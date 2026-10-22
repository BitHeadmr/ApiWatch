'use client';

import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { RequireAuth } from '@/components/RequireAuth';
import { DataProvider } from '@/lib/data';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <DataProvider>
        <AppShell>{children}</AppShell>
      </DataProvider>
    </RequireAuth>
  );
}
