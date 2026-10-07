#!/usr/bin/env bash
# One-time PostgreSQL setup for the app on an aaPanel server (run as root; deploy/README.md "PostgreSQL").
#
#   bash deploy/db-setup.sh [--env /www/wwwroot/axiomatic/shared/.env.production] [--db NAME] [--psql PATH]
#                           [--host 127.0.0.1 --superuser postgres]
#
# Takes the role, its password and the database name from DATABASE_URL in the env file (gen-prod-env.mjs generated
# the password), then, connected as the PostgreSQL superuser:
#   - creates the role (LOGIN; no SUPERUSER, CREATEDB or CREATEROLE: migrate deploy needs no shadow database), or
#     resets its password to the one in the file;
#   - creates the database (or --db NAME, e.g. a restore target) owned by that role with
#       ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0
#     unless it exists already (an existing database that is not UTF8 is reported, never changed);
#   - prints the server version, the database encoding and collation, and listen_addresses (a WARNING when
#     PostgreSQL listens on more than localhost: it must never be reachable from the internet).
# Idempotent. Re-run it after changing the password in DATABASE_URL, then restart the app. Never prints the password.
#
# Superuser connection: as the OS user postgres over the local socket (runuser/sudo -u postgres psql), which aaPanel's
# PostgreSQL and Debian's packages both allow. If that is refused, add --host 127.0.0.1 --superuser postgres and type
# the superuser password when psql asks (aaPanel > Databases > PgSQL shows/sets it).
# The same SQL by hand, if you prefer (replace <password> with the one inside DATABASE_URL):
#   /www/server/pgsql/bin/psql -U postgres -d postgres     (or: sudo -u postgres psql)
#   CREATE ROLE axiomatic LOGIN PASSWORD '<password>';
#   CREATE DATABASE axiomatic OWNER axiomatic ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/common.sh
source "$SCRIPT_DIR/common.sh"

ENV_FILE="$AXS_BASE/shared/.env.production" DB_OVERRIDE="" PSQL="" SU_HOST="" SU_USER="postgres"
while (( $# > 0 )); do
  case "$1" in
    --env|--db|--psql|--host|--superuser)
      (( $# >= 2 )) || die "$1 needs a value"
      case "$1" in
        --env) ENV_FILE="$2" ;;
        --db) DB_OVERRIDE="$2" ;;
        --psql) PSQL="$2" ;;
        --host) SU_HOST="$2" ;;
        --superuser) SU_USER="$2" ;;
      esac
      shift 2 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done

[[ "$(id -u)" -eq 0 || -n "$SU_HOST" ]] || die "run as root (aaPanel Terminal), or pass --host 127.0.0.1 --superuser postgres"
url="$(env_file_value "$ENV_FILE" DATABASE_URL)" || die "DATABASE_URL not found in $ENV_FILE"
parse_database_url "$url" || die "DATABASE_URL in $ENV_FILE is not a postgresql:// URL"
unset url
db_name="${DB_OVERRIDE:-$DB_NAME}"
ident_re='^[a-z_][a-z0-9_]{0,62}$'
[[ "$DB_USER" =~ $ident_re ]] || die "the role name in DATABASE_URL must be lower case letters, digits and _"
[[ "$db_name" =~ $ident_re ]] || die "the database name must be lower case letters, digits and _"
[[ "$DB_USER" != postgres ]] || die "DATABASE_URL must use a dedicated role, not the postgres superuser"
pw_re='^[A-Za-z0-9._~+-]{16,}$'
[[ "$DB_PASSWORD" =~ $pw_re ]] || die "the password in DATABASE_URL must be 16+ letters, digits or ._~+- (gen-prod-env.mjs makes one)"
case "$DB_HOST" in
  127.0.0.1|localhost|::1) ;;
  *) warn "DATABASE_URL points at $DB_HOST, not this server; this script sets up the PostgreSQL it can reach locally" ;;
esac

if [[ -z "$PSQL" ]]; then
  if [[ -x /www/server/pgsql/bin/psql ]]; then PSQL=/www/server/pgsql/bin/psql
  elif command -v psql >/dev/null 2>&1; then PSQL="$(command -v psql)"
  else die "psql not found (install PostgreSQL from aaPanel > App Store, or pass --psql PATH)"
  fi
fi

psql_super() {
  local -a cmd=("$PSQL" -X -q -v ON_ERROR_STOP=1 --no-psqlrc -d postgres)
  if [[ -n "$SU_HOST" ]]; then
    "${cmd[@]}" -h "$SU_HOST" -U "$SU_USER"
  elif command -v runuser >/dev/null 2>&1; then
    (cd / && runuser -u "$SU_USER" -- "${cmd[@]}")
  else
    (cd / && sudo -u "$SU_USER" "${cmd[@]}")
  fi
}

say "PostgreSQL client: $PSQL; role $DB_USER, database $db_name"
# The SQL goes to psql on stdin, so the password is never on a command line. format(%I, %L) quotes the names and
# the password; CREATE DATABASE runs outside a transaction (psql autocommit, one \gexec statement at a time).
report="$(psql_super <<SQL
\set role '$DB_USER'
\set pw '$DB_PASSWORD'
\set db '$db_name'
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'role', :'pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'role', :'pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I ENCODING %L LC_COLLATE %L LC_CTYPE %L TEMPLATE template0', :'db', :'role', 'UTF8', 'C', 'C')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
\pset tuples_only on
\pset format unaligned
SELECT 'server=' || current_setting('server_version') || ' listen_addresses=' || current_setting('listen_addresses')
  || ' max_connections=' || current_setting('max_connections');
SELECT 'database=' || datname || ' encoding=' || pg_encoding_to_char(encoding) || ' collate=' || datcollate
  || ' ctype=' || datctype || ' owner=' || pg_get_userbyid(datdba) FROM pg_database WHERE datname = :'db';
SQL
)" || die "psql failed (message above). Is PostgreSQL running? Peer login refused? Try --host 127.0.0.1 --superuser postgres"
unset DB_PASSWORD

printf '%s\n' "$report" | sed 's/^/  /'
grep -q "^database=$db_name encoding=UTF8 " <<<"$report" || die "database $db_name is not UTF8. It holds the rupee sign: drop and recreate it (only while it is still empty!) with this script"
grep -q "^database=$db_name .* owner=$DB_USER\$" <<<"$report" || warn "database $db_name is not owned by $DB_USER: as superuser, ALTER DATABASE $db_name OWNER TO $DB_USER"
grep -q "^database=$db_name .* collate=C " <<<"$report" || warn "database $db_name does not use collation C (it works, but text ordering may differ from development)"
listen="$(sed -n 's/^server=.* listen_addresses=\(.*\) max_connections=.*/\1/p' <<<"$report")"
case "$listen" in
  localhost|127.0.0.1|::1|"localhost,127.0.0.1"|"127.0.0.1,::1"|"localhost, 127.0.0.1") ;;
  *) warn "PostgreSQL listens on '$listen'. Set listen_addresses = 'localhost' in postgresql.conf (aaPanel > App Store > PostgreSQL > Settings > Config), restart it, and never open port 5432 in any firewall" ;;
esac
say "PostgreSQL is ready for DATABASE_URL (role $DB_USER, database $db_name)."
