import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { CAPABILITIES, isKnownCapability } from "../model/capabilities.js";
import { getPack, isKnownLanguage } from "../lang/index.js";
import { blocksRoot, systemOf } from "../project/project.js";
import type { Project } from "../project/project.js";

/**
 * Writes the generated half of a project to disk, one language pack per system.
 *
 * The contract file is regenerated every time, because it is derived from the
 * diagram and must never drift from it. The implementation is only ever
 * created when missing: it holds work the model or a person wrote, and
 * overwriting it would throw that away.
 */

export interface EmitResult {
  written: string[];
  skipped: string[];
  problems: string[];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function emitProject(project: Project): Promise<EmitResult> {
  const written: string[] = [];
  const skipped: string[] = [];
  const problems: string[] = [];

  const relative = (target: string) => path.relative(project.dir, target).split(path.sep).join("/");

  for (const system of project.systems) {
    if (!isKnownLanguage(system.language)) {
      problems.push(`The system "${system.rootBlock}" is written in "${system.language}", which Fragmentor has no language pack for.`);
    }
  }

  for (const node of project.byPath.values()) {
    for (const [name, cap] of Object.entries(node.block.capabilities)) {
      if (!isKnownCapability(cap.capability)) {
        problems.push(
          `"${node.block.name}" asks for a capability "${name}" of an unknown kind "${cap.capability}". Known kinds: ${Object.keys(CAPABILITIES).join(", ")}.`,
        );
      }
    }
  }

  if (problems.length > 0) return { written, skipped, problems };

  // One shared capabilities module per language actually used.
  const languagesUsed = [...new Set(project.systems.map((system) => system.language))];
  for (const language of languagesUsed) {
    const pack = getPack(language);
    const target = path.join(blocksRoot(project.dir), pack.capabilitiesFile);
    await writeFile(target, pack.capabilitiesSource(), "utf8");
    written.push(relative(target));
  }

  for (const node of project.byPath.values()) {
    const system = systemOf(project, node.path);
    if (!system) {
      problems.push(`"${node.path}" does not belong to any system in this project.`);
      continue;
    }
    const pack = getPack(system.language);

    const contractFile = path.join(node.dir, pack.contractFile);
    await writeFile(contractFile, pack.contractSource({ block: node.block, blockPath: node.path }), "utf8");
    written.push(relative(contractFile));

    const implFile = path.join(node.dir, pack.implFile);
    if (await exists(implFile)) {
      skipped.push(relative(implFile));
    } else {
      await writeFile(implFile, pack.implScaffold(node.block), "utf8");
      written.push(relative(implFile));
    }
  }

  written.sort();
  skipped.sort();
  return { written, skipped, problems };
}
