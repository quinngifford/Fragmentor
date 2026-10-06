import "./deliver.js";
import { publish } from "./q.js";
await publish(1);
try { await publish(2); } catch (e) { console.log("caught", e.stack.split("\n")[1].trim()); }
