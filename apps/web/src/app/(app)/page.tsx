'use client';

import Link from 'next/link';
import { EndpointRow, LedgerHeader } from '@/components/EndpointRow';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { useData } from '@/lib/data';
import { downSubline, headline, sortEndpoints, summarize } from '@/lib/summary';
import { useNow } from '@/lib/use-now';

export default function OverviewPage() {
  const { loaded, error, endpoints, stats, openIncidents, refresh } = useData();
  const now = useNow(1000);

  if (!loaded) {
    if (error) return <ErrorState message={error} onRetry={() => void refresh()} />;
    return (
      <div aria-busy="true" aria-label="Loading endpoints">
        <Skeleton className="h-14 w-96 max-w-full" />
        <div className="mt-10 space-y-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const list = sortEndpoints(Object.values(endpoints));
  const summary = summarize(list);
  const incidents = Object.values(openIncidents);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <h1 className="display text-[2.6rem] sm:text-6xl">{headline(summary)}</h1>
          {summary.down.length > 0 && (
            <p className="mt-3 text-lg text-down font-medium">
              {downSubline(summary.down, incidents, now)}
            </p>
          )}
        </div>
        <Link href="/endpoints/new" className="btn btn-primary">
          Add endpoint
        </Link>
      </div>

      {list.length === 0 ? (
        <div className="mt-12">
          <EmptyState
            title="Add the first API you want to watch"
            action={
              <Link href="/endpoints/new" className="btn btn-primary">
                Add endpoint
              </Link>
            }
          >
            Give APIWatch a URL and how often to check it. It will keep checking on its own and tell
            you the moment something breaks.
          </EmptyState>
        </div>
      ) : (
        <section className="mt-12" aria-label="Endpoints">
          {error && (
            <p role="alert" className="mb-3 text-sm text-down">
              Couldn&apos;t refresh just now: {error}
            </p>
          )}
          <LedgerHeader />
          <ul className="border-b border-rule">
            {list.map((endpoint) => (
              <EndpointRow
                key={endpoint.id}
                endpoint={endpoint}
                stats={stats[endpoint.id]}
                incident={incidents.find((i) => i.endpointId === endpoint.id)}
                now={now}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
