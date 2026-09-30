import { describe, expect, it } from "vitest";
import { formatRule, parseRule, refuseRule } from "./rules.js";
import type { RuleBlock } from "./rules.js";

/**
 * The rule sentences and the structural refusals. Everything here is shared
 * by the kernel and the window, so what is held here is that both read a
 * sentence the same way and that a pair that could never break a rule is
 * turned away with a reason in plain words.
 */

const block = (path: string, role = "component"): RuleBlock => ({ path, name: path.split("/").pop()!, role });

describe("the two sentences", () => {
  it("reads and writes both kinds, word for word", () => {
    const never = parseRule("app/workers must never reach app/client");
    expect(never).toEqual({ kind: "never", from: "app/workers", to: "app/client" });
    expect(formatRule(never!)).toBe("app/workers must never reach app/client");

    const only = parseRule("only app/api may reach app/db");
    expect(only).toEqual({ kind: "only", from: "app/api", to: "app/db" });
    expect(formatRule(only!)).toBe("only app/api may reach app/db");
  });

  it("is not fooled by anything that is not exactly one of them", () => {
    expect(parseRule("")).toBeNull();
    expect(parseRule("app/a may never reach app/b")).toBeNull();
    expect(parseRule("only app/a must reach app/b")).toBeNull();
    expect(parseRule("app/a must never reach app/b either")).toBeNull();
    expect(parseRule("Only app/a may reach app/b")).toBeNull();
  });

  it("refuses an entry: a rule is about blocks, never about one table or operation", () => {
    expect(parseRule("app/a must never reach app/db.users")).toBeNull();
    expect(parseRule("only app/a.run may reach app/db")).toBeNull();
  });
});

describe("which pairs may have a rule", () => {
  it("allows an ordinary pair", () => {
    expect(refuseRule("never", block("app/workers"), block("app/client", "client"), [])).toBeNull();
  });

  it("needs two different blocks", () => {
    expect(refuseRule("never", block("app/a"), block("app/a"), [])).toMatch(/two different blocks/);
  });

  it("refuses a block and something around it, either way up", () => {
    expect(refuseRule("never", block("app/api/router"), block("app/api"), [])).toMatch(/inside/);
    expect(refuseRule("only", block("app/api"), block("app/api/router"), [])).toMatch(/its own parts/);
  });

  it("refuses two separate programs, which never reach each other anyway", () => {
    expect(refuseRule("never", block("app/client"), block("worker/jobs"), [])).toMatch(/separate programs/);
  });

  it("refuses a database, storage, structure or queue on the reaching side", () => {
    for (const role of ["database", "storage", "structure", "queue"]) {
      expect(refuseRule("never", block("app/db", role), block("app/api"), [])).toMatch(/never reaches anything itself/);
    }
    expect(refuseRule("never", block("app/api", "service"), block("app/db", "database"), [])).toBeNull();
  });

  it("refuses a rule that is already there, but only the same one", () => {
    const existing = ["app/workers must never reach app/client"];
    expect(refuseRule("never", block("app/workers"), block("app/client"), existing)).toMatch(/already a rule/);
    expect(refuseRule("only", block("app/workers"), block("app/client"), existing)).toBeNull();
  });
});
