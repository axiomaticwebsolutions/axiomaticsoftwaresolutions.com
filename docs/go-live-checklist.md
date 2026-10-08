# Go-live checklist

Two lists: what must be true for today's **test-mode release** (Razorpay TEST keys, real email and storage, the site
labelled sample), and what must be true **before live sales**. Each item says how to check it. The step-by-step
deployment is in [`deploy-today.md`](deploy-today.md) ("step N" below means a step there). `<domain>` is your domain.

Server commands run in the aaPanel Terminal as `root`. The app runs as the user `axiomatic` (PM2 process name
`axiomatic`), so PM2 commands and the app's `deploy/*.sh` scripts are prefixed with `sudo -iu axiomatic` (root never
runs a file from `/www/wwwroot/axiomatic`, deploy/README.md "Privileges"). The live release is
`/www/wwwroot/axiomatic/current`, the settings file `/www/wwwroot/axiomatic/shared/.env.production`. For the database
checks, first set the client path in the Terminal tab:
`PSQL=/www/server/pgsql/bin/psql; [ -x "$PSQL" ] || PSQL="$(command -v psql)"` (each `psql` asks for the `postgres`
administrator password).

Tick an item only after you have done the check, not because the setting "should" be right.

## Test-mode release (today)

### Server and network
- [ ] **DNS points at the server.** Windows: `nslookup <domain>` shows only your server's IPv4 address. No `AAAA`
  record unless the server really serves IPv6. On Cloudflare the records are "DNS only" (grey cloud). The smoke
  test's DNS rows PASS.
- [ ] **Only 80, 443 and SSH are open to the internet.** Windows: `Test-NetConnection <domain> -Port 3000`, then
  `-Port 5432` and `-Port 6379`: each shows `TcpTestSucceeded : False`. Server: `ss -tlnp | grep -E ':(3000|5432|6379)\b'`
  shows only `127.0.0.1` (or `[::1]`) addresses, never `0.0.0.0` or `*`. aaPanel > Security lists none of these ports.
- [ ] **The aaPanel panel is private.** aaPanel > Settings: security entrance set, panel SSL on, two-factor
  authentication on; the panel port is allowed only from your IP in the cloud firewall (or "Authorized IP" is set).
- [ ] **Enough memory.** `free -h`: RAM + swap together at least 4 GB; `grep swap /etc/fstab` shows the swap file
  (it survives a reboot).
- [ ] **Versions.** `node -v` is v24.x; `pm2 -v` prints a version;
  `sudo -iu axiomatic bash -lc 'cd /www/wwwroot/axiomatic/current && corepack pnpm -v'` prints 11.0.8;
  `"$PSQL" --version` is 14 or newer (16/17 preferred).
- [ ] **Everything survives a reboot.** `systemctl is-enabled pm2-axiomatic` prints `enabled` (from `pm2 startup`,
  step 5). Reboot once (aaPanel > Home > Restart server) and, a few minutes later, https://<domain>/api/health answers
  `{"status":"ok"}` without you starting anything; `sudo -iu axiomatic pm2 status` shows `axiomatic` online.

### Database and Redis
- [ ] **UTF-8 database with the C collation.**
  `"$PSQL" -U postgres -h 127.0.0.1 -d postgres -c "SELECT datname, pg_encoding_to_char(encoding), datcollate, datctype FROM pg_database WHERE datname = 'axiomatic';"`
  shows `UTF8`, `C`, `C` (`sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/db-setup.sh --host 127.0.0.1 --superuser postgres`
  prints the same facts).
- [ ] **The app's role is not privileged.**
  `"$PSQL" -U postgres -h 127.0.0.1 -d postgres -c "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'axiomatic';"`
  shows `f` three times.
- [ ] **Migrations applied.**
  `sudo -iu axiomatic bash -lc 'cd /www/wwwroot/axiomatic/current && NODE_ENV=production corepack pnpm exec prisma migrate status'`
  ends with "Database schema is up to date!".
- [ ] **Redis has a password and listens locally.** `ss -tlnp | grep ':6379'` shows `127.0.0.1:6379` only;
  `/www/server/redis/src/redis-cli -h 127.0.0.1 ping` answers `NOAUTH Authentication required.`

