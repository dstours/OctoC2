// dashboard/src/App.tsx
/**
 * OctoC2 Dashboard — App Shell
 *
 * Providers (outermost → innermost):
 *   QueryClientProvider  — TanStack Query cache
 *   AuthProvider         — operator PAT, mode, credentials in memory only
 *   BrowserRouter        — react-router-dom v6, basename = Vite base URL
 *
 * Route structure:
 *   /login                    — LoginPage (always accessible)
 *   / (protected)             — BeaconListPage via Layout shell
 *   /beacon/:id (protected)   — BeaconDetailPage
 *   /tentacles (protected)    — TentacleMonitorPage
 *   /tasks (protected)        — TaskQueuePage
 *   /settings (protected)     — SettingsPage
 *   * (catch-all)             — redirect to /login
 *
 * Guard logic (ProtectedRoutes):
 *   No PAT AND mode is not 'offline'  →  redirect to /login
 *   Has PAT OR mode is 'offline'      →  render Layout (with Outlet)
 *
 * This allows operators to browse in offline mode (read-only, no API calls)
 * without re-entering credentials after a tab reload.
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { Layout } from '@/components/Layout';
import { LoginPage }           from '@/pages/LoginPage';
import { BeaconListPage }      from '@/pages/BeaconListPage';
import { BeaconDetailPage }    from '@/pages/BeaconDetailPage';
import { TentacleMonitorPage } from '@/pages/TentacleMonitorPage';
import { TaskQueuePage }       from '@/pages/TaskQueuePage';
import { SettingsPage }              from '@/pages/SettingsPage';
import { MultiBeaconResultsPage }    from '@/pages/MultiBeaconResultsPage';

// ── Query client — module-level singleton ─────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // 30s — polls stay fresh between automatic 30s refetches
      retry: 1,
    },
  },
});

// ── Route components ──────────────────────────────────────────────────────────

function ProtectedRoutes() {
  const { pat, mode } = useAuth();
  // Allow through if operator has a PAT or has explicitly chosen offline mode.
  // Initial state is `mode: 'offline'`, so the dashboard is viewable immediately;
  // the BeaconTable shows a "connect with PAT" prompt until credentials are set.
  if (!pat && mode !== 'offline') return <Navigate to="/login" replace />;
  return <Layout />;
}

/** Named export for isolated routing tests — avoids full provider setup in tests. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoutes />}>
        <Route index element={<BeaconListPage />} />
        <Route path="/beacon/:id"  element={<BeaconDetailPage />} />
        <Route path="/tentacles"   element={<TentacleMonitorPage />} />
        <Route path="/tasks"       element={<TaskQueuePage />} />
        <Route path="/settings"    element={<SettingsPage />} />
        <Route path="/results"     element={<MultiBeaconResultsPage />} />
      </Route>

      {/* Catch-all — unknown paths fall back to login */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
