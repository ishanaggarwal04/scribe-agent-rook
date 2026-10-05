#!/usr/bin/env bash
# Reviewed-suite release gate. Requires Rook, bash, jq, and tar.
# Based on https://www.testmuai.com/support/resources/rook/rook-ci.sh, adapted for
# this repo: headless sign-in, the <slug>--<id> project folder Rook writes, and the
# profile's SCRIBE_API_TOKEN handed to `rook env` from the CI secret.
set -euo pipefail
set +x
umask 077

: "${LT_USERNAME:?Set LT_USERNAME through your CI secret store}"
: "${LT_ACCESS_KEY:?Set LT_ACCESS_KEY through your CI secret store}"
: "${ROOK_HOME:?Set ROOK_HOME to an isolated directory outside the checkout}"
: "${ROOK_PROJECT_ID:?Set the reviewed project ID}"
: "${ROOK_AGENT_ID:?Set the reviewed agent ID}"
: "${ROOK_PROFILE:?Set the reviewed profile name}"
: "${ROOK_SCENARIO_IDS:?Set a comma-separated list of reviewed scenario IDs}"
: "${SCRIBE_API_TOKEN:?Set SCRIBE_API_TOKEN (declared by the profile) through your CI secret store}"

for id in "$ROOK_PROJECT_ID" "$ROOK_AGENT_ID"; do
  [[ "$id" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid project/agent ID' >&2; exit 1; }
done
[[ "$ROOK_SCENARIO_IDS" =~ ^[a-zA-Z0-9_-]+(,[a-zA-Z0-9_-]+)*$ ]] || {
  echo 'Scenario IDs must be comma-separated, without spaces or empty entries' >&2; exit 1;
}
expected=$(jq -en --arg ids "$ROOK_SCENARIO_IDS" '
  ($ids | split(",")) as $list |
  if ($list | unique | length) == ($list | length)
  then ($list | length) else error("Duplicate scenario IDs") end')
for dependency in rook jq tar; do command -v "$dependency" >/dev/null; done

# Rook names the project folder <slug>--<id> (or a legacy bare <id>). nullglob only
# drops unmatched wildcards, not the literal legacy name, so keep what exists.
project_dirs=()
for candidate in .testmuai/rook/projects/*--"$ROOK_PROJECT_ID" .testmuai/rook/projects/"$ROOK_PROJECT_ID"; do
  if test -d "$candidate"; then project_dirs+=("$candidate"); fi
done
test "${#project_dirs[@]}" -eq 1 || {
  echo "Expected exactly one committed project folder for $ROOK_PROJECT_ID, found ${#project_dirs[@]}" >&2; exit 1;
}
agent_dir="${project_dirs[0]}/agents/$ROOK_AGENT_ID"
test -d "$agent_dir" || { echo "Missing committed agent definitions: $agent_dir" >&2; exit 1; }

results=${ROOK_RESULTS_DIR:-rook-results}
mkdir -p "$(dirname "$results")"
# Refuse a reused output directory: old results must never pass a new job.
mkdir "$results"
preserve_evidence() {
  code=$?
  trap - EXIT
  if test -d "$agent_dir/runs"; then
    tar -czf "$results/evidence.tar.gz" "$agent_dir/runs" || code=1
  fi
  exit "$code"
}
trap preserve_evidence EXIT

rook --version
# rook reports any 401/403 from the identity endpoint as "credentials were refused",
# which also covers an edge proxy refusing the runner. On failure, say which it was:
# the API's own 401 is JSON with a request_id; a proxy block is not. Never prints the key.
explain_login_failure() {
  local api
  case "${ROOK_ENV:-prod}" in
    stage) api=https://stage-rook-api.lambdatestinternal.com/api/v1 ;;
    *) api=https://rook-api.lambdatest.com/api/v1 ;;
  esac
  local body headers code
  body=$(mktemp); headers=$(mktemp)
  code=$(curl -s -o "$body" -D "$headers" -w '%{http_code}' \
    -H "Authorization: Basic $(printf '%s:%s' "$LT_USERNAME" "$LT_ACCESS_KEY" | base64 -w0)" \
    "$api/me" || true)
  echo "login diagnosis: GET $api/me -> HTTP $code" >&2
  grep -iE '^(content-type|server|cf-mitigated|cf-ray):' "$headers" | sed 's/^/  /' >&2 || true
  if jq -e . "$body" >/dev/null 2>&1; then
    jq -r '"  api says: \(.error.code // "ok") / \(.error.message // "") (request_id \(.request_id // "none"))"' "$body" >&2
  else
    echo "  body is not the API's JSON (first bytes: $(head -c 80 "$body" | tr -d '\n'))" >&2
  fi
  echo "  runner egress IP: $(curl -s --max-time 5 https://api.ipify.org || echo unknown)" >&2
  rm -f "$body" "$headers"
}
rook login --username "$LT_USERNAME" --access-key "$LT_ACCESS_KEY" || { explain_login_failure; exit 1; }
rook project use "$ROOK_PROJECT_ID"
rook agent use "$ROOK_AGENT_ID"
rook profile use "$ROOK_PROFILE"
# The profile references ${SCRIBE_API_TOKEN}; ROOK_HOME is fresh, so store it there.
# Written through a 0600 file so the value never appears in argv or the log.
mkdir -p "$ROOK_HOME"
env_file="$ROOK_HOME/profile.env"
printf 'SCRIBE_API_TOKEN=%s\n' "$SCRIBE_API_TOKEN" > "$env_file"
rook env set --from "$env_file" >/dev/null
rm -f "$env_file"
# No discovery or generation here: sync only the reviewed checkout.
# --yes: the runner is headless with no stored grants, so without it rook declines the
# profile's hook and tool calls. It lasts for the one command and writes no settings.
rook sync --agent "$ROOK_AGENT_ID" --yes

run_args=(run --only "$ROOK_SCENARIO_IDS" --profile "$ROOK_PROFILE"
  --concurrency "${ROOK_CONCURRENCY:-1}" --name "${ROOK_RUN_NAME:-ci-release-gate}" --yes)
while IFS= read -r rule; do
  test -z "$rule" || run_args+=(--allow "$rule")
done <<< "${ROOK_ALLOW_RULES:-}"

run_code=0
rook "${run_args[@]}" --json > "$results/run.json" || run_code=$?
if test "$run_code" -ne 0; then
  echo "Rook command failed (exit $run_code); inspect stderr and retained evidence." >&2
  exit "$run_code"
fi
jq -e '.ok == true and .halted == false and .discarded == null
  and (.run_id | type == "string" and length > 0)
  and (.report | type == "object")' "$results/run.json" >/dev/null
run_id=$(jq -er '.run_id' "$results/run.json")
rook report "$run_id" --json > "$results/report.json"
jq -e --arg id "$run_id" --argjson expected "$expected" '
  .run_id == $id and .report.run_id == $id
  and (.dir | type == "string" and length > 0)
  and (.report.totals | [.planned, .executed, .passed, .failed,
    .unverifiable, .unjudged, .not_run, .unrunnable] |
    all(.[]; type == "number" and . >= 0 and floor == .))
  and (.report.totals | .planned == $expected
    and .planned == (.executed + .not_run)
    and .executed == (.passed + .failed + .unverifiable + .unjudged))
  and (.report.clusters | type == "array")
' "$results/report.json" >/dev/null
jq -r '.report.totals |
  "Pass: \(.passed) | Fail: \(.failed) | Unable to Verify: \(.unverifiable)",
  "Unjudged: \(.unjudged) | Not run: \(.not_run) | Unrunnable: \(.unrunnable)"' \
  "$results/report.json"
printf 'Run ID: %s\n' "$run_id"
# Strict release policy: uncertainty is a blocked gate, not a fabricated Fail verdict.
jq -e --argjson expected "$expected" '
  (.report.totals | .executed == $expected and .passed == $expected
    and .failed == 0 and .unverifiable == 0 and .unjudged == 0
    and .not_run == 0 and .unrunnable == 0)
  and ([.report.clusters[] | select(.kind == "compromised")] | length == 0)
' "$results/report.json" >/dev/null
echo 'Rook release gate passed.'
