#!/usr/bin/env bash
# Pull the latest code from GitHub into this checkout and release it.
#
# On the server, as the app user (not root), inside the git checkout:
#   cd /www/wwwroot/axiomaticsoftwaresolutions.com && ./scripts/deploy.sh   # latest main
#   ./scripts/deploy.sh --ref v1.2.0                                     # a tag or another branch
#   ./scripts/deploy.sh --first-run                                      # first deploy: also bootstraps catalog + owner
# Any other option is passed to deploy/deploy.sh (e.g. --skip-backup). Releases, the shared .env.production, logs and
# backups live in the runtime folder /www/wwwroot/axiomatic (deploy.sh default; --base to change), not in this checkout.
#
# The checkout must stay clean: releases are built from what is committed on GitHub, never from edits on the server.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd -P)"
REF="main"
PASS=()
while (($#)); do
  case "$1" in
    --ref)
      [[ $# -ge 2 ]] || { echo "--ref needs a branch or tag" >&2; exit 2; }
      REF="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      PASS+=("$1")
      shift
      ;;
  esac
done

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this as the app user, not root (e.g. sudo -iu axiomatic, then cd $REPO_DIR)." >&2
  exit 1
fi
git rev-parse --is-inside-work-tree > /dev/null 2>&1 || { echo "$REPO_DIR is not a git checkout." >&2; exit 1; }
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "This checkout has local changes. Commit them on your PC and push, or discard them here (git checkout -- .)." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

echo "==> Fetching from $(git remote get-url origin)"
git fetch --tags --prune origin

if git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
  if git show-ref --verify --quiet "refs/heads/$REF"; then
    git checkout -q "$REF"
  else
    git checkout -q -b "$REF" "origin/$REF"
  fi
  git merge -q --ff-only "origin/$REF" || {
    echo "Cannot fast-forward $REF to origin/$REF (the server checkout has diverged). Fix: git reset --hard origin/$REF" >&2
    exit 1
  }
elif git show-ref --verify --quiet "refs/tags/$REF"; then
  git checkout -q "tags/$REF"
else
  echo "No branch or tag named '$REF' on origin." >&2
  exit 1
fi

echo "==> Releasing $(git describe --tags --always) ($(git log -1 --format='%h %s'))"
exec bash "$REPO_DIR/deploy/deploy.sh" --source "$REPO_DIR" "${PASS[@]}"
