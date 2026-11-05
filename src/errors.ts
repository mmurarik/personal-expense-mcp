import type { ZodError } from "zod";
import type { ErrorBody } from "./schemas.js";

export class ApiError extends Error {
  readonly body: ErrorBody;

  constructor(readonly status: number, code: string, message: string, field?: string) {
    super(message);
    this.body = { error: { code, message, ...(field === undefined ? {} : { field }) } };
  }
}

export function validationError(error: ZodError, fallbackField?: string): ApiError {
  const issue = error.issues[0];
  const path = issue?.path.join(".");
  // Unknown keys and unexpected input values can contain arbitrary user text.
  const message = issue?.code === "unrecognized_keys"
    ? "Unknown properties are not allowed."
    : issue?.message ?? "Invalid input.";
  return new ApiError(422, "validation_error", message, path || fallbackField);
}
