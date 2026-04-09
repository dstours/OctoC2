// dashboard/src/pages/__tests__/TentacleMonitorPage.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TentacleMonitorPage } from '../TentacleMonitorPage';
import type { Beacon } from '@/types';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockLiveGetBeacons  = vi.hoisted(() => vi.fn());
const mockSubscribeEvents = vi.hoisted(() => vi.fn());

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    pat: 'ghp_test', mode: 'live', serverUrl: 'http://localhost:8080',
    privkey: null, latencyMs: null, login: vi.fn(), logout: vi.fn(),
    setPrivkey: vi.fn(), isAuthenticated: true,
  }),
}));

vi.mock('@/lib/C2ServerClient', () => ({
  C2ServerClient: vi.fn(function (this: Record<string, unknown>) {
    this['getBeacons']      = mockLiveGetBeacons;
    this['health']          = vi.fn();
    this['queueTask']       = vi.fn();
    this['getResults']      = vi.fn();
    this['subscribeEvents'] = mockSubscribeEvents;
  }),
}));

vi.mock('@/lib/coords', () => ({
  getGitHubCoords: () => ({ owner: 'test-owner', repo: 'test-repo' }),
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
  );
}

// Helper to make a beacon with a given last-seen offset in ms
function makeBeacon(
  id: string,
  activeTentacle: Beacon['activeTentacle'],
  msPast = 0,
): Beacon {
  return {
    id,
    hostname: `host-${id}`,
    os: 'linux',
    arch: 'x64',
    status: 'active',
    lastSeen: new Date(Date.now() - msPast).toISOString(),
    activeTentacle,
  };
}

// Default subscribeEvents to a never-resolving promise (simulates open SSE connection)
beforeEach(() => {
  mockSubscribeEvents.mockReset().mockImplementation(() => new Promise(() => {}));
});

// ── Existing tests (unchanged) ─────────────────────────────────────────────────

describe('TentacleMonitorPage', () => {
  it('renders all 12 tentacle cells by name', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    const names = ['Issues', 'Branch', 'Actions', 'Codespaces', 'Pages',
                   'Gists', 'OIDC', 'PR\\+SSH', 'Stego', '^Proxy$'];
    for (const name of names) {
      expect(await screen.findByText(new RegExp(name, 'i'))).toBeInTheDocument();
    }
  });

  it('shows active status for T1 when a beacon uses tentacle 1', async () => {
    const beacon: Beacon = {
      id: 'b1', hostname: 'host', os: 'linux', arch: 'x64',
      status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 1,
    };
    mockLiveGetBeacons.mockResolvedValue([beacon]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    expect(screen.getByTestId('tentacle-cell-1')).toHaveTextContent('1 beacon');
  });

  it('shows idle status for tentacles with no beacons', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    const cells = screen.getAllByTestId(/tentacle-cell-/);
    expect(cells).toHaveLength(12);
    for (const cell of cells) {
      expect(cell).toHaveTextContent(/idle/i);
    }
  });

  it('renders all 12 tentacle cells including Notes and Relay', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    expect(await screen.findByText(/Notes/i)).toBeInTheDocument();
    expect(screen.getByText(/Relay/i)).toBeInTheDocument();
    const cells = screen.getAllByTestId(/tentacle-cell-/);
    expect(cells).toHaveLength(12);
  });

  it('shows correct beacon count when multiple beacons use the same tentacle', async () => {
    const beacons: Beacon[] = [
      { id: 'b1', hostname: 'h1', os: 'linux', arch: 'x64', status: 'active',
        lastSeen: new Date().toISOString(), activeTentacle: 1 },
      { id: 'b2', hostname: 'h2', os: 'windows', arch: 'x64', status: 'active',
        lastSeen: new Date().toISOString(), activeTentacle: 1 },
    ];
    mockLiveGetBeacons.mockResolvedValue(beacons);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    expect(screen.getByTestId('tentacle-cell-1')).toHaveTextContent('2 beacons');
  });

  describe('Recovery Status panel', () => {
    it('renders the Recovery Status heading', async () => {
      mockLiveGetBeacons.mockResolvedValue([]);
      render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
      expect(await screen.findByText(/Recovery Status/i)).toBeInTheDocument();
    });

    it('shows Notes beacon count when a beacon uses T11', async () => {
      const beacon: Beacon = {
        id: 'b11', hostname: 'ghost', os: 'linux', arch: 'x64',
        status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 11,
      };
      mockLiveGetBeacons.mockResolvedValue([beacon]);
      render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
      await screen.findByText(/Recovery Status/i);
      expect(screen.getByTestId('recovery-notes-count')).toHaveTextContent('1 beacon');
    });

    it('shows Relay beacon count when a beacon uses T12', async () => {
      const beacon: Beacon = {
        id: 'b12', hostname: 'relay-hop', os: 'linux', arch: 'x64',
        status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 12,
      };
      mockLiveGetBeacons.mockResolvedValue([beacon]);
      render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
      await screen.findByText(/Recovery Status/i);
      expect(screen.getByTestId('recovery-relay-count')).toHaveTextContent('1 beacon');
    });

    it('shows zero counts when no beacons use stealth channels', async () => {
      mockLiveGetBeacons.mockResolvedValue([]);
      render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
      await screen.findByText(/Recovery Status/i);
      expect(screen.getByTestId('recovery-notes-count')).toHaveTextContent('0 beacons');
      expect(screen.getByTestId('recovery-relay-count')).toHaveTextContent('0 beacons');
    });

    it('shows dead-drop armed status', async () => {
      mockLiveGetBeacons.mockResolvedValue([]);
      render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
      await screen.findByText(/Recovery Status/i);
      expect(screen.getByTestId('recovery-dead-drop')).toHaveTextContent(/armed/i);
    });
  });

  it('shows T4 cell active when a beacon uses gRPC channel (activeTentacle: 4)', async () => {
    const beacon: Beacon = {
      id: 'b4', hostname: 'grpc-host', os: 'linux', arch: 'x64',
      status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 4,
    };
    mockLiveGetBeacons.mockResolvedValue([beacon]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    expect(screen.getByTestId('tentacle-cell-4')).toHaveTextContent('1 beacon');
  });

  it('counts beacons with missing activeTentacle as T1 (Issues channel)', async () => {
    const beacon = {
      id: 'b-no-tentacle',
      hostname: 'ghost',
      os: 'linux' as const,
      arch: 'x64' as const,
      status: 'active' as const,
      lastSeen: new Date().toISOString(),
      activeTentacle: undefined as unknown as import('@/types').TentacleId,
    };
    mockLiveGetBeacons.mockResolvedValue([beacon]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    // Beacon with undefined activeTentacle must register as T1, not disappear
    expect(screen.getByTestId('tentacle-cell-1')).toHaveTextContent('1 beacon');
  });
});

describe('ProxyPanel', () => {
  it('renders the Proxy Status heading', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    expect(await screen.findByText(/Proxy Status/i)).toBeInTheDocument();
  });

  it('shows "0 beacons" when no beacons use T10', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText(/Proxy Status/i);
    expect(screen.getByTestId('proxy-panel-count')).toHaveTextContent('0 beacons');
  });

  it('shows proxy beacon count when a beacon uses T10', async () => {
    const beacon: Beacon = {
      id: 'b10', hostname: 'proxy-host', os: 'linux', arch: 'x64',
      status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 10,
    };
    mockLiveGetBeacons.mockResolvedValue([beacon]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText(/Proxy Status/i);
    expect(screen.getByTestId('proxy-panel-count')).toHaveTextContent('1 beacon');
  });

  it('shows the proxy config env var hint', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText(/Proxy Status/i);
    expect(screen.getByTestId('proxy-panel-hint')).toBeInTheDocument();
  });
});

