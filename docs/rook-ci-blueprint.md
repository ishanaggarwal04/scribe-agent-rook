# Testing an AI agent in CI with Rook

This repo tests its AI agent with **Rook** (TestMu AI Agent Assurance) in GitHub Actions. Follow
the steps below to set up the same pipeline for your own agent.

*(this repo)* marks values that are specific to this example agent, `incident-scribe`.

---

## What you get

- **Pull requests** that change the agent run **only the Rook scenarios the change affects**,
  and show a ✅ or ❌ check on the PR.
- **A nightly run** and **on-demand runs** run your whole list of reviewed scenarios.
- The job **fails unless every selected scenario passes**.
- Every run uploads its evidence as a build artifact and appears on the Rook dashboard.

```
Once, on your laptop                       Every CI run
────────────────────                       ────────────
rook explore   → agent spec                pick scenarios for this change
rook generate  → scenarios                 install Rook CLI, sign in with an access key
rook profile   → how to call the agent     rook sync  (your committed suite)
rook run       → rehearse, review          rook run   (only the picked scenarios)
rook sync      → record upstream           check every verdict → pass / fail
git commit .testmuai/rook/                 upload evidence
```

CI never writes scenarios. It only runs scenarios you have reviewed and committed, so results stay
predictable.

---

## Before you start

- An AI agent you own, which can run on a Linux CI runner (CLI, HTTP service, or MCP).
- A TestMu AI / LambdaTest account with Rook credits. Your **username** and **access key** are in
  the LambdaTest console under *Account Settings → Password & Security*.
