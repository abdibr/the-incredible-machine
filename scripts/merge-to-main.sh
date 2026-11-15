#!/usr/bin/env bash
# merge-to-main.sh — release `develop` into `main`.
#
# main policy: main is the playable game ONLY. It carries no `*.md` files at all
# (no README, AGENTS, GLOSSARY, plans, ADRs, work-log...) and no `.scratch/` dev
# workspace — of any file type. All docs and scratch work live on `develop` and its
# feature branches. This script merges origin/develop into main and strips both.
#
# The script itself lives on develop (it's a doc/tool, so main doesn't have it).
# Because checking out main removes it from the worktree, run it via process
# substitution so bash keeps the file handle open:
#
#     git fetch origin
#     bash <(git show develop:scripts/merge-to-main.sh)
#
# Optional arg: the develop ref to release (default: origin/develop).
set -euo pipefail

DEV="${1:-origin/develop}"
cd "$(git rev-parse --show-toplevel)"
PREV_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

cleanup_return() {
  if [ "$PREV_BRANCH" != "main" ] && [ "$PREV_BRANCH" != "(detached)" ]; then
    git checkout "$PREV_BRANCH" 2>/dev/null || git checkout develop 2>/dev/null || true
  fi
}
trap cleanup_return EXIT

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: worktree is dirty — commit or stash before releasing." >&2
  exit 1
fi

git fetch origin

git checkout main
git reset --hard origin/main

echo "== merging $DEV into main =="
if ! git merge --no-commit --no-ff "$DEV"; then
  echo "merge has conflicts — markdown paths are auto-resolved below" >&2
fi

# main policy strips (resolved as deletions on the main side; -f also resolves
# modify/delete conflicts in favor of the delete):
#   - every tracked markdown file, anywhere in the tree
#   - the whole `.scratch/` dev workspace, any file type
git ls-files -z '*.md' | xargs -0 -r git rm -q -f --ignore-unmatch
git ls-files -z -- '.scratch' | xargs -0 -r git rm -q -f --ignore-unmatch

# fail loudly if anything non-markdown is still conflicted
CONFLICTS="$(git diff --name-only --diff-filter=U | grep -v '\.md$' || true)"
if [ -n "$CONFLICTS" ]; then
  echo "ERROR: non-markdown conflicts need human resolution; merge state left in place:" >&2
  echo "$CONFLICTS" >&2
  exit 1
fi

git commit --no-edit
git push origin main

echo "main updated: $(git rev-parse --short main)"
echo "verifying main is dev-doc-free:"
fail=0
for pat in '*.md' '.scratch'; do
  left="$(git ls-files -- "$pat")"
  if [ -n "$left" ]; then
    echo "ERROR: paths still tracked under '$pat':" >&2
    echo "$left" >&2
    fail=1
  fi
done
if [ "$fail" != 0 ]; then exit 1; fi
echo "  clean — no tracked *.md or .scratch on main."
