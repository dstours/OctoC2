// dashboard/src/components/__tests__/ConnectionBadge.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ConnectionBadge } from '../ConnectionBadge';

describe('ConnectionBadge', () => {
  it('shows LIVE label in live mode', () => {
    render(<ConnectionBadge mode="live" />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  it('shows latency when latencyMs is provided in live mode', () => {
    render(<ConnectionBadge mode="live" latencyMs={42} />);
    expect(screen.getByText('· 42ms')).toBeInTheDocument();
  });

  it('does NOT show ms text when latencyMs is null in live mode', () => {
    render(<ConnectionBadge mode="live" latencyMs={null} />);
    expect(screen.queryByText(/ms/)).not.toBeInTheDocument();
  });

  it('shows API label in api mode with bg-blue-700 class', () => {
    render(<ConnectionBadge mode="api" />);
    expect(screen.getByText('API')).toBeInTheDocument();
    const badge = screen.getByTestId('connection-badge');
    expect(badge).toHaveClass('bg-blue-700');
  });

  it('shows OFFLINE label in offline mode with bg-amber-700 class', () => {
    render(<ConnectionBadge mode="offline" />);
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
    const badge = screen.getByTestId('connection-badge');
    expect(badge).toHaveClass('bg-amber-700');
  });

  it('shows LIVE label in live mode with bg-green-700 class', () => {
    render(<ConnectionBadge mode="live" />);
    const badge = screen.getByTestId('connection-badge');
    expect(badge).toHaveClass('bg-green-700');
  });

  it('applies shadow-neon-green in live mode', () => {
    render(<ConnectionBadge mode="live" />);
    expect(screen.getByTestId('connection-badge')).toHaveClass('shadow-neon-green');
  });

  it('applies shadow-neon-blue in api mode', () => {
    render(<ConnectionBadge mode="api" />);
    expect(screen.getByTestId('connection-badge')).toHaveClass('shadow-neon-blue');
  });

  it('applies shadow-neon-amber in offline mode', () => {
    render(<ConnectionBadge mode="offline" />);
    expect(screen.getByTestId('connection-badge')).toHaveClass('shadow-neon-amber');
  });

  it('applies animate-pulse dot only in live mode', () => {
    const { rerender } = render(<ConnectionBadge mode="live" />);
    // The dot span is the first child of the badge
    const badge = screen.getByTestId('connection-badge');
    expect(badge.querySelector('span')).toHaveClass('animate-pulse');

    rerender(<ConnectionBadge mode="api" />);
    expect(screen.getByTestId('connection-badge').querySelector('span')).not.toHaveClass('animate-pulse');
  });
});
