import { register } from "node:module";
import { isMainThread } from "node:worker_threads";
const MAP = { "deliver.js": ["deliver", "boom"], "q.js": ["publish"] };
if (isMainThread) {
  globalThis.__fragmentorTrack = (block, fn) => function (...a) { console.log("call", block); return Reflect.apply(fn, this, a); };
  register(import.meta.url);
}
export async function load(url, context, next) {
  const result = await next(url, context);
  const file = Object.keys(MAP).find((f) => url.endsWith("/sub/" + f));
  if (!file) return result;
  const head = MAP[file].map((fn) => `${fn} = (globalThis.__fragmentorTrack ?? ((b, f) => f))(${JSON.stringify(fn)}, ${fn});`).join(" ");
  return { ...result, source: head + String(result.source) };
}
