# Live server runbook: axiomaticsoftwaresolutions.com

How the test-mode release that went live on 8 Oct 2026 is set up on its server, and the commands to run it.
[`deploy-today.md`](deploy-today.md) is the general guide. This server differs from it in the places listed in
section 2, and every command below already includes those differences. Never put a password, key or the content of
`.env.production` in this file.

Commands run in **aaPanel > Terminal** as root unless they start with `sudo -iu axsstore` or `sudo -u axsstore` (= as
the app user). In the Terminal always switch users with `sudo`; `runuser` is only for the aaPanel Cron tasks.
**Root never runs, edits, `chown`s or `chmod`s anything the app user owns** (section 7): a compromised app could
otherwise turn a routine root command into root access on this shared server.

---

## 1. What runs where

| Item | Value |
|---|---|
| Site | https://axiomaticsoftwaresolutions.com (`www.` redirects to it) |
| Server | aaPanel 8 on Ubuntu 24.04, VPS `srv877937`, 168.231.102.76. **Shared with many other sites and apps.** |
| DNS | Cloudflare: A records `@` and `www` -> 168.231.102.76, **DNS only** (grey cloud), no AAAA (Nginx serves HTTPS on IPv4 only) |
| App user | `axsstore` (home `/home/axsstore`, not in `sudo`). The app, its files and its PM2 belong to it. |
| Node.js | 24.14.0 from `/www/server/nodejs/v24.14.0/bin`, for `axsstore` only (its `~/.profile` and `AXS_NODE_DIR`). The server's default Node stays v20 for the other apps. PM2 7 is installed in that same folder. |
| PM2 | `axsstore`'s own PM2; process **`axiomatic-software`**, fork mode, 1 instance. Starts on boot (`pm2-axsstore.service`). pm2-logrotate module: 20 MB x 14 files, compressed. |
| App port | **127.0.0.1:3210** (3000 belongs to another app) |
| Git checkout | `/www/wwwroot/axiomaticsoftwaresolutions.com` (also the aaPanel site folder), pulled with the read-only deploy key `/home/axsstore/.ssh/axiomatic_deploy` (GitHub > repo > Settings > Deploy keys > "aaPanel server") |
| Runtime folder | `/www/wwwroot/axiomatic`: `releases/<UTC time>/`, `current` -> the live release (its `.release` file names the commit), `shared/.env.production` (mode 600), `shared/deploy.env`, `shared/logs/` (app and deploy logs), `shared/backups/` (pre-deploy dumps, 7 days) |
| `shared/deploy.env` | `AXS_PORT=3210`, `AXS_NODE_DIR=/www/server/nodejs/v24.14.0/bin`, `AXS_APP_NAME=axiomatic-software` |
| Database | aaPanel PostgreSQL 16.10 (shared server), database and role **`axs_store`**, UTF8 / collation C, 127.0.0.1:5432 |
| Redis | the app's **own** instance on **127.0.0.1:6380** with a password: systemd `axsstore-redis`, config `/etc/axsstore-redis.conf` (root:axsstore, 640), binary `/usr/local/lib/axsstore-redis/redis-server` (a copy of aaPanel's Redis 8.2), no persistence, 128 MB. aaPanel's Redis on 6379 is not used. |
| Integrations | Razorpay, SMTP and the bucket are set in Admin > Settings > Integrations and stored encrypted in the database (key derived from `LICENSE_KEY_ENC_KEY`); the server file is only a fallback. Redis stays in the server file. |
| Nginx | site file `/www/server/panel/vhost/nginx/axiomaticsoftwaresolutions.com.conf` (aaPanel's static-file blocks and HSTS line removed, includes the proxy folder); proxy file `/www/server/panel/vhost/nginx/proxy/axiomaticsoftwaresolutions.com/axiomatic-app.conf` = `deploy/aapanel-nginx.conf` with port 3210; root-owned copy for repairs `/root/axs-nginx/axiomatic-app.conf` (5.5) |
| Web root | Nginx `root` is still the checkout folder; it is only reached if the proxy include goes missing. 5.6 replaces it with an empty folder. |
| TLS | Let's Encrypt wildcard `*.axiomaticsoftwaresolutions.com` + apex, imported in aaPanel ("Other certificate"). **Expires 21 Dec 2026 and aaPanel does not renew it** (5.4). |
| Nightly backups | `/home/axsstore/backups`, 14 days (section 6) |
| Scheduled jobs | 5 aaPanel Cron tasks (section 4) |

---

## 2. Where this server differs from deploy-today.md

| deploy-today.md | This server | Why |
|---|---|---|
| App user `axiomatic` | `axsstore` | A Linux user `axiomatic` already exists here for another app (`/opt/axiomatic`) |
| Database and role `axiomatic` | `axs_store` | A PostgreSQL role `axiomatic` already belongs to another app; `db-setup.sh` would have reset its password |
| Port 3000 | 3210 (`AXS_PORT`) | Port 3000 is used by an app under root's PM2 |
| Node 24 as aaPanel's command-line version, links in `/usr/local/bin` | Node 24 only for `axsstore` (`AXS_NODE_DIR`) | n8n and other apps run on the server's Node 20 |
| `requirepass` on aaPanel's Redis | Own Redis on 6380 | Other apps use aaPanel's Redis without a password |
| PostgreSQL memory tuning (2.3) | Not done | `ALTER SYSTEM` + restart affects every site on the server |
| aaPanel's Reverse proxy form | Proxy file written by hand (8.1) | aaPanel's website-monitor lines inside the static-file blocks make the form fail with `"location" directive is not allowed here` |
| Backups in `/www/backup/axiomatic` | `/home/axsstore/backups` | `/www/backup` is root-only (mode 600) and holds the other sites' backups |
| PM2 process `axiomatic` | `axiomatic-software` (`AXS_APP_NAME`) | Owner's choice |
| Razorpay, SMTP and bucket in the server file | Entered in Admin > Settings > Integrations (5.1); the release-day stand-ins in the file count as not configured | Owner decision 2026-10-08: editable, encrypted integrations |

---

## 3. Everyday commands

**Deploy** the latest `main`, or a tag (5-15 minutes; the live site keeps running; if the new release fails its health
check, the previous one is put back automatically):

```bash
sudo -iu axsstore bash -lc 'cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh'
sudo -iu axsstore bash -lc 'cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh --ref v0.1.1'
```

**Deploy with `--bootstrap`** when a release adds catalog rows (a "catalog addition", decisions.md 2026-10-09), such as
the release with the 20 coming-soon products and 3 new categories. The bootstrap runs after the migrations and before
the build (settings and counters only), and the catalog addition runs as step 13, once the new release is live and
healthy: the release that is still live during the build cannot read a "Coming soon" product, and its admin pages
that list every product (Overview, Products & categories) would fail until the switch. The addition inserts only the
categories and products that are missing, records itself so it never runs again, and leaves every existing product,
plan, setting and user as it is. The storefront lists the new products within 5 minutes (page cache). The Owner already
exists, so no `BOOTSTRAP_OWNER_*` line is needed (leave them out of `shared/.env.production`):

```bash
sudo -iu axsstore bash -lc 'cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh --bootstrap'
```

The deploy output (and `shared/logs/deploy-<release>.log`) shows, under `[13/14] Catalog additions`, `Catalog addition
2026-10-09-coming-soon ... added 3 categories, 20 products.` with one `+` line per row; a product skipped because its license prefix is taken is listed
with `!`. A later deploy with `--bootstrap` prints `already added on <date>; nothing to do`. To check at any time
(read only; the release reads `shared/.env.production` itself), and to run the addition by hand if step 13 failed (the
new release is live either way; drop `--dry-run`):

```bash
sudo -iu axsstore bash -lc 'cd /www/wwwroot/axiomatic/current && NODE_ENV=production node --import tsx scripts/bootstrap-production.ts --additions-only --dry-run'
```

`./scripts/deploy.sh` always pulls the newest `main` (or the given tag) first. To rebuild exactly the code that is live
(for example after an `APP_URL` change), check that the checkout is at the live commit, then build from it:

```bash
sudo -iu axsstore git -C /www/wwwroot/axiomaticsoftwaresolutions.com log -1 --format=%H
sudo -iu axsstore grep '^commit=' /www/wwwroot/axiomatic/current/.release       # the same commit
sudo -iu axsstore bash -lc 'cd /www/wwwroot/axiomaticsoftwaresolutions.com && bash deploy/deploy.sh --source "$PWD"'
```

**If a deploy fails**, its last lines read `DEPLOY FAILED in step N/14 ...`, a `What to do:` line and
`Full log: /www/wwwroot/axiomatic/shared/logs/deploy-<release>.log`.

- Steps 1-10 (checks, install, migrations, build): the live site is unchanged. Fix the cause shown above that line and
  run the same command again. Usual causes: another deploy, restart or rollback still running (lock); little free disk
  (`df -h /www`); a value in `shared/.env.production`; `axsstore-redis` or PostgreSQL stopped; the build ran out of
  memory (`AXS_BUILD_HEAP_MB` in `shared/deploy.env`).
- `AUTOMATIC ROLLBACK` (exit 3): the previous release is live and healthy again. Read the PM2 lines printed above it
  (or `sudo -iu axsstore pm2 logs axiomatic-software --lines 300 --nostream`), fix the cause, deploy again.
- The new release is live but not healthy, or the automatic rollback did not bring a healthy site back: go to 8.5.
- Step 13 (catalog additions): the new release is live and healthy; only the addition failed. Run it by hand (above).
- An error before `==> Releasing` (git fetch, local changes, cannot fast-forward): nothing changed. Test the deploy key
  with `sudo -iu axsstore ssh -T git@github.com`.
- Run every command a failure message suggests as the app user (`sudo -iu axsstore ...`). A bare `pm2` in the root
  Terminal is root's PM2, which runs another app on port 3000.

**Which release is live:** `sudo -iu axsstore cat /www/wwwroot/axiomatic/current/.release` (release, ref, commit, time).

**Restart** (after editing `shared/.env.production`):

```bash
sudo -iu axsstore bash /www/wwwroot/axiomatic/current/deploy/restart.sh
```

**Status, logs, health:**

```bash
sudo -iu axsstore pm2 status
sudo -iu axsstore pm2 logs axiomatic-software --lines 200 --nostream
curl -fsS http://127.0.0.1:3210/api/health; echo          # {"status":"ok"}
systemctl is-active axsstore-redis pm2-axsstore            # active, active
```

**Roll back** to the previous release (code only; database migrations stay), or to a named one. Going back to a
release older than the 2026-10-09 coming-soon release once its products or waitlist sign-ups exist breaks that old
release's admin pages that list them (Overview, Products & categories, Leads; the storefront is fine): see
"Rolling back past a new status" in `deploy/README.md` first.

```bash
sudo -iu axsstore bash /www/wwwroot/axiomatic/current/deploy/rollback.sh --list
sudo -iu axsstore bash /www/wwwroot/axiomatic/current/deploy/rollback.sh
sudo -iu axsstore bash /www/wwwroot/axiomatic/current/deploy/rollback.sh --to <release from --list>
```

**Smoke test** from the Windows PC, in the project folder, after every deploy. It is non-destructive: it sends no real
data and only leaves one rejected-webhook record and rate-limit counters.

```powershell
node scripts/smoke-prod.mjs --base https://axiomaticsoftwaresolutions.com
```

**What a change needs:**

| You changed | Then |
|---|---|
| Razorpay, email or bucket settings | Change them in Admin > Settings > Integrations (5.1); they apply within 30 seconds, no restart |
| Logos or favicon | Admin > Settings > Branding (Owner); they apply at once, no deploy (stored in the database, so backups include them) |
| A secret in `shared/.env.production` (session, license, database, Redis) | `restart.sh` |
| `APP_URL` | Deploy again (the build bakes it into the pages); see above to rebuild exactly the live code |
| Code (pushed to GitHub from the PC) | Deploy |
| Code that adds catalog products or categories (a catalog addition) | Deploy with `--bootstrap` (above) |
| `AXS_PORT` | `restart.sh --recreate`; then put the new port into the root copy of the proxy file (`sed -i 's#127.0.0.1:3210;#127.0.0.1:<NEW>;#' /root/axs-nginx/axiomatic-app.conf`), run 8.1, and use the new port in this runbook's health checks. The site answers 502 between the two steps. |
| `AXS_NODE_DIR` | 8.4 |
| `AXS_APP_NAME` | `sudo -iu axsstore pm2 delete <old name>`, then `restart.sh`, then `sudo -iu axsstore pm2 save` |

**Coming-soon products** are listed on the site with a "Coming soon" badge and a "Notify me when it launches" form, and
cannot be bought. Sign-ups arrive in Admin > Leads (type "Waitlist", references `WAIT-1001`, ...), each with an email to
the sales address; the product's drawer in Admin > Products & categories shows how many people are waiting. To launch
one: Admin > Plans & pricing, add its plans; Admin > Releases, create a release, upload the installer and publish it;
then Admin > Products & categories > the product > Publish (with a reason). Publish stays disabled, with the missing
item named, until it has page content, a plan on sale and a published release. The waitlist is not emailed
automatically: export it from Admin > Leads (filter Type = Waitlist) and write to those people. To take a coming-soon
product off the site, use Hide; to show a draft product as coming soon, use Mark coming soon.

**Editing the settings file:** always as the app user, never as root and never in aaPanel > Files (a compromised app
could otherwise swap the file for a link to a system file that root then changes):

```bash
sudo -iu axsstore nano /www/wwwroot/axiomatic/shared/.env.production
sudo -iu axsstore stat -c '%U %a %F' /www/wwwroot/axiomatic/shared/.env.production    # axsstore 600 regular file
```

In nano: Ctrl+W searches, Ctrl+O then Enter saves, Ctrl+X exits. Wrap values with spaces or `#` in double quotes and
write `$` as `\$`. If the mode is not 600: `sudo -iu axsstore chmod 600 /www/wwwroot/axiomatic/shared/.env.production`.
`shared/deploy.env` is edited the same way.

---

## 4. Scheduled jobs (aaPanel > Cron)

Task type Shell Script, execute user `root`, script on **one line**. The server clock is UTC.

| Name | Period | Script content |
|---|---|---|
| `axiomatic-emails` | N Minutes, 1 | `cd / && runuser -u axsstore -- bash /www/wwwroot/axiomatic/current/deploy/cron-emails.sh` |
| `axiomatic-reconcile` | N Minutes, 10 | `cd / && runuser -u axsstore -- bash /www/wwwroot/axiomatic/current/deploy/cron-reconcile.sh` |
| `axiomatic-renewals` | Daily 04:01 (09:31 IST) | `cd / && runuser -u axsstore -- bash /www/wwwroot/axiomatic/current/deploy/cron-renewals.sh` |
| `axiomatic-backup` | Daily 21:01 (02:31 IST) | `cd / && runuser -u axsstore -- env BACKUP_DIR=/home/axsstore/backups bash /www/wwwroot/axiomatic/current/deploy/backup.sh` |
| `axiomatic-maintenance` | Daily 22:01 (03:31 IST) | `cd / && runuser -u axsstore -- bash /www/wwwroot/axiomatic/current/deploy/cron-maintenance.sh` |

Where to look: aaPanel > Cron > the task > **Log**. The job scripts print nothing when there was nothing to do,
`cron <job> ok ...` when they did something, and `cron <job> FAILED http=...` on a problem (`http=401`: run
`restart.sh`; `http=000`: the app is down, 8.5). The backup task prints `backup ok axiomatic-<date>.dump <size>`; its
history is in `/home/axsstore/backups/backup.log` (`sudo -iu axsstore tail -n 3 /home/axsstore/backups/backup.log`).
Test the four jobs by hand (each prints `cron <job> ok` and `exit 0`):

```bash
cd / && for job in emails reconcile renewals maintenance; do sudo -u axsstore env AXS_CRON_VERBOSE=1 bash /www/wwwroot/axiomatic/current/deploy/cron-$job.sh; echo "exit $?"; done
```

---

## 5. Still to do

### 5.1 Razorpay, email and bucket: enter them in Admin

Since the release with editable integrations, the real values are entered in **Admin > Settings > Integrations** (Owner
only; every save asks for your password). They are stored encrypted in the database (key derived from
`LICENSE_KEY_ENC_KEY`) and shown only as "Set (ends 1a2b)". A saved card wins over the server file, and the
release-day stand-ins in `shared/.env.production` count as not configured. Until a card is saved: checkout says payments
aren't available yet, emails wait in the outbox, uploads and downloads answer an error. Saved changes apply within 30
seconds: no restart and no deploy, a bucket change included.

1. **Payment provider (Razorpay):** Dashboard > **Test Mode** > Account & Settings > API Keys > Generate Test Key
   (payment capture **automatic**). In Admin: Key ID, Key secret and a Webhook secret of your choice (a long random
   string, kept in the password manager). **Save**, then **Test Razorpay keys**. Then add the webhook (5.2).
2. **Email delivery:** Provider **SMTP** or **Amazon SES (API)**. SMTP: host, port and security (STARTTLS on 587 or TLS
   on 465), username, password, From name and From address. **Save**, then **Send test email** (it goes to your own
   address). Quickest for test mode: Gmail with an app password (Google Account > Security > 2-Step Verification on >
   App passwords): host `smtp.gmail.com`, port 587, STARTTLS, the Gmail address as username and From address. Use a
   Gmail account created only for this site's mail, never a main mailbox (an app password opens the whole mailbox).
   Before real customers, move to a sender on the site's own domain (Brevo, Zoho ZeptoMail or Amazon SES, with SPF and
   DKIM records in Cloudflare) and revoke the app password. **Amazon SES (API)** instead of SMTP: in the SES console,
   region **ap-south-1** (Mumbai), verify the domain (Identities > Create identity > Domain, Easy DKIM; the 3 CNAME
   records in Cloudflare, DNS only). Create an IAM user without console access whose only policy allows
   `ses:SendEmail` and `ses:SendRawEmail` on `arn:aws:ses:ap-south-1:<account-id>:identity/<domain>` only (in the
   sandbox also your verified test address's identity; with a configuration set also its ARN; the full policy is in
   docs/go-live-checklist.md), and an access key for it. In Admin: Provider **Amazon SES (API)**, AWS
   region `ap-south-1`, the access key ID and secret access key, configuration set empty, From name and a From address
   on the verified domain; **Save**, then **Send test email**. A new SES account is in the **sandbox**: it only delivers
   to verified addresses (verify your own for the test) until SES > Account dashboard > Request production access is
   granted.
