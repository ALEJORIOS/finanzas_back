import { db } from '../db/driver.ts';
import { readValueSql, settledSql } from '../db/schema.ts';
import { AppError } from '../lib/errors.ts';
import { round2 } from '../lib/money.ts';
import type { CreateCategoryInput } from '../lib/schemas.ts';
import { buildRecordWhere, type RecordFilter } from './filters.ts';

export interface Category {
  id: number;
  name: string;
  kind: 'income' | 'outcome' | 'both';
  color: string;
  icon: string;
  archived: boolean;
  sortOrder: number;
  /** Populated by `listCategories` when usage stats are requested. */
  recordCount?: number;
  totalSpent?: number;
  lastUsed?: string | null;
}

function mapRow(row: any): Category {
  return {
    id: Number(row.id),
    name: row.name,
    kind: row.kind,
    color: row.color,
    icon: row.icon,
    archived: Boolean(row.archived),
    sortOrder: Number(row.sort_order) || 0,
    ...(row.record_count !== undefined ? { recordCount: Number(row.record_count) || 0 } : {}),
    ...(row.total_spent !== undefined ? { totalSpent: round2(Number(row.total_spent) || 0) } : {}),
    ...(row.last_used !== undefined ? { lastUsed: row.last_used ?? null } : {}),
  };
}

export async function listCategories(options: {
  includeArchived?: boolean;
  withUsage?: boolean;
  filter?: RecordFilter;
} = {}): Promise<Category[]> {
  const archivedClause = options.includeArchived ? '' : 'WHERE NOT c.archived';

  if (!options.withUsage) {
    const { rows } = await db().query(
      `SELECT * FROM "category" c ${archivedClause} ORDER BY c.sort_order, LOWER(c.name)`
    );
    return rows.map(mapRow);
  }

  // Usage is aggregated in one pass rather than N queries.
  const where = buildRecordWhere(options.filter ?? {});
  const { rows } = await db().query(
    `WITH usage AS (
        SELECT r.category,
               COUNT(*)::int AS record_count,
               COALESCE(SUM(CASE WHEN UPPER(r.concept) <> 'INCOME' AND ${settledSql()}
                                 THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS total_spent,
               to_char(MAX(r.date), 'YYYY-MM-DD') AS last_used
          FROM "record" r
          ${where.sql}
         GROUP BY r.category
     )
     SELECT c.*,
            COALESCE(u.record_count, 0) AS record_count,
            COALESCE(u.total_spent, 0)  AS total_spent,
            u.last_used                 AS last_used
       FROM "category" c
       LEFT JOIN usage u ON LOWER(u.category) = LOWER(c.name)
       ${archivedClause}
      ORDER BY c.sort_order, LOWER(c.name)`,
    where.params
  );
  return rows.map(mapRow);
}

export async function getCategory(id: number): Promise<Category> {
  const { rows } = await db().query('SELECT * FROM "category" WHERE id = $1', [id]);
  if (!rows.length) throw AppError.notFound('La categoría no existe.');
  return mapRow(rows[0]);
}

