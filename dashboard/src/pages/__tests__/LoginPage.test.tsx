import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'bun:test';
import * as ReactRouterDom from 'react-router-dom';
import { MemoryRouter } from 'react-router-dom';
import type { ConnectionMode } from '@/types';
import { LoginPage } from '../LoginPage';

const mockLogin = vi.fn();
const mockNavigate = vi.fn();
const mockRefresh = vi.fn();
const mockConnectionMode = vi.fn();

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ login: mockLogin }),
}));

vi.mock('@/hooks/useConnectionMode', () => ({
  useConnectionMode: (operatorToken: string, githubPat: string) =>
    mockConnectionMode(operatorToken, githubPat),
}));

vi.mock('react-router-dom', () => {
  return { ...ReactRouterDom, useNavigate: () => mockNavigate };
});

function connection(overrides: Partial<{
  mode: ConnectionMode;
  latencyMs: number | null;
  serverUrl: string;
  loading: boolean;
  error: string | null;
}> = {}) {
  return {
    mode: 'offline' as ConnectionMode,
    latencyMs: null,
    serverUrl: 'https://127.0.0.1:8080',
    loading: false,
    error: null,
    refresh: mockRefresh,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockLogin.mockReset();
  mockNavigate.mockReset();
  mockRefresh.mockReset().mockResolvedValue({
    mode: 'api' as ConnectionMode,
    latencyMs: null,
  });
  mockConnectionMode.mockImplementation((_operatorToken: string, githubPat: string) =>
    connection({ mode: githubPat ? 'api' : 'offline' }),
  );
});

describe('LoginPage', () => {
  it('shows a conspicuous non-production warning', () => {
    renderPage();
    expect(screen.getByRole('alert', { name: /experimental warning/i }))
      .toHaveTextContent(/experimental.*non-production/i);
  });

  it('renders separate password inputs for operator and GitHub credentials', () => {
    renderPage();
    expect(screen.getByLabelText(/operator api token/i)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/github pat/i)).toHaveAttribute('type', 'password');
    expect(screen.getByText(/used only for operator rest and sse/i)).toBeInTheDocument();
    expect(screen.getByText(/never sent to the controller api/i)).toBeInTheDocument();
  });

  it('passes the two credentials to connection detection in their own roles', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/operator api token/i), {
      target: { value: 'operator-only' },
    });
    fireEvent.change(screen.getByLabelText(/github pat/i), {
      target: { value: 'ghp_direct' },
    });
    expect(mockConnectionMode).toHaveBeenLastCalledWith('operator-only', 'ghp_direct');
  });

  it('stores role-separated credentials after a live probe succeeds', async () => {
    mockRefresh.mockResolvedValueOnce({ mode: 'live', latencyMs: 17 });
    renderPage();
    fireEvent.change(screen.getByLabelText(/operator api token/i), {
      target: { value: 'operator-live' },
    });
    fireEvent.change(screen.getByLabelText(/github pat/i), {
      target: { value: 'ghp_fallback' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    });

    expect(mockLogin).toHaveBeenCalledWith({
      operatorToken: 'operator-live',
      githubPat: 'ghp_fallback',
      mode: 'live',
      serverUrl: 'https://127.0.0.1:8080',
      latencyMs: 17,
      privkey: null,
    });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('stores an optional private key only when supplied', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/github pat/i), {
      target: { value: 'ghp_direct' },
    });
    fireEvent.click(screen.getByRole('button', { name: /advanced/i }));
    fireEvent.change(screen.getByLabelText(/operator private key/i), {
      target: { value: 'private-key' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    });
    expect(mockLogin).toHaveBeenCalledWith(expect.objectContaining({
      githubPat: 'ghp_direct',
      privkey: 'private-key',
    }));
  });

  it('clears both credential roles when entering offline mode', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /skip.*offline/i }));
    expect(mockLogin).toHaveBeenCalledWith({
      operatorToken: '',
      githubPat: '',
      mode: 'offline',
      serverUrl: 'https://127.0.0.1:8080',
      latencyMs: null,
      privkey: null,
    });
  });

  it('disables connect while detection is in progress', () => {
    mockConnectionMode.mockReturnValue(connection({ loading: true }));
    renderPage();
    expect(screen.getByRole('button', { name: /detecting/i })).toBeDisabled();
  });
});
