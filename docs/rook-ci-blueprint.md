# Rook assurance workflow

A GitHub Actions workflow that tests an AI agent with **Rook** (TestMu AI Agent Assurance) on every
relevant pull request, every night, and on demand. Copy it into your repo to use Rook as the
assurance layer in your CI/CD.

It assumes you already have a working Rook suite for your agent: a committed `.testmuai/rook/`
folder with a profile and reviewed scenarios. Setting that up is covered by the
[Rook docs](https://www.testmuai.com/support/docs/agent-assurance-ci-cd/).

---

## How it works

```
trigger: PR into main │ nightly (weekdays 02:30 UTC) │ manual
        │
        ▼
1. Select scenarios ── PR:            only the scenarios whose feature the diff touches
        │              nightly/manual: the whole gate list (ROOK_SCENARIO_IDS)
        │              nothing selected → stop here, check passes, no credits spent
        ▼
2. Install the Rook CLI (pinned version)
        ▼
3. ci/rook-ci.sh
     rook login         access key from secrets (headless)
     rook project/agent/profile use
     rook env set       agent's secret, from a GitHub secret
     rook sync          the committed suite
     rook run --only <selected IDs> --json
     rook report        then check every verdict: any Fail or Unable to Verify → job fails
        ▼
4. Upload rook-results/ (run.json, report.json, evidence) as an artifact, even on failure
```

The agent itself runs **on the CI runner**, from the PR's code. Rook calls it through your
profile, simulates the user, and judges every scenario. The run also appears on the Rook
dashboard as `github-pr<N>-…` (PRs) or `github-…` (other runs).

**Safety:** only PRs from branches in the same repo run the check. A fork PR's code would run with
your secrets, so it is skipped. The workflow never uses `pull_request_target`.

---

## Files

| File | Role |
|---|---|
| `.github/workflows/rook-assurance.yml` | Triggers, runtime setup, wiring |
| `ci/select-scenarios.mjs` | Picks the scenarios a PR's diff affects |
| `ci/scenario-map.json` | Extra code → feature mapping for the selector |
| `ci/rook-ci.sh` | The gate: sign in, sync, run, check verdicts |

---

## Use it in your repo

**1. Copy the four files**, then change:

- **`rook-assurance.yml`:**
  - `paths:`: the folders that hold your agent and its tools (keep `.testmuai/rook/**`, `ci/**`
    and the workflow file itself);
  - the **runtime setup** steps your agent needs (this repo: Python 3.12 + Node 22);
  - the `env:` block of *Run the reviewed suite*: your agent's secrets and model settings.
- **`rook-ci.sh`:** the agent secret's name (`SCRIBE_API_TOKEN` here) in the `: "${…:?}"` check
  and the `printf` line.
- **`scenario-map.json`:** your own code. See [How PRs pick scenarios](#how-prs-pick-scenarios).
  `{}` also works, but then every code change runs the whole gate list.

**2. In GitHub, create an environment** under *Settings → Environments*, named `rook-assurance`.
Leave *Deployment branches* on **No restriction**. Optionally, add required reviewers to approve
each run before it spends credits.

**3. Add these to that environment:**

| Secrets | |
|---|---|
| `LT_USERNAME`, `LT_ACCESS_KEY` | Rook account (LambdaTest console → *Account Settings → Password & Security*) |
| your agent's secrets | e.g. its API token and model key |

| Variables | |
|---|---|
| `ROOK_PROJECT_ID` | your Rook project ID |
| `ROOK_AGENT_ID` | the agent's folder name under `.testmuai/rook/projects/*/agents/` |
| `ROOK_PROFILE` | the profile name (e.g. `local`) |
| `ROOK_SCENARIO_IDS` | the **gate list**: reliable scenarios, comma-separated, no spaces |
| your agent's config | e.g. model provider and name |
| `ROOK_ENV` *(optional)* | `prod` (default) or `stage` (stage only works inside the LambdaTest VPN) |

**4. Run it.** Use *Actions → Rook assurance → Run workflow*, or open a PR that changes the agent.
A pass ends with `Rook release gate passed.`, and the job's **Summary** shows which scenarios
were picked and why.

> Put only scenarios that pass reliably in `ROOK_SCENARIO_IDS`. The gate is strict: one
> *Unable to Verify* fails the job.

---

## How PRs pick scenarios

1. The diff is turned into the **functions and constants** it changes. Comments and blank lines are
   ignored.
2. Those are matched to **features**:
   - through Rook's mapping (each `features/F-*.yaml` lists its `sources`);
   - plus `ci/scenario-map.json`.
3. The PR runs the gated scenarios of those features. A changed scenario file runs that scenario.
4. **Fail-safe:** anything changed that nothing maps runs the **whole gate list**.

```json
{
  "ignore":        { "paths": ["docs/**"], "symbols": ["src/agent.py:debug_dump"] },
  "full_run_on":   { "sources": ["src/agent.py:SYSTEM_PROMPT", "src/llm.py"] },
  "extra_sources": { "F-003": ["src/agent.py:severity_helper"] }
}
```

- **`ignore`:** code your tested turns never reach.
- **`full_run_on`:** shared code every answer depends on: the prompt, the main loop, the model
  client.
- **`extra_sources`:** code that drives a feature but is missing from Rook's `sources`.

Selection only picks from the gate list. Put a reliable scenario for each feature in it, or changes
to the other features aren't tested on PRs. The nightly full run covers what per-PR selection can
miss.

---

## Advisory check or merge gate

By default the check is **advisory**: a PR shows ✅ or ❌, but it can still be merged. That's how
this demo repo uses it.

To make it a **merge gate**, so that `main` only ever holds versions that passed:

1. Remove `paths:` from the `pull_request` trigger. A required check on a PR that doesn't match the
   filter never runs, and the PR stays stuck on "waiting for status".
2. Add your docs and other non-agent files to `ignore.paths` in `ci/scenario-map.json`, so those PRs
   pass in seconds without running Rook.
3. Go to *Settings → Branches* → a rule for `main` → **Require status checks** → `assurance`.

---

## Troubleshooting

| You see | Fix |
|---|---|
| `those credentials were refused`, diagnosis **401 JSON** | Wrong username or access key for that environment |
| `those credentials were refused`, diagnosis **403 HTML (cloudflare)** | The runner's network is blocked (stage is VPN-only). Use prod or a self-hosted runner |
| `No files were found … rook-results/` | The gate failed earlier. Read the *Run the reviewed suite* log |
| Scenarios `agent_never_ran` | Your profile failed on Linux (timeouts, `EPIPE`). Check the profile's script |
| No Rook check on a PR | Fork PR (skipped by design), or no changed file matched `paths` |
| PR check "waiting" | The environment has required reviewers. Approve the run |
