'use client';

import { useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api';
import type { Endpoint, EndpointInput } from '@/lib/types';
import { FormErrors } from './ui';

const INTERVALS = [
  { seconds: 30, label: 'Every 30 seconds' },
  { seconds: 60, label: 'Every minute' },
  { seconds: 120, label: 'Every 2 minutes' },
  { seconds: 300, label: 'Every 5 minutes' },
  { seconds: 600, label: 'Every 10 minutes' },
  { seconds: 1800, label: 'Every 30 minutes' },
  { seconds: 3600, label: 'Every hour' },
];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

interface HeaderRow {
  id: number;
  key: string;
  value: string;
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="grid gap-x-10 gap-y-4 border-t border-rule py-8 md:grid-cols-[14rem_minmax(0,1fr)]">
      <legend className="sr-only">{title}</legend>
      <div aria-hidden="true">
        <h2 className="display text-xl">{title}</h2>
        <p className="mt-1 text-sm text-muted">{hint}</p>
      </div>
      <div className="space-y-5 max-w-lg">{children}</div>
    </fieldset>
  );
}

export function validate(f: {
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  threshold: number;
  expectedStatus: string;
}): string[] {
  const problems: string[] = [];
  if (!f.name.trim()) problems.push('Give the endpoint a name.');
  try {
    const u = new URL(f.url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
  } catch {
    problems.push('The URL must start with http:// or https://.');
  }
  if (!Number.isFinite(f.intervalSeconds) || f.intervalSeconds < 1)
    problems.push('Choose how often to check.');
  if (!Number.isFinite(f.timeoutSeconds) || f.timeoutSeconds < 1 || f.timeoutSeconds > 60) {
    problems.push('The timeout must be between 1 and 60 seconds.');
  } else if (f.timeoutSeconds * 1000 >= f.intervalSeconds * 1000) {
    problems.push('The timeout must be shorter than the time between checks.');
  }
  if (!/^([1-5]\d\d|[1-5]xx)$/i.test(f.expectedStatus.trim())) {
    problems.push('The expected status must be a code like 200, or a class like 2xx.');
  }
  if (!Number.isInteger(f.threshold) || f.threshold < 1 || f.threshold > 10) {
    problems.push('Failures before an incident must be a whole number from 1 to 10.');
  }
  return problems;
}

export function EndpointForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Endpoint;
  submitLabel: string;
  onSubmit: (input: EndpointInput) => Promise<void>;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const initialInterval = initial?.intervalSeconds ?? 300;
  const isPreset = INTERVALS.some((i) => i.seconds === initialInterval);

  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [method, setMethod] = useState(initial?.method ?? 'GET');
  const [headers, setHeaders] = useState<HeaderRow[]>(
    Object.entries(initial?.headers ?? {}).map(([key, value], id) => ({ id, key, value })),
  );
  const [body, setBody] = useState(initial?.body ?? '');
  const [interval, setIntervalChoice] = useState(isPreset ? String(initialInterval) : 'custom');
  const [customInterval, setCustomInterval] = useState(String(initialInterval));
  const [timeoutSeconds, setTimeoutSeconds] = useState(
    String((initial?.timeoutMs ?? 10_000) / 1000),
  );
  const [expectedStatus, setExpectedStatus] = useState(initial?.expectedStatus ?? '200');
  const [bodyContains, setBodyContains] = useState(initial?.expectedBodyContains ?? '');
  const [threshold, setThreshold] = useState(String(initial?.failureThreshold ?? 3));
  const [startNow, setStartNow] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const sendsBody = !['GET', 'HEAD'].includes(method);
  const intervalSeconds = interval === 'custom' ? Number(customInterval) : Number(interval);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problems = validate({
      name,
      url,
      intervalSeconds,
      timeoutSeconds: Number(timeoutSeconds),
      threshold: Number(threshold),
      expectedStatus,
    });
    const filled = headers.filter((h) => h.key.trim());
    if (filled.some((h) => !/^[A-Za-z0-9-]+$/.test(h.key.trim()))) {
      problems.push('Header names can only contain letters, numbers and hyphens.');
    }
    setErrors(problems);
    if (problems.length) return;

    const input: EndpointInput = {
      name: name.trim(),
      url: url.trim(),
      method,
      headers: Object.fromEntries(filled.map((h) => [h.key.trim(), h.value])),
      body: sendsBody && body ? body : editing ? null : undefined,
      intervalSeconds,
      timeoutMs: Math.round(Number(timeoutSeconds) * 1000),
      expectedStatus: expectedStatus.trim().toLowerCase(),
      expectedBodyContains: bodyContains.trim() ? bodyContains.trim() : editing ? null : undefined,
      failureThreshold: Number(threshold),
      ...(editing ? {} : { isActive: startNow }),
    };

    setBusy(true);
    try {
      await onSubmit(input);
    } catch (err) {
      setErrors(err instanceof ApiError ? err.messages : ['Something went wrong. Try again.']);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <FormErrors messages={errors} />

      <Section title="What to check" hint="The address APIWatch will request.">
        <div>
          <label className="label" htmlFor="name">
            Name
          </label>
          <input
            id="name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Payments API"
          />
        </div>
        <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
          <div>
            <label className="label" htmlFor="method">
              Method
            </label>
            <select
              id="method"
              className="input"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="url">
              URL
            </label>
            <input
              id="url"
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.com/health"
              inputMode="url"
            />
          </div>
        </div>

        <div>
          <p className="label">Request headers</p>
          {headers.map((h) => (
            <div
              key={h.id}
              className="mb-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2"
            >
              <input
                aria-label="Header name"
                className="input"
                value={h.key}
                placeholder="Authorization"
                onChange={(e) =>
                  setHeaders(
                    headers.map((x) => (x.id === h.id ? { ...x, key: e.target.value } : x)),
                  )
                }
              />
              <input
                aria-label="Header value"
                className="input"
                value={h.value}
                placeholder="Bearer …"
                onChange={(e) =>
                  setHeaders(
                    headers.map((x) => (x.id === h.id ? { ...x, value: e.target.value } : x)),
                  )
                }
              />
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setHeaders(headers.filter((x) => x.id !== h.id))}
                aria-label={`Remove header ${h.key || ''}`}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => setHeaders([...headers, { id: Date.now(), key: '', value: '' }])}
          >
            Add header
          </button>
        </div>

        {sendsBody && (
          <div>
            <label className="label" htmlFor="body">
              Request body
            </label>
            <textarea
              id="body"
              className="input"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        )}
      </Section>

      <Section
        title="How often"
        hint="How long to wait between checks, and when to give up on one."
      >
        <div>
          <label className="label" htmlFor="interval">
            Check frequency
          </label>
          <select
            id="interval"
            className="input"
            value={interval}
            onChange={(e) => setIntervalChoice(e.target.value)}
          >
            {INTERVALS.map((i) => (
              <option key={i.seconds} value={i.seconds}>
                {i.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
          {interval === 'custom' && (
            <div className="mt-2">
              <label className="label" htmlFor="custom-interval">
                Seconds between checks
              </label>
              <input
                id="custom-interval"
                className="input"
                inputMode="numeric"
                value={customInterval}
                onChange={(e) => setCustomInterval(e.target.value)}
              />
            </div>
          )}
        </div>
        <div>
          <label className="label" htmlFor="timeout">
            Timeout, in seconds
          </label>
          <input
            id="timeout"
            className="input max-w-32"
            inputMode="numeric"
            value={timeoutSeconds}
            onChange={(e) => setTimeoutSeconds(e.target.value)}
          />
          <p className="hint">A check that takes longer than this counts as failed.</p>
        </div>
      </Section>

      <Section
        title="What counts as healthy"
        hint="A check passes only if everything here matches."
      >
        <div>
          <label className="label" htmlFor="status">
            Expected status
          </label>
          <input
            id="status"
            className="input max-w-32"
            value={expectedStatus}
            onChange={(e) => setExpectedStatus(e.target.value)}
          />
          <p className="hint">A code such as 200, or a whole class such as 2xx.</p>
        </div>
        <div>
          <label className="label" htmlFor="contains">
            Response must contain
          </label>
          <input
            id="contains"
            className="input"
            value={bodyContains}
            onChange={(e) => setBodyContains(e.target.value)}
            placeholder='"status":"ok"'
          />
          <p className="hint">
            Optional. Catches an API that answers 200 but returns the wrong thing.
          </p>
        </div>
      </Section>

      <Section title="When to raise an incident" hint="One failed check is usually a blip.">
        <div>
          <label className="label" htmlFor="threshold">
            Failed checks in a row
          </label>
          <input
            id="threshold"
            className="input max-w-32"
            inputMode="numeric"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <p className="hint">
            After this many failures in a row, APIWatch opens an incident and sends your alerts.
          </p>
        </div>
        {!editing && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={startNow}
              onChange={(e) => setStartNow(e.target.checked)}
            />
            Start checking right away
          </label>
        )}
      </Section>

      <div className="flex gap-3 border-t border-rule pt-8">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
