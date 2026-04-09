// dashboard/src/pages/LoginPage.tsx
/**
 * LoginPage — operator authentication entry point.
 *
 * Visual: circuit-grid bg, centered card with neon hairline border,
 * ambient-pulsing logo, neon Connect button, subtle mode indicator.
 * Credentials stay in memory only — never written to storage.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useConnectionMode } from '@/hooks/useConnectionMode';
import { OctoLogo } from '@/assets/OctoLogo';

export function LoginPage() {
  const [patInput,     setPatInput]     = useState('');
  const [privkeyInput, setPrivkeyInput] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const { login }  = useAuth();
  const navigate   = useNavigate();
  const { mode, latencyMs, serverUrl, loading, error, refresh } =
    useConnectionMode(patInput);

  // ── Derived display ─────────────────────────────────────────────────────────

  const modeText = loading
    ? 'Detecting…'
    : mode === 'live'   ? `Live server (${latencyMs ?? '?'}ms)`
    : mode === 'api'    ? 'API mode'
    :                     'Offline mode';

  const modeColor = loading ? 'text-gray-500'
    : mode === 'live'   ? 'text-green-400'
    : mode === 'api'    ? 'text-blue-400'
    :                     'text-amber-400';

  const dotClass = loading ? 'bg-gray-500'
    : mode === 'live'   ? 'bg-green-400 shadow-neon-green animate-pulse'
    : mode === 'api'    ? 'bg-blue-400  shadow-neon-blue'
    :                     'bg-amber-400 shadow-neon-amber';

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    const { mode: detectedMode, latencyMs: detectedLatency } = await refresh();
    login(patInput, detectedMode, serverUrl, detectedLatency, privkeyInput || null);
    navigate('/');
  }

  function handleSkipOffline() {
    login('', 'offline', serverUrl, null, null);
    navigate('/');
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="bg-login min-h-screen flex items-center justify-center p-8 font-mono">
      <div className="w-full max-w-sm space-y-7">

        {/* ── Brand ──────────────────────────────────────────────────────────── */}
        <div className="flex flex-col items-center">
          <OctoLogo variant="full" size={180} className="logo-pulse" />
          <h1 className="sr-only">OctoC2</h1>
        </div>

        {/* ── Local-only safety banner ───────────────────────────────────────── */}
        <div
          className="border border-amber-800/50 bg-amber-950/30 rounded px-3 py-2 text-[10px] font-mono text-amber-400/80 space-y-0.5"
          role="note"
          aria-label="Security notice"
        >
          <p className="font-semibold text-amber-400">
            ⚠️ Local / private Codespace only
          </p>
          <p className="text-amber-500/70">
            Safe to enter PAT and private key here. Never run on an untrusted network.
          </p>
        </div>

        {/* ── Login card ─────────────────────────────────────────────────────── */}
        <form
          onSubmit={handleConnect}
          className="card-neon bg-[#030310] rounded-lg p-6 space-y-5"
        >

          {/* PAT field */}
          <div className="space-y-1.5">
            <label
              htmlFor="pat-input"
              className="text-[10px] text-gray-500 uppercase tracking-[0.2em] block"
            >
              GitHub Personal Access Token
            </label>
            <input
              id="pat-input"
              type="password"
              value={patInput}
              onChange={e => setPatInput(e.target.value)}
              placeholder="ghp_..."
              autoComplete="off"
              spellCheck={false}
              className="
                w-full bg-octo-black border border-octo-border rounded px-3 py-2
                text-sm text-gray-200 placeholder:text-gray-700 font-mono
                outline-none
                transition-all duration-150
                focus:border-octo-blue/50 focus:ring-1 focus:ring-octo-blue/30
                focus:shadow-[0_0_12px_rgba(0,240,255,0.12)]
              "
            />
          </div>

          {/* Mode indicator */}
          <div className={`flex items-center gap-2 text-xs ${modeColor}`}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
            <span>{modeText}</span>
          </div>

          {/* Error */}
          {error && (
            <p className="text-xs text-red-400 font-mono" role="alert">
              {error}
            </p>
          )}

          {/* Advanced section */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(v => !v)}
              className="flex items-center gap-1 text-[10px] text-gray-600 hover:text-gray-400
                         transition-colors duration-150"
              aria-expanded={showAdvanced}
              aria-controls="advanced-section"
            >
              {showAdvanced ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Advanced
            </button>

            {showAdvanced && (
              <div id="advanced-section" className="mt-3 space-y-1.5">
                <label
                  htmlFor="privkey-input"
                  className="text-[10px] text-gray-500 uppercase tracking-[0.2em] block"
                >
                  Operator Private Key
                  <span className="ml-2 text-gray-700 normal-case tracking-normal text-[10px]">
                    (decrypts beacon results)
                  </span>
                </label>
                <input
                  id="privkey-input"
                  type="password"
                  value={privkeyInput}
                  onChange={e => setPrivkeyInput(e.target.value)}
                  placeholder="Private key (base64)"
                  autoComplete="off"
                  spellCheck={false}
                  className="
                    w-full bg-octo-black border border-octo-border rounded px-3 py-2
                    text-sm text-gray-200 placeholder:text-gray-700 font-mono
                    outline-none transition-all duration-150
                    focus:border-octo-blue/50 focus:ring-1 focus:ring-octo-blue/30
                    focus:shadow-[0_0_12px_rgba(0,240,255,0.12)]
                  "
                />
              </div>
            )}
          </div>

          {/* Connect */}
          <button
            type="submit"
            disabled={loading}
            className="btn-connect w-full rounded px-4 py-2.5 text-xs tracking-widest uppercase"
          >
            {loading ? 'Detecting…' : 'Connect'}
          </button>

          {/* Skip to offline */}
          <div className="text-center">
            <button
              type="button"
              onClick={handleSkipOffline}
              className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors duration-150
                         tracking-wide underline underline-offset-4 decoration-dotted"
            >
              Skip to Offline Mode
            </button>
          </div>

        </form>
      </div>
    </div>
  );
}
