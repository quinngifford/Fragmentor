import { register } from "node:module";
import { isMainThread } from "node:worker_threads";
const MAP = { "router.js": [["route", "app/router"], ["inner", "app/inner"]], "auth.js": [["checkSession", "app/auth"]] };
let calls = 0;
if (isMainThread) {
  globalThis.__fragmentorTrack = (block, fn) => function (...a) { console.log("call", block, ++calls); return Reflect.apply(fn, this, a); };
  register(import.meta.url);
}
export async function load(url, context, next) {
  const result = await next(url, context);
  const file = Object.keys(MAP).find((f) => url.endsWith("/app/" + f));
  if (!file || result.format !== "module") return result;
  let source = String(result.source);
  for (const [fn, block] of MAP[file]) source += `\n${fn} = (globalThis.__fragmentorTrack ?? ((b, f) => f))(${JSON.stringify(block)}, ${fn});`;
  return { ...result, source };
}
