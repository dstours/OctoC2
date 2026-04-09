// dashboard/src/assets/OctoLogo.tsx
//
// Both variants use fixed_logo.png — 620×687 RGBA PNG with real alpha
// transparency. No mix-blend-mode needed; renders cleanly on any dark surface.
//
// variant="icon"  → small emblem for the topbar   (size = width, square crop)
// variant="full"  → larger emblem for login hero  (size = width, height auto)

import logoSrc from './fixed_logo.png';

interface Props {
  size?: number;
  variant?: 'icon' | 'full';
  className?: string;
}

export function OctoLogo({ size = 40, variant = 'icon', className = '' }: Props) {
  if (variant === 'full') {
    return (
      <img
        src={logoSrc}
        alt="OctoC2 logo"
        width={size}
        draggable={false}
        className={`select-none ${className}`}
        style={{ height: 'auto' }}
      />
    );
  }

  // Icon variant — topbar emblem
  return (
    <img
      src={logoSrc}
      alt="OctoC2 logo"
      width={size}
      height={size}
      draggable={false}
      className={`object-contain select-none ${className}`}
    />
  );
}
