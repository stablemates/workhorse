#!/bin/sh

set -eu

requirements_file=$(mktemp)
trap 'rm -f "$requirements_file"' EXIT

uv export \
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