### Configuration and secrets
- [ ] **`shared/.env.production` is private.** `stat -c '%a %U' /www/wwwroot/axiomatic/shared/.env.production` prints
  `600 axiomatic`; `ls -l /www/wwwroot/axiomatic/current/.env.production` shows a link to `../../shared/.env.production`.
  It is not inside the website folder (`/www/wwwroot/<domain>`), and it was never emailed or pasted into a chat.
- [ ] **A copy of `shared/.env.production` is in your password manager.** `LICENSE_KEY_PEPPER`, `LICENSE_KEY_ENC_KEY`
  and the `LICENSE_SIGNING_*` key pair cannot be regenerated: without them a restored database cannot read or verify
  any license key, and every installed app would have to be re-activated.
- [ ] **Nothing is left to fill in.** `grep -iE '^[A-Z_]+=.*change-?me' /www/wwwroot/axiomatic/shared/.env.production | cut -d= -f1`
  prints nothing (names only, never values).
- [ ] **Test mode is on.** Admin > Settings > Integrations > Payment provider shows "Saved in Admin" and the **Test
  mode** badge (the Key ID starts with `rzp_test_`), and Admin shows the "Test mode" pill in the top bar.
- [ ] **No release-day stand-ins left.** Once Razorpay, email and storage are saved in Admin, the server file has no
  integration lines: `grep -cE '^(PAYMENT|STORAGE|EMAIL|SMTP)_' /www/wwwroot/axiomatic/shared/.env.production` prints
  `0` (`DOWNLOAD_LINK_TTL_SECONDS` stays and does not match). Otherwise delete those lines and run `restart.sh`
  (deploy/README.md "Restart, env changes and secret rotation").
- [ ] **Public address and proxy count.** `grep -E '^(APP_URL|TRUSTED_PROXY_HOPS)=' /www/wwwroot/axiomatic/shared/.env.production`
  shows `APP_URL=https://<domain>` (no trailing slash, no `www.`) and `TRUSTED_PROXY_HOPS=1` (2 only behind
  Cloudflare's orange-cloud proxy).
- [ ] **The bootstrap lines are gone.** `grep -c '^BOOTSTRAP_OWNER_' /www/wwwroot/axiomatic/shared/.env.production`
  prints `0` (deleted after the first sign-in, step 9).
- [ ] **The app accepted the configuration.** `sudo -iu axiomatic pm2 logs axiomatic --nostream --lines 300 | grep -c "Invalid environment configuration"`
  prints `0`, and the restart counter (`↺`) in `sudo -iu axiomatic pm2 status` does not grow (an invalid setting ends
  the process on its first request, so PM2 keeps restarting it). (Production refuses
  mock payments, local storage, console email, `CATALOG_SOURCE=fixtures`, an http `APP_URL`, a missing `REDIS_URL`
  and `TRUSTED_PROXY_HOPS=0`; `deploy.sh` checks all of this before it builds.)

### App process (PM2) and releases
- [ ] **The app runs under PM2 as `axiomatic`, not root.** `sudo -iu axiomatic pm2 status` shows `axiomatic`
  **online** with a growing uptime; `ps -o user= -p "$(sudo -iu axiomatic pm2 pid axiomatic | head -n 1)"` prints
  `axiomatic`.
- [ ] **Health answers on the server.** `curl -fsS http://127.0.0.1:3000/api/health` prints `{"status":"ok"}`.
- [ ] **The app listens on localhost only.** `ss -tlnp | grep ':3000'` shows `127.0.0.1:3000`.
- [ ] **Logs are rotated.** `sudo -iu axiomatic pm2 conf pm2-logrotate` shows `max_size` and `retain` (step 5).
- [ ] **Release layout.** `readlink -f /www/wwwroot/axiomatic/current` points into `/www/wwwroot/axiomatic/releases/`;
  `sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/rollback.sh --list` shows at most 3 releases, the
  current one "[was healthy]".
- [ ] **You know what an automatic rollback looks like.** When a deploy's new release fails `/api/health` after the
  switch, `deploy.sh` puts the previous release back, prints `AUTOMATIC ROLLBACK` and exits with status 3; the
  failed release shows "[never passed the health check]" in `rollback.sh --list` (deploy/README.md "Rollback").
  After any deploy, `grep -c ' DEPLOYED ' /www/wwwroot/axiomatic/shared/logs/deploy-<release>.log` prints `1`.

### Scheduled jobs and backups (aaPanel Cron)
- [ ] **The five tasks exist.** aaPanel > Cron lists `axiomatic-emails` (every minute), `axiomatic-reconcile` (every
  10 minutes), `axiomatic-renewals` (daily), `axiomatic-backup` (daily) and `axiomatic-maintenance` (daily, after the
  backup: `deploy/cron-maintenance.sh`), each a Shell Script whose one line is
  `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/<script>`: the app user runs it, never root.
  No task contains a secret (open each and read it).
- [ ] **The jobs succeed.** No task's **Log** shows `FAILED` lines (idle runs print nothing; runs that did something
  print `cron <job> ok`). By hand:
  `for job in emails reconcile renewals maintenance; do runuser -u axiomatic -- env AXS_CRON_VERBOSE=1 bash /www/wwwroot/axiomatic/current/deploy/cron-$job.sh; echo "exit $?"; done`
  prints four `ok` lines and `exit 0` four times. `http=401` means the running app and `shared/.env.production`
  disagree about `CRON_SECRET` (`sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/restart.sh`); `http=000` means the app is down.
