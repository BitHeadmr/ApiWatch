import type { ReactNode } from 'react';
import { STATUS_LABEL, formatMs, formatTime } from '@/lib/format';
import type { EndpointStatus, RecentCheck } from '@/lib/types';

export function StatusLamp({ status, label = true }: { status: EndpointStatus; label?: boolean }) {
  return (
    <span
      className="lamp"
      data-status={status}
      role={label ? 'img' : undefined}
      aria-label={label ? STATUS_LABEL[status] : undefined}
      title={label ? STATUS_LABEL[status] : undefined}
      aria-hidden={label ? undefined : true}
    />
  );
}

export const TICKS = 30;

/** The last 30 checks, oldest on the left. Empty slots stay as faint placeholders. */
export function Heartbeat({ recent, large = false }: { recent: RecentCheck[]; large?: boolean }) {
  const shown = recent.slice(-TICKS);
  const empty = TICKS - shown.length;
  const failed = shown.filter((c) => !c.ok).length;
  const summary = shown.length
    ? `Last ${shown.length} checks: ${shown.length - failed} succeeded, ${failed} failed`
    : 'No checks yet';
  return (
    <span className={`heartbeat ${large ? 'heartbeat-lg' : ''}`} role="img" aria-label={summary}>
      {Array.from({ length: empty }, (_, i) => (
        <span key={`empty-${i}`} className="tick" />
      ))}
      {shown.map((c) => (
        <span
          key={c.at}
          className="tick"
          data-ok={c.ok}
          title={`${formatTime(c.at)}: ${c.ok ? `ok, ${formatMs(c.ms)}` : 'failed'}`}
        />
      ))}
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="border-y border-rule py-14 max-w-xl">
      <h2 className="display text-2xl">{title}</h2>
      {children && <p className="mt-2 text-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "Couldn't load this",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="border-y border-down/40 py-10 max-w-xl">
      <h2 className="display text-2xl">{title}</h2>
      <p className="mt-2 text-muted">{message}</p>
      {onRetry && (
        <button type="button" className="btn mt-5" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function FormErrors({ messages }: { messages: string[] }) {
  if (!messages.length) return null;
  return (
    <div role="alert" className="border-l-4 border-down bg-raised px-4 py-3 mb-6">
      <p className="font-semibold">
        {messages.length > 1 ? 'Fix these and try again:' : 'Fix this and try again:'}
      </p>
      <ul className="mt-1 list-disc pl-5">
        {messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}

/** A labelled fact: small label, bigger value. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted text-sm">{label}</dt>
      <dd className="display text-2xl tnum mt-0.5">{children}</dd>
    </div>
  );
}
