/**
 * OctoC2 — Shared tentacle registration
 *
 * Centralises the logic for wiring up tentacles into a ConnectionFactory.
 * Used both during initial beacon boot and when rebuilding the factory after
 * a dead-drop recovery, ensuring the two paths never diverge.
 */

import type { ConnectionFactory } from "./ConnectionFactory.ts";
import type { BeaconConfig } from "../types.ts";
import { IssuesTentacle }     from "../tentacles/IssuesTentacle.ts";
import { HttpTentacle }       from "../tentacles/HttpTentacle.ts";
import { NotesTentacle }      from "../tentacles/NotesTentacle.ts";
import { BranchTentacle }     from "../tentacles/BranchTentacle.ts";
import { GistTentacle }       from "../tentacles/GistTentacle.ts";
import { OidcTentacle }       from "../tentacles/OidcTentacle.ts";
import { ActionsTentacle }    from "../tentacles/ActionsTentacle.ts";
import { SecretsTentacle }    from "../tentacles/SecretsTentacle.ts";
import { RelayConsortiumTentacle } from "../tentacles/RelayConsortiumTentacle.ts";
import { OctoProxyTentacle }  from "../tentacles/OctoProxyTentacle.ts";
import { SteganographyTentacle } from "../tentacles/SteganographyTentacle.ts";
import { createLogger }       from "../logger.ts";

const log = createLogger("registerTentacles");

// GrpcSshTentacle is loaded dynamically to avoid bundling @grpc/grpc-js,
// protobufjs, and ssh2 (~9.5 MB) into beacons that never use the codespaces
// channel.  The import is deferred until the tentacle is actually needed.
async function loadGrpcSshTentacle(): Promise<typeof import("../tentacles/GrpcSshTentacle.ts")> {
  return await import("../tentacles/GrpcSshTentacle.ts");
}

export interface RegisterOptions {
  /** When true, logs are suppressed (used during rebuild after dead-drop). */
  silent?: boolean;
}

/**
 * Register all tentacles implied by `config.tentaclePriority` into the
 * supplied `factory`.  This is the single source of truth for how tentacles
 * are wired — both the initial boot sequence and dead-drop rebuild call it.
 *
 * Relay consortium and proxy tentacles are also handled here when their
 * prerequisites are present, regardless of whether they appear in the
 * priority list (legacy compatibility).
 */
export async function registerTentacles(
  factory: ConnectionFactory,
  config: BeaconConfig,
  opts: RegisterOptions = {}
): Promise<void> {
  const { silent = false } = opts;

  for (const kind of config.tentaclePriority) {
    switch (kind) {
      case "issues":
        factory.register(new IssuesTentacle(config));
        break;
      case "codespaces": {
        const hasGrpcDirect = Boolean(process.env.SVC_GRPC_DIRECT);
        const hasCodespace  = Boolean(
          process.env.SVC_GRPC_CODESPACE_NAME && process.env.SVC_GITHUB_USER
        );
        if (hasGrpcDirect || hasCodespace) {
          const { GrpcSshTentacle } = await loadGrpcSshTentacle();
          factory.register(new GrpcSshTentacle(config));
          if (!silent) {
            log.info(`GrpcSshTentacle registered (${hasGrpcDirect ? "direct" : "SSH tunnel"} mode)`);
          }
        }
        break;
      }
      case "branch":
        factory.register(new BranchTentacle(config));
        break;
      case "stego":
        factory.register(new SteganographyTentacle(config));
        break;
      case "notes":
        factory.register(new NotesTentacle(config));
        break;
      case "gist":
        factory.register(new GistTentacle(config));
        break;
      case "secrets":
        factory.register(new SecretsTentacle(config));
        break;
      case "actions":
        if (ActionsTentacle.isActionsAvailable()) {
          factory.register(new ActionsTentacle(config));
          if (!silent) log.info("ActionsTentacle registered (GITHUB_TOKEN available)");
        }
        break;
      case "oidc":
        if (OidcTentacle.isOidcAvailable()) {
          factory.register(new OidcTentacle(config));
          if (!silent) log.info("OidcTentacle registered (Actions id-token available)");
        }
        break;
      case "relay":
        // RelayConsortiumTentacle is handled below after the priority loop
        break;
      case "proxy":
        // Proxy tentacles are handled below after the priority loop
        break;
      case "http": {
        const hasHttpUrl = Boolean(process.env.SVC_HTTP_URL);
        if (hasHttpUrl) {
          factory.register(new HttpTentacle(config));
          if (!silent) log.info("HttpTentacle registered (SVC_HTTP_URL configured)");
        }
        break;
      }
    }
  }

  // Register RelayConsortiumTentacle if consortium is configured
  if ((config.relayConsortium?.length ?? 0) > 0) {
    factory.register(new RelayConsortiumTentacle(config));
  }

  // Register proxy tentacles if configured
  if (config.tentaclePriority.includes("proxy") && (config.proxyRepos?.length ?? 0) > 0) {
    factory.setProxyTentacles(
      config.proxyRepos!.map((proxyConfig) => new OctoProxyTentacle(config, proxyConfig))
    );
  }
}
