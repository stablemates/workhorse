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

# Print the commit that a tag on origin points to, or nothing if origin has no such tag. An
# annotated tag names a tag object, so the peeled `^{}` line names its commit. A failed lookup
# exits the command substitution with 1, and each caller then stops.
remote_tag_commit() {
  if ! listing=$(git ls-remote origin "refs/tags/$1" "refs/tags/$1^{}"); then
    echo "Refusing to release: cannot read $1 from origin." >&2
    exit 1
  fi
  printf '%s\n' "$listing" | awk -v plain="refs/tags/$1" -v peeled="refs/tags/$1^{}" '
    $2 == peeled { peeled_commit = $1 }
    $2 == plain { plain_commit = $1 }
    END { print (peeled_commit != "" ? peeled_commit : plain_commit) }
  '
}

version=$1
tag="go/v$version"
# The Python tag spells a prerelease the PEP 440 way, so `X.Y.Z-rc.N` becomes `X.Y.ZrcN`.
python_version=$(printf '%s\n' "$version" | sed -E \
  -e 's/-(alpha|a)\.?([0-9]+)$/a\2/' \
  -e 's/-(beta|b)\.?([0-9]+)$/b\2/' \
  -e 's/-rc\.?([0-9]+)$/rc\1/')
case $python_version in
  *-*)
    echo "Refusing to release: $version has no PEP 440 spelling for the python/v tag." >&2
    exit 1
    ;;
esac

# The rehearsal stages the module from HEAD, so it runs only on a clean worktree.
require_clean_worktree "Refusing to release from a dirty worktree."

# Every tag of the release train points to the candidate commit, a commit on main. Other commits
# can land on main during the release, so HEAD must be that candidate, not the tip of main.
head_commit=$(git rev-parse HEAD)
if ! git fetch --quiet --no-tags origin "+refs/heads/main:refs/remotes/origin/main"; then
  echo "Refusing to release HEAD $head_commit: cannot fetch main from origin." >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$head_commit" refs/remotes/origin/main; then
  echo "Refusing to release: HEAD $head_commit is not an ancestor of origin/main." >&2
  exit 1
fi
for train_tag in "v$version" "python/v$python_version"; do
  tagged_commit=$(remote_tag_commit "$train_tag") || exit 1
  if [ -z "$tagged_commit" ]; then
    echo "Refusing to release: $train_tag does not exist on origin. The Go stage runs last." >&2
    exit 1
  fi
  if [ "$tagged_commit" != "$head_commit" ]; then
    echo "Refusing to release: $train_tag on origin points to $tagged_commit, not to HEAD $head_commit." >&2
    exit 1
  fi
done

if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
  echo "$tag already exists locally." >&2
  exit 1
fi
go_tag_commit=$(remote_tag_commit "$tag") || exit 1
if [ -n "$go_tag_commit" ]; then
  echo "$tag already exists on origin." >&2
  exit 1
fi

# Print `owner/repo` for the GitHub repository that origin names in the configuration, or nothing
# if origin is not one github.com URL or has another push URL. The script pushes the tag to origin,
# so the CI query must name the same repository. `GH_REPO` and the `{owner}/{repo}` placeholder of
# `gh` can name another one. Git pushes to every URL of a remote, so a second URL also stops reuse.
origin_github_repository() {
  url=$(git config --get-all remote.origin.url) || return 0
  push_urls=$(git config --get-all remote.origin.pushurl) || push_urls=$url
  if [ "$(printf '%s\n' "$url" | wc -l)" -ne 1 ] || [ "$push_urls" != "$url" ]; then
    return 0
  fi
  printf '%s\n' "$url" | sed -n -E \
    -e 's#^(https://|ssh://git@|git@)github\.com[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$#\2/\3#' \
    -e 't github' -e 'd' -e ':github' -e 's#\.git$##' -e 'p'
}

# Print the URL of a successful `CI` push run on main for the commit in the repository, or nothing
# if GitHub has no such run or cannot answer. A canceled, failed, or unfinished run is not success,
# because a maintainer can cancel a main run. `gh` prints one line per run, and awk checks each
# field, so a loose filter on the GitHub side cannot select another run.
successful_main_ci_run() {
  if [ -z "$2" ] || ! command -v gh >/dev/null 2>&1; then
    return 0
  fi
  if ! runs=$(gh api --hostname github.com --method GET "repos/$2/actions/workflows/ci.yml/runs" \
    -f head_sha="$1" -f branch=main -f event=push -f status=completed -f per_page=100 \
    --jq '.workflow_runs[] | [.head_sha, .head_branch, .event, .path, .status, .conclusion, .html_url] | @tsv' \
    2>/dev/null); then
    return 0
  fi
  printf '%s\n' "$runs" | awk -F '\t' -v commit="$1" -v runs="https://github.com/$2/actions/runs/" '
    $1 == commit && $2 == "main" && $3 == "push" && $4 == ".github/workflows/ci.yml" &&
      $5 == "completed" && $6 == "success" && index($7, runs) == 1 &&
      substr($7, length(runs) + 1) ~ /^[0-9]+$/ { print $7; exit }
  '
}

pnpm go:release-check "$version"

# ADR 0043 and ADR 0102 make the successful main CI push run of the candidate the release gate. That
# run executes every CI job, so the full local check repeats it. The script then runs only the Go
# checks. Without such a run, the script runs the full check.
ci_run=$(successful_main_ci_run "$head_commit" "$(origin_github_repository)")
if [ -n "$ci_run" ]; then
  echo "HEAD $head_commit passed the main CI run $ci_run. Running only the Go checks."
  pnpm db:reset:test
  pnpm go:test
  pnpm go:vuln
else
  echo "No successful main CI run for HEAD $head_commit. Running the full pnpm check."
  pnpm db:reset:test
  pnpm db:reset:test-packed
  pnpm check
fi

require_clean_worktree "The release gate changed tracked files; review them before tagging."

git tag --annotate "$tag" --message "Release $tag"
git push origin "$tag"
