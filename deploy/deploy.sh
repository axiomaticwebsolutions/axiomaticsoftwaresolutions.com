#!/usr/bin/env bash
# Release-based deploy of the Axiomatic app on an aaPanel server, without Docker (deploy/README.md).
#
#   bash deploy/deploy.sh --source <dir | archive.tar.gz | git-url> [--ref <branch|tag>] [--first-run] [options]
#
# Layout under AXS_BASE (default /www/wwwroot/axiomatic), owned by the app user (never root):
#   releases/<UTC yyyymmddHHMMSS>/  one complete copy per deploy: code, node_modules, .next
#   current -> releases/<...>       what PM2 runs; switched in one atomic rename after a good build
#   shared/.env.production          the only env file (chmod 600), symlinked into every release as .env.production
#   shared/logs/                    PM2 app logs (app-out.log, app-error.log) and deploy-<release>.log
#   shared/backups/                 pre-deploy database dumps (deploy/backup.sh)
#   shared/pnpm-store/              pnpm's content store (hard links keep the releases small)
#   shared/deploy.env               optional settings, never secrets (AXS_INSTANCES, AXS_MAX_MEMORY, ...; README)
#
# Order: preflight -> copy the source into a new release -> link shared/.env.production -> pnpm install
# --frozen-lockfile (devDependencies included: the build needs them) -> prisma generate -> check env, PostgreSQL
# (UTF8) and Redis -> pre-deploy backup -> prisma migrate deploy -> (--first-run) bootstrap catalog + Owner ->
# next build (prerenders from the database, so it runs after the migration) -> switch current -> pm2
# startOrReload --update-env -> /api/health -> pm2 save -> keep the newest AXS_KEEP_RELEASES (3) releases.
# A failure before the switch leaves the live site untouched and deletes the half-built release (--keep-failed
# keeps it). Automatic rollback: when PM2 cannot start the new release or /api/health does not answer 200 within
# AXS_HEALTH_TIMEOUT after the switch, `current` goes back to the previous release, PM2 reloads it and the health
# check runs again; the failed release stays on disk for inspection and the script exits 3 (1 when there is no
# previous release or it is not healthy either). Migrations are forward-only: a rollback (automatic or rollback.sh)
# switches code, never the database schema.
#
# Exit status: 0 deployed; 1 failed (before the switch the live site is unchanged; the message says what is live);
# 3 the new release failed after the switch and the previous release is live and healthy again; 130 interrupted.
# Never prints secret values (git URLs are shown without credentials).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$SCRIPT_DIR/common.sh"

usage() {
  cat <<'EOF'
Usage: bash deploy/deploy.sh --source <dir | archive.tar.gz | git-url> [options]

  --source PATH|URL   the code to deploy: a folder (e.g. an upload extracted to /www/wwwroot/axiomatic/src), a
                      .tar.gz made on Windows (deploy/README.md), or a git URL (https://... or git@...)
  --ref NAME          git branch or tag to deploy (default: the repository's default branch)
  --subdir PATH       the app folder inside the source (found automatically: the folder with package.json and
                      prisma.config.ts, e.g. axiomaticsoftwaresolutions.com/ in the repository)
  --first-run         first deploy: also run the production bootstrap (catalog, settings and the first Owner from
                      BOOTSTRAP_OWNER_* in shared/.env.production or exported in the shell). Safe to repeat;
                      required while no release exists
  --bootstrap         run the bootstrap on a later deploy too (adds settings and counters a newer version
                      introduced; once the Owner exists it needs no BOOTSTRAP_OWNER_* at all: unset them all)
  --base DIR          deployment root (default /www/wwwroot/axiomatic, or $AXS_BASE)
  --keep N            releases to keep (default 3, or AXS_KEEP_RELEASES)
  --skip-backup       no pre-deploy pg_dump (not recommended when migrations are pending)
  --keep-failed       keep the release folder when the deploy fails before the switch (for debugging)
  --allow-root        run as root anyway (only if root owns the deployment and PM2)
  -h, --help          this text

If the new release does not start or fails /api/health after the switch, the previous release is put back
automatically (exit status 3); the failed release stays in releases/ for inspection.

Typical runs, as the app user (sudo -iu axiomatic):
  bash /www/wwwroot/axiomatic/src/deploy/deploy.sh --source /www/wwwroot/axiomatic/src --first-run
  bash /www/wwwroot/axiomatic/current/deploy/deploy.sh --source /www/wwwroot/axiomatic/upload/axiomatic.tar.gz
  bash /www/wwwroot/axiomatic/current/deploy/deploy.sh --source git@github.com:owner/repo.git --ref main
EOF
}

SOURCE="" REF="" SUBDIR="" FIRST_RUN=0 RUN_BOOTSTRAP=0 ALLOW_ROOT=0 SKIP_BACKUP=0 KEEP_FAILED=0 KEEP_OPT=""
normalized=()
for arg in "$@"; do
  case "$arg" in
    --*=*) normalized+=("${arg%%=*}" "${arg#*=}") ;;
    *) normalized+=("$arg") ;;
  esac