3. **Installer storage (Cloudflare R2):** R2 > Create bucket `axiomatic-files` (Asia-Pacific; public access off: no
   r2.dev URL, no custom domain). Bucket > Settings > CORS policy:

   ```json
   [
     {
       "AllowedOrigins": ["https://axiomaticsoftwaresolutions.com"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["content-type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```

   R2 > Manage API tokens > Create API token: Object Read & Write, this bucket only. In Admin: preset **Cloudflare R2**,
   endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto`, the bucket, the token's access key ID and
   secret access key, path-style on. **Save** (the page reloads itself), then **Test bucket**. Reload any other open
   Admin tabs before uploading.

Changing the SMTP server or the storage endpoint later asks for the password or secret key again. **Remove saved
settings** on a card deletes it and falls back to the server file.

**Then remove the stand-ins from the server file** (as the app user; `DOWNLOAD_LINK_TTL_SECONDS` stays), restart, and
let the preflight confirm the saved cards:

```bash
sudo -iu axsstore sed -i -E '/^(PAYMENT_[A-Z_]+|STORAGE_(DRIVER|ENDPOINT|REGION|BUCKET|ACCESS_KEY_ID|SECRET_ACCESS_KEY|FORCE_PATH_STYLE)|EMAIL_[A-Z_]+|SMTP_[A-Z_]+)=/d' /www/wwwroot/axiomatic/shared/.env.production
sudo -iu axsstore grep -cE '^(PAYMENT_|STORAGE_|EMAIL_|SMTP_)' /www/wwwroot/axiomatic/shared/.env.production    # 0
sudo -iu axsstore bash /www/wwwroot/axiomatic/current/deploy/restart.sh
sudo -iu axsstore bash -lc 'cd /www/wwwroot/axiomatic/current && NODE_ENV=production node --import tsx deploy/preflight.mjs --db'
```

### 5.2 Razorpay webhook (Test Mode)

The Payment provider card shows the webhook URL, `https://axiomaticsoftwaresolutions.com/api/webhooks/payments/razorpay`.
Razorpay > Test Mode > Account & Settings > Webhooks > Add new webhook: that URL, the **same Webhook secret you saved in
Admin**, events `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`, `order.paid`. After the next
test payment, the card's test result shows when the last signed webhook arrived.

