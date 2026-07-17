import { useState } from 'react'

const owner = import.meta.env.VITE_GITHUB_OWNER || 'dstours'
const repo = import.meta.env.VITE_GITHUB_REPO || 'OctoC2'
const repositoryUrl = `https://github.com/${owner}/${repo}`
const docsUrl = (path: string) => `${repositoryUrl}/blob/main/${path}`
const logoUrl = `${import.meta.env.BASE_URL}logo.png`

const installCommand = `bun install --frozen-lockfile
bun run proto:gen
bun run deps:check
bun run docs:check`

const controllerConfig = `# Repository and operator identity
OCTOC2_REPO_OWNER=<owner>
OCTOC2_REPO_NAME=<private-control-repo>
OCTOC2_OPERATOR_SECRET=<x25519-secret-key>

# Opt-in HTTPS/WSS listener
OCTOC2_HTTP_ENABLED=true
OCTOC2_HTTP_HOST=127.0.0.1
OCTOC2_HTTP_PORT=8080
OCTOC2_HTTP_SERVER_CERT=/absolute/path/server.crt
OCTOC2_HTTP_SERVER_KEY=/absolute/path/server.key
OCTOC2_OPERATOR_API_TOKEN=<unique-operator-token>
OCTOC2_BEACON_API_TOKENS={"<beacon-id>":"<unique-beacon-token>"}`

const launchCommands = `# Terminal 1 — controller
cd server && bun run src/index.ts

# Terminal 2 — dashboard
cd dashboard && bun run dev

# Terminal 3 — operator CLI
cd octoctl && bun run src/index.ts --help`

const verification = `bun run deps:check
bun run docs:check
bun run workflows:check
bun run toolchain:check
bun run proto:check
bun run lint
bun audit

cd shared && bun test --timeout 30000 && bun run typecheck
cd ../implant && bun test --timeout 30000 && bun run typecheck
cd ../server && bun test --timeout 30000 && bun run typecheck`

const workspaces = [
  { name: 'implant', description: 'Beacon runtime, task lifecycle, recovery, and transport clients.' },
  { name: 'server', description: 'Controller services, durable task state, channel polling, and APIs.' },
  { name: 'dashboard', description: 'Local operator interface for beacons, tasks, results, and activity.' },
  { name: 'octoctl', description: 'Operator CLI for keys, enrollment, builds, tasks, and proxy setup.' },
  { name: 'shared', description: 'Canonical task, channel, envelope, identity, and signing contracts.' },
]

const transportGroups = [
  {
    eyebrow: 'GitHub primitives',
    title: 'Repository-backed channels',
    description: 'Encrypted task and result exchange through native GitHub artifacts.',
    channels: ['Issues', 'Branch', 'Actions', 'Pages', 'Gists', 'Secrets / variables', 'Steganography', 'Git Notes'],
  },
  {
    eyebrow: 'Direct transports',
    title: 'Authenticated controller paths',
    description: 'Low-latency controller communication with explicit network and identity controls.',
    channels: ['HTTPS / WSS', 'gRPC / mTLS', 'GitHub OIDC'],
  },
  {
    eyebrow: 'Routing',
    title: 'Resilient relay paths',
    description: 'Signed routing across distinct repositories or an authenticated relay consortium.',
    channels: ['Two-repository proxy', 'Relay consortium', 'Codespaces tunnel'],
  },
]

