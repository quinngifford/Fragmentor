import { agentGuide } from "file:///C:/Users/quinn/OneDrive/CS%20Projects/Fragmentor/src/codegen/guide.ts";
const base = { name: "Test", goal: "", existingCode: false, start: "build", granularity: { level: 3, maxDepth: 4 }, systems: [] };
for (const [label, extra] of [["typescript", { language: "typescript" }], ["plan", { language: "typescript", start: "plan" }], ["existing", { language: "typescript", existingCode: true }], ["python", { language: "python" }]] as const) {
  const g = agentGuide({ ...base, ...extra } as never);
  console.log(label, g.split("\n").length, "lines,", g.length, "chars");
}