- [ ] **The cron routes are closed to the internet.** The smoke test's Cron rows PASS with `404 (blocked at the proxy)`.
- [ ] **A backup exists.** `sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/backup.sh list` shows today's
  `axiomatic-*.dump` with a plausible size, and you copied one off the server (step 12.4).

### Website, SSL and proxy (aaPanel)
- [ ] **HTTPS works and renews.** aaPanel > Website > `<domain>` > SSL shows a Let's Encrypt certificate with
  auto-renewal for `<domain>` and `www.<domain>`; "Force HTTPS" is on. The smoke test's TLS rows PASS (certificate
  valid, more than 14 days left, `http://` redirects to `https://`).
- [ ] **The website folder is not the app.** aaPanel > Website > `<domain>` > Site directory is `/www/wwwroot/<domain>`.
  The smoke test's "Env and source files are not served" row PASSes.
- [ ] **The proxy forwards the right headers and caches nothing.**
  `grep -rhoE 'proxy_set_header +(Host|X-Forwarded-For|X-Forwarded-Proto) +[^;]+' /www/server/panel/vhost/nginx/ | sort -u`
  shows `Host $host`, `X-Forwarded-For $proxy_add_x_forwarded_for` and `X-Forwarded-Proto $scheme` (the lines from
  `deploy/aapanel-nginx.conf`). The reverse-proxy rule has cache off, and the smoke test's Health and Device API rows
  PASS without a Cache-Control warning (`no-store` reaches the client).
- [ ] **One address only.** `curl.exe -sSI https://www.<domain>/` (Windows) shows `301` and
  `Location: https://<domain>/`; the smoke test's "www redirects" row PASSes. The site is never served on `www`,
  because sign-in and checkout refuse posts from any origin other than `APP_URL`.
- [ ] **Client IPs are real.** Sign in to the portal from your phone on mobile data, open Account > Security >
  Sessions: the session shows your phone's public IP prefix, not `127.0.0.1` (that would mean `X-Forwarded-For` or
  `TRUSTED_PROXY_HOPS` is wrong, and every visitor would share one rate-limit bucket).
- [ ] **Logs keep no order-link tokens.** Open an order link (`/orders/<id>?t=...`), then
  `grep -c '?t=' /www/wwwlogs/<domain>.log /www/wwwlogs/<domain>.error.log` prints `0` for both files (order links
  are 30-day credentials). The error log can still get one: while the app restarts (a few seconds of 502 in fork
  mode) Nginx logs each failed request line, query string included, so an order page opened at that moment leaves
  its token there. Delete such lines (`sed -i '/?t=/d' /www/wwwlogs/<domain>.error.log`); the order page's status
  polls carry the token in a header, never in the URL.
