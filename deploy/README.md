# Operating the app on the aaPanel server (no Docker)

> **The live server** for axiomaticsoftwaresolutions.com is set up with a few differences from this README (app user `axsstore`, port 3210, database `axs_store`, its own Redis on 6380, a hand-written proxy file, backups in `/home/axsstore/backups`): see [`docs/server-runbook.md`](../docs/server-runbook.md).

Operator reference for the production server: a Linux VPS (Ubuntu 22.04/24.04 or Debian 12, x86_64, 2-4 GB RAM)
managed with aaPanel. Everything runs natively: Node.js 24 + PM2, PostgreSQL and Redis from the aaPanel App Store,
aaPanel's Nginx in front. Commands print names and counts, never secret values.

```
Browser / desktop apps --https--> aaPanel Nginx :443 (Let's Encrypt) --http--> 127.0.0.1:3000  PM2 "axiomatic"
                                                                                  (next start, current release)
                                    PostgreSQL 127.0.0.1:5432 <---+---> Redis 127.0.0.1:6379 (requirepass)
aaPanel Cron --runuser axiomatic--> cron-*.sh --http--> 127.0.0.1:3000/api/cron/{emails,reconcile,renewals,maintenance}
aaPanel Cron --runuser axiomatic--> deploy/backup.sh --> /www/backup/axiomatic/*.dump (14 days)
Razorpay --https--> https://<domain>/api/webhooks/payments/razorpay
Files: private S3-compatible bucket (browsers upload/download directly). Email: SMTP provider or the Amazon SES API.
```

| File | Purpose |
|---|---|
| `deploy.sh` | Release-based deploy (`--source <folder, .tar.gz or git URL> [--ref] [--first-run]`); rolls back by itself when the new release fails its health check |
| `rollback.sh` | Put an earlier release back (`--list`, `--to <release>`) |
| `restart.sh` | Restart the current release (after editing the env file; `--recreate` after scaling changes) |
| `backup.sh` | Daily `pg_dump` (14 days), `list`, `restore` |
| `cron-emails.sh`, `cron-reconcile.sh`, `cron-renewals.sh`, `cron-maintenance.sh` | aaPanel Cron tasks (all call `cron-job.sh`) |
| `db-setup.sh` | One-time PostgreSQL role + UTF8 database (root during setup; later as the app user with `--host`) |
| `preflight.mjs` | Env, PostgreSQL and Redis checks run by `deploy.sh` |
| `ecosystem.config.cjs` | PM2 process definition |
| `aapanel-nginx.conf` | Reverse-proxy block for the aaPanel site |
| `.env.production.example` | Template for `shared/.env.production` (`scripts/gen-prod-env.mjs`) |
| `common.sh` | Shared shell helpers |

Server layout (`AXS_BASE`, default `/www/wwwroot/axiomatic`, owned by the app user `axiomatic`):

```
/www/wwwroot/axiomatic/
  releases/<UTC yyyymmddHHMMSS>/   full copy per deploy (code, node_modules, .next); the newest 3 are kept
  current -> releases/<...>        what PM2 runs
  shared/.env.production           the only env file (mode 600), linked into each release as .env.production
  shared/deploy.env                optional non-secret settings (see "Settings")
  shared/logs/                     app-out.log, app-error.log (PM2), deploy-<release>.log
  shared/backups/                  pre-deploy dumps (7 days)
  shared/pnpm-store/               pnpm content store (hard links keep releases small)
  src/                             where you extract an uploaded archive before deploying it
```

## One-time server setup

Run in the aaPanel Terminal (root) unless a step says "as the app user" (`sudo -iu axiomatic`, or `su - axiomatic`).

1. **Swap** (servers under 4 GB RAM; `next build` is the memory peak):
   ```bash
   free -h
   fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```
