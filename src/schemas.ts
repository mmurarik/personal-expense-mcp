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

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export const CalendarDate = z
  .string()
  .refine(isCalendarDate, { message: "must be a real calendar date in YYYY-MM-DD format." });

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

const nullableDate = z
  .preprocess(emptyToNull, CalendarDate.nullable())
  .describe("Calendar date the expense happened, YYYY-MM-DD, or null if unknown.");
const nullableMerchant = z
  .preprocess(emptyToNull, z.string().max(200, { message: "merchant must be at most 200 characters." }).nullable())
  .describe("Merchant name as the user said it, or null if unknown.");
const nullableCategory = z.preprocess(emptyToNull, Category.nullable()).describe(
  `Category, or null if unknown. One of: ${CATEGORIES.join(", ")}.`,
);
const nullableNotes = z
  .preprocess(emptyToNull, z.string().max(2000, { message: "notes must be at most 2000 characters." }).nullable())
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
export const ExpenseChanges = z
  .object({
    amount_minor: expenseFields.amount_minor.optional(),
    currency: expenseFields.currency.optional(),
    expense_date: expenseFields.expense_date.optional(),
    merchant: expenseFields.merchant.optional(),
    category: expenseFields.category.optional(),
    notes: expenseFields.notes.optional(),
  })
  .strict();
export type ExpenseChanges = z.infer<typeof ExpenseChanges>;

export const ExpectedVersion = z
  .number({ invalid_type_error: "expected_version must be a positive integer." })
  .int({ message: "expected_version must be a positive integer." })
  .min(1, { message: "expected_version must be a positive integer." })
  .describe("The version you last read. The write fails with a conflict if the record changed since.");

export const ExpenseUpdate = ExpenseChanges.extend({ expected_version: ExpectedVersion })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== "expected_version"), {
    message: "Supply at least one field to change.",
  });
export type ExpenseUpdate = z.infer<typeof ExpenseUpdate>;

export const ExpenseId = z.string().uuid({ message: "must be a UUID." });

export const Expense = z
  .object({
    id: z.string().uuid(),
    amount_minor: z.number().int(),
    currency: z.literal("USD"),
    expense_date: z.string().nullable(),
    merchant: z.string().nullable(),
    category: z.enum(CATEGORIES).nullable(),
    notes: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string().describe("RFC 3339 UTC timestamp."),
    updated_at: z.string().describe("RFC 3339 UTC timestamp."),
  })
  .strict();
export type Expense = z.infer<typeof Expense>;

const queryInt = (field: string, min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, { message: `${field} must be an integer from ${min} to ${max}.` })
    .transform(Number)
    .pipe(
      z
        .number()
        .min(min, { message: `${field} must be an integer from ${min} to ${max}.` })
        .max(max, { message: `${field} must be an integer from ${min} to ${max}.` }),
    );

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

/** Filters shared by the REST query string and the list_expenses tool. */
export const ListFilters = z
  .object({
    date_from: z
      .preprocess(emptyToUndefined, CalendarDate.optional())
      .describe("Inclusive start date, YYYY-MM-DD. Excludes expenses with no date."),
    date_to: z
      .preprocess(emptyToUndefined, CalendarDate.optional())
      .describe("Inclusive end date, YYYY-MM-DD. Excludes expenses with no date."),
    category: z.preprocess(emptyToUndefined, Category.optional()),
    merchant: z
      .preprocess(emptyToUndefined, z.string().max(200).optional())
      .describe("Case-insensitive substring match on merchant name."),
  })
  .strict();
export type ListFilters = z.infer<typeof ListFilters>;

const checkDateBounds = (q: { date_from?: string | undefined; date_to?: string | undefined }, ctx: z.RefinementCtx) => {
  if (q.date_from && q.date_to && q.date_from > q.date_to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date_from"], message: "date_from must not be after date_to." });
  }
};

export const ListQuery = ListFilters.extend({
  limit: queryInt("limit", 1, 100).optional(),
  cursor: z.string().max(512).optional(),
})
  .strict()
  .superRefine(checkDateBounds);
export type ListQuery = z.infer<typeof ListQuery>;

export const ListResult = z
  .object({
    items: z.array(Expense),
    next_cursor: z.string().nullable().describe("Pass as cursor to get the next page; null when there are no more."),
  })
  .strict();
export type ListResult = z.infer<typeof ListResult>;

export const DeleteQuery = z
  .object({ expected_version: queryInt("expected_version", 1, 2_147_483_647) })
  .strict();

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    field: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
