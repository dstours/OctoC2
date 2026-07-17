import { describe, expect, it } from "bun:test";
import {
  assertCodespaceName,
  codespaceForwardArgs,
  SshTunnel,
} from "../tentacles/grpc/SshTunnel.ts";

describe("Codespaces tunnel argument validation", () => {
  it("builds the GitHub CLI port-forward command without a shell", () => {
    expect(codespaceForwardArgs("paper-lantern-abc123", 50051, 50051))
      .toEqual([
        "codespace",
        "ports",
        "forward",
        "50051:50051",
        "--codespace",
        "paper-lantern-abc123",
      ]);
  });

  it("rejects names and ports that could alter command execution", () => {
    expect(() => assertCodespaceName("name; rm -rf /"))
      .toThrow("unsupported characters");
    expect(() => codespaceForwardArgs("valid-name", 0, 50051))
      .toThrow("localPort");
    expect(() => codespaceForwardArgs("valid-name", 50051, 70_000))
      .toThrow("remotePort");
  });

  it("fails fast for fine-grained PATs unsupported by the CLI tunnel", async () => {
    const tunnel = new SshTunnel("unused-gh");
    await expect(tunnel.connect("valid-name", "github_pat_fine_grained"))
      .rejects.toThrow("classic PAT with the codespace scope");
  });
});
