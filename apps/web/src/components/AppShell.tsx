'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useData } from '@/lib/data';

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`py-4 border-b-2 no-underline font-semibold ${
        active ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink'
      }`}
    >
      {children}
    </Link>
  );
}

const CONNECTION_TEXT = {
  live: 'Live',
  connecting: 'Connecting',
  offline: 'Reconnecting',
} as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { openIncidents, connection } = useData();
  const openCount = Object.keys(openIncidents).length;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-rule bg-raised">
        <div className="mx-auto max-w-6xl px-5 flex items-center gap-x-8 flex-wrap">
          <Link href="/" className="display text-xl py-4 no-underline text-ink">
            APIWatch
          </Link>
          <nav aria-label="Main" className="flex gap-6">
            <NavLink href="/" active={pathname === '/' || pathname.startsWith('/endpoints')}>
              Endpoints
            </NavLink>
            <NavLink href="/incidents" active={pathname.startsWith('/incidents')}>
              Incidents
              {openCount > 0 && (
                <span className="ml-2 inline-block min-w-5 rounded-full bg-down px-1.5 text-center text-xs font-bold text-on-down tnum">
                  {openCount}
                </span>
              )}
            </NavLink>
          </nav>

          <div className="ml-auto flex items-center gap-5 py-2 text-sm">
            <span
              className="flex items-center gap-2 text-muted"
              role="status"
              aria-label={`Live updates: ${CONNECTION_TEXT[connection]}`}
            >
              <span
                className="lamp"
                data-status={connection === 'live' ? 'UP' : 'UNKNOWN'}
                aria-hidden="true"
                style={{ width: '0.6rem', height: '0.6rem' }}
              />
              {CONNECTION_TEXT[connection]}
            </span>
            <span className="text-muted hidden sm:inline">{user?.team?.name ?? user?.email}</span>
            <button type="button" className="btn btn-quiet" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>
    </div>
  );
}