### 5.3 Owner sign-in and two-step verification

Since 8 Oct 2026 the emailed sign-in code (two-step verification) is **optional for every account, staff included**
(`docs/decisions.md`). Each person turns it on or off for themselves: staff in **Admin > My profile**, customers in
**Account > Security**. Turning it off asks for the password.

The Owner account (the address given as `BOOTSTRAP_OWNER_EMAIL` on release day) signs in with email and password; the
password is in the owner's password manager (the `BOOTSTRAP_OWNER_*` lines were removed from the settings file). The
first deploy created it with the code switched on, under the old rule. Once the release with optional two-step is live,
switch it off for that account, as the app's own database role (the PostgreSQL superuser never queries the app's
tables; section 7):

```bash
sudo -iu axsstore bash <<'EOF_AXS'
export PGHOST=127.0.0.1 PGUSER=axs_store
export PGPASSWORD="$(sed -n 's#^DATABASE_URL=postgresql://axs_store:\([^@]*\)@.*#\1#p' /www/wwwroot/axiomatic/shared/.env.production)"
/www/server/pgsql/bin/psql -X -d axs_store <<'SQL'
UPDATE "User" SET "twoStepEnabled" = false, "securityEpoch" = "securityEpoch" + 1
WHERE kind = 'STAFF' AND "staffRole" = 'OWNER' AND "twoStepEnabled";
SQL
EOF_AXS
```

