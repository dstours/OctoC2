// dashboard/src/pages/__tests__/MultiBeaconResultsPage.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MultiBeaconResultsPage } from '../MultiBeaconResultsPage';
import type { ServerTask } from '@/lib/C2ServerClient';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockGetResults      = vi.hoisted(() => vi.fn());
const mockAuthPrivkey     = vi.hoisted(() => ({ value: null as string | null }));
const mockDecryptSealedResult = vi.hoisted(() => vi.fn());

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    pat: 'ghp_test', mode: 'live', serverUrl: 'http://localhost:8080',
    privkey: mockAuthPrivkey.value, latencyMs: null,
    login: vi.fn(), logout: vi.fn(), setPrivkey: vi.fn(), isAuthenticated: true,
  }),
}));

vi.mock('@/lib/C2ServerClient', () => ({
  C2ServerClient: vi.fn(function (this: Record<string, unknown>) {
    this['getResults']  = mockGetResults;
    this['getBeacons']  = vi.fn().mockResolvedValue([]);
    this['health']      = vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 });
  }),
}));

vi.mock('@/lib/crypto', () => ({
  decryptSealedResult:               mockDecryptSealedResult,
  deadDropGistKey:                   vi.fn().mockResolvedValue('deadbeef'),
  parseMaintenanceDiagnosticPayload: vi.fn().mockReturnValue(null),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const COMPLETED_TASK: ServerTask = {
  taskId: 'tid-c1', beaconId: 'beacon-aaa', kind: 'shell', args: { cmd: 'whoami' },
  status: 'completed', ref: 'abc', createdAt: new Date().toISOString(),
  deliveredAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  result: { success: true, output: 'root\n', data: '', signature: '' },
};

const FAILED_TASK: ServerTask = {
  taskId: 'tid-f1', beaconId: 'beacon-bbb', kind: 'shell', args: { cmd: 'id' },
  status: 'failed', ref: 'def', createdAt: new Date().toISOString(),
  deliveredAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  result: { success: false, output: '', data: '', signature: '' },
};

function makeWrapper(search = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/results${search}`]}>
        <Routes>
          <Route path="/results" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockGetResults.mockReset().mockResolvedValue([COMPLETED_TASK]);
  mockAuthPrivkey.value = null;
  mockDecryptSealedResult.mockReset();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('MultiBeaconResultsPage', () => {
  it('renders beacon group headings for each beacon in query string', async () => {
    mockGetResults.mockResolvedValue([]);
    render(
      <MultiBeaconResultsPage />,
      { wrapper: makeWrapper('?beacons=beacon-aaa,beacon-bbb') }
    );
    // Short IDs derived from the beacon IDs (strip dashes, take 8 chars)
    await waitFor(() => {
      expect(screen.getByText('[beaconaa]')).toBeInTheDocument();
      expect(screen.getByText('[beaconbb]')).toBeInTheDocument();
    });
  });

  it("renders 'no results' message when beacon has no completed tasks", async () => {
    mockGetResults.mockResolvedValue([]);
    render(
      <MultiBeaconResultsPage />,
      { wrapper: makeWrapper('?beacons=beacon-aaa') }
    );
    await waitFor(() => {
      expect(screen.getByText(/No completed or failed tasks/i)).toBeInTheDocument();
    });
  });

  it('renders task results when completed tasks exist', async () => {
    mockGetResults.mockResolvedValue([COMPLETED_TASK]);
    render(
      <MultiBeaconResultsPage />,
      { wrapper: makeWrapper('?beacons=beacon-aaa') }
    );
    await waitFor(() => {
      expect(screen.getByText('tid-c1')).toBeInTheDocument();
    });
    // Output should be visible
    expect(screen.getByText(/root/)).toBeInTheDocument();
  });

  it('renders failed tasks in the result list', async () => {
    mockGetResults.mockResolvedValue([FAILED_TASK]);
    render(
      <MultiBeaconResultsPage />,
      { wrapper: makeWrapper('?beacons=beacon-bbb') }
    );
    await waitFor(() => {
      expect(screen.getByText('tid-f1')).toBeInTheDocument();
      expect(screen.getByText('failed')).toBeInTheDocument();
    });
  });

  it('renders Back button', async () => {
    mockGetResults.mockResolvedValue([]);
    render(
      <MultiBeaconResultsPage />,
      { wrapper: makeWrapper('?beacons=beacon-aaa') }
    );
    expect(screen.getByText(/back/i)).toBeInTheDocument();
  });
});
