import { createHash, timingSafeEqual } from "node:crypto";
import type { onRequestAsyncHookHandler } from "fastify";
import type { ErrorBody } from "./schemas.js";

export function createBearerAuth(token: string): onRequestAsyncHookHandler {
  const expected = createHash("sha256").update(token).digest();

  return async (request, reply) => {
    const authorization = request.headers.authorization ?? "";
    const supplied = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization)?.[1];

    // Hash both tokens so the timing-safe comparison always uses equal-length buffers.
    if (supplied && timingSafeEqual(expected, createHash("sha256").update(supplied).digest())) {
      return;
    }

    return reply.header("WWW-Authenticate", "Bearer").code(401).send({
      error: { code: "unauthorized", message: "A valid bearer token is required." },
    } satisfies ErrorBody);
  };
}
