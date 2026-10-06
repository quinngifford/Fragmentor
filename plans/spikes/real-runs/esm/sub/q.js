const hs = [];
export function subscribe(h) { hs.push(h); }
export async function publish(m) { for (const h of hs) await h(m); }
