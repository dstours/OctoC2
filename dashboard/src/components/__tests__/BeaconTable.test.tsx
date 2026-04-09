// dashboard/src/components/__tests__/BeaconTable.test.tsx
import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GitHubIssue } from '@/types/github';
import type { ConnectionMode } from '@/types';
import { BeaconTable } from '../BeaconTable';

// ── Mocks ──────────────────────────────────────────────────────────────────────

// vi.hoisted ensures these are defined before vi.mock factory runs (hoisting-safe)
const mockGetBeacons        = vi.hoisted(() => vi.fn());
const mockNavigate          = vi.hoisted(() => vi.fn());
const mockLiveGetBeacons    = vi.hoisted(() => vi.fn());
const mockQueueTask         = vi.hoisted(() => vi.fn().mockResolvedValue({ taskId: 't1' }));
const mockSubscribeEvents   = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// Flexible auth state controlled per test
let mockAuthMode: ConnectionMode = 'api';
let mockAuthPat = 'ghp_test';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    pat:       mockAuthPat,
    mode:      mockAuthMode,
    serverUrl: 'http://localhost:8080',
    latencyMs: null,
    privkey:   null,
    login:     vi.fn(),
    setPrivkey: vi.fn(),
    logout:    vi.fn(),
    isAuthenticated: true,
  }),
}));

// Use regular function (not arrow) so `new GitHubApiClient(...)` works correctly
vi.mock('@/lib/GitHubApiClient', () => ({
  GitHubApiClient: vi.fn(function (this: Record<string, unknown>) {
    this['getBeacons'] = mockGetBeacons;
  }),
}));

vi.mock('@/lib/C2ServerClient', () => ({
  C2ServerClient: vi.fn(function (this: Record<string, unknown>) {
    this['getBeacons']      = mockLiveGetBeacons;
    this['health']          = vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 });
    this['queueTask']       = mockQueueTask;
    this['getResults']      = vi.fn().mockResolvedValue([]);
    this['subscribeEvents'] = mockSubscribeEvents;
  }),
}));

