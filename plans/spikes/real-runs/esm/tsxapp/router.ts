import { checkSession } from "./auth.js";
export async function route(req: { s: string }) {
  const who = checkSession(req.s);
  if (!who) return { status: 401 };
  return { status: 200, body: inner(who) };
}
function inner(x: string) { return "hi " + x; }
export const arrow = async (n: number) => n * 2;
