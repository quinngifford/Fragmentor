export async function load(url, context, next) {
  const result = await next(url, context);
  if (!url.endsWith("auth.mjs")) return result;
  const src = String(result.source);
  const extra = ["logIn", "logOut", "route"].map((n) => `\n;try { ${n} = globalThis.__track(${JSON.stringify(n)}, ${n}); } catch (e) { globalThis.__unseen(${JSON.stringify(n)}, e.message); }`).join("");
  return { ...result, source: src + extra, shortCircuit: true };
}
