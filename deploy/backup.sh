#!/usr/bin/env bash
# PostgreSQL backups of the Axiomatic app database (deploy/README.md "Backups"). Always as the app user (it refuses
# root: this folder belongs to the app user, deploy/README.md "Privileges"); from the root Terminal prefix
# `sudo -iu axiomatic`, in the aaPanel Cron task `runuser -u axiomatic --`:
#
#   bash /www/wwwroot/axiomatic/current/deploy/backup.sh [now]          one backup (what the daily aaPanel task runs)
#   bash /www/wwwroot/axiomatic/current/deploy/backup.sh list           the backups on disk
#   bash /www/wwwroot/axiomatic/current/deploy/backup.sh restore <file> --yes [--into <database>]
#
# BACKUP_DIR must exist and belong to the app user: once, as root,
#   install -d -m 700 -o axiomatic -g axiomatic /www/backup/axiomatic
#
# Backup: pg_dump --format=custom (compressed) into BACKUP_DIR (default /www/backup/axiomatic, mode 700, files 600),
# named axiomatic-YYYYMMDDTHHMMSSZ.dump (UTC). A dump only counts after `pg_restore --list` reads it back; then
# dumps older than BACKUP_RETENTION_DAYS (14) are deleted. A failed run deletes nothing and exits non-zero (aaPanel
# marks the task failed). One line per run goes to stdout (the aaPanel task log) and BACKUP_DIR/backup.log.
# Connection: DATABASE_URL from shared/.env.production, or the PG* variables when PGDATABASE is set in the
# environment. The password reaches pg_dump through PGPASSWORD, never the command line.
# pg_dump / pg_restore: PG_BIN if set, else aaPanel's /www/server/pgsql/bin, else PATH, else /usr/lib/postgresql/*/bin.
# They must be at least the server's major version (pg_dump refuses an older client with a clear message).
# deploy.sh also calls this before every migration (BACKUP_DIR=shared/backups, BACKUP_PREFIX=pre-deploy, 7 days).
#
# RESTORE (replaces every table of the target database with the dump's contents):
#   1. Stop everything that writes: as the app user `pm2 stop axiomatic`; pause the app's aaPanel cron tasks.
#      Steps 2-3 as the app user too.
#   2. bash .../backup.sh list
#   3. bash .../backup.sh restore axiomatic-20261007T210000Z.dump --yes
#      (refused while /api/health still answers, i.e. while the app runs)
#   4. As the app user `pm2 start axiomatic`, open https://<domain>/api/health, resume the cron tasks.
# Safer variant that keeps the live database until you switch:
#   a. as the app user: bash .../db-setup.sh --db axiomatic_restore --host 127.0.0.1 --superuser postgres
#      (an empty UTF8 database owned by the app role; asks for the postgres administrator password)
#   b. bash .../backup.sh restore <file> --yes --into axiomatic_restore     (allowed while the app runs)
#   c. check it, then change the database name at the end of DATABASE_URL to axiomatic_restore and run
#      deploy/restart.sh as the app user (the old database stays until you drop it).
# Off-server copies: download a dump now and then (aaPanel > Files), or sync BACKUP_DIR to object storage. A backup
# that only lives on the same disk does not survive the loss of the server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$SCRIPT_DIR/common.sh"
refuse_root_job backup.sh

