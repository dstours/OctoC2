// dashboard/src/assets/__tests__/OctoLogo.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { OctoLogo } from '../OctoLogo';

describe('OctoLogo', () => {
  describe('icon variant', () => {
    it('renders an img with OctoC2 logo alt text', () => {
      render(<OctoLogo variant="icon" size={30} />);
      expect(screen.getByRole('img', { name: /octoc2 logo/i })).toBeInTheDocument();
    });

    it('does not apply rounded-full circular clip', () => {
      render(<OctoLogo variant="icon" size={30} />);
      const img = screen.getByRole('img', { name: /octoc2 logo/i });
      expect(img).not.toHaveClass('rounded-full');
    });

    it('does not apply a blend mode style (transparent PNG needs none)', () => {
      render(<OctoLogo variant="icon" size={30} />);
      const img = screen.getByRole('img', { name: /octoc2 logo/i }) as HTMLImageElement;
      expect(img.style.mixBlendMode).toBe('');
    });
  });

  describe('full variant', () => {
    it('renders an img element', () => {
      render(<OctoLogo variant="full" size={200} />);
      const el = screen.getByRole('img', { name: /octoc2 logo/i });
      expect(el.tagName.toLowerCase()).toBe('img');
    });

    it('respects the size prop as the width attribute', () => {
      render(<OctoLogo variant="full" size={200} />);
      const img = screen.getByRole('img', { name: /octoc2 logo/i }) as HTMLImageElement;
      expect(img).toHaveAttribute('width', '200');
    });

    it('full variant src is the fixed transparent logo', () => {
      render(<OctoLogo variant="full" size={200} />);
      const img = screen.getByRole('img', { name: /octoc2 logo/i }) as HTMLImageElement;
      expect(img.src).toMatch(/fixed_logo/);
    });
  });
});
