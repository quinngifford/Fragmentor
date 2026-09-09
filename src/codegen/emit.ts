import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { CAPABILITIES, capabilitiesModuleSource, isKnownCapability } from "../model/capabilities.js";
import { generateContractSource, generateImplScaffold } from "./contract.js";
import { blocksRoot } from "../project/project.js";
import type { Project } from "../project/project.js";

/**
 * Writes the generated half of a project to disk.
 *
 * `contract.ts` is regenerated every time, because it is derived from the
 * diagram and must never drift from it. `impl.ts` is only ever created when
 * missing: it holds work the model or a person wrote, and overwriting it
 * would throw that away.
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

  const capabilitiesFile = path.join(blocksRoot(project.dir), "capabilities.ts");
  await writeFile(capabilitiesFile, capabilitiesModuleSource(), "utf8");
  written.push(relative(capabilitiesFile));

  for (const node of project.byPath.values()) {
    const contractFile = path.join(node.dir, "contract.ts");
    await writeFile(
      contractFile,
      generateContractSource({ block: node.block, blockPath: node.path }),
      "utf8",
    );
    written.push(relative(contractFile));

    const implFile = path.join(node.dir, "impl.ts");
    if (await exists(implFile)) {
      skipped.push(relative(implFile));
    } else {
      await writeFile(implFile, generateImplScaffold(node.block), "utf8");
      written.push(relative(implFile));
    }
  }

  written.sort();
  skipped.sort();
  return { written, skipped, problems };
}