2. **App user and folders**:
   ```bash
   id axiomatic >/dev/null 2>&1 || useradd --create-home --shell /bin/bash axiomatic
   mkdir -p /www/wwwroot/axiomatic/releases /www/wwwroot/axiomatic/shared/logs
   chown -R axiomatic:axiomatic /www/wwwroot/axiomatic && chmod 750 /www/wwwroot/axiomatic
   install -d -m 700 -o axiomatic -g axiomatic /www/backup/axiomatic     # nightly dumps (backup.sh runs as axiomatic)
   ```
3. **Node.js 24, PM2, corepack**: aaPanel > App Store > "Node.js version manager" > install the newest v24 LTS and
   set it as the command-line version. Then:
   ```bash
   node -v                      # v24.x
   npm install -g pm2
   NODE_BIN="$(dirname "$(readlink -f "$(command -v node)")")"
   for b in node npm npx corepack pm2; do [ -x "$NODE_BIN/$b" ] && ln -sf "$NODE_BIN/$b" /usr/local/bin/$b; done
   sudo -iu axiomatic bash -lc 'node -v && pm2 -v && corepack --version'
   ```
   Do not add the app as an aaPanel "Node project": PM2 is driven by `deploy.sh` with `ecosystem.config.cjs`.
4. **Code and env file.** The code comes from the private GitHub repository through a read-only deploy key and
   is checked out in the aaPanel site folder `/www/wwwroot/axiomaticsoftwaresolutions.com` (create the site in aaPanel first, then
   `chown axiomatic:axiomatic /www/wwwroot/axiomaticsoftwaresolutions.com`). Full steps, including the deploy key: docs/deploy-today.md step 3.
   Then, as the app user:
   ```bash
   node /www/wwwroot/axiomaticsoftwaresolutions.com/scripts/gen-prod-env.mjs --out /www/wwwroot/axiomatic/shared/.env.production
   ```
   It generates every secret plus the PostgreSQL and Redis passwords. Open `shared/.env.production` (aaPanel > Files,
   or `nano`) and replace every `CHANGE-ME` value it lists. Razorpay, SMTP and the bucket are NOT needed here: the Owner
   enters them in Admin > Settings > Integrations after the first sign-in (step 11); the file keeps only a commented-out
   fallback for them. Keep a copy of the file in a password manager.

   What the file must hold: `APP_URL`, `SESSION_SECRET`, `CSRF_SECRET`, `ORDER_TOKEN_SECRET`, `CRON_SECRET`,
   `DATABASE_URL`, `CATALOG_SOURCE=db`, `LICENSE_KEY_PEPPER`, `LICENSE_KEY_ENC_KEY` (also protects the integration
   secrets saved in Admin), `LICENSE_SIGNING_PRIVATE_KEY`, `LICENSE_SIGNING_PUBLIC_KEY`, `REDIS_URL`,
   `TRUSTED_PROXY_HOPS`. Optional, with defaults: `DATABASE_POOL_*`, `LICENSE_OFFLINE_GRACE_DAYS`,
   `SECURITY_HSTS_STRICT`, `DOWNLOAD_LINK_TTL_SECONDS`. Fallback only (normally left out): `PAYMENT_*`, `STORAGE_*`
   (except `DOWNLOAD_LINK_TTL_SECONDS`), `EMAIL_*`, `SMTP_*`, `SES_*`. What is saved in Admin wins over them, per integration.
5. **PostgreSQL 16 or 17**: aaPanel > App Store > PostgreSQL (Manager) > install. In its settings / config file set
   `listen_addresses = 'localhost'` and restart it. Do not create the database in the aaPanel UI (it must be UTF8 with
   collation C). As root (only now, before the app has ever run; later runs as the app user, see "Privileges"):
   ```bash
   bash /www/wwwroot/axiomaticsoftwaresolutions.com/deploy/db-setup.sh
   ```
   It creates the role from `DATABASE_URL` (password included) and the database with
   `ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`, then reports encoding and `listen_addresses`. The
   header of `db-setup.sh` shows the same SQL for `/www/server/pgsql/bin/psql -U postgres` or `sudo -u postgres psql`.
   Then apply the memory and planner settings below ("PostgreSQL settings") and restart PostgreSQL.
