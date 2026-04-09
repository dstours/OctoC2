// dashboard/src/pages/__tests__/SettingsPage.test.tsx
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SettingsPage } from '../SettingsPage';

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Mock libsodium so KeygenSection works without native bindings in test env
vi.mock('libsodium-wrappers', () => {
  const fakeKey = new Uint8Array(32).fill(1);
  return {
    default: {
      ready: Promise.resolve(),
      crypto_kx_keypair: () => ({ publicKey: fakeKey, privateKey: fakeKey }),
      to_base64: (_bytes: Uint8Array, _variant: number) => 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      base64_variants: { URLSAFE_NO_PADDING: 3 },
    },
  };
});

const mockLogout         = vi.hoisted(() => vi.fn());
const mockSubscribeEvents = vi.hoisted(() => vi.fn());

const mockAuthState = vi.hoisted(() => ({
  mode:      'live' as string,
  serverUrl: 'http://localhost:8080',
  latencyMs: 42 as number | null,
  privkey:   null as string | null,
  pat:       'ghp_test',
  logout:    mockLogout,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('@/lib/coords', () => ({
  getGitHubCoords: () => ({ owner: 'example-owner', repo: 'c2-repo' }),
}));

vi.mock('@/lib/C2ServerClient', () => ({
  C2ServerClient: vi.fn(function (this: Record<string, unknown>) {
    this['subscribeEvents'] = mockSubscribeEvents;
  }),
}));

beforeEach(() => {
  mockLogout.mockReset();
  mockAuthState.mode      = 'live';
  mockAuthState.serverUrl = 'http://localhost:8080';
  mockAuthState.latencyMs = 42;
  mockAuthState.privkey   = null;
  mockAuthState.pat       = 'ghp_test';
  // Default SSE subscription: never resolves
  mockSubscribeEvents.mockReset().mockImplementation(() => new Promise(() => {}));
  // Reset fetch mock if set
  if (vi.isMockFunction(globalThis.fetch)) {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReset();
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SettingsPage', () => {
  it('renders the Settings heading', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument();
  });

  it('shows current connection mode', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByText(/live \(\d+ms\)/i)).toBeInTheDocument();
  });

  it('shows server URL', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByText('http://localhost:8080')).toBeInTheDocument();
  });

  it('shows GitHub owner', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByText('example-owner')).toBeInTheDocument();
  });

  it('shows GitHub repo', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByText('c2-repo')).toBeInTheDocument();
  });

  it('shows "Not loaded" when privkey is null', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByText(/not loaded/i)).toBeInTheDocument();
  });

  it('shows key fingerprint when privkey is set', () => {
    mockAuthState.privkey = 'abc123def456ghi789jkl';
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByText(/loaded.*abc123d/i)).toBeInTheDocument();
  });

  it('shows server-side OPSEC reference variables (OCTOC2_*)', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByText('OCTOC2_CLEANUP_DAYS')).toBeInTheDocument();
    expect(screen.getByText('OCTOC2_APP_ID')).toBeInTheDocument();
    expect(screen.getByText('OCTOC2_INSTALLATION_ID')).toBeInTheDocument();
    expect(screen.getByText('OCTOC2_PROXY_REPOS')).toBeInTheDocument();
  });

  it('shows beacon-side OPSEC reference variables (SVC_*)', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByText('SVC_SLEEP')).toBeInTheDocument();
    expect(screen.getByText('SVC_JITTER')).toBeInTheDocument();
    expect(screen.getByText('SVC_APP_ID')).toBeInTheDocument();
    expect(screen.getByText('SVC_INSTALLATION_ID')).toBeInTheDocument();
  });

  it('calls logout() when logout button is clicked', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    fireEvent.click(screen.getByTestId('logout-btn'));
    expect(mockLogout).toHaveBeenCalledOnce();
  });

  it('renders Generate Operator Keypair button', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByTestId('keygen-btn')).toBeInTheDocument();
    expect(screen.getByTestId('keygen-btn')).toHaveTextContent('Generate Operator Keypair');
  });

  it('renders Safety Checklist heading', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByText(/safety checklist/i)).toBeInTheDocument();
  });

  it('renders all 8 checklist items', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(screen.getByText('C2 repo is private')).toBeInTheDocument();
    expect(screen.getByText('GitHub App auth (not PAT) configured')).toBeInTheDocument();
    expect(screen.getByText('App private key delivered via dead-drop (not baked in binary)')).toBeInTheDocument();
    expect(screen.getByText('OctoProxy relay active for target isolation')).toBeInTheDocument();
    expect(screen.getByText('OCTOC2_CLEANUP_DAYS set to 3 or less')).toBeInTheDocument();
    expect(screen.getByText('Dashboard not exposed publicly (local only)')).toBeInTheDocument();
    expect(screen.getByText('PAT scope limited to repo only')).toBeInTheDocument();
    expect(screen.getByText('E2E --fingerprint check passing')).toBeInTheDocument();
  });
});

