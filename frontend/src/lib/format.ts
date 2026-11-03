/**
 * Every date and time is shown in India Standard Time, the same zone the API counts
 * calendar days in, so "Thu 5" on the date strip and the showtimes under it always agree,
 * whatever the viewer's own timezone.
 */
export const TIMEZONE = 'Asia/Kolkata';

const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const rupeesExact = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const fmt = (o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: TIMEZONE, ...o });

const whenFmt = fmt({
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const timeFmt = fmt({ hour: 'numeric', minute: '2-digit' });
const dayFmt = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const isoDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE });

/** Amounts are integer paise on the server. Whole rupees drop the ".00". */
export const formatMoney = (paise: number) =>
  paise % 100 === 0 ? rupees.format(paise / 100) : rupeesExact.format(paise / 100);
export const formatWhen = (iso: string) => whenFmt.format(new Date(iso));
export const formatTime = (iso: string) => timeFmt.format(new Date(iso));
export const formatLongDay = (iso: string) => dayFmt.format(new Date(iso));

/** Today's date in IST as YYYY-MM-DD */
export const todayIst = () => isoDayFmt.format(new Date());

/** A YYYY-MM-DD day as { top: "Today" | "Thu", day: "5", month: "Nov" } for the date strip. */
export function dayParts(day: string) {
  const d = new Date(`${day}T12:00:00+05:30`);
  const today = todayIst();
  const tomorrow = isoDayFmt.format(new Date(Date.now() + 86_400_000));
  return {
    top:
      day === today ? 'Today' : day === tomorrow ? 'Tomorrow' : fmt({ weekday: 'short' }).format(d),
    day: fmt({ day: 'numeric' }).format(d),
    month: fmt({ month: 'short' }).format(d),
  };
}

/** 166 -> "2h 46m" */
export const formatDuration = (minutes: number) =>
  `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;

/** 263 -> "4:23" */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "RECLINER" -> "Recliner" */
export const categoryName = (c: string) =>
  c.charAt(0) + c.slice(1).toLowerCase().replace(/_/g, ' ');

/** A1, A2, A10, B1: rows by letter, seats by number */
export const seatOrder = (a: string, b: string) =>
  a[0]! === b[0]! ? Number(a.slice(1)) - Number(b.slice(1)) : a.localeCompare(b);

/** The short booking reference printed on tickets: the first 8 characters, upper case. */
export const bookingRef = (id: string) => id.slice(0, 8).toUpperCase();
