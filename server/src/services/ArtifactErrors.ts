/**
 * An authenticated transport artifact that is structurally invalid, fails
 * identity/signature/ownership policy, or is a replay/conflict.
 *
 * Channel pollers may durably record this outcome as rejected. Operational
 * failures must use ordinary errors so the artifact remains uncommitted and is
 * retried.
 */
export class RejectedArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RejectedArtifactError";
  }
}
