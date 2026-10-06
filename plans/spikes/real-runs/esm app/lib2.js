export function inner(x) { return x + 1; }
export function outer(x) { return inner(x) * 2; }
export const table = { outer };            // captured during evaluation
export const arrow = (x) => inner(x);