It prints `UPDATE 1` (or `UPDATE 0` if it was already off).

Before real customers, once email works (5.1): Owner and Finance staff turn two-step **on** in Admin > My profile
(`go-live-checklist.md`). The Owner account controls every customer's licenses and payments. If a code does not arrive
within a minute (check spam), look for `email_send_failed` (it carries the SMTP error) in
`sudo -iu axsstore pm2 logs axiomatic-software --lines 200 --nostream`; sign-in codes are sent directly, not by the
`axiomatic-emails` Cron task. Do not keep retrying: each password attempt counts until it succeeds (5 per address per
15 minutes, then 429 for up to 15 minutes). Locked out because email broke while two-step was on: run the block above
for that account (with `WHERE email = '<the address>'` as the last line of the SQL).

### 5.4 Certificate renewal (before mid-November 2026)

aaPanel reused its stored wildcard certificate instead of issuing a new one, so aaPanel does not renew it. First check
that nothing else on this shared server uses or renews that wildcard:

```bash
FP=$(openssl x509 -in /www/server/panel/vhost/cert/axiomaticsoftwaresolutions.com/fullchain.pem -noout -fingerprint -sha256)
for c in /www/server/panel/vhost/cert/*/fullchain.pem; do [ "$(openssl x509 -in "$c" -noout -fingerprint -sha256 2>/dev/null)" = "$FP" ] && echo "$c"; done
ls /www/server/panel/vhost/nginx/ | grep -i axiomaticsoftwaresolutions
ls /etc/letsencrypt/renewal/ /root/.acme.sh/ 2>/dev/null | grep -i axiomaticsoftwaresolutions
```

