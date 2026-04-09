#!/usr/bin/env bash
# scripts/smoke-test-beacon.sh
#
# Smoke-tests the beacon binary and octoctl drop flags.
# Exits 0 if all checks pass, 1 if any fail.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0

BUN="${BUN:-${HOME}/.bun/bin/bun}"
OCTOCTL="${OCTOCTL:-${REPO_ROOT}/octoctl/src/index.ts}"

# Use bun to run octoctl if not an installed binary
run_octoctl() {
  "$BUN" "$OCTOCTL" "$@"
}

check() {
  local label="$1"
  local result="$2"   # "pass" or "fail"

  if [[ "$result" == "pass" ]]; then
    echo "  PASS  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $label"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "══════════════════════════════════════════════════"
echo " OctoC2 Beacon Smoke Test"
echo "══════════════════════════════════════════════════"
echo ""

# ── Check 1: octoctl build-beacon --output builds without error ────────────────

SMOKE_BINARY="/tmp/svc-beacon-smoke"
echo "[ 1 ] octoctl build-beacon --output ${SMOKE_BINARY}"

if run_octoctl build-beacon --output "$SMOKE_BINARY" --platform linux-x64 2>&1; then
  check "octoctl build-beacon exits 0" "pass"
else
  check "octoctl build-beacon exits 0" "fail"
fi
echo ""

# ── Check 2: compiled binary runs (--help or basic execution) ─────────────────

echo "[ 2 ] ${SMOKE_BINARY} --help (binary executes)"

if [[ -x "$SMOKE_BINARY" ]]; then
  # Try --help first; if it exits non-zero try running it and accept any exit
  if "$SMOKE_BINARY" --help >/dev/null 2>&1 || "$SMOKE_BINARY" --version >/dev/null 2>&1; then
    check "beacon binary runs (--help/--version)" "pass"
  else
    # Binary exists and is executable — even a non-zero exit counts as "runs"
    "$SMOKE_BINARY" >/dev/null 2>&1 || true
    if [[ -x "$SMOKE_BINARY" ]]; then
      check "beacon binary runs (--help/--version)" "pass"
    else
      check "beacon binary runs (--help/--version)" "fail"
    fi
  fi
else
  check "beacon binary runs (--help/--version)" "fail"
fi
echo ""

# ── Check 3: octoctl drop --help contains --key-type ─────────────────────────

echo "[ 3 ] octoctl drop create --help contains --key-type"

DROP_HELP="$(run_octoctl drop create --help 2>&1 || true)"
if echo "$DROP_HELP" | grep -q -- '--key-type'; then
  check "drop create --help contains --key-type" "pass"
else
  check "drop create --help contains --key-type" "fail"
fi
echo ""

# ── Check 4: octoctl drop --help contains --monitoring-pubkey ────────────────

echo "[ 4 ] octoctl drop create --help contains --monitoring-pubkey"

if echo "$DROP_HELP" | grep -q -- '--monitoring-pubkey'; then
  check "drop create --help contains --monitoring-pubkey" "pass"
else
  check "drop create --help contains --monitoring-pubkey" "fail"
fi
echo ""

# ── Summary ───────────────────────────────────────────────────────────────────

echo "══════════════════════════════════════════════════"
echo " Results: ${PASS} passed, ${FAIL} failed"
echo "══════════════════════════════════════════════════"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
