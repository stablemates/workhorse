#!/bin/sh

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

cd "$repository_root"
export BUNDLE_GEMFILE="$repository_root/deployment/kamal/Gemfile"
