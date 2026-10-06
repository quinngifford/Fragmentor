import { route, arrow } from "./router.js";
(async () => { await route({ s: "ok" }); await arrow(2); })();