// ── New tests: health color logic ─────────────────────────────────────────────

describe('TentacleMonitorPage — health color logic', () => {
  it('shows green dot for T1 when beacon seen < 5 min ago', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('g1', 1, 60_000)]); // 1 min ago
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    expect(screen.getByTestId('tentacle-dot-1')).toHaveClass('bg-green-400');
  });

  it('shows yellow dot for T2 when beacon seen 6–29 min ago', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('y2', 2, 10 * 60_000)]); // 10 min ago
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    expect(screen.getByTestId('tentacle-dot-2')).toHaveClass('bg-yellow-400');
  });

  it('shows red dot for T3 when beacon seen 30+ min ago', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('r3', 3, 45 * 60_000)]); // 45 min ago
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    expect(screen.getByTestId('tentacle-dot-3')).toHaveClass('bg-red-500');
  });

  it('shows gray dot for tentacle with no beacons ever', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    // T6 (Gists) has no beacons — should be gray
    expect(screen.getByTestId('tentacle-dot-6')).toHaveClass('bg-gray-700');
  });

  it('uses the most recent beacon when multiple use same tentacle for color', async () => {
    // One beacon 45 min ago, one 1 min ago — should be green overall
    mockLiveGetBeacons.mockResolvedValue([
      makeBeacon('old', 1, 45 * 60_000),
      makeBeacon('new', 1, 60_000),
    ]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    expect(screen.getByTestId('tentacle-dot-1')).toHaveClass('bg-green-400');
  });
});