- [ ] **No duplicate security headers.** The smoke test shows no WARN "sent twice" for HSTS, X-Frame-Options or
  X-Content-Type-Options (the app sends them; aaPanel's HSTS switch stays off).
- [ ] **Static files come from the app.** The smoke test's "Static asset through the proxy" row PASSes (an aaPanel
  static-file rule would otherwise answer `/_next/static/*.js` with 404 or add a second expiry).

### Application
- [ ] **Smoke test passes.** Windows: `node scripts/smoke-prod.mjs --base https://<domain>` ends with "Result: OK"
  (`0 failed`) and `$LASTEXITCODE` is `0`.
- [ ] **Catalog and Owner bootstrapped.** /software lists the products, and
  `sudo -iu axiomatic bash -lc 'cd /www/wwwroot/axiomatic/current && NODE_ENV=production node --import tsx scripts/bootstrap-production.ts --dry-run'`
  reports nothing left to create.
- [ ] **Owner can sign in.** The Owner signs in at https://<domain>/sign-in with the password alone (two-step sign-in
  starts off, so Admin is reachable before SMTP works; decisions.md 2026-10-08).
- [ ] **Email works.** "Forgot password" on /sign-in (or a test purchase) sends an email that arrives within a minute.
  Until it does, leave two-step sign-in off: its codes are emailed.
- [ ] **Settings reviewed.** Admin > Settings: business details (sample placeholders are fine today, `sample` stays
  on), support / sales / legal / privacy emails are mailboxes you read, invoice prefix `AXS` and credit-note prefix
  `AXC` (or your choice, up to 3 characters), GST rate 18 % and SAC 997331 (to confirm with your CA). Integrations:
  payments, storage and email each say "Saved in Admin" (payments with Test mode), and "Test Razorpay keys", "Send
  test email" and "Test bucket" each pass; Rate limits says Configured.
- [ ] **The site says it is a test.** The sample notice strip shows on the home page.
- [ ] **Installer uploads work.** Admin > Releases: a draft release takes an installer upload and publishes. Every
  page allows the bucket's origin in `connect-src`, taken at runtime from the storage settings saved in Admin: a CSP
  error in the browser console (F12) mentioning `connect-src` means the tab was opened before the bucket was saved
  (reload) or the saved bucket differs from the one uploads go to ("Test bucket"); a CORS error means the bucket's
  CORS rule lacks `https://<domain>` or `PUT`.
- [ ] **Razorpay webhook is delivered.** Razorpay Dashboard (Test Mode) > Webhooks > your webhook: recent deliveries
  show response code 200; the events are `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`
  and `order.paid` (without `refund.failed` a refund Razorpay could not complete is noticed only a day later).
- [ ] **A test purchase completes end to end** (step 11): the order turns Paid within seconds, the license key is
  shown once, the confirmation and "license issued" emails arrive, the invoice PDF downloads (it says it is not a
  valid tax invoice while the business details are sample), the installer downloads, and the activation API
  activates, validates and deactivates a test device.
- [ ] **A refund works.** Admin > Orders & payments > the test order > Refund (Owner or Finance, with a reason): the
  license is revoked, a credit-note number is issued, and Razorpay's `refund.processed` webhook marks the order
  Refunded (a `refund.failed` webhook puts it "In review" instead, and the refund can be issued again).
- [ ] **Development tools are hidden.** The smoke test's "Dev routes" rows PASS (`/dev/*` and `/api/dev/*` are 404),
  and its "CSP without 'unsafe-eval'" row says "production build".
- [ ] **Strict CSP and the other security headers reach the browser.** The smoke test's "Strict CSP" rows PASS (a
  fresh nonce on every /sign-in and /checkout response, which also proves no proxy caches those pages) and its
  Cross-Origin-Opener-Policy and X-Permitted-Cross-Domain-Policies rows PASS.
