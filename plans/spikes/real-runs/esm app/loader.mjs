export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (url.endsWith("/lib.js")) {
    return { ...r, source: String(r.source) + "\n;inner = globalThis.__ft.wrap('inner', inner); outer = globalThis.__ft.wrap('outer', outer);\n" };
  }
  return r;
}
