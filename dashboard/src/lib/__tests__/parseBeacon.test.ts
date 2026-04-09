// dashboard/src/lib/__tests__/parseBeacon.test.ts
import { describe, it, expect } from 'vitest';
import { parseBeacon } from '../parseBeacon';
import type { GitHubIssue } from '@/types/github';

// ── Fixture helper ────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: '[beacon] web-server',
    body: 'os: linux\ntentacle: 3\nhostname: web-server\narch: x64',
    state: 'open',
    labels: [{ id: 1, name: 'infra-node', color: '0075ca', description: null }],
    user: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
    comments: 0,
    html_url: 'https://github.com/example-owner/OctoC2/issues/1',
    ...overrides,
  };
}

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseBeacon', () => {
  // ── Frontmatter parsing ───────────────────────────────────────────────────

  it('parses hostname from frontmatter', () => {
    const beacon = parseBeacon(makeIssue());
    expect(beacon.hostname).toBe('web-server');
  });

  it('falls back to title (stripped of [beacon] prefix) when hostname not in frontmatter', () => {
    const issue = makeIssue({ body: 'os: linux', title: '[beacon] fallback-host' });
    const beacon = parseBeacon(issue);
    expect(beacon.hostname).toBe('fallback-host');
  });

  it('parses os from frontmatter', () => {
    const beacon = parseBeacon(makeIssue({ body: 'os: windows\nhostname: win-box' }));
    expect(beacon.os).toBe('windows');
  });

  it('defaults os to linux when not present', () => {
    const beacon = parseBeacon(makeIssue({ body: 'hostname: bare-box' }));
    expect(beacon.os).toBe('linux');
  });

  // ── arch ──────────────────────────────────────────────────────────────────

  it('parses arch from frontmatter', () => {
    const beacon = parseBeacon(makeIssue({ body: 'arch: arm64\nhostname: pi' }));
    expect(beacon.arch).toBe('arm64');
  });

  it('defaults arch to x64 when not present', () => {
    const beacon = parseBeacon(makeIssue({ body: 'hostname: oldbox' }));
    expect(beacon.arch).toBe('x64');
  });

  it('parses arch: x86 correctly', () => {
    const beacon = parseBeacon(makeIssue({ body: 'arch: x86\nhostname: retro' }));
    expect(beacon.arch).toBe('x86');
  });

  // ── activeTentacle ────────────────────────────────────────────────────────

  it('parses tentacle number into activeTentacle', () => {
    const beacon = parseBeacon(makeIssue({ body: 'tentacle: 3\nhostname: host' }));
    expect(beacon.activeTentacle).toBe(3);
  });

  it('defaults activeTentacle to 1 when tentacle not in frontmatter', () => {
    const beacon = parseBeacon(makeIssue({ body: 'hostname: host' }));
    expect(beacon.activeTentacle).toBe(1);
  });

  // ── status derivation ─────────────────────────────────────────────────────

  it('sets status to active when updated_at is less than 5 minutes ago', () => {
    const beacon = parseBeacon(makeIssue({ updated_at: minutesAgo(2) }));
    expect(beacon.status).toBe('active');
  });

  it('sets status to stale when updated_at is 30 minutes ago', () => {
    const beacon = parseBeacon(makeIssue({ updated_at: minutesAgo(30) }));
    expect(beacon.status).toBe('stale');
  });

  it('sets status to dead when updated_at is 2 hours ago', () => {
    const beacon = parseBeacon(makeIssue({ updated_at: minutesAgo(120) }));
    expect(beacon.status).toBe('dead');
  });

  it('sets status to stale at exactly 5 minutes ago', () => {
    const beacon = parseBeacon(makeIssue({ updated_at: minutesAgo(5) }));
    expect(beacon.status).toBe('stale');
  });

  it('sets status to dead at exactly 60 minutes ago', () => {
    const beacon = parseBeacon(makeIssue({ updated_at: minutesAgo(60) }));
    expect(beacon.status).toBe('dead');
  });

  // ── id and issueNumber ────────────────────────────────────────────────────

  it('sets id as beacon-{number}', () => {
    const beacon = parseBeacon(makeIssue({ number: 42 }));
    expect(beacon.id).toBe('beacon-42');
  });

  it('sets issueNumber from issue.number', () => {
    const beacon = parseBeacon(makeIssue({ number: 7 }));
    expect(beacon.issueNumber).toBe(7);
  });

  it('sets lastSeen from issue.updated_at', () => {
    const ts = minutesAgo(1);
    const beacon = parseBeacon(makeIssue({ updated_at: ts }));
    expect(beacon.lastSeen).toBe(ts);
  });

  // ── null body fallback ────────────────────────────────────────────────────

  it('handles null body gracefully — os defaults to linux', () => {
    const beacon = parseBeacon(makeIssue({ body: null }));
    expect(beacon.os).toBe('linux');
  });

  it('handles null body gracefully — activeTentacle defaults to 1', () => {
    const beacon = parseBeacon(makeIssue({ body: null }));
    expect(beacon.activeTentacle).toBe(1);
  });

  it('handles null body gracefully — arch defaults to x64', () => {
    const beacon = parseBeacon(makeIssue({ body: null }));
    expect(beacon.arch).toBe('x64');
  });

  it('handles null body gracefully — hostname falls back to title', () => {
    const beacon = parseBeacon(makeIssue({ body: null, title: '[beacon] null-host' }));
    expect(beacon.hostname).toBe('null-host');
  });

  // ── optional fields ───────────────────────────────────────────────────────

  it('parses username from frontmatter when present', () => {
    const beacon = parseBeacon(makeIssue({ body: 'hostname: h\nusername: jdoe' }));
    expect(beacon.username).toBe('jdoe');
  });

  it('leaves username undefined when not in frontmatter', () => {
    const beacon = parseBeacon(makeIssue({ body: 'hostname: h' }));
    expect(beacon.username).toBeUndefined();
  });

  it('parses version from frontmatter when present', () => {
    const beacon = parseBeacon(makeIssue({ body: 'hostname: h\nversion: 1.2.3' }));
    expect(beacon.version).toBe('1.2.3');
  });

  it('parses pubkey from frontmatter into publicKey', () => {
    const beacon = parseBeacon(makeIssue({ body: 'hostname: h\npubkey: abc123==' }));
    expect(beacon.publicKey).toBe('abc123==');
  });

  it('parses tags as a comma-split trimmed array', () => {
    const beacon = parseBeacon(makeIssue({ body: 'hostname: h\ntags: prod, web, dmz' }));
    expect(beacon.tags).toEqual(['prod', 'web', 'dmz']);
  });

  it('leaves tags undefined when not in frontmatter', () => {
    const beacon = parseBeacon(makeIssue({ body: 'hostname: h' }));
    expect(beacon.tags).toBeUndefined();
  });
});
