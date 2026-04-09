#!/usr/bin/env bash
# Runs once after the dev container is created.
# Mirrors the setup that GitHub Codespaces would perform.
set -euo pipefail

# ── Toolchain versions ─────────────────────────────────────────────────────────
echo ""
echo "Verifying toolchain..."
echo "   Bun    : $(bun --version)"
echo "   Node   : $(node --version)"
echo "   npm    : $(npm --version)"
echo "   gh     : $(gh --version 2>&1 | head -1)"
echo "   protoc : $(protoc --version)"
echo "   act    : $(act --version 2>/dev/null || echo 'not found')"
echo ""

# ── Git hygiene ────────────────────────────────────────────────────────────────
git config --local core.autocrlf false
git config --local core.eol lf

# ── Install workspace dependencies ────────────────────────────────────────────
echo "[*] Installing monorepo dependencies..."
bun install

# ── Protobuf codegen ───────────────────────────────────────────────────────────
# Generate TypeScript types from proto/svc.proto for both server and implant.
if [ -f "proto/svc.proto" ]; then
  echo "[*] Generating protobuf TypeScript bindings..."

  mkdir -p server/src/proto
  mkdir -p implant/src/proto

  PROTO_GEN="$(bun pm bin -g)/protoc-gen-ts_proto"

  if [ -x "$PROTO_GEN" ]; then
    # Server bindings (full gRPC-js service stubs)
    protoc \
      --plugin="protoc-gen-ts_proto=${PROTO_GEN}" \
      --ts_proto_out=server/src/proto \
      --ts_proto_opt=outputServices=grpc-js,esModuleInterop=true \
      --proto_path=proto \
      proto/svc.proto

    # Implant bindings (client-only, no server stubs to keep binary small)
    protoc \
      --plugin="protoc-gen-ts_proto=${PROTO_GEN}" \
      --ts_proto_out=implant/src/proto \
      --ts_proto_opt=outputServices=generic-definitions,esModuleInterop=true \
      --proto_path=proto \
      proto/svc.proto

    echo "[+] Proto bindings generated."
  else
    echo "[!] protoc-gen-ts_proto not found at ${PROTO_GEN}. Run: bun add -g ts-proto"
  fi
else
  echo "[~] proto/svc.proto not found, skipping codegen."
fi

# ── act runner config ──────────────────────────────────────────────────────────
if command -v act &>/dev/null; then
  echo "[*] Configuring act runner..."
  mkdir -p ~/.config/act
  cat > ~/.config/act/actrc <<EOF
-P ubuntu-latest=catthehacker/ubuntu:act-22.04
-P ubuntu-22.04=catthehacker/ubuntu:act-22.04
--container-architecture linux/amd64
EOF
  echo "[+] act configured."
fi

# ── SSH server readiness ───────────────────────────────────────────────────────
# Ensure SSH host keys exist (needed for gRPC-over-SSH tunnel tentacle)
if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
  echo "[*] Generating SSH host keys..."
  sudo ssh-keygen -A 2>/dev/null || true
fi

echo ""
echo "Dev environment ready."
echo "  Dashboard : cd dashboard && bun run dev"
echo "  Server    : cd server    && bun run dev"
echo "  CLI       : cd octoctl   && bun run dev"
echo "  Build all : bun run build"
echo "  Test GHA  : act -j <job-name>"
echo ""
