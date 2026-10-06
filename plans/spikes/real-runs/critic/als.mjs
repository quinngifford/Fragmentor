import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
const als = new AsyncLocalStorage();
function start() {
  const server = http.createServer((req, res) => { res.end(String(als.getStore())); });
  return new Promise((r) => server.listen(0, () => r(server)));
}
const server = await als.run("startServer-call-1", () => start());
const port = server.address().port;
// request made from outside any watched context
const body = await new Promise((r) => http.get(`http://127.0.0.1:${port}/`, (res) => { let d=""; res.on("data", c=>d+=c); res.on("end", ()=>r(d)); }));
console.log("store seen inside a later request handler:", body);
// a timer set inside a watched call, firing after it returned
als.run("call-2", () => setTimeout(() => console.log("timer after return sees:", als.getStore()), 20));
setTimeout(() => server.close(), 60);
