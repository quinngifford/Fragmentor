"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.a = a;
exports.b = b;
function a(x) { return b(x) + 1; }
function b(x) { return x * 2; }
exports.strict = (function () { return this === undefined; })();
exports.line = () => new Error("x").stack.split("\n")[1];
