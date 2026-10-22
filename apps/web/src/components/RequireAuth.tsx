'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { ErrorState, Skeleton } from './ui';

/** Everything inside needs a signed-in user. Anyone else is sent to the sign-in page. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, retry } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'anon') router.replace('/login');
  }, [status, router]);

  if (status === 'authed') return <>{children}</>;
  if (status === 'unreachable') {
    return (
      <div className="mx-auto max-w-6xl px-5 py-16">
        <ErrorState
          title="Can't reach the API"
          message="APIWatch couldn't connect to its server. Check that the API is running, then try again."
          onRetry={retry}
        />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-6xl px-5 py-16" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-10 w-72" />
    </div>
  );
}
