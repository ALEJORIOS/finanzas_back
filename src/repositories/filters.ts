import { readValueSql, schemaInfo } from '../db/schema.ts';
import type { RecordQuery } from '../lib/schemas.ts';
import { resolveRange, type PeriodPreset } from '../lib/period.ts';

export interface WhereClause {
  sql: string;
  params: unknown[];
}

export interface RecordFilter {
  search?: string;
  from?: string | null;
  to?: string | null;
  preset?: string;
  category?: string | string[];
  concept?: 'Income' | 'Outcome' | 'all';
  accountId?: number;
  minValue?: number;
  maxValue?: number;
  /**
   * `settled` excludes planned/unpaid movements, `pending` shows only those.
   * Money aggregates always pass `settled`; the transaction list defaults to `all`.
   */
  status?: 'all' | 'settled' | 'pending';
}

/**
 * Builds the shared WHERE clause used by the list, analytics and report
 * queries so filtering behaves identically everywhere.
 *
 * `startIndex` lets the caller reserve earlier bind parameters.
 */
export function buildRecordWhere(filter: RecordFilter, startIndex = 1): WhereClause {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let index = startIndex;

  const range = resolveRange(
    (filter.preset as PeriodPreset | undefined) ?? (filter.from || filter.to ? 'custom' : 'all'),
    filter.from,
    filter.to
  );

  if (range.from) {
    conditions.push(`r.date >= $${index}::date`);
    params.push(range.from);
    index += 1;
  }
  if (range.to) {
    // `< to + 1 day` keeps timestamp-typed columns inclusive of the final day.
    conditions.push(`r.date < ($${index}::date + INTERVAL '1 day')`);
    params.push(range.to);
    index += 1;
  }

  const categories = filter.category
    ? (Array.isArray(filter.category) ? filter.category : [filter.category]).filter(Boolean)
    : [];
  if (categories.length === 1) {
    conditions.push(`r.category = $${index}`);
    params.push(categories[0]);
    index += 1;
  } else if (categories.length > 1) {
    conditions.push(`r.category = ANY($${index}::text[])`);
    params.push(categories);
    index += 1;
  }

  if (filter.concept && filter.concept !== 'all') {
    conditions.push(`UPPER(r.concept) = $${index}`);
    params.push(filter.concept.toUpperCase());
    index += 1;
  }

  if (filter.accountId) {
    conditions.push(`r.account_id = $${index}`);
    params.push(filter.accountId);
    index += 1;
  }

  if (filter.search) {
    // Case-insensitive match across the free-text columns.
    conditions.push(
      `(r.description ILIKE $${index} OR r.category ILIKE $${index} OR r.concept ILIKE $${index})`
    );
    params.push(`%${filter.search}%`);
    index += 1;
  }

  if (filter.status && filter.status !== 'all' && schemaInfo().hasPending) {
    conditions.push(
      filter.status === 'pending'
        ? 'COALESCE(r.pending, FALSE) = TRUE'
        : 'COALESCE(r.pending, FALSE) = FALSE'
    );
  }

  if (typeof filter.minValue === 'number' && Number.isFinite(filter.minValue)) {
    conditions.push(`${readValueSql()} >= $${index}`);
    params.push(filter.minValue);
    index += 1;
  }
  if (typeof filter.maxValue === 'number' && Number.isFinite(filter.maxValue)) {
    conditions.push(`${readValueSql()} <= $${index}`);
    params.push(filter.maxValue);
    index += 1;
  }

  return {
    sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Whitelist of sortable columns. `value` is resolved through `readValueSql()`
 * so it sorts numerically even when the column is `money` (which would
 * otherwise sort as formatted text).
 */
const SORT_COLUMNS: Record<string, () => string> = {
  date: () => 'r.date',
  value: () => readValueSql(),
  category: () => 'r.category',
  concept: () => 'r.concept',
  create_time: () => 'r.create_time',
};

/** Whitelisted ORDER BY — never interpolates raw user input. */
export function buildOrderBy(sort: string | undefined, dir: string | undefined): string {
  const direction = dir?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const key = sort && sort in SORT_COLUMNS ? sort : 'date';
  const column = SORT_COLUMNS[key]!();
  // `id` breaks ties so pagination stays stable across pages.
  return `ORDER BY ${column} ${direction}, r.id ${direction}`;
}

export function toFilter(query: RecordQuery): RecordFilter {
  return {
    search: query.search,
    from: query.from ?? null,
    to: query.to ?? null,
    preset: query.preset,
    category: query.category,
    concept: query.concept,
    accountId: query.accountId,
    minValue: query.minValue,
    maxValue: query.maxValue,
    status: query.status,
  };
}
