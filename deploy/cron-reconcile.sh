#!/usr/bin/env bash
# aaPanel Cron task, every 10 minutes: re-checks stuck payments and day-old pending refunds with Razorpay.
# Type Shell Script. aaPanel runs tasks as root, so the script content switches to the app user first:
#   runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-reconcile.sh
# Never plain `bash ...` as root: this folder belongs to the app user (deploy/README.md "Privileges").
# Everything else (secret, lock, log line, exit status): deploy/cron-job.sh.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/cron-job.sh" reconcile
