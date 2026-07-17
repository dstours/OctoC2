# OctoC2 — operator shortcuts
#
# Usage:
#   make test          — run all unit tests (implant + server + octoctl + dashboard)
#   make beacon        — build a provisioned beacon plus public enrollment artifact
#   make clean         — remove build artefacts

.PHONY: test beacon clean

# ── Unit tests ────────────────────────────────────────────────────────────────

test:
	@echo "==> implant"
	cd implant  && bun test
	@echo "==> server"
	cd server   && bun test
	@echo "==> octoctl"
	cd octoctl  && bun test
	@echo "==> dashboard"
	cd dashboard && bun test

# ── Build a provisioned beacon ────────────────────────────────────────────────
#
# The build generates distinct X25519 and Ed25519 keys and writes a public
# enrollment artifact beside the binary. GitHub App private keys remain on the
# server; short-lived repository leases arrive through signed recovery records.

beacon:
	cd octoctl && bun run src/index.ts build-beacon --outfile ../beacon-agent
	@echo "==> Built: beacon-agent"
	@echo "==> Import the generated enrollment artifact before deployment."

# ── Clean ─────────────────────────────────────────────────────────────────────

clean:
	rm -f beacon-agent beacon-prod
