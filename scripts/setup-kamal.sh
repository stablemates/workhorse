#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=kamal-env.sh
. "$repository_root/scripts/kamal-env.sh"

: "${DATABASE_URL_PRIMARY:?Export DATABASE_URL_PRIMARY before setup}"
: "${DATABASE_URL_SECONDARY:?Export DATABASE_URL_SECONDARY before setup}"

bundle exec kamal setup --config-file config/deploy.site.yml
bundle exec kamal setup --config-file config/deploy.yml
