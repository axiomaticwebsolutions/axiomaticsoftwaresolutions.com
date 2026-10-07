#!/usr/bin/env bash
# aaPanel Cron task, every minute: sends due outbox emails (the safety net behind the after-commit send).
# Type Shell Script. aaPanel runs tasks as root, so the script content switches to the app user first:
#   runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/cron-emails.sh
# Never plain `bash ...` as root: this folder belongs to the app user (deploy/README.md "Privileges").
# Everything else (secret, lock, log line, exit status): deploy/cron-job.sh.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/cron-job.sh" emails
