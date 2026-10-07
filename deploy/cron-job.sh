#!/usr/bin/env bash
# Runs one scheduled job of the app for aaPanel Cron (deploy/README.md "Scheduled jobs"):
#   GET http://127.0.0.1:3000/api/cron/<job> with "Authorization: Bearer <CRON_SECRET>".
#
#   runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-job.sh emails|reconcile|renewals|maintenance
#   (or the wrappers cron-emails.sh, cron-reconcile.sh, cron-renewals.sh, cron-maintenance.sh)
#
# Always as the app user, never as root: aaPanel Cron runs tasks as root, so the task's script content starts with
# `runuser -u axiomatic --`. This file belongs to the app user; root running it would let anything that took over the
# app become root (deploy/README.md "Privileges"). Run as root, it refuses with the exact line to use instead.
#
# The secret is read from shared/.env.production on every run and handed to curl on stdin: it never appears in the
# panel, on a command line (ps) or in a log. The app is called on 127.0.0.1 directly (Nginx answers 404 for
# /api/cron/ from outside). One line per run that did something (AXS_CRON_VERBOSE=1: every run) or failed;
# the response holds counts, ids and task names only. Exit status 1 when the job failed (aaPanel marks the run
# failed); a run is skipped (exit 0) while the previous run of the same job is still going.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$SCRIPT_DIR/common.sh"

job="${1:-}"
case "$job" in
  emails) max_time=120 ;;
  reconcile|renewals|maintenance) max_time=330 ;;
  *) printf 'usage: %s emails|reconcile|renewals|maintenance\n' "$0" >&2; exit 2 ;;
esac
refuse_root_job "cron-$job.sh"
load_deploy_settings
command -v curl >/dev/null 2>&1 || die "cron $job: curl is missing"
[[ -r "$AXS_ENV_FILE" ]] || die "cron $job: cannot read $AXS_ENV_FILE as $(id -un) (run the job as the app user that owns it)"
secret="$(env_file_value "$AXS_ENV_FILE" CRON_SECRET)" || die "cron $job: CRON_SECRET is missing in $AXS_ENV_FILE"
secret_re='^[A-Za-z0-9._~+/=-]{32,}$'
[[ "$secret" =~ $secret_re ]] || die "cron $job: CRON_SECRET must be 32+ letters, digits or ._~+/=- (gen-prod-env.mjs makes one)"

# The app user's lock folder (the deploy scripts lock there too).
lock_dir="$AXS_BASE/shared/run"
if ! mkdir -p "$lock_dir" 2>/dev/null || [[ ! -w "$lock_dir" ]]; then lock_dir="${TMPDIR:-/tmp}"; fi
if command -v flock >/dev/null 2>&1; then
  exec 9>"$lock_dir/axiomatic-cron-$job.lock"
  if ! flock -n 9; then say "cron $job skipped: the previous run is still going"; exit 0; fi
fi

body="$(mktemp)"
errors="$(mktemp)"
trap 'rm -f -- "$body" "$errors"' EXIT
url="http://127.0.0.1:${AXS_PORT}/api/cron/$job"
started=$SECONDS
code="$(printf 'header = "Authorization: Bearer %s"\n' "$secret" \
  | curl --silent --show-error --config - --connect-timeout 5 --max-time "$max_time" \
      --output "$body" --write-out '%{http_code}' "$url" 2>"$errors")" || true
unset secret
took=$((SECONDS - started))
summary="$(head -c 300 "$body" 2>/dev/null | tr -d '\r\n')" || true
if [[ "$code" == 200 ]]; then
  # Quiet when there was nothing to do: no count in the whole body is above 0 and no task was left unfinished
  # ("more"). {"sent":0,"failed":0} every minute, or reconcile's nested summary every 10 minutes, would only grow
  # the aaPanel task log. The bodies carry counts, ids, task names and the provider name, never ":<digit>" text.
  if [[ "${AXS_CRON_VERBOSE:-0}" != 1 ]] && ! grep -Eq ':[1-9]|"more"' "$body"; then exit 0; fi
  say "cron $job ok in ${took}s $summary"
  exit 0
fi
detail="$(head -c 300 "$errors" 2>/dev/null | tr -d '\r\n')" || true
case "$code" in
  000|"") hint="the app does not answer on 127.0.0.1:${AXS_PORT} (as the app user: pm2 status)" ;;
  401) hint="CRON_SECRET in the file differs from the one the running app loaded (restart the app after changing it)" ;;
  503) hint="the database or Redis is unavailable" ;;
  *) hint="see pm2 logs ${AXS_APP_NAME}" ;;
esac
printf '%s cron %s FAILED http=%s in %ss %s %s: %s\n' "$(axs_now)" "$job" "${code:-000}" "$took" "$summary" "$detail" "$hint" >&2
exit 1
