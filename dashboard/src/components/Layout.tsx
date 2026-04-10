// dashboard/src/components/Layout.tsx
import { useState, useEffect } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Radio, Shield, Terminal, Settings, RefreshCw, LogOut, Menu } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { OctoLogo } from '@/assets/OctoLogo';
import { ConnectionBadge } from './ConnectionBadge';

const NAV_ITEMS = [
  { to: '/',          icon: <Radio size={13} />,    label: 'Beacons',   end: true  },
  { to: '/tentacles', icon: <Shield size={13} />,   label: 'Tentacles', end: false },
  { to: '/tasks',     icon: <Terminal size={13} />, label: 'Tasks',     end: false },
  { to: '/settings',  icon: <Settings size={13} />, label: 'Settings',  end: false },
];

const MD_BREAKPOINT = 768;

function navLinkClass({ isActive }: { isActive: boolean }) {
  return [
    'flex items-center gap-2 px-2 py-1.5 rounded-sm text-xs',
    'transition-all duration-150 border-l-2 pl-[5px]',
    isActive
      ? 'text-octo-blue border-octo-blue bg-octo-blue/[0.04]'
      : 'text-gray-500 hover:text-gray-200 hover:bg-gray-800/30 border-transparent',
  ].join(' ');
}

function Sidebar() {
  return (
    <nav
      aria-label="Main navigation"
      className="w-48 bg-octo-surface border-r border-octo-border/60 px-2 py-3 flex flex-col gap-0.5 shrink-0 h-full"
    >
      {NAV_ITEMS.map(({ to, icon, label, end }) => (
        <NavLink key={to} to={to} end={end} className={navLinkClass}>
          {icon}
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export function Layout() {
  const { mode, latencyMs, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    function handleResize() {
      if (window.innerWidth >= MD_BREAKPOINT) setSidebarOpen(false);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="min-h-screen bg-octo-black font-mono flex flex-col">

      {/* ── Topbar ─────────────────────────────────────────── */}
      <header
        className="fixed top-0 left-0 right-0 z-50 h-12 flex items-center px-4 gap-3
                   bg-octo-surface/90 backdrop-blur-md
                   border-b border-octo-border/60
                   header-inset-glow"
      >
        {/* Hamburger (mobile only) */}
        <button
          className="md:hidden p-1 text-gray-500 hover:text-gray-200 transition-colors duration-150"
          onClick={() => setSidebarOpen(o => !o)}
          aria-label="Toggle navigation"
        >
          <Menu size={15} />
        </button>

        {/* Brand — logo only; wordmark hidden visually but kept for a11y/tests */}
        <Link to="/" className="logo-glow-hover shrink-0 flex items-center">
          <OctoLogo size={30} />
          {/* sr-only spans preserve test selectors: getByText('Octo') / getByText('C2') */}
          <span className="sr-only">Octo</span>
          <span className="sr-only">C2</span>
        </Link>

        <div className="flex-1" />

        {/* Right controls */}
        <div className="flex items-center gap-2">
          <ConnectionBadge mode={mode} latencyMs={latencyMs} />

          <button
            onClick={() => queryClient.invalidateQueries()}
            className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors duration-150"
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={12} />
          </button>

          <button
            onClick={handleLogout}
            className="p-1.5 text-gray-600 hover:text-octo-red transition-colors duration-150"
            title="Logout"
            aria-label="Logout"
          >
            <LogOut size={12} />
          </button>
        </div>
      </header>

      {/* ── Local-only safety strip ────────────────────────── */}
      <div
        className="fixed top-12 left-0 right-0 z-40 flex items-center justify-center
                   bg-amber-950/40 border-b border-amber-800/30 px-3 py-[3px]"
        role="note"
        aria-label="Security notice"
      >
        <span className="text-[9px] font-mono text-amber-500/70 tracking-wide">
          ⚠️ Local / private Codespace only — never expose to untrusted networks
        </span>
      </div>

      {/* ── Body ───────────────────────────────────────────── */}
      <div className="flex flex-1 pt-[52px]">
        <div className="hidden md:flex">
          <Sidebar />
        </div>

        {sidebarOpen && (
          <>
            <div
              className="fixed inset-0 bg-black/50 z-30 md:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-hidden="true"
            />
            <div className="fixed top-12 bottom-0 left-0 z-40 md:hidden">
              <Sidebar />
            </div>
          </>
        )}

        <main className="flex-1 overflow-auto bg-octo-black p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
