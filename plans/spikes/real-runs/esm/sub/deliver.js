import { subscribe } from "./q.js";
export async function deliver(m) { return boom(m); }
function boom(m) { if (m === 2) throw new Error("bad " + m); return m; }
subscribe(deliver);
