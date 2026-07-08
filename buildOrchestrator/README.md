# Build Orchestrator

Agentic workflow (TypeScript + [Strands Agents](https://strandsagents.com/), models via
OpenRouter) that clones and builds every `(project, sha)` pair — a **subject** — in
`integration_tests_flakies.csv`, until its tests are **runnable**: main *and* test sources
compile. It does not run the test suites themselves.

## Documentation

| Doc | Read it for |
|---|---|
| [docs/ROADMAP.md](docs/ROADMAP.md) | guided tour of the codebase, file by file, in reading order |
| [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md) | architecture, flow charts (Mermaid), design rationale |
| this README | setup and how to run subjects |

## How it works (30 seconds)

1. `integration_tests_flakies.csv` is parsed into 60 tasks — one per `(project, sha)`.
2. For each task, plain code shallow-clones the repo and checks out the exact SHA into
   `workspace/repos/<task-id>/`.
3. A fresh LLM **build agent** (Strands agent, model via OpenRouter) gets the checkout and a
   toolbox: inspect the project, install JDKs/Maven/Gradle via SDKMAN, run build commands,
   read logs. It figures out the right JDK and build invocation, diagnoses failures, and
   retries up to 5 times.
4. The agent must finish by calling `report_result`; the structured outcome (status, JDK,
   the exact test-compile command, notes) is recorded in `workspace/ledger.json`.
5. Re-running skips subjects already built — you can stop and resume any time.

## One-time setup

```bash
cd buildOrchestrator
npm install
npm run bootstrap        # installs SDKMAN, seeds JDK 8/11/17 + Maven (non-interactive)
cp .env.example .env     # then edit .env and set OPENROUTER_API_KEY
```

`.env` also picks the model (`OPENROUTER_MODEL`, default `anthropic/claude-sonnet-4.5`),
command timeout, and workspace location — see `.env.example` for all knobs.

## Trying it out, subject by subject

Every subject has a stable **task id**: `<owner>__<repo>__<first-7-of-sha>`. List them all:

```bash
npm run dev -- --dry-run
```

### Run a single subject

```bash
npm run dev -- --only alibaba__fastjson__37ed66b
```

You'll see the live trace: clone, then each command the agent runs (`$ mvn ...`, exit codes,
durations, toolchain installs), then ✅/❌ with the total time.

### Run all subjects of one project

```bash
npm run dev -- --filter fastjson        # all 5 fastjson SHAs
npm run dev -- --filter apache          # every apache/* subject
```

### Run a first smoke test (recommended before the full sweep)

Start with a small, well-behaved subject to validate the loop end-to-end:

```bash
npm run dev -- --filter commons-lang --limit 1
```

### Run everything

```bash
npm run dev --                    # sequential; resumes automatically on re-run
npm run dev -- --concurrency 3    # 3 subjects in parallel (they never share state)
npm run dev -- --fresh            # ignore previous successes and rebuild all
```

A full pass takes hours (some subjects are huge — quarkus, CoreNLP, shardingsphere), which
is why every outcome is persisted immediately and re-runs skip prior successes.

## Inspecting the results of a subject

After a subject runs, three places tell the story (all under `workspace/`, gitignored):

```bash
# 1. The verdict — status, JDK, exact test-compile command, agent notes
cat workspace/ledger.json | python3 -m json.tool | less

# 2. Every command the agent ran, with full output — one run-NNN directory per
#    attempt (history is preserved across re-runs), logs numbered in execution order
ls workspace/logs/alibaba__fastjson__37ed66b/run-*/

# 3. The checkout itself, at the exact SHA
git -C workspace/repos/alibaba__fastjson__37ed66b log -1
```

A `success` ledger entry is directly actionable for flaky-test work — reproduce the build
yourself with the JDK and command the agent recorded:

```bash
export JAVA_HOME=~/.sdkman/candidates/java/<jdkVersion-from-ledger>
cd workspace/repos/<task-id>
<testCompileCommand-from-ledger>       # e.g. mvn -B -DskipTests test-compile
```

Statuses: `success` (test-compile exited 0) · `failure` (agent tried ≤ 5 approaches and gave
up — `notes` explain why) · `error` (infrastructure: clone failed / agent never reported).

## CLI reference

```
--dry-run          list matching task ids and exit
--only <task-id>   run exactly one subject
--filter <str>     subjects whose project name contains <str>
--limit <n>        first n matching subjects
--concurrency <n>  parallel subjects (default 1)
--fresh            ignore ledger, rebuild even prior successes
--help             this list
```
