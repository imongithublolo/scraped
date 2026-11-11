#!/usr/bin/env bash
# DAEMON → GitHub deploy (orphan branch force-push, the proven pipeline).
#
#   GITHUB_TOKEN=ghp_xxx ./scripts/deploy-github.sh
#
# Pushes the working tree to imongithublolo/scraped. The PRODUCTION branch
# is "main" (that's what Vercel deploys to https://murke-is.onthewifi.com/); "web" is also
# pushed as a preview mirror. Both are force-pushed orphan branches, then
# the resulting Vercel production deployment is verified via the API.
set -euo pipefail

: "${GITHUB_TOKEN:?set GITHUB_TOKEN (a classic PAT with repo scope)}"
REPO="${GITHUB_REPO:-imongithublolo/scraped}"
BRANCH="${GITHUB_BRANCH:-main}"
MIRROR_BRANCH="${GITHUB_MIRROR_BRANCH:-web}"
STAGE=/tmp/deploy-stage

rm -rf "$STAGE" && mkdir -p "$STAGE"
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude .next --exclude dev.log \
  --exclude server.log --exclude worklog.md --exclude agent-ctx --exclude skills \
  --exclude "*.db" --exclude db/ --exclude .env --exclude tool-results \
  --exclude wisp-dev.log --exclude .DS_Store \
  ./ "$STAGE/"

cd "$STAGE"
git init -q -b "$BRANCH"
git config user.email "deploy@daemon.local"
git config user.name "daemon deploy"
git add -A
git commit -q -m "murke os deploy ($(date -u +%Y-%m-%dT%H:%MZ))"
git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"
git push -q --force origin "$BRANCH"
SHA=$(git rev-parse HEAD)
echo "pushed $SHA → ${REPO}@${BRANCH}"

# preview mirror branch (same tree, force-pushed)
if [ -n "$MIRROR_BRANCH" ] && [ "$MIRROR_BRANCH" != "$BRANCH" ]; then
  git push -q --force origin "HEAD:${MIRROR_BRANCH}"
  echo "pushed $SHA → ${REPO}@${MIRROR_BRANCH} (preview mirror)"
fi

# wait for the VERCEL PRODUCTION deployment of $SHA and report its status
sleep 20
DEPLOY_ID=""
for _ in 1 2 3 4 5 6; do
  DEPLOY_ID=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    "https://api.github.com/repos/${REPO}/deployments?sha=${SHA}&per_page=10" \
    | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    prod=[x for x in d if x.get('environment')=='Production']
    print(prod[0]['id'] if prod else '')
except Exception:
    print('')
")
  [ -n "$DEPLOY_ID" ] && break
  sleep 15
done
if [ -n "$DEPLOY_ID" ]; then
  for _ in 1 2 3 4 5 6; do
    STATE=$(curl -s -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      "https://api.github.com/repos/${REPO}/deployments/${DEPLOY_ID}/statuses" \
      | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d[0]['state'] if d else 'pending')
except Exception:
    print('pending')
")
    echo "vercel production: $STATE"
    [ "$STATE" = "success" ] || [ "$STATE" = "failure" ] || [ "$STATE" = "error" ] && break
    sleep 20
  done
else
  echo "no production deployment seen yet for $SHA (check the Vercel dashboard)"
fi