- [ ] **PostgreSQL settings applied** (deploy/README.md "PostgreSQL settings"). Check:
  `"$PSQL" -U postgres -h 127.0.0.1 -d axiomatic -c 'SHOW shared_buffers' -c 'SHOW work_mem' -c 'SHOW random_page_cost'`
  prints the values you set (1GB or 2GB, 16MB, 1.1).

## Before live sales

### Start live on clean data
- [ ] **Test orders, customers, licenses and invoices are gone.** Test-mode orders take real invoice numbers
  (`AXS/<FY>/0001` onwards) and appear in the GST summary used for GSTR-1. Decide with your CA; the recommended way is
  a fresh database:
  1. Back up (`sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/backup.sh`) and keep that dump.
  2. aaPanel > Cron: pause the five `axiomatic-*` tasks; `sudo -iu axiomatic pm2 stop axiomatic`.
  3. `"$PSQL" -U postgres -h 127.0.0.1 -d postgres -c "DROP DATABASE axiomatic WITH (FORCE);"`, then
     `sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/db-setup.sh --host 127.0.0.1 --superuser postgres`
     (creates it again, empty and UTF-8; asks for the `postgres` administrator password).
  4. In `shared/.env.production`: the real `BOOTSTRAP_BUSINESS_*` values (optional), and the `BOOTSTRAP_OWNER_EMAIL=`
     and `BOOTSTRAP_OWNER_PASSWORD=` lines again (8+ characters with a letter and a number; no `$`, `#`, quotes or
     spaces) for the Owner, who is created anew.
  5. `sudo -iu axiomatic bash -lc 'cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh --first-run'`,
     sign in, delete the `BOOTSTRAP_OWNER_*` lines, re-upload and publish the installers, resume the Cron tasks.

  Check: Admin > Orders & payments and Admin > Customers are empty, and Admin > Reports > GST summary shows nothing
  before go-live.

### Business, tax and legal
- [ ] **Real company details and GSTIN on invoices.** Admin > Settings > Business: legal name, GSTIN (its first two
  digits match the state), address, city, state, PIN, phone; then turn "sample" off. Check: a new order's invoice PDF
  shows your legal name and GSTIN and no "not a valid tax invoice" note. Old invoices keep their snapshot, so do this
  before the first real sale.
- [ ] **GST settings confirmed by your CA.** Rate (18 %), SAC (997331), intra-state CGST/SGST vs inter-state IGST, the
  invoice and credit-note prefixes, and that e-invoicing (IRN/QR, not built) is not required at your turnover.
- [ ] **Legal text reviewed by counsel.** /legal/terms, /legal/privacy, /legal/refund and /legal/eula say "Sample -
  to be reviewed by counsel" and contain `[bracketed]` values. The text lives in the code (`content/legal`), so
  changes need a new deploy. Check: no `[` placeholders and no "Sample" label on any /legal page.
- [ ] **DPDP privacy notice details.** The privacy notice names the Data Fiduciary (your legal entity) and its
  contact, the grievance contact and how to reach it, what is collected and why, retention, the rights to access,
  correct and erase data and to nominate, how to withdraw consent, and the processors (Razorpay, the storage provider,
  the email provider, the server host). Check: counsel signs off; the privacy email in Settings is a mailbox someone
  reads; marketing opt-in stays unticked by default.
- [ ] **Support contacts are real.** Settings: support, sales, legal and privacy emails, phone and support hours.
  Check: send a message from /contact and a demo request; both the acknowledgement and the internal notification
  emails arrive.