// ── New tests: summary row ────────────────────────────────────────────────────

describe('TentacleMonitorPage — channel summary', () => {
  it('shows "0 of 12 channels active" when no beacons', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId('channel-summary')).toHaveTextContent(
      '0 of 12 channels active',
    );
  });

  it('counts one active channel when one tentacle has a recent beacon', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('a1', 1, 30_000)]); // 30s ago
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId('channel-summary')).toHaveTextContent(
      '1 of 12 channels active',
    );
  });

  it('counts yellow channels as active in summary', async () => {
    // T2 beacon: 10 min ago (yellow)
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('y2', 2, 10 * 60_000)]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId('channel-summary')).toHaveTextContent(
      '1 of 12 channels active',
    );
  });

  it('does not count red or gray tentacles as active', async () => {
    // T3: 45 min ago (red), T4: no beacons (gray)
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('r3', 3, 45 * 60_000)]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId('channel-summary')).toHaveTextContent(
      '0 of 12 channels active',
    );
  });

  it('counts multiple distinct active channels', async () => {
    mockLiveGetBeacons.mockResolvedValue([
      makeBeacon('a1', 1, 30_000),      // green
      makeBeacon('a6', 6, 2 * 60_000),  // green
      makeBeacon('a11', 11, 8 * 60_000), // yellow
    ]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId('channel-summary')).toHaveTextContent(
      '3 of 12 channels active',
    );
  });
});

// ── New tests: last-seen timestamp ────────────────────────────────────────────

describe('TentacleMonitorPage — last-seen display', () => {
  it('shows relative last-seen time on active tentacle cell', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('ls1', 1, 3 * 60_000)]); // 3 min ago
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    expect(screen.getByTestId('tentacle-lastseen-1')).toHaveTextContent('3m ago');
  });

  it('does not show last-seen element for idle tentacle', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    // No beacons on T7 — no last-seen element
    expect(screen.queryByTestId('tentacle-lastseen-7')).not.toBeInTheDocument();
  });
});

// ── New tests: expandable beacon list ────────────────────────────────────────

describe('TentacleMonitorPage — beacon drill-down', () => {
  it('shows expand button when tentacle has beacons', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('e1', 1, 30_000)]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    expect(screen.getByTestId('tentacle-expand-1')).toBeInTheDocument();
  });

  it('does not show expand button for idle tentacle', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    expect(screen.queryByTestId('tentacle-expand-1')).not.toBeInTheDocument();
  });

  it('expands beacon list on click and shows hostname', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('e1', 1, 30_000)]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    fireEvent.click(screen.getByTestId('tentacle-expand-1'));
    expect(screen.getByTestId('tentacle-beacon-list-1')).toBeInTheDocument();
    expect(screen.getByTestId('tentacle-beacon-list-1')).toHaveTextContent('host-e1');
  });

  it('collapses beacon list on second click', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('e1', 1, 30_000)]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    const btn = screen.getByTestId('tentacle-expand-1');
    fireEvent.click(btn);
    expect(screen.getByTestId('tentacle-beacon-list-1')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByTestId('tentacle-beacon-list-1')).not.toBeInTheDocument();
  });

  it('shows all beacons in the expanded list', async () => {
    mockLiveGetBeacons.mockResolvedValue([
      makeBeacon('ea', 1, 30_000),
      makeBeacon('eb', 1, 60_000),
    ]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    fireEvent.click(screen.getByTestId('tentacle-expand-1'));
    const list = screen.getByTestId('tentacle-beacon-list-1');
    expect(list).toHaveTextContent('host-ea');
    expect(list).toHaveTextContent('host-eb');
  });

  it('only one tentacle is expanded at a time', async () => {
    mockLiveGetBeacons.mockResolvedValue([
      makeBeacon('t1', 1, 30_000),
      makeBeacon('t2', 2, 30_000),
    ]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    fireEvent.click(screen.getByTestId('tentacle-expand-1'));
    expect(screen.getByTestId('tentacle-beacon-list-1')).toBeInTheDocument();
    // Opening T2 should close T1
    fireEvent.click(screen.getByTestId('tentacle-expand-2'));
    expect(screen.queryByTestId('tentacle-beacon-list-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('tentacle-beacon-list-2')).toBeInTheDocument();
  });

  it('aria-expanded reflects open/closed state', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('e1', 1, 30_000)]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    const btn = screen.getByTestId('tentacle-expand-1');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });
});

