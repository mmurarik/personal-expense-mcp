CREATE TABLE "expense_create_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"payload_hash" char(64) NOT NULL,
	"expense_id" uuid NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"expense_date" date,
	"merchant" varchar(200),
	"category" text,
	"notes" varchar(2000),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "expenses_amount_minor_check" CHECK ("expenses"."amount_minor" BETWEEN 1 AND 1000000000),
	CONSTRAINT "expenses_currency_check" CHECK ("expenses"."currency" = 'USD'),
	CONSTRAINT "expenses_category_check" CHECK ("expenses"."category" IS NULL OR "expenses"."category" IN ('groceries', 'dining', 'transport', 'housing', 'utilities', 'health', 'shopping', 'entertainment', 'travel', 'education', 'other')),
	CONSTRAINT "expenses_version_check" CHECK ("expenses"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "expense_create_requests" ADD CONSTRAINT "expense_create_requests_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_active_created_idx" ON "expenses" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "expenses"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "expenses_active_date_idx" ON "expenses" USING btree ("expense_date") WHERE "expenses"."deleted_at" IS NULL;