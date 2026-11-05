'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { onIdTokenChanged } from 'firebase/auth';
import { FunctionCallError, isDeadSession } from '@drivx/firebase-client';
import { consoleAuth, firebaseClients } from './firebase';

/**
 * The parts every console tool needs: who is signed in, the sign-in form, and
 * the header that lets them leave.
 *
 * The claim is read out of the ID token rather than from a profile document, so
 * the console knows what the rules will allow before a function refuses it — and
 * a staff member cannot grant themselves access by editing their own record.
 */

export type Reviewer = {
  label: string;
  /** Can approve drivers and record a collection. */
  admin: boolean;
  /** Can read live operations but decides nothing. */
  ops: boolean;
};

export function useReviewerSession(): { reviewer: Reviewer | null; checked: boolean } {
  const [reviewer, setReviewer] = useState<Reviewer | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let active = true;
    let initialStateResolved = false;
    // IndexedDB/session restoration can stall in a cold browser profile. Keep
    // the Admin sign-in usable instead of leaving its gate on an endless
    // "Checking your session…" screen; a later Auth callback still replaces
    // the fallback with the real session state.
    const startupTimeout = setTimeout(() => {
      if (!active || initialStateResolved) return;
      setReviewer(null);
      setChecked(true);
    }, 8_000);
    const unsubscribe = onIdTokenChanged(firebaseClients().auth, (user) => {
      void (async () => {
        if (!user) {
          initialStateResolved = true;
          clearTimeout(startupTimeout);
          if (active) {
            setReviewer(null);
            setChecked(true);
          }
          return;
        }
        try {
          // Forced, not cached: a session left in this browser by the emulator is
          // stored under the same key as a live one, and only asking the live
          // project to refresh it reveals that it was never valid here.
          const token = await user.getIdTokenResult(true);
          if (!active) return;
          setReviewer({
            label: user.email ?? user.phoneNumber ?? user.uid,
            admin: token.claims.admin === true,
            ops: token.claims.ops === true,
          });
        } catch (caught) {
          if (!active) return;
          if (isDeadSession(caught)) {
            setReviewer(null);
            // A session the live project will never accept again, cleared so the
            // sign-in form appears instead of a spinner that waits forever.
            await consoleAuth().signOutUser();
          } else {
            // Navigation can coincide with a temporary token-refresh/network
            // failure. Preserve the persisted session using its cached token;
            // only an invalid/deleted session should return to sign-in.
            try {
              const cached = await user.getIdTokenResult();
              if (active) {
                setReviewer({
                  label: user.email ?? user.phoneNumber ?? user.uid,
                  admin: cached.claims.admin === true,
                  ops: cached.claims.ops === true,
                });
              }
            } catch {
              if (active) setReviewer(null);
            }
          }
        } finally {
          initialStateResolved = true;
          clearTimeout(startupTimeout);
          if (active) setChecked(true);
        }
      })();
    });
    return () => {
      active = false;
      clearTimeout(startupTimeout);
      unsubscribe();
    };
  }, []);

  return { reviewer, checked };
}