Only if the first two commands list nothing but this site's own folder and file, and the third prints nothing:
aaPanel > Website > the site > SSL > **Certificate holder**: delete the stored `*.axiomaticsoftwaresolutions.com`
certificate, then **Let's Encrypt** > File verification > both names > Apply (plain HTTP redirects to HTTPS, which Let's
Encrypt follows, and the proxy file serves `/.well-known/acme-challenge/` from the web root). Otherwise use Let's
Encrypt with **DNS verification** through a Cloudflare API token (zone DNS edit), which gives a wildcard that aaPanel
renews itself, or ask whoever issued the wildcard. Afterwards check that aaPanel did not put the HSTS line back or drop
the proxy include, and that the new certificate is in place:

```bash
V=/www/server/panel/vhost/nginx/axiomaticsoftwaresolutions.com.conf
grep -c 'Strict-Transport-Security' "$V"                               # 0
grep -c 'vhost/nginx/proxy/axiomaticsoftwaresolutions.com' "$V"        # 1
openssl x509 -in /www/server/panel/vhost/cert/axiomaticsoftwaresolutions.com/fullchain.pem -noout -startdate -enddate
```

If either count is wrong, run 8.1.

### 5.5 A root-owned copy of the proxy file (once, soon)

The live proxy file was made from the release folder, which the app user owns, so Nginx (run by root) should only ever
load a copy that root keeps and has checked. Check that the live file is exactly the project's file with port 3210, then
keep the copy (8.1 only uses that copy):

```bash
P=/www/server/panel/vhost/nginx/proxy/axiomaticsoftwaresolutions.com
sha256sum "$P/axiomatic-app.conf"     # dc68e916a3910065c04fa36907ce99b9af48a13554babd0d8456a835a1b76ed1
install -D -m 600 -o root -g root "$P/axiomatic-app.conf" /root/axs-nginx/axiomatic-app.conf
```

Run the `install` line only if the hash matches. It is the hash of `deploy/aapanel-nginx.conf` at commit `c307e71` with
port 3210; on the PC, in Git Bash in the project folder:
`git show c307e71:deploy/aapanel-nginx.conf | sed 's#127\.0\.0\.1:3000;#127.0.0.1:3210;#' | sha256sum`.

**When a release changes `deploy/aapanel-nginx.conf`**, never copy it as root from the release folder. Read it as the app
user, compare and check:

```bash
sudo -u axsstore cat /www/wwwroot/axiomatic/current/deploy/aapanel-nginx.conf | sed 's#127\.0\.0\.1:3000;#127.0.0.1:3210;#' > /root/axs-nginx/candidate.conf
diff -u /root/axs-nginx/axiomatic-app.conf /root/axs-nginx/candidate.conf
sha256sum /root/axs-nginx/candidate.conf
```

The hash must equal the PC command above run with that release's commit, and the diff must add no `include`,
`access_log`/`error_log` path, `root`/`alias`, `ssl_*`, `server_name`, `listen`, or `proxy_pass` other than
`127.0.0.1:3210`. Then `install -m 600 /root/axs-nginx/candidate.conf /root/axs-nginx/axiomatic-app.conf` and run 8.1.

### 5.6 Serve an empty folder, not the checkout (hardening)

Nginx's `root` for this site is the git checkout. Every request normally goes to the app (the proxy's `location ^~ /`),
but if aaPanel ever drops the proxy include, Nginx would serve the checkout's files (source code, this runbook) as
static files. Point the site at an empty folder instead:

```bash
install -d -m 755 -o root -g root /www/wwwroot/axiomaticsoftwaresolutions.com-acme
```

