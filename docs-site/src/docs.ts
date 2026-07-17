export interface DocumentationEntry {
  readonly id: string
  readonly title: string
  readonly label: string
  readonly category: 'Start' | 'Operate' | 'Resilience' | 'Engineering'
  readonly description: string
  readonly sourcePath: string
  readonly load: () => Promise<string>
}

export const DOCUMENTATION = [
  {
    id: 'documentation',
    title: 'Documentation index',
    label: 'All guides',
    category: 'Start',
    description: 'Choose a reading path through the complete operator and engineering manual.',
    sourcePath: 'docs/README.md',
    load: () => import('../../docs/README.md?raw').then((module) => module.default),
  },
  {
    id: 'installation',
    title: 'Installation',
    label: 'Install',
    category: 'Start',
    description: 'Install the pinned toolchain, run each component, and build platform beacon binaries.',
    sourcePath: 'docs/INSTALLATION.md',
    load: () => import('../../docs/INSTALLATION.md?raw').then((module) => module.default),
  },
  {
    id: 'github-setup',
    title: 'GitHub setup',
    label: 'Provision',
    category: 'Start',
    description: 'Configure repositories, the GitHub App, least-privilege permissions, PAT roles, and rotation.',
    sourcePath: 'docs/GITHUB_SETUP.md',
    load: () => import('../../docs/GITHUB_SETUP.md?raw').then((module) => module.default),
  },
  {
    id: 'quickstart',
    title: 'Quickstart',
    label: 'First run',
    category: 'Start',
    description: 'Build and import a pre-enrolled beacon, then verify an accepted ping result.',
    sourcePath: 'docs/QUICKSTART.md',
    load: () => import('../../docs/QUICKSTART.md?raw').then((module) => module.default),
  },
  {
    id: 'architecture',
    title: 'Architecture',
    label: 'Learn',
    category: 'Start',
    description: 'Understand components, identity boundaries, task lifecycle, durable state, and recovery.',
    sourcePath: 'docs/ARCHITECTURE.md',
    load: () => import('../../docs/ARCHITECTURE.md?raw').then((module) => module.default),
  },
  {
    id: 'channels',
    title: 'Channel guide',
    label: 'Transports',
    category: 'Operate',
    description: 'Compare every transport, permission, prerequisite, priority rule, and qualification step.',
    sourcePath: 'docs/CHANNELS.md',
    load: () => import('../../docs/CHANNELS.md?raw').then((module) => module.default),
  },
  {
    id: 'configuration',
    title: 'Configuration',
    label: 'Reference',
    category: 'Operate',
    description: 'Look up controller, listener, beacon, OIDC, recovery, dashboard, and CLI settings.',
    sourcePath: 'docs/CONFIGURATION.md',
    load: () => import('../../docs/CONFIGURATION.md?raw').then((module) => module.default),
  },
  {
    id: 'cli',
    title: 'CLI reference',
    label: 'Commands',
    category: 'Operate',
    description: 'Use setup, enrollment, builds, inventory, tasks, results, proxy, and service commands.',
    sourcePath: 'docs/CLI.md',
    load: () => import('../../docs/CLI.md?raw').then((module) => module.default),
  },
  {
    id: 'dashboard',
    title: 'Dashboard',
    label: 'Interface',
    category: 'Operate',
    description: 'Configure the local operator interface, TLS trust, credential roles, and capability views.',
    sourcePath: 'dashboard/README.md',
    load: () => import('../../dashboard/README.md?raw').then((module) => module.default),
  },
  {
    id: 'operations',
    title: 'Operations & assurance',
    label: 'Assurance',
    category: 'Operate',
    description: 'Apply listener, lifecycle, replay, certificate, result-acceptance, and evidence policy.',
    sourcePath: 'docs/PRODUCTION.md',
    load: () => import('../../docs/PRODUCTION.md?raw').then((module) => module.default),
  },
  {
    id: 'recovery',
    title: 'Recovery',
    label: 'Recover',
    category: 'Resilience',
    description: 'Provision signed records, exact App policies, short-lived leases, renewal, and rotation.',
    sourcePath: 'docs/RECOVERY.md',
    load: () => import('../../docs/RECOVERY.md?raw').then((module) => module.default),
  },
  {
    id: 'proxy',
    title: 'Proxy workflow',
    label: 'Route',
    category: 'Resilience',
    description: 'Configure control and decoy workflows, signed routes, deduplication, and cleanup.',
    sourcePath: 'templates/proxy/README.md',
    load: () => import('../../templates/proxy/README.md?raw').then((module) => module.default),
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    label: 'Diagnose',
    category: 'Resilience',
    description: 'Diagnose GitHub errors, decrypt failures, acknowledgements, proxy, TLS, gRPC, OIDC, and state.',
    sourcePath: 'docs/TROUBLESHOOTING.md',
    load: () => import('../../docs/TROUBLESHOOTING.md?raw').then((module) => module.default),
  },
  {
    id: 'development',
    title: 'Development',
    label: 'Contribute',
    category: 'Engineering',
    description: 'Work with shared contracts, tests, builds, generated protocol bindings, and change checks.',
    sourcePath: 'docs/DEVELOPMENT.md',
    load: () => import('../../docs/DEVELOPMENT.md?raw').then((module) => module.default),
  },
  {
    id: 'verification',
    title: 'Verification evidence',
    label: 'Evidence',
    category: 'Engineering',
    description: 'Trace implementation decisions to tests, live qualifications, and cleanup records.',
    sourcePath: 'docs/REMEDIATION_TRACEABILITY.md',
    load: () => import('../../docs/REMEDIATION_TRACEABILITY.md?raw').then((module) => module.default),
  },
] as const satisfies readonly DocumentationEntry[]

export const DOCUMENTATION_BY_ID: ReadonlyMap<string, DocumentationEntry> = new Map(
  DOCUMENTATION.map((entry) => [entry.id, entry] as const),
)

export const DOCUMENTATION_ID_BY_SOURCE: ReadonlyMap<string, string> = new Map(
  DOCUMENTATION.map((entry) => [entry.sourcePath, entry.id] as const),
)

export function documentationUrl(id: string, anchor = ''): string {
  return `${import.meta.env.BASE_URL}?guide=${encodeURIComponent(id)}${anchor}`
}
