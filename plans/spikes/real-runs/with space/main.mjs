import { route } from "./auth.mjs";
console.log(route({ path: "/login", email: "ada@x", password: "p" }), route({ path: "/logout", id: "s-1" }));
