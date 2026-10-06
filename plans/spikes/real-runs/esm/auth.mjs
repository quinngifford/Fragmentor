export function logIn(email, password) { return `s-${email.length}`; }
export const logOut = (id) => "/login";
export function route(r) { return r.path === "/login" ? logIn(r.email, r.password) : logOut(r.id); }
