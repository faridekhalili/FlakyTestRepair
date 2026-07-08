# Codebase Roadmap — a guided tour

Read this top to bottom and you'll understand the whole system. Each stop says *what*
the file does, *why* it exists, and what to look at. Companion docs:

- [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) — architecture + flow charts (Mermaid)
- [../README.md](../README.md) — how to run it

## The one-sentence summary

A **deterministic pipeline** (plain TypeScript) walks the CSV, clones each `(project, sha)`,
and hands each checkout to a **fresh LLM agent** whose only job is the fuzzy part: figure out
how to build *this* project at *this* historical commit, and report a structured outcome.

## Reading order

### Stop 1 — `src/types.ts` (the vocabulary)

Four types describe the entire system:

| Type | Meaning |
|---|---|
| `BuildTask` | one CSV row, enriched: repo URL, unique id, checkout dir |
| `AgentReport` | what the agent must report: status, build tool, JDK, the exact test-compile command, notes |
| `BuildOutcome` | `AgentReport` + orchestrator bookkeeping (duration, model id, errors) |
| `Ledger` | `taskId → BuildOutcome`, persisted as `workspace/ledger.json` |

Everything else is machinery to produce a `BuildOutcome` for every `BuildTask`.

### Stop 2 — `src/config.ts` and `src/model.ts` (the knobs)

`config.ts` reads `.env` once into a typed object: OpenRouter key/model, workspace path,
command timeout, log-tail size. `model.ts` is a factory that builds a Strands `OpenAIModel`
pointed at OpenRouter's OpenAI-compatible endpoint — swap `OPENROUTER_MODEL` in `.env` to
change the brain without touching code.

### Stop 3 — the deterministic pipeline (`csv.ts`, `git.ts`, `ledger.ts`, `exec.ts`)

These four files are deliberately LLM-free:

- **`csv.ts`** — parses `project,sha` rows into `BuildTask`s. Same project with 5 SHAs
  (fastjson) becomes 5 independent tasks with 5 separate checkout dirs.
- **`git.ts`** — `prepareRepo()`: `git fetch --depth 1 origin <sha>` fetches *just that
  commit* (GitHub allows this), falling back to a full clone. Idempotent: if the dir already
  has the right SHA checked out, it's a no-op.
- **`ledger.ts`** — read/write the outcome ledger. Written after *every* task, so a run
  killed at task 30 resumes at task 31.
- **`exec.ts`** — the single low-level `runShell()` used by everything: spawn bash, hard
  timeout, capture output, never throw on non-zero exit. Also builds the SDKMAN
  `PATH`/`JAVA_HOME` so any command can run under any installed JDK.

### Stop 4 — the tools (`src/tools/*`) — the agent's hands

Tools are what turn a chat model into an agent. Each is a Strands `tool()` with a Zod
schema. Three are *factories* taking a `BuildTask` so the closure locks the tool to one
checkout directory — that's the sandbox.

| File | Tool | Role |
|---|---|---|
| `inspect.ts` | `inspect_project` | deterministic recon: build files, wrappers, JDK hints, CI config — in one call |
| `toolchain.ts` | `list_toolchains`, `search_java_versions`, `install_toolchain` | see / find / install JDKs, Maven, Gradle via SDKMAN |
| `shell.ts` | `run_command` | run bash in the checkout; full log → disk, tail → model; denylist; per-command `javaVersion` |
| `files.ts` | `read_file` | windowed reads of poms and command logs (never floods context) |
| `report.ts` | `report_result` | required final call; closure captures a typed `AgentReport` |

### Stop 5 — `src/agents/buildAgent.ts` (the brain)

`createBuildAgent(task)` assembles a **fresh** `Agent` per task: the model, the seven tools
above (closed over `task`), and the system prompt. The prompt encodes the build engineer's
playbook: inspect first → choose JDK from hints/era → `mvn test-compile` or
`gradlew testClasses -x test` → diagnose failures (wrong JDK, enforcer plugins, dead HTTP
repos, broken modules) → max 5 attempts → always `report_result`.

Why fresh-per-task instead of one long-lived agent? Context isolation (task 40 doesn't
carry task 1's logs), parallelism, and crash containment. See SYSTEM_DESIGN.md.

### Stop 6 — `src/pipeline/orchestrator.ts` (the conductor)

A worker pool over the task queue. Per task: ledger check → `prepareRepo()` →
`createBuildAgent(task).runTask()` → record. Three terminal states:

- `success` — agent reported the test-compile command exited 0
- `failure` — agent tried and gave up (its `notes` say why)
- `error` — infrastructure problem: clone failed, agent crashed, or never called `report_result`

### Stop 7 — `src/index.ts` (the front door)

CLI flag parsing (`--limit`, `--filter`, `--only`, `--concurrency`, `--fresh`, `--dry-run`),
task selection, then the pipeline, then a summary. `scripts/bootstrap.sh` is the one-time
host setup: SDKMAN + seeded JDK 8/11/17 + Maven, all non-interactive.

## Data flow of a single task

```
CSV row "alibaba/fastjson,37ed66b..."
  → BuildTask {id: alibaba__fastjson__37ed66b, dir: workspace/repos/...}
    → prepareRepo(): shallow fetch + detached checkout of the SHA
      → agent.invoke("Set up and build alibaba/fastjson at 37ed66b...")
          inspect_project        → "Maven, no wrapper, pom says source 1.5"
          list_toolchains        → JDK 8 installed? yes
          run_command            → "mvn -B -DskipTests test-compile" [java 8.0.x-tem]
          (on failure: read_file on the log, fix, retry ≤ 5×)
          report_result          → {status, jdkVersion, testCompileCommand, notes}
        → BuildOutcome recorded in workspace/ledger.json
```

## Where to extend

1. **Run the flaky tests** — next natural step: a `testRunnerAgent` that reads a `success`
   ledger entry (it has the JDK + command) and runs a target test N times. Copy the
   buildAgent pattern: factory + task-scoped tools + a report tool.
2. **Per-role models** — cheap model for inspection, strong model for diagnosis:
   parameterize `createModel()`.
3. **Docker isolation** — swap `runShell()` internals for `docker exec`; every layer above
   is untouched.
