/**
 * The original schema stores `record.value` as a Postgres `money` column, which
 * the pg driver hands back as a locale-formatted string such as `"$50,314.00"`.
 * These helpers make the API surface deal in plain numbers regardless of how the
 * column is actually typed.
 */

/** Parses `"$50,314.00"`, `"50314"`, `50314`, `"1.234,56"` into a number. */
export function parseMoney(input: unknown): number {
  if (input === null || input === undefined || input === '') return 0;
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0;

  const raw = String(input).trim();
  if (!raw) return 0;

  const negative = /^\(.*\)$/.test(raw) || raw.includes('-');
  let digits = raw.replace(/[^0-9.,]/g, '');
  if (!digits) return 0;

  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever separator comes last is the decimal separator.
    if (lastComma > lastDot) {
      digits = digits.replace(/\./g, '').replace(',', '.');
    } else {
      digits = digits.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    // A lone comma is a decimal separator only when it splits 1-2 trailing digits.
    const decimals = digits.length - lastComma - 1;
    digits = decimals > 0 && decimals <= 2 ? digits.replace(',', '.') : digits.replace(/,/g, '');
  } else if (lastDot !== -1) {
    const decimals = digits.length - lastDot - 1;
    if (decimals === 3 && digits.split('.').length > 2) {
      digits = digits.replace(/\./g, '');
    }
  }

  const parsed = Number.parseFloat(digits);
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -Math.abs(parsed) : parsed;
}

/** Rounds to cents, killing float drift like 0.1 + 0.2. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function sum(values: number[]): number {
  return round2(values.reduce((total, value) => total + value, 0));
}

/** Guards against division by zero in every ratio we surface. */
export function safeDivide(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : 0;
}

export function percentage(part: number, whole: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(safeDivide(part, whole) * 100 * factor) / factor;
}

export function formatMoney(value: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${round2(value).toFixed(2)}`;
  }
}
