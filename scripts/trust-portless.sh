#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  portless trust
  exit 0
fi

ca_path="${HOME}/.portless/ca.pem"
system_ca_paths=(
  "/usr/local/share/ca-certificates/portless-ca.crt"
  "/etc/ca-certificates/trust-source/anchors/portless-ca.crt"
  "/etc/pki/ca-trust/source/anchors/portless-ca.crt"
  "/etc/pki/trust/anchors/portless-ca.crt"
)

os_trusted=false
for system_ca_path in "${system_ca_paths[@]}"; do
  if [[ -f "$system_ca_path" ]] && cmp -s "$ca_path" "$system_ca_path"; then
    os_trusted=true
    break
  fi
done

if [[ "$os_trusted" == false ]]; then
  portless trust
fi

if ! command -v certutil >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Portless is trusted by the Linux OS, but Chromium also needs the NSS certificate tools.
Install them, then run this command again:

  Ubuntu/Debian: sudo apt install libnss3-tools
  Fedora:        sudo dnf install nss-tools
  Arch:          sudo pacman -S nss
EOF
  exit 1
fi

nss_db="sql:${HOME}/.pki/nssdb"
mkdir -p "${HOME}/.pki/nssdb"

if [[ ! -f "${HOME}/.pki/nssdb/cert9.db" ]]; then
  certutil -N -d "$nss_db" --empty-password
fi

certutil -D -d "$nss_db" -n "portless Local CA" 2>/dev/null || true
certutil -A -d "$nss_db" -n "portless Local CA" -t "C,," -i "$ca_path"

echo "Portless CA trusted for Chromium. Fully restart the browser before opening a .localhost URL."
