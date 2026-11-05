import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";

export function jsonSchema(schema: z.ZodTypeAny) {
  // Use inline schemas so MCP clients and OpenAPI consumers need no external references.
  const { $schema: _dialect, ...definition } = zodToJsonSchema(schema, {
    $refStrategy: "none",
    effectStrategy: "input",
    strictUnions: true,
  });
  return definition;
}
