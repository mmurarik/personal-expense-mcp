// Shared runtime contracts for the REST API and the MCP tools.
// TypeScript types are inferred from these schemas; there are no hand-written duplicates.
import { z } from "zod";

export const CATEGORIES = [
  "groceries",
  "dining",
  "transport",
  "housing",
  "utilities",
  "health",
  "shopping",
  "entertainment",
  "travel",
  "education",
  "other",
] as const;

export const MAX_AMOUNT_MINOR = 1_000_000_000; // $10,000,000.00

const emptyToNull = (value: unknown) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

export const CalendarDate = z.string().date("must be a real calendar date in YYYY-MM-DD format.")
  .refine((date) => !date.startsWith("0000"), { message: "Calendar year must be at least 0001." });

export const AmountMinor = z
  .number({ invalid_type_error: "amount_minor must be a positive integer." })
  .int({ message: "amount_minor must be a positive integer." })
  .min(1, { message: "amount_minor must be a positive integer." })
  .max(MAX_AMOUNT_MINOR, { message: `amount_minor must not exceed ${MAX_AMOUNT_MINOR}.` })
  .describe("Amount in integer US cents. 1250 means $12.50. Must be 1 to 1000000000.");

export const Currency = z
  .literal("USD", { errorMap: () => ({ message: "Only USD is supported." }) })
  .describe("ISO currency code. Only USD is supported.");

export const Category = z
  .enum(CATEGORIES, {
    errorMap: () => ({ message: `category must be one of: ${CATEGORIES.join(", ")}.` }),
  })
  .describe(`One of: ${CATEGORIES.join(", ")}.`);

const databaseText = (max: number) =>
  z.string().max(max).refine((value) => !value.includes("\0") && value.isWellFormed(), {
    message: "Must contain valid text without NUL characters.",
  });

const nullableDate = z
  .preprocess(emptyToNull, CalendarDate.nullable())
  .describe("Calendar date the expense happened, YYYY-MM-DD, or null if unknown.");
const nullableMerchant = z
  .preprocess(emptyToNull, databaseText(200).nullable())
  .describe("Merchant name as the user said it, or null if unknown.");
const nullableCategory = z.preprocess(emptyToNull, Category.nullable()).describe(
  `Category, or null if unknown. One of: ${CATEGORIES.join(", ")}.`,
);
const nullableNotes = z
  .preprocess(emptyToNull, databaseText(2000).nullable())
  .describe("Free-text notes, or null.");

/** Mutable expense fields. Shared by create bodies and update changes. */
const expenseFields = {
  amount_minor: AmountMinor,
  currency: Currency,
  expense_date: nullableDate,
  merchant: nullableMerchant,
  category: nullableCategory,
  notes: nullableNotes,
};

export const ExpenseCreate = z
  .object({
    amount_minor: AmountMinor,
    currency: Currency.default("USD"),
    expense_date: nullableDate.default(null),
    merchant: nullableMerchant.default(null),
    category: nullableCategory.default(null),
    notes: nullableNotes.default(null),
  })
  .strict();
export type ExpenseCreate = z.infer<typeof ExpenseCreate>;

/** Fields an update may change. Omitted keys stay unchanged; explicit null clears a nullable field. */
const MutableFields = z
  .object({
    amount_minor: expenseFields.amount_minor.optional(),
    currency: expenseFields.currency.optional(),
    expense_date: expenseFields.expense_date.optional(),
    merchant: expenseFields.merchant.optional(),
    category: expenseFields.category.optional(),
    notes: expenseFields.notes.optional(),
  })
  .strict();
const hasChanges = (body: Record<string, unknown>) =>
  Object.entries(body).some(([key, value]) => key !== "expected_version" && value !== undefined);
const emptyPatch = { message: "Supply at least one field to change." };
export const ExpenseChanges = MutableFields.refine(hasChanges, emptyPatch);
export type ExpenseChanges = z.infer<typeof ExpenseChanges>;

export const ExpectedVersion = z
  .number({ invalid_type_error: "expected_version must be a positive integer." })
  .int({ message: "expected_version must be a positive integer." })
  .min(1, { message: "expected_version must be a positive integer." })
  .max(2_147_483_647)
  .describe("The version you last read. The write fails with a conflict if the record changed since.");

export const ExpenseUpdate = MutableFields.extend({ expected_version: ExpectedVersion })
  .strict()
  .refine(hasChanges, emptyPatch);
export type ExpenseUpdate = z.infer<typeof ExpenseUpdate>;

export const ExpenseId = z.string().uuid({ message: "must be a UUID." });
export const ExpensePath = z.object({ id: ExpenseId }).strict();
export const EmptyQuery = z.object({}).strict();
export const UtcTimestamp = z.string().datetime().describe("RFC 3339 UTC timestamp.");

export const Expense = z
  .object({
    id: ExpenseId,
    amount_minor: AmountMinor,
    currency: Currency,
    expense_date: CalendarDate.nullable(),
    merchant: databaseText(200).nullable(),
    category: Category.nullable(),
    notes: databaseText(2000).nullable(),
    version: ExpectedVersion,
    created_at: UtcTimestamp,
    updated_at: UtcTimestamp,
  })
  .strict();
export type Expense = z.infer<typeof Expense>;

const queryInt = (field: string, schema: z.ZodNumber) =>
  z
    .string()
    .regex(/^\d+$/, { message: `${field} must be an integer from ${schema.minValue} to ${schema.maxValue}.` })
    .transform(Number)
    .pipe(schema);

/** Filters shared by the REST query string and the list_expenses tool. */
export const ListFilters = z
  .object({
    date_from: CalendarDate.optional()
      .describe("Inclusive start date, YYYY-MM-DD. Excludes expenses with no date."),
    date_to: CalendarDate.optional()
      .describe("Inclusive end date, YYYY-MM-DD. Excludes expenses with no date."),
    category: Category.optional(),
    merchant: databaseText(200).refine((value) => value.length > 0).optional()
      .describe("Case-insensitive literal substring match on merchant name."),
  })
  .strict();
export type ListFilters = z.infer<typeof ListFilters>;

const checkDateBounds = (q: { date_from?: string | undefined; date_to?: string | undefined }, ctx: z.RefinementCtx) => {
  if (q.date_from && q.date_to && q.date_from > q.date_to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date_from"], message: "date_from must not be after date_to." });
  }
};

const Limit = z.number().int().min(1).max(100).describe("Page size. Defaults to 25.");
const Cursor = z.string().min(1).max(512).describe("Opaque continuation cursor from the previous page.");

export const ListToolInput = ListFilters.extend({
  limit: Limit.default(25),
  cursor: Cursor.optional(),
}).strict().superRefine(checkDateBounds);

export const ListQuery = ListFilters.extend({
  limit: queryInt("limit", Limit).default("25"),
  cursor: Cursor.optional(),
}).strict().superRefine(checkDateBounds);
export type ListQuery = z.infer<typeof ListQuery>;

export const ListResult = z
  .object({
    items: z.array(Expense),
    next_cursor: z.string().nullable().describe("Pass as cursor to get the next page; null when there are no more."),
  })
  .strict();
export type ListResult = z.infer<typeof ListResult>;

export const DeleteQuery = z
  .object({ expected_version: queryInt("expected_version", ExpectedVersion) })
  .strict();

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    field: z.string().optional(),
  }).strict(),
}).strict();
export type ErrorBody = z.infer<typeof ErrorBody>;

export const StatusBody = z.object({ status: z.literal("ok") }).strict();