aaPanel > Website > the site > **Site directory**: set it to `/www/wwwroot/axiomaticsoftwaresolutions.com-acme` and save
(aaPanel writes the site file again), then run 8.1 and check:

```bash
grep -nE '^[[:space:]]*root ' /www/server/panel/vhost/nginx/axiomaticsoftwaresolutions.com.conf      # ...-acme;
curl -s -o /dev/null -w '%{http_code}\n' https://axiomaticsoftwaresolutions.com/docs/server-runbook.md   # 404
```

The checkout stays where it is; deploys do not change. Let's Encrypt file verification then uses the new folder.

### 5.7 Smaller items

- aaPanel > Security (ufw) has rules that allow 5432 (PostgreSQL) and 23 (telnet) from anywhere. Check first:
  `ss -ltnp | grep -E ':(23|5432) '`. Remove the 5432 rule only if every line shows `127.0.0.1` or `[::1]`. If anything
  listens on 23 or on `0.0.0.0:5432`, the output names the process: ask that app's owner before changing the rule, and
  treat a telnet service as urgent (it sends passwords in plain text).
- aaPanel adds a `server_session_<hash>` cookie to every response of this site (its firewall or monitoring). Harmless
  for the app; review it before real customers (cookie notice, DPDP).
- Before live sales: [`go-live-checklist.md`](go-live-checklist.md) (live keys, real business details, legal pages,
  two-step on for Owner and Finance, a clean database).

---

## 6. Backups and restore

Nightly dumps: `/home/axsstore/backups/axiomatic-<UTC>.dump` (14 days). Before each deploy:
`/www/wwwroot/axiomatic/shared/backups/pre-deploy-<UTC>.dump` (7 days). Both are on the same disk as the database:
download a dump to the PC now and then (aaPanel > Files), and keep the `shared/.env.production` copy in the password
manager (a dump without its license secrets cannot verify issued keys).

```bash
sudo -iu axsstore env BACKUP_DIR=/home/axsstore/backups bash /www/wwwroot/axiomatic/current/deploy/backup.sh        # back up now
sudo -iu axsstore env BACKUP_DIR=/home/axsstore/backups bash /www/wwwroot/axiomatic/current/deploy/backup.sh list
```

**Test a restore** (the live database is not touched; monthly). The `postgres` superuser only creates and drops the
scratch database; the counts are read as the app's own role:

```bash
sudo -u postgres psql -d postgres -c "CREATE DATABASE axs_store_restore OWNER axs_store ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;"
sudo -iu axsstore env BACKUP_DIR=/home/axsstore/backups bash /www/wwwroot/axiomatic/current/deploy/backup.sh restore <axiomatic-....dump> --yes --into axs_store_restore
sudo -iu axsstore bash <<'EOF_AXS'
export PGHOST=127.0.0.1 PGUSER=axs_store
export PGPASSWORD="$(sed -n 's#^DATABASE_URL=postgresql://axs_store:\([^@]*\)@.*#\1#p' /www/wwwroot/axiomatic/shared/.env.production)"
for db in axs_store axs_store_restore; do
  /www/server/pgsql/bin/psql -X -d "$db" -At -c 'SELECT current_database(), (SELECT count(*) FROM "Order"), (SELECT count(*) FROM "License"), (SELECT count(*) FROM "Invoice");'
done
EOF_AXS
sudo -u postgres psql -d postgres -c "DROP DATABASE axs_store_restore;"
```

The counts match (or the live database is a little ahead).

**Restore into the live database** (everything written after the dump is lost):

1. aaPanel > Cron: stop the five `axiomatic-*` tasks.
2. Only if the dump is older than the live release's migrations: roll the code back to the matching release first,
   `sudo -iu axsstore bash /www/wwwroot/axiomatic/current/deploy/rollback.sh --to <release from --list>` (it restarts
   the app on that release).
3. Safety dump of the database as it is now, so this restore can be undone:
   `sudo -iu axsstore env BACKUP_DIR=/home/axsstore/backups bash /www/wwwroot/axiomatic/current/deploy/backup.sh`
   (note the file name in its `backup ok` line).
4. `sudo -iu axsstore pm2 stop axiomatic-software` (the site shows 502 until step 6).
5. `sudo -iu axsstore env BACKUP_DIR=/home/axsstore/backups bash /www/wwwroot/axiomatic/current/deploy/backup.sh restore <file> --yes`
   (for a pre-deploy dump give its full path under `/www/wwwroot/axiomatic/shared/backups/`).
6. `sudo -iu axsstore pm2 start axiomatic-software`, `curl -fsS http://127.0.0.1:3210/api/health`, start the Cron tasks
   again, run the smoke test.

---

## 7. Do not

- Use aaPanel's **Reverse proxy** form for this site (it breaks the site file; use 8.1).
- Change the `axs_store` password in aaPanel > Databases (the app loses the database until `DATABASE_URL` matches).
- Set a password on aaPanel's Redis (6379) or switch aaPanel's command-line Node version for this app: other apps
  depend on both.
- Touch the Linux user `axiomatic`, `/opt/axiomatic` or the PostgreSQL role `axiomatic`: they belong to another app.
- Run any script from `/www/wwwroot/axiomatic` or the checkout as root, `rollback.sh --list` included (it does not
  refuse root). Always put `sudo -iu axsstore` in front. The root checks inside the scripts live in files the app user
  can change, so they protect nothing. Never add `axsstore` to `sudo`.
- Edit, `chown` or `chmod` anything under `/www/wwwroot/axiomatic`, the checkout or `/home/axsstore` as root, or open
  those files in aaPanel > Files. Use `sudo -iu axsstore` (section 3).