vi.mock('@/lib/coords', () => ({
  getGitHubCoords: () => ({ owner: 'test-owner', repo: 'test-repo' }),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// ── Helpers ────────────────────────────────────────────────────────────────────

const NOW            = new Date().toISOString();
const THIRTY_MIN_AGO = new Date(Date.now() - 31 * 60 * 1000).toISOString();
const TWO_HOURS_AGO  = new Date(Date.now() - 121 * 60 * 1000).toISOString();

function makeIssue(overrides: Partial<GitHubIssue> & { body?: string } = {}): GitHubIssue {
  return {
    number:     1,
    title:      '[beacon] test-host',
    body:       'hostname: test-host\nos: linux\narch: x64\ntentacle: 1',
    state:      'open',
    labels:     [{ id: 1, name: 'infra-node', color: 'ff0000', description: null }],
    user:       null,
    created_at: NOW,
    updated_at: NOW,
    closed_at:  null,
    comments:   0,
    html_url:   'https://github.com/test-owner/test-repo/issues/1',
    ...overrides,
  };
}

/** Creates a fresh QueryClient + wrapper for each test to avoid cache pollution. */
function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

// ── Setup ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockAuthMode = 'api';
  mockAuthPat  = 'ghp_test';
  mockNavigate.mockReset();
  mockGetBeacons.mockReset();
  mockLiveGetBeacons.mockReset();
  mockQueueTask.mockReset();
  mockQueueTask.mockResolvedValue({ taskId: 't1' });
  mockSubscribeEvents.mockReset();
  mockSubscribeEvents.mockResolvedValue(undefined);
  // Default: single beacon, active status (NOW updated_at)
  mockGetBeacons.mockResolvedValue([makeIssue()]);
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('BeaconTable', () => {

  // ── Loading ──────────────────────────────────────────────────────────────────

  describe('loading state', () => {
    it('shows loading message while data is fetching', () => {
      mockGetBeacons.mockReturnValue(new Promise(() => {})); // never resolves
      render(<BeaconTable />, { wrapper: makeWrapper() });
      expect(screen.getByText(/loading beacons/i)).toBeInTheDocument();
    });
  });

  // ── Offline / empty ──────────────────────────────────────────────────────────

  describe('offline mode', () => {
    it('shows connect prompt instead of table when mode is offline', () => {
      mockAuthMode = 'offline';
      render(<BeaconTable />, { wrapper: makeWrapper() });
      expect(screen.getByText(/connect/i)).toBeInTheDocument();
      expect(mockGetBeacons).not.toHaveBeenCalled();
    });
  });

  describe('empty state', () => {
    it('shows no active beacons message when query returns empty array', async () => {
      mockGetBeacons.mockResolvedValue([]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      expect(await screen.findByText(/no active beacons/i)).toBeInTheDocument();
    });
  });

  // ── Error ─────────────────────────────────────────────────────────────────────

  describe('error state', () => {
    it('shows error message when query fails', async () => {
      mockGetBeacons.mockRejectedValue(new Error('GitHub API error: 401'));
      render(<BeaconTable />, { wrapper: makeWrapper() });
      expect(await screen.findByText(/github api error: 401/i)).toBeInTheDocument();
    });
  });

  // ── Column headers ────────────────────────────────────────────────────────────

  describe('column headers', () => {
    it('renders all expected column headers', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host'); // wait for data
      expect(screen.getByRole('columnheader', { name: /hostname/i    })).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: /beacon id/i   })).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: /os.*arch/i    })).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: /tentacle/i    })).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: /last seen/i   })).toBeInTheDocument();
    });
  });

  // ── Beacon row data ──────────────────────────────────────────────────────────

  describe('beacon rows', () => {
    it('renders the beacon hostname', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      expect(await screen.findByText('test-host')).toBeInTheDocument();
    });

    it('renders the beacon id (beacon-{n} format)', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      expect(screen.getByText('beacon-1')).toBeInTheDocument();
    });

    it('renders os/arch combined in one cell', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      expect(screen.getByText('linux/x64')).toBeInTheDocument();
    });

    it('renders the active tentacle badge with T{n} and name', async () => {
      mockGetBeacons.mockResolvedValue([
        makeIssue({ body: 'hostname: relay\nos: windows\narch: x64\ntentacle: 4' }),
      ]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('relay');
      // T4 = Codespaces
      expect(screen.getByText(/T4.*Codespaces/)).toBeInTheDocument();
    });

    it('renders the relative last seen time', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      // just now (updated_at = NOW)
      expect(screen.getByText(/just now/i)).toBeInTheDocument();
    });

    it('renders a View button in the actions column', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      expect(screen.getByRole('button', { name: /view/i })).toBeInTheDocument();
    });

    it('renders multiple beacon rows when multiple issues returned', async () => {
      mockGetBeacons.mockResolvedValue([
        makeIssue({ number: 1, body: 'hostname: alpha\nos: linux\ntentacle: 1',   updated_at: NOW            }),
        makeIssue({ number: 2, body: 'hostname: beta\nos:  windows\ntentacle: 2', updated_at: THIRTY_MIN_AGO }),
      ]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      expect(await screen.findByText('alpha')).toBeInTheDocument();
      expect(screen.getByText('beta')).toBeInTheDocument();
    });
  });

  // ── Status dots ───────────────────────────────────────────────────────────────

  describe('status dots', () => {
    it('renders active dot (title="active") for a recently updated beacon', async () => {
      mockGetBeacons.mockResolvedValue([makeIssue({ updated_at: NOW })]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      expect(document.querySelector('[title="active"]')).toBeInTheDocument();
    });

    it('renders stale dot (title="stale") for a 31-minute-old beacon', async () => {
      mockGetBeacons.mockResolvedValue([makeIssue({ updated_at: THIRTY_MIN_AGO })]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      expect(document.querySelector('[title="stale"]')).toBeInTheDocument();
    });

    it('renders dead dot (title="dead") for a 2-hour-old beacon', async () => {
      mockGetBeacons.mockResolvedValue([makeIssue({ updated_at: TWO_HOURS_AGO })]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      expect(document.querySelector('[title="dead"]')).toBeInTheDocument();
    });
  });

  // ── Sorting ───────────────────────────────────────────────────────────────────

  describe('sorting', () => {
    const twoBeacons = () => [
      makeIssue({ number: 1, body: 'hostname: older-host\nos: linux\ntentacle: 1',  updated_at: THIRTY_MIN_AGO }),
      makeIssue({ number: 2, body: 'hostname: newer-host\nos: linux\ntentacle: 1',  updated_at: NOW            }),
    ];

    it('renders most recently updated beacon first by default (lastSeen desc)', async () => {
      mockGetBeacons.mockResolvedValue(twoBeacons());
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('newer-host');

      const rows = screen.getAllByRole('row');
      // rows[0] = header, rows[1] = first data row, rows[2] = second
      expect(within(rows[1]!).getByText('newer-host')).toBeInTheDocument();
      expect(within(rows[2]!).getByText('older-host')).toBeInTheDocument();
    });

    it('changing sort dropdown to lastSeen asc shows oldest first', async () => {
      mockGetBeacons.mockResolvedValue(twoBeacons());
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('newer-host');

      fireEvent.change(screen.getByRole('combobox', { name: /sort beacons/i }), {
        target: { value: 'lastSeen_asc' },
      });

      const rows = screen.getAllByRole('row');
      expect(within(rows[1]!).getByText('older-host')).toBeInTheDocument();
      expect(within(rows[2]!).getByText('newer-host')).toBeInTheDocument();
    });

    it('changing sort dropdown to hostname A→Z sorts alphabetically', async () => {
      mockGetBeacons.mockResolvedValue(twoBeacons());
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('newer-host');

      fireEvent.change(screen.getByRole('combobox', { name: /sort beacons/i }), {
        target: { value: 'hostname_asc' },
      });

      const rows = screen.getAllByRole('row');
      expect(within(rows[1]!).getByText('newer-host')).toBeInTheDocument();
      expect(within(rows[2]!).getByText('older-host')).toBeInTheDocument();
    });
  });

  // ── Filtering ──────────────────────────────────────────────────────────────

  describe('filtering', () => {
    const multiBeacons = () => [
      makeIssue({ number: 1, body: 'hostname: active-linux\nos: linux\ntentacle: 1',   updated_at: NOW            }),
      makeIssue({ number: 2, body: 'hostname: stale-win\nos: windows\ntentacle: 1',    updated_at: THIRTY_MIN_AGO }),
      makeIssue({ number: 3, body: 'hostname: dead-linux\nos: linux\ntentacle: 1',     updated_at: TWO_HOURS_AGO  }),
    ];

    it('renders the filter bar when beacons are loaded', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      expect(screen.getByTestId('beacon-filter-bar')).toBeInTheDocument();
    });

    it('filter bar contains status, OS, tentacle, search and sort controls', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      expect(screen.getByRole('combobox', { name: /filter by status/i })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /filter by os/i })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /filter by tentacle/i })).toBeInTheDocument();
      expect(screen.getByRole('textbox',  { name: /search beacons/i })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /sort beacons/i })).toBeInTheDocument();
    });

    it('filtering by status=active hides stale and dead beacons', async () => {
      mockGetBeacons.mockResolvedValue(multiBeacons());
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('active-linux');

      fireEvent.change(screen.getByRole('combobox', { name: /filter by status/i }), {
        target: { value: 'active' },
      });

      expect(screen.getByText('active-linux')).toBeInTheDocument();
      expect(screen.queryByText('stale-win')).not.toBeInTheDocument();
      expect(screen.queryByText('dead-linux')).not.toBeInTheDocument();
    });

    it('filtering by os=windows shows only windows beacon', async () => {
      mockGetBeacons.mockResolvedValue(multiBeacons());
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('active-linux');

      fireEvent.change(screen.getByRole('combobox', { name: /filter by os/i }), {
        target: { value: 'windows' },
      });

      expect(screen.queryByText('active-linux')).not.toBeInTheDocument();
      expect(screen.getByText('stale-win')).toBeInTheDocument();
      expect(screen.queryByText('dead-linux')).not.toBeInTheDocument();
    });

    it('search box filters beacons by hostname substring (case-insensitive)', async () => {
      mockGetBeacons.mockResolvedValue(multiBeacons());
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('active-linux');

      fireEvent.change(screen.getByRole('textbox', { name: /search beacons/i }), {
        target: { value: 'ACTIVE' },
      });

      expect(screen.getByText('active-linux')).toBeInTheDocument();
      expect(screen.queryByText('stale-win')).not.toBeInTheDocument();
      expect(screen.queryByText('dead-linux')).not.toBeInTheDocument();
    });

    it('shows "no beacons match" message when filters exclude all results', async () => {
      mockGetBeacons.mockResolvedValue(multiBeacons());
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('active-linux');

      fireEvent.change(screen.getByRole('textbox', { name: /search beacons/i }), {
        target: { value: 'zzznomatch' },
      });

      expect(screen.getByText(/no beacons match/i)).toBeInTheDocument();
    });

    it('displays visible/total count in filter bar', async () => {
      mockGetBeacons.mockResolvedValue(multiBeacons());
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('active-linux');

      // All 3 visible initially → shows "3/3"
      expect(screen.getByText('3/3')).toBeInTheDocument();

      fireEvent.change(screen.getByRole('combobox', { name: /filter by status/i }), {
        target: { value: 'active' },
      });

      // After filtering to active only → shows "1/3"
      expect(screen.getByText('1/3')).toBeInTheDocument();
    });
  });

  // ── Global search ─────────────────────────────────────────────────────────────

  describe('global search', () => {
    const osBeacons = () => [
      makeIssue({ number: 1, body: 'hostname: host-alpha\nos: linux\ntentacle: 1',   updated_at: NOW }),
      makeIssue({ number: 2, body: 'hostname: host-beta\nos:  windows\ntentacle: 1', updated_at: NOW }),
    ];

    it('query "linux" matches beacon with os:linux and excludes os:windows', async () => {
      mockGetBeacons.mockResolvedValue(osBeacons());
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('host-alpha');

      fireEvent.change(screen.getByRole('textbox', { name: /search beacons/i }), {
        target: { value: 'linux' },
      });

      expect(screen.getByText('host-alpha')).toBeInTheDocument();
      expect(screen.queryByText('host-beta')).not.toBeInTheDocument();
    });

    it('query "beacon-uuid-" matches beacon by id substring', async () => {
      mockGetBeacons.mockResolvedValue([
        makeIssue({ number: 42, body: 'hostname: my-host\nos: linux\ntentacle: 1', updated_at: NOW }),
      ]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('my-host');

      // beacon id for issue #42 is "beacon-42" — searching "beacon-" matches it
      fireEvent.change(screen.getByRole('textbox', { name: /search beacons/i }), {
        target: { value: 'beacon-' },
      });

      expect(screen.getByText('my-host')).toBeInTheDocument();
    });

    it('Cmd+K focuses the search input', async () => {
      const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus');
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
      expect(focusSpy).toHaveBeenCalled();
      focusSpy.mockRestore();
    });
  });

  // ── Multi-select ──────────────────────────────────────────────────────────────

  describe('multi-select', () => {
    it('checkbox in row becomes checked when clicked', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');

      const checkbox = screen.getByRole('checkbox', { name: /select beacon beacon-1/i });
      expect(checkbox).not.toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).toBeChecked();
    });

    it('select-all checkbox selects all visible beacons', async () => {
      mockGetBeacons.mockResolvedValue([
        makeIssue({ number: 1, body: 'hostname: host-a\nos: linux\ntentacle: 1', updated_at: NOW }),
        makeIssue({ number: 2, body: 'hostname: host-b\nos: linux\ntentacle: 1', updated_at: NOW }),
      ]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('host-a');

      const selectAll = screen.getByRole('checkbox', { name: /select all beacons/i });
      fireEvent.click(selectAll);

      expect(screen.getByRole('checkbox', { name: /select beacon beacon-1/i })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: /select beacon beacon-2/i })).toBeChecked();
    });

    it('BulkActionBar appears when at least one beacon is selected', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');

      expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('checkbox', { name: /select beacon beacon-1/i }));

      expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();
      expect(screen.getByText('1 selected')).toBeInTheDocument();
    });

    it('Clear button clears selection and hides BulkActionBar', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');

      fireEvent.click(screen.getByRole('checkbox', { name: /select beacon beacon-1/i }));
      expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /clear selection/i }));

      expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: /select beacon beacon-1/i })).not.toBeChecked();
    });
  });

  // ── Navigation ────────────────────────────────────────────────────────────────

  describe('navigation', () => {
    it('clicking a row navigates to /beacon/:id', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');

      // Click the hostname cell — it's inside the row
      fireEvent.click(screen.getByText('test-host'));
      expect(mockNavigate).toHaveBeenCalledWith('/beacon/beacon-1');
    });

    it('clicking the View button navigates to /beacon/:id', async () => {
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');

      fireEvent.click(screen.getByRole('button', { name: /view/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/beacon/beacon-1');
    });
  });

  // ── Bulk actions expansion ────────────────────────────────────────────────

  describe('bulk actions expansion', () => {
    /** Helper: render in live mode with one beacon selected */
    async function renderLiveWithSelection() {
      mockAuthMode = 'live';
      mockLiveGetBeacons.mockResolvedValue([{
        id: 'b1', hostname: 'live-host', os: 'linux', arch: 'x64',
        status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 1,
        issueNumber: 10, publicKey: 'pk', username: 'root',
      }]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('live-host');
      fireEvent.click(screen.getByRole('checkbox', { name: /select beacon b1/i }));
      expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();
    }

    /** Helper: render in api mode with one beacon selected */
    async function renderApiWithSelection() {
      mockGetBeacons.mockResolvedValue([makeIssue()]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      fireEvent.click(screen.getByRole('checkbox', { name: /select beacon beacon-1/i }));
      expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();
    }

    it('Queue load-module button appears in bulk action bar', async () => {
      await renderLiveWithSelection();
      expect(screen.getByRole('button', { name: /queue load-module task/i })).toBeInTheDocument();
    });

    it('Queue load-module calls queueTask with correct args', async () => {
      await renderLiveWithSelection();
      fireEvent.change(screen.getByRole('textbox', { name: /module name/i }), {
        target: { value: 'mymodule' },
      });
      fireEvent.click(screen.getByRole('button', { name: /queue load-module task/i }));
      expect(mockQueueTask).toHaveBeenCalledWith('b1', 'load-module', { name: 'mymodule' });
    });

    it('Persist dropdown has expected options', async () => {
      await renderLiveWithSelection();
      const select = screen.getByRole('combobox', { name: /persistence method/i });
      const options = Array.from(select.querySelectorAll('option')).map(o => o.value);
      expect(options).toContain('auto');
      expect(options).toContain('crontab');
      expect(options).toContain('launchd');
      expect(options).toContain('registry');
      expect(options).toContain('gh-runner');
    });

    it('Persist button disabled in non-live mode', async () => {
      await renderApiWithSelection();
      expect(screen.getByRole('button', { name: /queue persist task/i })).toBeDisabled();
    });

    it('OpenHulud dropdown has expected actions', async () => {
      await renderLiveWithSelection();
      const select = screen.getByRole('combobox', { name: /evasion action/i });
      const options = Array.from(select.querySelectorAll('option')).map(o => o.value);
      expect(options).toContain('hide');
      expect(options).toContain('anti_debug');
      expect(options).toContain('sleep');
      expect(options).toContain('self_delete');
      expect(options).toContain('status');
      expect(options).toContain('propagate');
    });

    it('OpenHulud button calls confirm before queuing', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await renderLiveWithSelection();
      fireEvent.click(screen.getByRole('button', { name: /queue openhulud task/i }));
      expect(window.confirm).toHaveBeenCalled();
      expect(mockQueueTask).toHaveBeenCalledWith('b1', 'openhulud', expect.objectContaining({ action: 'hide' }));
      vi.restoreAllMocks();
    });

    it('OpenHulud button does not queue when confirm cancelled', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      await renderLiveWithSelection();
      fireEvent.click(screen.getByRole('button', { name: /queue openhulud task/i }));
      expect(window.confirm).toHaveBeenCalled();
      expect(mockQueueTask).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('Persist button calls confirm before queuing', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await renderLiveWithSelection();
      fireEvent.click(screen.getByRole('button', { name: /queue persist task/i }));
      expect(window.confirm).toHaveBeenCalled();
      expect(mockQueueTask).toHaveBeenCalledWith('b1', 'evasion', expect.objectContaining({ action: 'persist' }));
      vi.restoreAllMocks();
    });

    it('Persist button does not queue when confirm cancelled', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      await renderLiveWithSelection();
      fireEvent.click(screen.getByRole('button', { name: /queue persist task/i }));
      expect(window.confirm).toHaveBeenCalled();
      expect(mockQueueTask).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('Stego dropdown has expected actions', async () => {
      await renderLiveWithSelection();
      const select = screen.getByRole('combobox', { name: /stego action/i });
      const options = Array.from(select.querySelectorAll('option')).map(o => o.value);
      expect(options).toContain('ack');
      expect(options).toContain('encode');
      expect(options).toContain('decode');
    });

    it('Stego button calls confirm before queuing', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      await renderLiveWithSelection();
      fireEvent.click(screen.getByRole('button', { name: /queue stego task/i }));
      expect(window.confirm).toHaveBeenCalled();
      expect(mockQueueTask).toHaveBeenCalledWith('b1', 'stego', expect.objectContaining({ action: 'encode' }));
      vi.restoreAllMocks();
    });

    it('Stego button does not queue when confirm cancelled', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      await renderLiveWithSelection();
      fireEvent.click(screen.getByRole('button', { name: /queue stego task/i }));
      expect(window.confirm).toHaveBeenCalled();
      expect(mockQueueTask).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it('Stego button disabled in non-live mode', async () => {
      await renderApiWithSelection();
      expect(screen.getByRole('button', { name: /queue stego task/i })).toBeDisabled();
    });

    it('View Results link appears and points to /results?beacons=<ids>', async () => {
      await renderLiveWithSelection();
      const link = screen.getByRole('link', { name: /view results/i });
      expect(link).toBeInTheDocument();
      expect(link.getAttribute('href')).toMatch(/\/results\?beacons=b1/);
    });
  });

  // ── Live mode ─────────────────────────────────────────────────────────────

  describe('live mode', () => {
    it('uses C2ServerClient (not GitHubApiClient) when mode is live', async () => {
      mockAuthMode = 'live';
      mockLiveGetBeacons.mockResolvedValue([{
        id: 'b1', hostname: 'live-host', os: 'linux', arch: 'x64',
        status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 1,
        issueNumber: 10, publicKey: 'pk', username: 'root',
      }]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      expect(await screen.findByText('live-host')).toBeInTheDocument();
      expect(mockGetBeacons).not.toHaveBeenCalled();
    });

    it('shows beacon id from server (no beacon- prefix transformation)', async () => {
      mockAuthMode = 'live';
      mockLiveGetBeacons.mockResolvedValue([{
        id: 'b1', hostname: 'live-host', os: 'linux', arch: 'x64',
        status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 1,
      }]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('live-host');
      expect(screen.getByText('b1')).toBeInTheDocument();
    });

    it('renders sse-indicator element in live mode', async () => {
      mockAuthMode = 'live';
      mockLiveGetBeacons.mockResolvedValue([{
        id: 'b1', hostname: 'live-host', os: 'linux', arch: 'x64',
        status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 1,
      }]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('live-host');
      expect(screen.getByTestId('sse-indicator')).toBeInTheDocument();
    });

    it('does not render sse-indicator in api mode', async () => {
      mockAuthMode = 'api';
      mockGetBeacons.mockResolvedValue([makeIssue()]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('test-host');
      expect(screen.queryByTestId('sse-indicator')).toBeNull();
    });

    it('calls subscribeEvents when mode is live', async () => {
      mockAuthMode = 'live';
      mockLiveGetBeacons.mockResolvedValue([{
        id: 'b1', hostname: 'live-host', os: 'linux', arch: 'x64',
        status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 1,
      }]);
      render(<BeaconTable />, { wrapper: makeWrapper() });
      await screen.findByText('live-host');
      expect(mockSubscribeEvents).toHaveBeenCalled();
    });
  });
});