6. **Redis 7**: aaPanel > App Store > Redis > install. Settings: `bind 127.0.0.1`, `port 6379`, `protected-mode yes`,
   and `requirepass` = the password inside `REDIS_URL` (in `shared/.env.production`, the part between `redis://:` and
   `@`). Restart Redis, then check (prints PONG, never the password):
   ```bash
   REDISCLI_AUTH="$(sed -n 's|^REDIS_URL=redis://:\([^@]*\)@.*|\1|p' /www/wwwroot/axiomatic/shared/.env.production)" \
     /www/server/redis/src/redis-cli -h 127.0.0.1 ping
   ```
7. **First deploy**, as the app user (about 5-15 minutes; the build is the slow part):
   ```bash
   cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh --first-run
   ```
8. **Start on boot and log rotation**: as root,
   `env PATH="$PATH" "$(command -v pm2)" startup systemd -u axiomatic --hp /home/axiomatic`; then as the app user:
   ```bash
   pm2 install pm2-logrotate
   pm2 set pm2-logrotate:max_size 20M && pm2 set pm2-logrotate:retain 14 && pm2 set pm2-logrotate:compress true
   pm2 save
   ```
9. **Website**: aaPanel > Website > Add site: the domain (and `www.` if wanted), PHP "Pure static", no database.
   SSL > Let's Encrypt for both names > Force HTTPS on (HSTS switch off). Then the reverse proxy exactly as the header
   of `aapanel-nginx.conf` describes (target `http://127.0.0.1:3000`; replace the proxy file's content with that file).
10. **Scheduled jobs** and **firewall**: the next two sections.
11. **Integrations and the Razorpay webhook.** Sign in as the Owner (password only: the bootstrapped Owner starts with
    two-step sign-in off, so no working SMTP is needed to get in) and delete the `BOOTSTRAP_OWNER_*` lines from the env
    file. In Admin > Settings > Integrations save, each with your password:
    - **Payment provider**: the Razorpay Key ID and Key secret (Test Mode > API Keys), and a Webhook secret you choose.
      In Razorpay (Test Mode > Webhooks) add the webhook URL the card shows
      (`https://<domain>/api/webhooks/payments/razorpay`) with that same secret and the events `payment.captured`,
      `order.paid`, `payment.failed`, `refund.processed`, `refund.failed` (a refund Razorpay could not complete puts
      the order in review so it can be refunded again). Then "Test Razorpay keys".
    - **Email delivery**: Provider SMTP (host, port, security, username and password) or Amazon SES (API) (AWS
      region, default `ap-south-1`; access key ID and secret access key of an IAM user limited to `ses:SendEmail` and
      `ses:SendRawEmail`, scoped to the sending identity in that region (policy: `docs/go-live-checklist.md`);
      optional configuration set), then From name and address; "Send test email" sends one to your
      own address (in the SES sandbox that address must be verified in SES).
    - **Installer storage**: provider, endpoint, region, bucket, access key ID and secret access key (creating the
      private bucket and its CORS rule: `docs/deploy-today.md` step 0.5); "Test bucket" uploads, reads and deletes a
      tiny file under `axs-probe/` (it cannot check CORS).
    Saves apply at once (other PM2 processes within 30 s): no restart, no deploy. From your PC run
    `node scripts/smoke-prod.mjs --base=https://<domain>`. Once email sending works, the Owner (and Finance staff) turn
    two-step on in Admin > My profile (`docs/go-live-checklist.md`; decisions.md 2026-10-08).

## Scheduled jobs (aaPanel > Cron)

Add each as type **Shell Script** with exactly this script content. aaPanel runs every task as root, so each line
first switches to the app user with `runuser -u axiomatic --` (see "Privileges"; the scripts refuse to run as root).
No secret in the panel: the scripts read `CRON_SECRET` and `DATABASE_URL` from `shared/.env.production` at run
time. Times are server time (`timedatectl` shows it). Most VPS images run on UTC, where 04:00 is 09:30 IST, 21:00 is
02:30 IST and 22:00 is 03:30 IST; on a server clock set to IST use 09:30, 02:30 and 03:30 instead.

| Name | Period | Script content |
|---|---|---|
| axiomatic-emails | every 1 minute | `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-emails.sh` |
| axiomatic-reconcile | every 10 minutes | `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-reconcile.sh` |
| axiomatic-renewals | daily 04:00 (UTC clock) | `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-renewals.sh` |
| axiomatic-backup | daily 21:00 (UTC clock) | `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/backup.sh` |
| axiomatic-maintenance | daily 22:00 (UTC clock), after the backup | `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-maintenance.sh` |

The maintenance job (`/api/cron/maintenance`) closes tickets resolved 14 days ago, deletes uploads never finished
(older than 24 h, file and row), empties the body and subject of sent emails after 30 days and masks their recipient
(the row and its dedupe key stay, so nothing is sent twice), and purges expired rate-limit
buckets, sessions and auth tokens (30 days past expiry), account activity older than 24 months and webhook delivery
records older than 180 days. Renewal reminders stay in `axiomatic-renewals` (30 and 7 days before expiry).

A failed run exits non-zero and writes one line with the HTTP status and a hint into the task's log ("Log" button).
Idle runs of the jobs (every count 0) print nothing; to log every run, use
`runuser -u axiomatic -- env AXS_CRON_VERBOSE=1 bash ...` as the script content. Test one by hand (root Terminal):
`runuser -u axiomatic -- env AXS_CRON_VERBOSE=1 bash /www/wwwroot/axiomatic/current/deploy/cron-reconcile.sh; echo "exit $?"`.

## Firewall

- aaPanel > Security: allow TCP 80 and 443, your SSH port, and the aaPanel panel port **restricted to your own IP**
  (also turn on the panel's security entrance, SSL and two-factor login). Never add 3000, 5432 or 6379.
- Cloud provider firewall (if any): the same rules.
- Check on the server: `ss -ltnp | grep -E ':(3000|5432|6379) '` must show only `127.0.0.1` / `[::1]` addresses.

## Privileges

Everything under `/www/wwwroot/axiomatic` (`current`, every release and its `deploy/*.sh`, `shared/`) belongs to the
app user `axiomatic`, and so do the running app (PM2) and `pnpm install` at deploy time. **Root never runs a file
from there**: if it did, anything that took over the app (a vulnerable or malicious dependency) could rewrite that file
or repoint `current`, and root would run its code at the next cron minute.

- aaPanel Cron tasks call `runuser -u axiomatic -- bash ...` (table above); in the root Terminal prefix the app's
  scripts with `sudo -iu axiomatic` (or `runuser -u axiomatic --`). `cron-job.sh`, `backup.sh`, `deploy.sh`,
  `restart.sh` and `rollback.sh` refuse to run as root (a guard against mistakes, not a security boundary).
- `db-setup.sh` is the one script that runs as root, and only in setup step 5, from the freshly unpacked `src/`
  before the app has ever run. Later runs (password rotation, a restore database): as the app user with
  `--host 127.0.0.1 --superuser postgres` (it asks for the `postgres` administrator password).
- Keep the app user out of `sudo` and the `sudo`/`wheel` groups; it needs no root rights.

## Deploying an update

Push the new version to GitHub from your PC, then on the server, as the app user:

```bash
cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh                  # latest main
cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh --ref v0.1.1     # a tag (or another branch)
```

`scripts/deploy.sh` fetches from GitHub, fast-forwards the checkout (it refuses when tracked files were edited on the
server) and runs `deploy/deploy.sh --source /www/wwwroot/axiomaticsoftwaresolutions.com`, so changes to the deploy tooling apply at once.
`deploy/deploy.sh` also accepts a `.tar.gz` archive or a git URL as `--source`; see `--help`.

What it does, in order: preflight (tools, disk, memory, env file mode 600, lock) > copy the source into
`releases/<UTC time>` without `node_modules`, build output or any real env file > link `shared/.env.production` >
`pnpm install --frozen-lockfile` (devDependencies included, store in `shared/pnpm-store`) > `prisma generate` >
`preflight.mjs` (production env rules, no CHANGE-ME left, PostgreSQL 14+ with a UTF8 database, Redis PING) >
pre-deploy `pg_dump` to `shared/backups` > `prisma migrate deploy` > bootstrap (`scripts/bootstrap-production.ts`;
`--first-run`, or `--bootstrap` on a later deploy, e.g. a release with a catalog addition such as the 2026-10-09
coming-soon products) > `next build`
(prerenders from the database, so after the migration) > switch `current` atomically > `pm2 startOrReload` >
`/api/health` on 127.0.0.1 within 90 s and a check that PM2 runs the new folder > `pm2 save` > catalog additions
(`--bootstrap` while an older release was live: the bootstrap before the build skips them with `--skip-additions` and
`bootstrap-production.ts --additions-only` runs them now, so the older release never reads a product status it does not
know; a first deploy adds them before the build) > keep the newest 3 releases. Anything failing before the switch leaves the live site untouched and deletes the half-built release.
With one PM2 instance the reload leaves a gap of a few seconds (Nginx answers 502 meanwhile); see "Scaling".
A failure after the switch rolls back automatically (next section).

Exit status: `0` deployed; `1` failed (the closing message says what is live); `3` the new release failed after the
switch and the previous release is live and healthy again (automatic rollback); `130` interrupted.

## Rollback

**Automatic (deploy.sh).** When PM2 cannot start the new release, `/api/health` does not answer 200 within
`AXS_HEALTH_TIMEOUT` (90 s) after the switch, or a PM2 process still runs in another folder, `deploy.sh`:

1. prints why (PM2's error, or the last 40 PM2 log lines when the health check timed out), then `the new release
   <new> is not healthy: rolling back to <previous> automatically`;
2. points `current` back at the previous release (the release that was live when the deploy started) in one atomic
   rename, runs `pm2 startOrReload` on it and checks `/api/health` and the processes' folder again, then `pm2 save`;
3. exits with status 3 after a `DEPLOY FAILED ... (exit 3)` message whose `AUTOMATIC ROLLBACK` paragraph names the
   release that is live again and the failed release left in `releases/` (no `.deploy-ok`, so `rollback.sh --list`
   marks it "[never passed the health check]", and the plain `rollback.sh` never picks it). Later deploys prune it.

If the previous release is missing or incomplete, or is not healthy either, the script exits 1 and says what
`current` points at now (the site is probably down: look at `pm2 logs`, then `restart.sh --recreate` or
`rollback.sh --to` an older release). The first deploy has nothing to go back to, so it stops with `current` on the
new release. The automatic rollback switches code only: migrations that deploy applied stay (see below), and the
pre-deploy dump is in `shared/backups/` if one has to be undone.

**By hand (rollback.sh)**, e.g. for a release that is healthy but misbehaves:

```bash
bash /www/wwwroot/axiomatic/current/deploy/rollback.sh --list
bash /www/wwwroot/axiomatic/current/deploy/rollback.sh                    # newest healthy release before current
bash /www/wwwroot/axiomatic/current/deploy/rollback.sh --to 20261007093000
```

Migrations are forward-only: a rollback switches code, never the schema. Older code keeps working when the newer
migrations only added things, which is how this project writes them. If a migration removed or renamed something the
older code needs, stop the app and restore `shared/backups/pre-deploy-<time>.dump` (see "Backups"). The failed
release stays on disk until later deploys prune it.

**Rolling back past a new status.** A new enum value is additive, but once rows use it, older code cannot read them:
its Prisma client throws "Value ... not found in enum" on any query that returns such a row. The 2026-10-09 release added
the product status `COMING_SOON` and the lead type `WAITLIST`. On a release older than that, the storefront still works
(it only reads published products), but Admin > Overview, Products & categories and Leads fail once those rows exist.
Before you run an older release for more than a few minutes, note the rows and move them to values it knows (psql as
the database owner):

```sql
SELECT id FROM "Product" WHERE status = 'COMING_SOON';          -- keep this list
UPDATE "Product" SET status = 'DRAFT' WHERE status = 'COMING_SOON';
UPDATE "Lead" SET kind = 'CONTACT' WHERE kind = 'WAITLIST';   -- their ids still start with WAIT-
```

After deploying the newer release again: `UPDATE "Lead" SET kind = 'WAITLIST' WHERE id LIKE 'WAIT-%';`, and mark the
listed products coming soon again (Admin > Products & categories > Mark coming soon, or `UPDATE "Product" SET status =
'COMING_SOON' WHERE id IN (...)`).

## Restart, env changes and secret rotation

- After editing `shared/.env.production`: `bash /www/wwwroot/axiomatic/current/deploy/restart.sh` (graceful PM2 reload,
  health check). That includes the `STORAGE_*` fallback: the CSP's bucket origin is set at runtime, not by the build.
- Razorpay, SMTP / Amazon SES and storage credentials saved in Admin > Settings > Integrations are rotated there: save
  the new value (Replace, then Save with your password). No restart or deploy; other PM2 processes follow within 30 s.
  They win over any `PAYMENT_*`, `EMAIL_*`, `SMTP_*`, `SES_*` or `STORAGE_*` line, which is only a fallback when
  nothing is saved.
- Removing the release-day stand-ins: save the real values in Admin first (they win at once), then delete every
  `PAYMENT_*`, `STORAGE_*` (except `DOWNLOAD_LINK_TTL_SECONDS`), `EMAIL_*`, `SMTP_*` and `SES_*` line and run `restart.sh`. The
  cards then say "Saved in Admin"; if the Admin settings are removed later, nothing falls back to stand-ins.
- Never run `pm2 reload --update-env` from a shell that exported app variables: PM2 copies the caller's environment,
  and an exported variable wins over the file. The scripts call PM2 with a clean environment.

| Value | How to rotate | Effect |
|---|---|---|
| `CRON_SECRET` | new random value (`openssl rand -hex 32`), restart | none (cron scripts read the file every run) |
| `CSRF_SECRET` | new random value, restart | open forms fail once; reload fixes it |
| `SESSION_SECRET` | new random value, restart | trusted devices forgotten (two-step code again for people who have it on), sign-in codes in flight void |
| `ORDER_TOKEN_SECRET` | new random value, restart | guest order links already emailed stop working |
| Razorpay webhook secret (Admin, or `PAYMENT_WEBHOOK_SECRET`) | save the new value in Admin and in the Razorpay webhook at the same time (fallback: edit the file, restart) | webhooks in between fail and are retried by Razorpay |
| Razorpay Key ID / Key secret (Admin, or `PAYMENT_KEY_ID` / `PAYMENT_KEY_SECRET`) | regenerate in Razorpay, save in Admin, "Test Razorpay keys" | unpaid orders start a fresh payment attempt; payments taken with the old keys of the same account and mode are still reconciled and refundable from Admin; after a test-to-live switch or with another account, refund old payments in the Razorpay Dashboard |
| Storage access key (Admin, or `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY`) | new key at the provider, save in Admin, "Test bucket", then delete the old key | none |
| SMTP password (Admin, or `SMTP_PASSWORD`) | new credential at the provider, save in Admin, "Send test email" | none |
| Amazon SES secret access key (Admin, or `SES_SECRET_ACCESS_KEY`) | IAM > the SES user > create a second access key, save the new key ID and secret in Admin, "Send test email", then deactivate and delete the old key | none |
| DB password (in `DATABASE_URL`) | edit the URL (letters and digits), as the app user `bash deploy/db-setup.sh --host 127.0.0.1 --superuser postgres`, restart | none |
| Redis password (in `REDIS_URL`) | edit the URL, set the same `requirepass` in aaPanel > Redis, restart Redis, then restart the app | rate-limited requests may be refused until the app restarts |
| `LICENSE_KEY_PEPPER`, `LICENSE_KEY_ENC_KEY` | **never** once a license key exists | issued keys could no longer be checked or revealed; the integration secrets saved in Admin could no longer be read (enter them again) |
| `LICENSE_SIGNING_*` | only together with an app release that embeds the new public key | old apps reject tokens signed with the new key |

## Logs

| What | Where |
|---|---|
| App (PM2) | as the app user: `pm2 logs axiomatic` (live), `pm2 logs axiomatic --lines 200 --nostream`, `pm2 status`, `pm2 monit`; files `shared/logs/app-out.log` and `app-error.log` (JSON lines, secrets redacted by `lib/log.ts`) |
| Deploys | `shared/logs/deploy-<release>.log` (30 days) |
| Scheduled jobs | aaPanel > Cron > the task > Log |
| Backups | `/www/backup/axiomatic/backup.log` (and the backup task's log) |
| Nginx | `/www/wwwlogs/<domain>.error.log` (the access log is off on purpose: order links carry a token; the error log can hold an order page URL from a restart's 502 seconds, go-live-checklist.md) |
| Health | `curl -s http://127.0.0.1:3000/api/health` (`{"status":"ok"}`; 503 names nothing, the app log says which check failed) |

PM2 log rotation is pm2-logrotate (setup step 8): 20 MB per file, 14 rotated files, compressed.

## Backups

`backup.sh` (daily aaPanel task) writes `pg_dump --format=custom` files to `/www/backup/axiomatic` (mode 700),
verifies each with `pg_restore --list`, then deletes dumps older than 14 days. `deploy.sh` also dumps to
`shared/backups/pre-deploy-*.dump` before every migration (7 days). Copy a dump off the server now and then
(aaPanel > Files > download, or sync the folder to object storage): a backup on the same disk does not survive the
server.

As the app user (from the root Terminal: `sudo -iu axiomatic` first; `backup.sh` refuses root):

```bash
bash /www/wwwroot/axiomatic/current/deploy/backup.sh            # one backup now
bash /www/wwwroot/axiomatic/current/deploy/backup.sh list
```

Restore (replaces every table):

```bash
sudo -iu axiomatic pm2 stop axiomatic                            # and pause the app's aaPanel cron tasks
sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/backup.sh restore axiomatic-20261007T210000Z.dump --yes
sudo -iu axiomatic pm2 start axiomatic                           # check /api/health, resume the cron tasks
```

To inspect a dump without touching the live database, as the app user:
`bash deploy/db-setup.sh --db axiomatic_restore --host 127.0.0.1 --superuser postgres`, then
`bash deploy/backup.sh restore <file> --yes --into axiomatic_restore`; switch by changing the database name in
`DATABASE_URL` and running `restart.sh`. A pre-deploy dump restores the same way
(`BACKUP_DIR=/www/wwwroot/axiomatic/shared/backups BACKUP_PREFIX=pre-deploy bash deploy/backup.sh restore <file> --yes`).

## Scaling PM2 instances

One process (fork mode) suits a 2-4 GB server. For more throughput, or reloads without the few-second gap, run one
process per vCPU in PM2 cluster mode (the processes share port 3000):

```bash
echo 'AXS_INSTANCES=2' >> /www/wwwroot/axiomatic/shared/deploy.env
bash /www/wwwroot/axiomatic/current/deploy/restart.sh --recreate    # brief downtime once (fork -> cluster)
```

Each process adds 300-500 MB of memory and its own database pool: instances x `DATABASE_POOL_MAX` (10) must stay well
below PostgreSQL `max_connections` (100). Rate limits are shared through Redis, the cron jobs are safe with any number
of processes. Back to one process: `AXS_INSTANCES=1` and `restart.sh --recreate`. Beyond one server: docs/scaling.md.

## PostgreSQL settings

The stock settings spill the larger portal and admin queries to disk (`docs/performance.md`: a large account's devices
page 257 ms -> 22 ms, its overview 105 ms -> 14 ms, billing 30 ms -> 3 ms). As the `postgres` administrator
(`/www/server/pgsql/bin/psql -U postgres -h 127.0.0.1 -d postgres`):

```sql
ALTER SYSTEM SET shared_buffers = '1GB';          -- '2GB' on a server with 8 GB of RAM or more
ALTER SYSTEM SET effective_cache_size = '2GB';
ALTER SYSTEM SET work_mem = '16MB';
ALTER SYSTEM SET maintenance_work_mem = '256MB';
ALTER SYSTEM SET random_page_cost = 1.1;          -- SSD / NVMe storage
```

Restart PostgreSQL (aaPanel > App Store > PostgreSQL Manager > Service; `shared_buffers` needs a restart). The values
land in `postgresql.auto.conf`, which wins over `postgresql.conf`. `work_mem` is per sort or hash, per connection:
keep `AXS_INSTANCES` x `DATABASE_POOL_MAX` (10) x 16 MB well below the free memory.

## Settings (`shared/deploy.env`, optional, no secrets)

| Key | Default | Meaning |
|---|---|---|
| `AXS_INSTANCES` | 1 | PM2 processes (2+ = cluster mode) |
| `AXS_MAX_MEMORY` | 1G | PM2 restarts a process above this memory |
| `AXS_HEAP_MB` | 512 | V8 heap cap per process (`--max-old-space-size`); 768 with `AXS_MAX_MEMORY=1500M` on 8 GB+ servers. Uncapped, a busy process grows to about 1.15 GB and hits `AXS_MAX_MEMORY`. Changing it needs `restart.sh --recreate` |
| `AXS_PORT` | 3000 | local port (also change the Nginx proxy target) |
| `AXS_KEEP_RELEASES` | 3 | releases kept on disk |
| `AXS_BUILD_HEAP_MB` | from RAM + swap (1536 / 2048 / 3072) | Node heap for `next build` |
| `AXS_HEALTH_TIMEOUT` | 90 | seconds to wait for `/api/health` after a (re)start |
| `AXS_NODE_DIR` | (PATH, else the newest `/www/server/nodejs/v24*/bin`) | folder with node, corepack and pm2 |

## Troubleshooting

- **502 Bad Gateway**: the app is not running or still starting. `pm2 status`, `pm2 logs axiomatic --lines 100`.
  An invalid environment stops the server on its first request after a start (`deploy.sh` and `restart.sh` make one
  at once) with "Invalid environment configuration" and the variable names; PM2 restarts it (the restart counter
  grows) and gives up after 15 quick crashes ("errored"). Fix the named variable, then `restart.sh`.
- **Signed-out visits to /account or /admin land on `localhost`**: `APP_URL` must be exactly `https://<domain>`; the
  sign-in redirect is built on it (behind Nginx the app itself only sees 127.0.0.1).
- **Health 503**: PostgreSQL or Redis is down or refuses the password. Restart it in aaPanel; the app log names the check.
- **Build killed / "heap out of memory"**: add swap (setup step 1) or set `AXS_BUILD_HEAP_MB`.
- **`ERR_PNPM_OUTDATED_LOCKFILE`**: `pnpm-lock.yaml` and `package.json` in the upload do not match; fix them on the
  development machine (`pnpm install`) and upload again.
- **Corepack "Cannot find matching keyid" or download errors**: update it as root (`npm install -g corepack@latest`).
- **Sign-in or forms fail with an origin error**: `APP_URL` is not exactly the address in the browser (https, no www).
- **Everyone shares one rate limit**: Nginx does not send `X-Forwarded-For` (use `aapanel-nginx.conf`), or
  `TRUSTED_PROXY_HOPS` is not 1.
- **Cron task fails with http=401**: `CRON_SECRET` changed but the app was not restarted (`restart.sh`).
- **`PM2 process ... still runs in` another folder** after a deploy: `pm2 delete axiomatic`, then
  `bash /www/wwwroot/axiomatic/current/deploy/restart.sh --recreate`.
- **A failed migration** blocks further deploys: run `NODE_ENV=production corepack pnpm exec prisma migrate status` in
  the newest release folder, fix the cause, mark it with `prisma migrate resolve`, deploy again.
