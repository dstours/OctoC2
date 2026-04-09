// dashboard/src/pages/MultiBeaconResultsPage.tsx
//
// Multi-beacon aggregate result viewer.
// Navigated to from BulkActionBar "View Results" button.
// URL: /results?beacons=id1,id2,id3
//
// For each beacon ID in the query string, fetches results via getResults
// (same as BeaconDetailPage) and shows them grouped by beacon.

import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { C2ServerClient } from '@/lib/C2ServerClient';
import type { ServerTask } from '@/lib/C2ServerClient';
import { decryptSealedResult } from '@/lib/crypto';

// ── Helpers ───────────────────────────────────────────────────────────────────

function rel(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)     return 'just now';
  if (ms < 3_600_000)  return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

const STATUS_COLOURS: Record<string, string> = {
  pending:   'text-gray-400 border-gray-700',
  delivered: 'text-blue-400 border-blue-800',
  completed: 'text-green-400 border-green-800',
  failed:    'text-red-400 border-red-800',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center text-[9px] font-mono border px-1.5 py-0.5 rounded ${STATUS_COLOURS[status] ?? 'text-gray-500 border-gray-800'}`}>
      {status}
    </span>
  );
}

// ── ResultOutput — shows plaintext or decrypted output ───────────────────────

function ResultOutput({ task, privkey, onSetPrivkey }: {
  task:         ServerTask;
  privkey:      string | null;
  onSetPrivkey: (key: string) => void;
}) {
  const [decrypted, setDecrypted]   = useState<string | null>(null);
  const [decryptErr, setDecryptErr] = useState<string | null>(null);
  const [keyInput, setKeyInput]     = useState('');
  const notifiedRef = useRef(false);

  const r       = task.result;
  const encData = r?.data ?? '';

  async function doDecrypt(key: string) {
    try {
      const plain = await decryptSealedResult(encData, key);
      setDecrypted(plain);
      setDecryptErr(null);
      onSetPrivkey(key);
    } catch {
      setDecryptErr('Decryption failed — check private key');
    }
  }

  // Auto-decrypt when operator privkey is available
  useEffect(() => {
    if (privkey && encData && decrypted === null && decryptErr === null) {
      void doDecrypt(privkey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privkey, encData]);

  // Mark plaintext as notified (for ref tracking consistency)
  useEffect(() => {
    if (!notifiedRef.current && r?.output && !r?.data) {
      notifiedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r?.output, r?.data]);

  if (!r) return null;

  if (r.output && !r.data) {
    return (
      <pre className="mt-1 bg-octo-black border border-octo-border rounded p-2 text-[11px] text-gray-300 font-mono whitespace-pre-wrap overflow-auto max-h-32">
        {r.output}
      </pre>
    );
  }

  if (r.data) {
    if (decrypted !== null) {
      return (
        <pre className="mt-1 bg-octo-black border border-green-900 rounded p-2 text-[11px] text-green-300 font-mono whitespace-pre-wrap overflow-auto max-h-32">
          {decrypted}
        </pre>
      );
    }

    if (decryptErr !== null) {
      return (
        <div className="mt-1 space-y-1">
          <p className="text-[10px] text-red-400 font-mono">{decryptErr}</p>
          <div className="flex gap-2">
            <input
              type="password"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              placeholder="Private key (base64url)"
              className="flex-1 bg-octo-black border border-octo-border rounded px-2 py-1 text-xs font-mono outline-none focus:border-octo-blue/50"
            />
            <button
              onClick={() => void doDecrypt(keyInput)}
              className="text-[10px] px-3 py-1 bg-octo-blue/10 border border-octo-blue/30 text-octo-blue rounded hover:bg-octo-blue/20 font-mono"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    if (privkey) {
      return <p className="mt-1 text-[10px] text-gray-600 font-mono">Decrypting…</p>;
    }

    return (
      <div className="mt-1 space-y-1">
        <p className="text-[10px] text-gray-600 font-mono">
          Encrypted result ({r.data.length} bytes) — enter operator private key to decrypt
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={e => setKeyInput(e.target.value)}
            placeholder="Private key (base64url)"
            className="flex-1 bg-octo-black border border-octo-border rounded px-2 py-1 text-xs font-mono outline-none focus:border-octo-blue/50"
          />
          <button
            onClick={() => void doDecrypt(keyInput)}
            className="text-[10px] px-3 py-1 bg-octo-blue/10 border border-octo-blue/30 text-octo-blue rounded hover:bg-octo-blue/20 font-mono"
          >
            Decrypt
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// ── BeaconResultGroup — results for a single beacon ──────────────────────────

function BeaconResultGroup({ beaconId, privkey, onSetPrivkey }: {
  beaconId:     string;
  privkey:      string | null;
  onSetPrivkey: (key: string) => void;
}) {
  const { serverUrl, pat } = useAuth();

  const client = new C2ServerClient(serverUrl ?? '', pat);

  const { data: tasks, isLoading, isError } = useQuery<ServerTask[]>({
    queryKey: ['results', beaconId],
    queryFn:  () => client.getResults(beaconId),
    staleTime: 30_000,
    retry: 1,
  });

  const shortId = beaconId.replace(/-/g, '').slice(0, 8);
  const heading = shortId;

  const completedOrFailed = (tasks ?? []).filter(
    t => t.status === 'completed' || t.status === 'failed'
  );

  return (
    <div className="mb-6">
      <h2 className="text-[11px] font-mono font-semibold text-octo-blue border-b border-octo-border/40 pb-1 mb-2">
        [{heading}]
      </h2>

      {isLoading && (
        <p className="text-[10px] text-gray-600 font-mono px-1">Loading…</p>
      )}

      {isError && (
        <p className="text-[10px] text-red-400 font-mono px-1">Failed to load results</p>
      )}

      {!isLoading && !isError && completedOrFailed.length === 0 && (
        <p className="text-[10px] text-gray-600 font-mono px-1">No completed or failed tasks</p>
      )}

      {completedOrFailed.map(task => (
        <div key={task.taskId} className="border-b border-octo-border/30 py-2 px-2 text-xs font-mono">
          <div className="flex items-center gap-2">
            <StatusBadge status={task.status} />
            <span className="text-gray-400">{task.kind}</span>
            <span className="text-gray-700 text-[10px] truncate max-w-xs">
              {JSON.stringify(task.args)}
            </span>
            <span className="text-[10px] text-gray-600 shrink-0">{task.taskId}</span>
            <span className="ml-auto text-[10px] text-gray-600 shrink-0">{rel(task.completedAt)}</span>
          </div>
          {task.result && (
            <ResultOutput
              task={task}
              privkey={privkey}
              onSetPrivkey={onSetPrivkey}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── MultiBeaconResultsPage ────────────────────────────────────────────────────

export function MultiBeaconResultsPage() {
  const [searchParams]          = useSearchParams();
  const navigate                = useNavigate();
  const { privkey, setPrivkey } = useAuth();

  const beaconIds: string[] = (searchParams.get('beacons') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return (
    <div className="p-4 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 text-[10px] font-mono text-gray-500 hover:text-gray-300 transition-colors"
        >
          <ChevronLeft className="w-3 h-3" />
          Back
        </button>
        <h1 className="text-sm font-mono font-semibold text-gray-300">
          Multi-Beacon Results
        </h1>
        <span className="text-[10px] font-mono text-gray-600">
          ({beaconIds.length} beacon{beaconIds.length !== 1 ? 's' : ''})
        </span>
      </div>

      {beaconIds.length === 0 && (
        <p className="text-[11px] text-gray-600 font-mono">
          No beacons specified. Add <code>?beacons=id1,id2</code> to the URL.
        </p>
      )}

      {beaconIds.map(id => (
        <BeaconResultGroup
          key={id}
          beaconId={id}
          privkey={privkey}
          onSetPrivkey={setPrivkey}
        />
      ))}
    </div>
  );
}
