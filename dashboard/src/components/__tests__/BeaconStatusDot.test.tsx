// dashboard/src/components/__tests__/BeaconStatusDot.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BeaconStatusDot } from '../BeaconStatusDot';

describe('BeaconStatusDot', () => {
  it('renders active status with bg-green-500 and animate-pulse', () => {
    render(<BeaconStatusDot status="active" />);
    const dot = screen.getByTitle('active');
    expect(dot).toHaveClass('bg-green-500');
    expect(dot).toHaveClass('animate-pulse');
  });

  it('renders stale status with bg-yellow-500 and no pulse', () => {
    render(<BeaconStatusDot status="stale" />);
    const dot = screen.getByTitle('stale');
    expect(dot).toHaveClass('bg-yellow-500');
    expect(dot).not.toHaveClass('animate-pulse');
  });

  it('renders dead status with bg-red-600 and no pulse', () => {
    render(<BeaconStatusDot status="dead" />);
    const dot = screen.getByTitle('dead');
    expect(dot).toHaveClass('bg-red-600');
    expect(dot).not.toHaveClass('animate-pulse');
  });

  it('sets title attribute to status when showTooltip is true (default)', () => {
    render(<BeaconStatusDot status="active" />);
    expect(screen.getByTitle('active')).toBeInTheDocument();
  });

  it('does NOT set title attribute when showTooltip is false', () => {
    const { container } = render(<BeaconStatusDot status="active" showTooltip={false} />);
    const span = container.firstChild as HTMLElement;
    expect(span.getAttribute('title')).toBeNull();
  });
});
