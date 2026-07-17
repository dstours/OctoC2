import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const NAMES = [
  "helper.yml",
  "process-checkin.yml",
  "forward-replies.yml",
  "sync-helper.yml",
] as const;

function template(name: (typeof NAMES)[number] | "README.md"): string {
  return readFileSync(
    resolve(import.meta.dir, "../../../templates/proxy", name),
    "utf8",
  );
}

describe("proxy workflow contract", () => {
  it("uses separate ingress and later egress events", () => {
    const decoyIngress = template("helper.yml");
    const controlIngress = template("process-checkin.yml");
    const controlEgress = template("forward-replies.yml");
    const decoyEgress = template("sync-helper.yml");

    expect(decoyIngress).toContain("octoc2-relay-ingress");
    expect(decoyIngress).toContain("types: [created, edited]");
    expect(decoyIngress).toContain("COMMENT_DIGEST");
    expect(decoyIngress).toContain(
      'SOURCE_EVENT_ID="decoy:${REPOSITORY_ID}:${COMMENT_ID}:${COMMENT_DIGEST}"',
    );
    expect(controlIngress).toContain("types: [octoc2-relay-ingress]");
    expect(controlIngress).toContain("gh issue comment");
    expect(controlEgress).toContain("issue_comment:");
    expect(controlEgress).toContain("octoc2-relay-egress");
    expect(decoyEgress).toContain("types: [octoc2-relay-egress]");
  });

  it("signs canonical dispatch payloads and verifies before mutation", () => {
    for (const name of NAMES) {
      const workflow = template(name);
      expect(workflow).toContain("RELAY_SIGNING_KEY");
      expect(workflow).toContain("sha256");
    }
    for (const name of ["process-checkin.yml", "sync-helper.yml"] as const) {
      const receiver = template(name);
      expect(receiver).toContain("jq -cS 'del(.signature)'");
      expect(receiver).toContain('test "${SIGNATURE}" = "${EXPECTED}"');
      expect(receiver.indexOf('test "${SIGNATURE}" = "${EXPECTED}"'))
        .toBeLessThan(receiver.indexOf("gh issue comment"));
    }
  });

  it("sends repository dispatch bodies through gh's JSON input path", () => {
    for (const name of ["helper.yml", "forward-replies.yml"] as const) {
      const sender = template(name);
      expect(sender).toContain('printf \'%s\' "${DISPATCH}"');
      expect(sender).toContain('DISPATCH="$(jq -cn');
      expect(sender).toContain("gh api");
      expect(sender).toContain("--input -");
    }
  });

  it("keeps egress below GitHub's ten-property client_payload limit", () => {
    const sender = template("forward-replies.yml");
    expect(sender).not.toContain("control_repository: $control_repository");
    expect(sender).not.toContain("control_issue: $control_issue");
    expect(sender).not.toContain("source_comment_id: $source_comment_id");
    expect(sender).toContain("SOURCE_EVENT_ID=\"control:${REPOSITORY_ID}:${COMMENT_ID}\"");
  });

  it("binds routes, enforces freshness, and deduplicates exactly once", () => {
    const controlIngress = template("process-checkin.yml");
    const controlEgress = template("forward-replies.yml");
    const decoyEgress = template("sync-helper.yml");
    const all = NAMES.map(template).join("\n");

    expect(all).toContain("source_event_id");
    expect(all).toContain("issued_at");
    expect(all).toContain("<!-- octoc2-relay:ingress:");
    expect(all).toContain("<!-- octoc2-relay:egress:");
    expect(controlIngress).toContain("EXPECTED_DECOY_REPOSITORY");
    expect(controlIngress).toContain("EXPECTED_DECOY_ISSUE");
    expect(controlEgress).toContain("control issue is not mapped exactly once");
    expect(decoyEgress).toContain("NODE_ID");
    expect(controlIngress).toContain(
      "octoc2-relay-ingress-${{ github.event.client_payload.source_event_id }}",
    );
    expect(decoyEgress).toContain(
      "octoc2-relay-egress-${{ github.event.client_payload.source_event_id }}",
    );
    expect(controlIngress).toContain("cancel-in-progress: false");
    expect(decoyEgress).toContain("cancel-in-progress: false");
  });

  it("does not drop valid egress replies merely because they arrive out of order", () => {
    const decoyEgress = template("sync-helper.yml");
    expect(decoyEgress).not.toContain("LAST_CONTROL_COMMENT_ID");
    expect(decoyEgress).not.toContain('SOURCE_COMMENT_ID" -le');
    expect(decoyEgress).toContain("octoc2-relay:egress:${SOURCE_EVENT_ID}");
    expect(decoyEgress).toContain("ALREADY_POSTED");
    expect(decoyEgress).not.toContain("actions: write");
  });

  it("documents distinct-repository verification and credential boundaries", () => {
    const readme = template("README.md");
    expect(readme).toContain("two distinct repositories");
    expect(readme.replace(/\s+/g, " ")).toContain(
      "must not be reported as proxy end-to-end verification",
    );
    expect(readme).toContain("CONTROL_TOKEN");
    expect(readme).toContain("TARGET_TOKEN");
    expect(readme).toContain("NODE_ROUTE_MAP");
    expect(readme).toContain("OCTOC2_PROXY_CONTROL_FINGERPRINTS");
    expect(readme).toContain("MONITORING_PUBKEY");
    expect(readme).toContain("at most one proxy");
  });
});
