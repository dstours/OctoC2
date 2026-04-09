// dashboard/src/components/ConnectionBadge.tsx
import { Badge } from '@/components/ui/badge';
import type { ConnectionMode } from '@/types';

interface ConnectionBadgeProps {
  mode: ConnectionMode;
  latencyMs?: number | null;
}

// Live is strongest — green glow at full weight.
// Api is mid — blue glow (brand primary).
// Offline is dimmest — amber glow.
const MODE_CONFIG: Record<ConnectionMode, {
  label: string;
  bg: string;
  dotColor: string;
  shadow: string;
  pulse: boolean;
}> = {
  live: {
    label: 'LIVE',
    bg: 'bg-green-700',
    dotColor: 'bg-green-300',
    shadow: 'shadow-neon-green',
    pulse: true,
  },
  api: {
    label: 'API',
    bg: 'bg-blue-700',
    dotColor: 'bg-blue-300',
    shadow: 'shadow-neon-blue',
    pulse: false,
  },
  offline: {
    label: 'OFFLINE',
    bg: 'bg-amber-700',
    dotColor: 'bg-amber-300',
    shadow: 'shadow-neon-amber',
    pulse: false,
  },
};

export function ConnectionBadge({ mode, latencyMs }: ConnectionBadgeProps) {
  const { label, bg, dotColor, shadow, pulse } = MODE_CONFIG[mode];

  return (
    <Badge
      data-testid="connection-badge"
      className={`
        font-mono font-semibold text-[10px] tracking-widest
        text-white/90 border-0 gap-1.5
        ${bg} ${shadow}
      `}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}${pulse ? ' animate-pulse' : ''}`}
      />
      <span>{label}</span>
      {mode === 'live' && latencyMs != null && (
        <span className="text-green-200 ml-0.5">· {latencyMs}ms</span>
      )}
    </Badge>
  );
}
