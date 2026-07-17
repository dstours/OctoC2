import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BeaconIdentityService,
  type EnrollmentArtifact,
} from "./BeaconIdentityService.ts";

export async function loadEnrollmentDirectory(
  directory: string,
  identities: BeaconIdentityService,
): Promise<number> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".enrollment.json"))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const path = join(directory, entry.name);
    let artifact: EnrollmentArtifact;
    try {
      artifact = JSON.parse(await readFile(path, "utf8")) as EnrollmentArtifact;
    } catch (error) {
      throw new Error(
        `Could not parse enrollment artifact ${path}: ${(error as Error).message}`,
      );
    }
    await identities.enroll(artifact, `file:${entry.name}`);
  }
  return entries.length;
}
