// dashboard/src/components/BeaconStatusDot.tsx
import type { BeaconStatus } from '@/types';

interface BeaconStatusDotProps {
  status: BeaconStatus;       // 'active' | 'stale' | 'dead'
  showTooltip?: boolean;      // default true — shows native title tooltip
}

const STATUS_CONFIG: Record<BeaconStatus, { color: string; pulse: boolean }> = {
  active: { color: 'bg-green-500', pulse: true },
  stale:  { color: 'bg-yellow-500', pulse: false },
  dead:   { color: 'bg-red-600', pulse: false },
};

export function BeaconStatusDot({ status, showTooltip = true }: BeaconStatusDotProps) {
  const { color, pulse } = STATUS_CONFIG[status];
  const pulseClass = pulse ? ' animate-pulse' : '';

  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${color}${pulseClass}`}
      title={showTooltip ? status : undefined}
    />
  );
}
