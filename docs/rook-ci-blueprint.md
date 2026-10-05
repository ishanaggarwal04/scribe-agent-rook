# Rook as the assurance layer in CI/CD: a blueprint

This repository runs **Rook** (TestMu AI Agent Assurance) in GitHub Actions to test an AI agent
before it ships. This guide explains how the pipeline works and how to set the same pipeline up
for **your own agent**, step by step. Use it as a blueprint for any CI/CD system where Rook
decides whether an agent version is good enough to release.

The example agent here is `incident-scribe`, a Python CLI agent with an MCP tool server. Nothing
in the blueprint depends on it. Where a value is specific to this repo, it is marked
*(this repo)*.

---

## Contents

1. [What the pipeline does](#1-what-the-pipeline-does)
2. [How the pieces fit together](#2-how-the-pieces-fit-together)
3. [Prerequisites](#3-prerequisites)
4. [Step 1: Author and rehearse the suite locally](#4-step-1-author-and-rehearse-the-suite-locally)
5. [Step 2: Commit the suite to your repository](#5-step-2-commit-the-suite-to-your-repository)
6. [Step 3: Add the gate script and workflow](#6-step-3-add-the-gate-script-and-workflow)
7. [Step 4: Configure GitHub](#7-step-4-configure-github)
8. [Step 5: Run it and read the result](#8-step-5-run-it-and-read-the-result)
9. [Writing a profile for your agent](#9-writing-a-profile-for-your-agent)
10. [Choosing which scenarios gate a release](#10-choosing-which-scenarios-gate-a-release)
11. [Day-to-day: when to regenerate and when not to](#11-day-to-day-when-to-regenerate-and-when-not-to)
12. [Moving the suite to another account or environment](#12-moving-the-suite-to-another-account-or-environment)
13. [Turning it into a real CD gate](#13-turning-it-into-a-real-cd-gate)
14. [Using it on other CI platforms](#14-using-it-on-other-ci-platforms)
15. [Known Rook limitations (0.1.5)](#15-known-rook-limitations-015)
16. [Troubleshooting](#16-troubleshooting)
17. [Security checklist](#17-security-checklist)
18. [Reference](#18-reference)

---

## 1. What the pipeline does

**When it runs:**

- on every **pull request into `main`** that touches the agent, its tool server, its Rook suite,
  the gate script or the workflow. It runs against the PR's code, and the result appears as a
  ✅ or ❌ check on the PR;
- **on demand**, from *Actions → Rook assurance → Run workflow* on `main`.

PRs from **forks** do not run it, because the PR's own code would run with your secrets. See
[section 13](#13-turning-it-into-a-real-cd-gate).

On each run, the pipeline:

1. checks out the agent's code at the commit being tested;
2. installs a pinned Rook CLI;
3. signs in to Rook without a browser, using an access key;
4. runs a **reviewed, committed** set of test scenarios against the **real agent**, which runs
   on the CI runner;
5. has Rook's judge grade every acceptance criterion from evidence (the reply, the tool calls,
   the files the agent wrote);
6. **fails the job unless every selected scenario passes**;
7. uploads the run's evidence as a build artifact and records it on the Rook dashboard.

What CI deliberately does **not** do: discover the agent (`rook explore`) or write new scenarios
(`rook generate`). Both use model credits and produce output a person should review. CI only
runs scenarios that someone has already reviewed and committed, so its results are predictable
and comparable from run to run.

---

## 2. How the pieces fit together

```
your laptop (once per agent / per capability change)        CI (every run)
───────────────────────────────────────────────────          ──────────────────────────────────
rook explore   → agent spec (.testmuai/rook/…/agent.yaml)    checkout commit
rook generate  → scenarios  (…/scenarios/SC-*.yaml)          install pinned Rook CLI
rook profile   → how to call the agent (…/profiles, scripts) ci/rook-ci.sh:
rook run       → rehearse, review verdicts                     rook login (access key)
rook sync      → record the reviewed suite upstream            rook project/agent/profile use
git commit .testmuai/rook/  ───────────── push ──────────▶     rook env set (agent's secret)
                                                               rook sync --agent … --yes
                                                               rook run --only <IDs> --yes --json
                                                               rook report <run-id> --json
                                                               jq gate → pass / fail the job
                                                             upload rook-results/ artifact
```

| Piece | Path | Role |
|---|---|---|
| Rook project tree | `.testmuai/rook/` | Agent specs, features, scenarios, profiles and rehearsal evidence. Committed. |
| Profile | `.testmuai/rook/projects/<slug>--<project-id>/agents/<agent>/profiles/<name>.yaml` | Says which hook script runs for each phase (`open`, `execute`, `collect`). |
| Hook script | `…/agents/<agent>/scripts/<name>.mjs` | Starts your agent, passes it the scenario's goal, returns its reply and evidence as JSON. |
| Gate script | `ci/rook-ci.sh` | The CI logic. Platform-neutral bash. |
| Workflow | `.github/workflows/rook-assurance.yml` | GitHub-specific wiring: runner, tools, secrets, artifact upload. |

### How Rook runs in CI with no one at the keyboard

Rook switches to headless mode when stdin is not a terminal or a CI variable is set. In headless
mode every step has to run without prompts:

| Step | Command | Why it needs no interaction |
|---|---|---|
| Sign-in | `rook login --username … --access-key …` | Access key from a CI secret, not the browser flow |
| Target | `rook project use` / `agent use` / `profile use` | IDs come from CI variables |
| Agent secrets | `rook env set --from <file>` | Written from a CI secret into a throwaway `ROOK_HOME` |
| Publish | `rook sync --agent <id> --yes` | `--yes` pre-approves this one command; nothing is saved to settings |
| Test | `rook run --only <IDs> --yes --json` | Machine-readable result |
| Gate | `rook report <run-id> --json` plus `jq` | The job's pass/fail comes from verdicts, not from Rook's exit code |

> **A green exit code is not a passing suite.** `rook run` exits 0 when a run *finishes*, even if
> scenarios failed. A refused run can say `ok: true`. The gate therefore checks the JSON: the run
> completed, was not halted or discarded, every planned scenario ran, and the counts add up
> before it looks at pass and fail.

---

## 3. Prerequisites

- **An agent you own**, plus whatever it needs to run in CI (runtime, model API key, test data).
- **A TestMu AI / LambdaTest account** with Rook access and credits.
  - Your **username** and **access key** are in the LambdaTest console under
    *Account Settings → Password & Security*.
  - Use a dedicated CI account if you can (this repo uses `rookprod`).
- **The Rook CLI** locally (`rook --version`). Install it from
  <https://github.com/LambdaTest/rook#install>.
- **A GitHub repository** for the agent, with Actions enabled.
- **On Windows:** Git with long-path support, because Rook's evidence paths are deep.

**Credit costs** seen in this repo, to help you budget:

| Command | Approximate cost |
|---|---|
| `rook explore` (first time, 2 agents) | ~30 credits |
| `rook generate` (20 scenarios) | ~300 credits |
| `rook run` | ~8–15 credits per scenario (includes judging) |
| `rook profile test`, `rook sync`, `rook doctor`, `rook status` | free |

---

## 4. Step 1: Author and rehearse the suite locally

Run all of this from your agent's repository root. That folder becomes Rook's workspace, and
`.testmuai/rook/` is created there.

### 4.1 Sign in and create a project

```bash
rook doctor                         # environment, reachability, sign-in state
rook login                          # browser sign-in (or --username/--access-key)
rook plan --json                    # account and credit balance
rook project create my-agent-ci     # creates the project and selects it
```

> **Watch for environment variables.** If `LT_USERNAME`/`LT_ACCESS_KEY` are set in your shell,
> they **take precedence over** `rook login`. If they belong to a different account, unset them.

### 4.2 Discover the agent

```bash
rook explore . --yes --json
```

Explore reads the codebase and writes an agent spec for each agent it finds: interface,
tool calls, guardrails, and which calls **write** (`write: true`). It is incremental. Unchanged
agents are skipped on later runs, and `--force` re-derives everything.

**Review `agent.yaml`, especially every call marked `write: true`.** Scenarios really run those
writes. Point them at disposable state before running anything. This repo redirects the
agent's session folder and its learned-incidents file to a throwaway path for every scenario.

### 4.3 Store the agent's secrets in Rook

Profiles refer to secrets as `${VAR}`. Never write the value itself into a profile:

```bash
printf 'MY_AGENT_TOKEN=%s\n' "$MY_AGENT_TOKEN" > /tmp/agent.env
rook env set --from /tmp/agent.env && rm /tmp/agent.env
rook env list                       # values are masked
```

### 4.4 Approve MCP servers (if your agent has them)

If your repo declares MCP servers in `.mcp.json`, Rook finds them during explore. They then need
approval before Rook's grader can call them to check the agent's claims:

```bash
rook mcp list --json
rook mcp approve <server-name> --origin discovered
```

### 4.5 Create the profile

The profile tells Rook how to call your agent. See [section 9](#9-writing-a-profile-for-your-agent).
For a first version, let Rook write it:

```bash
rook profile add local --from notes.md --yes   # notes: how to invoke the agent
rook profile test local --goal "Say hello and nothing else."   # free; calls the agent once
```

`profile add` writes the hook script and test-runs it, and it costs credits. Check the script it
wrote, because you will probably need to adjust it. Every later change is a hand edit followed by
`rook profile test`.

### 4.6 Generate scenarios

```bash
rook generate --total 20 --yes --json    # default classes: functional + adversarial
rook scenarios list --json
```

Narrow it with `--class functional|non_functional|adversarial` or
`--category happy_path,prompt_injection,…`. You can also pass steering text after `--`.

### 4.7 Review the scenarios

Generated scenarios can contain bad checks. In this repo, 4 of 20 did:

- a **regex check** that passes when its pattern *matches*, written to forbid something, so it
  enforced the opposite;
- a "must not contain X" regex that can never match a reply longer than one line;
- a **forbidden word** banned from the whole reply when only part of the reply (the customer
  note) should exclude it;
- a check applied to the whole reply that should apply to one section.

Read each `scenarios/SC-*.yaml` before you gate on it. To leave a scenario out of runs without
deleting it, use `rook scenarios exclude SC-004 SC-009 --json` (separate arguments, not
comma-separated).

### 4.8 Rehearse

```bash
rook run --concurrency 1 --name rehearsal-1 --yes --json > run.json
rook report "$(jq -r .run_id run.json)" --json > report.json
```

Use `--test` to keep a rehearsal out of the project's history. Then read the verdicts:
`runs/<run-id>/scenarios/<SC>/verdict.yaml` holds every criterion with its expected value,
achieved value and quoted evidence.

**Run it at least twice.** Model latency and judge variance mean that a scenario that passed once
is not yet a reliable gate.

### 4.9 Record the reviewed suite upstream

```bash
rook sync --yes
rook status --json        # every agent should be "tree": "clean"
```

---

## 5. Step 2: Commit the suite to your repository

Commit `.testmuai/rook/`. Its own `.gitignore` already leaves out caches, logs and the
machine-specific `state.json`. Also add these to your repository's `.gitignore`:

```gitignore
.env
rook-results/
# plus wherever your agent writes per-run state, e.g.
.scribe-sessions/
```

**Never commit `~/.testmuai/rook/`** (your Rook home). It holds credentials, the `rook env`
values and session transcripts.

On Windows, set these once for the repository:

```bash
git config core.longpaths true     # Rook evidence paths exceed 260 characters
git config core.autocrlf false     # keep bytes identical between your machine and Linux CI
```

Before the first push, check that no secret value is staged. Search for each value from `.env`;
`-l` prints only file names:

```bash
git grep --cached -l -F -- "$(grep '^MY_AGENT_TOKEN=' .env | cut -d= -f2-)"   # expect no output
```

---

## 6. Step 3: Add the gate script and workflow

Copy two files from this repository into yours.

### 6.1 `ci/rook-ci.sh` (the gate)

It is based on TestMu AI's reference gate (<https://www.testmuai.com/support/docs/rook-github-actions/>),
with fixes found while running it for real:

| Change | Why |
|---|---|
| `rook login --username … --access-key …` | The reference script never signs in, so a fresh `ROOK_HOME` is anonymous. |
| Finds the project folder by `*--<project-id>` | Rook names folders `<slug>--<id>`, not `<id>`. A bare-ID glob also counted a folder that does not exist. |
| Writes the profile's secret with `rook env set --from` (mode 0600, then deleted) | CI starts with an empty `ROOK_HOME`, and the secret must not appear in argv or logs. |
| `--yes` on `sync` and `run` | No permissions are stored on a fresh runner, so Rook would decline the hook and tool calls. |
| A login diagnosis on failure | Rook reports any 401/403 as "credentials were refused", including a proxy blocking the runner. The diagnosis tells the two apart. |

Things to change for your agent:

- the `: "${MY_AGENT_TOKEN:?…}"` check and the `printf 'MY_AGENT_TOKEN=%s\n'` line, to match
  the variables your profile declares (this repo uses `SCRIBE_API_TOKEN`);
- the gate policy at the end, if you choose the permissive policy (see [section 10](#10-choosing-which-scenarios-gate-a-release)).

### 6.2 `.github/workflows/rook-assurance.yml`

The workflow's key choices:

```yaml
on:
  workflow_dispatch:                       # on demand
  pull_request:                            # pre-merge gate
    branches: [main]
    paths: ['agent/**', '.testmuai/rook/**', 'ci/**', '.github/workflows/rook-assurance.yml']
permissions:
  contents: read
concurrency:
  group: rook-assurance-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: false                # a started run has spent credits; let it finish
jobs:
  assurance:
    # same-repo PRs and manual runs on main only: fork code never runs with your secrets
    if: >-
      (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||
      (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)
    runs-on: ubuntu-24.04
    environment: rook-assurance # secrets live here, scoped and protectable
    env:
      ROOK_ENV: ${{ vars.ROOK_ENV || 'prod' }}
      ROOK_PROJECT_ID: ${{ vars.ROOK_PROJECT_ID }}
      # … ROOK_AGENT_ID, ROOK_PROFILE, ROOK_SCENARIO_IDS, ROOK_RUN_NAME
    steps:
      - uses: actions/checkout@v7
        with: { persist-credentials: false }
      # set up your agent's runtime here (this repo: Python 3.12 + Node 22)
      - name: Install pinned public Rook CLI
        run: |
          curl -fsSL https://raw.githubusercontent.com/LambdaTest/rook/main/install.sh -o "$RUNNER_TEMP/install-rook.sh"
          bash "$RUNNER_TEMP/install-rook.sh" --version 0.1.5 --dir "$RUNNER_TEMP/rook-bin"
          echo "$RUNNER_TEMP/rook-bin" >> "$GITHUB_PATH"
          echo "ROOK_HOME=$RUNNER_TEMP/rook-home" >> "$GITHUB_ENV"
      - name: Run the reviewed suite
        env: { LT_USERNAME: …, LT_ACCESS_KEY: …, MY_AGENT_TOKEN: …, <model key>: … }
        run: bash ci/rook-ci.sh
      - name: Preserve results even on failure
        if: always()
        uses: actions/upload-artifact@v7
        with: { path: rook-results/, retention-days: 7 }
```

Things to change for your agent:

- **`paths`**: the folders that change your agent's behaviour, plus `.testmuai/rook/**`, `ci/**`
  and the workflow itself. PRs that touch nothing on the list (docs, for example) don't spend
  credits. *(This repo: `incident_scribe/**`, `services/**`, `.mcp.json`, `package*.json`.)*
- **runtime setup steps**: whatever your agent needs (Python, Node, Java, a database container, …);
- **the env block of "Run the reviewed suite"**: your profile's variables and your agent's
  model provider settings;
- **timeout**: roughly scenario count × slowest turn × 2. This repo uses 60 minutes for 3
  scenarios at concurrency 1, which is generous.

> **Gotcha:** `${{ runner.temp }}` is **not allowed in job-level `env`**. GitHub rejects the
> workflow with `Unrecognized named-value: 'runner'`. Set `ROOK_HOME` from a step through
> `$GITHUB_ENV`, as shown above.

---

## 7. Step 4: Configure GitHub

### 7.1 Create the environment

Go to **Settings → Environments → New environment** and name it `rook-assurance`.

- *Deployment branches:* **No restriction**. PR runs come from PR refs, not `main`, so restricting
  this to `main` would block them. The job's `if:` already limits runs to same-repo PRs and
  manual runs on `main`.
- *Required reviewers* (recommended): add yourself or your team. Each run, including each push to
  a PR, then waits for someone to click **Approve and deploy** before it uses the secrets or spends
  credits. This is the "explicitly approve" control TestMu AI recommends.

### 7.2 Environment secrets

| Secret | Value |
|---|---|
| `LT_USERNAME` | Rook account username *(this repo: `rookprod`)* |
| `LT_ACCESS_KEY` | That account's access key, for the **same environment** as `ROOK_ENV` |
| *your profile's secrets* | e.g. `SCRIBE_API_TOKEN` *(this repo)* |
| *your agent's model key* | e.g. `GLM_API_KEY` *(this repo)* |

### 7.3 Environment variables

| Variable | Value |
|---|---|
| `ROOK_PROJECT_ID` | Shown by `rook project create`, or in `.testmuai/rook/settings.json` |
| `ROOK_AGENT_ID` | The agent's local ID: its folder name under `agents/` *(this repo: `incident-scribe`)* |
| `ROOK_PROFILE` | Profile name *(this repo: `local`)* |
| `ROOK_SCENARIO_IDS` | Comma-separated, no spaces *(this repo: `SC-004,SC-008,SC-009`)* |
| `ROOK_ENV` | Optional. `prod` (the default) or `stage` |
| `ROOK_CONCURRENCY` | Optional. Defaults to 1 |
| `ROOK_ALLOW_RULES` | Optional. Scoped tool grants, one per line |
| *agent config* | e.g. `LLM_PROVIDER`, `GLM_MODEL`, `ANTHROPIC_BASE_URL` *(this repo)* |

---

## 8. Step 5: Run it and read the result

Go to **Actions → Rook assurance → Run workflow** and choose `main`.

A passing log ends with:

```
Pass: 3 | Fail: 0 | Unable to Verify: 0
Unjudged: 0 | Not run: 0 | Unrunnable: 0
Run ID: 2026-10-05T11-02-33Z
Rook release gate passed.
```

Where to find the evidence:

- **GitHub artifact** `rook-<run-id>-<attempt>`, kept 7 days:
  - `run.json`: the run outcome and credit cost;
  - `report.json`: totals and failure clusters;
  - `evidence.tar.gz`: every scenario's request, response, hook record, captured files and
    `verdict.yaml`.
- **Rook dashboard**: the run appears under the project as `github-pr<N>-<run_id>-<attempt>` for a PR, or `github-<run_id>-<attempt>` for a manual run. Open a
  scenario to see each criterion's expected value, achieved value and evidence. The
  **Response** tab shows exactly what the agent returned.

Rook gives each scenario one of three verdicts:

- **Pass**: every criterion was met, and the evidence is quoted.
- **Fail**: a criterion was contradicted by evidence. Read `expected` against `achieved`.
- **Unable to Verify**: Rook could not observe enough to decide. The reason is one of:
  - `agent_never_ran`: the profile or transport failed before the agent answered;
  - `not_observable`: the criterion depends on something Rook cannot see;
  - `undecidable`: Rook saw enough but could not reach a verdict.

---

## 9. Writing a profile for your agent

A profile has up to five hooks: `prepare`, `open`, `execute`, `close`, `collect`. Each hook is a
script that prints **exactly one JSON object** on stdout. Anything else must go to stderr.

| Hook | Input | Must return |
|---|---|---|
| `open` | none | `{ "conversation": "<id>" }` to start a multi-turn session |
| `execute` | the goal on **stdin**; `ROOK_CONVERSATION` in env | `{ "agent_reply": "<non-empty text>", "calls": [...], "usage": {...}, … }` |
| `collect` | `ROOK_CONVERSATION`, `ROOK_STATE_DIR` in env | anything; Rook copies every absolute path and URL in it into the evidence |

Variables Rook passes to every hook: `ROOK_HOOK`, `ROOK_WORKSPACE`, `ROOK_PROJECT`,
`ROOK_AGENT`, `ROOK_RUN_ID`, `ROOK_SCENARIO_ID`, `ROOK_SESSION`, `ROOK_TURN`,
`ROOK_CONVERSATION`, `ROOK_STATE_DIR` (one per scenario), `ROOK_RUN_STATE_DIR`.

Common target types:

| Your agent is… | Profile approach |
|---|---|
| an HTTP API | `rook profile add api --from curl.txt`, where the file holds a curl with `{{goal}}` |
| a CLI | `rook profile add cli --command 'my-agent run "{{goal}}"'`, or a script like this repo's |
| an MCP tool | declare the server and call the tool; see the Rook MCP docs |

### What makes a profile give useful evidence

These lessons come from this repo's profile
(`.testmuai/rook/projects/*/agents/incident-scribe/scripts/local.mjs`).

1. **Return the tool calls** in `execute` as `calls: [{name, arguments}]`. Without them, every
   "the agent called X" criterion is *Unable to Verify*.
2. **Add a `collect` hook.** This repo's `collect` hook:
   - writes an evidence file with every turn's full reply and each tool call paired with its
     *result*, taken from the agent's transcript;
   - returns the paths of the files the agent wrote and the image URLs it produced, which Rook
     copies into the run.

   This is how criteria such as "the reply used the facts returned by the lookup" become
   checkable.
3. **Isolate state per scenario.** Use the stable `ROOK_STATE_DIR` to derive a short, per-scenario
   folder, and point the agent's state and any writes there. On Windows, keep the folder short:
   `ROOK_STATE_DIR` itself is deep enough to exceed the 260-character path limit.
4. **Put that folder inside the workspace (gitignored)** if you want Rook's judge to list it with
   its own tools.
5. **Handle every reply shape.** For example, `needs_input` replies may carry their text under
   `answer`, not `question`. A hook that finds no text fails the scenario as *agent_never_ran*.
6. **Set realistic timeouts.** A single model turn here reached 112 s, and a 120 s limit
   turned real answers into *agent_never_ran*. The hook's own timeout bounds the scenario.
7. **Never let a stdin write crash the hook.** If the hook writes to a child process (for example
   `python --version`, or a command that never reads stdin) after it has exited, Linux raises
   `EPIPE`. Without a `child.stdin.on("error")` handler, the hook dies before the agent runs.
   This never shows up on Windows, so a Windows-only rehearsal will not catch it.
8. **Test each change** with `rook profile test <name> --goal "…"`. It is free, and a goal that only
   asks for a reply avoids side effects.

Hand edits are supported. Rook cannot tell a hand-written hook from one it wrote. Do **not**
re-run `rook profile add` on a profile you have fixed: it rewrites the script.

---

## 10. Choosing which scenarios gate a release

`ROOK_SCENARIO_IDS` is the release contract. Only listed scenarios run, and every one must pass.

**Strict policy (this repo, and TestMu AI's guide):** fail the job on any Fail, Unable to
Verify, unjudged, not-run or unrunnable result, or on any compromised adversarial scenario.

**Permissive policy (the Rook skill's general recipe):** fail only on Fail, compromised or
incomplete results. Print Unable to Verify counts but do not fail on them.

Since this repo uses the strict policy:

- **Gate only on scenarios that passed in at least two local runs.** One pass is not evidence of
  stability.
- **Leave out scenarios whose criteria Rook cannot check**, such as "did not write a file" or
  "did not call X". See [section 15](#15-known-rook-limitations-015). These come out *Unable to
  Verify* no matter how the agent behaves.
- **Start small.** This repo began with 3 scenarios. Add an ID once it has proven reliable; that
  is a change to one variable, with no code change.
- Adding a scenario costs roughly 8–15 credits per CI run.

---

## 11. Day-to-day: when to regenerate and when not to

| You changed… | Do this |
|---|---|
| Internal code, same behaviour and interface | **Nothing.** Push and run the workflow. That is the regression test working. |
| Behaviour: a new rule, tool or output | `rook explore . --yes` → `rook generate --yes` (both incremental) → review the new scenarios → rehearse with `rook run --only <new IDs> --test` → `rook sync --yes` → commit → add the IDs to `ROOK_SCENARIO_IDS` |
| How the agent is called: CLI args, URL, auth, output fields | Edit the hook script by hand → `rook profile test` → `rook sync --yes` → commit |
| Nothing, but a gated scenario became unreliable | Remove its ID from `ROOK_SCENARIO_IDS` and investigate locally |

Regenerating scenarios on every change would replace your reviewed regression suite with new,
unreviewed tests each time. Don't.

---

## 12. Moving the suite to another account or environment

You can reuse reviewed specs, scenarios and profiles under a different Rook account, or on a
different Rook environment (`prod` or `stage`), **without** re-running explore or generate. This
repo has done it twice: once to stage, and once to the `rookprod` account.

1. Sign in as the target account, in the target environment. Keep separate Rook homes so the
   sign-ins don't overwrite each other:
   ```bash
   export ROOK_HOME=~/.testmuai/rook-stage ROOK_ENV=stage      # e.g. for stage
   unset LT_USERNAME LT_ACCESS_KEY                             # or they override the sign-in
   rook login
   rook project create my-agent-ci                             # note the new <new-id>
   ```
2. Copy the definitions, **leaving out** each agent's `state.json` (it holds the old account's
   agent IDs) and `runs/` (the old evidence):
   ```bash
   cd .testmuai/rook/projects
   mkdir -p my-agent-ci--<new-id>/agents
   (cd my-agent-ci--<old-id>/agents && tar -cf - --exclude=state.json --exclude=runs .) \
     | (cd my-agent-ci--<new-id>/agents && tar -xf -)
   cp my-agent-ci--<old-id>/active my-agent-ci--<new-id>/active
   ```
3. Redo the setup that lives in the Rook home:
   ```bash
   rook agent use <agent>; rook profile use <profile>
   rook mcp approve <server> --origin discovered     # if any
   rook env set --from <secrets file>
   rook profile test <profile> --goal "Say hello and nothing else."
   rook sync --yes            # expect "new upstream — recording everything"
   rook status --json         # expect "tree": "clean"
   ```
4. Rehearse (`rook run --only <IDs>`), commit the new project folder, and update the CI
   variables: `ROOK_PROJECT_ID`, `LT_USERNAME`, `LT_ACCESS_KEY` and, if it changed, `ROOK_ENV`.
   Scenario IDs stay the same.

> **Environment access:** Rook **stage** (`*.lambdatestinternal.com`) only accepts traffic from
> the LambdaTest VPN. GitHub-hosted runners get a Cloudflare **403** page, which Rook reports as
> "credentials were refused". To run CI on stage, you need one of:
> - a Cloudflare exception: a GitHub Actions IP allowlist, or a service token;
> - a self-hosted runner on the VPN.
>
> **prod** works from anywhere. The public CLI includes both environments; `ROOK_ENV` selects one.

---

## 13. Turning it into a real CD gate

As committed, the workflow runs on **pull requests into `main`** from branches in this repository,
and on demand. To make it actually *block* changes, do **B** below. **A** and **C** are
additional patterns.

### Why PRs from forks are excluded

In this pipeline, the PR's own code runs with your secrets: the agent, and the profile's hook
script that Rook executes. A PR could edit that script to send `LT_ACCESS_KEY` or your model key
anywhere. TestMu AI's guidance:

> "The manual trigger avoids exposing credentials to untrusted pull-request code. Do not replace
> it with `pull_request_target` plus a checkout of an untrusted PR."
> ([Rook with GitHub Actions](https://www.testmuai.com/support/docs/rook-github-actions/))

> "Do not run untrusted pull-request hook scripts with repository secrets."
> ([Agent assurance in CI/CD](https://www.testmuai.com/support/docs/agent-assurance-ci-cd/))

So:

- PRs from branches **in this repository** run the gate. Their authors already have write access.
- PRs from **forks** are skipped by the job's `if:`. GitHub's `pull_request` event would not give
  them secrets anyway.
- **Never** switch to `pull_request_target`. It *does* give secrets to fork code.
- To test a fork PR, have a maintainer review the code, push it to a branch in this repository,
  and open the PR from there.

**A. Make deployment depend on it** (simplest):
```yaml
jobs:
  assurance:   { … as in rook-assurance.yml … }
  deploy:
    needs: assurance          # deploy only if the Rook gate passed
    runs-on: ubuntu-24.04
    environment: production
    steps: [ … your deploy … ]
```

**B. Require it before merging** (the PR trigger is already in the workflow):
1. Open one PR that touches the agent, so the check runs once and GitHub learns its name.
2. Go to **Settings → Branches → Add branch protection rule** (or **Rulesets**) for `main`, turn on
   **Require status checks to pass**, and select **`assurance`**.
3. Merging is now blocked while the Rook gate is red or still running.

Note on path filters: a PR that touches none of the `paths` doesn't run the check, and a
*required* check that never runs leaves the PR waiting. Either keep the check optional for such
PRs, or drop `paths` and accept a run (and its credits) on every PR.

**C. On a schedule**, to catch drift in the model provider:
```yaml
on:
  schedule: [ { cron: "0 3 * * 1-5" } ]
```

**Cost controls** (every trigger spends credits):

- Use path filters so changes to docs only don't trigger a run (already in this workflow).
- Keep `concurrency.cancel-in-progress: false` so a run is never killed halfway through. The group
  is per PR, so different PRs don't queue behind each other.
- Keep the gate list small; run the full suite on a schedule instead.
- Add required reviewers on the environment for runs you approve by hand.

**Evaluate a deployed instance:** the profile in this repo runs the agent from source on the
runner. To test what you actually deployed (for example in a staging environment), add a second
profile that calls the deployed URL (`rook profile add staging --from curl.txt`), and run that
profile after deploy-to-staging and before promoting to production.

---

## 14. Using it on other CI platforms

`ci/rook-ci.sh` is plain bash and needs only `rook`, `jq` and `tar`. To port the pipeline, rebuild
the workflow's wiring on the other platform:

| Concern | GitHub Actions | Any other CI |
|---|---|---|
| Secrets | environment secrets | the platform's secret store, passed as env vars |
| Isolated Rook home | `ROOK_HOME=$RUNNER_TEMP/rook-home` | any empty temp directory outside the checkout |
| Run label | `ROOK_RUN_NAME=github-$run_id-$attempt` | any unique build ID |
| Evidence | `actions/upload-artifact` on `rook-results/`, always | archive `rook-results/` even when the job fails |
| One run at a time | `concurrency:` group | the platform's lock or serial stage |

TestMu AI also publishes Jenkins and Argo CD versions of the gate:
<https://www.testmuai.com/support/docs/agent-assurance-ci-cd/>.

---

## 15. Known Rook limitations (0.1.5)

These were confirmed by reading the 0.1.5 CLI. They come out *Unable to Verify* no matter what
the agent or profile does, so leave scenarios that depend on them out of a strict gate:

| Criterion type | Why it can't be verified |
|---|---|
| `json_path` checks (e.g. `$.status`) | Rook stores the hook's output as a JSON **string**, so the path never resolves. |
| "The agent did **not** write a file" | Rook takes no filesystem snapshot and always tells the judge the filesystem was not observed. The judge does not accept evidence that the profile supplies. |
| `not_called` tool expectations | Rook never treats a reported call list as complete (Rook issue #975). |
| Arguments on a `called` expectation | Only `called_with` matches arguments. |
| `verification_requires` naming an MCP server but no `op` | Not runnable. Name the operation. |

The judge's own judgement also varies a little between runs. That is another reason to gate only
on scenarios that have passed repeatedly.

---

## 16. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Invalid workflow file … Unrecognized named-value: 'runner'` | `${{ runner.temp }}` used in job-level `env` | Set it from a step through `$GITHUB_ENV` |
| A PR shows no Rook check at all | The PR comes from a fork (skipped by design), or it touched none of the `paths` | Push the branch to this repository; or run it on demand |
| The PR check says *Waiting* / "Review deployments" | The environment has required reviewers | A reviewer clicks **Review deployments → Approve and deploy** |
| A required check stays "Expected — waiting for status" | The PR touched none of the `paths`, so the check never ran | Make the check optional for such PRs, or drop `paths` |
| `No files were found with the provided path: rook-results/` | The gate failed before it created the results folder | Read the **Run the reviewed suite** step's log; this warning is only a symptom |
| `Expected exactly one committed project folder … found 2` (or 0) | Wrong `ROOK_PROJECT_ID`, or the bare-ID glob bug | Check the variable; use the fixed script |
| `Set LT_USERNAME through your CI secret store` | Secret missing, or added at repository level instead of in the environment | Add it to the `rook-assurance` environment |
| `those credentials were refused`, with diagnosis **401 JSON** | Wrong username or key for that environment | Copy the key again from Account Settings; keys differ between prod and stage |
| `those credentials were refused`, with diagnosis **403 HTML, server: cloudflare** | The environment blocks the runner's network (stage is VPN-only) | Cloudflare exception, or a self-hosted runner, or use prod |
| Scenarios `agent_never_ran`, Rook's summary says `write EPIPE` | The hook wrote to an exited child's stdin on Linux | Handle `child.stdin` errors; only write when there is input |
| `agent_never_ran`, `exceeded N seconds` | The hook's command timeout is shorter than a slow model turn | Raise the hook's timeout; lower concurrency |
| `agent_never_ran`, `getaddrinfo failed` | DNS or network blip reaching the model provider | Re-run; consider retries in the agent |
| Local runs fine, CI hook fails | OS differences: `python3` vs `python`, paths, EPIPE, line endings | Test the hook on Linux; `core.autocrlf false` |
| `rook` uses the wrong account locally | `LT_USERNAME`/`LT_ACCESS_KEY` set in the shell override `rook login` | Unset them |
| `filename too long` on `git add` (Windows) | Deep Rook evidence paths | `git config core.longpaths true` |
| The run passes but nothing appears on the dashboard you expected | Wrong `ROOK_ENV`, account or project | Check `rook doctor` / `rook status --json` locally with the same values |

The gate also refuses to pass if the run was halted or discarded, if the report's `run_id` does
not match, or if the counts don't add up. Read `rook-results/run.json` (`error`, `reason`,
`discarded`) for the cause.

---

## 17. Security checklist

- [ ] Secrets live in a **GitHub environment**, not in the repo and not in workflow YAML.
- [ ] The workflow never runs fork code with secrets (`workflow_dispatch`, or a same-repo
      `pull_request` guard; never `pull_request_target`).
- [ ] `permissions: contents: read` and `persist-credentials: false` on checkout.
- [ ] Profiles refer to secrets as `${VAR}`, and values go through `rook env set`.
- [ ] `ROOK_HOME` is a throwaway directory outside the checkout, never cached, uploaded or committed.
- [ ] The uploaded artifact contains only `rook-results/` (run, report, evidence), never `ROOK_HOME`.
- [ ] Before every commit, staged files have been searched for each secret value.
- [ ] Every `write: true` call in `agent.yaml` has been reviewed, and scenario state is disposable.
- [ ] `--yes` is used only on `sync` and `run`, and lasts for one command. Use `--allow` rules
      if you need tighter scoping.
- [ ] The CI account is a dedicated account, with credits sized for the expected run volume.

---

## 18. Reference

### Files in this repository

| File | What it is |
|---|---|
| `.github/workflows/rook-assurance.yml` | The workflow |
| `ci/rook-ci.sh` | The gate script |
| `.testmuai/rook/settings.json` | The workspace's selected project |
| `.testmuai/rook/projects/<slug>--<id>/agents/<agent>/agent.yaml` | Agent spec from `explore` |
| `…/features/F-*.yaml` | Capabilities the scenarios are derived from |
| `…/scenarios/SC-*.yaml` | The test scenarios |
| `…/profiles/<name>.yaml` | Profile: hooks and timeouts |
| `…/scripts/<name>.mjs` | Hook script |
| `…/runs/<run-id>/` | Rehearsal evidence: `report.yaml`, and per scenario `verdict.yaml`, `response.json`, `hooks.json`, `artifacts/` |

### Gate script inputs

| Variable | Required | Meaning |
|---|---|---|
| `LT_USERNAME`, `LT_ACCESS_KEY` | yes | Rook account for `ROOK_ENV` |
| `ROOK_HOME` | yes | Empty directory outside the checkout |
| `ROOK_PROJECT_ID` | yes | Upstream project ID; also locates `.testmuai/rook/projects/*--<id>` |
| `ROOK_AGENT_ID` | yes | Agent folder name under `agents/` |
| `ROOK_PROFILE` | yes | Profile name |
| `ROOK_SCENARIO_IDS` | yes | `SC-001,SC-002`: comma-separated, no spaces, no duplicates |
| `ROOK_ENV` | no | `prod` (default) or `stage` |
| `ROOK_CONCURRENCY` | no | Scenarios in parallel, 1–8 (default 1) |
| `ROOK_RUN_NAME` | no | Run label shown on the dashboard |
| `ROOK_ALLOW_RULES` | no | Newline-separated `--allow` rules |
| `ROOK_RESULTS_DIR` | no | Output folder (default `rook-results`); must not already exist |
| *profile variables* | yes | Whatever your profile declares (this repo: `SCRIBE_API_TOKEN`) |

### Useful commands

```bash
rook doctor                           # reachability, sign-in, project, mode
rook status --json                    # per-agent sync state ("tree")
rook plan --json                      # account and credits
rook scenarios list --json            # scenarios, runnable or not
rook profile test <p> --goal "…"      # free single call to the agent
rook run --only SC-1,SC-2 --test      # rehearsal kept out of history
rook report <run-id> --json           # report for this run, by ID (never "latest")
rook export logs --out ./rook-logs    # diagnostics for a bug report (no secrets)
```

### Further reading

- TestMu AI: Agent assurance in CI/CD: <https://www.testmuai.com/support/docs/agent-assurance-ci-cd/>
- TestMu AI: Rook with GitHub Actions: <https://www.testmuai.com/support/docs/rook-github-actions/>
- Rook CLI and installer: <https://github.com/LambdaTest/rook>
