#!/usr/bin/env bash
# aaPanel Cron task, once a day after the backup (22:00 UTC = 03:30 IST suggested): housekeeping (closes tickets
# resolved 14 days ago, deletes abandoned uploads, redacts sent emails after 30 days, purges dead sessions, tokens and
# rate-limit buckets, activity older than 24 months and webhook deliveries older than 180 days).
# Type Shell Script. aaPanel runs tasks as root, so the script content switches to the app user first:
#   runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-maintenance.sh
# Never plain `bash ...` as root: this folder belongs to the app user (deploy/README.md "Privileges").
# Everything else (secret, lock, log line, exit status): deploy/cron-job.sh.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/cron-job.sh" maintenance
