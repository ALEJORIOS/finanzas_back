import { db } from '../db/driver.ts';
import { readValueSql, schemaInfo, settledSql, writeValueSql } from '../db/schema.ts';
import { AppError } from '../lib/errors.ts';
import { round2 } from '../lib/money.ts';
import type { CreateRecordInput, RecordQuery, UpdateRecordInput } from '../lib/schemas.ts';
import { buildOrderBy, buildRecordWhere, toFilter, type RecordFilter } from './filters.ts';

export interface MovementRecord {
  id: number;
  date: string;
  concept: 'Income' | 'Outcome';
  category: string;
  description: string;
  value: number;
  accountId: number | null;
  accountName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  pending: boolean;
  createTime: string | null;
  updatedAt: string | null;
}

export interface RecordTotals {
  income: number;
  outcome: number;
  balance: number;
  count: number;
  /** Planned movements inside the filtered set, reported separately. */
  pendingAmount: number;
  pendingCount: number;
}

/**
 * Dates are returned as plain `YYYY-MM-DD` strings rather than timestamps.
 * Serialising a `timestamp` to ISO and comparing it client-side is what made
 * the original app's duplicate check timezone-dependent.
 */
function selectColumns(): string {
  const info = schemaInfo();
  return `
    r.id,
    to_char(r.date, 'YYYY-MM-DD')                AS date,
    r.concept,
    r.category,
    COALESCE(r.description, '')                  AS description,
    ${readValueSql()}                            AS value,
    ${info.hasAccountId ? 'r.account_id' : 'NULL::int'} AS account_id,
    a.name                                       AS account_name,
    c.color                                      AS category_color,
    c.icon                                       AS category_icon,
    ${info.hasPending ? 'COALESCE(r.pending, FALSE)' : 'FALSE'} AS pending,
    to_char(r.create_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS create_time,
    ${info.hasUpdatedAt ? `to_char(r.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS')` : 'NULL::text'} AS updated_at
  `;
}

function joins(): string {
  const info = schemaInfo();
  return `
    LEFT JOIN "category" c ON LOWER(c.name) = LOWER(r.category)
    ${info.hasAccountId ? 'LEFT JOIN "account" a ON a.id = r.account_id' : 'LEFT JOIN "account" a ON FALSE'}
  `;
}

function mapRow(row: any): MovementRecord {
  return {
    id: Number(row.id),
    date: row.date,
    concept: String(row.concept).toUpperCase() === 'INCOME' ? 'Income' : 'Outcome',
    category: row.category,
    description: row.description ?? '',
    value: round2(Number(row.value) || 0),
    accountId: row.account_id === null ? null : Number(row.account_id),
    accountName: row.account_name ?? null,
    categoryColor: row.category_color ?? null,
    categoryIcon: row.category_icon ?? null,
    pending: Boolean(row.pending),
    createTime: row.create_time ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export async function listRecords(query: RecordQuery): Promise<{
  items: MovementRecord[];
  total: number;
  totals: RecordTotals;
  page: number;
  pageSize: number;
}> {
  const filter = toFilter(query);
  const where = buildRecordWhere(filter);
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  // Totals are aggregated in SQL over the *whole* filtered set, so the UI can
  // show "total of the filtered results" without downloading every row.
  const [rowsResult, totalsResult] = await Promise.all([
    db().query(
      `SELECT ${selectColumns()}
         FROM "record" r
         ${joins()}
         ${where.sql}
         ${buildOrderBy(query.sort, query.dir)}
        LIMIT $${where.params.length + 1}
       OFFSET $${where.params.length + 2}`,
      [...where.params, pageSize, offset]
    ),
    db().query(
      `SELECT
          COUNT(*)::int AS count,
          COALESCE(SUM(CASE WHEN UPPER(r.concept) = 'INCOME' AND ${settledSql()} THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS income,
          COALESCE(SUM(CASE WHEN UPPER(r.concept) <> 'INCOME' AND ${settledSql()} THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS outcome,
          COALESCE(SUM(CASE WHEN NOT (${settledSql()}) THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS pending_amount,
          COALESCE(SUM(CASE WHEN NOT (${settledSql()}) THEN 1 ELSE 0 END), 0)::int AS pending_count
         FROM "record" r
         ${where.sql}`,
      where.params
    ),
  ]);

  const totalsRow = totalsResult.rows[0] ?? {};
  const income = round2(Number(totalsRow.income) || 0);
  const outcome = round2(Number(totalsRow.outcome) || 0);
  const count = Number(totalsRow.count) || 0;

  return {
    items: rowsResult.rows.map(mapRow),
    total: count,
    page,
    pageSize,
    totals: {
      income,
      outcome,
      balance: round2(income - outcome),
      count,
      pendingAmount: round2(Number(totalsRow.pending_amount) || 0),
      pendingCount: Number(totalsRow.pending_count) || 0,
    },
  };
}

export async function getRecord(id: number): Promise<MovementRecord> {
  const { rows } = await db().query(
    `SELECT ${selectColumns()} FROM "record" r ${joins()} WHERE r.id = $1`,
    [id]
  );
  if (!rows.length) throw AppError.notFound('El movimiento no existe o ya fue eliminado.');
  return mapRow(rows[0]);
}

export async function createRecord(input: CreateRecordInput): Promise<MovementRecord> {
  const info = schemaInfo();
  const columns = ['date', 'concept', 'category', 'description', 'value', 'create_time'];
  const values = ['$1::date', '$2', '$3', '$4', writeValueSql('$5'), 'NOW()'];
  const params: unknown[] = [
    input.date,
    input.concept,
    input.category,
    input.description ?? '',
    input.value,
  ];

  if (info.hasAccountId) {
    columns.push('account_id');
    values.push(`$${params.length + 1}`);
    params.push(input.accountId ?? null);
  }
  if (info.hasPending) {
    columns.push('pending');
    values.push(`$${params.length + 1}`);
    params.push(input.pending ?? false);
  }

  const { rows } = await db().query(
    `INSERT INTO "record" (${columns.join(', ')}) VALUES (${values.join(', ')}) RETURNING id`,
    params
  );

  return getRecord(Number(rows[0].id));
}

/**
 * Partial update. This is the capability the original app was missing entirely —
 * there was no way to correct a mistyped amount short of editing the database.
 */
export async function updateRecord(id: number, input: UpdateRecordInput): Promise<MovementRecord> {
  const info = schemaInfo();
  const assignments: string[] = [];
  const params: unknown[] = [];

  const push = (fragment: (placeholder: string) => string, value: unknown) => {
    params.push(value);
    assignments.push(fragment(`$${params.length}`));
  };

  if (input.date !== undefined) push((p) => `date = ${p}::date`, input.date);
  if (input.concept !== undefined) push((p) => `concept = ${p}`, input.concept);
  if (input.category !== undefined) push((p) => `category = ${p}`, input.category);
  if (input.description !== undefined) push((p) => `description = ${p}`, input.description);
  if (input.value !== undefined) push((p) => `value = ${writeValueSql(p)}`, input.value);
  if (info.hasAccountId && input.accountId !== undefined) {
    push((p) => `account_id = ${p}`, input.accountId ?? null);
  }
  if (info.hasPending && input.pending !== undefined) {
    push((p) => `pending = ${p}`, input.pending);
  }

  if (!assignments.length) throw AppError.badRequest('No se envió ningún cambio.');
  if (info.hasUpdatedAt) assignments.push('updated_at = NOW()');

  params.push(id);
  const { rowCount } = await db().query(
    `UPDATE "record" SET ${assignments.join(', ')} WHERE id = $${params.length}`,
    params
  );
  if (!rowCount) throw AppError.notFound('El movimiento no existe o ya fue eliminado.');

  return getRecord(id);
}

export async function deleteRecord(id: number): Promise<void> {
  const { rowCount } = await db().query('DELETE FROM "record" WHERE id = $1', [id]);
  if (!rowCount) throw AppError.notFound('El movimiento no existe o ya fue eliminado.');
}

export async function deleteRecords(ids: number[]): Promise<number> {
  const { rowCount } = await db().query('DELETE FROM "record" WHERE id = ANY($1::int[])', [ids]);
  return rowCount;
}

/**
 * Duplicate detection for the "you already registered this" warning. The
 * original version pulled *every* record to the browser and filtered in JS;
 * this answers the same question with one indexed query.
 */
export async function findDuplicates(
  date: string,
  category: string,
  value: number,
  excludeId?: number
): Promise<MovementRecord[]> {
  const params: unknown[] = [date, category, value];
  let exclude = '';
  if (excludeId) {
    params.push(excludeId);
    exclude = `AND r.id <> $${params.length}`;
  }

  const { rows } = await db().query(
    `SELECT ${selectColumns()}
       FROM "record" r
       ${joins()}
      WHERE r.date::date = $1::date
        AND LOWER(r.category) = LOWER($2)
        AND ABS(${readValueSql()} - $3::numeric::float8) < 0.005
        ${exclude}
      LIMIT 10`,
    params
  );
  return rows.map(mapRow);
}

/** All records matching a filter, for exports. Capped to keep memory bounded. */
export async function listAllForExport(
  filter: RecordFilter,
  limit = 20_000
): Promise<MovementRecord[]> {
  const where = buildRecordWhere(filter);
  const { rows } = await db().query(
    `SELECT ${selectColumns()}
       FROM "record" r
       ${joins()}
       ${where.sql}
      ORDER BY r.date DESC, r.id DESC
      LIMIT $${where.params.length + 1}`,
    [...where.params, limit]
  );
  return rows.map(mapRow);
}

export async function countByCategory(name: string): Promise<number> {
  const { rows } = await db().query(
    'SELECT COUNT(*)::int AS count FROM "record" WHERE LOWER(category) = LOWER($1)',
    [name]
  );
  return Number(rows[0]?.count) || 0;
}
