import { pathToFileURL } from "node:url";
import Fastify, { LogController } from "fastify";
import { DrizzleQueryError } from "drizzle-orm";
import { createBearerAuth } from "./auth.js";
import { loadAppConfig, type AppConfig } from "./config.js";
import { createDb, createPool } from "./db/client.js";
import { ApiError } from "./errors.js";
import { expenseRoutes } from "./expense-routes.js";
import { createExpenseService } from "./expense-service.js";
import { mcpRoutes } from "./mcp.js";

const databaseUnavailable = () =>
  new ApiError(503, "database_unavailable", "Database is unavailable.");

function isDatabaseUnavailable(error: unknown): boolean {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  if (!(cause instanceof Error)) return false;
  const code = (cause as { code?: string }).code;
  return Boolean(code && (/^(08|28|53|57)[0-9A-Z]{3}$/.test(code)
    || ["3D000", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "ENOENT"].includes(code)))
    || /timeout|connection terminated/i.test(cause.message);
}

export function createServer(config: AppConfig = loadAppConfig(), logStream?: NodeJS.WritableStream) {
  const server = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      stream: logStream,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
  });
  const pool = createPool(config.db);
  const service = createExpenseService(createDb(pool));
  const authenticate = createBearerAuth(config.apiBearerToken);

  server.addHook("onClose", async () => {
    await pool.end();
  });

  server.addHook("onResponse", async (request, reply) => {
    request.log.info({
      method: request.method,
      route: request.routeOptions.url,
      status: reply.raw.statusCode,
      durationMs: reply.elapsedTime,
    }, "request completed");
  });
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send(error.body);
    if (isDatabaseUnavailable(error)) {
      request.log.warn("Database operation unavailable");
      const failure = databaseUnavailable();
      return reply.code(failure.status).send(failure.body);
    }
    const status = error instanceof Error ? (error as { statusCode?: number }).statusCode : undefined;
    if (status && status >= 400 && status < 500) {
      const failure = new ApiError(422, "validation_error", "Invalid request. Use valid JSON and supported request fields.");
      return reply.code(failure.status).send(failure.body);
    }
    request.log.error("Unexpected request failure");
    const failure = new ApiError(500, "internal_error", "Unexpected service error.");
    return reply.code(failure.status).send(failure.body);
  });

  // Liveness does not access the database.
  server.get("/healthz", async () => ({ status: "ok" }));
  server.get("/readyz", { onRequest: authenticate }, async (request) => {
    try {
      await service.ready();
    } catch {
      request.log.warn("Readiness database check failed");
      throw databaseUnavailable();
    }
    return { status: "ok" };
  });

  server.register(expenseRoutes, { prefix: "/v1", authenticate, service });
  server.register(mcpRoutes, { authenticate, config });

  return server;
}

async function main(): Promise<void> {
  const config = loadAppConfig();
  const server = createServer(config);

  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      server.log.error("Server shutdown failed");
      process.exitCode = 1;
    }
  };

  try {
    await server.listen({ host: "0.0.0.0", port: config.port });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    server.log.error("Server startup failed");
    await server.close();
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : "Server startup failed");
    process.exitCode = 1;
  });
}
