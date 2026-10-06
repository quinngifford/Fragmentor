import { checkSession } from "./auth.js";
export async function route(req) {
  const who = checkSession(req.s);
  if (!who) return { status: 401 };
  return { status: 200, body: inner(who) };
}
function inner(x) { return "hi " + x; }
export let arrow = async (n) => n * 2;
