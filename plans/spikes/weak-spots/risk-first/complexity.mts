// Read-only: cyclomatic complexity per function (ESLint-style counting) and statements per file, for a folder of TS.
import ts from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/node_modules/typescript/lib/typescript.js";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const root = process.argv[2]!;
const files: string[] = [];
const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "blocks") continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !e.name.endsWith(".d.ts")) files.push(p); } };
walk(root);
const rows: [number, number, string][] = []; let totalStatements = 0; const perFile: [number, string][] = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let statements = 0;
  const visit = (node: ts.Node, fn: { c: number; c2: number } | null) => {
    if (ts.isStatement(node) && !ts.isBlock(node) && !ts.isFunctionDeclaration(node) && !ts.isClassDeclaration(node) && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node) && !ts.isImportDeclaration(node) && !ts.isEmptyStatement(node)) statements++;
    if (ts.isFunctionLike(node) && (node as any).body) {
      const me = { c: 1, c2: 1 };
      ts.forEachChild(node, (child) => visit(child, me));
      const name = (node as any).name?.getText?.(sf) ?? "<anon>";
      rows.push([me.c, me.c2, `${path.relative(root, f)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${name}`]);
      return;
    }
    if (fn) {
      let k = 0;
      if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isCatchClause(node) || ts.isCaseClause(node)) k = 1;
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) k = 1;
      fn.c += k; fn.c2 += k;
      // ESLint 9 also counts optional chaining and default values
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken) fn.c2++;
      if ((ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer) fn.c2++;
    }
    ts.forEachChild(node, (child) => visit(child, fn));
  };
  visit(sf, null);
  totalStatements += statements; perFile.push([statements, path.relative(root, f)]);
}
rows.sort((a, b) => b[0] - a[0]);
console.log(`files ${files.length}, functions ${rows.length}, statements ${totalStatements}`);
console.log("top complexity (classic | with ?. and defaults):");
for (const r of rows.slice(0, 8)) console.log(`  ${r[0]} | ${r[1]}  ${r[2]}`);
console.log("over 10:", rows.filter((r) => r[0] > 10).length, " over 15:", rows.filter((r) => r[0] > 15).length, " over 20:", rows.filter((r) => r[0] > 20).length, " over 5:", rows.filter((r) => r[0] > 5).length, " | eslint9 over 10:", rows.filter((r) => r[1] > 10).length, " over 15:", rows.filter((r) => r[1] > 15).length);
perFile.sort((a, b) => b[0] - a[0]);
console.log("largest files by statements:", perFile.slice(0, 5).map(([n, f]) => `${f} ${n} (${Math.round(100 * n / totalStatements)}%)`).join("; "));
