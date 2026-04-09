import { readFile } from "fs/promises";

/**
 * Load templates from the JSON file at the given path.
 * Validates that the file contains a non-empty array of strings.
 * Throws if the file is missing, unreadable, or the content is invalid.
 */
export async function loadTitleTemplates(jsonPath: string): Promise<readonly [string, ...string[]]> {
  const raw = await readFile(jsonPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`title-templates: invalid JSON in ${jsonPath}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`title-templates: expected a JSON array in ${jsonPath}`);
  }
  if (parsed.length === 0) {
    throw new Error(`title-templates: array must not be empty in ${jsonPath}`);
  }
  for (const item of parsed) {
    if (typeof item !== "string") {
      throw new Error(
        `title-templates: all elements must be strings in ${jsonPath}`
      );
    }
  }
  return parsed as unknown as readonly [string, ...string[]];
}

export interface TitleContext {
  shortId: string;
  hostname: string;
  date: string; // pre-formatted "Mar 30"
}

/**
 * Pick a uniformly random template from the array, substitute all known
 * placeholders with values from ctx, and return the result.
 *
 * Supported placeholders:
 *   {shortId}       — first 8 hex chars of beaconId
 *   {shortBeaconId} — alias for {shortId}
 *   {hostname}      — operator hostname at build time
 *   {date:short}    — formatted date at build time, e.g. "Mar 30"
 */
export function pickIssueTitle(
  templates: readonly [string, ...string[]],
  ctx: TitleContext
): string {
  const idx = Math.floor(Math.random() * templates.length);
  return templates[idx]!
    .replaceAll("{shortId}", ctx.shortId)
    .replaceAll("{shortBeaconId}", ctx.shortId) // alias — both map to the same value
    .replaceAll("{hostname}", ctx.hostname)
    .replaceAll("{date:short}", ctx.date);
}
