import { db } from '../db/driver.ts';
import { readValueSql, settledSql } from '../db/schema.ts';
import { AppError } from '../lib/errors.ts';
import { percentage, round2 } from '../lib/money.ts';
import { budgetWindow, parseIsoDate, toIsoDate } from '../lib/period.ts';
import type { CreateBudgetInput } from '../lib/schemas.ts';

export type BudgetStatus = 'on-track' | 'warning' | 'exceeded';

export interface Budget {
  id: number;
  /** `null` means the budget covers total spending across every category. */
  category: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  amount: number;
  period: 'monthly' | 'weekly' | 'yearly' | 'custom';
  startDate: string;
  endDate: string | null;
  alertThreshold: number;
  active: boolean;
  note: string;
}

export interface BudgetProgress extends Budget {
  /** The concrete window the budget currently applies to. */
  windowFrom: string;
  windowTo: string;
  spent: number;
  remaining: number;
  usedPercent: number;
  status: BudgetStatus;
  /** Days left in the current window; 0 once it has closed. */
  daysRemaining: number;
  /** What can still be spent per remaining day without going over. */
  dailyAllowance: number;
  /** Straight-line projection of where spending lands at this pace. */
  projectedSpend: number;
}

function mapRow(row: any): Budget {
  return {
    id: Number(row.id),
    category: row.category ?? null,
    categoryColor: row.category_color ?? null,
    categoryIcon: row.category_icon ?? null,
    amount: round2(Number(row.amount) || 0),
    period: row.period,
    startDate: row.start_date,
    endDate: row.end_date ?? null,
    alertThreshold: Number(row.alert_threshold) || 80,
    active: Boolean(row.active),
    note: row.note ?? '',
  };
}

const SELECT = `
  SELECT b.id, b.category, b.amount, b.period,
         to_char(b.start_date, 'YYYY-MM-DD') AS start_date,
         to_char(b.end_date,   'YYYY-MM-DD') AS end_date,
         b.alert_threshold, b.active, b.note,
         c.color AS category_color, c.icon AS category_icon
    FROM "budget" b
    LEFT JOIN "category" c ON LOWER(c.name) = LOWER(b.category)
`;

export async function listBudgets(includeInactive = false): Promise<Budget[]> {
  const { rows } = await db().query(
    `${SELECT} ${includeInactive ? '' : 'WHERE b.active'} ORDER BY b.active DESC, LOWER(COALESCE(b.category, '')) `
  );
  return rows.map(mapRow);
}

export async function getBudget(id: number): Promise<Budget> {
  const { rows } = await db().query(`${SELECT} WHERE b.id = $1`, [id]);
  if (!rows.length) throw AppError.notFound('El presupuesto no existe.');
  return mapRow(rows[0]);
}

export async function createBudget(input: CreateBudgetInput): Promise<Budget> {
  if (input.period === 'custom' && !input.endDate) {
    throw AppError.badRequest('Un presupuesto personalizado necesita una fecha de fin.');
  }
  if (input.endDate && input.endDate < input.startDate) {
    throw AppError.badRequest('La fecha de fin debe ser posterior a la de inicio.');
  }
  if (input.category) {
    const { rows } = await db().query('SELECT id FROM "category" WHERE LOWER(name) = LOWER($1)', [
      input.category,
    ]);
    if (!rows.length) throw AppError.badRequest(`La categoría "${input.category}" no existe.`);
  }

  // The partial unique index enforces this too; checking first gives a clearer message.
  const { rows: clash } = await db().query(
    `SELECT id FROM "budget"
      WHERE active AND period = $1
        AND COALESCE(LOWER(category), '*') = COALESCE(LOWER($2), '*')`,
    [input.period, input.category ?? null]
  );
  if (clash.length) {
    throw AppError.conflict(
      input.category
        ? `Ya existe un presupuesto ${input.period} activo para "${input.category}".`
        : `Ya existe un presupuesto ${input.period} global activo.`
    );
  }

  const { rows } = await db().query(
    `INSERT INTO "budget" (category, amount, period, start_date, end_date, alert_threshold, note)
     VALUES ($1, $2, $3, $4::date, $5::date, $6, $7) RETURNING id`,
    [
      input.category ?? null,
      input.amount,
      input.period,
      input.startDate,
      input.endDate ?? null,
      input.alertThreshold,
      input.note ?? '',
    ]
  );
  return getBudget(Number(rows[0].id));
}