const guides = [
  {
    title: 'Installation',
    description: 'Install the pinned toolchain, run each component, and build platform beacon binaries.',
    href: docsUrl('docs/INSTALLATION.md'),
    label: 'Install',
  },
  {
    title: 'GitHub setup',
    description: 'Configure repositories, the GitHub App, least-privilege permissions, PAT roles, and rotation.',
    href: docsUrl('docs/GITHUB_SETUP.md'),
    label: 'Provision',
  },
  {
    title: 'Quickstart',
    description: 'Build and import a pre-enrolled beacon, then verify an accepted ping result.',
    href: docsUrl('docs/QUICKSTART.md'),
    label: 'First run',
  },
  {
    title: 'Architecture',
    description: 'Understand components, identity boundaries, task lifecycle, durable state, and recovery.',
    href: docsUrl('docs/ARCHITECTURE.md'),
    label: 'Learn',
  },
  {
    title: 'Channel guide',
    description: 'Compare every transport, permission, prerequisite, priority rule, and qualification step.',
    href: docsUrl('docs/CHANNELS.md'),
    label: 'Transports',
  },
  {
    title: 'Configuration',
    description: 'Look up controller, listener, beacon, OIDC, recovery, dashboard, and CLI settings.',
    href: docsUrl('docs/CONFIGURATION.md'),
    label: 'Reference',
  },
  {
    title: 'CLI reference',
    description: 'Use setup, enrollment, builds, inventory, tasks, results, proxy, and service commands.',
    href: docsUrl('docs/CLI.md'),
    label: 'Operate',
  },
  {
    title: 'Operations & assurance',
    description: 'Listener policy, lifecycle behavior, replay protection, and certificate handling.',
    href: docsUrl('docs/PRODUCTION.md'),
    label: 'Operate safely',
  },
  {
    title: 'Recovery',
    description: 'Provision signed recovery records and short-lived GitHub App token leases.',
    href: docsUrl('docs/RECOVERY.md'),
    label: 'Configure recovery',
  },
  {
    title: 'Troubleshooting',
    description: 'Diagnose GitHub errors, decrypt failures, acknowledgements, proxy, TLS, gRPC, OIDC, and state.',
    href: docsUrl('docs/TROUBLESHOOTING.md'),
    label: 'Diagnose',
  },
  {
    title: 'Development',
    description: 'Work with shared contracts, tests, builds, generated protocol bindings, and change checks.',
    href: docsUrl('docs/DEVELOPMENT.md'),
    label: 'Contribute',
  },
  {
    title: 'Verification evidence',
    description: 'Trace implementation decisions to tests, live qualifications, and cleanup records.',
    href: docsUrl('docs/REMEDIATION_TRACEABILITY.md'),
    label: 'Review evidence',
  },
]

