import { describe, expect, it } from "bun:test";
import {
  CHANNEL_BY_ID,
  CHANNEL_BY_KIND,
  CHANNEL_CATALOG,
  CHANNEL_IDS,
  CHANNEL_KINDS,
  SELECTABLE_CHANNEL_KINDS,
  getChannelDefinition,
  isChannelKind,
  isSelectableChannel,
} from "../channels.ts";

describe("channel catalog", () => {
  it("has unique IDs and kinds", () => {
    expect(new Set(CHANNEL_IDS).size).toBe(CHANNEL_IDS.length);
    expect(new Set(CHANNEL_KINDS).size).toBe(CHANNEL_KINDS.length);
    expect(CHANNEL_CATALOG).toHaveLength(14);
  });

  it("indexes every entry consistently", () => {
    for (const channel of CHANNEL_CATALOG) {
      expect(CHANNEL_BY_KIND[channel.kind]).toBe(channel);
      expect(CHANNEL_BY_ID[String(channel.id)]).toBe(channel);
      expect(isChannelKind(channel.kind)).toBe(true);
      expect(channel.authModes.length).toBeGreaterThan(0);
      expect(channel.prerequisites.length).toBeGreaterThan(0);
    }
  });

  it("includes Pages with its deployment prerequisites", () => {
    const pages = getChannelDefinition("pages");
    expect(pages.id).toBe(5);
    expect(pages.name).toBe("Pages");
    expect(pages.implementationStatus).toBe("experimental");
    expect(pages.prerequisites).toContain("deployments-read-write");
    expect(pages.prerequisites).toContain("default-branch");
    expect(isSelectableChannel("pages")).toBe(true);
  });

  it("marks Stego selectable only after the local server round trip exists", () => {
    const stego = getChannelDefinition("stego");
    expect(stego.id).toBe(9);
    expect(stego.name).toBe("Stego");
    expect(stego.implementationStatus).toBe("experimental");
    expect(stego.prerequisites).toContain("server-channel-counterpart");
    expect(isSelectableChannel("stego")).toBe(true);
    expect(SELECTABLE_CHANNEL_KINDS).toContain("stego");
    expect(SELECTABLE_CHANNEL_KINDS).not.toContain("pull_request");
  });

  it("preserves the historical Secrets 7b identifier without a collision", () => {
    expect(getChannelDefinition("secrets").id).toBe("7b");
    expect(getChannelDefinition("oidc").id).toBe(7);
  });

  it("does not claim OIDC authentication for the repository-variables channel", () => {
    expect(getChannelDefinition("secrets").authModes).not.toContain(
      "github-oidc",
    );
    expect(getChannelDefinition("oidc").authModes).toContain("github-oidc");
  });
});
