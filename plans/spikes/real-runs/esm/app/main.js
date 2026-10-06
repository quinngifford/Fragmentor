import { route, arrow } from "./router.js";
await route({ s: "ok" });
await route({ s: "no" });
await Promise.all([route({ s: "ok" }), arrow(3)]);
