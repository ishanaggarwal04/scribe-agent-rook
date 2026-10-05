# Rook assurance workflow

This GitHub Actions workflow tests an AI agent with **Rook** before changes go in. It runs the
agent against saved test scenarios, and the check fails if any scenario doesn't pass.

You need a Rook suite for your agent first: a `.testmuai/rook/` folder with a profile and
scenarios ([Rook docs](https://www.testmuai.com/support/docs/agent-assurance-ci-cd/)).

## When it runs

- **On a pull request** into `main` that changes the agent. It runs only the scenarios related to
  what changed.
- **Manually**, from the Actions tab. This runs all of your chosen scenarios.
- **Nightly** (optional, off by default to save credits). To run all scenarios every weekday
  night, uncomment the `schedule:` lines near the top of the workflow.

## What it does

```
1. Pick scenarios      based on what the PR changed (or all of them)
2. Install Rook
3. Run the tests       sign in → run the agent through each scenario → Rook grades it
4. Pass or fail        any failed scenario fails the check
5. Save the evidence   uploaded as a build artifact, and shown on the Rook dashboard
```

The agent runs on the GitHub runner, using the code from the pull request.

PRs from forks are skipped, so outside code never runs with your secrets.

## Use it in your repo

1. **Copy these files:**
   - `.github/workflows/rook-assurance.yml`
   - `ci/rook-ci.sh`
   - `ci/select-scenarios.mjs`
   - `ci/scenario-map.json`

2. **Edit them for your agent:**
   - In the workflow, set `paths:` to your agent's folders. Replace the Python/Node setup steps
     with whatever your agent needs. List your agent's secrets under *Run the reviewed suite*.
   - In `ci/rook-ci.sh`, replace `SCRIBE_API_TOKEN` with your agent's secret name.
   - In `ci/scenario-map.json`, map your own code (see below), or set it to `{}` to start.

3. **In GitHub**, go to *Settings → Environments* and create **`rook-assurance`**. Then add:
   - Secrets:
     - `LT_USERNAME` and `LT_ACCESS_KEY` (your Rook / LambdaTest account);
     - your agent's own secrets.
   - Variables:
     - `ROOK_PROJECT_ID`;
     - `ROOK_AGENT_ID` (the agent's folder name);
     - `ROOK_PROFILE` (e.g. `local`);
     - `ROOK_SCENARIO_IDS`: the scenarios to test, like `SC-004,SC-008,SC-009`.

4. **Run it** from *Actions → Rook assurance → Run workflow*, or open a pull request. A pass ends
   with `Rook release gate passed.`

Only list scenarios in `ROOK_SCENARIO_IDS` that pass reliably. One failure fails the check.

## How it picks scenarios for a PR

Each Rook scenario belongs to a feature, and each feature lists the code it uses. The workflow
looks at which functions the PR changed and runs the scenarios for those features.

- If a change can't be matched to a feature, it runs **all** scenarios, to be safe.
- If nothing relevant changed (docs, comments), it runs **nothing**, and the check passes.

`ci/scenario-map.json` fills in what Rook's mapping misses:

```json
{
  "ignore":        { "paths": ["docs/**"] },
  "full_run_on":   { "sources": ["src/agent.py:SYSTEM_PROMPT"] },
  "extra_sources": { "F-003": ["src/agent.py:severity_helper"] }
}
```

- **`ignore`:** files that never affect the agent.
- **`full_run_on`:** code everything depends on, such as the prompt. Changing it runs all scenarios.
- **`extra_sources`:** code that belongs to a feature but that Rook didn't list.

## Blocking merges (optional)

By default the check only **reports** ✅ or ❌, and a PR can still be merged. This demo repo keeps
it that way.

To **block** merging until the check passes:

1. Remove `paths:` from the workflow's `pull_request` trigger.
2. Add your docs to `ignore` in `ci/scenario-map.json`.
3. In *Settings → Branches*, require the **`assurance`** check on `main`.

## If something goes wrong

- **"credentials were refused":** check `LT_USERNAME` and `LT_ACCESS_KEY`. The log's
  *login diagnosis* line tells you whether the key was wrong (401) or the network was blocked (403).
- **No check on a PR:** the PR came from a fork, or it didn't change any file listed in `paths:`.
- **Scenario says "agent never ran":** the agent failed to start on the runner. Check your setup
  steps and your profile's script.