BACKUP_DIR="${BACKUP_DIR:-/www/backup/axiomatic}"
PREFIX="${BACKUP_PREFIX:-axiomatic}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
ENV_FILE="${AXS_ENV_FILE:-$AXS_BASE/shared/.env.production}"
[[ "$PREFIX" =~ ^[A-Za-z0-9_-]+$ ]] || die "BACKUP_PREFIX may only contain letters, digits, _ and -"
[[ "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_RETENTION_DAYS must be a whole number of days (1 or more)"

blog() {
  local line
  line="$(axs_now) backup $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >> "$BACKUP_DIR/backup.log" 2>/dev/null || true
}
bfail() { blog "FAILED: $*" >&2; exit 1; }

find_pg_bin() {
  local dir
  for dir in "${PG_BIN:-}" /www/server/pgsql/bin; do
    if [[ -n "$dir" && -x "$dir/pg_dump" && -x "$dir/pg_restore" ]]; then printf '%s' "$dir"; return 0; fi
  done
  if command -v pg_dump >/dev/null 2>&1; then dirname "$(command -v pg_dump)"; return 0; fi
  dir="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1)" || true
  if [[ -n "$dir" && -x "$dir/pg_dump" ]]; then printf '%s' "$dir"; return 0; fi
  return 1
}

connect_settings() {
  local url
  if [[ -n "${PGDATABASE:-}" ]]; then return 0; fi
  url="$(env_file_value "$ENV_FILE" DATABASE_URL)" || bfail "DATABASE_URL not found in $ENV_FILE (or the file is not readable by $(id -un))"
  parse_database_url "$url" || bfail "DATABASE_URL in $ENV_FILE is not a postgresql:// URL"
  export PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$DB_USER" PGDATABASE="$DB_NAME"
  export PGPASSWORD="$DB_PASSWORD"
}

prepare() {
  umask 077
  if ! mkdir -p "$BACKUP_DIR" 2>/dev/null || [[ ! -w "$BACKUP_DIR" ]]; then
    die "$BACKUP_DIR is missing or not writable by $(id -un). Once, as root: install -d -m 700 -o $(id -un) -g $(id -gn) $BACKUP_DIR"
  fi
  chmod 700 "$BACKUP_DIR" 2>/dev/null || true
  PG_BIN_DIR="$(find_pg_bin)" || bfail "pg_dump not found (set PG_BIN, e.g. PG_BIN=/www/server/pgsql/bin)"
  connect_settings
  export PGCONNECT_TIMEOUT=10 PGAPPNAME="axiomatic-backup"
}

backup_now() {
  local stamp final partial started size old
  prepare
  exec 7>"$BACKUP_DIR/.backup.lock"
  if command -v flock >/dev/null 2>&1 && ! flock -n 7; then bfail "another backup is still running"; fi
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  final="$BACKUP_DIR/$PREFIX-$stamp.dump"
  partial="$BACKUP_DIR/.$PREFIX-$stamp.dump.partial"
  started=$SECONDS
  if ! "$PG_BIN_DIR/pg_dump" --format=custom --compress=6 --no-owner --no-privileges --file="$partial"; then
    rm -f -- "$partial"
    bfail "pg_dump of $PGDATABASE on $PGHOST:${PGPORT:-5432} (message above); earlier backups are kept"
  fi
  if ! "$PG_BIN_DIR/pg_restore" --list "$partial" >/dev/null; then
    rm -f -- "$partial"
    bfail "the new dump cannot be read back by pg_restore; earlier backups are kept"
  fi
  mv -- "$partial" "$final"
  size="$(du -h "$final" | cut -f1)"
  blog "ok $(basename "$final") $size in $((SECONDS - started))s ($PGDATABASE, $("$PG_BIN_DIR/pg_dump" --version | awk '{ print $NF }'))"
  # Retention only after a good backup: keep RETENTION_DAYS days of dumps.
  while IFS= read -r -d '' old; do
    rm -f -- "$old"
    blog "removed $(basename "$old") (older than $RETENTION_DAYS days)"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$PREFIX-*.dump" -mtime +"$((RETENTION_DAYS - 1))" -print0)
  find "$BACKUP_DIR" -maxdepth 1 -type f -name ".$PREFIX-*.partial" -mmin +1440 -delete 2>/dev/null || true
}

list_backups() {
  if compgen -G "$BACKUP_DIR/$PREFIX-*.dump" >/dev/null; then
    ls -lh "$BACKUP_DIR"/"$PREFIX"-*.dump
  else
    say "no backups in $BACKUP_DIR yet"
  fi
}

restore_backup() {
  local file="" confirm=0 into="" target
  while (( $# > 0 )); do
    case "$1" in
      --yes) confirm=1; shift ;;
      --into) (( $# >= 2 )) || die "--into needs a database name"; into="$2"; shift 2 ;;
      -*) die "unknown restore option '$1'" ;;
      *) [[ -z "$file" ]] || die "one backup file at a time"; file="$1"; shift ;;
    esac
  done
  [[ -n "$file" ]] || die "usage: backup.sh restore <file> --yes [--into <database>] (files: backup.sh list)"
  if [[ "$file" != /* && ! -f "$file" ]]; then file="$BACKUP_DIR/$file"; fi
  [[ -f "$file" ]] || die "no such backup: $file"
  prepare
  target="${into:-$PGDATABASE}"
  [[ "$target" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "database name '$target' is not a plain identifier"
  if [[ -z "$into" || "$into" == "$PGDATABASE" ]]; then
    load_deploy_settings
    if health_ok; then die "the app still answers on $AXS_HEALTH_URL: stop it first (as the app user: pm2 stop $AXS_APP_NAME), or restore --into another database"; fi
  fi
  if (( ! confirm )); then
    die "this REPLACES every table of database '$target' with $(basename "$file"). Stop the app and the cron tasks, then add --yes"
  fi
  "$PG_BIN_DIR/pg_restore" --list "$file" >/dev/null || die "$file is not a readable pg_dump custom-format file"
  blog "restoring $(basename "$file") into $target"
  "$PG_BIN_DIR/pg_restore" --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error \
    --dbname="$target" "$file"
  blog "restore of $(basename "$file") into $target finished"
}

command="${1:-now}"
if (( $# > 0 )); then shift; fi
case "$command" in
  now) backup_now ;;
  list) list_backups ;;
  restore) restore_backup "$@" ;;
  -h|--help) sed -n '2,37p' "$0" ;;
  *) die "unknown command '$command' (now | list | restore <file> --yes [--into <database>])" ;;
esac
