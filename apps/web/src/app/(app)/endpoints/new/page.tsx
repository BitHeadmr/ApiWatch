'use client';

import { useRouter } from 'next/navigation';
import { EndpointForm } from '@/components/EndpointForm';
import { api } from '@/lib/api';

export default function NewEndpointPage() {
  const router = useRouter();
  return (
    <div className="max-w-4xl">
      <h1 className="display text-5xl">Add endpoint</h1>
      <p className="mt-2 mb-8 text-lg text-muted">
        Tell APIWatch what to check. It starts right away.
      </p>
      <EndpointForm
        submitLabel="Add endpoint"
        onCancel={() => router.push('/')}
        onSubmit={async (input) => {
          const created = await api.createEndpoint(input);
          router.push(`/endpoints/${created.id}`);
        }}
      />
    </div>
  );
}
