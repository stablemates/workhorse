#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=kamal-env.sh
. "$repository_root/scripts/kamal-env.sh"

: "${DATABASE_URL_PRIMARY:?Export DATABASE_URL_PRIMARY before deploying}"
: "${DATABASE_URL_SECONDARY:?Export DATABASE_URL_SECONDARY before deploying}"

exec bundle exec kamal deploy --config-file config/deploy.yml "$@"
