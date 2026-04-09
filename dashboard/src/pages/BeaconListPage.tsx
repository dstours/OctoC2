// dashboard/src/pages/BeaconListPage.tsx
import { BeaconTable } from '@/components/BeaconTable';

export function BeaconListPage() {
  return (
    <div>
      <h2 className="text-xs text-gray-600 uppercase tracking-widest mb-4 font-mono">
        Active Beacons
      </h2>
      <BeaconTable />
    </div>
  );
}
