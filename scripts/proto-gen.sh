#!/usr/bin/env bash
# ── OctoC2 Proto codegen ──────────────────────────────────────────────────────
# Regenerates TypeScript bindings from proto/octoc2.proto.
# Run: bun run proto:gen
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTO_FILE="${ROOT}/proto/octoc2.proto"
PROTO_DIR="${ROOT}/proto"

SERVER_OUT="${ROOT}/server/src/proto"
IMPLANT_OUT="${ROOT}/implant/src/proto"

mkdir -p "$SERVER_OUT" "$IMPLANT_OUT"

PLUGIN="$(bun pm bin -g 2>/dev/null)/protoc-gen-ts_proto"
if [ ! -x "$PLUGIN" ]; then
  PLUGIN="$(which protoc-gen-ts_proto 2>/dev/null || echo '')"
fi

if [ -z "$PLUGIN" ]; then
  echo "[!] protoc-gen-ts_proto not found. Install with: npm install -g ts-proto"
  exit 1
fi

echo "[*] Generating server bindings (full gRPC-js stubs)..."
protoc \
  --plugin="protoc-gen-ts_proto=${PLUGIN}" \
  --ts_proto_out="${SERVER_OUT}" \
  --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true,stringEnums=true \
  --proto_path="${PROTO_DIR}" \
  "${PROTO_FILE}"

echo "[*] Generating implant bindings (client-only, minimal size)..."
protoc \
  --plugin="protoc-gen-ts_proto=${PLUGIN}" \
  --ts_proto_out="${IMPLANT_OUT}" \
  --ts_proto_opt=outputServices=generic-definitions,esModuleInterop=true,stringEnums=true,onlyTypes=false \
  --proto_path="${PROTO_DIR}" \
  "${PROTO_FILE}"

echo "[+] Proto codegen complete."
echo "    Server  → ${SERVER_OUT}"
echo "    Implant → ${IMPLANT_OUT}"
