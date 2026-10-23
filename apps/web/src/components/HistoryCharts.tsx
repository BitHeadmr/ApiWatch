'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { EndpointHistory, HistoryPoint } from '@/lib/types';
import { formatMs, formatPercent } from '@/lib/format';

function ResponseChart({ points }: { points: HistoryPoint[] }) {
  const values = points.filter((p) => p.avgResponseMs !== null);
  if (!values.length) return <p className="py-10 text-center text-sm text-muted">No response-time data for this period yet.</p>;
  const width = 800, height = 220, pad = 24;
  const max = Math.max(1, ...values.map((p) => p.avgResponseMs ?? 0));
  const x = (i: number) => pad + (i / Math.max(1, values.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);
  const path = values.map((p, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(p.avgResponseMs ?? 0)}`).join(' ');
  return <div className="w-full overflow-hidden"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Average response time over time" className="w-full">
    {[0, .25, .5, .75, 1].map((f) => <line key={f} x1={pad} x2={width-pad} y1={height-pad-f*(height-pad*2)} y2={height-pad-f*(height-pad*2)} stroke="currentColor" opacity=".12" />)}
    {path && <path d={path} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
    {values.map((p, i) => p.failures > 0 ? <circle key={p.at} cx={x(i)} cy={y(p.avgResponseMs ?? 0)} r="5" fill="currentColor" stroke="currentColor" strokeWidth="1" aria-label={`${p.failures} failures`} /> : null)}
    <text x={pad} y={14} fontSize="11" fill="currentColor">{formatMs(max)}</text><text x={pad} y={height-4} fontSize="11" fill="currentColor">0 ms</text>
  </svg><p className="text-xs text-muted">Failure markers appear on buckets that include failed checks.</p></div>;
}

function UptimeBars({ points }: { points: HistoryPoint[] }) {
  if (!points.some((p) => p.checks > 0)) return <p className="py-10 text-center text-sm text-muted">No checks recorded for this period yet.</p>;
  return <div className="flex h-24 items-end gap-[2px]" role="img" aria-label="Uptime by time bucket">
    {points.map((p) => <div key={p.at} title={`${new Date(p.at).toLocaleString()}: ${p.checks ? formatPercent(p.uptime) : 'No checks'}${p.failures ? `, ${p.failures} failures` : ''}`} className="min-w-0 flex-1 rounded-t-sm" style={{ height: `${p.checks ? Math.max(5, p.uptime ?? 0) : 3}%`, opacity: p.checks ? 1 : .25, background: p.checks && p.failures ? 'var(--down, #dc2626)' : 'var(--up, #16a34a)' }} />)}
  </div>;
}

export function HistoryCharts({ endpointId }: { endpointId: string }) {
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const [data, setData] = useState<EndpointHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    api.endpointHistory(endpointId, range, controller.signal).then(setData).catch((e: unknown) => {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message || 'Could not load history.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpointId, range]);

  return <section className="mt-12" aria-labelledby="history-h">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="history-h" className="display text-3xl">History & performance</h2><p className="mt-1 text-sm text-muted">Downsampled response time and uptime trends.</p></div>
      <div className="flex gap-1 rounded-lg border border-rule p-1" aria-label="History range">
        {(['24h', '7d'] as const).map((r) => <button type="button" key={r} onClick={() => setRange(r)} aria-pressed={range === r} className={`rounded-md px-3 py-1.5 text-sm ${range === r ? 'bg-foreground text-background' : 'text-muted'}`}>{r === '24h' ? '24 hours' : '7 days'}</button>)}
      </div>
    </div>
    {loading ? <p className="py-8 text-muted">Loading history…</p> : error ? <p role="alert" className="py-8 text-down">{error}</p> : data && <>
      <div className="mt-5 grid grid-cols-2 gap-4 border-y border-rule py-5 md:grid-cols-4">
        <div><p className="text-sm text-muted">Uptime</p><p className="mt-1 text-2xl tnum">{formatPercent(data.summary.uptime)}</p></div>
        <div><p className="text-sm text-muted">Average response</p><p className="mt-1 text-2xl tnum">{formatMs(data.summary.avgResponseMs)}</p></div>
        <div><p className="text-sm text-muted">p95 response</p><p className="mt-1 text-2xl tnum">{formatMs(data.summary.p95ResponseMs)}</p></div>
        <div><p className="text-sm text-muted">Total checks</p><p className="mt-1 text-2xl tnum">{data.summary.checks.toLocaleString()}</p></div>
      </div>
      <div className="mt-7 grid gap-8 lg:grid-cols-2"><div><h3 className="mb-3 font-semibold">Average response time</h3><div className="rounded-xl border border-rule p-3"><ResponseChart points={data.points} /></div></div><div><h3 className="mb-3 font-semibold">Uptime by interval</h3><div className="rounded-xl border border-rule p-4"><UptimeBars points={data.points} /><p className="mt-3 text-xs text-muted">Each bar represents a {data.bucketMinutes < 60 ? `${data.bucketMinutes}-minute` : `${data.bucketMinutes / 60}-hour`} bucket. Hover for details.</p></div></div></div>
    </>}
  </section>;
}
