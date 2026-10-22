'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { EndpointForm } from '@/components/EndpointForm';
import { EmptyState, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useData } from '@/lib/data';

export default function EditEndpointPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { loaded, endpoints } = useData();
  const endpoint = endpoints[id];

  if (!loaded) return <Skeleton className="h-10 w-72" />;
  if (!endpoint) {
    return (
      <EmptyState
        title="That endpoint doesn't exist"
        action={
          <Link href="/" className="btn">
            Back to endpoints
          </Link>
        }
      >
        It may have been deleted.
      </EmptyState>
    );
  }

  return (
    <div className="max-w-4xl">
      <Link href={`/endpoints/${id}`}>Back to {endpoint.name}</Link>
      <h1 className="display mt-3 text-5xl">Edit endpoint</h1>
      <div className="mt-8">
        <EndpointForm
          initial={endpoint}
          submitLabel="Save changes"
          onCancel={() => router.push(`/endpoints/${id}`)}
          onSubmit={async (input) => {
            await api.updateEndpoint(id, input);
            router.push(`/endpoints/${id}`);
          }}
        />
      </div>
    </div>
  );
}
