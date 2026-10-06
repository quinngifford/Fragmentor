export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (url.endsWith("/lib.js")) return { ...r, source: String(r.source) + "\n;arrow = globalThis.__ft.wrap('arrow', arrow);\n" };
  return r;
}
