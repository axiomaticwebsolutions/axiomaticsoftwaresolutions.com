#!/usr/bin/env bash
# aaPanel Cron task, once a day (any time; 04:00 UTC = 09:30 IST suggested): automatic renewal reminders.
# Type Shell Script. aaPanel runs tasks as root, so the script content switches to the app user first:
#   runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-renewals.sh
# Never plain `bash ...` as root: this folder belongs to the app user (deploy/README.md "Privileges").
# Everything else (secret, lock, log line, exit status): deploy/cron-job.sh.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/cron-job.sh" renewals
