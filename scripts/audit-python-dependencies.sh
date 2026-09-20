#!/bin/sh

set -eu

requirements_file=$(mktemp)
trap 'rm -f "$requirements_file"' EXIT

# `--frozen` reads the committed lockfile without resolving, which is the set an audit is about.
# CI exports UV_LOCKED, and the pinned uv refuses `--frozen` together with the `--locked` that
# variable implies, so the variable is dropped for this one command. Freshness of the lockfile is
# still asserted: every other uv command in the same lane runs under UV_LOCKED.
env -u UV_LOCKED uv export \
  --project python \
  --frozen \
  --all-extras \
  --no-dev \
  --no-emit-project \
  --quiet \
  --output-file "$requirements_file"
uv run --project python pip-audit \
  --requirement "$requirements_file" \
  --no-deps \
  --disable-pip
