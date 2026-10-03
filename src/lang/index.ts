/**
 * The language packs Fragmentor knows about.
 *
 * Importing this module is what registers them, so anything that resolves a
 * pack by id should import from here rather than from `pack.js` directly.
 */
import "./typescript.js";
import "./python.js";

export { getPack, isKnownLanguage, knownLanguages, normaliseLanguage } from "./pack.js";
export type { FileReach, LanguagePack, ReachReader, Target, Uses } from "./pack.js";
