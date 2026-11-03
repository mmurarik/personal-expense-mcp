import { sql } from "drizzle-orm";
import { char, check, date, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("USD"),
    expenseDate: date("expense_date", { mode: "string" }),
    merchant: varchar("merchant", { length: 200 }),
    category: text("category"),
    notes: varchar("notes", { length: 2000 }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    check("expenses_amount_minor_check", sql`${t.amountMinor} BETWEEN 1 AND 1000000000`),
    check("expenses_currency_check", sql`${t.currency} = 'USD'`),
    check(
      "expenses_category_check",
      sql`${t.category} IS NULL OR ${t.category} IN ('groceries', 'dining', 'transport', 'housing', 'utilities', 'health', 'shopping', 'entertainment', 'travel', 'education', 'other')`,
    ),
    check("expenses_version_check", sql`${t.version} > 0`),
    index("expenses_active_created_idx")
      .on(t.createdAt.desc(), t.id.desc())
      .where(sql`${t.deletedAt} IS NULL`),
    index("expenses_active_date_idx").on(t.expenseDate).where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const expenseCreateRequests = pgTable("expense_create_requests", {
  requestId: uuid("request_id").primaryKey(),
  payloadHash: char("payload_hash", { length: 64 }).notNull(),
  expenseId: uuid("expense_id")
    .notNull()
    .references(() => expenses.id),
  responseBody: jsonb("response_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type ExpenseRow = typeof expenses.$inferSelect;