// ── Task 83: SSE + live indicators ───────────────────────────────────────────

describe('Task 83: SSE + live indicators', () => {
  it('renders animate-pulse on green tentacle dot', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('g1', 1, 0)]); // just seen
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByTestId('tentacle-cell-1');
    expect(screen.getByTestId('tentacle-dot-1').className).toContain('animate-pulse');
  });

  it('does not render animate-pulse on gray tentacle dot (no beacons)', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByTestId('tentacle-cell-1');
    expect(screen.getByTestId('tentacle-dot-1').className).not.toContain('animate-pulse');
  });

  it('refetches beacons when beacon-update SSE event is received', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('a1', 1, 30_000)]);
    let emitEvent: ((e: { type: string; beacons: unknown[] }) => void) | undefined;
    mockSubscribeEvents.mockImplementation(
      (cb: (e: { type: string; beacons: unknown[] }) => void) => {
        emitEvent = cb;
        return new Promise(() => {});
      },
    );
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByTestId('channel-summary');
    const initialCalls = mockLiveGetBeacons.mock.calls.length;
    emitEvent!({ type: 'beacon-update', beacons: [] });
    await waitFor(() => {
      expect(mockLiveGetBeacons.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it('shows last-updated timestamp after beacons load', async () => {
    mockLiveGetBeacons.mockResolvedValue([makeBeacon('a1', 1, 30_000)]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId('last-updated')).toBeInTheDocument();
  });
});

// ── New tests: all 12 tentacle kinds appear ──────────────────────────────────

describe('TentacleMonitorPage — all 12 tentacle kinds in grid', () => {
  const ALL_TENTACLE_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

  it('renders a cell with data-testid for each of the 12 tentacle IDs', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    for (const tid of ALL_TENTACLE_IDS) {
      expect(screen.getByTestId(`tentacle-cell-${tid}`)).toBeInTheDocument();
    }
  });

  it('renders a health dot for each of the 12 tentacle cells', async () => {
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    for (const tid of ALL_TENTACLE_IDS) {
      expect(screen.getByTestId(`tentacle-dot-${tid}`)).toBeInTheDocument();
    }
  });

  it('shows each tentacle name in its cell', async () => {
    const EXPECTED_NAMES: Record<number, RegExp> = {
      1:  /issues/i,
      2:  /branch/i,
      3:  /actions/i,
      4:  /codespaces/i,
      5:  /pages/i,
      6:  /gists/i,
      7:  /oidc/i,
      8:  /pr\+ssh/i,
      9:  /stego/i,
      10: /proxy/i,
      11: /notes/i,
      12: /relay/i,
    };
    mockLiveGetBeacons.mockResolvedValue([]);
    render(<TentacleMonitorPage />, { wrapper: makeWrapper() });
    await screen.findByText('Issues');
    for (const [tidStr, pattern] of Object.entries(EXPECTED_NAMES)) {
      const cell = screen.getByTestId(`tentacle-cell-${tidStr}`);
      expect(cell).toHaveTextContent(pattern);
    }
  });
});
