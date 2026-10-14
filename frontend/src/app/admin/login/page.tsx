'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { adminApi, setToken } from '@/lib/admin-api';

/**
 * The admin realm's sign-in.
 *
 * Rendered by the layout's login branch — the site header above, no panel
 * chrome, no guard (a guard here would redirect the page to itself). It writes
 * `tk-admin-token`, which is deliberately a different key from the portal's
 * `tk-portal-token`: an admin session must never grant portal access, or the
 * reverse.
 */
export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token } = await adminApi.login(email, password);
      setToken(token);
      router.replace('/admin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-5 rounded-2xl border border-border/60 bg-surface p-8 shadow-card"
      onSubmit={submit}
    >
      <div>
        <h1 className="font-display text-2xl font-semibold">Admin sign in</h1>
        <p className="mt-1 text-sm text-muted-foreground">Internal use only.</p>
      </div>

      <div className="flex flex-col gap-3">
        <Input
          type="email"
          placeholder="Email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <Input
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button
        type="submit"
        className="w-full bg-gradient-primary shadow-glow"
        disabled={busy || !email || !password}
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