function CopyButton({ value }: { value: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'blocked'>('idle')

  async function copy() {
    let succeeded = false
    try {
      await navigator.clipboard.writeText(value)
      succeeded = true
    } catch {
      const fallback = document.createElement('textarea')
      fallback.value = value
      fallback.setAttribute('readonly', '')
      fallback.style.position = 'fixed'
      fallback.style.opacity = '0'
      document.body.appendChild(fallback)
      fallback.select()
      succeeded = document.execCommand('copy')
      fallback.remove()
    }
    setStatus(succeeded ? 'copied' : 'blocked')
    window.setTimeout(() => setStatus('idle'), 1800)
  }

  return (
    <button className="copy-button" type="button" onClick={copy} aria-label="Copy code" aria-live="polite">
      {status === 'copied' ? 'Copied' : status === 'blocked' ? 'Copy unavailable' : 'Copy'}
    </button>
  )
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="code-shell">
      <div className="code-toolbar">
        <span>{title}</span>
        <CopyButton value={code} />
      </div>
      <pre><code>{code}</code></pre>
    </div>
  )
}

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description: string
}) {
  return (
    <div className="section-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  )
}

function App() {
  return (
    <div className="site-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#top" aria-label="OctoC2 documentation home">
            <img src={logoUrl} alt="" />
            <span>OctoC2</span>
            <span className="brand-divider" />
            <span className="brand-context">Docs</span>
          </a>
          <nav className="topnav" aria-label="Primary navigation">
            <a href="#architecture">Architecture</a>
            <a href="#quickstart">Quickstart</a>
            <a href="#transports">Transports</a>
            <a href="#security">Security</a>
            <a href="#guides">Guides</a>
          </nav>
          <a className="repo-link" href={repositoryUrl}>GitHub <span aria-hidden="true">↗</span></a>
        </div>
      </header>

      <aside className="notice" role="note">
        <div>
          <span className="notice-mark" aria-hidden="true">i</span>
          <p><strong>Authorized use only.</strong> Run OctoC2 only on systems and repositories you own or have explicit permission to test. Keep controller surfaces private and credentials scoped to the evaluation.</p>
        </div>
      </aside>

      <main id="top">
        <section className="hero">
          <div className="hero-glow" aria-hidden="true" />
          <div className="hero-copy">
            <p className="eyebrow"><span className="pulse-dot" /> GitHub-native command and control</p>
            <h1>GitHub is the transport.<br /><span>Trust is the protocol.</span></h1>
            <p className="hero-lede">
              OctoC2 is built for authorized security research, connecting a TypeScript
              beacon, durable controller, local dashboard, and operator CLI through
              encrypted multi-channel transport with resilient failover.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#quickstart">Start local setup <span>→</span></a>
              <a className="button button-secondary" href="#architecture">Understand the system</a>
            </div>
            <dl className="hero-metrics">
              <div><dt>13</dt><dd>selectable channels</dd></div>
              <div><dt>5</dt><dd>core workspaces</dd></div>
              <div><dt>Ed25519</dt><dd>beacon identity</dd></div>
              <div><dt>SQLite</dt><dd>durable state</dd></div>
            </dl>
          </div>
          <div className="hero-panel" aria-label="OctoC2 request lifecycle">
            <div className="panel-heading">
              <span>Signed task lifecycle</span>
              <span className="live-pill"><span /> fail closed</span>
            </div>
            <ol className="lifecycle">
              <li><span>01</span><div><strong>Enroll identity</strong><small>Provision a canonical beacon ID and Ed25519 public key.</small></div></li>
              <li><span>02</span><div><strong>Claim delivery</strong><small>The controller issues an exclusive, expiring task lease.</small></div></li>
              <li><span>03</span><div><strong>Execute once</strong><small>A persistent ledger prevents task replay after restart.</small></div></li>
              <li><span>04</span><div><strong>Accept result</strong><small>Ownership and signature checks complete the task durably.</small></div></li>
            </ol>
          </div>
        </section>

        <section className="content-section" id="architecture">
          <SectionHeading
            eyebrow="Architecture"
            title="One protocol, multiple transport paths"
            description="Every channel shares the same signed identities, encrypted envelopes, task contracts, delivery leases, and result validation rules."
          />
          <div className="architecture-flow" role="img" aria-label="Operator tools connect to the controller, which exchanges encrypted artifacts with GitHub and enrolled beacons">
            <div className="architecture-node">
              <span className="node-label">Operator</span>
              <strong>CLI + Dashboard</strong>
              <small>Tasks, results, activity</small>
            </div>
            <span className="flow-arrow" aria-hidden="true">→</span>
            <div className="architecture-node featured">
              <span className="node-label">Control plane</span>
              <strong>Controller</strong>
              <small>Identity, queue, leases, state</small>
            </div>
            <span className="flow-arrow" aria-hidden="true">⇄</span>
            <div className="architecture-node">
              <span className="node-label">Transport</span>
              <strong>GitHub + Direct APIs</strong>
              <small>Signed, sealed exchange</small>
            </div>
            <span className="flow-arrow" aria-hidden="true">⇄</span>
            <div className="architecture-node">
              <span className="node-label">Endpoint</span>
              <strong>Enrolled Beacon</strong>
              <small>Persistent identity + ledger</small>
            </div>
          </div>
          <div className="workspace-grid">
            {workspaces.map((workspace, index) => (
              <article className="workspace-card" key={workspace.name}>
                <span>0{index + 1}</span>
                <h3>{workspace.name}/</h3>
                <p>{workspace.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="content-section quickstart-section" id="quickstart">
          <SectionHeading
            eyebrow="Quickstart"
            title="From checkout to local control plane"
            description="Use a private repository, separate every credential role, and keep listener bindings on loopback while you validate the environment."
          />
          <div className="steps-layout">
            <div className="steps-nav" aria-label="Quickstart steps">
              <div><span>1</span><strong>Install & verify</strong><small>Pin the toolchain and generate contracts.</small></div>
              <div><span>2</span><strong>Configure roles</strong><small>Set repository, identity, TLS, and API credentials.</small></div>
              <div><span>3</span><strong>Launch locally</strong><small>Start the controller, dashboard, and CLI.</small></div>
            </div>
            <div className="steps-content">
              <CodeBlock title="Install dependencies" code={installCommand} />
              <CodeBlock title="Controller environment" code={controllerConfig} />
              <CodeBlock title="Start the stack" code={launchCommands} />
            </div>
          </div>
          <div className="callout">
            <div className="callout-icon" aria-hidden="true">✓</div>
            <div>
              <strong>Dashboard address</strong>
              <p>Vite binds to <code>127.0.0.1:5173</code>. The controller’s HTTPS and gRPC listeners remain disabled until their explicit enable flags and TLS material are present.</p>
            </div>
            <a href={docsUrl('docs/QUICKSTART.md')}>Open the complete quickstart →</a>
          </div>
        </section>

        <section className="content-section" id="transports">
          <SectionHeading
            eyebrow="Transport catalog"
            title="Choose the path that fits the environment"
            description="GitHub-backed, direct, and relayed paths are interchangeable at the task-contract boundary, while their credentials and operational prerequisites remain distinct."
          />
          <div className="transport-grid">
            {transportGroups.map((group, index) => (
              <article className="transport-card" key={group.title}>
                <div className="transport-index">0{index + 1}</div>
                <p className="eyebrow">{group.eyebrow}</p>
                <h3>{group.title}</h3>
                <p>{group.description}</p>
                <ul>
                  {group.channels.map((channel) => <li key={channel}>{channel}</li>)}
                </ul>
              </article>
            ))}
          </div>
          <p className="section-note">Transport selection never changes task ownership or signature requirements. Review exact permissions, credentials, and environment prerequisites in the channel guide before enabling a path.</p>
        </section>

        <section className="content-section security-section" id="security">
          <div>
            <SectionHeading
              eyebrow="Security model"
              title="Credentials have one job"
              description="OctoC2 separates operator access, beacon access, GitHub API access, encryption keys, and recovery signing material. Values are never interchangeable."
            />
            <div className="security-list">
              <div><span>01</span><p><strong>Operator API token</strong><small>Authorizes dashboard and CLI requests to controller REST/SSE routes.</small></p></div>
              <div><span>02</span><p><strong>Per-beacon API token</strong><small>Binds HTTPS and gRPC requests to one pre-enrolled beacon identity.</small></p></div>
              <div><span>03</span><p><strong>GitHub credential</strong><small>Scopes repository operations; App private keys remain server-side.</small></p></div>
              <div><span>04</span><p><strong>Operator encryption key</strong><small>Seals tasks and decrypts result content independently of API authorization.</small></p></div>
            </div>
          </div>
          <div className="principles-card">
            <p className="eyebrow">Default posture</p>
            <h3>Secure defaults are structural</h3>
            <ul>
              <li><span>✓</span> Network listeners are opt-in and loopback-first.</li>
              <li><span>✓</span> HTTPS requires a valid certificate and hostname.</li>
              <li><span>✓</span> gRPC requires mTLS plus a beacon bearer credential.</li>
              <li><span>✓</span> Tasks and results are signed and identity-bound.</li>
              <li><span>✓</span> Delivery leases and replay state survive restarts.</li>
              <li><span>✓</span> Unsigned remote modules are rejected.</li>
            </ul>
            <a href={docsUrl('docs/PRODUCTION.md')}>Read the operating model →</a>
          </div>
        </section>

        <section className="content-section" id="verification">
          <SectionHeading
            eyebrow="Verification"
            title="Ship evidence with every change"
            description="Run deterministic policy checks first, then execute tests and strict type checks in each workspace touched by the change."
          />
          <div className="verification-layout">
            <CodeBlock title="Repository checks" code={verification} />
            <div className="verification-copy">
              <div><span>1</span><p><strong>Policy</strong><small>Dependencies, workflows, toolchains, generated proto, and documentation stay aligned.</small></p></div>
              <div><span>2</span><p><strong>Behavior</strong><small>Bun tests cover signatures, replay handling, delivery ownership, persistence, and transport behavior.</small></p></div>
              <div><span>3</span><p><strong>Artifacts</strong><small>Builds and smoke tests verify the dashboard, CLI, controller, proxy, and target beacon binaries.</small></p></div>
              <a className="text-link" href={docsUrl('docs/REMEDIATION_TRACEABILITY.md')}>Review verification traceability →</a>
            </div>
          </div>
        </section>

        <section className="guides-section" id="guides">
          <SectionHeading
            eyebrow="Guides"
            title="A complete operator and engineering manual"
            description="Follow the first-run path or jump directly to setup, channels, configuration, operations, recovery, troubleshooting, and development references."
          />
          <div className="guide-grid">
            {guides.map((guide) => (
              <a className="guide-card" href={guide.href} key={guide.title}>
                <span className="guide-label">{guide.label}</span>
                <h3>{guide.title}</h3>
                <p>{guide.description}</p>
                <span className="guide-arrow" aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
        </section>
      </main>

      <footer>
        <div className="footer-brand">
          <img src={logoUrl} alt="" />
          <div><strong>OctoC2</strong><span>Encrypted multi-channel operations</span></div>
        </div>
        <div className="footer-links">
          <a href={docsUrl('docs/README.md')}>Documentation index ↗</a>
          <a href="#quickstart">Quickstart</a>
          <a href="#security">Security</a>
          <a href="#verification">Verification</a>
          <a href="#guides">All guides</a>
          <a href={repositoryUrl}>Repository ↗</a>
        </div>
        <p>Use only on systems and repositories you are explicitly authorized to test.</p>
      </footer>
    </div>
  )
}

export default App
