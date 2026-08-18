/**
 * Date handling is deliberately string-based (`YYYY-MM-DD`) end to end.
 *
 * The original app compared raw timestamps like `2026-08-17T00:00:00.000Z`,
 * which silently shifts a transaction to the previous day for anyone west of
 * UTC. Keeping calendar dates as plain strings removes that class of bug.
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PeriodPreset =
  | 'this-month'
  | 'last-month'
  | 'last-3-months'
  | 'last-6-months'
  | 'this-year'
  | 'last-year'
  | 'last-30-days'
  | 'last-12-months'
  | 'all'
  | 'custom';

export interface DateRange {
  from: string | null;
  to: string | null;
  preset: PeriodPreset;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function toIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = parseIsoDate(value);
  return toIsoDate(parsed) === value;
}

export function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function endOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

export function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/** Resolves a preset (or explicit from/to) into a concrete date range. */
export function resolveRange(
  preset: PeriodPreset | undefined,
  from?: string | null,
  to?: string | null,
  today = new Date()
): DateRange {
  const now = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  if (from || to) {
    return { from: from ?? null, to: to ?? null, preset: preset ?? 'custom' };
  }

  switch (preset) {
    case 'last-month': {
      const previous = addMonths(startOfMonth(now), -1);
      return {
        from: toIsoDate(startOfMonth(previous)),
        to: toIsoDate(endOfMonth(previous)),
        preset: 'last-month',
      };
    }
    case 'last-3-months':
      return {
        from: toIsoDate(startOfMonth(addMonths(now, -2))),
        to: toIsoDate(endOfMonth(now)),
        preset: 'last-3-months',
      };
    case 'last-6-months':
      return {
        from: toIsoDate(startOfMonth(addMonths(now, -5))),
        to: toIsoDate(endOfMonth(now)),
        preset: 'last-6-months',
      };
    case 'this-year':
      return {
        from: `${now.getUTCFullYear()}-01-01`,
        to: `${now.getUTCFullYear()}-12-31`,
        preset: 'this-year',
      };
    case 'last-year':
      return {
        from: `${now.getUTCFullYear() - 1}-01-01`,
        to: `${now.getUTCFullYear() - 1}-12-31`,
        preset: 'last-year',
      };
    case 'last-30-days':
      return { from: toIsoDate(addDays(now, -29)), to: toIsoDate(now), preset: 'last-30-days' };
    case 'last-12-months':
      return {
        from: toIsoDate(startOfMonth(addMonths(now, -11))),
        to: toIsoDate(endOfMonth(now)),
        preset: 'last-12-months',
      };
    case 'all':
      return { from: null, to: null, preset: 'all' };
    case 'this-month':
    default:
      return {
        from: toIsoDate(startOfMonth(now)),
        to: toIsoDate(endOfMonth(now)),
        preset: 'this-month',
      };
  }
}

/** The equivalent range one period earlier, used for period-over-period deltas. */
export function previousRange(range: DateRange): DateRange {
  if (!range.from || !range.to) return { from: null, to: null, preset: 'custom' };

  const from = parseIsoDate(range.from);
  const to = parseIsoDate(range.to);
  const spanDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;

  return {
    from: toIsoDate(addDays(from, -spanDays)),
    to: toIsoDate(addDays(from, -1)),
    preset: 'custom',
  };
}

/** Inclusive list of `YYYY-MM` buckets spanned by a range, capped for safety. */
export function monthsBetween(from: string, to: string, limit = 60): string[] {
  const months: string[] = [];
  let cursor = startOfMonth(parseIsoDate(from));
  const end = startOfMonth(parseIsoDate(to));

  while (cursor <= end && months.length < limit) {
    months.push(`${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}`);
    cursor = addMonths(cursor, 1);
  }
  return months;
}

/** Resolves the concrete window a recurring budget applies to today. */
export function budgetWindow(
  period: string,
  startDate: string,
  endDate: string | null,
  today = new Date()
): { from: string; to: string } {
  const now = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = parseIsoDate(startDate);

  if (period === 'custom') {
    return { from: startDate, to: endDate ?? toIsoDate(now) };
  }

  if (period === 'yearly') {
    const year = Math.max(now.getUTCFullYear(), start.getUTCFullYear());
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }

  if (period === 'weekly') {
    // Weeks run Monday–Sunday.
    const weekday = (now.getUTCDay() + 6) % 7;
    const monday = addDays(now, -weekday);
    return { from: toIsoDate(monday), to: toIsoDate(addDays(monday, 6)) };
  }

  // monthly (default)
  const anchor = now < start ? start : now;
  return { from: toIsoDate(startOfMonth(anchor)), to: toIsoDate(endOfMonth(anchor)) };
}
