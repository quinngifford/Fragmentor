import { register } from "node:module";
import { isMainThread } from "node:worker_threads";
const MAP = { "router.ts": ["route", "inner"], "auth.ts": ["checkSession"] };
if (isMainThread) {
  globalThis.__fragmentorTrack = (block, fn) => function (...a) { console.log("call", block, process.pid); return Reflect.apply(fn, this, a); };
  register(import.meta.url);
}
export async function load(url, context, next) {
  const result = await next(url, context);
  const file = Object.keys(MAP).find((f) => url.split("?")[0].endsWith("/tsxapp/" + f));
  if (!file) return result;
  const head = MAP[file].map((fn) => `${fn} = (globalThis.__fragmentorTrack ?? ((b, f) => f))(${JSON.stringify(fn)}, ${fn});`).join(" ");
  console.error("[hook]", file, result.format, String(result.source).slice(0, 30).replace(/\n/g, " "));
  return { ...result, source: head + String(result.source) };
}
