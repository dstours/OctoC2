import { describe, expect, it } from "bun:test";
import { CredentialVerifier, parseCredentialMap } from "../services/CredentialVerifier.ts";

describe("CredentialVerifier", () => {
  it("binds a bearer token to one principal", () => {
    const verifier = new CredentialVerifier({ beaconA: "token-a", beaconB: "token-b" });
    expect(verifier.authenticateAuthorization("Bearer token-a")).toBe("beaconA");
    expect(verifier.authenticateAuthorization("Bearer token-b")).toBe("beaconB");
    expect(verifier.authenticateAuthorization("Bearer wrong")).toBeNull();
  });

  it("rejects duplicate or empty credentials", () => {
    expect(() => new CredentialVerifier({ a: "same", b: "same" })).toThrow();
    expect(() => new CredentialVerifier({ a: "" })).toThrow();
  });

  it("parses a non-empty credential map", () => {
    expect(parseCredentialMap('{"beacon-a":"secret"}', "TOKENS")).toEqual({
      "beacon-a": "secret",
    });
    expect(() => parseCredentialMap("[]", "TOKENS")).toThrow();
  });
});
