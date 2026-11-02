import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink text-paper hover:bg-booked disabled:bg-ink-soft/50',
  secondary: 'border border-ink/25 bg-card text-ink hover:border-ink/50 disabled:opacity-50',
  quiet: 'text-ink-soft underline-offset-4 hover:text-ink hover:underline disabled:opacity-50',
  danger: 'border border-brick/40 text-brick hover:bg-brick hover:text-paper disabled:opacity-50',
};

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-md px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

const TONES = {
  info: 'border-rule bg-card text-ink',
  error: 'border-brick/30 bg-brick/8 text-brick',
  success: 'border-teal/30 bg-teal/8 text-teal',
};

/** A message block. role=alert for errors so screen readers announce them. */
export function Notice({
  tone = 'info',
  children,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-md border px-4 py-3 text-sm ${TONES[tone]}`}
    >
      {children}
    </div>
  );
}

/** Small uppercase label above a value, in the ticket's mono face. */
export function Label({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-[11px] tracking-[0.12em] text-ink-soft uppercase">
      {children}
    </div>
  );
}
