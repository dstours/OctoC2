// dashboard/src/lib/parseBeacon.ts

import type { Beacon, OS, Arch, TentacleId, BeaconStatus } from '@/types';
import type { GitHubIssue } from '@/types/github';

const VALID_OS: ReadonlySet<string> = new Set<OS>(['windows', 'linux', 'macos']);
const VALID_ARCH: ReadonlySet<string> = new Set<Arch>(['x64', 'arm64', 'x86']);

function toOS(raw: string | undefined): OS {
  return VALID_OS.has(raw ?? '') ? (raw as OS) : 'linux';
}

function toArch(raw: string | undefined): Arch {
  return VALID_ARCH.has(raw ?? '') ? (raw as Arch) : 'x64';
}

/**
 * Parse key: value frontmatter lines from an issue body.
 * Returns a map of lowercase keys to trimmed string values.
 */
function parseFrontmatter(body: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!body) return map;
  for (const line of body.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (key) map.set(key, value);
  }
  return map;
}

/**
 * Derive beacon liveness status from issue.updated_at:
 *   < 5 minutes  → 'active'
 *   5–60 minutes → 'stale'
 *   ≥ 60 minutes → 'dead'
 */
function deriveStatus(updatedAt: string): BeaconStatus {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const ageMin = ageMs / 60_000;
  if (ageMin < 5) return 'active';
  if (ageMin < 60) return 'stale';
  return 'dead';
}

/** Parse a GitHubIssue into a Beacon object. */
export function parseBeacon(issue: GitHubIssue): Beacon {
  const fm = parseFrontmatter(issue.body);

  // hostname: frontmatter → title stripped of "[beacon]" prefix
  const hostname =
    fm.get('hostname') ??
    issue.title.replace(/^\[beacon\]\s*/i, '').trim();

  const os = toOS(fm.get('os'));
  const arch = toArch(fm.get('arch'));

  const tentacleRaw = fm.get('tentacle');
  const tentacleN = tentacleRaw !== undefined ? parseInt(tentacleRaw, 10) : 1;
  const activeTentacle: TentacleId =
    tentacleN >= 1 && tentacleN <= 10 ? (tentacleN as TentacleId) : 1;

  const status = deriveStatus(issue.updated_at);

  const beacon: Beacon = {
    id: `beacon-${issue.number}`,
    hostname,
    os,
    arch,
    status,
    lastSeen: issue.updated_at,
    activeTentacle,
    issueNumber: issue.number,
  };

  // Optional fields — only set when present in frontmatter
  const username = fm.get('username');
  if (username !== undefined) beacon.username = username;

  const version = fm.get('version');
  if (version !== undefined) beacon.version = version;

  const pubkey = fm.get('pubkey');
  if (pubkey !== undefined) beacon.publicKey = pubkey;

  const tagsRaw = fm.get('tags');
  if (tagsRaw !== undefined) {
    beacon.tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
  }

  return beacon;
}
