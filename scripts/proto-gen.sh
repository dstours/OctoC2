#!/usr/bin/env bash
# Compatibility wrapper. The canonical, cross-platform generator is written in
# TypeScript and uses proto/svc.proto as its only schema input.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bun run "${ROOT}/scripts/generate-proto.ts" "$@"