// ── SSE live count tests ───────────────────────────────────────────────────────

describe('ConnectionSection — SSE live updates', () => {
  it('shows "—" for Live beacons and Last SSE update before any SSE event in live mode', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    // Both rows should show em-dash initially
    const rows = screen.getAllByText('—');
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('updates Live beacons count when beacon-update SSE event is received', async () => {
    let emitEvent: ((event: unknown) => void) | null = null;
    mockSubscribeEvents.mockImplementation((cb: (event: unknown) => void) => {
      emitEvent = cb;
      return new Promise(() => {});
    });

    render(<SettingsPage />, { wrapper: MemoryRouter });

    // Wait until SSE subscription is set up
    await waitFor(() => expect(emitEvent).not.toBeNull());

    act(() => {
      emitEvent!({ type: 'beacon-update', beacons: [{}, {}, {}, {}, {}] });
    });

    // Look for "5" specifically in the Live beacons row (unique enough to avoid OPSEC table)
    await waitFor(() => {
      expect(screen.getByText('5')).toBeInTheDocument();
    });
  });

  it('updates Last SSE update to "0s ago" immediately after SSE event', async () => {
    let emitEvent: ((event: unknown) => void) | null = null;
    mockSubscribeEvents.mockImplementation((cb: (event: unknown) => void) => {
      emitEvent = cb;
      return new Promise(() => {});
    });

    render(<SettingsPage />, { wrapper: MemoryRouter });
    await waitFor(() => expect(emitEvent).not.toBeNull());

    act(() => {
      emitEvent!({ type: 'beacon-update', beacons: [{}] });
    });

    await waitFor(() => {
      expect(screen.getByText(/\ds ago/)).toBeInTheDocument();
    });
  });

  it('shows "—" for both SSE rows when mode is api (not live)', () => {
    mockAuthState.mode = 'api';
    render(<SettingsPage />, { wrapper: MemoryRouter });
    // Should not call subscribeEvents
    expect(mockSubscribeEvents).not.toHaveBeenCalled();
    // Both SSE rows should show em-dash
    const rows = screen.getAllByText('—');
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('subscribes to SSE via C2ServerClient.subscribeEvents in live mode', () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    expect(mockSubscribeEvents).toHaveBeenCalled();
  });
});

// ── MONITORING_PUBKEY push tests ───────────────────────────────────────────────

describe('KeygenSection — Push MONITORING_PUBKEY', () => {
  async function generateKeys() {
    const btn = screen.getByTestId('keygen-btn');
    await act(async () => { fireEvent.click(btn); });
    // Wait for keys to appear
    await screen.findByLabelText('Public key');
  }

  it('shows "Push MONITORING_PUBKEY →" button after generating keys', async () => {
    render(<SettingsPage />, { wrapper: MemoryRouter });
    await generateKeys();
    expect(screen.getByTestId('push-pubkey-btn')).toHaveTextContent('Push MONITORING_PUBKEY →');
  });

  it('shows "Pushing…" state while the API call is in-flight', async () => {
    // fetch never resolves
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));

    render(<SettingsPage />, { wrapper: MemoryRouter });
    await generateKeys();

    const pushBtn = screen.getByTestId('push-pubkey-btn');
    fireEvent.click(pushBtn);

    await waitFor(() => {
      expect(screen.getByTestId('push-pubkey-btn')).toHaveTextContent('Pushing…');
    });
  });

  it('shows "✓ Pushed to MONITORING_PUBKEY" after a successful push', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: () => Promise.resolve(''),
    } as unknown as Response);

    render(<SettingsPage />, { wrapper: MemoryRouter });
    await generateKeys();

    const pushBtn = screen.getByTestId('push-pubkey-btn');
    await act(async () => { fireEvent.click(pushBtn); });

    await waitFor(() => {
      expect(screen.getByTestId('push-pubkey-btn')).toHaveTextContent('✓ Pushed to MONITORING_PUBKEY');
    });
  });

  it('shows error message when the API call fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('Unprocessable Entity'),
    } as unknown as Response);

    render(<SettingsPage />, { wrapper: MemoryRouter });
    await generateKeys();

    const pushBtn = screen.getByTestId('push-pubkey-btn');
    await act(async () => { fireEvent.click(pushBtn); });

    await waitFor(() => {
      expect(screen.getByTestId('push-pubkey-error')).toBeInTheDocument();
      expect(screen.getByTestId('push-pubkey-error')).toHaveTextContent('✗ Error:');
    });
  });

  it('retries with POST when PATCH returns 404', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: () => Promise.resolve(''),
      } as unknown as Response);
    globalThis.fetch = fetchMock;

    render(<SettingsPage />, { wrapper: MemoryRouter });
    await generateKeys();

    await act(async () => {
      fireEvent.click(screen.getByTestId('push-pubkey-btn'));
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Second call should be POST to the variables list endpoint
      const secondCall = fetchMock.mock.calls[1]!;
      expect((secondCall[1] as RequestInit).method).toBe('POST');
    });
  });
});
