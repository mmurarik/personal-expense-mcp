import type { FastifyPluginAsync, onRequestAsyncHookHandler } from "fastify";
import { z } from "zod";
import { validationError } from "./errors.js";
import type { ExpenseService } from "./expense-service.js";
import { DeleteQuery, EmptyQuery, ExpenseCreate, ExpenseId, ExpensePath, ExpenseUpdate, ListQuery } from "./schemas.js";

function validate<T extends z.ZodTypeAny>(schema: T, input: unknown, field?: string): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error, field);
  return result.data;
}

export const expenseRoutes: FastifyPluginAsync<{
  authenticate: onRequestAsyncHookHandler;
  service: ExpenseService;
}> = async (server, { authenticate, service }) => {
  server.addHook("onRequest", authenticate);

  server.post("/expenses", async (request, reply) => {
    validate(EmptyQuery, request.query);
    const key = validate(ExpenseId, request.headers["idempotency-key"], "Idempotency-Key");
    const body = validate(ExpenseCreate, request.body);
    const { expense, replayed } = await service.create(key, body);
    if (replayed) {
      return reply.code(200).header("Idempotency-Replayed", "true").send(expense);
    }
    return reply.code(201).header("Location", `/v1/expenses/${expense.id}`).send(expense);
  });

  server.get("/expenses", async (request) => service.list(validate(ListQuery, request.query)));

  server.get("/expenses/:id", async (request) => {
    validate(EmptyQuery, request.query);
    const { id } = validate(ExpensePath, request.params);
    return service.get(id);
  });

  server.patch("/expenses/:id", async (request) => {
    validate(EmptyQuery, request.query);
    const { id } = validate(ExpensePath, request.params);
    return service.update(id, validate(ExpenseUpdate, request.body));
  });

  server.delete("/expenses/:id", async (request, reply) => {
    const { id } = validate(ExpensePath, request.params);
    const { expected_version } = validate(DeleteQuery, request.query);
    await service.delete(id, expected_version);
    return reply.code(204).send();
  });
};
