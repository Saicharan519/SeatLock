const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const when = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** Amounts are integer paise on the server. */
export const formatMoney = (paise: number) => rupees.format(paise / 100);
export const formatWhen = (iso: string) => when.format(new Date(iso));

/** 263 -> "4:23" */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
