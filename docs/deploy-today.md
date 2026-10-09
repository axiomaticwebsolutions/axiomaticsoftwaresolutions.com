# Deploy today: test-mode release on your aaPanel server (no Docker)

> **The live server** (axiomaticsoftwaresolutions.com, aaPanel VPS shared with other apps) differs from this guide in several places: app user, port, database name, Redis, proxy and backup folder. For that server use [`server-runbook.md`](server-runbook.md); its commands already include the differences.

This guide puts the site on `https://<domain>` on your own Linux VPS, managed with aaPanel, with **Razorpay in TEST
mode**, real email (SMTP or the Amazon SES API) and real private file storage (an S3-compatible bucket). Nobody can
pay real money yet and the site keeps its "sample" labels. What must change before live sales is in
[`go-live-checklist.md`](go-live-checklist.md).

Everything runs natively: Node.js 24 + PM2, PostgreSQL and Redis come from the aaPanel App Store. There is no Docker.
Plan about 3 hours; most of it is waiting (DNS, your email provider verifying the domain, the first build).

**How to read this guide**
- `<domain>` is your domain without `https://`, e.g. `axiomaticsoftwaresolutions.com`. Replace every `<...>` value.
- "aaPanel Terminal" = aaPanel > Terminal (you are `root` on the server). "Windows PowerShell" = your own PC.
- Copy each grey block as a whole. Lines starting with `#` are comments.
- Never paste passwords, keys or the contents of `.env.production` into chat, email or a support ticket.

**What runs where**

```
Browser / desktop apps --https--> aaPanel Nginx :443 (Let's Encrypt) --http--> 127.0.0.1:3000  Next.js app (PM2 "axiomatic")
                                                                                 |-- PostgreSQL 127.0.0.1:5432 (aaPanel)
                                                                                 |-- Redis      127.0.0.1:6379 (aaPanel, password)
aaPanel Cron (as the app user) --http--> 127.0.0.1:3000/api/cron/emails (every minute), /reconcile (every 10 minutes), /renewals and /maintenance (daily)
aaPanel Cron (as the app user) --> pg_dump every night --> /www/backup/axiomatic (kept 14 days)
Razorpay --https--> https://<domain>/api/webhooks/payments/razorpay
Files: your private S3-compatible bucket (browsers upload and download straight to and from it). Email: your SMTP provider, or Amazon SES through its API.
```

Only Nginx faces the internet. The app listens on `127.0.0.1:3000`; PostgreSQL and Redis listen on `127.0.0.1` only.

**Folders on the server** (owned by the app user `axiomatic`; step 1 creates the user, step 3 the folders)

```
/www/wwwroot/axiomatic/
  releases/<UTC yyyymmddHHMMSS>/ one complete copy per deploy: code, node_modules, build (the newest 3 are kept)
  current -> releases/...       the release PM2 runs (a symlink, switched in one step after a good build)
  shared/.env.production        settings and secrets (mode 600), linked into every release
  shared/logs/                  app logs (app-out.log, app-error.log) and one log per deploy
  shared/backups/               database dumps taken before each deploy (7 days)
  shared/deploy.env             optional deploy settings, never secrets (e.g. AXS_INSTANCES)
/www/backup/axiomatic/          nightly database backups (14 days)
/www/wwwroot/axiomaticsoftwaresolutions.com/  the aaPanel site folder = the git checkout from GitHub (step 3);
                                each deploy copies it into a new release. Never holds secrets.
```

---

## 0. Before you start

### 0.1 Server
- **Size:** 2 vCPU and **4 GB RAM recommended**; 2 GB works with a swap file (the build is the memory peak).
  40 GB SSD or more, x86_64, Ubuntu 22.04/24.04 LTS or Debian 12. aaPanel is installed and you can log in.
- Check in the aaPanel Terminal:

  ```bash
  uname -m          # x86_64
  nproc; free -h    # CPUs, memory and swap
  df -h /           # at least 15 GB free
  cat /etc/os-release
  ```

- **Less than 4 GB RAM and no swap?** Add a 4 GB swap file (skip if `free -h` already shows swap):

  ```bash
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  free -h           # the Swap line now shows 4.0Gi
  ```

### 0.2 Domain and DNS
- At your DNS provider, create an **A record** for `<domain>` (host `@`) pointing at the server's public IPv4 address,
  and an A record for `www` pointing at the same IP (the site redirects `www` to `<domain>`).
- Delete any **AAAA** (IPv6) record unless your server really serves IPv6: Let's Encrypt and some visitors prefer
  IPv6, and a wrong AAAA record breaks the certificate and the site for them.
- On Cloudflare, set both records to **DNS only** (grey cloud). The orange-cloud proxy adds a second proxy in front
  of Nginx (the app would then need `TRUSTED_PROXY_HOPS=2` and more set-up).
- Check from Windows PowerShell (DNS can take from minutes to a few hours):

  ```powershell
  nslookup <domain>
  nslookup www.<domain>
  ```

### 0.3 Firewall
- **aaPanel > Security** (system firewall): allow TCP **80** and **443** and your SSH port. **Never** add 3000,
  5432 or 6379. If any of them is listed, delete the rule.
- **Your cloud provider's firewall / security group** (if it has one): 80 and 443 from anywhere; SSH and the aaPanel
  panel port **only from your own IP address**.
- **Keep the aaPanel panel private:** aaPanel > Settings: keep the random security entrance, turn on panel SSL and
  two-factor authentication, and set "Authorized IP" if your home or office IP is fixed.

### 0.4 Email (SMTP provider, or Amazon SES API)
The app sends verification and sign-in codes, password resets, order, license and invoice emails through SMTP or the
Amazon SES API. Two-step sign-in (an emailed code) is optional and starts **off** for the first Owner, so you can get
into Admin with the password even before email works; you turn it on once email works (step 11, item 3). Customers
still need email to verify their address, so set email up today. Pick one provider and verify your domain with it (it
gives you DNS records to add: SPF and DKIM). For SMTP use port **587** (STARTTLS, which the app requires in
production) or 465 (TLS).

| Provider | SMTP host | Port | Username | Password |
|---|---|---|---|---|
| Brevo | `smtp-relay.brevo.com` | 587 | your SMTP login (Settings > SMTP & API) | an SMTP key |
| Zoho ZeptoMail | `smtp.zeptomail.in` (India data centre; `smtp.zeptomail.com` otherwise) | 587 | `emailapikey` | the Send Mail token |
| Amazon SES, Mumbai | `email-smtp.ap-south-1.amazonaws.com` | 587 | SES SMTP username | SES SMTP password |

- **Brevo:** Senders, Domains & Dedicated IPs > Domains > add and authenticate your domain (DNS records); Settings >
  SMTP & API > generate an SMTP key.
- **Zoho ZeptoMail:** add a Mail Agent, add and verify your domain (SPF + DKIM TXT records), then SMTP > create a Send
  Mail token.
- **Amazon SES:** SES console (region Asia Pacific (Mumbai)) > Identities > Create identity > Domain, Easy DKIM; add
  the 3 CNAME records. SMTP settings > Create SMTP credentials (these are not your AWS access keys). A new account is
  in the **sandbox** and only sends to verified addresses: verify your own address(es) for today and request
  production access for real customers.
