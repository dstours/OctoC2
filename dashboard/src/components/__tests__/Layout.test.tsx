// dashboard/src/components/__tests__/Layout.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { Layout } from '../Layout';

function renderLayout(initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Layout />
      </AuthProvider>
    </MemoryRouter>
  );
}

describe('Layout', () => {
  it('renders the OctoC2 brand text', () => {
    renderLayout();
    // Brand is split into two spans: "Octo" and "C2"
    expect(screen.getByText('Octo')).toBeInTheDocument();
    expect(screen.getByText('C2')).toBeInTheDocument();
  });

  it('renders the OctoLogo', () => {
    renderLayout();
    expect(screen.getByRole('img', { name: /octoc2 logo/i })).toBeInTheDocument();
  });

  it('renders a ConnectionBadge', () => {
    renderLayout();
    expect(screen.getByTestId('connection-badge')).toBeInTheDocument();
  });

  it('renders the main navigation with Beacons link', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: /beacons/i })).toBeInTheDocument();
  });

  it('renders Tentacles, Tasks, Settings nav links', () => {
    renderLayout();
    expect(screen.getByRole('link', { name: /tentacles/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /tasks/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });

  it('logout button is present', () => {
    renderLayout();
    expect(screen.getByRole('button', { name: /logout/i })).toBeInTheDocument();
  });

  it('hamburger toggle button is present', () => {
    renderLayout();
    expect(screen.getByRole('button', { name: /toggle navigation/i })).toBeInTheDocument();
  });

  it('main content area renders Outlet', () => {
    renderLayout();
    expect(document.querySelector('main')).toBeInTheDocument();
  });
});
