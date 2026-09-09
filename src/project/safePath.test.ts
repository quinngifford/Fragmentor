import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInside } from "./safePath.js";

const root = path.resolve("/projects/demo");

describe("resolveInside", () => {
  it("resolves a path within the project", () => {
    expect(resolveInside(root, "blocks", "rank-jobs", "impl.ts")).toBe(
      path.join(root, "blocks", "rank-jobs", "impl.ts"),
    );
  });

  it("allows the root itself", () => {
    expect(resolveInside(root)).toBe(root);
  });

  it("refuses to climb out with ..", () => {
    expect(() => resolveInside(root, "..", "secrets.txt")).toThrow(/Refusing to touch/);
    expect(() => resolveInside(root, "blocks", "..", "..", "secrets.txt")).toThrow(/Refusing to touch/);
  });

  it("refuses an absolute path that lands elsewhere", () => {
    expect(() => resolveInside(root, path.resolve("/etc/passwd"))).toThrow(/Refusing to touch/);
  });

  it("is not fooled by a sibling whose name starts the same way", () => {
    expect(() => resolveInside(path.resolve("/projects/demo"), "..", "demo-other", "x")).toThrow(
      /Refusing to touch/,
    );
  });
});