done
set -- ${normalized[@]+"${normalized[@]}"}
while (( $# > 0 )); do
  case "$1" in
    --source|--ref|--subdir|--base|--keep)
      (( $# >= 2 )) || die "$1 needs a value (see --help)"
      case "$1" in
        --source) SOURCE="$2" ;;
        --ref) REF="$2" ;;
        --subdir) SUBDIR="${2%/}" ;;
        --base) AXS_BASE="${2%/}" ;;
        --keep) KEEP_OPT="$2" ;;
      esac
      shift 2 ;;
    --first-run) FIRST_RUN=1; shift ;;
    --bootstrap) RUN_BOOTSTRAP=1; shift ;;
    --allow-root) ALLOW_ROOT=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --keep-failed) KEEP_FAILED=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done
[[ -n "$SOURCE" ]] || { usage >&2; die "--source is required"; }
[[ "$AXS_BASE" == /* ]] || die "--base must be an absolute path"
if [[ -n "$KEEP_OPT" ]]; then AXS_KEEP_RELEASES="$KEEP_OPT"; fi

refuse_root "$ALLOW_ROOT"
load_deploy_settings

STEP_TOTAL=13 STEP_NO=0 STEP_NAME="start" STEP_HINT="" SWITCHED=0 REL="" RELEASE_NAME="" PREV_RELEASE=""
STAGE_TMP="" DEPLOY_LOG="" STARTED_AT=$SECONDS
# HEALTHY: the new release passed the health check after the switch. ROLLBACK: "" (not needed), "done" (the previous
# release is live and healthy again), "failed" (it is live again but not healthy) or "none" (nothing to go back to).
HEALTHY=0 ROLLBACK=""

step() {
  STEP_NO=$((STEP_NO + 1)); STEP_NAME="$1"; STEP_HINT="${2:-}"
  printf '\n==> [%d/%d] %s\n' "$STEP_NO" "$STEP_TOTAL" "$STEP_NAME"
}

on_exit() {
  local status=$?
  if [[ -n "$STAGE_TMP" && -d "$STAGE_TMP" ]]; then rm -rf -- "$STAGE_TMP"; fi
  if (( status == 0 )); then return 0; fi
  printf '\n' >&2
  printf '%s DEPLOY FAILED in step %d/%d: %s (exit %d)\n' "$(axs_now)" "$STEP_NO" "$STEP_TOTAL" "$STEP_NAME" "$status" >&2
  if [[ -n "$STEP_HINT" ]]; then printf '  What to do: %s\n' "$STEP_HINT" >&2; fi
  if (( SWITCHED == 0 )); then
    if [[ -n "$REL" && -d "$REL" ]]; then
      if (( KEEP_FAILED )); then
        printf '  The unfinished release is kept for inspection: %s\n' "$REL" >&2
      else
        rm -rf -- "$REL"
        printf '  The unfinished release %s was deleted (--keep-failed keeps it).\n' "$RELEASE_NAME" >&2
      fi
    fi
    printf '  The live site is unchanged: current -> %s\n' "${PREV_RELEASE:-(none yet)}" >&2
    printf '  Fix the cause and run the same command again.\n' >&2
  elif [[ "$ROLLBACK" == done ]]; then
    printf '  AUTOMATIC ROLLBACK: the new release %s did not pass the health check after the switch, so\n' "$RELEASE_NAME" >&2
    printf '  current points at the previous release %s again; PM2 runs it and %s answers 200.\n' "$PREV_RELEASE" "$AXS_HEALTH_URL" >&2
    printf '  The live site is the previous version. The failed release stays on disk: %s\n' "$REL" >&2
    printf '  Database: migrations this deploy applied stay applied (forward-only; deploy/README.md "Rollback").\n' >&2
    printf '  Look:    the PM2 log lines above the rollback, or pm2 logs %s --lines 300\n' "$AXS_APP_NAME" >&2
    printf '  Fix the cause and deploy again.\n' >&2
  elif [[ "$ROLLBACK" == failed ]]; then
    printf '  The new release %s failed the health check, and the automatic rollback to %s did not bring\n' "$RELEASE_NAME" "$PREV_RELEASE" >&2
    printf '  the site back either: current -> %s, NOT healthy. The site is probably down.\n' "$(current_release)" >&2
    printf '  Look:    pm2 logs %s --lines 200   and   curl -i %s   (database, Redis, disk, memory)\n' "$AXS_APP_NAME" "$AXS_HEALTH_URL" >&2
    printf '  Then:    bash %s/deploy/restart.sh --recreate,  or an older release: bash %s/deploy/rollback.sh --list\n' "$AXS_CURRENT" "$AXS_CURRENT" >&2
  elif (( HEALTHY )); then
    printf '  The new release %s is live and healthy (current -> %s); only this later step failed.\n' "$RELEASE_NAME" "$RELEASE_NAME" >&2
  else
    printf '  current now points at the NEW release %s, but it is not healthy.\n' "$RELEASE_NAME" >&2
    printf '  Look:    pm2 logs %s --lines 200   and   curl -i %s\n' "$AXS_APP_NAME" "$AXS_HEALTH_URL" >&2
    if [[ -n "$PREV_RELEASE" ]]; then
      printf '  Go back: bash %s/releases/%s/deploy/rollback.sh --to %s\n' "$AXS_BASE" "$PREV_RELEASE" "$PREV_RELEASE" >&2
    else
      printf '  This was the first release, so there is nothing to roll back to: fix the cause and deploy again.\n' >&2
    fi
  fi
  if [[ -n "$DEPLOY_LOG" ]]; then printf '  Full log: %s\n' "$DEPLOY_LOG" >&2; fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# auto_rollback: the new release failed after the switch (PM2 could not start it, /api/health did not answer 200 or a
# process runs in another folder). Puts the previous release back (restore_release: switch + PM2 reload + health
# check) and exits: 3 when the previous release is healthy again, 1 when there is none or it is not healthy either.
# on_exit prints what is live.
auto_rollback() {
  printf '\n'
  if [[ -z "$PREV_RELEASE" ]]; then
    ROLLBACK="none"
    warn "the new release $RELEASE_NAME is not healthy and there is no previous release to roll back to"
    exit 1
  fi
  warn "the new release $RELEASE_NAME is not healthy: rolling back to $PREV_RELEASE automatically"
  if restore_release "$PREV_RELEASE"; then
    ROLLBACK="done"
    say "ROLLED BACK automatically: $PREV_RELEASE is live and healthy again"
    exit 3
  fi
  ROLLBACK="failed"
  warn "the automatic rollback to $PREV_RELEASE did not bring a healthy site back"
  exit 1
}

# ------------------------------------------------------------------------------------------------------------------
step "Preflight checks" "fix the problem named above, then run the same command again"
command -v curl >/dev/null 2>&1 || die "curl is missing (apt-get install -y curl)"
command -v tar >/dev/null 2>&1 || die "tar is missing"
resolve_node_tools
# pm2_clean even for --version: the first pm2 command starts the PM2 daemon, which keeps the environment it started with.
say "node $("$AXS_NODE" -p 'process.versions.node') ($AXS_NODE), pm2 $(pm2_clean --version 2>/dev/null | tail -n 1), pnpm via ${PNPM[*]}"

mkdir -p "$AXS_RELEASES" "$AXS_BASE/shared/logs" "$AXS_BASE/shared/run" "$AXS_BASE/shared/backups"
[[ -w "$AXS_RELEASES" && -w "$AXS_BASE/shared/logs" ]] || die "$AXS_BASE is not writable by $(id -un) (as root: chown -R $(id -un): $AXS_BASE)"
take_lock

[[ -f "$AXS_ENV_FILE" ]] || die "missing $AXS_ENV_FILE. Create it once with:
  node <source>/scripts/gen-prod-env.mjs --out $AXS_ENV_FILE
then fill in every CHANGE-ME value (deploy/README.md)"
[[ -r "$AXS_ENV_FILE" ]] || die "$AXS_ENV_FILE is not readable by $(id -un)"
env_mode="$(stat -c '%a' "$AXS_ENV_FILE")"
if [[ "$env_mode" != 600 && "$env_mode" != 400 ]]; then
  if [[ -O "$AXS_ENV_FILE" ]]; then
    chmod 600 "$AXS_ENV_FILE"
    say "tightened $AXS_ENV_FILE to mode 600 (was $env_mode)"
  else
    die "$AXS_ENV_FILE has mode $env_mode; as root: chown $(id -un): $AXS_ENV_FILE && chmod 600 $AXS_ENV_FILE"
  fi
fi

placeholders="$(grep -iE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=.*change-?me' "$AXS_ENV_FILE" \
  | sed -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*).*/\2/' | tr '\n' ' ')" || true
[[ -z "$placeholders" ]] || die "fill in the CHANGE-ME values in $AXS_ENV_FILE first: $placeholders"

if [[ -e "$AXS_CURRENT" && ! -L "$AXS_CURRENT" ]]; then die "$AXS_CURRENT exists but is not a symlink; move it away first"; fi
PREV_RELEASE="$(current_release)"
if [[ -z "$PREV_RELEASE" ]]; then
  (( FIRST_RUN )) || die "there is no current release yet, so this is the first deploy: run again with --first-run"
  say "first deploy (no current release)"
else
  say "live release: $PREV_RELEASE"
  if (( FIRST_RUN )); then say "--first-run with an existing release: the bootstrap runs again (it only adds what is missing)"; fi
fi

avail_kb="$(df -Pk "$AXS_BASE" | awk 'NR == 2 { print $4 }')"
if (( avail_kb < 3 * 1024 * 1024 )); then die "only $((avail_kb / 1024)) MB free on $AXS_BASE; a release needs about 2-3 GB while it builds"; fi
mem_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
swap_kb="$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo)"
total_mb=$(( (mem_kb + swap_kb) / 1024 ))
if [[ -z "$AXS_BUILD_HEAP_MB" ]]; then
  if (( total_mb >= 6144 )); then AXS_BUILD_HEAP_MB=3072; elif (( total_mb >= 3584 )); then AXS_BUILD_HEAP_MB=2048; else AXS_BUILD_HEAP_MB=1536; fi
fi
say "memory $((mem_kb / 1024)) MB + swap $((swap_kb / 1024)) MB; build heap ${AXS_BUILD_HEAP_MB} MB"
if (( mem_kb < 3584 * 1024 && swap_kb < 2048 * 1024 )); then
  warn "less than 4 GB RAM and under 2 GB swap: next build may run out of memory. Add a swap file (deploy/README.md \"Swap\")."
fi
pm2_checks

# ------------------------------------------------------------------------------------------------------------------
step "Copy the source into a new release" "check --source (and --ref / --subdir); for git, check the deploy key or token"
RELEASE_NAME="$(date -u +%Y%m%d%H%M%S)"
if [[ -e "$AXS_RELEASES/$RELEASE_NAME" ]]; then sleep 1; RELEASE_NAME="$(date -u +%Y%m%d%H%M%S)"; fi
REL="$AXS_RELEASES/$RELEASE_NAME"
mkdir "$REL"
umask 077
DEPLOY_LOG="$AXS_BASE/shared/logs/deploy-$RELEASE_NAME.log"
: > "$DEPLOY_LOG"
umask 022
exec > >(tee -a "$DEPLOY_LOG") 2>&1
say "release $RELEASE_NAME, log $DEPLOY_LOG"

redact_url() { printf '%s' "$1" | sed -E 's#^([a-z+]+://)[^/@]*@#\1***@#'; }
source_label="$SOURCE" source_kind="" commit=""
if [[ -d "$SOURCE" ]]; then
  source_kind="folder"
  stage_root="$(cd "$SOURCE" && pwd -P)"
  if [[ -n "$REF" ]]; then warn "--ref is ignored for a folder source"; fi
elif [[ -f "$SOURCE" && "$SOURCE" =~ \.(tar\.gz|tgz|tar)$ ]]; then
  source_kind="archive"
  STAGE_TMP="$(mktemp -d "$AXS_BASE/shared/run/source.XXXXXX")"
  tar -xf "$SOURCE" -C "$STAGE_TMP"
  stage_root="$STAGE_TMP"
elif [[ "$SOURCE" =~ ^(https://|http://|ssh://|git://|file://|[A-Za-z0-9._-]+@[^:]+:) ]]; then
  source_kind="git"
  command -v git >/dev/null 2>&1 || die "git is missing (apt-get install -y git)"
  source_label="$(redact_url "$SOURCE")"
  STAGE_TMP="$(mktemp -d "$AXS_BASE/shared/run/source.XXXXXX")"
  clone_args=(clone --quiet --depth 1 --single-branch)
  if [[ -n "$REF" ]]; then clone_args+=(--branch "$REF"); fi
  say "git clone $source_label${REF:+ (ref $REF)}"
  GIT_TERMINAL_PROMPT=0 git "${clone_args[@]}" -- "$SOURCE" "$STAGE_TMP/repo" 2> >(sed -E 's#([a-z+]+://)[^/@ ]*@#\1***@#g' >&2)
  commit="$(git -C "$STAGE_TMP/repo" rev-parse HEAD)"
  stage_root="$STAGE_TMP/repo"
else
  die "--source must be an existing folder, a .tar.gz archive or a git URL"
fi

find_app_root() {
  local root="$1" dir
  local -a found=()
  if [[ -n "$SUBDIR" ]]; then
    [[ -f "$root/$SUBDIR/package.json" ]] || die "--subdir $SUBDIR has no package.json in the source"
    printf '%s' "$root/$SUBDIR"; return 0
  fi
  if [[ -f "$root/package.json" && -f "$root/prisma.config.ts" ]]; then printf '%s' "$root"; return 0; fi
  for dir in "$root"/*/; do
    if [[ -f "$dir/package.json" && -f "$dir/prisma.config.ts" ]]; then found+=("${dir%/}"); fi
  done
  (( ${#found[@]} == 1 )) || die "cannot find the app folder in the source (none or several with package.json + prisma.config.ts); pass --subdir"
  printf '%s' "${found[0]}"
}
app_root="$(find_app_root "$stage_root")"
if [[ "$app_root" != "$stage_root" ]]; then say "app folder: ${app_root#"$stage_root"/}"; fi
if [[ -z "$commit" ]] && command -v git >/dev/null 2>&1 && git -C "$app_root" rev-parse --git-dir >/dev/null 2>&1; then
  commit="$(git -C "$app_root" rev-parse HEAD 2>/dev/null)" || commit=""
fi

copy_app_tree "$app_root" "$REL"
if [[ -n "$STAGE_TMP" ]]; then rm -rf -- "$STAGE_TMP"; STAGE_TMP=""; fi

for required in package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts next.config.ts \
  scripts/bootstrap-production.ts deploy/ecosystem.config.cjs deploy/preflight.mjs deploy/backup.sh; do
  [[ -f "$REL/$required" ]] || die "the source has no $required; is it the app folder of this project?"
done
stray="$(find "$REL" -maxdepth 1 -name '.env*' ! -name '.env.example' -printf '%f ')"
[[ -z "$stray" ]] || die "the release contains env files Next.js would load ($stray); only shared/.env.production may be used"
if grep -lq $'\r' "$REL"/deploy/*.sh 2>/dev/null; then die "deploy/*.sh in the source has Windows line endings (CRLF); fix .gitattributes / the archive"; fi
{
  printf 'release=%s\n' "$RELEASE_NAME"
  printf 'source=%s (%s)\n' "$source_label" "$source_kind"
  printf 'ref=%s\ncommit=%s\n' "${REF:-}" "${commit:-unknown}"
  printf 'deployed_by=%s\ndeployed_at=%s\n' "$(id -un)" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
} > "$REL/.release"
say "copied from $source_label ($source_kind${commit:+, commit ${commit:0:12}})"

# ------------------------------------------------------------------------------------------------------------------
step "Link shared/.env.production into the release"
ln -s "../../shared/.env.production" "$REL/.env.production"
[[ -r "$REL/.env.production" ]] || die "$REL/.env.production does not resolve to $AXS_ENV_FILE"
say ".env.production -> shared/.env.production"

# Commands below run in the release; NODE_OPTIONS / NEXT_DIST_DIR from the caller's shell must not leak in.
unset NODE_OPTIONS NEXT_DIST_DIR
export CI=1
in_release() { (cd "$REL" && "$@"); }

# ------------------------------------------------------------------------------------------------------------------
step "Install dependencies (pnpm install --frozen-lockfile)" \
  "needs internet access to registry.npmjs.org and binaries.prisma.sh; a lockfile error means pnpm-lock.yaml does not match package.json in the source"
# Without NODE_ENV, so devDependencies (TypeScript, Tailwind, tsx, prisma CLI) are installed: the build needs them.
in_release env -u NODE_ENV "${PNPM[@]}" install --frozen-lockfile --reporter=append-only \
  --store-dir "$AXS_BASE/shared/pnpm-store"

# ------------------------------------------------------------------------------------------------------------------
step "Generate the Prisma client"
in_release env -u NODE_ENV "${PNPM[@]}" exec prisma generate

# ------------------------------------------------------------------------------------------------------------------
step "Check the environment, PostgreSQL and Redis" \
  "edit $AXS_ENV_FILE (the lines above name each variable and rule; values are never printed), or start PostgreSQL / Redis"
preflight_args=(--db --redis)
if (( FIRST_RUN )) && [[ -z "$PREV_RELEASE" ]]; then preflight_args+=(--first-run); fi
in_release env NODE_ENV=production "$AXS_NODE" --import tsx deploy/preflight.mjs "${preflight_args[@]}"

# ------------------------------------------------------------------------------------------------------------------
step "Back up the database before migrating" \
  "pg_dump failed: check the message above (deploy/README.md \"Backups\"), or re-run with --skip-backup"
if (( SKIP_BACKUP )); then
  warn "skipped (--skip-backup)"
elif [[ -z "$PREV_RELEASE" ]]; then
  say "skipped (first deploy: nothing to protect yet)"
else
  AXS_BASE="$AXS_BASE" BACKUP_DIR="$AXS_BASE/shared/backups" BACKUP_PREFIX="pre-deploy" BACKUP_RETENTION_DAYS=7 \
    bash "$REL/deploy/backup.sh" now
fi

# ------------------------------------------------------------------------------------------------------------------
step "Apply database migrations (prisma migrate deploy)" \
  "read the Prisma error above; '${PNPM[*]} exec prisma migrate status' (run in $REL with NODE_ENV=production) shows the state. A failed migration must be fixed and marked with 'prisma migrate resolve' before the next deploy"
in_release env NODE_ENV=production "${PNPM[@]}" exec prisma migrate deploy

# ------------------------------------------------------------------------------------------------------------------
step "Production bootstrap (catalog, settings, first Owner)" \
  "the bootstrap names the variable or rule above (BOOTSTRAP_OWNER_* in $AXS_ENV_FILE); it is safe to run again"
if (( FIRST_RUN || RUN_BOOTSTRAP )); then
  in_release env NODE_ENV=production "$AXS_NODE" --import tsx scripts/bootstrap-production.ts
else
  say "skipped (runs with --first-run or --bootstrap)"
fi

# ------------------------------------------------------------------------------------------------------------------
step "Build (next build, heap ${AXS_BUILD_HEAP_MB} MB)" \
  "'JavaScript heap out of memory' or a killed build: add swap or set AXS_BUILD_HEAP_MB in shared/deploy.env. Database errors: the build prerenders pages from PostgreSQL"
# Only the compiler cache: .next/cache/fetch-cache holds data cached by the old code (ISR), never reused across releases.
if [[ -n "$PREV_RELEASE" && -d "$AXS_RELEASES/$PREV_RELEASE/.next/cache/webpack" ]]; then
  mkdir -p "$REL/.next/cache"
  if cp -a "$AXS_RELEASES/$PREV_RELEASE/.next/cache/webpack" "$REL/.next/cache/webpack"; then
    say "reusing the webpack build cache of $PREV_RELEASE"
  else
    warn "could not copy the previous build cache (the build just takes longer)"
    rm -rf -- "$REL/.next/cache/webpack"
  fi
fi
in_release env NODE_ENV=production NODE_OPTIONS="--max-old-space-size=$AXS_BUILD_HEAP_MB" "${PNPM[@]}" run build
[[ -f "$REL/.next/BUILD_ID" ]] || die "next build finished without .next/BUILD_ID"
release_complete "$RELEASE_NAME" || die "the release is incomplete after the build"

# ------------------------------------------------------------------------------------------------------------------
step "Switch current to $RELEASE_NAME"
switch_current "$RELEASE_NAME"
SWITCHED=1
say "current -> releases/$RELEASE_NAME (was ${PREV_RELEASE:-none})"

# ------------------------------------------------------------------------------------------------------------------
step "Start or reload the app with PM2, then check /api/health" \
  "pm2 logs $AXS_APP_NAME --lines 200 shows why the new release did not answer"
if ! reload_app "$REL"; then auto_rollback; fi
HEALTHY=1
touch "$REL/.deploy-ok"

# ------------------------------------------------------------------------------------------------------------------
step "Clean up old releases"
mapfile -t all_releases < <(list_releases)
remove_count=$(( ${#all_releases[@]} - AXS_KEEP_RELEASES ))
for (( i = 0; i < remove_count; i++ )); do
  old="${all_releases[$i]}"
  if [[ "$old" == "$RELEASE_NAME" || "$old" == "$PREV_RELEASE" ]]; then continue; fi
  rm -rf -- "${AXS_RELEASES:?}/$old"
  say "removed release $old"
done
find "$AXS_BASE/shared/logs" -maxdepth 1 -type f -name 'deploy-*.log' -mtime +30 -delete 2>/dev/null || true
say "releases kept: $(list_releases | tr '\n' ' ')"

STEP_NAME="done"
printf '\n'
say "DEPLOYED $RELEASE_NAME in $(( (SECONDS - STARTED_AT) / 60 ))m $(( (SECONDS - STARTED_AT) % 60 ))s${commit:+ (commit ${commit:0:12})}"
say "check from your PC: node scripts/smoke-prod.mjs --base=<APP_URL>"
if (( FIRST_RUN )); then
  say "first run: sign in at <APP_URL>/sign-in as BOOTSTRAP_OWNER_EMAIL, then DELETE the BOOTSTRAP_OWNER_* lines from $AXS_ENV_FILE"
  say "and set up the aaPanel cron tasks (deploy/README.md \"Scheduled jobs\") if they do not exist yet"
fi
if grep -qE '^[[:space:]]*BOOTSTRAP_OWNER_PASSWORD[[:space:]]*=[[:space:]]*[^[:space:]]' "$AXS_ENV_FILE" && (( ! FIRST_RUN )); then
  warn "BOOTSTRAP_OWNER_PASSWORD is still in $AXS_ENV_FILE: delete that line (it is only used by --first-run)"
fi
