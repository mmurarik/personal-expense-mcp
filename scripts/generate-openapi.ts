import { writeFileSync } from "node:fs";
import type { z } from "zod";
import { jsonSchema } from "../src/json-schema.js";
import { ErrorBody, Expense, ExpenseCreate, ExpenseId, ExpenseUpdate, ExpectedVersion, ListResult, ListToolInput, StatusBody } from "../src/schemas.js";

const schemas = {
  Error: jsonSchema(ErrorBody),
  Expense: jsonSchema(Expense),
  ExpenseCreate: jsonSchema(ExpenseCreate),
  ExpenseUpdate: { ...jsonSchema(ExpenseUpdate), minProperties: 2 },
  ListResult: jsonSchema(ListResult),
  Status: jsonSchema(StatusBody),
};
type SchemaName = keyof typeof schemas;
const json = (name: SchemaName) => ({ "application/json": { schema: { $ref: `#/components/schemas/${name}` } } });
const body = (schema: SchemaName) => ({ required: true, content: json(schema) });
const response = (description: string, schema?: SchemaName) =>
  ({ description, ...(schema && { content: json(schema) }) });
const parameter = (name: string, location: string, schema: z.ZodTypeAny) =>
  ({ name, in: location, required: true, schema: jsonSchema(schema) });
const id = parameter("id", "path", ExpenseId);
const version = parameter("expected_version", "query", ExpectedVersion);
const listParameters = Object.entries(ListToolInput.innerType().shape).map(([name, schema]) =>
  ({ ...parameter(name, "query", schema), required: false }));
const invalid = response("Input failed validation.", "Error");
const conflict = response("Version or idempotency conflict.", "Error");
const missing = response("Active expense not found.", "Error");
const protectedResponses = {
  401: {
    ...response("A valid bearer token is required.", "Error"),
    headers: { "WWW-Authenticate": { schema: { type: "string", const: "Bearer" } } },
  },
  503: response("Database unavailable.", "Error"),
};
const expenseResponses = { ...protectedResponses, 422: invalid };
const document = {
  openapi: "3.1.0",
  info: { title: "Personal Expense API", version: "0.1.0", description: "Single-owner USD expense records in integer cents." },
  security: [{ bearerAuth: [] }],
  components: { schemas, securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  paths: {
    "/health": {
      get: { summary: "Check service liveness", operationId: "health", security: [], responses: { 200: response("Service is running.", "Status") } },
    },
    "/readyz": {
      get: { summary: "Check database readiness", operationId: "readiness", responses: { ...protectedResponses, 200: response("Database is reachable.", "Status") } },
    },
    "/v1/expenses": {
      post: {
        summary: "Create an expense",
        operationId: "createExpense",
        parameters: [{ ...parameter("Idempotency-Key", "header", ExpenseId), description: "Reuse this UUID only when retrying the same normalized expense." }],
        requestBody: body("ExpenseCreate"),
        responses: {
          ...expenseResponses,
          200: {
            ...response("Original creation receipt replayed.", "Expense"),
            headers: { "Idempotency-Replayed": { schema: { type: "string", const: "true" } } },
          },
          201: {
            ...response("Expense created.", "Expense"),
            headers: { Location: { schema: { type: "string", format: "uri-reference" } } },
          },
          409: conflict,
        },
      },
      get: {
        summary: "List active expenses",
        operationId: "listExpenses",
        description: "Sorted by creation time and ID, descending. Reuse the same filters when supplying a continuation cursor.",
        parameters: listParameters,
        responses: { ...expenseResponses, 200: response("Expense page.", "ListResult") },
      },
    },
    "/v1/expenses/{id}": {
      parameters: [id],
      get: {
        summary: "Read an active expense",
        operationId: "getExpense",
        responses: { ...expenseResponses, 200: response("Active expense.", "Expense"), 404: missing },
      },
      patch: {
        summary: "Update explicitly supplied fields",
        operationId: "updateExpense",
        requestBody: body("ExpenseUpdate"),
        responses: { ...expenseResponses, 200: response("Updated expense.", "Expense"), 404: missing, 409: conflict },
      },
      delete: {
        summary: "Soft-delete an expense",
        operationId: "deleteExpense",
        parameters: [version],
        responses: { ...expenseResponses, 204: response("Expense hidden or already deleted."), 404: missing, 409: conflict },
      },
    },
  },
};

writeFileSync("openapi.json", JSON.stringify(document, null, 2) + "\n");
