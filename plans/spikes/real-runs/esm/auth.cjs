"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logOut = exports.route = void 0;
exports.logIn = logIn;
function logIn(email, password) { return `s-${email.length}`; }
const logOut = (id) => "/login";
exports.logOut = logOut;
function route(r) { return r.path === "/login" ? logIn(r.email, r.password) : (0, exports.logOut)(r.id); }
exports.route = route;
