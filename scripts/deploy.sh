#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

"$repository_root/scripts/deploy-site.sh"
exec "$repository_root/scripts/deploy-demo.sh" "$@"
