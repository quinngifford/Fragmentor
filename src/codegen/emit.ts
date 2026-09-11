import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CAPABILITIES, isKnownCapability } from "../model/capabilities.js";
import { getPack, isKnownLanguage } from "../lang/index.js";
import { blocksRoot, systemOf } from "../project/project.js";
import type { Project } from "../project/project.js";
import { AGENTS_FILE, AGENTS_SCAFFOLD, CLAUDE_FILE, CLAUDE_SCAFFOLD, GUIDE_FILE, agentGuide } from "./guide.js";

/**
 * Writes the generated half of a project to disk, one language pack per system.
 *
 * Contracts and the agent's guide are regenerated every time, because they are
 * derived and must never drift. The implementation is only ever created when
 * missing: it holds work an agent or a person wrote, and overwriting it would
 * throw that away.
 *
 * A file is only written when its contents change. The application watches
 * the project, and a check that rewrote identical files would redraw the
 * window under the person using it every time the agent ran one.
 */

export interface EmitResult {
  /** Files created or changed, relative to the project. */
  written: string[];
  /** Implementations that already existed, and were left alone. */
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

async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Writes `contents` unless the file already holds them, and says whether it
 * wrote. Line endings are ignored, so a checkout that converted them does not
 * count as a change.
 */
async function writeIfChanged(filePath: string, contents: string): Promise<boolean> {
  if ((await readIfPresent(filePath))?.replace(/\r\n/g, "\n") === contents) return false;
  await writeFile(filePath, contents, "utf8");
  return true;
}

/**
 * Prepares a folder for a coding agent: the guide, and the two files agents
 * read first, which point at it. Those two are only ever created, never
 * rewritten, because they are where the person keeps instructions of their
 * own. Any that were already there without mentioning the guide are reported,
 * since an agent reading them would never learn that it exists.
 */
export async function writeAgentFiles(
  projectDir: string,
): Promise<{ written: string[]; kept: string[]; withoutGuide: string[] }> {
  await mkdir(projectDir, { recursive: true });

  const written = (await writeIfChanged(path.join(projectDir, GUIDE_FILE), agentGuide())) ? [GUIDE_FILE] : [];
  const kept: string[] = [];
  const withoutGuide: string[] = [];

  for (const [file, contents] of [[AGENTS_FILE, AGENTS_SCAFFOLD], [CLAUDE_FILE, CLAUDE_SCAFFOLD]] as const) {
    const existing = await readIfPresent(path.join(projectDir, file));
    if (existing === null) {
      await writeFile(path.join(projectDir, file), contents, "utf8");
      written.push(file);
    } else {
      kept.push(file);
      if (!existing.includes(GUIDE_FILE)) withoutGuide.push(file);
    }
  }

  return { written, kept, withoutGuide };
}

export async function emitProject(project: Project): Promise<EmitResult> {
  const written: string[] = [];
  const skipped: string[] = [];
  const problems: string[] = [];

  const relative = (target: string) => path.relative(project.dir, target).split(path.sep).join("/");
  const write = async (target: string, contents: string) => {
    if (await writeIfChanged(target, contents)) written.push(relative(target));
  };

  // The guide does not depend on the project being valid, and is most needed
  // when it is not, so it is kept current before anything can be refused.
  await write(path.join(project.dir, GUIDE_FILE), agentGuide());

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
    await write(path.join(blocksRoot(project.dir), pack.capabilitiesFile), pack.capabilitiesSource());
  }

  for (const node of project.byPath.values()) {
    const system = systemOf(project, node.path);
    if (!system) {
      problems.push(`"${node.path}" does not belong to any system in this project.`);
      continue;
    }
    const pack = getPack(system.language);

    await write(path.join(node.dir, pack.contractFile), pack.contractSource({ block: node.block, blockPath: node.path }));

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
