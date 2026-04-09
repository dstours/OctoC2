// dashboard/src/pages/__tests__/BeaconListPage.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BeaconListPage } from '../BeaconListPage';

// Stub BeaconTable so this test focuses on the page shell, not the table internals
vi.mock('@/components/BeaconTable', () => ({
  BeaconTable: () => <div data-testid="beacon-table-stub" />,
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('BeaconListPage', () => {
  it('renders the Active Beacons heading', () => {
    render(<BeaconListPage />, { wrapper: makeWrapper() });
    expect(screen.getByText(/active beacons/i)).toBeInTheDocument();
  });

  it('renders the BeaconTable component', () => {
    render(<BeaconListPage />, { wrapper: makeWrapper() });
    expect(screen.getByTestId('beacon-table-stub')).toBeInTheDocument();
  });
});
