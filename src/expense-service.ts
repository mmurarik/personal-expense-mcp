import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./db/client.js";
import { expenses, expenseCreateRequests, type ExpenseRow } from "./db/schema.js";
import { ApiError } from "./errors.js";
import { Expense, ExpenseId, UtcTimestamp, type ExpenseCreate, type ExpenseUpdate, type ListFilters, type ListQuery, type ListResult } from "./schemas.js";

function serialize(row: ExpenseRow): Expense {
  return Expense.parse({
    id: row.id,
    amount_minor: row.amountMinor,
    currency: row.currency,
    expense_date: row.expenseDate,
    merchant: row.merchant,
    category: row.category,
    notes: row.notes,
    version: row.version,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function digest(body: object): string {
  // Both the create body and the filter signature are flat objects.
  return createHash("sha256").update(JSON.stringify(body, Object.keys(body).sort())).digest("hex");
}

const cursorSchema = z.object({
  createdAt: UtcTimestamp.refine((value) => !value.startsWith("0000")),
  id: ExpenseId,
  filters: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

function decodeCursor(value: string, filters: string): z.infer<typeof cursorSchema> {
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") === value) {
      const parsed = cursorSchema.safeParse(JSON.parse(bytes.toString("utf8")));
      if (parsed.success && parsed.data.filters === filters) return parsed.data;
    }
  } catch {
    // All malformed cursors use the same public error.
  }
  throw new ApiError(422, "validation_error", "Invalid cursor for these filters.", "cursor");
}

function filterSignature(filters: ListFilters): string {
  const { date_from, date_to, category, merchant } = filters;
  return digest({ date_from, date_to, category, merchant });
}

const notFound = () => new ApiError(404, "expense_not_found", "Expense not found.");
const staleVersion = () => new ApiError(409, "version_conflict", "Expense changed. Read the current version before retrying.");
const createCollision = new Error("Creation receipt already exists");

export function createExpenseService(db: Database) {
  return {
    async ready() {
      await db.execute(sql`SELECT 1`);
    },

    async create(requestId: string, body: ExpenseCreate) {
      const payloadHash = digest(body);
      try {
        const expense = await db.transaction(async (tx) => {
          const [row] = await tx.insert(expenses).values({
            id: randomUUID(),
            amountMinor: body.amount_minor,
            currency: body.currency,
            expenseDate: body.expense_date,
            merchant: body.merchant,
            category: body.category,
            notes: body.notes,
          }).returning();
          const response = serialize(row!);
          const [receipt] = await tx.insert(expenseCreateRequests).values({
            requestId,
            payloadHash,
            expenseId: response.id,
            responseBody: response,
          }).onConflictDoNothing({ target: expenseCreateRequests.requestId }).returning({
            requestId: expenseCreateRequests.requestId,
          });
          // PostgreSQL waits for the winner's transaction. Roll back our expense if we lost.
          if (!receipt) throw createCollision;
          return response;
        });
        return { expense, replayed: false };
      } catch (error) {
        if (error !== createCollision) throw error;
      }
      const [receipt] = await db.select().from(expenseCreateRequests)
        .where(eq(expenseCreateRequests.requestId, requestId));
      if (receipt?.payloadHash !== payloadHash) {
        throw new ApiError(409, "idempotency_conflict", "This request ID was already used for a different expense.");
      }
      return { expense: Expense.parse(receipt.responseBody), replayed: true };
    },

    async list(query: ListQuery): Promise<ListResult> {
      const { date_from, date_to, category, merchant, limit, cursor } = query;
      const filters = filterSignature(query);
      const anchor = cursor === undefined ? undefined : decodeCursor(cursor, filters);
      // JS Date rounds timestamps to milliseconds. Keep PostgreSQL's full precision in the cursor.
      const rows = await db.select({
        row: expenses,
        sortTime: sql<string>`to_char(${expenses.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      }).from(expenses).where(and(
        isNull(expenses.deletedAt),
        date_from === undefined ? undefined : gte(expenses.expenseDate, date_from),
        date_to === undefined ? undefined : lte(expenses.expenseDate, date_to),
        category === undefined ? undefined : eq(expenses.category, category),
        merchant === undefined ? undefined : sql`strpos(lower(${expenses.merchant}), lower(${merchant})) > 0`,
        anchor === undefined ? undefined : sql`(${expenses.createdAt}, ${expenses.id}) < (${anchor.createdAt}::timestamptz, ${anchor.id}::uuid)`,
      )).orderBy(desc(expenses.createdAt), desc(expenses.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = rows.length > limit ? page.at(-1) : undefined;
      return {
        items: page.map(({ row }) => serialize(row)),
        next_cursor: last
          ? Buffer.from(JSON.stringify({ createdAt: last.sortTime, id: last.row.id, filters })).toString("base64url")
          : null,
      };
    },

    async get(id: string): Promise<Expense> {
      const [row] = await db.select().from(expenses).where(and(eq(expenses.id, id), isNull(expenses.deletedAt)));
      if (!row) throw notFound();
      return serialize(row);
    },

    async update(id: string, body: ExpenseUpdate): Promise<Expense> {
      return db.transaction(async (tx) => {
        const [current] = await tx.select().from(expenses).where(eq(expenses.id, id)).for("update");
        if (!current || current.deletedAt) throw notFound();
        if (current.version !== body.expected_version) throw staleVersion();
        const [updated] = await tx.update(expenses).set({
          amountMinor: body.amount_minor,
          currency: body.currency,
          expenseDate: body.expense_date,
          merchant: body.merchant,
          category: body.category,
          notes: body.notes,
          version: current.version + 1,
          updatedAt: sql`greatest(clock_timestamp(), ${expenses.updatedAt} + interval '1 millisecond')`,
        }).where(eq(expenses.id, id)).returning();
        return serialize(updated!);
      });
    },

    async delete(id: string, expectedVersion: number): Promise<void> {
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(expenses).where(eq(expenses.id, id)).for("update");
        if (!current) throw notFound();
        if (current.deletedAt) return;
        if (current.version !== expectedVersion) throw staleVersion();
        const deletedAt = sql`greatest(statement_timestamp(), ${expenses.updatedAt} + interval '1 millisecond')`;
        await tx.update(expenses).set({
          deletedAt,
          updatedAt: deletedAt,
          version: current.version + 1,
        }).where(eq(expenses.id, id));
      });
    },
  };
}

export type ExpenseService = ReturnType<typeof createExpenseService>;
