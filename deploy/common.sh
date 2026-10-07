# shellcheck shell=bash
# Shared helpers for deploy/*.sh (sourced, never run on its own). Bash 4.3+, GNU coreutils/findutils (Ubuntu/Debian).
# Nothing here prints a secret value: env values are only captured into variables.
#
# Settings: environment variables win, then $AXS_BASE/shared/deploy.env (optional, KEY=value lines, never secrets),
# then the defaults below. AXS_BASE itself comes from the environment or a --base option.
set -euo pipefail

AXS_BASE="${AXS_BASE:-/www/wwwroot/axiomatic}"

axs_now() { date '+%Y-%m-%d %H:%M:%S %z'; }
say() { printf '%s %s\n' "$(axs_now)" "$*"; }
warn() { printf '%s WARNING: %s\n' "$(axs_now)" "$*" >&2; }
die() { printf '%s ERROR: %s\n' "$(axs_now)" "$*" >&2; exit 1; }

# env_file_value FILE KEY: prints KEY's value from a dotenv file (the last assignment wins), without surrounding
# quotes, an unquoted trailing comment or a CR. Returns 1 when the key is missing or empty. Capture it, never echo it.
env_file_value() {
  local file="$1" key="$2" line value
  [[ -r "$file" ]] || return 1
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" | tail -n 1)" || true
  [[ -n "$line" ]] || return 1
  line="${line%$'\r'}"
  value="${line#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    *) value="${value%%#*}"; value="${value%"${value##*[![:space:]]}"}" ;;
  esac
  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

# url_decode STRING: percent-decoding for the user and password parts of a connection URL.
url_decode() {
  local s="$1" out="" ch re='^([^%]*)%([0-9A-Fa-f]{2})(.*)$'
  while [[ "$s" =~ $re ]]; do
    printf -v ch '%b' "\x${BASH_REMATCH[2]}"
    out+="${BASH_REMATCH[1]}${ch}"
    s="${BASH_REMATCH[3]}"
  done
  printf '%s' "$out$s"
}

# parse_database_url URL: sets DB_USER, DB_PASSWORD, DB_HOST, DB_PORT and DB_NAME (query parameters are ignored).
parse_database_url() {
  local url="$1" userinfo hostport
  local re='^postgres(ql)?://(([^@/]*)@)?([^/?#]*)(/([^?#]*))?([?#].*)?$'
  local re6='^\[([^]]+)\](:([0-9]+))?$'
  [[ "$url" =~ $re ]] || return 1
  userinfo="${BASH_REMATCH[3]}"
  hostport="${BASH_REMATCH[4]}"
  DB_NAME="$(url_decode "${BASH_REMATCH[6]}")"
  DB_USER="$(url_decode "${userinfo%%:*}")"
  DB_PASSWORD=""
  if [[ "$userinfo" == *:* ]]; then DB_PASSWORD="$(url_decode "${userinfo#*:}")"; fi
  if [[ "$hostport" =~ $re6 ]]; then
    DB_HOST="${BASH_REMATCH[1]}"
    DB_PORT="${BASH_REMATCH[3]:-5432}"
  else
    DB_HOST="${hostport%%:*}"
    DB_PORT=5432
    if [[ "$hostport" == *:* ]]; then DB_PORT="${hostport##*:}"; fi
  fi
  DB_HOST="${DB_HOST:-127.0.0.1}"
  [[ -n "$DB_USER" && -n "$DB_NAME" && "$DB_PORT" =~ ^[0-9]+$ ]]
}

# load_deploy_settings: fills the AXS_* settings (environment > shared/deploy.env > defaults) and checks them.
load_deploy_settings() {
  local file="$AXS_BASE/shared/deploy.env" key value
  for key in AXS_APP_NAME AXS_PORT AXS_INSTANCES AXS_MAX_MEMORY AXS_HEAP_MB AXS_KEEP_RELEASES AXS_BUILD_HEAP_MB \
    AXS_HEALTH_TIMEOUT AXS_NODE_DIR; do
    if [[ -z "${!key:-}" && -f "$file" ]] && value="$(env_file_value "$file" "$key")"; then
      printf -v "$key" '%s' "$value"
    fi
  done
  AXS_APP_NAME="${AXS_APP_NAME:-axiomatic}"
  AXS_PORT="${AXS_PORT:-3000}"
  AXS_INSTANCES="${AXS_INSTANCES:-1}"
  AXS_MAX_MEMORY="${AXS_MAX_MEMORY:-1G}"
  AXS_HEAP_MB="${AXS_HEAP_MB:-512}"
  AXS_KEEP_RELEASES="${AXS_KEEP_RELEASES:-3}"
  AXS_BUILD_HEAP_MB="${AXS_BUILD_HEAP_MB:-}"
  AXS_HEALTH_TIMEOUT="${AXS_HEALTH_TIMEOUT:-90}"
  AXS_NODE_DIR="${AXS_NODE_DIR:-}"
  [[ "$AXS_APP_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || die "AXS_APP_NAME may only contain letters, digits and ._-"
  [[ "$AXS_PORT" =~ ^[0-9]{2,5}$ ]] || die "AXS_PORT must be a port number"
  [[ "$AXS_INSTANCES" =~ ^([1-9]|1[0-6])$ ]] || die "AXS_INSTANCES must be between 1 and 16"
  [[ "$AXS_MAX_MEMORY" =~ ^[0-9]+[KMG]$ ]] || die "AXS_MAX_MEMORY must look like 1G or 900M"
  [[ "$AXS_HEAP_MB" =~ ^[0-9]{3,5}$ ]] || die "AXS_HEAP_MB must be megabytes, e.g. 512"
  [[ "$AXS_KEEP_RELEASES" =~ ^([2-9]|[1-9][0-9])$ ]] || die "AXS_KEEP_RELEASES must be 2 or more"
  [[ -z "$AXS_BUILD_HEAP_MB" || "$AXS_BUILD_HEAP_MB" =~ ^[0-9]{3,5}$ ]] || die "AXS_BUILD_HEAP_MB must be megabytes, e.g. 2048"
  [[ "$AXS_HEALTH_TIMEOUT" =~ ^[0-9]{1,4}$ ]] || die "AXS_HEALTH_TIMEOUT must be seconds"
  AXS_HEALTH_URL="http://127.0.0.1:${AXS_PORT}/api/health"
  AXS_CURRENT="$AXS_BASE/current"
  AXS_RELEASES="$AXS_BASE/releases"
  AXS_ENV_FILE="$AXS_BASE/shared/.env.production"
}

# refuse_root ALLOW: PM2 and the release files belong to the app user (deploy/README.md), never root.
refuse_root() {
  if [[ "$(id -u)" -eq 0 && "${1:-0}" != 1 ]]; then
    die "do not run this as root: PM2 would start a second, root-owned copy of the app. Run it as the app user
  (e.g. sudo -iu axiomatic bash $0 ...), or add --allow-root if root really owns $AXS_BASE and PM2."
  fi
}

# refuse_root_job SCRIPT: the scheduled jobs and backup.sh run as the app user that owns $AXS_BASE, never as root.
# Every file under $AXS_BASE (current, releases/*/deploy/*.sh, this file) belongs to that user, and so does the app
# process: if root ran them, anything that took over the app could rewrite them and get root within a minute
# (deploy/README.md "Privileges"). aaPanel Cron runs as root, so each task switches user first:
# `runuser -u axiomatic -- bash .../current/deploy/<script>`. This check only catches a task set up the wrong way; it is
# no security boundary (the file it lives in is the app user's). A deployment root owns itself (deploy.sh
# --allow-root) has no app user to protect, so root may run the jobs there.
refuse_root_job() {
  local owner
  [[ "$(id -u)" -eq 0 ]] || return 0
  owner="$(stat -c %U "$AXS_BASE" 2>/dev/null)" || owner=""
  [[ "$owner" != root ]] || return 0
  if [[ -z "$owner" || "$owner" == UNKNOWN ]]; then owner=axiomatic; fi
  die "do not run this as root: the files under $AXS_BASE belong to the app user. Run it as that user; the aaPanel
  Cron task's script content (or the root Terminal command) is:  runuser -u $owner -- bash $AXS_BASE/current/deploy/$1"
}

# take_lock: one deploy, rollback or restart at a time (fd 8 stays open until the script exits).
take_lock() {
  mkdir -p "$AXS_BASE/shared/run"
  exec 8>"$AXS_BASE/shared/run/deploy.lock"
  if command -v flock >/dev/null 2>&1; then
    flock -n 8 || die "another deploy, rollback or restart is running (lock: $AXS_BASE/shared/run/deploy.lock)"
  fi
}

# resolve_node_tools: sets AXS_NODE (node binary), AXS_PM2 and PNPM (array: corepack pnpm, or pnpm 11).
# aaPanel's Node.js version manager keeps versions in /www/server/nodejs/<version>/bin: when node is not on PATH,
# the newest v24 there is used (or AXS_NODE_DIR).
resolve_node_tools() {
  local dir version major minor
  if [[ -n "$AXS_NODE_DIR" ]]; then PATH="$AXS_NODE_DIR:$PATH"; fi
  if ! command -v node >/dev/null 2>&1; then
    dir="$(ls -d /www/server/nodejs/v24*/bin 2>/dev/null | sort -V | tail -n 1)" || true
    if [[ -n "$dir" && -x "$dir/node" ]]; then PATH="$dir:$PATH"; fi
  fi
  export PATH
  command -v node >/dev/null 2>&1 || die "node is not installed or not on PATH (aaPanel > App Store > Node.js version manager: install v24 and set it as the command-line version, or set AXS_NODE_DIR in shared/deploy.env)"
  AXS_NODE="$(readlink -f "$(command -v node)")"
  version="$("$AXS_NODE" -p 'process.versions.node')"
  major="${version%%.*}"; minor="${version#*.}"; minor="${minor%%.*}"
  if (( major < 20 || (major == 20 && minor < 19) )); then die "Node.js $version is too old (24 LTS expected, 20.19 minimum)"; fi
  if (( major != 24 )); then warn "Node.js $version: this app is built and tested on Node.js 24 LTS"; fi
  dir="$(dirname "$AXS_NODE")"
  if command -v pm2 >/dev/null 2>&1; then AXS_PM2="$(command -v pm2)"
  elif [[ -x "$dir/pm2" ]]; then AXS_PM2="$dir/pm2"
  else die "pm2 is not installed (as root: npm install -g pm2, with the same Node.js 24; deploy/README.md)"
  fi
  if command -v corepack >/dev/null 2>&1; then PNPM=(corepack pnpm)
  elif [[ -x "$dir/corepack" ]]; then PNPM=("$dir/corepack" pnpm)
  elif command -v pnpm >/dev/null 2>&1; then PNPM=(pnpm)
  else die "neither corepack nor pnpm found next to node (Node.js 24 ships corepack: check $dir)"
  fi
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
}

# pm2_clean ARGS...: runs pm2 with a minimal environment. PM2 copies the caller's environment into the app's, so
# nothing from this shell (NODE_OPTIONS, a stray DATABASE_URL, ...) can override shared/.env.production.
# File descriptors 7-9 (the backup, deploy and cron locks) are closed for pm2: when this call starts the PM2 daemon,
# the daemon (and the app it forks) would otherwise inherit the flock on shared/run/deploy.lock and keep it after the
# script exits, so every later deploy, rollback and restart would stop with "another deploy ... is running".
pm2_clean() {
  local -a vars=(
    "HOME=$HOME" "PATH=$PATH" "USER=$(id -un)" "LOGNAME=$(id -un)" "LANG=${LANG:-C.UTF-8}"
    "AXS_BASE=$AXS_BASE" "AXS_NODE=$AXS_NODE" "AXS_APP_NAME=$AXS_APP_NAME" "AXS_PORT=$AXS_PORT"
    "AXS_INSTANCES=$AXS_INSTANCES" "AXS_MAX_MEMORY=$AXS_MAX_MEMORY" "AXS_HEAP_MB=$AXS_HEAP_MB"
  )
  if [[ -n "${PM2_HOME:-}" ]]; then vars+=("PM2_HOME=$PM2_HOME"); fi
  env -i "${vars[@]}" "$AXS_PM2" "$@" 7>&- 8>&- 9>&-
}

# pm2_checks: warnings only (start on boot, log rotation).
pm2_checks() {
  local user; user="$(id -un)"
  if command -v systemctl >/dev/null 2>&1 && ! systemctl is-enabled "pm2-$user" >/dev/null 2>&1; then
    warn "PM2 does not start on boot yet. Once, as root: env PATH=\"$(dirname "$AXS_NODE"):\$PATH\" $AXS_PM2 startup systemd -u $user --hp $HOME"
  fi
  if [[ ! -d "${PM2_HOME:-$HOME/.pm2}/modules/pm2-logrotate" ]]; then
    warn "pm2-logrotate is not installed (logs grow forever). Once, as $user: pm2 install pm2-logrotate (deploy/README.md \"Logs\")"
  fi
}

# health_ok: true when /api/health answers 200 (database and Redis reachable).
health_ok() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$AXS_HEALTH_URL" 2>/dev/null)" || true
  [[ "$code" == 200 ]]
}

# wait_healthy SECONDS
wait_healthy() {
  local limit="$1" start=$SECONDS
  while (( SECONDS - start < limit )); do
    if health_ok; then say "health check OK ($AXS_HEALTH_URL, $((SECONDS - start))s)"; return 0; fi
    sleep 2
  done
  return 1
}

# list_releases: release names (UTC yyyymmddHHMMSS), oldest first.
list_releases() {
  [[ -d "$AXS_RELEASES" ]] || return 0
  find "$AXS_RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E '^[0-9]{14}$' | sort || true
}

# current_release: the release name `current` points at (empty when there is none).
current_release() {
  local target
  if [[ -L "$AXS_CURRENT" ]]; then
    target="$(readlink "$AXS_CURRENT")"
    printf '%s' "$(basename "$target")"
  fi
}

# release_complete NAME: the release has a finished build, its dependencies and the shared env link.
release_complete() {
  local dir="$AXS_RELEASES/$1"
  [[ -f "$dir/.next/BUILD_ID" && -f "$dir/node_modules/next/dist/bin/next" && -r "$dir/.env.production" \
    && -f "$dir/deploy/ecosystem.config.cjs" ]]
}

# copy_app_tree FROM TO: copies the app folder without dependencies, build output, local data or any real env file
# (only examples). Patterns starting with ./ match at the top of FROM only; node_modules matches at any depth.
copy_app_tree() {
  tar -C "$1" \
    --exclude=./.git --exclude=node_modules --exclude=./.next --exclude='./.next-*' --exclude=./.pgdata \
    --exclude=./.storage --exclude=./.shots --exclude=./.claude --exclude=./generated --exclude=./coverage \
    --exclude=./test-results --exclude=./playwright-report --exclude=./blob-report --exclude=./tsconfig.tsbuildinfo \
    --exclude=./.env --exclude=./.env.local --exclude='./.env.*.local' --exclude=./.env.production \
    --exclude=./.env.development --exclude=./.env.test \
    --exclude=./.user.ini --exclude=./index.html --exclude=./404.html --exclude=./.htaccess --exclude=./.well-known \
    -cf - . | tar -C "$2" -xf -
}

# switch_current NAME: points `current` at releases/NAME in one atomic rename (relative link).
switch_current() {
  local tmp="$AXS_BASE/.current.tmp.$$"
  rm -f -- "$tmp"
  ln -s "releases/$1" "$tmp"
  mv -T -- "$tmp" "$AXS_CURRENT"
}

# reload_app RELEASE_DIR: pm2 startOrReload of the ecosystem file through `current`, then the health check, then a
# check that PM2's processes really run in RELEASE_DIR, then pm2 save (so a reboot resurrects this state).
# Returns 1 (never exits) when PM2 cannot start the app, the health check fails or a process runs elsewhere, so the
# caller decides what happens next (deploy.sh rolls back). A failed pm2 save is only a warning: the app is healthy.
reload_app() {
  local expected pids pid cwd
  expected="$(readlink -f "$1")"
  say "pm2 startOrReload $AXS_APP_NAME ($AXS_INSTANCES instance(s), $( (( AXS_INSTANCES > 1 )) && echo cluster || echo fork ) mode)"
  if ! pm2_clean startOrReload "$AXS_CURRENT/deploy/ecosystem.config.cjs" --update-env; then
    warn "pm2 startOrReload failed (message above)"
    return 1
  fi
  if ! wait_healthy "$AXS_HEALTH_TIMEOUT"; then
    printf '\n' >&2
    warn "no healthy answer from $AXS_HEALTH_URL within ${AXS_HEALTH_TIMEOUT}s. Last log lines:"
    pm2_clean logs "$AXS_APP_NAME" --nostream --lines 40 >&2 || true
    return 1
  fi
  pids="$(pm2_clean pid "$AXS_APP_NAME" 2>/dev/null)" || true
  for pid in $pids; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" || continue
    if [[ "$cwd" != "$expected" ]]; then
      warn "PM2 process $pid still runs in $cwd, not $expected"
      warn "fix: pm2 delete $AXS_APP_NAME && bash $AXS_CURRENT/deploy/restart.sh --recreate"
      return 1
    fi
  done
  if pm2_clean save >/dev/null; then
    say "pm2 saved: a reboot brings back $(basename "$expected")"
  else
    warn "pm2 save failed: run 'pm2 save' as $(id -un), or a reboot brings back the release PM2 saved last"
  fi
}

# restore_release NAME: deploy.sh's automatic rollback. Points `current` back at releases/NAME (one atomic rename)
# and reloads PM2 on it with the same health and working-folder checks as reload_app. Returns 1 when NAME is missing
# or incomplete (nothing is switched) or when it is live again but still not healthy.
restore_release() {
  local name="$1"
  if [[ ! "$name" =~ ^[0-9]{14}$ ]] || ! release_complete "$name"; then
    warn "release ${name:-(none)} is missing or incomplete: it cannot be put back automatically"
    return 1
  fi
  switch_current "$name"
  say "current -> releases/$name (automatic rollback)"
  reload_app "$AXS_RELEASES/$name"
}
