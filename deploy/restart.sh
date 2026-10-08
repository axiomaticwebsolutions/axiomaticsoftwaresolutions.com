#!/usr/bin/env bash
# Restarts the app on the current release and checks /api/health (deploy/README.md).
#
#   bash /www/wwwroot/axiomatic/current/deploy/restart.sh              pm2 reload: after editing shared/.env.production
#   bash /www/wwwroot/axiomatic/current/deploy/restart.sh --recreate   pm2 delete + start: after changing AXS_INSTANCES
#                                                                      (fork <-> cluster), AXS_PORT or the Node.js version
# Run it as the app user. Next.js reads .env.production when the process starts, so a reload picks up new values.
# That includes the STORAGE_* fallback: the bucket origin in the Content-Security-Policy is read at runtime, so a
# restart is enough (no deploy). Payments, email and storage saved in Admin > Settings > Integrations need neither.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$SCRIPT_DIR/common.sh"

RECREATE=0 ALLOW_ROOT=0
while (( $# > 0 )); do
  case "$1" in
    --recreate) RECREATE=1; shift ;;
    --base) (( $# >= 2 )) || die "--base needs a folder"; AXS_BASE="${2%/}"; shift 2 ;;
    --base=*) AXS_BASE="${1#*=}"; AXS_BASE="${AXS_BASE%/}"; shift ;;
    --allow-root) ALLOW_ROOT=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) die "unknown option '$1' (--recreate, --base DIR, --allow-root)" ;;
  esac
done
refuse_root "$ALLOW_ROOT"
load_deploy_settings
resolve_node_tools
take_lock

current="$(current_release)"
[[ -n "$current" ]] || die "no current release yet: run deploy.sh --first-run"
release_complete "$current" || die "the current release $current is incomplete; deploy again or roll back"
if (( RECREATE )); then
  say "pm2 delete $AXS_APP_NAME (the site is down until it starts again)"
  pm2_clean delete "$AXS_APP_NAME" >/dev/null 2>&1 || true
fi
reload_app "$AXS_RELEASES/$current" || die "the app is not healthy after the restart: pm2 logs $AXS_APP_NAME --lines 200"
say "RESTARTED $current"
