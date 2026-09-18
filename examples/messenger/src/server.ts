import { route } from "./api/router.js";
import type { Request } from "./api/router.js";

/** The HTTP server's one job: turn a request into a call to the router. The framework around it is left out. */
export async function handle(request: Request): Promise<string> {
  const response = await route(request);
  return JSON.stringify(response);
}
