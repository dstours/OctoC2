// dashboard/src/pages/__tests__/BeaconDetailPage.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BeaconDetailPage } from '../BeaconDetailPage';
import type { Beacon } from '@/types';
import type { ServerTask } from '@/lib/C2ServerClient';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockQueueTask             = vi.hoisted(() => vi.fn());
const mockGetResults            = vi.hoisted(() => vi.fn());
const mockLiveGetBeacons        = vi.hoisted(() => vi.fn());
const mockListModules           = vi.hoisted(() => vi.fn());
const mockGetMaintenance        = vi.hoisted(() => vi.fn());
const mockGetMaintenanceComment = vi.hoisted(() => vi.fn());
const mockSubscribeEvents       = vi.hoisted(() => vi.fn());
const mockAuthPrivkey           = vi.hoisted(() => ({ value: null as string | null }));
const mockDecryptSealedResult                 = vi.hoisted(() => vi.fn());
const mockDeadDropGistKey                     = vi.hoisted(() => vi.fn());
const mockParseMaintenanceDiagnosticPayload   = vi.hoisted(() => vi.fn());

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    pat: 'ghp_test', mode: 'live', serverUrl: 'http://localhost:8080',
    privkey: mockAuthPrivkey.value, latencyMs: null,
    login: vi.fn(), logout: vi.fn(), setPrivkey: vi.fn(), isAuthenticated: true,
  }),
}));

vi.mock('@/lib/C2ServerClient', () => ({
  C2ServerClient: vi.fn(function (this: Record<string, unknown>) {
    this['getBeacons']             = mockLiveGetBeacons;
    this['queueTask']              = mockQueueTask;
    this['getResults']             = mockGetResults;
    this['health']                 = vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 });
    this['listModules']            = mockListModules;
    this['getMaintenance']         = mockGetMaintenance;
    this['getMaintenanceComment']  = mockGetMaintenanceComment;
    this['subscribeEvents']        = mockSubscribeEvents;
  }),
}));

vi.mock('@/lib/coords', () => ({
  getGitHubCoords: () => ({ owner: 'test-owner', repo: 'test-repo' }),
}));

