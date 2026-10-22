'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { RecentCheck } from '@/lib/types';
import { FormErrors, Heartbeat, StatusLamp } from './ui';

/** A made-up board for the sign-in page: what you'll see once you're in. "." is a good check, anything else a failure. */
const sample = (pattern: string): RecentCheck[] =>
  pattern
    .split('')
    .map((c, i) => ({
      ok: c === '.',
      ms: 90 + ((i * 37) % 120),
      at: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
    }));

const SAMPLE_ROWS = [
  {
    name: 'Payments API',
    status: 'DOWN' as const,
    note: 'Down for 4m 12s',
    pattern: '.......................XXXXXXX',
  },
  {
    name: 'Auth service',
    status: 'UP' as const,
    note: '',
    pattern: '..............................',
  },
  { name: 'Search', status: 'UP' as const, note: '', pattern: '.......X......................' },
];

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const { status, login, register } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [teamName, setTeamName] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const isLogin = mode === 'login';

  useEffect(() => {
    if (status === 'authed') router.replace('/');
  }, [status, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors([]);
    setBusy(true);
    try {
      if (isLogin) await login(email.trim(), password);
      else await register(email.trim(), password, teamName.trim());
      router.replace('/');
    } catch (err) {
      setErrors(err instanceof ApiError ? err.messages : ['Something went wrong. Try again.']);
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section className="hidden lg:flex flex-col justify-center border-r border-rule bg-raised px-14">
        <p className="display text-xl">APIWatch</p>
        <h1 className="display mt-10 text-6xl max-w-[14ch]">Know before your customers do.</h1>
        <p className="mt-5 max-w-md text-lg text-muted">
          Checks your APIs around the clock, opens an incident the moment one breaks, and tells you.
        </p>
        <ul className="mt-12 max-w-xl" aria-hidden="true">
          {SAMPLE_ROWS.map((r) => (
            <li
              key={r.name}
              className="flex items-center gap-4 border-t border-rule py-3 last:border-b"
              style={{
                paddingLeft: '0.75rem',
                paddingRight: '0.75rem',
                ...(r.status === 'DOWN'
                  ? { background: 'var(--down-wash)', boxShadow: 'inset 3px 0 0 var(--down)' }
                  : {}),
              }}
            >
              <StatusLamp status={r.status} label={false} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{r.name}</p>
                {r.note && <p className="text-sm font-semibold text-down">{r.note}</p>}
              </div>
              <Heartbeat recent={sample(r.pattern)} />
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col justify-center px-6 py-14 sm:px-14">
        <div className="mx-auto w-full max-w-sm">
          <p className="display text-xl lg:hidden mb-8">APIWatch</p>
          <h2 className="display text-4xl">{isLogin ? 'Sign in' : 'Create your account'}</h2>
          <p className="mt-2 text-muted">
            {isLogin ? 'Welcome back.' : 'One account per team. You can add endpoints right after.'}
          </p>

          <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
            <FormErrors messages={errors} />
            {!isLogin && (
              <div>
                <label className="label" htmlFor="team">
                  Team name
                </label>
                <input
                  id="team"
                  className="input"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  autoComplete="organization"
                  required
                  minLength={2}
                />
              </div>
            )}
            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                required
                minLength={isLogin ? undefined : 8}
              />
              {!isLogin && <p className="hint">At least 8 characters.</p>}
            </div>
            <button type="submit" className="btn btn-primary w-full" disabled={busy}>
              {busy
                ? isLogin
                  ? 'Signing in…'
                  : 'Creating account…'
                : isLogin
                  ? 'Sign in'
                  : 'Create account'}
            </button>
          </form>

          <p className="mt-6 text-muted">
            {isLogin ? (
              <>
                New here? <Link href="/register">Create an account</Link>
              </>
            ) : (
              <>
                Already have an account? <Link href="/login">Sign in</Link>
              </>
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
