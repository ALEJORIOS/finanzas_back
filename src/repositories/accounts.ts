import { db } from '../db/driver.ts';
import { readValueSql, schemaInfo } from '../db/schema.ts';
import { AppError } from '../lib/errors.ts';
import { round2 } from '../lib/money.ts';
import type { CreateAccountInput } from '../lib/schemas.ts';

export interface Account {
  id: number;
  name: string;
  kind: 'cash' | 'bank' | 'card' | 'wallet' | 'other';
  color: string;
  icon: string;
  openingBalance: number;
  archived: boolean;
  /** Opening balance plus every movement assigned to this account. */
  balance?: number;
  recordCount?: number;
}

function mapRow(row: any): Account {
  const opening = round2(Number(row.opening_balance) || 0);
  return {
    id: Number(row.id),
    name: row.name,
    kind: row.kind,
    color: row.color,
    icon: row.icon,
    openingBalance: opening,
    archived: Boolean(row.archived),
    ...(row.net !== undefined
      ? { balance: round2(opening + (Number(row.net) || 0)), recordCount: Number(row.record_count) || 0 }
      : {}),
  };
}

export async function listAccounts(includeArchived = false): Promise<Account[]> {
  const where = includeArchived ? '' : 'WHERE NOT a.archived';

  // Accounts are only meaningful once records can reference them.
  if (!schemaInfo().hasAccountId) {
    const { rows } = await db().query(`SELECT * FROM "account" a ${where} ORDER BY LOWER(a.name)`);
    return rows.map(mapRow);
  }

  const { rows } = await db().query(`
    WITH movement AS (
      SELECT r.account_id,
             COUNT(*)::int AS record_count,
             COALESCE(SUM(CASE WHEN UPPER(r.concept) = 'INCOME'
                               THEN ${readValueSql()} ELSE -${readValueSql()} END), 0)::float8 AS net
        FROM "record" r
       WHERE r.account_id IS NOT NULL
       GROUP BY r.account_id
    )
    SELECT a.*, COALESCE(m.net, 0) AS net, COALESCE(m.record_count, 0) AS record_count
      FROM "account" a
      LEFT JOIN movement m ON m.account_id = a.id
      ${where}
     ORDER BY LOWER(a.name)
  `);
  return rows.map(mapRow);
}

export async function getAccount(id: number): Promise<Account> {
  const { rows } = await db().query('SELECT * FROM "account" WHERE id = $1', [id]);
  if (!rows.length) throw AppError.notFound('La cuenta no existe.');
  return mapRow(rows[0]);
}

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  const { rows: clash } = await db().query(
    'SELECT id FROM "account" WHERE LOWER(name) = LOWER($1)',
    [input.name]
  );
  if (clash.length) throw AppError.conflict(`Ya existe una cuenta llamada "${input.name}".`);

  const { rows } = await db().query(
    `INSERT INTO "account" (name, kind, color, icon, opening_balance)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.name, input.kind, input.color, input.icon, input.openingBalance]
  );
  return mapRow(rows[0]);
}

export async function updateAccount(
  id: number,
  input: Partial<CreateAccountInput> & { archived?: boolean }
): Promise<Account> {
  const assignments: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  };

  if (input.name !== undefined) {
    const { rows: clash } = await db().query(
      'SELECT id FROM "account" WHERE LOWER(name) = LOWER($1) AND id <> $2',
      [input.name, id]
    );
    if (clash.length) throw AppError.conflict(`Ya existe una cuenta llamada "${input.name}".`);
    push('name', input.name);
  }
  if (input.kind !== undefined) push('kind', input.kind);
  if (input.color !== undefined) push('color', input.color);
  if (input.icon !== undefined) push('icon', input.icon);
  if (input.openingBalance !== undefined) push('opening_balance', input.openingBalance);
  if (input.archived !== undefined) push('archived', input.archived);

  if (!assignments.length) return getAccount(id);
  assignments.push('updated_at = NOW()');

  params.push(id);
  const { rows } = await db().query(
    `UPDATE "account" SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows.length) throw AppError.notFound('La cuenta no existe.');
  return mapRow(rows[0]);
}

/** Records keep their history; they simply become "sin cuenta". */
export async function deleteAccount(id: number): Promise<void> {
  await db().transaction(async (tx) => {
    const { rows } = await tx.query('SELECT id FROM "account" WHERE id = $1', [id]);
    if (!rows.length) throw AppError.notFound('La cuenta no existe.');

    if (schemaInfo().hasAccountId) {
      await tx.query('UPDATE "record" SET account_id = NULL WHERE account_id = $1', [id]);
    }
    await tx.query('DELETE FROM "account" WHERE id = $1', [id]);
  });
}
