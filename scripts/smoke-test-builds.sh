#!/usr/bin/env bash
# scripts/smoke-test-builds.sh
#
# Smoke-tests the production builds of dashboard and docs-site.
# Exits 0 if all builds pass, 1 if any fail.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0

run_build() {
  local label="$1"
  local dir="$2"

  echo "──────────────────────────────────────────"
  echo "Building: $label  ($dir)"
  echo "──────────────────────────────────────────"

  if (cd "$dir" && bun run build); then
    echo ""
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo ""
    echo "  FAIL  $label"
    FAIL=$((FAIL + 1))
  fi
  echo ""
}

run_build "dashboard" "$REPO_ROOT/dashboard"
run_build "docs-site"  "$REPO_ROOT/docs-site"

echo "══════════════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
echo "══════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
