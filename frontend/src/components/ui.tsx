import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';
import type { BookingStatus, PaymentStatus } from '../lib/api';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-marigold text-night hover:bg-marigold-hi shadow-[0_0_0_1px_rgb(242_169_59/0.4),0_8px_30px_-8px_rgb(242_169_59/0.55)] disabled:bg-line-2 disabled:text-faint disabled:shadow-none',
  secondary: 'border border-line-2 bg-night-2 text-screen hover:border-dim disabled:opacity-50',
  ghost: 'text-dim hover:text-screen disabled:opacity-50',
  danger: 'border border-bad/50 text-bad hover:bg-bad hover:text-night disabled:opacity-50',
};

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-all active:scale-[0.98] disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export function ButtonLink({
  to,
  variant = 'primary',
  className = '',
  children,
}: {
  to: string;
  variant?: Variant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-all active:scale-[0.98] ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}

const TONES = {
  info: 'border-line-2 bg-night-2 text-dim',
  error: 'border-bad/40 bg-bad/10 text-bad',
  success: 'border-ok/40 bg-ok/10 text-ok',
};

/** A message block. role=alert for errors so screen readers announce them. */
export function Notice({
  tone = 'info',
  children,
  className = '',
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-xl border px-4 py-3 text-sm ${TONES[tone]} ${className}`}
    >
      {children}
    </div>
  );
}

/** Small, spaced, upper-case label: the cinema-signage voice for section names. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`font-mono text-[11px] tracking-[0.2em] text-faint uppercase ${className}`}>
      {children}
    </div>
  );
}

export function Chip({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
        active
          ? 'border-marigold bg-marigold/15 text-marigold-hi'
          : 'border-line-2 text-dim hover:border-dim hover:text-screen'
      }`}
    >
      {children}
    </button>
  );
}

/** U, UA, A: the CBFC certificate in a small boxed badge. */
export function Certificate({ value }: { value: string }) {
  return (
    <span
      className="inline-grid h-5 min-w-5 place-items-center rounded border border-current px-1 font-mono text-[10px] leading-none font-semibold"
      title={`Certified ${value}`}
    >
      {value === 'UA' ? 'U/A' : value}
    </span>
  );
}

export function Rating({ value, className = '' }: { value: number | null; className?: string }) {
  if (value === null) return null;
  return (
    <span className={`inline-flex items-center gap-1 font-semibold ${className}`}>
      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-marigold" aria-hidden="true">
        <path d="M10 1.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L10 14.8l-5.2 2.8 1-5.8L1.5 7.7l5.9-.8z" />
      </svg>
      {value.toFixed(1)}
      <span className="sr-only">out of 10</span>
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-night-3 ${className}`} aria-hidden="true" />;
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
    <div className="rounded-2xl border border-dashed border-line-2 px-6 py-14 text-center">
      <div className="font-display text-3xl font-bold tracking-wide uppercase">{title}</div>
      {children && <p className="mx-auto mt-2 max-w-md text-sm text-dim">{children}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

type Pill = { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'mine' };

const PILL_TONES: Record<Pill['tone'], string> = {
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  bad: 'bg-bad/15 text-bad',
  neutral: 'bg-line text-dim',
  mine: 'bg-marigold/15 text-marigold-hi',
};

/** The booking's state as a customer would say it, from booking and payment statuses. */
export function bookingPill(status: BookingStatus, payment?: PaymentStatus | null): Pill {
  if (status === 'CONFIRMED') return { label: 'Confirmed', tone: 'ok' };
  if (payment === 'REFUNDED') return { label: 'Refunded', tone: 'neutral' };
  if (payment === 'REFUND_REQUIRED') return { label: 'Refund on its way', tone: 'warn' };
  if (status === 'CANCELLED') return { label: payment ? 'Cancelled' : 'Released', tone: 'neutral' };
  if (status === 'FAILED') return { label: 'Payment failed', tone: 'bad' };
  if (status === 'EXPIRED') return { label: 'Expired', tone: 'neutral' };
  if (payment === 'INITIATED') return { label: 'Processing', tone: 'warn' };
  return { label: 'Held for you', tone: 'mine' };
}

export function StatusPill({ pill }: { pill: Pill }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${PILL_TONES[pill.tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {pill.label}
    </span>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-4 w-4 animate-spin ${className}`} aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