export async function updateBudget(
  id: number,
  input: Partial<CreateBudgetInput> & { active?: boolean }
): Promise<Budget> {
  const assignments: string[] = [];
  const params: unknown[] = [];
  const push = (fragment: (placeholder: string) => string, value: unknown) => {
    params.push(value);
    assignments.push(fragment(`$${params.length}`));
  };

  if (input.category !== undefined) push((p) => `category = ${p}`, input.category ?? null);
  if (input.amount !== undefined) push((p) => `amount = ${p}`, input.amount);
  if (input.period !== undefined) push((p) => `period = ${p}`, input.period);
  if (input.startDate !== undefined) push((p) => `start_date = ${p}::date`, input.startDate);
  if (input.endDate !== undefined) push((p) => `end_date = ${p}::date`, input.endDate ?? null);
  if (input.alertThreshold !== undefined) push((p) => `alert_threshold = ${p}`, input.alertThreshold);
  if (input.active !== undefined) push((p) => `active = ${p}`, input.active);
  if (input.note !== undefined) push((p) => `note = ${p}`, input.note);

  if (!assignments.length) return getBudget(id);
  assignments.push('updated_at = NOW()');

  params.push(id);
  const { rowCount } = await db().query(
    `UPDATE "budget" SET ${assignments.join(', ')} WHERE id = $${params.length}`,
    params
  );
  if (!rowCount) throw AppError.notFound('El presupuesto no existe.');
  return getBudget(id);
}

export async function deleteBudget(id: number): Promise<void> {
  const { rowCount } = await db().query('DELETE FROM "budget" WHERE id = $1', [id]);
  if (!rowCount) throw AppError.notFound('El presupuesto no existe.');
}

/**
 * Resolves every active budget against actual spending in one query per
 * budget window, and derives the indicators the UI needs (status, projection,
 * remaining daily allowance).
 */
export async function budgetProgress(
  today = new Date(),
  includeInactive = false
): Promise<BudgetProgress[]> {
  const budgets = await listBudgets(includeInactive);
  if (!budgets.length) return [];

  // Group by window so budgets sharing a period cost a single aggregate query.
  const results: BudgetProgress[] = [];

  for (const budget of budgets) {
    const window = budgetWindow(budget.period, budget.startDate, budget.endDate, today);

    const params: unknown[] = [window.from, window.to];
    let categoryClause = '';
    if (budget.category) {
      params.push(budget.category);
      categoryClause = `AND LOWER(r.category) = LOWER($3)`;
    }

    const { rows } = await db().query(
      `SELECT COALESCE(SUM(${readValueSql()}), 0)::float8 AS spent
         FROM "record" r
        WHERE UPPER(r.concept) <> 'INCOME'
          AND ${settledSql()}
          AND r.date >= $1::date
          AND r.date < ($2::date + INTERVAL '1 day')
          ${categoryClause}`,
      params
    );

    const spent = round2(Number(rows[0]?.spent) || 0);
    const usedPercent = percentage(spent, budget.amount);
    const remaining = round2(budget.amount - spent);

    const status: BudgetStatus =
      usedPercent >= 100 ? 'exceeded' : usedPercent >= budget.alertThreshold ? 'warning' : 'on-track';

    const start = parseIsoDate(window.from);
    const end = parseIsoDate(window.to);
    const now = parseIsoDate(toIsoDate(today));

    const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
    const elapsedDays = Math.min(
      totalDays,
      Math.max(1, Math.round((now.getTime() - start.getTime()) / 86_400_000) + 1)
    );
    const daysRemaining = Math.max(0, totalDays - elapsedDays);

    results.push({
      ...budget,
      windowFrom: window.from,
      windowTo: window.to,
      spent,
      remaining,
      usedPercent,
      status,
      daysRemaining,
      dailyAllowance: daysRemaining > 0 ? round2(Math.max(0, remaining) / daysRemaining) : 0,
      projectedSpend: round2((spent / elapsedDays) * totalDays),
    });
  }

  return results;
}
