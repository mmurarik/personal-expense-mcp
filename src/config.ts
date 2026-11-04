// Reads settings from environment variables and validates them once at startup.
// If anything is missing or invalid, the process fails immediately with a clear
// message that names the setting but never prints its value.
import { z } from "zod";

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// Environment variables are always text, so converting "8080" to 8080 is expected here.
// (Request bodies are different: there, a number sent as text is rejected.)
const DbEnv = z.object({
  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PGDATABASE: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
});

const AppEnv = DbEnv.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  OWNER_TIMEZONE: z
    .string()
    .default("America/Los_Angeles")
    .refine(isTimeZone, { message: "must be an IANA time zone such as America/Los_Angeles" }),
  API_INTERNAL_BASE_URL: z.string().url().optional(),
  API_BEARER_TOKEN: z.string().min(32, { message: "must be at least 32 characters" }),
});

export type DbConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

export type AppConfig = {
  port: number;
  ownerTimezone: string;
  apiInternalBaseUrl: string;
  apiBearerToken: string;
  db: DbConfig;
};

type Env = Record<string, string | undefined>;

function parse<T extends z.ZodTypeAny>(schema: T, env: Env): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Only names and rules go into the message, never values, so secrets can't leak into logs.
    const problems = result.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }
  return result.data;
}

function toDbConfig(env: z.infer<typeof DbEnv>): DbConfig {
  return {
    host: env.PGHOST,
    port: env.PGPORT,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
  };
}

/** Database settings only. The migration job needs nothing else. */
export function loadDbConfig(env: Env = process.env): DbConfig {
  return toDbConfig(parse(DbEnv, env));
}

/** Everything the web service needs. */
export function loadAppConfig(env: Env = process.env): AppConfig {
  const parsed = parse(AppEnv, env);
  return {
    port: parsed.PORT,
    ownerTimezone: parsed.OWNER_TIMEZONE,
    // The MCP tools call the API inside the same container, so default to this process's own port.
    apiInternalBaseUrl: parsed.API_INTERNAL_BASE_URL ?? `http://127.0.0.1:${parsed.PORT}`,
    apiBearerToken: parsed.API_BEARER_TOKEN,
    db: toDbConfig(parsed),
  };
}
