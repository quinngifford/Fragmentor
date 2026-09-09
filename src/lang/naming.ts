/**
 * Turning a block id into a name a given language would use.
 *
 * Block ids are kebab-case everywhere, because they are folder names. What
 * that becomes in code is a language convention, not a property of the block,
 * which is why none of this lives in the model.
 */

const words = (id: string): string[] => id.split("-").filter(Boolean);

/** `rank-jobs` -> `rankJobs` */
export function camelCase(id: string): string {
  const [first, ...rest] = words(id);
  if (!first) return id;
  return first + rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

/** `rank-jobs` -> `RankJobs` */
export function pascalCase(id: string): string {
  return words(id)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/** `rank-jobs` -> `rank_jobs`, and `readFile` -> `read_file` */
export function snakeCase(id: string): string {
  return id
    .replace(/-/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}
