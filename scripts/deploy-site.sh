#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=kamal-env.sh
. "$repository_root/scripts/kamal-env.sh"

exec bundle exec kamal deploy --config-file config/deploy.site.yml "$@"
