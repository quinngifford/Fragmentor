// Read-only: cyclomatic complexity (1 + decision points) and statement counts of every
// top-level function/arrow/method in a project's TypeScript, plus which block points at it.
const ts = require("C:/Users/quinn/OneDrive/CS Projects/Fragmentor/node_modules/typescript");
const fs = require("fs"), path = require("path");
const dir = process.argv[2];
const files = [];
const walk = (rel) => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
  const f = rel ? rel + "/" + e.name : e.name;
  if (e.isDirectory()) { if (e.name === "node_modules" || e.name.startsWith(".") || (rel === "" && e.name === "blocks")) continue; walk(f); }
  else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) files.push(f); } };
walk("");
const pointers = new Map();
const bwalk = (rel) => { const p = path.join(dir, "blocks", rel); if (!fs.existsSync(p)) return; for (const e of fs.readdirSync(p, { withFileTypes: true })) {
  if (e.isDirectory()) bwalk(rel ? rel + "/" + e.name : e.name);
  else if (e.name === "block.json") { const b = JSON.parse(fs.readFileSync(path.join(p, e.name), "utf8")); if (b.code) pointers.set(b.code.split(String.fromCharCode(92)).join("/"), rel); } } };
bwalk("");
const decision = (n, nested) => {
  let c = 0;
  const visit = (x, top) => {
    if (!top && nested === false && ts.isFunctionLike(x)) return;
    switch (x.kind) {
      case ts.SyntaxKind.IfStatement: case ts.SyntaxKind.ConditionalExpression: case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement: case ts.SyntaxKind.ForOfStatement: case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement: case ts.SyntaxKind.CatchClause: c++; break;
      case ts.SyntaxKind.CaseClause: c++; break;
      case ts.SyntaxKind.BinaryExpression: { const k = x.operatorToken.kind;
        if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
             ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(k)) c++; break; }
    }
    ts.forEachChild(x, (y) => visit(y, false));
  };
  visit(n, true);
  return 1 + c;
};
const statements = (n) => { let s = 0; const v = (x) => { if (ts.isStatement(x) && !ts.isBlock(x)) s++; ts.forEachChild(x, v); }; ts.forEachChild(n, v); return s; };
const rows = []; let total = 0;
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  total += statements(sf);
  const fn = (name, node) => rows.push({ f, name, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, cc: decision(node, true), ccOwn: decision(node, false), st: statements(node), block: pointers.get(`${f}#${name.split(".").pop()}`) ?? pointers.get(`${f}#${name}`) ?? "" });
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) fn(s.name.text, s);
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) { if (d.initializer && ts.isIdentifier(d.name) && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) fn(d.name.text, d.initializer); }
    else if (ts.isClassDeclaration(s) && s.name) for (const m of s.members) if ((ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) && m.body) fn(`${s.name.text}.${m.name ? m.name.getText(sf) : "constructor"}`, m);
  }
}
rows.sort((a, b) => b.cc - a.cc);
console.log(`files ${files.length}, statements ${total}, functions ${rows.length}, pointers ${pointers.size}`);
const over = (k, t) => rows.filter((r) => r[k] > t).length;
console.log(`cc(with nested) >5: ${over("cc",5)} >10: ${over("cc",10)} >15: ${over("cc",15)} >20: ${over("cc",20)} | own-only >10: ${over("ccOwn",10)} >15: ${over("ccOwn",15)} >20: ${over("ccOwn",20)}`);
for (const r of rows.slice(0, 8)) console.log(`  ${r.cc}/${r.ccOwn} st${r.st} ${r.f}#${r.name}:${r.line} ${r.block}`);
const st = rows.map((r) => r.st); const mean = st.reduce((a, b) => a + b, 0) / st.length; const sd = Math.sqrt(st.reduce((a, b) => a + (b - mean) ** 2, 0) / st.length);
console.log(`statements per function mean ${mean.toFixed(1)} sd ${sd.toFixed(1)}; over mean+2sd: ${rows.filter((r) => r.st > mean + 2 * sd).map((r) => r.name + "(" + r.st + ")").join(", ")}`);
