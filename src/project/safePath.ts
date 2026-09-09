import path from "node:path";

/**
 * Every path the interface sends is treated as untrusted.
 *
 * The window is not a browser tab and there is no remote content, but the
 * renderer is still the least trusted part of the application, and a block
 * path arriving as `../../..` should be refused rather than followed. Nothing
 * outside the project a request names can be reached.
 */
export function resolveInside(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to touch ${target}, which is outside ${resolvedRoot}.`);
  }
  return target;
}
