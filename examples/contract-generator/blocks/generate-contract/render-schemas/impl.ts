import type { RenderSchemasInput, RenderSchemasOutput, RenderSchemasCaps } from "./contract.js";

/** Render the zod object expression for the input ports and for the output ports, expanding each port's type expression into a schema. */
export async function renderSchemas(input: RenderSchemasInput, caps: RenderSchemasCaps): Promise<RenderSchemasOutput> {
  throw new Error("Render Schemas has no implementation yet.");
}
