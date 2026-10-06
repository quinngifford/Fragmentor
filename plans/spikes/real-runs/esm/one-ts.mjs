import { register } from "node:module";
import { isMainThread } from "node:worker_threads";
const MAP = { "router.ts": [["route", "app/router"], ["inner", "app/inner"], ["arrow", "app/arrow"]], "auth.ts": [["checkSession", "app/auth"]] };
if (isMainThread) {
  globalThis.__fragmentorTrack = (block, fn) => function (...a) { console.log("call", block); return Reflect.apply(fn, this, a); };
  register(import.meta.url);
}
export async function load(url, context, next) {
  const result = await next(url, context);
  const file = Object.keys(MAP).find((f) => url.split("?")[0].endsWith("/tsxapp/" + f));
  if (!file) return result;
  let source = String(result.source);
  for (const [fn, block] of MAP[file]) {
    source = source.replace(new RegExp(String.raw`\bconst\s+` + fn + String.raw`\s*=`), `let ${fn} =`);
    source += `\n${fn} = (globalThis.__fragmentorTrack ?? ((b, f) => f))(${JSON.stringify(block)}, ${fn});`;
  }
  console.error("[hook]", file, result.format);
  return { ...result, source };
}
