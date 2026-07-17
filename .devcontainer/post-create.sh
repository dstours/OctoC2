#!/usr/bin/env bash
set -euo pipefail

echo ""
echo "Verifying toolchain..."
echo "   Bun : $(bun --version)"
echo "   Node: $(node --version)"
echo "   gh  : $(gh --version 2>&1 | head -1)"
echo ""

test "$(bun --version)" = "1.3.14"
test "$(node --version)" = "v22.14.0"

git config --local core.autocrlf false
git config --local core.eol lf

echo "[*] Installing exact monorepo dependencies..."
bun install --frozen-lockfile

echo "[*] Checking generated protobuf consumers..."
bun run proto:check

if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
  echo "[*] Generating SSH host keys..."
  sudo ssh-keygen -A 2>/dev/null || true
fi

echo ""
echo "Dev environment ready."
echo "  WARNING   : EXPERIMENTAL / NON-PRODUCTION; start listeners explicitly."
echo "  Dashboard : cd dashboard && bun run dev"
echo "  Server    : cd server && bun run dev"
echo "  CLI       : cd octoctl && bun run dev"
echo "  Verify    : bun run lint && bun audit"
echo ""