- Run `git` as root in the checkout (its config could run commands): `sudo -iu axsstore git -C ...`.
- Query the app's tables as the `postgres` superuser (a compromised app could plant a view that runs its code with
  superuser rights); only `CREATE DATABASE` / `DROP DATABASE` as in section 6.
- Run `gen-prod-env.mjs --force` once a license exists: new license secrets make every issued key unverifiable.
- Change `LICENSE_KEY_ENC_KEY`: it also encrypts the integration secrets saved in Admin, which would all have to be
  entered again.
- Edit code on the server: change it on the PC, push to GitHub, deploy (the deploy refuses a checkout with local edits).

---

## 8. Repairs

### 8.1 Proxy missing (aaPanel's default page, 404 or 403 instead of the site)

aaPanel may rewrite the site file when SSL or site settings are saved in its forms. This block puts the proxy back from
the root-owned copy (5.5), drops aaPanel's static-file blocks and an HSTS line it may have re-added, keeps copies of the
site file and the proxy file, and puts both back if the Nginx test fails:

```bash
V=/www/server/panel/vhost/nginx/axiomaticsoftwaresolutions.com.conf
P=/www/server/panel/vhost/nginx/proxy/axiomaticsoftwaresolutions.com
SRC=/root/axs-nginx/axiomatic-app.conf
if [ ! -f "$SRC" ]; then echo "STOP: $SRC is missing (section 5.5)"; else
cp "$V" /root/axs-vhost-before-repair.conf
if [ -f "$P/axiomatic-app.conf" ]; then cp "$P/axiomatic-app.conf" /root/axs-proxy-before-repair.conf; else rm -f /root/axs-proxy-before-repair.conf; fi
awk 'index($0, "location ~ .*\\.(gif|") || index($0, "location ~ .*\\.(js|css)") {skip=1}
skip && /^[[:space:]]*}[[:space:]]*$/ {skip=0; next}
skip {next}
/vhost\/nginx\/proxy\/axiomaticsoftwaresolutions\.com/ {next}
/Strict-Transport-Security/ {next}
{print}
/#REWRITE-END/ {print "    include /www/server/panel/vhost/nginx/proxy/axiomaticsoftwaresolutions.com/*.conf;"}' /root/axs-vhost-before-repair.conf > "$V"
install -d -m 755 "$P" && install -m 644 -o root -g root "$SRC" "$P/axiomatic-app.conf"
diff /root/axs-vhost-before-repair.conf "$V"; grep -n 'proxy_pass' "$P/axiomatic-app.conf"; ls "$P"
if /www/server/nginx/sbin/nginx -t; then /www/server/nginx/sbin/nginx -s reload && echo "PROXY OK"
else cp /root/axs-vhost-before-repair.conf "$V"; if [ -f /root/axs-proxy-before-repair.conf ]; then cp /root/axs-proxy-before-repair.conf "$P/axiomatic-app.conf"; else rm -f "$P/axiomatic-app.conf"; fi; /www/server/nginx/sbin/nginx -t && echo "RESTORED - nothing changed"; fi
fi
```

`ls "$P"` must list only `axiomatic-app.conf`. If the Nginx test reports a duplicate `location "/"`, aaPanel's own
proxy file is in that folder too: delete it and run the block again. The "protocol options redefined" warnings come
from two other sites on the server and are harmless.

### 8.2 After a server reboot

```bash
systemctl is-active axsstore-redis pm2-axsstore            # active, active
sudo -iu axsstore pm2 status                               # axiomatic-software online
curl -fsS http://127.0.0.1:3210/api/health; echo           # {"status":"ok"}
```

### 8.3 The private Redis

Config `/etc/axsstore-redis.conf` (its `requirepass` equals the password inside `REDIS_URL`), logs
`journalctl -u axsstore-redis`. When aaPanel upgrades its own Redis, this instance keeps running its copy; to update it:

```bash
install -m 755 -o root -g root /www/server/redis/src/redis-server /usr/local/lib/axsstore-redis/redis-server && systemctl restart axsstore-redis
sleep 3; curl -fsS http://127.0.0.1:3210/api/health; echo        # {"status":"ok"}: the app reached Redis with its password
```

### 8.4 If aaPanel removes Node 24.14.0

The app, PM2 and the boot service all use `/www/server/nodejs/v24.14.0/bin`. Install another v24 in aaPanel's Node.js
version manager (do not make it the command-line version). With `<NEW>` its folder (e.g. `/www/server/nodejs/v24.15.0`):

1. As root: `PATH=<NEW>/bin:$PATH npm install -g --prefix <NEW> pm2`.
2. `sudo -iu axsstore nano /www/wwwroot/axiomatic/shared/deploy.env` (set `AXS_NODE_DIR=<NEW>/bin`) and
   `sudo -iu axsstore nano /home/axsstore/.profile` (the `PATH` line).
3. `sudo -iu axsstore bash /www/wwwroot/axiomatic/current/deploy/restart.sh --recreate`.
4. As root: `env PATH="<NEW>/bin:$PATH" <NEW>/bin/pm2 startup systemd -u axsstore --hp /home/axsstore`, then
   `sudo -iu axsstore pm2 save`.

### 8.5 Site shows 502 Bad Gateway, or /api/health is not ok

