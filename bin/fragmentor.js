#!/usr/bin/env node
// The `fragmentor` command, for the coding agent working in a project. It runs
// the TypeScript source directly, so the command always matches the code in
// this folder and there is nothing to rebuild after a change.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