- The Rook CLI installed locally (<https://github.com/LambdaTest/rook#install>).
- A GitHub repo for the agent.

Rough costs: explore ~30 credits, generating 20 scenarios ~300, and each scenario run
~8–15. `profile test`, `sync`, `status` and `doctor` are free.

---

## Step 1: Set up Rook locally (once)

Run these from your agent's repo root.

```bash
rook login                                   # browser sign-in
rook project create my-agent-ci              # note the project ID it prints
rook explore . --yes                         # finds your agent, writes its spec
```

Open the generated `agent.yaml` and check every call marked `write: true`. Scenarios really run
those writes, so point them at throwaway state.

Store your agent's secret(s) in Rook. The profile refers to them by name only:

```bash
printf 'MY_AGENT_TOKEN=%s\n' "$MY_AGENT_TOKEN" > /tmp/a.env
rook env set --from /tmp/a.env && rm /tmp/a.env
```

If your repo has an `.mcp.json`, approve those servers so Rook's grader can use them:

```bash
rook mcp approve <server-name> --origin discovered
```

Create the **profile**, which tells Rook how to call your agent, and test it:

```bash
rook profile add local --command 'my-agent run "{{goal}}"' --yes   # or --from notes.md
rook profile test local --goal "Say hello and nothing else."       # free
```

Generate scenarios, then **read them**:

```bash
rook generate --total 20 --yes
rook scenarios list --json
```

> Generated scenarios can have broken checks. In this repo 4 of 20 did, for example a regex
> written to *forbid* something that actually *required* it. Read each `scenarios/SC-*.yaml`
> before you trust it.

Rehearse **twice**, then record the reviewed suite:

```bash
rook run --concurrency 1 --yes
rook run --concurrency 1 --yes
rook sync --yes
```

Pick your **gate list**: scenarios that passed both times. Start small. This repo started with
`SC-004,SC-008,SC-009`.

> If `LT_USERNAME`/`LT_ACCESS_KEY` are set in your shell, they take priority over
> `rook login`. Unset them if they belong to a different account.

---

## Step 2: Copy the CI files into your repo

| File | What it does | What to change |
|---|---|---|
| `ci/rook-ci.sh` | The gate: sign in, sync, run, check every verdict | The secret name (`SCRIBE_API_TOKEN` *(this repo)* → yours) in the `: "${…:?}"` check and the `printf` line |
| `ci/select-scenarios.mjs` | Picks the scenarios a PR's change affects | Nothing |
| `ci/scenario-map.json` | Fills gaps in Rook's code → feature mapping | Rewrite it for your code (see [How PR runs pick scenarios](#how-pr-runs-pick-scenarios)); `{}` is a valid start |
| `.github/workflows/rook-assurance.yml` | The workflow | `paths:`, the runtime setup steps, and the `env:` block of *Run the reviewed suite* |

Also commit `.testmuai/rook/` (its own `.gitignore` already leaves out machine-only files), and
add these to your `.gitignore`:

```gitignore
.env
rook-results/
```

On Windows, run this once in the repo: `git config core.longpaths true` and
`git config core.autocrlf false`.

---

## Step 3: Configure GitHub

**Settings → Environments → New environment →** `rook-assurance`

- **Deployment branches:** *No restriction*. PR runs don't come from `main`, and the workflow
  already decides which runs are allowed.
- **Required reviewers:** optional. Add them if you want to approve each run before it spends
  credits.

**Environment secrets**

| Name | Value |
|---|---|
| `LT_USERNAME` | Rook account username |
| `LT_ACCESS_KEY` | Its access key |
| your profile's secret | e.g. `SCRIBE_API_TOKEN` *(this repo)* |
| your agent's model key | e.g. `GLM_API_KEY` *(this repo)* |

**Environment variables**

| Name | Value |
|---|---|
| `ROOK_PROJECT_ID` | from `rook project create` |
| `ROOK_AGENT_ID` | the agent's folder name under `.testmuai/rook/projects/*/agents/` |
| `ROOK_PROFILE` | `local` (or your profile's name) |
| `ROOK_SCENARIO_IDS` | your gate list, e.g. `SC-004,SC-008,SC-009`, with no spaces |
| your agent's config | e.g. `LLM_PROVIDER`, `GLM_MODEL` *(this repo)* |

Optional: `ROOK_ENV` (`prod` by default; `stage` only works inside the LambdaTest VPN) and
`ROOK_CONCURRENCY` (default 1).

---

## Step 4: Run it

- **Manually:** *Actions → Rook assurance → Run workflow* on `main`. This runs the whole gate list.
- **On a PR:** open a PR into `main` from a branch in your repo that changes agent code. This runs
  the affected scenarios.
- **Nightly:** runs by itself on weekdays at 02:30 UTC. This runs the whole gate list.

A passing run ends with:

```
Pass: 3 | Fail: 0 | Unable to Verify: 0
Rook release gate passed.
```

Where to look:

- **The job's Summary:** which scenarios were picked, and why.
- **The artifact** `rook-<run-id>-<attempt>`: `run.json`, `report.json`, and `evidence.tar.gz` with
  every scenario's verdict and evidence.
- **The Rook dashboard:** the run is named `github-pr<N>-…` for a PR, or `github-…` otherwise.

Rook gives each scenario one of three verdicts:

- **Pass:** the scenario met its criteria.
- **Fail:** it didn't.
- **Unable to Verify:** Rook couldn't observe enough to decide. The strict gate treats this as a
  failure.

> Quick self-test without touching behaviour: on a branch, reword a docstring in a function that
> belongs to a gated scenario's feature, and open a PR. That should run only that feature's
> scenarios. This repo verified it: a docstring change in `_policy_severity` ran exactly
> SC-008 and SC-009.

---

## How PR runs pick scenarios

1. The PR's diff is turned into the **functions and constants** it changes. Comment-only and
   blank-line edits are ignored.
2. Those are matched to **features**:
   - through Rook's own mapping (each `features/F-*.yaml` lists its `sources`);
   - plus `ci/scenario-map.json`.
3. The PR runs the gated scenarios of those features (each scenario names its `feature_id`). A
   changed scenario file runs that scenario.
4. **Fail-safe:** if anything changed that nothing maps, the **whole gate list** runs.

`ci/scenario-map.json` has three lists:

```json
{
  "ignore":        { "paths": ["docs/**"], "symbols": ["src/agent.py:debug_dump"] },
  "full_run_on":   { "sources": ["src/agent.py:SYSTEM_PROMPT", "src/llm.py"] },
  "extra_sources": { "F-003": ["src/agent.py:severity_helper"] }
}
```

| List | Put here |
|---|---|
| `ignore` | code your tested turns never reach |
| `full_run_on` | shared code every answer depends on: the system prompt, the main loop, the model client, the CLI, the profile, CI files |
| `extra_sources` | code that drives a feature but is missing from Rook's `sources` for it |

Rook's mapping is a good start but incomplete. Here, no feature listed the main prompt or the
severity helpers, which is why the fail-safe and this map exist.

If a PR's change doesn't touch any gated scenario's feature, nothing runs and the check passes
in seconds, with the job summary saying why.

**Selection can only pick from your gate list.** Put at least one reliable scenario per feature in
`ROOK_SCENARIO_IDS`, or changes to the other features are never tested on PRs. Keep the nightly
full run too: a prompt or model change can break a feature whose code didn't change.

---

## Advisory check or merge gate?

As set up here, the Rook check is **advisory**. A PR shows ✅ or ❌, but nothing stops a merge.
This repo is a demo, so it stays advisory.

For a real agent, especially when `main` gets deployed, make it a **merge gate**. Then a PR can't
merge until its Rook check has passed, so `main` only contains agent versions that passed.

| | Advisory | Merge gate |
|---|---|---|
| Rook finds a regression | ❌ on the PR, but it can still be merged | Merge is blocked until it's fixed |
| Merging before the check finishes | allowed | blocked |
| `main` contains | whatever was merged | only versions that passed |
| Good for | demos, solo work, early setup | real agents, teams, deploy-from-main |

**To make it a merge gate:**

1. **Remove the `paths:` filter** from the `pull_request` trigger in the workflow. A required check
   on a PR that doesn't match the filter never runs, so GitHub leaves the PR stuck on
   "Expected — waiting for status". Without the filter, every PR runs the check. Add your
   docs and other non-agent files to `ignore.paths` in `ci/scenario-map.json` (for example
   `"docs/**"`), so those PRs select no scenarios and pass in seconds without running Rook.
   Any file not listed there triggers the fail-safe and runs the whole gate list.
2. Open one PR so the check runs once.
3. Go to **Settings → Branches → Add rule** (or **Rulesets**) for `main` → **Require status checks
   to pass** → select **`assurance`**.

Only gate on scenarios that pass reliably. With a strict gate, one unreliable *Unable to Verify*
blocks a good PR.

---

## Keeping it up to date

| You changed… | Do this |
|---|---|
| Agent code, same behaviour | Nothing. Open the PR, and the affected scenarios run. |
| Agent behaviour (new rule, tool, output) | Locally run `rook explore . --yes`, then `rook generate --yes`. Review and rehearse the new scenarios, then `rook sync --yes`, commit, and add good IDs to `ROOK_SCENARIO_IDS` |
| How the agent is called (args, URL, auth) | Edit the profile's script by hand, then `rook profile test`, then `rook sync --yes`, then commit |
| Added a function your agent's turns use | Map it in `ci/scenario-map.json`; until then, PRs touching it run everything |

Don't run `rook profile add` again on a profile you've fixed. It rewrites the script.

---

## Moving to another Rook account or environment

You can reuse the same specs and scenarios without generating again:

1. Sign in to the new account, and create a project with `rook project create`.
2. Copy `.testmuai/rook/projects/<old>/agents/` into `.testmuai/rook/projects/<new>/agents/`,
   **leaving out** each agent's `state.json` and `runs/`.
3. Run `rook agent use …`, `rook profile use …`, `rook mcp approve …`, `rook env set …`, then
   `rook sync --yes`.
4. Commit, then update `ROOK_PROJECT_ID`, `LT_USERNAME` and `LT_ACCESS_KEY` in GitHub.

---

## Writing a good profile

The profile's script receives each scenario's goal and must print one JSON object containing
`agent_reply`. Lessons from this repo's script
(`.testmuai/rook/projects/*/agents/incident-scribe/scripts/local.mjs`):

- **Return the tool calls** (`calls: [{name, arguments}]`) so "did it call X" checks can pass.
- **Add a `collect` hook** that returns the files the agent wrote and its tool results. Rook copies
  them into the evidence.
- **Give each scenario its own throwaway state**, keyed by `ROOK_STATE_DIR`.
- **Allow for slow models.** A 120 s timeout cut off real answers here; 240 s works.
- **Handle stdin errors** (`child.stdin.on("error", …)`). On Linux, writing to a process that
  already exited crashes the script with `EPIPE`. This never shows up on Windows.

---

## Troubleshooting

| You see | Cause | Fix |
|---|---|---|
| `Unrecognized named-value: 'runner'` | `${{ runner.temp }}` in job-level `env` | Set it from a step through `$GITHUB_ENV` |
| `No files were found … rook-results/` | the gate failed earlier | Read the *Run the reviewed suite* log |
| `those credentials were refused` + diagnosis **401 JSON** | wrong username or key | Copy them again; prod and stage keys differ |
| `those credentials were refused` + diagnosis **403 HTML (cloudflare)** | the runner's network is blocked (stage is VPN-only) | Use prod, a self-hosted runner, or get access |
| scenarios `agent_never_ran`, `write EPIPE` | profile script crashed on Linux | Handle child stdin errors |
| `agent_never_ran`, `exceeded N seconds` | timeout shorter than the model's answer | Raise the profile's timeout |
| PR shows no Rook check | fork PR (skipped on purpose), or no file matched `paths` | Use a branch in the repo, or run it manually |
| PR check "waiting" | required reviewers on the environment | **Review deployments → Approve** |
| `filename too long` on `git add` (Windows) | deep Rook paths | `git config core.longpaths true` |

---

## Good to know

- **Some checks can never pass in Rook 0.1.5**, so don't gate on scenarios that use them:
  - "did *not* write a file";
  - "did *not* call X";
  - `json_path` checks.

  They come out *Unable to Verify* however the agent behaves.
- **Fork PRs never run the check.** The PR's own code would run with your secrets. Never switch to
  `pull_request_target`.
- **Secrets** live only in the GitHub environment and `rook env`, never in profiles, scenarios or
  commits.
- Official guides:
  - [Agent assurance in CI/CD](https://www.testmuai.com/support/docs/agent-assurance-ci-cd/)
  - [Rook with GitHub Actions](https://www.testmuai.com/support/docs/rook-github-actions/)