- [ ] **Owner copy review done.** [`docs/owner-decisions.md` "Copy review"](owner-decisions.md#copy-review) lists the
  copy by area (it collects the "Owner copy review" notes of every phase in `docs/decisions.md`).
- [ ] **Owner decisions recorded.** Every item marked "Before live sales" in
  [`docs/owner-decisions.md`](owner-decisions.md#at-a-glance) (L6, P1, P2, P4, P5, T1-T8, S1, A1) has an answer
  recorded in `docs/decisions.md` with the date, and the builders have acted on it.
- [ ] **Assistive-technology pass.** NVDA + Chrome and VoiceOver on iOS through the guest purchase, sign-in with
  two-step, the license key reveal and an admin refund with its reason dialog; the storefront, portal and admin in a
  real Windows contrast theme (`docs/accessibility.md` "Known limitations"). Check: findings fixed or recorded there.

### Catalog and downloads
- [ ] **Real products, prices and installers.** The bootstrap created the SAMPLE catalog. Admin > Products and Admin >
  Plans & pricing: edit each real product's content and prices, hide or archive anything you do not sell. Admin >
  Releases: upload the real, code-signed installers and publish. Check: /software and /pricing show only real
  products at the right prices (excl. and incl. GST); each product page shows a published release; a purchase
  downloads the real installer and its SHA-256 (shown in Admin > Releases) matches the file you built.
- [ ] **The sample notice is off.** Admin > Content & FAQs (or Settings) > Sample notice off. Check: no strip on the
  home page.
- [ ] **Activation token decision made before any app ships.** `docs/decisions.md` Phase 4 and
  [`docs/owner-decisions.md` L1](owner-decisions.md#l1-fingerprint-hash-in-activation-tokens): sign a fingerprint hash
  instead of the raw fingerprint. Check: decision recorded; the apps embed the production public key
  (`LICENSE_SIGNING_PUBLIC_KEY` from `shared/.env.production`), not a development key.

### Payments
- [ ] **Razorpay account activated for live payments** (KYC, website and business details approved).
- [ ] **Live keys and a live webhook.** In Live Mode: generate API keys; Account & Settings > Webhooks > add
  `https://<domain>/api/webhooks/payments/razorpay` with events `payment.captured`, `payment.failed`,
  `refund.processed`, `refund.failed`, `order.paid` and a NEW secret (`openssl rand -hex 24`). Save the live Key ID
  (`rzp_live_...`), the live Key secret and the new webhook secret in Admin > Settings > Integrations > Payment
  provider (Replace each secret, then Save with your password); no restart. Check: the card shows **Live mode**, "Test
  Razorpay keys" says the keys were accepted, the Admin "Test mode" pill is gone, and the smoke test still passes.
  Unpaid test orders start a fresh payment attempt; payments taken with the test keys are refunded in the Razorpay
  Dashboard if ever needed (Admin answers `provider_key_changed`).
- [ ] **Automatic capture in Live Mode too.** Razorpay Account & Settings: payment capture is automatic (otherwise
  payments stay "authorized" and orders never complete).
- [ ] **One real purchase and refund.** Buy the cheapest plan with your own card or UPI, check the invoice, then refund
  it from Admin > Orders & payments. Check: Razorpay shows the refund; the order reads Refunded; a credit-note number
  exists.

### Email deliverability
- [ ] **SPF, DKIM and DMARC for the sending domain.** DNS has the provider's SPF include (one SPF record only), its DKIM
  records, and `_dmarc.<domain>` (start with `v=DMARC1; p=none; rua=mailto:<you>`; move to `quarantine` once reports
  are clean). Check: `nslookup -type=txt <domain>` and `nslookup -type=txt _dmarc.<domain>`; send a code to a Gmail
  address, open "Show original": SPF, DKIM and DMARC all PASS.
- [ ] **Out of the sandbox.** Amazon SES: production access granted for ap-south-1 (the sandbox only sends to verified
  addresses). Other providers: the domain shows as verified and the sending limits fit your volume.
- [ ] **Owner and Finance use two-step sign-in.** Before live sales, once SMTP works (the items above), the Owner and
  every Finance staff member turn two-step on in Admin > My profile (account menu, top right > My profile >
  Two-step verification). It is optional for every account and nothing turns it on for them (decisions.md
  2026-10-08). Check: sign out and back in; the 6-digit code arrives by email, and Admin > Staff & roles shows "On" in
  the 2-step column for each of them.

### Operations
- [ ] **HSTS covers every subdomain.** Only once every name under the domain serves HTTPS (`www`, mail and panel
  names included): `SECURITY_HSTS_STRICT=1` in `shared/.env.production`, then run `deploy.sh` again with the same
  source (security headers are fixed when the app is built). Check:
  `curl -sI https://<domain>/ | grep -i strict-transport-security` shows `max-age=31536000; includeSubDomains; preload`.
  Submit the domain to the browser preload list only after that, and only if you are sure: leaving it takes months.
- [ ] **Backups verified with a restore.** Restore the newest dump into a scratch database (step 12.4, "Test a
  restore") and compare the order, license and invoice counts with production. Copy dumps off the server at least
  weekly (another bucket, provider or your PC), keep at least 14 days, and keep `shared/.env.production` in the
  password manager.
- [ ] **Monitoring and alerts.** An external uptime check (e.g. UptimeRobot, Better Stack) on
  `https://<domain>/api/health` every 1-5 minutes, alerting your phone; an SSL-expiry alert; aaPanel alerts for disk
  above 80 % and high memory; failed aaPanel Cron runs and Razorpay webhook failure emails go to a mailbox you read.
  Check: `sudo -iu axiomatic pm2 stop axiomatic` for 5 minutes and confirm the alert arrives; then
  `sudo -iu axiomatic pm2 start axiomatic`.
- [ ] **Log size is bounded.** pm2-logrotate is installed and configured (step 5); aaPanel log cutting is on for the
  site's Nginx logs. Check after a week: `du -sh /www/wwwroot/axiomatic/shared/logs /home/axiomatic/.pm2/logs /www/wwwlogs`
  stays small.
- [ ] **Server hardening.** SSH with keys only (password login off), automatic security updates
  (`unattended-upgrades` on Ubuntu/Debian), aaPanel, Node.js 24, PostgreSQL and Redis kept up to date (after a Node.js
  update: repeat the PM2 and `/usr/local/bin` block of step 1, then `deploy/restart.sh --recreate` and the
  `pm2 startup` line of step 5), a second Owner (or
  Administrator) staff account so one lost mailbox cannot lock you out.
- [ ] **Capacity.** One small VPS is fine for launch, not for the 25 lakh license target. Before large customers ship
  apps, read `docs/scaling.md` (managed Postgres and Redis, more app processes, a CDN for downloads). More app
  processes on this server: `AXS_INSTANCES=2` (or more) in `/www/wwwroot/axiomatic/shared/deploy.env`, then
  `sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/restart.sh --recreate` (PM2 cluster mode; each
  process needs about 300-500 MB). Keep processes x `DATABASE_POOL_MAX` (10) well below PostgreSQL's `max_connections`
  (100 by default).

### Phase 7 items still open
- [ ] **End-to-end tests in CI.** The Playwright suite exists (`pnpm e2e`, `tests/e2e`, 2026-10-08) and runs by hand
  against a development server, like `scripts/check-*.mjs`; nothing runs them automatically yet.
- [ ] **Load test of the device API at about 1,000 requests/second** on production-like servers
  (`docs/scaling.md` "Phase 7: what to measure"; never against the live site during business hours).
- [x] **CSP nonces** instead of `'unsafe-inline'` for scripts: done 2026-10-08 on the portal, admin, checkout, order
  and auth pages (`middleware.ts`, `docs/security.md`); the prerendered storefront keeps the static policy (S4 in
  `docs/owner-decisions.md`). Verified by tests/unit/security-csp.test.ts and the smoke test's "Strict CSP" rows.
- [x] **Scheduled clean-up jobs**: done 2026-10-08. The daily maintenance job (`/api/cron/maintenance`, aaPanel task
  `axiomatic-maintenance` running `deploy/cron-maintenance.sh`) closes resolved tickets after 14 days, deletes stale
  pending uploads, empties sent emails older than 30 days and purges expired housekeeping rows. Verified by the
  `tests/unit/jobs-*` and `tests/db/jobs-*` tests. On the server, check its task log shows `cron maintenance ok` lines.
- [ ] **Database indexes for scale** (`docs/performance.md` "Proposed changes", `docs/decisions.md` Phase 7): the
  trigram, report-window and maintenance indexes migration. Not needed for the test release; apply before about
  10 lakh licenses.
- [ ] **Access-log hygiene for order links** (exchange the `?t=` token for a short-lived cookie), after which the
  proxy can keep a normal access log.

Check for each: the item is marked done in `docs/decisions.md` with the date and how it was verified.