export function describe(error: unknown): string {
  if (error instanceof FunctionCallError) return `${error.code} — ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'The console could not complete that request.';
}

/** `en-IN` on a 12-hour clock, because that is what the owner reads. */
export const stamp = (ms: number | null): string =>
  ms === null
    ? '—'
    : new Intl.DateTimeFormat('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        hour12: true,
        timeZone: 'Asia/Kolkata',
      }).format(new Date(ms));

export type ConsoleLink = { href: string; label: string };

const CLAIM_LABEL = {
  admin: 'administrator claim',
  staff: 'administrator or operations claim',
} as const;

export function ConsoleHeader({
  title,
  blurb,
  reviewer,
  links,
}: {
  title: string;
  blurb: string;
  reviewer: Reviewer | null;
  links: ConsoleLink[];
}) {
  const pathname = usePathname();
  return (
    <>
      <aside className="console-sidebar" aria-label="DrivX admin navigation">
        <Link href="/" aria-label="DrivX Operations home" className="console-brand">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-surface-brand shadow-lg shadow-blue-950/20"><Image src="/logo-mark-light.png" alt="" width={28} height={28} className="h-7 w-7" priority /></span>
          <span><span className="block text-lg font-extrabold tracking-tight text-ink">DrivX</span><span className="block text-[10px] font-bold uppercase tracking-[0.2em] text-ink-faint">Admin workspace</span></span>
        </Link>
        <p className="console-section-label">WORKSPACE</p>
        <nav aria-label="Operations" className="console-nav">
          <Link href="/" aria-current={pathname === '/' ? 'page' : undefined} className={`console-nav-link ${pathname === '/' ? 'is-active' : ''}`}><span className="console-nav-icon">◫</span><span>Overview</span></Link>
          {links.filter((link) => link.href !== '/').map((link) => {
            const active = pathname === link.href;
            const icon = link.href === '/bookings' ? '↗' : link.href === '/verification' ? '✓' : '₹';
            return <Link key={link.href} href={link.href} aria-current={active ? 'page' : undefined} className={`console-nav-link ${active ? 'is-active' : ''}`}><span className="console-nav-icon">{icon}</span><span>{link.label}</span>{active ? <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" /> : null}</Link>;
          })}
        </nav>
        <div className="console-sidebar-bottom"><div className="flex items-center gap-2 rounded-xl bg-success-soft px-3 py-2.5"><span className="h-2 w-2 rounded-full bg-accent" /><span className="text-xs font-bold text-ink">Live systems</span><span className="ml-auto text-[10px] font-semibold text-ink-muted">SYNCED</span></div>
          {reviewer ? <div className="mt-4 flex items-center gap-3 border-t border-line pt-4"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-brand text-xs font-bold uppercase text-ink-on-brand">{reviewer.label.slice(0, 1)}</span><div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-ink">{reviewer.label}</p><p className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">Administrator</p></div></div> : null}
        </div>
      </aside>
      <header className="console-topbar">
        <div><p className="text-xs font-semibold text-ink-faint">DrivX <span className="px-1">/</span> <span className="text-accent">{title}</span></p><h1 className="mt-1 text-xl font-extrabold tracking-tight text-ink">{title}</h1><p className="mt-0.5 text-xs text-ink-muted">{blurb}</p></div>
        <div className="flex items-center gap-2"><div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-2 shadow-sm"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" /><span className="text-xs font-semibold text-ink-muted">Live updates</span></div>{reviewer ? <button type="button" onClick={() => void consoleAuth().signOutUser()} className="rounded-full border border-line bg-surface px-3 py-2 text-xs font-semibold text-ink-muted shadow-sm hover:bg-surface-muted hover:text-ink">Sign out</button> : null}</div>
      </header>
    </>
  );
}

/**
 * The gate in front of every tool: session check, sign-in, or the reason the
 * signed-in account is not enough. Nothing is typed here that grants access.
 *
 * `claim` is what the page needs, in the words the owner can act on: `admin`
 * covers anything that decides something (approving a driver, recording a
 * collection), `staff` covers read-only operations. The function on the other
 * side of the call checks it again — this only saves a page from looking broken.
 */
export function StaffGate({
  checked,
  reviewer,
  claim,
  signInHeading,
  signInBlurb,
  children,
}: {
  checked: boolean;
  reviewer: Reviewer | null;
  claim: 'admin' | 'staff';
  signInHeading: string;
  signInBlurb: string;
  children: (reviewer: Reviewer) => React.ReactNode;
}) {
  const [email, setEmail] = useState(claim === 'admin' ? 'amit@referralme.in' : '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await consoleAuth().emailPasswordSignIn(email.trim(), password);
      // The box empties so the next person at this keyboard cannot read it.
      setPassword('');
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!checked) return <p className="text-sm text-ink-muted">Checking your session…</p>;

  if (!reviewer) {
    return (
      <main className="login-stage flex-1">
        <div className="mx-auto grid min-h-[calc(100vh-2rem)] w-full max-w-[1280px] overflow-hidden rounded-[28px] border border-line bg-surface shadow-2xl lg:min-h-[min(780px,calc(100vh-4rem))] lg:grid-cols-[1.08fr_.92fr]">
          <section className="login-brand-panel relative flex min-h-[300px] flex-col justify-between overflow-hidden p-7 text-white sm:p-10 lg:p-14">
            <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full border border-white/10" />
            <div className="absolute -bottom-40 -left-20 h-[470px] w-[470px] rounded-full border border-white/10" />
            <div className="relative z-10 flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/20"><Image src="/logo-mark-light.png" alt="" width={31} height={31} className="h-[31px] w-[31px]" priority /></span>
              <span><span className="block text-xl font-extrabold tracking-tight">DrivX</span><span className="block text-[10px] font-bold uppercase tracking-[0.22em] text-white/65">Operations console</span></span>
            </div>
            <div className="relative z-10 my-10 max-w-xl">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold tracking-wide text-white/90"><span className="h-2 w-2 rounded-full bg-blue-300" /> LIVE OPERATIONS</span>
              <h1 className="mt-6 text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl">Every trip.<br />In good hands.</h1>
              <p className="mt-5 max-w-md text-base leading-7 text-white/75">One clear view to manage bookings, review drivers and keep the DrivX network moving.</p>
            </div>
            <div className="relative z-10 grid grid-cols-3 gap-3 border-t border-white/15 pt-5 text-xs text-white/75 sm:gap-6">
              <div><span className="block text-lg font-bold text-white">01</span>Live dispatch</div><div><span className="block text-lg font-bold text-white">02</span>Driver review</div><div><span className="block text-lg font-bold text-white">03</span>Earnings ledger</div>
            </div>
          </section>
          <section className="flex items-center justify-center bg-surface px-6 py-10 sm:px-12 lg:px-14">
            <form onSubmit={signIn} className="w-full max-w-[390px]">
              <div className="mb-8 lg:hidden"><span className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1.5 text-xs font-bold text-accent">DRIVX OPERATIONS</span></div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-accent">Secure workspace</p>
              <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-ink">Welcome back</h2>
              <p className="mt-2 text-sm leading-6 text-ink-muted">{signInBlurb}</p>
              <label className="mt-8 block text-sm font-semibold text-ink">Work email
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" placeholder="name@company.com" className="mt-2 w-full rounded-xl border border-line bg-surface px-4 py-3.5 text-sm text-ink shadow-sm outline-none transition placeholder:text-ink-faint focus:border-line-focus focus:ring-4 focus:ring-accent-soft" required />
              </label>
              <label className="mt-5 block text-sm font-semibold text-ink">Password
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" placeholder="Enter your password" className="mt-2 w-full rounded-xl border border-line bg-surface px-4 py-3.5 text-sm text-ink shadow-sm outline-none transition placeholder:text-ink-faint focus:border-line-focus focus:ring-4 focus:ring-accent-soft" required />
              </label>
              {error ? <p role="alert" className="mt-4 rounded-xl border border-danger/20 bg-danger-soft px-4 py-3 text-sm text-badge-danger">{error}</p> : null}
              <button type="submit" disabled={busy} className="mt-7 flex w-full items-center justify-center gap-2 rounded-xl bg-surface-brand px-5 py-3.5 text-sm font-bold text-ink-on-brand shadow-lg shadow-slate-900/10 transition hover:-translate-y-0.5 hover:shadow-xl disabled:cursor-wait disabled:opacity-60">{busy ? 'Signing in…' : <>{signInHeading === 'Administrator sign-in required' ? 'Sign in to dispatch' : 'Sign in to operations'} <span aria-hidden>→</span></>}</button>
              <div className="mt-6 flex items-start gap-3 rounded-xl bg-surface-muted p-4"><span className="mt-0.5 text-accent" aria-hidden>◈</span><p className="text-xs leading-5 text-ink-muted">Protected by DrivX access controls. Only authorized operations accounts can view or change live trip data.</p></div>
              <p className="mt-8 text-center text-xs text-ink-faint">© {new Date().getFullYear()} DrivX · Operations console</p>
            </form>
          </section>
        </div>
      </main>
    );
  }

  const allowed = claim === 'admin' ? reviewer.admin : reviewer.admin || reviewer.ops;
  if (!allowed) {
    return (
      <section className="max-w-md rounded-card border border-line bg-surface p-6">
        <h2 className="font-semibold">This account cannot use this tool</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Signed in as {reviewer.label}, which carries no {CLAIM_LABEL[claim]}. Ask for an account with
          that role, then sign in again.
        </p>
        <button
          type="button"
          onClick={() => void consoleAuth().signOutUser()}
          className="mt-5 rounded-xl bg-surface-brand px-4 py-3 text-sm font-bold text-ink-on-brand"
        >
          Sign out and use Amit’s admin email
        </button>
      </section>
    );
  }

  return children(reviewer);
}
