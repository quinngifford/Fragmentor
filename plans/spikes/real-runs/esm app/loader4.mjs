export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (url.endsWith("/lib2.js")) return { ...r, source: "try { inner = globalThis.__ft.wrap('inner', inner); outer = globalThis.__ft.wrap('outer', outer); } catch {}\n" + String(r.source) + "\n;try { arrow = globalThis.__ft.wrap('arrow', arrow); } catch (e) { globalThis.__ft.missed = String(e); }\n" };
  return r;
}
