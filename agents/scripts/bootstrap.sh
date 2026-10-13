#!/usr/bin/env bash
# One-time: create the workflow_depo repo on GitHub (private), push this tree,
# tag v1 for the reusable workflow, and print what to do about the token.
#   scripts/bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER="${OWNER:-$(gh api user -q .login)}"
if ! git rev-parse --git-dir >/dev/null 2>&1; then git init -q -b main; fi
git add -A && git -c commit.gpgsign=false commit -q -m "workflow_depo: initial" || true
if ! gh repo view "$OWNER/workflow_depo" >/dev/null 2>&1; then
  gh repo create "$OWNER/workflow_depo" --private --source=. --push
else
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "git@github.com:$OWNER/workflow_depo.git"
  git push -u origin main
fi
git tag -f v1 && git push -f origin v1
cat <<TXT

workflow_depo is at https://github.com/$OWNER/workflow_depo (private). Reusable workflow tagged v1.

Now create the token the sync job uses (Settings → Developer settings → Fine-grained tokens):
  Resource owner: $OWNER     Repository access: All repositories (or the ones you manage)
  Permissions:  Contents: Read and write   Pull requests: Read and write
                Workflows: Read and write  Metadata: Read   Administration: Read
  (Workflows:write is required to push .github/workflows/* into other repos.)
Then:  gh secret set WORKFLOW_DEPO_TOKEN -R $OWNER/workflow_depo

First run (report only):  gh workflow run distribute -R $OWNER/workflow_depo -f dry_run=true
Real run:                 gh workflow run distribute -R $OWNER/workflow_depo
State of affairs:         https://github.com/$OWNER/workflow_depo/blob/main/STATUS.md
TXT