export async function getCategoryByName(name: string): Promise<Category | null> {
  const { rows } = await db().query('SELECT * FROM "category" WHERE LOWER(name) = LOWER($1)', [
    name,
  ]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function createCategory(input: CreateCategoryInput): Promise<Category> {
  const existing = await getCategoryByName(input.name);
  if (existing) throw AppError.conflict(`Ya existe una categoría llamada "${existing.name}".`);

  const { rows } = await db().query(
    `INSERT INTO "category" (name, kind, color, icon, sort_order)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.name, input.kind, input.color, input.icon, input.sortOrder]
  );
  return mapRow(rows[0]);
}

/**
 * Renaming a category also rewrites the `category` text on every record that
 * used it, inside a transaction. Records reference categories by name, so
 * skipping that step would silently orphan history.
 */
export async function updateCategory(
  id: number,
  input: {
    name?: string;
    kind?: 'income' | 'outcome' | 'both';
    color?: string;
    icon?: string;
    archived?: boolean;
    sortOrder?: number;
  }
): Promise<Category> {
  return db().transaction(async (tx) => {
    const { rows: currentRows } = await tx.query('SELECT * FROM "category" WHERE id = $1', [id]);
    if (!currentRows.length) throw AppError.notFound('La categoría no existe.');
    const current = mapRow(currentRows[0]);

    if (input.name && input.name.toLowerCase() !== current.name.toLowerCase()) {
      const { rows: clash } = await tx.query(
        'SELECT id FROM "category" WHERE LOWER(name) = LOWER($1) AND id <> $2',
        [input.name, id]
      );
      if (clash.length) throw AppError.conflict(`Ya existe una categoría llamada "${input.name}".`);
    }

    const assignments: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };

    if (input.name !== undefined) push('name', input.name);
    if (input.kind !== undefined) push('kind', input.kind);
    if (input.color !== undefined) push('color', input.color);
    if (input.icon !== undefined) push('icon', input.icon);
    if (input.archived !== undefined) push('archived', input.archived);
    if (input.sortOrder !== undefined) push('sort_order', input.sortOrder);

    if (!assignments.length) return current;
    assignments.push('updated_at = NOW()');

    params.push(id);
    const { rows } = await tx.query(
      `UPDATE "category" SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    if (input.name && input.name !== current.name) {
      await tx.query('UPDATE "record" SET category = $1 WHERE LOWER(category) = LOWER($2)', [
        input.name,
        current.name,
      ]);
      await tx.query('UPDATE "budget" SET category = $1 WHERE LOWER(category) = LOWER($2)', [
        input.name,
        current.name,
      ]);
    }

    return mapRow(rows[0]);
  });
}

export interface CategoryUsage {
  recordCount: number;
  budgetCount: number;
}

export async function categoryUsage(name: string): Promise<CategoryUsage> {
  const [records, budgets] = await Promise.all([
    db().query('SELECT COUNT(*)::int AS count FROM "record" WHERE LOWER(category) = LOWER($1)', [
      name,
    ]),
    db().query('SELECT COUNT(*)::int AS count FROM "budget" WHERE LOWER(category) = LOWER($1)', [
      name,
    ]),
  ]);
  return {
    recordCount: Number(records.rows[0]?.count) || 0,
    budgetCount: Number(budgets.rows[0]?.count) || 0,
  };
}

/**
 * Deleting a category that is still in use would leave records pointing at a
 * name that no longer exists. We refuse unless the caller explicitly says where
 * to move those records, and offer archiving as the non-destructive option.
 */
export async function deleteCategory(id: number, reassignTo?: string | null): Promise<void> {
  await db().transaction(async (tx) => {
    const { rows } = await tx.query('SELECT * FROM "category" WHERE id = $1', [id]);
    if (!rows.length) throw AppError.notFound('La categoría no existe.');
    const category = mapRow(rows[0]);

    const { rows: countRows } = await tx.query(
      'SELECT COUNT(*)::int AS count FROM "record" WHERE LOWER(category) = LOWER($1)',
      [category.name]
    );
    const inUse = Number(countRows[0]?.count) || 0;

    if (inUse > 0) {
      if (!reassignTo) {
        throw AppError.conflict(
          `"${category.name}" tiene ${inUse} movimiento(s). Elige otra categoría a la cual moverlos o archívala.`,
          { recordCount: inUse, requiresReassign: true }
        );
      }

      const { rows: targetRows } = await tx.query(
        'SELECT name FROM "category" WHERE LOWER(name) = LOWER($1)',
        [reassignTo]
      );
      if (!targetRows.length) {
        throw AppError.badRequest(`La categoría destino "${reassignTo}" no existe.`);
      }
      if (targetRows[0].name.toLowerCase() === category.name.toLowerCase()) {
        throw AppError.badRequest('La categoría destino debe ser diferente.');
      }

      await tx.query('UPDATE "record" SET category = $1 WHERE LOWER(category) = LOWER($2)', [
        targetRows[0].name,
        category.name,
      ]);
    }

    await tx.query('DELETE FROM "budget" WHERE LOWER(category) = LOWER($1)', [category.name]);
    await tx.query('DELETE FROM "category" WHERE id = $1', [id]);
  });
}
