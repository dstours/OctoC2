// dashboard/src/components/__tests__/MaintenancePanel.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MaintenancePanel } from '../MaintenancePanel';
import type { MaintenanceState } from '@/lib/C2ServerClient';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockGetMaintenance        = vi.hoisted(() => vi.fn());
const mockGetMaintenanceComment = vi.hoisted(() => vi.fn());
const mockSubscribeEvents       = vi.hoisted(() => vi.fn());
const mockDecryptSealedResult   = vi.hoisted(() => vi.fn());
const mockParsePayload          = vi.hoisted(() => vi.fn());
const mockPrivkeyRef            = { value: null as string | null };

let mockMode = 'live';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    pat: 'ghp_test',
    mode: mockMode,
    serverUrl: 'http://localhost:8080',
    privkey: mockPrivkeyRef.value,
    login: vi.fn(),
    logout: vi.fn(),
    isAuthenticated: true,
  }),
}));

vi.mock('@/lib/crypto', () => ({
  decryptSealedResult:               mockDecryptSealedResult,
  parseMaintenanceDiagnosticPayload: mockParsePayload,
}));

vi.mock('@/lib/C2ServerClient', () => ({
  C2ServerClient: vi.fn(function (this: Record<string, unknown>) {
    this['getMaintenance']        = mockGetMaintenance;
    this['getMaintenanceComment'] = mockGetMaintenanceComment;
    this['subscribeEvents']       = mockSubscribeEvents;
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const MAINTENANCE_STATE: MaintenanceState = {
  beaconId:       'b1',
  hostname:       'WIN-HOST',
  os:             'windows',
  arch:           'x64',
  status:         'active',
  lastSeen:       new Date().toISOString(),
  taskCount:      3,
  completedCount: 1,
  failedCount:    0,
  pendingCount:   2,
  tasks:          [],
  commentBody:    null,
};

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeQC()}>
      {children}
    </QueryClientProvider>
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('MaintenancePanel', () => {
  beforeEach(() => {
    mockMode = 'live';
    mockPrivkeyRef.value = null;
    mockGetMaintenance.mockResolvedValue(MAINTENANCE_STATE);
    mockGetMaintenanceComment.mockResolvedValue({ commentBody: null });
    mockDecryptSealedResult.mockReset();
    mockParsePayload.mockReturnValue(null); // default: no diagnostic
    mockSubscribeEvents.mockReset().mockImplementation(() => new Promise(() => {})); // never resolves
  });

  it('shows "Live mode required" message in API mode', () => {
    mockMode = 'api';
    render(
      <Wrapper>
        <MaintenancePanel beaconId="b1" />
      </Wrapper>
    );
    expect(screen.getByText('Live mode required for maintenance data')).toBeInTheDocument();
  });

  it('shows "No maintenance comment found" when commentBody is null', async () => {
    mockGetMaintenanceComment.mockResolvedValue({ commentBody: null });
    render(
      <Wrapper>
        <MaintenancePanel beaconId="b1" />
      </Wrapper>
    );
    // Wait for the maintenance data to load (comment section only shows after maint loads)
    const msg = await screen.findByText('No maintenance comment found');
    expect(msg).toBeInTheDocument();
  });

  it('renders the ### heading when commentBody is present', async () => {
    const body = `<!-- infra-maintenance:abc123 -->\n\n### 🛠️ Scheduled maintenance\n\n#### Queued Maintenance Tasks (1)\n- [ ] **abc** — do something\n`;
    mockGetMaintenanceComment.mockResolvedValue({ commentBody: body });
    render(
      <Wrapper>
        <MaintenancePanel beaconId="b1" />
      </Wrapper>
    );
    const heading = await screen.findByText('🛠️ Scheduled maintenance');
    expect(heading.tagName).toBe('H3');
  });

  it('renders checked task items (■) for [x] entries', async () => {
    const body = `- [x] **ref-abc** — completed task\n`;
    mockGetMaintenanceComment.mockResolvedValue({ commentBody: body });
    render(
      <Wrapper>
        <MaintenancePanel beaconId="b1" />
      </Wrapper>
    );
    const item = await screen.findByText((content) =>
      content.includes('■') && content.includes('ref-abc')
    );
    expect(item).toBeInTheDocument();
  });

  it('renders unchecked task items (□) for [ ] entries', async () => {
    const body = `- [ ] **ref-xyz** — pending task\n`;
    mockGetMaintenanceComment.mockResolvedValue({ commentBody: body });
    render(
      <Wrapper>
        <MaintenancePanel beaconId="b1" />
      </Wrapper>
    );
    const item = await screen.findByText((content) =>
      content.includes('□') && content.includes('ref-xyz')
    );
    expect(item).toBeInTheDocument();
  });

  it('shows Decrypt Diagnostic button when payload is present and no privkey', async () => {
    mockParsePayload.mockReturnValue('sealed-payload-b64');
    render(<Wrapper><MaintenancePanel beaconId="b1" /></Wrapper>);
    const btn = await screen.findByRole('button', { name: /decrypt/i });
    expect(btn).toBeInTheDocument();
  });

  it('auto-decrypts when privkey is in AuthContext', async () => {
    mockPrivkeyRef.value = 'operator-privkey';
    mockParsePayload.mockReturnValue('sealed-payload-b64');
    mockDecryptSealedResult.mockResolvedValue('{"os":"linux","pid":1234}');
    render(<Wrapper><MaintenancePanel beaconId="b1" /></Wrapper>);
    // decrypted JSON should appear — text is split across syntax-highlight spans, so match on the code element
    expect(await screen.findByText((_, el) =>
      el?.tagName === 'CODE' && /"os": "linux"/.test(el.textContent ?? ''))
    ).toBeInTheDocument();
    expect(mockDecryptSealedResult).toHaveBeenCalledWith('sealed-payload-b64', 'operator-privkey');
  });

  it('renders prettified JSON in Diagnostic Payload section', async () => {
    mockPrivkeyRef.value = 'operator-privkey';
    mockParsePayload.mockReturnValue('sealed-b64');
    mockDecryptSealedResult.mockResolvedValue('{"beaconId":"abc","pid":99}');
    render(<Wrapper><MaintenancePanel beaconId="b1" /></Wrapper>);
    expect(await screen.findByText((_, el) =>
      el?.tagName === 'CODE' && /"beaconId": "abc"/.test(el.textContent ?? ''))
    ).toBeInTheDocument();
  });

  it('shows decrypt error when decryptSealedResult rejects', async () => {
    mockPrivkeyRef.value = 'bad-key';
    mockParsePayload.mockReturnValue('sealed-b64');
    mockDecryptSealedResult.mockRejectedValue(new Error('bad key'));
    render(<Wrapper><MaintenancePanel beaconId="b1" /></Wrapper>);
    expect(await screen.findByText(/decryption failed/i)).toBeInTheDocument();
  });

  it('renders ✅ Initial check-in line with green colour', async () => {
    const body = `### 🛠️ Scheduled maintenance\n✅ Initial check-in\n`;
    mockGetMaintenanceComment.mockResolvedValue({ commentBody: body });
    render(<Wrapper><MaintenancePanel beaconId="b1" /></Wrapper>);
    const el = await screen.findByText('✅ Initial check-in');
    expect(el.className).toMatch(/green/);
  });

  it('shows "Copy JSON" button after successful decryption', async () => {
    mockPrivkeyRef.value = 'operator-privkey';
    mockParsePayload.mockReturnValue('sealed-b64');
    mockDecryptSealedResult.mockResolvedValue('{"os":"linux"}');
    render(<Wrapper><MaintenancePanel beaconId="b1" /></Wrapper>);
    const btn = await screen.findByRole('button', { name: /copy json/i });
    expect(btn).toBeInTheDocument();
  });

  it('does not show "Copy JSON" button before decryption succeeds', () => {
    mockParsePayload.mockReturnValue('sealed-b64');
    render(<Wrapper><MaintenancePanel beaconId="b1" /></Wrapper>);
    expect(screen.queryByRole('button', { name: /copy json/i })).not.toBeInTheDocument();
  });

  it('renders JSON keys with syntax highlighting tokens', async () => {
    mockPrivkeyRef.value = 'operator-privkey';
    mockParsePayload.mockReturnValue('sealed-b64');
    mockDecryptSealedResult.mockResolvedValue('{"os":"linux","pid":99}');
    render(<Wrapper><MaintenancePanel beaconId="b1" /></Wrapper>);
    // Wait for decrypted content to appear (the "os" key should be rendered as a token span)
    await screen.findByText(/"os"/);
  });

  it('does not render the base64 payload embedded in infra-diagnostic marker', async () => {
    const payload = 'AAAAABBBBCCCC1234XYZbase64payload';
    // Payload is now embedded inside the HTML comment (invisible to GitHub UI)
    const body = `### 🛠️ Scheduled maintenance\n✅ Initial check-in\n<!-- infra-diagnostic:abc-123:${payload} -->\n`;
    mockGetMaintenanceComment.mockResolvedValue({ commentBody: body });
    render(<Wrapper><MaintenancePanel beaconId="b1" /></Wrapper>);
    // heading should appear
    await screen.findByText('🛠️ Scheduled maintenance');
    // base64 payload should NOT be rendered as text
    expect(screen.queryByText(payload)).not.toBeInTheDocument();
  });

  describe('Task 81: SSE invalidation', () => {
    it('refetches maintenance queries when beacon-update SSE event is received', async () => {
      let emitEvent: ((event: unknown) => void) | null = null;
      mockSubscribeEvents.mockImplementation((cb: (event: unknown) => void) => {
        emitEvent = cb;
        return new Promise(() => {});
      });

      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <MaintenancePanel beaconId="b1" />
        </QueryClientProvider>
      );

      // Wait for initial load
      await screen.findByText('No maintenance comment found');
      const initialCommentCalls = mockGetMaintenanceComment.mock.calls.length;

      // Emit beacon-update event
      emitEvent!({ type: 'beacon-update', beacons: [] });

      await waitFor(() => {
        expect(mockGetMaintenanceComment.mock.calls.length).toBeGreaterThan(initialCommentCalls);
      });
    });

    it('refetches maintenance queries when maintenance-update SSE event matches beaconId', async () => {
      let emitEvent: ((event: unknown) => void) | null = null;
      mockSubscribeEvents.mockImplementation((cb: (event: unknown) => void) => {
        emitEvent = cb;
        return new Promise(() => {});
      });

      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <MaintenancePanel beaconId="b1" />
        </QueryClientProvider>
      );

      await screen.findByText('No maintenance comment found');
      const initialCommentCalls = mockGetMaintenanceComment.mock.calls.length;

      emitEvent!({ type: 'maintenance-update', beaconId: 'b1' });

      await waitFor(() => {
        expect(mockGetMaintenanceComment.mock.calls.length).toBeGreaterThan(initialCommentCalls);
      });
    });
  });
});
