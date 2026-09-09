# Claude Code Setup

## 1. Copy these files into the repository root

Your project should contain:

```text
CLAUDE.md
PROJECT.md
STATUS.md
.claude/
  skills/
    develop-module/SKILL.md
    plan-feature/SKILL.md
    verify-feature/SKILL.md
    human-verification/SKILL.md
    version-control/SKILL.md
    project-status/SKILL.md
    simplify/SKILL.md
  agents/
    tester.md
    reviewer.md
```

Keep the `.claude` folder name exactly as written.

## 2. Start Claude Code from the repository root

Open a terminal in the project folder and run:

```bash
claude
```

Claude Code automatically loads the root `CLAUDE.md` as project instructions.

Project skills live under `.claude/skills/<skill-name>/SKILL.md` and can be invoked directly with commands such as `/verify-feature`, or Claude can select them when their descriptions match the task.

Project subagents live under `.claude/agents/`. Claude can delegate to them automatically based on their descriptions, or you can explicitly ask it to use `tester` or `reviewer`.

If `.claude/skills/` or `.claude/agents/` did not exist when the current Claude Code session started, restart Claude Code once after adding this starter kit.

## 3. Sanity-check the setup

In the first Claude Code chat, ask:

> Read CLAUDE.md, PROJECT.md, and STATUS.md. Tell me in simple terms what you think we are building, how you are expected to work, which project skills are available, and which supporting subagents are available. Do not change any code yet.

It should identify the seven project skills and the `tester` and `reviewer` subagents.

## Normal usage

You do not need to manually invoke every skill.

Tell the main Claude what you want to build or fix. `CLAUDE.md` tells it when the workflows are appropriate.

You can still explicitly request one when useful, for example:

- "Use develop-module for this."
- "Run verify-feature before calling this done."
- "Use the tester subagent to independently verify this."
- "Use simplify on this subsystem."
- "Give me project status."

Keep `PROJECT.md` durable and small. Keep `STATUS.md` current and small. Let the code remain the source of implementation detail.