- **Amazon SES through its API (no SMTP)**, Admin's Provider "Amazon SES (API)": the same domain identity with Easy
  DKIM and the same sandbox rule, then IAM > Users > Create user (no console access) with an inline policy allowing
  only `ses:SendEmail` and `ses:SendRawEmail` on your domain's identity in that region (replace `<account-id>`, your
  12-digit AWS account ID, and `<domain>`):

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["ses:SendEmail", "ses:SendRawEmail"],
        "Resource": ["arn:aws:ses:ap-south-1:<account-id>:identity/<domain>"]
      }
    ]
  }
  ```

  While the account is in the sandbox, SES also checks the verified recipient: add
  `arn:aws:ses:ap-south-1:<account-id>:identity/<your verified address>` to `Resource` for the test and remove it
  after production access. If you use a configuration set, add
  `arn:aws:ses:ap-south-1:<account-id>:configuration-set/<name>` too. Then Security credentials > Create access key
  (use case "Application running outside AWS"). In Admin you enter the AWS region (`ap-south-1`, Mumbai), the access
  key ID, the secret access key, an optional configuration set, the From name and the From address. There is no host
  or port: the app talks to AWS's HTTPS endpoint for the region (outbound port 443), so the SMTP port check below does
  not apply.
- The sender (From address) must use the verified domain, e.g. `Axiomatic Software <no-reply@<domain>>`.
- Keep the SMTP or SES details (host, port, username and password, or region, access key ID and secret access key)
  and the From address in your password manager. You enter them in **Admin > Settings > Integrations > Email
  delivery** after the first sign-in (step 9), not in the server file. If Chrome then offers to save or suggest a
  password on those forms, choose "No thanks" (docs/go-live-checklist.md).
- Check that the server can reach the SMTP port (many hosts block port 25; 587 is usually open):

  ```bash
  timeout 5 bash -c '</dev/tcp/<smtp-host>/587' && echo "SMTP port reachable"
  ```

### 0.5 File storage (S3-compatible bucket, private)
Installers, ticket attachments and other private files live in a bucket. Browsers upload to it and download from it
with links that expire within 10 minutes; the bucket itself must never be public. Pick one provider:

**A) AWS S3, Mumbai (`ap-south-1`)**
1. S3 > Create bucket: name e.g. `axiomatic-files-<something-unique>` (lower case, no dots), region `ap-south-1`,
   Object Ownership "ACLs disabled", **Block all public access: on**, default encryption SSE-S3.
2. Bucket > Permissions > Cross-origin resource sharing (CORS) > Edit, paste (with your domain):

   ```json
   [
     {
       "AllowedOrigins": ["https://<domain>"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["content-type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```

3. IAM > Users > Create user `axiomatic-app` (no console access). Permissions > Add permissions > Create inline
   policy > JSON (replace `BUCKET` twice):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::BUCKET/*" },
       { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::BUCKET" }
     ]
   }
   ```

   (`ListBucket` only makes a missing file answer "not found" instead of "access denied".) Then Security credentials >
   Create access key > "Application running outside AWS". Keep the key ID and secret for step 9.
4. In Admin (step 9) choose the provider **AWS S3**: endpoint empty (or `https://s3.ap-south-1.amazonaws.com`), region
   `ap-south-1`, path-style URLs off.

**B) Cloudflare R2**
1. R2 > Create bucket (location hint Asia-Pacific). Leave public access **off**: no `r2.dev` URL, no custom domain.
2. Bucket > Settings > CORS policy > Add: the same JSON as in A) step 2.
3. R2 > Manage R2 API Tokens > Create API token: permission **Object Read & Write**, "Apply to specific buckets
   only" = this bucket. Keep the Access Key ID, Secret Access Key and the S3 endpoint it shows.
4. In Admin (step 9) choose **Cloudflare R2**: endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region
   `auto`, path-style URLs on.

**C) DigitalOcean Spaces, Bangalore (`blr1`)**
1. Spaces Object Storage > Create bucket in BLR1; file listing **restricted**; CDN off.
2. Bucket > Settings > CORS Configurations > Add: origin `https://<domain>`, methods PUT, GET, HEAD, allowed header
   `content-type`, max age 3000.
3. API > Spaces Keys > create a key with **limited access** (read/write/delete) to this bucket only.
4. In Admin (step 9) choose **DigitalOcean Spaces**: endpoint `https://blr1.digitaloceanspaces.com`, region `blr1`,
   path-style URLs off.

You enter the bucket in **Admin > Settings > Integrations > Installer storage** (step 9). The site's
Content-Security-Policy follows the saved bucket at runtime: no deploy or restart is needed when you change it later.
The Settings page reloads itself after a storage change; other browser tabs opened before it need a reload.

### 0.6 Razorpay TEST keys
1. Razorpay Dashboard > switch to **Test Mode** (top bar).
2. Account & Settings > API Keys > Generate Test Key. Copy the **Key Id** (`rzp_test_...`) and the **Key Secret**
   (shown once) into your password manager.
3. Account & Settings > Payment capture: **automatic** (the default for new accounts). With manual capture, payments
   stay "authorized" and orders never complete.
4. Choose a webhook secret (at least 16 characters, e.g. `openssl rand -hex 24`) and keep it in your password manager.
   You enter the Key Id, the Key Secret and this webhook secret in **Admin > Settings > Integrations > Payment
   provider** (step 9) and the same webhook secret in Razorpay (step 8).

### 0.7 On your Windows PC
- The project folder (`E:\Developer\Axiomatc Web Solutions Pvt. Ltd\Axiomatic Software Solutions\axiomaticsoftwaresolutions.com`)
  and Node.js 20.19 or newer (`node -v`), for the smoke test in step 10.
- Access to the GitHub repository `axiomaticwebsolutions/axiomaticsoftwaresolutions.com` (to add the deploy key in
  step 3).
- A password manager. Everything secret in this guide goes there and nowhere else.


---

## 1. Install the server software (aaPanel App Store) and the app user
Wait for each install to finish (aaPanel > Message box, top right) before starting the next.

1. **Node.js 24.** App Store > search "Node.js" > install **Node.js version manager**. Open it, install the newest
   **v24.x**, and set it as the **command-line version** (the "CLI version" / "Command line version" switch).
2. **PostgreSQL.** App Store > **PostgreSQL Manager** > install version **17** (16 also works; never below 14).
   In its settings, set the administrator (`postgres`) password and keep it in your password manager.
3. **Redis.** App Store > **Redis** > install the newest version offered (7.x).
4. Do **not** create a "Node project" under aaPanel > Website for this app: PM2 runs it (step 5), and a second copy
   would fight over port 3000.

Then, in the aaPanel Terminal, install PM2 and make Node.js, PM2 and corepack available to every user (the app runs
as its own user, not as root):

```bash
node -v                                   # v24.x.x
npm install -g pm2                        # process manager that keeps the app running
NODE_BIN="$(dirname "$(readlink -f "$(command -v node)")")"; echo "$NODE_BIN"
for b in node npm npx corepack pm2; do [ -e "$NODE_BIN/$b" ] && ln -sf "$NODE_BIN/$b" "/usr/local/bin/$b"; done
pm2 -v
```

If `node -v` prints nothing or an old version, open the Node.js version manager again, set v24 as the command-line
version, open a new Terminal tab and repeat. (After you ever switch Node.js versions in aaPanel, run the last block
again so `/usr/local/bin` points at the new version; once the app is deployed, then also run
`sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/restart.sh --recreate` and the `pm2 startup` line of
step 5 again.)

**The app user.** The app, its files and PM2 belong to a normal user called `axiomatic`; the deploy scripts refuse to
run as root (a root PM2 would start a second copy of the app). Create it and check that it sees the tools:

```bash
id axiomatic >/dev/null 2>&1 || useradd --create-home --shell /bin/bash axiomatic
command -v sudo >/dev/null || apt-get install -y sudo
sudo -iu axiomatic bash -lc 'node -v && pm2 -v && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@11.0.8 --version'
# v24.x.x, a PM2 version, and 11.0.8 (the pnpm version the project pins; downloaded on first use)
```

If the last line fails with "Cannot find matching keyid", run `npm install -g corepack@latest`, repeat the
`ln -sf` block, and try again. Everywhere in this guide, `sudo -iu axiomatic <command>` (or, in Cron tasks,
`runuser -u axiomatic -- <command>`) means "run it as the app user"; everything else runs as root. **Root never runs
a script from `/www/wwwroot/axiomatic`** once the app has run: those files belong to the app user, so anything that
took over the app could change them (deploy/README.md "Privileges"). The only exception is `db-setup.sh` in step
4.3, before the first deploy. Do not add `axiomatic` to the `sudo` group.

---

## 2. PostgreSQL database and Redis (local only)
The database is called `axiomatic` and so is its role (the names in `deploy/.env.production.example`). The role's
password is generated in step 4 and given to PostgreSQL there by `deploy/db-setup.sh`, so you never type it.

### 2.1 Create the role and the UTF-8 database
The database **must** be UTF-8 (prices use the rupee sign) with the `C` collation, created from `template0`. The
role needs `LOGIN` and nothing else (no superuser, no `CREATEDB`: production migrations need no shadow database).

```bash
PSQL=/www/server/pgsql/bin/psql; [ -x "$PSQL" ] || PSQL="$(command -v psql)"; echo "$PSQL"
"$PSQL" -U postgres -h 127.0.0.1 -d postgres      # type the postgres administrator password from step 1
```

If that is refused (wrong password, or "no pg_hba.conf entry"), use the system account instead:
`sudo -u postgres "$PSQL" -d postgres` (on a non-aaPanel PostgreSQL: `sudo -u postgres psql -d postgres`).
At the `postgres=#` prompt paste:

```sql
CREATE ROLE axiomatic LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE axiomatic OWNER axiomatic ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
\l axiomatic
SHOW listen_addresses;
\q
```

- `\l axiomatic` must show Owner `axiomatic`, Encoding `UTF8`, Collate `C`, Ctype `C`.
- `listen_addresses` must be `localhost` (or `127.0.0.1`). If it shows `*` or `0.0.0.0`: aaPanel > App Store >
  PostgreSQL Manager > Settings > Config file (usually `/www/server/pgsql/data/postgresql.conf`), set
  `listen_addresses = 'localhost'`, save, restart PostgreSQL from the same window.

Check that nothing outside the server can reach it:

```bash
ss -tlnp | grep ':5432'     # only 127.0.0.1:5432 (and/or [::1]:5432); never 0.0.0.0:5432 or *:5432
```

Port 5432 must not be listed in aaPanel > Security either.

### 2.2 Redis on localhost
aaPanel > App Store > Redis > Settings > **Config file** (or Performance tuning): make sure these lines read

```
bind 127.0.0.1
protected-mode yes
```

Save and restart Redis (Settings > Service > Restart). The password (`requirepass`) is set in step 4.3, once the
settings file has generated it. Check:

```bash
ss -tlnp | grep ':6379'     # only 127.0.0.1:6379
```

### 2.3 PostgreSQL memory and planner settings
PostgreSQL's stock settings are sized for a tiny machine: the portal and admin pages of a large account then spill to
disk (measured in `docs/performance.md`: the portal devices page 257 ms -> 22 ms, the overview 105 ms -> 14 ms). Open
`"$PSQL" -U postgres -h 127.0.0.1 -d postgres` again (as in 2.1) and paste:

```sql
ALTER SYSTEM SET shared_buffers = '1GB';          -- '2GB' when the server has 8 GB of RAM or more
ALTER SYSTEM SET effective_cache_size = '2GB';
ALTER SYSTEM SET work_mem = '16MB';
ALTER SYSTEM SET maintenance_work_mem = '256MB';
ALTER SYSTEM SET random_page_cost = 1.1;          -- SSD / NVMe storage
\q
```

Then restart PostgreSQL (aaPanel > App Store > PostgreSQL Manager > Service > Restart; `shared_buffers` needs a
restart). `ALTER SYSTEM` writes `postgresql.auto.conf`, which wins over `postgresql.conf` and aaPanel's
performance-tuning form. Check: `"$PSQL" -U postgres -h 127.0.0.1 -d postgres -c 'SHOW shared_buffers' -c 'SHOW work_mem'`.

---

## 3. Get the code from GitHub
The code lives in the private repository **`axiomaticwebsolutions/axiomaticsoftwaresolutions.com`**. The server keeps
a git checkout in the site folder **`/www/wwwroot/axiomaticsoftwaresolutions.com`** and pulls every release from
GitHub with a read-only **deploy key**. The running app and its settings live separately in
**`/www/wwwroot/axiomatic`** (releases, `current`, `shared/.env.production`, logs), so pulling new code never touches
the live site until `./scripts/deploy.sh` has built and checked the new release.

1. **Create the site in aaPanel first** (skip if it exists): Website > Add site > Domain
   `axiomaticsoftwaresolutions.com` (add `www.axiomaticsoftwaresolutions.com` on the next line), Database: **No**,
   PHP version: **Static** (pure static). Leave SSL and the reverse proxy for step 6. aaPanel creates
   `/www/wwwroot/axiomaticsoftwaresolutions.com` with a few files of its own (`.user.ini`, `index.html`, `404.html`);
   they stay where they are and git ignores them.
2. **Folders and ownership** (aaPanel Terminal, as root):

   ```bash
   mkdir -p /www/wwwroot/axiomatic/shared
   chown -R axiomatic: /www/wwwroot/axiomatic && chmod 750 /www/wwwroot/axiomatic
   install -d -m 700 -o axiomatic -g axiomatic /www/backup/axiomatic     # nightly backups, written by the app user
   chown axiomatic:axiomatic /www/wwwroot/axiomaticsoftwaresolutions.com # the app user owns the checkout folder
   ```

3. **Deploy key** (read-only access to the private repository), as the app user:

   ```bash
   sudo -iu axiomatic bash -lc 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -t ed25519 -N "" -C "aaPanel deploy key" -f ~/.ssh/axiomatic_deploy && cat ~/.ssh/axiomatic_deploy.pub'
   ```

   Copy the printed line (it starts with `ssh-ed25519`). On GitHub open the repository > **Settings > Deploy keys >
   Add deploy key**: Title `aaPanel server`, paste the key, leave **Allow write access unticked**, then Add key.
   Tell SSH to use that key for GitHub and test it:

   ```bash
   sudo -iu axiomatic bash -lc 'printf "Host github.com\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/axiomatic_deploy\n  IdentitiesOnly yes\n" >> ~/.ssh/config && chmod 600 ~/.ssh/config'
   sudo -iu axiomatic ssh -T git@github.com
   ```

   The first time, SSH asks whether to trust GitHub's host key. Check that the fingerprint shown is
   `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU` (GitHub's ED25519 key, as listed on docs.github.com under
   "GitHub's SSH key fingerprints"), then type `yes`. Success looks like
   `Hi axiomaticwebsolutions/axiomaticsoftwaresolutions.com! You've successfully authenticated, but GitHub does not provide shell access.`
4. **Check out the code** into the site folder. `git clone` refuses a folder that already has files, so initialise
   it in place, as the app user:

   ```bash
   sudo -iu axiomatic bash -lc 'cd /www/wwwroot/axiomaticsoftwaresolutions.com && git init -q -b main && git remote add origin git@github.com:axiomaticwebsolutions/axiomaticsoftwaresolutions.com.git && git fetch origin && git checkout -t origin/main && git log -1 --oneline'
   ls /www/wwwroot/axiomaticsoftwaresolutions.com     # app  components  deploy  docs  lib  package.json  prisma  scripts ...
   ```

From now on, updating the site is one command as the app user (step 12.1):
`cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh`. It pulls `main` from GitHub (or a tag with
`--ref`) and runs `deploy/deploy.sh`. The checkout must stay as GitHub has it: the script refuses to run when tracked
files were edited on the server (change the code on your PC, push, then deploy).

---

## 4. The settings file `shared/.env.production`
One file holds every setting and secret of the site. It lives outside the releases and is linked into each one.

### 4.1 Generate it (once)
As the app user, so the file belongs to it (mode 600: only that user and root can read it):

```bash
sudo -iu axiomatic node /www/wwwroot/axiomaticsoftwaresolutions.com/scripts/gen-prod-env.mjs --out /www/wwwroot/axiomatic/shared/.env.production
```

It fills in fresh random values for the session, CSRF, order-link and cron secrets, the license key pepper and
encryption key, the Ed25519 license signing key pair, the first Owner's password and the PostgreSQL and Redis
passwords. It prints names, never values, and refuses to overwrite an existing file. Razorpay, email and storage are
not in it: you save them in Admin > Settings > Integrations (step 9); the file only carries a commented-out fallback.
**Never run it with `--force` once the site has issued a license:** new license secrets make every issued key
unverifiable.

### 4.2 Fill in the outside values
Open the file: aaPanel > Files > `/www/wwwroot/axiomatic/shared/` > `.env.production` > Edit (or
`nano /www/wwwroot/axiomatic/shared/.env.production`). Replace every value that still contains `CHANGE-ME`:

| Variable | Value | Where it comes from |
|---|---|---|
| `APP_URL` | `https://<domain>` | Your domain: https, no `www.`, no trailing slash |
| `BOOTSTRAP_OWNER_EMAIL` | your email address | The first Owner; it receives password resets (and sign-in codes once you turn two-step on), so use a mailbox you read |
| `BOOTSTRAP_OWNER_NAME` (optional) | `"Your Name"` | Remove the `#` in front to use it |

Leave every generated value, `TRUSTED_PROXY_HOPS=1` and `CATALOG_SOURCE=db` as they are, and leave the `PAYMENT_*`,
`STORAGE_*`, `EMAIL_*` and `SMTP_*` block commented out: what you save in Admin wins over it anyway, and production
starts without it (each integration shows "Not configured" until you save it). Wrap a value that contains spaces or
`#` in double quotes, and write a `$` inside a value as `\$` (or pick passwords without `$`). Then, in the aaPanel
Terminal:

```bash
F=/www/wwwroot/axiomatic/shared/.env.production
chown axiomatic: "$F" && chmod 600 "$F"
grep -iE '^[A-Z_]+=.*change-?me' "$F" | cut -d= -f1      # names still to fill in: must print nothing
stat -c '%a %U' "$F"                                       # 600 axiomatic
```

**Copy the whole file into your password manager now** (aaPanel > Files > Edit, select all). The license secrets in
it cannot be recreated: without them a restored database cannot verify any license key.

### 4.3 Give PostgreSQL and Redis their generated passwords
**PostgreSQL:** as root, this sets the `axiomatic` role's password to the one inside `DATABASE_URL` and checks the
database again (it never prints the password; safe to repeat). Root runs it only now, before the first deploy; any
later run (a new database password, a restore database) is as the app user with `--host 127.0.0.1 --superuser postgres`:

```bash
bash /www/wwwroot/axiomaticsoftwaresolutions.com/deploy/db-setup.sh
# ... database=axiomatic encoding=UTF8 collate=C ctype=C owner=axiomatic
# ... PostgreSQL is ready for DATABASE_URL (role axiomatic, database axiomatic).
```

If it says the peer login was refused, run it as
`bash /www/wwwroot/axiomaticsoftwaresolutions.com/deploy/db-setup.sh --host 127.0.0.1 --superuser postgres` and type the
`postgres` administrator password. A `WARNING` about `listen_addresses` means step 2.1 is not done yet.

**Redis:** show the generated Redis password (the part of `REDIS_URL` between `:` and `@`), copy it, then clear the
screen:

```bash
sed -n 's#^REDIS_URL=redis://:\([^@]*\)@.*#\1#p' /www/wwwroot/axiomatic/shared/.env.production
clear
```

aaPanel > App Store > Redis > Settings > Performance tuning (or Config file): set **requirepass** to that value (the
config line reads `requirepass <password>`), save, restart Redis. Check:

```bash
REDIS_CLI=/www/server/redis/src/redis-cli; [ -x "$REDIS_CLI" ] || REDIS_CLI="$(command -v redis-cli)"
"$REDIS_CLI" -h 127.0.0.1 ping            # NOAUTH Authentication required.  (the password is on)
REDISCLI_AUTH="$(sed -n 's#^REDIS_URL=redis://:\([^@]*\)@.*#\1#p' /www/wwwroot/axiomatic/shared/.env.production)" "$REDIS_CLI" -h 127.0.0.1 ping
                                          # PONG  (the file's password works; nothing is printed)
```

The first deploy (step 5) then checks that the app really gets in with both passwords.

---

## 5. First deploy
`deploy/deploy.sh` does everything in order and stops at the first problem without touching the live site: preflight
(Node, PM2, disk, memory, the settings file) > copy the code into `releases/<UTC date-time>` > link
`shared/.env.production` > `pnpm install --frozen-lockfile` > Prisma client > check every setting, PostgreSQL (UTF-8)
and Redis > `prisma migrate deploy` > **(first run)** bootstrap the catalog, settings and the first Owner > `next build`
(it reads the catalog from the database, so it runs after the migration) > switch `current` > start PM2 > health check
> keep the newest 3 releases. If the new release fails the health check after the switch on a later deploy, the
script puts the previous release back by itself (see 12.1). Run it as the app user (it takes 5 to 15 minutes; the
build is the slow part):

```bash
sudo -iu axiomatic bash -lc 'cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh --first-run'
```

It ends with `DEPLOYED <release> in ...`. If it stops with `DEPLOY FAILED in step N/14`, read the lines above it and
the "What to do" line, fix that (usually a value in `shared/.env.production`), and run the same command again. The
full log is in `/www/wwwroot/axiomatic/shared/logs/deploy-<release>.log`.

Then, as root:

```bash
curl -fsS http://127.0.0.1:3000/api/health; echo                         # {"status":"ok"}
sudo -iu axiomatic pm2 status                                             # axiomatic: online
# Start PM2 (and the app) on every boot, as the axiomatic user:
env PATH="$(dirname "$(readlink -f "$(command -v node)")"):$PATH" pm2 startup systemd -u axiomatic --hp /home/axiomatic
systemctl is-enabled pm2-axiomatic                                        # enabled
# Rotate the app logs (20 MB per file, 14 files, compressed):
sudo -iu axiomatic pm2 install pm2-logrotate
sudo -iu axiomatic pm2 set pm2-logrotate:max_size 20M
sudo -iu axiomatic pm2 set pm2-logrotate:retain 14
sudo -iu axiomatic pm2 set pm2-logrotate:compress true
sudo -iu axiomatic pm2 save
```

(`deploy.sh` already ran `pm2 save`; the last line saves again after the log-rotation module was added.)

**The first Owner's password** was generated in step 4. Show it once, copy it into your password manager next to
`BOOTSTRAP_OWNER_EMAIL`, and clear the screen; you sign in with it in step 9 and then delete it from the file:

```bash
grep '^BOOTSTRAP_OWNER_PASSWORD=' /www/wwwroot/axiomatic/shared/.env.production | cut -d= -f2-
clear
```

The bootstrap created: the SAMPLE catalog (published products and plans, one **draft** release per product without
files), FAQs, email templates, settings (business details marked sample, the sample notice on), the document counters
and the Owner. It never creates customers, orders or licenses, and running it again only adds what is missing.

**Optional, on the server, before the website exists:** the smoke test (step 10) can already check the bare app:

```bash
cd /www/wwwroot/axiomatic/current && node scripts/smoke-prod.mjs --base http://127.0.0.1:3000 --allow-http --app-url https://<domain>
```

---

## 6. Website, SSL and reverse proxy (aaPanel)
Do this after step 5 shows a healthy app. Port 80 must be open and the DNS from step 0.2 must already resolve.

1. **aaPanel > Website > Add site**
   - Domain name: `<domain>` and, on a second line, `www.<domain>`.
   - Root directory: keep the default `/www/wwwroot/<domain>`. **Never** point it at `/www/wwwroot/axiomatic`.
   - FTP: none. Database: none (step 2 created it). PHP version: **Pure static**. Submit.
2. **SSL:** Website > `<domain>` (click the name) > **SSL** > Let's Encrypt > verification by **file**, tick both
   names > Apply. When the certificate shows, switch on **Force HTTPS**. Leave aaPanel's **HSTS** switch **off**: the
   app already sends HSTS and two copies confuse browsers.
3. **Reverse proxy:** same window > **Reverse proxy** > Add reverse proxy: proxy name `app`, proxy directory `/`,
   target URL `http://127.0.0.1:3000`, sent domain `$host`, **cache off**, no content replacement. Save.
4. **Replace the proxy rule with the project's version:** in the reverse proxy list, open the `app` rule's
   **Conf** / **Config file**, select everything, delete it, and paste the whole content of
   `deploy/aapanel-nginx.conf` (aaPanel > Files > `/www/wwwroot/axiomatic/current/deploy/aapanel-nginx.conf` > Edit,
   copy all). Save: aaPanel tests the configuration and reloads Nginx. Nothing in it needs editing. It:
   - forwards `Host`, `X-Real-IP`, `X-Forwarded-For` (`$proxy_add_x_forwarded_for`) and `X-Forwarded-Proto`, which is
     why `TRUSTED_PROXY_HOPS=1`;
   - turns proxy caching and buffering off, allows request bodies up to 12 MB, sends `www.<domain>` to `<domain>`;
   - answers 404 for `/api/cron/*` from the internet (the cron scripts call `127.0.0.1:3000` directly);
   - keeps Let's Encrypt renewals working and writes no access log for the app (order links carry a private token in
     the query string; the file explains how to keep a log without query strings instead).
   If aaPanel reports a duplicate `location` for `/.well-known/acme-challenge/`, delete those four lines from the
   pasted text (the comment in the file says so) and save again. aaPanel writes this file again whenever you change
   the proxy in its form (or switch it off and on): paste the project's content again after any such change.
5. **Check** from Windows PowerShell:

   ```powershell
   curl.exe -sS https://<domain>/api/health                          # {"status":"ok"}
   curl.exe -sSI http://<domain>/ | Select-String "HTTP/|Location"     # 301 and Location: https://<domain>/
   curl.exe -sSI https://www.<domain>/ | Select-String "HTTP/|Location" # 301 and Location: https://<domain>/
   ```

   `502 Bad Gateway` means Nginx cannot reach the app: `sudo -iu axiomatic pm2 status` on the server (step 12.3).

---

## 7. Scheduled jobs and backups (aaPanel Cron)
The app needs four scheduled calls, and the database needs a nightly backup. The scripts read `CRON_SECRET` and the
database password from `shared/.env.production` themselves: **never paste a secret into the panel.**

aaPanel > **Cron** > Add task, once per row. Type of task: **Shell Script**; "Script content" is the one line shown.
aaPanel runs every task as root; `runuser -u axiomatic --` at the start of each line runs the script as the app user
instead. Never leave it out: root must not run files the app user can change (the scripts refuse to run as root).

| Name | Period | Script content |
|---|---|---|
| `axiomatic-emails` | N Minutes, 1 | `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-emails.sh` |
| `axiomatic-reconcile` | N Minutes, 10 | `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-reconcile.sh` |
| `axiomatic-renewals` | Daily, 04:00 (UTC clock) | `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-renewals.sh` |
| `axiomatic-backup` | Daily, 21:00 (UTC clock) | `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/backup.sh` |
| `axiomatic-maintenance` | Daily, 22:00 (UTC clock) | `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-maintenance.sh` |

- aaPanel Cron uses the server clock. `date` in the Terminal shows it; most VPS images run on UTC, where 04:00 is
  09:30 IST, 21:00 is 02:30 IST and 22:00 is 03:30 IST. If your server clock is IST, use 09:30, 02:30 and 03:30.
- The maintenance job (`/api/cron/maintenance`) tidies the database once a day, after the nightly backup: it closes
  support tickets resolved 14 days ago, deletes uploads that were never finished, empties the body and subject of
  sent emails after 30 days (and masks the address), and removes expired sign-in sessions, codes and rate-limit records, account activity older than two
  years and webhook delivery records older than 180 days. Renewal reminders stay in `axiomatic-renewals`.
- After saving, click **Execute** on each task once, then **Log**. The job scripts stay silent when there was nothing
  to do (every count 0), print `cron <job> ok ...` with counts when they did something, and `cron <job> FAILED http=... : <hint>`
  (exit status 1, marked failed in the panel) when they could not run: `http=401` means the running app has another
  `CRON_SECRET` than the file (`sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/restart.sh`), `http=000` that the app is down.
  The backup task prints `backup ok axiomatic-<date>.dump <size>`. A log line `do not run this as root` means the
  task's content lacks `runuser -u axiomatic --`; one about `/www/backup/axiomatic` means the folder from step 3.2 is
  missing. To see a line for every job run, test by hand:

  ```bash
  for job in emails reconcile renewals maintenance; do runuser -u axiomatic -- env AXS_CRON_VERBOSE=1 bash /www/wwwroot/axiomatic/current/deploy/cron-$job.sh; echo "exit $?"; done
  ```

  Each prints `cron <job> ok in 0s {...}` and `exit 0`.
- Backups go to `/www/backup/axiomatic` as `axiomatic-<date>.dump` (PostgreSQL custom format) and are deleted after
  14 days. They are on the same disk as the database, so also copy them off the server (step 12.4).
- Use the script rather than aaPanel's "Backup database" task type: it makes PostgreSQL custom-format dumps, keeps
  14 days, never deletes anything after a failed run, and is what the restore steps in step 12.4 expect.

---

## 8. Razorpay webhook (Test Mode)
Razorpay tells the site about payments through a webhook; licenses are issued only after it arrives (reconcile every
10 minutes is the safety net).

1. Take the webhook secret you chose in step 0.6 (item 4) from your password manager. The same value goes into Admin >
   Settings > Integrations > Payment provider > Webhook secret (step 9), which also shows the exact webhook URL.
2. Razorpay Dashboard, **Test Mode** on > Account & Settings > **Webhooks** > Add new webhook:
   - Webhook URL: `https://<domain>/api/webhooks/payments/razorpay`
   - Secret: paste the value from 1 (exactly; no spaces).
   - Alert email: a mailbox you read.
   - Active events: **`payment.captured`**, **`payment.failed`**, **`refund.processed`**, **`refund.failed`**,
     **`order.paid`**. Nothing else. `refund.failed` matters: when Razorpay cannot complete a refund, the order goes
     to "In review" in Admin > Orders & payments so you can issue the refund again; without that event the failure
     shows up only when the reconcile job checks refunds still pending after a day.
   - Create webhook.
3. Webhooks in Test Mode and Live Mode are separate. Before live sales you add a new one in Live Mode with a new secret
   (`go-live-checklist.md`).

Until the Razorpay keys and this secret are saved in Admin, the webhook answers 503 and Razorpay retries later, so no
event is lost. If you ever change the webhook secret, save the new one in Admin (Replace, then Save) and in Razorpay at
the same time; no restart is needed.

---

## 9. First sign-in, settings and installers
1. Open `https://<domain>/sign-in` and sign in with `BOOTSTRAP_OWNER_EMAIL` and `BOOTSTRAP_OWNER_PASSWORD` from step 4.
   No code is asked: two-step sign-in starts off for the first Owner, so this works even while SMTP is not set up
   yet. Turn it on later, once emails arrive (step 11, item 3). If a code is asked anyway, two-step is on for this
   account: the code arrives within a minute if SMTP works; no code? Check the spam folder, then step 12.3
   (`sudo -iu axiomatic pm2 logs axiomatic`, look for `email_` lines) and the SMTP values.
2. Remove the bootstrap lines (`BOOTSTRAP_OWNER_EMAIL`, `BOOTSTRAP_OWNER_PASSWORD` and `BOOTSTRAP_OWNER_NAME` if you
   used it) from the server. The account keeps its password and the app never reads these variables; a later
   bootstrap run would refuse an email line left without its password line:

   ```bash
   F=/www/wwwroot/axiomatic/shared/.env.production
   sed -i '/^BOOTSTRAP_OWNER_/d' "$F" && chown axiomatic: "$F" && chmod 600 "$F"
   grep -c '^BOOTSTRAP_OWNER_' "$F"     # 0
   ```

3. **Admin > Settings** (Owner only):
   - **Business:** company name, address, state, PIN, phone and the support / sales / legal / privacy emails (use
     mailboxes you read). Keep **sample** switched on today: invoices then say they are not valid tax invoices.
   - **Tax:** GST rate 18 %, SAC 997331, invoice prefix `AXS` and credit-note prefix `AXC` (1 to 3 characters; to be
     confirmed with your CA before live sales; the next numbers are read-only).
   - **Integrations** (each save asks for your password again; secrets are encrypted and never shown again, only
     "Set (ends 1a2b)"):
     - **Payment provider:** Key ID (`rzp_test_...`), Key secret (step 0.6) and the webhook secret (step 8) > Save >
       the card shows "Saved in Admin" and **Test mode** > **Test Razorpay keys** must say the keys were accepted.
     - **Installer storage:** pick the provider (it fills in endpoint, region and path style; check them against step
       0.5, item 4), then bucket, access key ID and secret access key > Save > **Test bucket**: upload, read and delete
       must each say OK.
     - **Email delivery:** Provider **SMTP**: SMTP host, port 587 with STARTTLS (or 465 with TLS), username, password;
       or Provider **Amazon SES (API)**: AWS region (`ap-south-1`), access key ID, secret access key, configuration set
       (optional). Then From name and From address on your verified domain (step 0.4) > Save > **Send test email**
       goes to your own address; check it arrived (and the spam folder). In the SES sandbox your own address must be
       a verified identity too.
     - **Rate limits** is read-only (Redis, set in the server file).
     A card that says "Not configured" names what is missing. Nothing needs a restart or a deploy.
4. **Admin > Releases:** the bootstrap created one **draft** release per product, without files. For each product
   you want to test: open the draft > upload the installer (any test build is fine today) > wait for the upload and
   the server's SHA-256 check > **Publish**. Customers can only download published releases.
   If the upload stops at once and the browser console (F12) shows a Content-Security-Policy `connect-src` error, the
   page was opened before the bucket was saved: reload it. Still blocked? Check the bucket, endpoint and path style in
   Admin > Settings > Integrations > Installer storage ("Test bucket"). A CORS error instead means the bucket's CORS
   rule (step 0.5) is missing `https://<domain>` or `PUT`.
5. **Admin > Content & FAQs:** the sample notice strip stays **on** for the test release.
6. Optional: Admin > Staff & roles > invite a second Owner or Administrator, so one lost mailbox cannot lock you out.

---

## 10. Smoke test
A read-only check of the live site from outside: certificate and redirects, DNS, health, every storefront page and
its security headers, sitemap and robots, sign-in gates, hidden development routes, no env or source files served,
cron routes closed, webhook signature check and the device API. It sends no personal data and changes nothing (apart
from one "invalid signature" webhook record and rate-limit counters).

Windows PowerShell:

```powershell
cd "E:\Developer\Axiomatc Web Solutions Pvt. Ltd\Axiomatic Software Solutions\axiomaticsoftwaresolutions.com"
node scripts/smoke-prod.mjs --base https://<domain>
$LASTEXITCODE        # 0 = no failures
```

It prints a table of PASS / FAIL / WARN / SKIP rows and ends with "Result: OK" or "Result: FAILED". Each FAIL row says
what to fix; `go-live-checklist.md` says how to check each item by hand. WARN rows are advice (for example an
AAAA record or a `www` name that does not redirect, or "payments are not configured yet" while the Razorpay keys are not
saved in Admin > Settings > Integrations). Run it again after every deploy.

The same script works on the server before the website exists (it skips TLS, DNS and www there):
`cd /www/wwwroot/axiomatic/current && node scripts/smoke-prod.mjs --base http://127.0.0.1:3000 --allow-http --app-url https://<domain>`.

---

## 11. Test purchase, license, invoice, email, download and activation
Use a private browser window and an email address that is **not** the Owner's (for example a Gmail address of yours).

1. **Buy:** `https://<domain>/software` > a product > a plan > Add to cart > Checkout. Enter the test email and
   billing details (a 10-digit mobile number, any valid Indian state and PIN; a GSTIN is optional) > Pay. The Razorpay window says **Test Mode**.
   - **UPI:** UPI ID `success@razorpay` (use `failure@razorpay` to see a failed payment).
   - **Card:** a domestic test card from Razorpay's "Test Card Details" page, any future expiry, any CVV; on the bank
     page choose **Success**.
2. **Order page:** it turns **Paid** within a few seconds (the webhook). The license key is shown **once**: copy it.
   If it stays "Confirming payment" for more than a minute, check Razorpay > Webhooks > your webhook > deliveries
   (response 200 expected) and `sudo -iu axiomatic pm2 logs axiomatic`.
3. **Emails:** the order confirmation and "license issued" emails arrive at the test address.
   - Email works, so turn on two-step sign-in for the Owner now: in Admin, open the account menu (your initials, top
     right) > **My profile** > switch **Two-step verification** on. Sign out and back in once: the 6-digit code must
     arrive by email. Finance staff do the same in their own My profile.
4. **Invoice:** download the invoice PDF from the order page: it has an `AXS/<FY>/0001`-style number and, while the
   business details are sample, says it is not a valid tax invoice.
5. **Download:** the order page (or the portal after verifying the email) offers the installer you published in
   step 9; the download starts straight from the bucket.
6. **Activation API:** in the aaPanel Terminal (or Git Bash on Windows), activate, validate and release a pretend device. The
   key's first three letters are the product code the API expects in `X-App-Id`:

   ```bash
   KEY='<license key from the order page>'
   BASE='https://<domain>/api/v1/licenses'
   APP="${KEY%%-*}"
   FP="$(printf 'smoke-test-device' | sha256sum | cut -d' ' -f1)"
   OUT="$(mktemp)"
   curl -sS -X POST "$BASE/activate" -H 'Content-Type: application/json' -H "X-App-Id: $APP" \
     -d "{\"licenseKey\":\"$KEY\",\"deviceFingerprint\":\"$FP\",\"deviceName\":\"Test PC\",\"os\":\"Test OS\",\"appVersion\":\"1.0.0\"}" \
     -o "$OUT" -w 'activate: HTTP %{http_code}\n'
   TOKEN="$(sed -n 's/.*"activationToken":"\([^"]*\)".*/\1/p' "$OUT")"
   curl -sS -X POST "$BASE/validate" -H 'Content-Type: application/json' -H "X-App-Id: $APP" \
     -d "{\"activationToken\":\"$TOKEN\",\"deviceFingerprint\":\"$FP\",\"appVersion\":\"1.0.0\"}" -o /dev/null -w 'validate: HTTP %{http_code}\n'
   curl -sS -X POST "$BASE/deactivate" -H 'Content-Type: application/json' -H "X-App-Id: $APP" \
     -d "{\"activationToken\":\"$TOKEN\",\"deviceFingerprint\":\"$FP\"}" -w '\ndeactivate: HTTP %{http_code}\n'
   rm -f "$OUT"; unset KEY TOKEN
   ```

   Expected: `activate: HTTP 200`, `validate: HTTP 200`, then `{"status":"deactivated","devicesUsed":0}` and
   `deactivate: HTTP 200`. Admin > Licenses shows the license and the device history. (A 404 `invalid_key` means the
   key was mistyped; 429 means wait a minute; the full API is in `docs/activation-api.md`.)
7. **Refund (optional today):** Admin > Orders & payments > the test order > Refund (Owner or Finance, with a reason
   and the typed order id). The license is revoked, a credit-note number is issued, and Razorpay's `refund.processed`
   webhook marks the order Refunded a little later (a `refund.failed` webhook instead puts it in "In review").

---

## 12. Later: updates, rollback, logs and backups

### 12.1 Deploy a new version
1. On your PC the new version is pushed to GitHub (`main`, or a version tag such as `v0.1.1`).
2. Nothing to upload: the server pulls it.
3. Deploy (no `--first-run`), as the app user:

   ```bash
   sudo -iu axiomatic bash -lc 'cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh'                  # latest main
   sudo -iu axiomatic bash -lc 'cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh --ref v0.1.1'     # a specific tag
   ```

   The live site keeps running while the new release installs and builds. Before migrating, the script dumps the
   database to `shared/backups/pre-deploy-<date>.dump` (kept 7 days). **Automatic rollback:** if the new release does
   not start or `/api/health` does not answer within 90 seconds after the switch, the script switches `current` back
   to the previous release, reloads PM2, checks health again and stops with `DEPLOY FAILED ... (exit 3)` and an
   `AUTOMATIC ROLLBACK` paragraph: the site then runs the previous version, the failed release stays on disk (marked
   "never passed the health check" by `rollback.sh --list`) and the database keeps the new migrations (12.2). Read
   the PM2 log lines printed above the rollback, fix the cause and deploy again. With one PM2 process the switch costs a few
   seconds of `502`; with `AXS_INSTANCES=2` in `/www/wwwroot/axiomatic/shared/deploy.env` (cluster mode, see
   `deploy/ecosystem.config.cjs`; switch with `deploy/restart.sh --recreate`) reloads have no gap, at the cost of
   more memory and database connections.
4. Run the smoke test again (step 10).
5. Only when your developer says the catalog copy in the code changed:
   `sudo -iu axiomatic bash -lc 'cd /www/wwwroot/axiomatic/current && NODE_ENV=production node --import tsx scripts/bootstrap-production.ts --update-catalog --dry-run'`,
   read the plan, then run it again without `--dry-run` (it overwrites admin edits to catalog copy and prices).

**Changed Razorpay, email or storage?** Save it in Admin > Settings > Integrations: it applies at once, no restart or
deploy (other PM2 processes follow within 30 seconds; after a storage change the Settings page reloads itself, other
open browser tabs need a reload). Changing the email provider, the SMTP server, the SES region or the storage
endpoint asks for the saved password or secret key again.
**Changed only a setting** in `shared/.env.production`? Restart instead of deploying:
`sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/restart.sh` (that includes the `STORAGE_*` fallback:
the bucket origin in the Content-Security-Policy is set at runtime). A change to `APP_URL` or `SECURITY_HSTS_STRICT`
needs a deploy (item 3 above; the same code is fine): the build bakes them into the pages and the security headers.

**Removing the release-day stand-ins** (`rzp_test_pending`, `smtp-pending.invalid`, `https://r2-pending.invalid` and
the other "pending" values): until real values are saved, those integrations show "Not configured" and the site says
payments are not available yet. Save the real values in Admin > Settings > Integrations (step 9; they win at once),
then delete every `PAYMENT_*`, `STORAGE_*` (except `DOWNLOAD_LINK_TTL_SECONDS`), `EMAIL_*`, `SMTP_*` and `SES_*` line from
`shared/.env.production` and run `restart.sh`. The cards then say "Saved in Admin"; if the Admin settings are removed
later, nothing falls back to stand-ins.

### 12.2 Roll back
`deploy.sh` already rolls back by itself when a new release fails its health check (12.1). Use this when a release
is healthy but misbehaves, to go back by hand:

```bash
sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/rollback.sh --list   # releases on disk (the newest 3)
sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/rollback.sh          # back to the previous healthy release
# or: ... rollback.sh --to <release name from the list>
```

Rollback switches the **code** only. Database migrations are forward-only: the older code keeps working when the newer
migrations only added things, which is how this project writes them. If a newer migration removed or renamed
something, also restore that deploy's `pre-deploy` dump (12.4) and talk to your developer before deploying again.

### 12.3 Logs
| What | Where |
|---|---|
| App status, restarts, memory | `sudo -iu axiomatic pm2 status` (live view: `sudo -iu axiomatic pm2 monit`) |
| App log | `sudo -iu axiomatic pm2 logs axiomatic --lines 200` (errors only: add `--err`); files `/www/wwwroot/axiomatic/shared/logs/app-out.log` and `app-error.log`, rotated by pm2-logrotate |
| Each deploy | `/www/wwwroot/axiomatic/shared/logs/deploy-<release>.log` (kept 30 days) |
| Scheduled jobs | aaPanel > Cron > the task > Log |
| Backups | the backup task's Log, and `/www/backup/axiomatic/backup.log` |
| Nginx | `/www/wwwlogs/<domain>.error.log` (requests to the app are not access-logged on purpose: order links carry a token; requests that hit a restart's 502 seconds are in the error log, query string included) |

The app's log lines are JSON with an event name (`email_sent`, `health_check_failed`, ...) and never contain
passwords, license keys or tokens.

### 12.4 Backups and restore
- **Nightly:** `/www/backup/axiomatic/axiomatic-<UTC date-time>.dump` (aaPanel Cron task, kept 14 days). **Before each
  deploy:** `/www/wwwroot/axiomatic/shared/backups/pre-deploy-<UTC date-time>.dump` (kept 7 days). Both are
  PostgreSQL custom-format dumps that were read back once to prove they are complete.
- **Back up now / list:** `sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/backup.sh` and
  `sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/backup.sh list` (always as the app user; it refuses
  root).
- **Copy off the server** at least weekly: aaPanel > Files > `/www/backup/axiomatic` > download the newest dump to your
  PC (or sync the folder to a second bucket). A backup on the same disk does not survive the loss of the server. Keep
  the `shared/.env.production` copy in your password manager: a dump without its license secrets is of little use.

**Test a restore** (the live database is not touched; do it once now and then monthly):

```bash
# empty UTF-8 scratch database (asks for the postgres administrator password):
sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/db-setup.sh --db axiomatic_restore --host 127.0.0.1 --superuser postgres
sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/backup.sh list
sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/backup.sh restore <axiomatic-....dump> --yes --into axiomatic_restore
PSQL=/www/server/pgsql/bin/psql; [ -x "$PSQL" ] || PSQL="$(command -v psql)"
for db in axiomatic axiomatic_restore; do
  "$PSQL" -U postgres -h 127.0.0.1 -d "$db" -At -c "SELECT current_database(), (SELECT count(*) FROM \"Order\") AS orders, (SELECT count(*) FROM \"License\") AS licenses, (SELECT count(*) FROM \"Invoice\") AS invoices;"
done                                                    # the counts match (or the live one is a little higher)
"$PSQL" -U postgres -h 127.0.0.1 -d postgres -c "DROP DATABASE axiomatic_restore;"
```

(`db-setup.sh` and each `psql` line ask for the `postgres` administrator password.)

**Restore into the live database** (everything written after the dump is lost):
1. aaPanel > Cron: stop (pause) the five `axiomatic-*` tasks.
2. `sudo -iu axiomatic pm2 stop axiomatic` (the site shows 502 until item 5).
3. `sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/backup.sh list`, then
   `sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/backup.sh restore <file> --yes` (it refuses while
   the app still answers).
   For a pre-deploy dump give its full path: `/www/wwwroot/axiomatic/shared/backups/pre-deploy-....dump`.
4. If you restored a dump from before the current release's migrations, roll the code back to the matching release
   first (12.2) and ask your developer before the next deploy.
5. `sudo -iu axiomatic pm2 start axiomatic`, check `curl -fsS http://127.0.0.1:3000/api/health`, resume the Cron tasks,
   run the smoke test.

A gentler variant keeps the damaged database for inspection: restore `--into axiomatic_restore` (after
`db-setup.sh --db axiomatic_restore --host 127.0.0.1 --superuser postgres` as the app user), change the database name at the end of `DATABASE_URL` to `axiomatic_restore`,
and run `deploy/restart.sh` as the app user. Backups and cron follow `DATABASE_URL` automatically.

---

## 13. What is still SAMPLE (fix before live sales)
Today's release is a working shop in test mode. These parts are placeholders on purpose; the "Before live sales"
half of [`go-live-checklist.md`](go-live-checklist.md) lists each one with its check.

| Area | Today | Before live sales |
|---|---|---|
| Payments | Razorpay **TEST** keys and a Test Mode webhook: no real money moves | Live keys, a live webhook with a new secret, automatic capture, one real purchase and refund |
| Business details | Admin > Settings > Business is **sample**: invoices say they are not valid tax invoices | Real legal name, GSTIN, address; `sample` off; GST settings confirmed by your CA |
| Catalog | The bootstrap's SAMPLE products, plans, prices, FAQs and copy; test installers | Your real products, prices and code-signed installers; hide or archive the rest |
| Legal pages | Every /legal page says "Sample - to be reviewed by counsel" and has `[bracketed]` values (they live in the code, `content/legal`) | Counsel-reviewed text, DPDP privacy notice details; then deploy again |
| Sample notice | The strip on the home page is on | Admin > Content & FAQs > off |
| Data | Today's test orders, customers, licenses and invoice numbers (`AXS/<FY>/0001` ...) | A fresh database (checklist "Start live on clean data"), so real invoices start at 0001 |
| Email | Provider sandbox / new domain reputation | SPF, DKIM and DMARC pass; out of the SES sandbox |
| Apps | Activation API works; token format decision open (`docs/decisions.md` Phase 4) | Decision made; apps embed the production `LICENSE_SIGNING_PUBLIC_KEY` |
| Operations | Nightly backups on the same disk; no uptime alerts | Off-server backup copies, a tested restore, uptime and SSL alerts, SSH keys only |
| Phase 7 | Open: device-API load test, end-to-end tests in CI, the index migration, the order-link token in page URLs (access-log hygiene). Done: strict CSP nonces, the Playwright suite, the maintenance job | Done and recorded in `docs/decisions.md` |

---

## Troubleshooting

| Symptom | Where to look | Usual cause |
|---|---|---|
| `deploy.sh` stops with "DEPLOY FAILED in step N" | The lines above it and the "What to do" hint; the full log in `shared/logs/deploy-<release>.log` | A value in `shared/.env.production` (the message names the variable), PostgreSQL or Redis not running, no internet for `pnpm install`, too little memory for the build (add swap) |
| `deploy.sh` ends with "AUTOMATIC ROLLBACK" (exit 3) | The PM2 log lines printed above the rollback; `sudo -iu axiomatic pm2 logs axiomatic --lines 300`; `rollback.sh --list` | The new release could not start or reach PostgreSQL / Redis (a new required setting missing from `shared/.env.production`, out of memory). The previous release is live again; fix the cause and deploy again |
| `502 Bad Gateway` on the site | `sudo -iu axiomatic pm2 status`, then `sudo -iu axiomatic pm2 logs axiomatic --lines 200` | The app is stopped or crashing. An invalid setting ends it on its first request with "Invalid environment configuration" and the variable names; PM2 restarts it (the restart counter grows) and stops after 15 quick crashes ("errored"). Fix the named variable, then `restart.sh` |
| Signed-out links to `/account` or `/admin` open `https://localhost...` | `grep '^APP_URL=' /www/wwwroot/axiomatic/shared/.env.production` | `APP_URL` is not exactly `https://<domain>`: the sign-in redirect is built on it. Fix it, then `restart.sh` |
| `/api/health` answers 503 | `sudo -iu axiomatic pm2 logs axiomatic` (look for `health_check_failed`) | PostgreSQL or Redis stopped, or a wrong password in `DATABASE_URL` / `REDIS_URL` |
| No sign-in code by email | Spam folder; Admin > Settings > Integrations > Email delivery ("Send test email" names the failing step); `sudo -iu axiomatic pm2 logs axiomatic` lines with `email_` events; the provider's sending log | Email "Not configured"; SMTP host, port, security, user or password wrong; sender domain not verified; SES sandbox |
| Order stays "Confirming payment" | Razorpay > Webhooks > deliveries (503 = payments not saved in Admin yet; 401 = secret mismatch); aaPanel Cron > `axiomatic-reconcile` log | Webhook URL or secret wrong (Admin and Razorpay must hold the same one), events missing, manual capture on in Razorpay |
| Checkout says "Payments aren't switched on yet" | Admin > Settings > Integrations > Payment provider | Nothing usable saved: save the Razorpay keys and webhook secret, then "Test Razorpay keys" |
| Upload in Admin > Releases fails at once | Browser console (F12); Admin > Settings > Integrations > Installer storage ("Test bucket") | CORS rule on the bucket (origin `https://<domain>`, `PUT`), storage "Not configured", or a tab opened before the bucket was saved (reload; step 9) |
| Cron task log says `do not run this as root` | The task's script content | It must start with `runuser -u axiomatic --` (step 7) |
| Cron task log shows HTTP 401 | The task's Log | The running app was started before `CRON_SECRET` changed: `sudo -iu axiomatic bash /www/wwwroot/axiomatic/current/deploy/restart.sh` |
| Let's Encrypt fails | aaPanel's SSL error text | DNS not pointing at the server yet, port 80 closed, a wrong AAAA record |