```bash
sudo -iu axsstore pm2 status                                          # online? restarts climbing? errored?
curl -sS -i http://127.0.0.1:3210/api/health | head -n 1              # 200 ok; 503 database or Redis; refused = app down
systemctl is-active axsstore-redis pm2-axsstore                       # active, active
sudo -iu axsstore pm2 logs axiomatic-software --lines 200 --nostream  # "Invalid environment configuration" names the variable
tail -n 20 /www/wwwlogs/axiomaticsoftwaresolutions.com.error.log      # connect() failed ... 127.0.0.1:3210
grep -n proxy_pass /www/server/panel/vhost/nginx/proxy/axiomaticsoftwaresolutions.com/axiomatic-app.conf   # 127.0.0.1:3210
```

- An invalid setting: fix it in `shared/.env.production` (section 3), then `restart.sh`.
- The app is `errored` or not listed: `sudo -iu axsstore bash /www/wwwroot/axiomatic/current/deploy/restart.sh --recreate`.
- 503: `systemctl restart axsstore-redis` (logs: `journalctl -u axsstore-redis`), or start PostgreSQL in aaPanel > App
  Store (shared with other sites).
- Checkout says payments are not available and the API answers 503 `payments_unavailable`: the Payment provider card
  in Admin > Settings > Integrations is not configured (5.1).
- `proxy_pass` is not 3210, or the proxy file is missing: 8.1.
- Storefront pages answer 404 and the app log shows `NoFallbackError`: a page uses `dynamicParams = false` again (decisions.md "No `dynamicParams = false` on ISR pages"). `restart.sh` is the stop-gap; the fix is in the code.
- The app's own log files: `/www/wwwroot/axiomatic/shared/logs/app-out.log` and `app-error.log`. Never check this app on
  port 3000 (another app) or with a bare `pm2` as root.

---

## 9. How it was set up (for a rebuild)

In this order, on 7-8 Oct 2026 (UTC evening):

1. Cloudflare: both records DNS only. aaPanel: site `axiomaticsoftwaresolutions.com` + `www` (static, no database).
   SSL: the imported wildcard (`*.axiomaticsoftwaresolutions.com` + apex, "Other certificate", expires 21 Dec 2026;
   aaPanel's Let's Encrypt button reused it, see 5.4). Force HTTPS on (plain http answers 301). The HSTS line removed
   from the site file.
2. `useradd --create-home --shell /bin/bash axsstore`;
   `echo 'export PATH=/www/server/nodejs/v24.14.0/bin:$PATH' >> /home/axsstore/.profile`;
   `PATH=/www/server/nodejs/v24.14.0/bin:$PATH npm install -g --prefix /www/server/nodejs/v24.14.0 pm2`.
3. `mkdir -p /www/wwwroot/axiomatic/shared`, `shared/deploy.env` with `AXS_PORT` and `AXS_NODE_DIR` (section 1),
   `chown -R axsstore: /www/wwwroot/axiomatic && chmod 750 /www/wwwroot/axiomatic`,
   `chown axsstore:axsstore /www/wwwroot/axiomaticsoftwaresolutions.com` (all before the app ever ran).
4. Deploy key as `axsstore` (`ssh-keygen -t ed25519 -N "" -f ~/.ssh/axiomatic_deploy`, added on GitHub without write
   access, `~/.ssh/config` entry `Host github.com` with that `IdentityFile` and `IdentitiesOnly yes`), then in the site
   folder: `git init -q -b main && git remote add origin git@github.com:axiomaticwebsolutions/axiomaticsoftwaresolutions.com.git && git fetch origin && git checkout -t origin/main`.
5. `sudo -iu axsstore node /www/wwwroot/axiomaticsoftwaresolutions.com/scripts/gen-prod-env.mjs --out /www/wwwroot/axiomatic/shared/.env.production`,
   then in that file: role and database in `DATABASE_URL` renamed to `axs_store`, `REDIS_URL` port 6380,
   `APP_URL=https://axiomaticsoftwaresolutions.com`.
6. `bash /www/wwwroot/axiomaticsoftwaresolutions.com/deploy/db-setup.sh` (as root, once, before the first deploy).
7. Private Redis: `/etc/axsstore-redis.conf` (`bind 127.0.0.1`, `port 6380`, `protected-mode yes`, `daemonize no`,
   `requirepass` = the `REDIS_URL` password, `save ""`, `appendonly no`, `dir /var/lib/axsstore-redis`,
   `maxmemory 128mb`), the binary copied to `/usr/local/lib/axsstore-redis/` (aaPanel's `/www/server/redis` is mode 700
   for its `redis` user), and `/etc/systemd/system/axsstore-redis.service` (`User=axsstore`, `Group=axsstore`,
   `ExecStart=/usr/local/lib/axsstore-redis/redis-server /etc/axsstore-redis.conf`, `Restart=always`,
   `StateDirectory=axsstore-redis`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=full`);
   `systemctl enable --now axsstore-redis`.
8. Stand-in values (5.1) and `BOOTSTRAP_OWNER_EMAIL`, then
   `sudo -iu axsstore bash -lc 'cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh --first-run'`
   (release `20261007225943`, 2 min 46 s). The Owner password went to the password manager and the
   `BOOTSTRAP_OWNER_*` lines were deleted.
9. `env PATH="/www/server/nodejs/v24.14.0/bin:$PATH" /www/server/nodejs/v24.14.0/bin/pm2 startup systemd -u axsstore --hp /home/axsstore`,
   pm2-logrotate, `pm2 save`; PM2 process renamed to `axiomatic-software` (`AXS_APP_NAME`).
10. Proxy by hand (the 8.1 approach, then from the release folder), smoke test 57 of 57 PASS,
    `install -d -m 700 -o axsstore -g axsstore /home/axsstore/backups`, the five Cron tasks (section 4).
11. Same day: two-step made optional for all accounts (5.3) and this runbook added.
