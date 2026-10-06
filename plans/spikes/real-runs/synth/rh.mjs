import { registerHooks } from "node:module";
registerHooks({ load(url, ctx, next) { const r = next(url, ctx); if (url.endsWith("lib.js")) console.log("load hook saw", url.split("/").pop(), ctx.format); return r; } });
