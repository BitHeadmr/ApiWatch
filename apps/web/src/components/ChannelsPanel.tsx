'use client';

import { useCallback, useState, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import type { AlertChannel } from '@/lib/types';
import { useResource } from '@/lib/use-resource';
import { FormErrors } from './ui';

export function ChannelsPanel({ endpointId }: { endpointId: string }) {
  const fetchChannels = useCallback(() => api.listChannels(endpointId), [endpointId]);
  const { data: channels, error: loadError, reload } = useResource(endpointId, fetchChannels);
  const [type, setType] = useState<'EMAIL' | 'WEBHOOK'>('EMAIL');
  const [target, setTarget] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ target: string; value: string } | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});

  async function add(e: FormEvent) {
    e.preventDefault();
    setErrors([]);
    setBusy(true);
    try {
      const created = await api.createChannel(endpointId, { type, target: target.trim() });
      setTarget('');
      setSecret(created.secret ? { target: created.target, value: created.secret } : null);
      reload();
    } catch (err) {
      setErrors(err instanceof ApiError ? err.messages : ['Something went wrong. Try again.']);
    } finally {
      setBusy(false);
    }
  }

  async function test(channel: AlertChannel) {
    setTests((t) => ({ ...t, [channel.id]: 'Sending…' }));
    try {
      const res = await api.testChannel(channel.id);
      setTests((t) => ({
        ...t,
        [channel.id]: res.success
          ? 'Test alert delivered.'
          : `Delivery failed: ${res.error ?? 'unknown error'}`,
      }));
    } catch (err) {
      setTests((t) => ({
        ...t,
        [channel.id]: err instanceof Error ? err.message : 'Delivery failed',
      }));
    }
  }

  async function remove(channel: AlertChannel) {
    try {
      await api.deleteChannel(channel.id);
      reload();
    } catch (err) {
      setErrors(err instanceof ApiError ? err.messages : ['Could not remove that channel.']);
    }
  }

  return (
    <div>
      {loadError && (
        <p role="alert" className="text-down">
          {loadError}
        </p>
      )}
      {channels && channels.length === 0 && (
        <p className="text-muted max-w-xl">
          No alerts yet. Add an email address or a webhook below, and APIWatch will notify it when
          an incident opens and again when it&apos;s resolved.
        </p>
      )}

      {channels && channels.length > 0 && (
        <ul className="border-b border-rule">
          {channels.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-rule py-3"
            >
              <span className="w-20 font-semibold">{c.type === 'EMAIL' ? 'Email' : 'Webhook'}</span>
              <span className="min-w-0 flex-1 break-all">{c.target}</span>
              {tests[c.id] && (
                <span role="status" className="text-sm text-muted">
                  {tests[c.id]}
                </span>
              )}
              <button type="button" className="btn" onClick={() => void test(c)}>
                Send test alert
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => void remove(c)}
                aria-label={`Remove ${c.target}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {secret && (
        <div role="status" className="mt-5 max-w-xl border-l-4 border-brand bg-raised px-4 py-3">
          <p className="font-semibold">
            Copy this signing secret now. It won&apos;t be shown again.
          </p>
          <p className="mt-1 text-sm text-muted">
            Use it to verify that requests to {secret.target} really come from APIWatch.
          </p>
          <code className="mt-2 block break-all rounded bg-paper px-2 py-1 text-sm">
            {secret.value}
          </code>
          <button type="button" className="btn btn-quiet mt-1" onClick={() => setSecret(null)}>
            I&apos;ve copied it
          </button>
        </div>
      )}

      <form onSubmit={add} className="mt-6 max-w-xl" noValidate>
        <FormErrors messages={errors} />
        <div className="grid grid-cols-[7.5rem_minmax(0,1fr)_auto] gap-2">
          <select
            aria-label="Channel type"
            className="input"
            value={type}
            onChange={(e) => setType(e.target.value as 'EMAIL' | 'WEBHOOK')}
          >
            <option value="EMAIL">Email</option>
            <option value="WEBHOOK">Webhook</option>
          </select>
          <input
            aria-label={type === 'EMAIL' ? 'Email address' : 'Webhook URL'}
            className="input"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={
              type === 'EMAIL' ? 'oncall@example.com' : 'https://example.com/hooks/apiwatch'
            }
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !target.trim()}>
            Add alert
          </button>
        </div>
      </form>
    </div>
  );
}