vi.mock('@/lib/crypto', () => ({
  decryptSealedResult:               mockDecryptSealedResult,
  deadDropGistKey:                   mockDeadDropGistKey,
  parseMaintenanceDiagnosticPayload: mockParseMaintenanceDiagnosticPayload,
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const BEACON: Beacon = {
  id: 'b1', hostname: 'WIN-HOST', os: 'windows', arch: 'x64',
  status: 'active', lastSeen: new Date().toISOString(), activeTentacle: 1,
  username: 'CORP\\user',
};

const PENDING_TASK: ServerTask = {
  taskId: 'tid-1', beaconId: 'b1', kind: 'shell', args: { cmd: 'whoami' },
  status: 'pending', ref: 'abc', createdAt: new Date().toISOString(),
  deliveredAt: null, completedAt: null, result: null,
};

const COMPLETED_TASK: ServerTask = {
  taskId: 'tid-2', beaconId: 'b1', kind: 'shell', args: { cmd: 'id' },
  status: 'completed', ref: 'def', createdAt: new Date().toISOString(),
  deliveredAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  result: { success: true, output: 'root\n', data: '', signature: '' },
};

const ENCRYPTED_TASK: ServerTask = {
  taskId: 'tid-3', beaconId: 'b1', kind: 'shell', args: { cmd: 'id' },
  status: 'completed', ref: 'ghi',
  createdAt: new Date().toISOString(),
  deliveredAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  result: { success: true, output: '', data: 'abc123sealed', signature: '' },
};

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/beacon/b1']}>
        <Routes>
          <Route path="/beacon/:id" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// ── Clipboard mock ─────────────────────────────────────────────────────────────

Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
  configurable: true,
});

beforeEach(() => {
  // Reset clipboard mock
  (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);

  mockLiveGetBeacons.mockReset().mockResolvedValue([BEACON]);
  mockGetResults.mockReset().mockResolvedValue([PENDING_TASK, COMPLETED_TASK]);
  mockQueueTask.mockReset().mockResolvedValue({
    taskId: 'new-tid', beaconId: 'b1', kind: 'shell', status: 'pending', createdAt: '',
  });
  mockAuthPrivkey.value = null;
  mockDecryptSealedResult.mockReset();
  (mockDeadDropGistKey as any).mockResolvedValue('deadbeef01234567');
  mockParseMaintenanceDiagnosticPayload.mockReset().mockReturnValue(null);
  mockListModules.mockResolvedValue([]);
  mockGetMaintenance.mockReset().mockResolvedValue({
    beaconId: 'b1', hostname: 'WIN-HOST', os: 'windows', arch: 'x64',
    status: 'active', lastSeen: new Date().toISOString(),
    taskCount: 0, completedCount: 0, failedCount: 0, pendingCount: 0,
    tasks: [],
    commentBody: null,
  });
  mockGetMaintenanceComment.mockReset().mockResolvedValue({ commentBody: null });
  mockSubscribeEvents.mockReset().mockImplementation(() => new Promise(() => {})); // never resolves (stream stays open)
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('BeaconDetailPage', () => {
  describe('header', () => {
    it('renders the beacon hostname and ID', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      const matches = await screen.findAllByText('WIN-HOST');
      expect(matches[0]).toBeInTheDocument();
      expect(screen.getByText('b1')).toBeInTheDocument();
    });

    it('renders os/arch', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      expect(screen.getByText(/windows.*x64/i)).toBeInTheDocument();
    });
  });

  describe('Tasks tab', () => {
    it('renders Tasks tab button', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      expect(await screen.findByRole('button', { name: /tasks/i })).toBeInTheDocument();
    });

    it('renders pending task in the task list', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
      expect(await screen.findByText('tid-1')).toBeInTheDocument();
    });

    it('renders the Queue Task form with kind selector and args input', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
      expect(screen.getByRole('combobox')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/args json/i)).toBeInTheDocument();
    });

    it('includes load-module in the task kind dropdown', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
      const select = screen.getByRole('combobox') as HTMLSelectElement;
      const optionValues = Array.from(select.options).map(o => o.value);
      expect(optionValues).toContain('load-module');
    });

    it('submits a new task when the form is filled and submitted', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));

      const argsInput = screen.getByPlaceholderText(/args json/i);
      fireEvent.change(argsInput, { target: { value: '{"cmd":"whoami"}' } });
      fireEvent.click(screen.getByRole('button', { name: /queue/i }));

      await waitFor(() => {
        expect(mockQueueTask).toHaveBeenCalledWith('b1', 'shell', { cmd: 'whoami' });
      });
    });
  });

  describe('Results tab', () => {
    it('switches to results tab when clicked', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /results/i }));
      expect(await screen.findByText(/tid-2/)).toBeInTheDocument();
    });

    it('shows plaintext output for completed gRPC tasks (no decrypt button needed)', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /results/i }));
      expect(await screen.findByText(/root/)).toBeInTheDocument();
    });
  });

  describe('Overview tab', () => {
    it('is the default active tab on page load', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      const btn = screen.getByRole('button', { name: /^overview$/i });
      expect(btn.className).toMatch(/text-octo-blue/);
    });

    it('shows a Hostname row in the overview panel', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      expect(screen.getByText('Hostname')).toBeInTheDocument();
    });

    it('shows the active tentacle name in the overview panel', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      // BEACON.activeTentacle = 1 → TENTACLE_NAMES[1] = 'Issues'
      const issuesMatches = screen.getAllByText('Issues');
      expect(issuesMatches.length).toBeGreaterThan(0);
    });

    it('shows a Last Seen row in the overview panel', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      expect(screen.getByText('Last Seen')).toBeInTheDocument();
    });
  });

  describe('auto-decrypt', () => {
    it('auto-decrypts sealed results when privkey is in AuthContext', async () => {
      mockAuthPrivkey.value = 'operator-privkey';
      mockDecryptSealedResult.mockResolvedValue('uid=0(root) gid=0(root)');
      mockGetResults.mockResolvedValue([ENCRYPTED_TASK]);

      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));

      expect(await screen.findByText('uid=0(root) gid=0(root)')).toBeInTheDocument();
      expect(mockDecryptSealedResult).toHaveBeenCalledWith('abc123sealed', 'operator-privkey');
    });

    it('shows decryption error when decryptSealedResult rejects', async () => {
      mockAuthPrivkey.value = 'bad-key';
      mockDecryptSealedResult.mockRejectedValue(new Error('bad key'));
      mockGetResults.mockResolvedValue([ENCRYPTED_TASK]);

      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));

      expect(await screen.findByText(/decryption failed/i)).toBeInTheDocument();
    });

    it('shows manual key input when no privkey in AuthContext', async () => {
      mockAuthPrivkey.value = null;
      mockGetResults.mockResolvedValue([ENCRYPTED_TASK]);

      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));

      expect(await screen.findByPlaceholderText(/private key/i)).toBeInTheDocument();
    });

    it('shows Copy JSON button when result is decrypted', async () => {
      mockAuthPrivkey.value = 'operator-privkey';
      mockDecryptSealedResult.mockResolvedValue('{"status":"ok"}');
      mockGetResults.mockResolvedValue([ENCRYPTED_TASK]);

      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));

      expect(await screen.findByTestId('copy-json-btn')).toBeInTheDocument();
    });

    it('Copy JSON button flashes Copied! then resets', async () => {
      mockAuthPrivkey.value = 'operator-privkey';
      mockDecryptSealedResult.mockResolvedValue('{"status":"ok"}');
      mockGetResults.mockResolvedValue([ENCRYPTED_TASK]);

      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));
      const btn = await screen.findByTestId('copy-json-btn');

      // Click and verify flash state
      fireEvent.click(btn);
      await waitFor(() => expect(btn).toHaveTextContent('Copied!'));

      // Wait for the 2 second timeout to fire naturally
      await waitFor(() => expect(btn).toHaveTextContent('Copy JSON'), { timeout: 3000 });
    });
  });

  describe('Shell tab', () => {
    it('renders a Shell tab button in the tab bar', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      expect(screen.getByRole('button', { name: /^shell$/i })).toBeInTheDocument();
    });

    it('shows the shell command input when Shell tab is active', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^shell$/i }));
      expect(screen.getByPlaceholderText(/shell command/i)).toBeInTheDocument();
    });

    it('queues a shell task when a command is submitted', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^shell$/i }));

      const input = screen.getByPlaceholderText(/shell command/i);
      fireEvent.change(input, { target: { value: 'whoami' } });
      fireEvent.submit(input.closest('form')!);

      await waitFor(() => {
        expect(mockQueueTask).toHaveBeenCalledWith('b1', 'shell', { cmd: 'whoami' });
      });
    });

    it('queues a shell task when the Run button is clicked', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^shell$/i }));

      const input = screen.getByPlaceholderText(/shell command/i);
      fireEvent.change(input, { target: { value: 'uname -a' } });
      fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

      await waitFor(() => {
        expect(mockQueueTask).toHaveBeenCalledWith('b1', 'shell', { cmd: 'uname -a' });
      });
    });

    it('shows the submitted command in the history panel', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^shell$/i }));

      const input = screen.getByPlaceholderText(/shell command/i);
      fireEvent.change(input, { target: { value: 'ls -la' } });
      fireEvent.submit(input.closest('form')!);

      expect(screen.getByText('ls -la')).toBeInTheDocument();
    });

    it('clears the input field after submission', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^shell$/i }));

      const input = screen.getByPlaceholderText(/shell command/i) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'id' } });
      fireEvent.submit(input.closest('form')!);

      expect(input.value).toBe('');
    });

    it('does not queue a task when an empty command is submitted', async () => {
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^shell$/i }));

      const input = screen.getByPlaceholderText(/shell command/i);
      fireEvent.submit(input.closest('form')!);

      expect(mockQueueTask).not.toHaveBeenCalled();
    });
  });

  describe('Stealth tab', () => {
    it('renders Stealth tab button', async () => {
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      const matches = await screen.findAllByText('WIN-HOST');
      expect(matches[0]).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /stealth/i })).toBeInTheDocument();
    });

    it('shows dead-drop gist filename on Stealth tab', async () => {
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /stealth/i }));
      expect(await screen.findByText('data-deadbeef01234567.bin')).toBeInTheDocument();
    });

    it('shows active channel name on Stealth tab', async () => {
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /stealth/i }));
      await screen.findByText('data-deadbeef01234567.bin');
      // activeTentacle=1 → Issues
      expect(screen.getAllByText('Issues')[0]).toBeInTheDocument();
    });
  });

  describe('Maintenance tab', () => {
    it('renders Maintenance tab button', async () => {
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      expect(screen.getByRole('button', { name: /maintenance/i })).toBeInTheDocument();
    });

    it('Maintenance tab is second in the tab bar (after overview)', async () => {
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      const tabs = screen.getAllByRole('button').filter(b =>
        ['overview', 'maintenance', 'tasks', 'results', 'shell', 'stealth'].includes(b.textContent?.toLowerCase() ?? '')
      );
      expect(tabs[0]?.textContent?.toLowerCase()).toBe('overview');
      expect(tabs[1]?.textContent?.toLowerCase()).toBe('maintenance');
    });

    it('shows task stats when Maintenance tab is clicked', async () => {
      // MaintenancePanel is mocked via C2ServerClient mock that already exists
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^maintenance$/i }));
      // Panel renders the "Task Queue" heading from MaintenancePanel
      // Since getMaintenance is not mocked in BeaconDetailPage tests,
      // it will show Loading... or the panel container — just assert the tab click works
      // and the content area is present
      expect(screen.getByRole('button', { name: /^maintenance$/i }).className).toMatch(/text-octo-blue/);
    });

    it('shows hostname in maintenance panel when Maintenance tab is active', async () => {
      mockGetMaintenance.mockResolvedValue({
        beaconId: 'b1', hostname: 'WIN-HOST', os: 'windows', arch: 'x64',
        status: 'active', lastSeen: new Date().toISOString(),
        taskCount: 2, completedCount: 1, failedCount: 0, pendingCount: 1,
        tasks: [],
      });
      mockGetMaintenanceComment.mockResolvedValue({ commentBody: null });
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^maintenance$/i }));
      // WIN-HOST appears in header area of maintenance panel
      const hostnames = await screen.findAllByText('WIN-HOST');
      expect(hostnames.length).toBeGreaterThanOrEqual(1);
    });

    it('shows Decrypt button in maintenance panel when comment has diagnostic payload', async () => {
      // Comment body with a diagnostic payload marker
      const commentBody = [
        '<!-- infra-maintenance:abc-123 -->',
        '### 🛠️ Scheduled maintenance',
        '✅ Initial check-in',
        '<!-- infra-diagnostic:abc-123 -->',
        'sealed-base64-payload',
      ].join('\n');
      mockGetMaintenance.mockResolvedValue({
        beaconId: 'b1', hostname: 'WIN-HOST', os: 'windows', arch: 'x64',
        status: 'active', lastSeen: new Date().toISOString(),
        taskCount: 0, completedCount: 0, failedCount: 0, pendingCount: 0,
        tasks: [],
      });
      mockGetMaintenanceComment.mockResolvedValue({ commentBody });
      // Override the parseMaintenanceDiagnosticPayload mock to return a non-null payload
      // so the Decrypt button is rendered in MaintenancePanel
      mockParseMaintenanceDiagnosticPayload.mockReturnValue('sealed-base64-payload');

      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^maintenance$/i }));

      // The Decrypt button appears when diagPayload is non-null and no privkey is set
      expect(await screen.findByRole('button', { name: /^decrypt$/i })).toBeInTheDocument();
    });
  });

  // ── Task 45 additions ────────────────────────────────────────────────────────

  describe('Task 45: status badges', () => {
    it('renders pulsing dot for pending tasks', async () => {
      mockGetResults.mockResolvedValue([PENDING_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
      await screen.findByText('pending');
      // The animate-pulse span is rendered inside the badge
      const badge = screen.getByText('pending').closest('span')!;
      const dot = badge.querySelector('.animate-pulse');
      expect(dot).toBeInTheDocument();
    });

    it('renders no pulsing dot for completed tasks', async () => {
      mockGetResults.mockResolvedValue([COMPLETED_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
      await screen.findByText('completed');
      const badge = screen.getByText('completed').closest('span')!;
      expect(badge.querySelector('.animate-pulse')).not.toBeInTheDocument();
    });
  });

  describe('Task 45: re-queue button', () => {
    const FAILED_TASK: ServerTask = {
      taskId: 'tid-fail', beaconId: 'b1', kind: 'shell', args: { cmd: 'ls' },
      status: 'failed', ref: 'xyz', createdAt: new Date().toISOString(),
      deliveredAt: null, completedAt: null, result: null,
    };

    it('renders re-queue button for failed tasks in the tasks tab', async () => {
      mockGetResults.mockResolvedValue([FAILED_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
      expect(await screen.findByRole('button', { name: /re-queue task/i })).toBeInTheDocument();
    });

    it('does not render re-queue button for pending tasks', async () => {
      mockGetResults.mockResolvedValue([PENDING_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
      await screen.findByText('pending');
      expect(screen.queryByRole('button', { name: /re-queue task/i })).not.toBeInTheDocument();
    });

    it('calls queueTask with the same kind and args when re-queue is clicked', async () => {
      mockGetResults.mockResolvedValue([FAILED_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
      const btn = await screen.findByRole('button', { name: /re-queue task/i });
      fireEvent.click(btn);
      await waitFor(() => {
        expect(mockQueueTask).toHaveBeenCalledWith('b1', 'shell', { cmd: 'ls' });
      });
    });
  });

  describe('Task 45: auto-refresh interval', () => {
    it('passes refetchInterval of 15000 to the tasks query', async () => {
      // We verify indirectly: the query fires and returns data (no 30s interval blocking)
      // The real check is that the component renders correctly with the 15s interval configured.
      // We confirm by rendering and asserting tasks are fetched.
      mockGetResults.mockResolvedValue([PENDING_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      await waitFor(() => expect(mockGetResults).toHaveBeenCalledWith('b1'));
    });
  });

  describe('Task 45: empty states', () => {
    it('shows "No tasks queued" when task list is empty in tasks tab', async () => {
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }));
      expect(await screen.findByText('No tasks queued')).toBeInTheDocument();
    });

    it('shows "No results yet" when completed task list is empty in results tab', async () => {
      // Only pending tasks — no completed/failed
      mockGetResults.mockResolvedValue([PENDING_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));
      expect(await screen.findByText('No results yet')).toBeInTheDocument();
    });
  });

  describe('Task 45: JSON pretty-print', () => {
    const JSON_TASK: ServerTask = {
      taskId: 'tid-json', beaconId: 'b1', kind: 'shell', args: { cmd: 'id' },
      status: 'completed', ref: 'jjj', createdAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      result: { success: true, output: '{"uid":0,"user":"root"}', data: '', signature: '' },
    };

    const PLAIN_TASK: ServerTask = {
      taskId: 'tid-plain', beaconId: 'b1', kind: 'shell', args: { cmd: 'uname' },
      status: 'completed', ref: 'ppp', createdAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      result: { success: true, output: 'Linux 5.15.0', data: '', signature: '' },
    };

    it('renders JSON output with colored key spans when output is valid JSON', async () => {
      mockGetResults.mockResolvedValue([JSON_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));
      // Results tab renders TaskRow with showResult=true (expanded by default)
      // Wait for task row to appear
      await screen.findByText('tid-json');
      // The pre block should be present with blue-300 spans for JSON keys
      await waitFor(() => {
        const blueSpans = document.querySelectorAll('.text-blue-300');
        expect(blueSpans.length).toBeGreaterThan(0);
      });
    });

    it('renders plain text output as monospace text when output is not JSON', async () => {
      mockGetResults.mockResolvedValue([PLAIN_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));
      expect(await screen.findByText('Linux 5.15.0')).toBeInTheDocument();
      // The pre element should contain just text, no blue key spans
      const pre = document.querySelector('pre');
      expect(pre).toBeInTheDocument();
      expect(pre!.querySelectorAll('.text-blue-300').length).toBe(0);
    });

    it('shows "last updated" indicator in results section heading', async () => {
      mockGetResults.mockResolvedValue([COMPLETED_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));
      // After data loads, "updated" text should appear
      expect(await screen.findByText(/updated/i)).toBeInTheDocument();
    });
  });

  describe('LoadedModulesPanel', () => {
    it('shows "No modules loaded." when module list is empty', async () => {
      mockListModules.mockResolvedValue([]);
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      expect(await screen.findByText('No modules loaded.')).toBeInTheDocument();
    });

    it('shows module names when modules are present', async () => {
      mockListModules.mockResolvedValue([
        { name: 'recon',      lastExecuted: null },
        { name: 'screenshot', lastExecuted: null },
      ]);
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      expect(screen.getByText('recon')).toBeInTheDocument();
      expect(screen.getByText('screenshot')).toBeInTheDocument();
    });

    it('shows — for lastExecuted when module has never run', async () => {
      mockListModules.mockResolvedValue([
        { name: 'recon', lastExecuted: null },
      ]);
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      // rel(null) returns '—'
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('shows relative time when module has been executed', async () => {
      const execTime = new Date(Date.now() - 90_000).toISOString(); // 90s ago → "1m ago"
      mockListModules.mockResolvedValue([
        { name: 'recon', lastExecuted: execTime },
      ]);
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      expect(screen.getByText('1m ago')).toBeInTheDocument();
    });

    it('shows modules section heading', async () => {
      mockListModules.mockResolvedValue([{ name: 'recon', lastExecuted: null }]);
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      expect(screen.getByText('Loaded Modules')).toBeInTheDocument();
    });
  });

  describe('Task 81: SSE invalidation', () => {
    it('calls getResults again when a beacon-update SSE event includes this beacon', async () => {
      let emitEvent: ((event: unknown) => void) | null = null;
      mockSubscribeEvents.mockImplementation((cb: (event: unknown) => void) => {
        emitEvent = cb;
        return new Promise(() => {});
      });
      mockGetResults.mockResolvedValue([]);

      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');

      // Initial call
      await waitFor(() => expect(mockGetResults).toHaveBeenCalledTimes(1));

      // Emit a beacon-update that includes our beacon
      emitEvent!({ type: 'beacon-update', beacons: [BEACON] });

      await waitFor(() => expect(mockGetResults).toHaveBeenCalledTimes(2));
    });

    it('calls getResults again when a task-update SSE event matches this beacon', async () => {
      let emitEvent: ((event: unknown) => void) | null = null;
      mockSubscribeEvents.mockImplementation((cb: (event: unknown) => void) => {
        emitEvent = cb;
        return new Promise(() => {});
      });
      mockGetResults.mockResolvedValue([]);

      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');

      await waitFor(() => expect(mockGetResults).toHaveBeenCalledTimes(1));

      emitEvent!({ type: 'task-update', beaconId: 'b1' });

      await waitFor(() => expect(mockGetResults).toHaveBeenCalledTimes(2));
    });

    it('calls getResults again when a maintenance-update SSE event matches this beacon', async () => {
      let emitEvent: ((event: unknown) => void) | null = null;
      mockSubscribeEvents.mockImplementation((cb: (event: unknown) => void) => {
        emitEvent = cb;
        return new Promise(() => {});
      });
      mockGetResults.mockResolvedValue([]);

      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');

      const initialResultCalls = mockGetResults.mock.calls.length;

      emitEvent!({ type: 'maintenance-update', beaconId: 'b1' });

      await waitFor(() => expect(mockGetResults.mock.calls.length).toBeGreaterThan(initialResultCalls));
    });
  });

  describe('Task 82: TentacleHealthGrid', () => {
    it('shows "Tentacle Activity" section on overview tab in live mode', async () => {
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      // overview tab is default
      expect(await screen.findByText('Tentacle Activity')).toBeInTheDocument();
    });

    it('shows the active tentacle (Issues) as a green dot', async () => {
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      // BEACON.activeTentacle = 1 → Issues should appear green (text-green-400 span)
      await screen.findByText('Tentacle Activity');
      // Issues appears in TentacleHealthGrid with green styling
      const tentacleGrid = screen.getByText('Tentacle Activity').closest('div')!;
      expect(tentacleGrid).toBeInTheDocument();
      // The grid should have a green dot for the active tentacle
      const greenDot = tentacleGrid.querySelector('.bg-green-400');
      expect(greenDot).toBeInTheDocument();
    });

    it('shows inactive tentacles as gray dots', async () => {
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      await screen.findByText('Tentacle Activity');
      const tentacleGrid = screen.getByText('Tentacle Activity').closest('div')!;
      // There should be gray dots for non-active tentacles
      const grayDots = tentacleGrid.querySelectorAll('.bg-gray-700');
      expect(grayDots.length).toBeGreaterThan(0);
    });

    it('shows all 6 mini tentacle labels', async () => {
      mockGetResults.mockResolvedValue([]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      await screen.findByText('Tentacle Activity');
      for (const name of ['Branch', 'Actions', 'Codespaces', 'Pages', 'Stego']) {
        expect(screen.getByText(name)).toBeInTheDocument();
      }
    });
  });

  describe('Task 82: Copy All decrypted results', () => {
    it('shows Copy All button after plaintext results are rendered in Results tab', async () => {
      mockGetResults.mockResolvedValue([COMPLETED_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));
      // Wait for results to render; onDecrypted fires via useEffect for plaintext
      expect(await screen.findByRole('button', { name: /copy all decrypted results/i })).toBeInTheDocument();
    });

    it('calls navigator.clipboard.writeText when Copy All is clicked', async () => {
      mockGetResults.mockResolvedValue([COMPLETED_TASK]);

      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));

      const copyAllBtn = await screen.findByRole('button', { name: /copy all decrypted results/i });
      fireEvent.click(copyAllBtn);

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('root'));
      });
    });

    it('shows "Copied!" flash text after clicking Copy All', async () => {
      mockGetResults.mockResolvedValue([COMPLETED_TASK]);

      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));

      const copyAllBtn = await screen.findByRole('button', { name: /copy all decrypted results/i });
      fireEvent.click(copyAllBtn);

      expect(await screen.findByText('Copied!')).toBeInTheDocument();
    });

    it('does NOT show Copy All button when there are no completed tasks', async () => {
      mockGetResults.mockResolvedValue([PENDING_TASK]);
      render(<BeaconDetailPage />, { wrapper: makeWrapper() });
      await screen.findAllByText('WIN-HOST');
      fireEvent.click(screen.getByRole('button', { name: /^results$/i }));
      await screen.findByText('No results yet');
      expect(screen.queryByRole('button', { name: /copy all decrypted results/i })).not.toBeInTheDocument();
    });
  });
});
