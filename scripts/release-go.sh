#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/release-go.sh X.Y.Z" >&2
  exit 1
fi

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(dirname -- "$script_directory")
cd "$repository_root"

require_clean_worktree() {
  message=$1
  if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git status --porcelain)" ]; then
    echo "$message" >&2
    exit 1
  fi
}

tag="go/v$1"
pnpm release:check go "$tag"

require_clean_worktree "Refusing to release from a dirty worktree."
if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists locally." >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  echo "$tag already exists on origin." >&2
  exit 1
fi

pnpm db:reset:test
pnpm db:reset:test-packed
pnpm check

require_clean_worktree "The release gate changed tracked files; review them before tagging."

git tag --annotate "$tag" --message "Release $tag"
git push origin "$tag"
