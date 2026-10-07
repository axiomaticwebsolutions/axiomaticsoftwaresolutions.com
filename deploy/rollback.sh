#!/usr/bin/env bash
# Puts an earlier release back live: switches `current`, reloads PM2, checks /api/health (deploy/README.md "Rollback").
#
#   bash /www/wwwroot/axiomatic/current/deploy/rollback.sh                    the newest good release before current
#   bash /www/wwwroot/axiomatic/current/deploy/rollback.sh --to 20261007093000 a specific release
#   bash /www/wwwroot/axiomatic/current/deploy/rollback.sh --list             the releases on disk
#
# Run it as the app user (like deploy.sh). Only releases still on disk can come back (deploy.sh keeps 3).
# Database migrations are forward-only: a rollback changes the code, never the schema. The older code keeps working
# when the newer migrations only added things (new tables, columns with defaults, indexes), which is how this project
# writes them. If a newer migration removed or renamed something the older code uses, restore the pre-deploy dump
# (shared/backups/pre-deploy-*.dump, see deploy/backup.sh) after stopping the app.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$SCRIPT_DIR/common.sh"

TARGET="" LIST=0 ALLOW_ROOT=0
while (( $# > 0 )); do
  case "$1" in
    --to) (( $# >= 2 )) || die "--to needs a release name (see --list)"; TARGET="$2"; shift 2 ;;
    --to=*) TARGET="${1#*=}"; shift ;;
    --base) (( $# >= 2 )) || die "--base needs a folder"; AXS_BASE="${2%/}"; shift 2 ;;
    --base=*) AXS_BASE="${1#*=}"; AXS_BASE="${AXS_BASE%/}"; shift ;;
    --list) LIST=1; shift ;;
    --allow-root) ALLOW_ROOT=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "unknown option '$1' (--to NAME, --list, --base DIR, --allow-root)" ;;
  esac
done
load_deploy_settings

current="$(current_release)"
mapfile -t releases < <(list_releases)
(( ${#releases[@]} > 0 )) || die "no releases in $AXS_RELEASES"

describe() {
  local name="$1" marks="" commit=""
  if [[ "$name" == "$current" ]]; then marks+=" [current]"; fi
  if [[ -f "$AXS_RELEASES/$name/.deploy-ok" ]]; then marks+=" [was healthy]"; else marks+=" [never passed the health check]"; fi
  if ! release_complete "$name"; then marks+=" [INCOMPLETE]"; fi
  if [[ -f "$AXS_RELEASES/$name/.release" ]]; then commit="$(sed -n 's/^commit=//p' "$AXS_RELEASES/$name/.release")"; fi
  printf '  %s%s%s\n' "$name" "${commit:+ commit ${commit:0:12}}" "$marks"
}

if (( LIST )); then
  printf 'Releases in %s (oldest first):\n' "$AXS_RELEASES"
  for name in "${releases[@]}"; do describe "$name"; done
  exit 0
fi

refuse_root "$ALLOW_ROOT"
resolve_node_tools
take_lock

if [[ -z "$TARGET" ]]; then
  [[ -n "$current" ]] || die "current points nowhere; choose a release with --to (see --list)"
  for name in "${releases[@]}"; do
    if [[ "$name" < "$current" && -f "$AXS_RELEASES/$name/.deploy-ok" ]] && release_complete "$name"; then TARGET="$name"; fi
  done
  [[ -n "$TARGET" ]] || die "no earlier healthy release on disk; choose one with --to (see --list)"
fi
[[ "$TARGET" =~ ^[0-9]{14}$ && -d "$AXS_RELEASES/$TARGET" ]] || die "release '$TARGET' does not exist (see --list)"
[[ "$TARGET" != "$current" ]] || die "$TARGET is already current (to restart it: deploy/restart.sh)"
release_complete "$TARGET" || die "release $TARGET is incomplete (no build, dependencies or env link); pick another"

say "rolling back: current $current -> $TARGET"
switch_current "$TARGET"
if ! reload_app "$AXS_RELEASES/$TARGET"; then
  die "release $TARGET is live but not healthy. Back to the previous one: bash $AXS_RELEASES/$current/deploy/rollback.sh --to $current"
fi
touch "$AXS_RELEASES/$TARGET/.deploy-ok"
say "ROLLED BACK to $TARGET. The database keeps every migration applied so far (forward-only)."
say "the newer release $current stays on disk until a later deploy prunes it"
