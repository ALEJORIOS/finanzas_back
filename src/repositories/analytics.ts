import { db } from '../db/driver.ts';
import { readValueSql, settledSql } from '../db/schema.ts';
import { percentage, round2, safeDivide } from '../lib/money.ts';
import {
  parseIsoDate,
  previousRange,
  resolveRange,
  type DateRange,
  type PeriodPreset,
} from '../lib/period.ts';
import { budgetProgress, type BudgetProgress } from './budgets.ts';
import { buildRecordWhere, type RecordFilter } from './filters.ts';

export interface MonthlyPoint {
  month: string;
  income: number;
  outcome: number;
  savings: number;
  /** Running net balance from the beginning of history through this month. */
  balance: number;
}

export interface DailyPoint {
  date: string;
  income: number;
  outcome: number;
}

export interface CategorySlice {
  category: string;
  color: string;
  icon: string;
  total: number;
  count: number;
  percent: number;
  /** Same figure for the previous period, so the UI can show movement. */
  previousTotal: number;
}

export interface Kpis {
  balance: number;
  income: number;
  outcome: number;
  savings: number;
  savingsRate: number;
  pendingAmount: number;
  pendingCount: number;
  transactionCount: number;
  avgDailySpend: number;
  largestExpense: number;
  budgetTotal: number;
  budgetSpent: number;
  budgetRemaining: number;
  budgetUsedPercent: number;
}

export interface Comparison {
  income: number;
  outcome: number;
  savings: number;
}

export interface Overview {
  range: DateRange;
  kpis: Kpis;
  /** Percentage change against the immediately preceding period. */
  comparison: Comparison;
  monthly: MonthlyPoint[];
  daily: DailyPoint[];
  expensesByCategory: CategorySlice[];
  incomeByCategory: CategorySlice[];
  budgets: BudgetProgress[];
  topExpenses: Array<{
    id: number;
    date: string;
    category: string;
    description: string;
    value: number;
    color: string | null;
  }>;
}

/** Income/expense totals for an arbitrary filter, computed entirely in SQL. */
async function totalsFor(filter: RecordFilter): Promise<{
  income: number;
  outcome: number;
  count: number;
  pendingAmount: number;
  pendingCount: number;
  largestExpense: number;
}> {
  const where = buildRecordWhere(filter);
  const { rows } = await db().query(
    `SELECT
        COALESCE(SUM(CASE WHEN UPPER(r.concept) = 'INCOME'  AND ${settledSql()} THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS income,
        COALESCE(SUM(CASE WHEN UPPER(r.concept) <> 'INCOME' AND ${settledSql()} THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS outcome,
        COALESCE(SUM(CASE WHEN NOT (${settledSql()}) THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS pending_amount,
        COALESCE(SUM(CASE WHEN NOT (${settledSql()}) THEN 1 ELSE 0 END), 0)::int AS pending_count,
        COALESCE(MAX(CASE WHEN UPPER(r.concept) <> 'INCOME' AND ${settledSql()} THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS largest_expense,
        COUNT(*)::int AS count
       FROM "record" r
       ${where.sql}`,
    where.params
  );

  const row = rows[0] ?? {};
  return {
    income: round2(Number(row.income) || 0),
    outcome: round2(Number(row.outcome) || 0),
    count: Number(row.count) || 0,
    pendingAmount: round2(Number(row.pending_amount) || 0),
    pendingCount: Number(row.pending_count) || 0,
    largestExpense: round2(Number(row.largest_expense) || 0),
  };
}

/**
 * Monthly aggregates across *all* history, with a running balance.
 *
 * Computing the cumulative balance needs every month, so the aggregation runs
 * over the whole table (one grouped scan) and only the tail is returned.
 */
export async function monthlySeries(limit = 12): Promise<MonthlyPoint[]> {
  const { rows } = await db().query(
    `SELECT to_char(r.date, 'YYYY-MM') AS month,
            COALESCE(SUM(CASE WHEN UPPER(r.concept) = 'INCOME'  AND ${settledSql()} THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS income,
            COALESCE(SUM(CASE WHEN UPPER(r.concept) <> 'INCOME' AND ${settledSql()} THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS outcome
       FROM "record" r
      WHERE ${settledSql()}
      GROUP BY 1
      ORDER BY 1`
  );

  let running = 0;
  const all: MonthlyPoint[] = rows.map((row: any) => {
    const income = round2(Number(row.income) || 0);
    const outcome = round2(Number(row.outcome) || 0);
    running = round2(running + income - outcome);
    return { month: row.month, income, outcome, savings: round2(income - outcome), balance: running };
  });

  return all.slice(-limit);
}

export async function dailySeries(range: DateRange): Promise<DailyPoint[]> {
  // `status: settled` keeps planned movements from creating empty buckets.
  const where = buildRecordWhere({
    from: range.from,
    to: range.to,
    preset: 'custom',
    status: 'settled',
  });
  const { rows } = await db().query(
    `SELECT to_char(r.date, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(CASE WHEN UPPER(r.concept) = 'INCOME'  AND ${settledSql()} THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS income,
            COALESCE(SUM(CASE WHEN UPPER(r.concept) <> 'INCOME' AND ${settledSql()} THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS outcome
       FROM "record" r
       ${where.sql}
      GROUP BY 1
      ORDER BY 1`,
    where.params
  );

  return rows.map((row: any) => ({
    date: row.date,
    income: round2(Number(row.income) || 0),
    outcome: round2(Number(row.outcome) || 0),
  }));
}

/**
 * Category breakdown for a period, joined against the previous period so each
 * slice can show whether it grew or shrank.
 */
export async function categoryBreakdown(
  range: DateRange,
  concept: 'Income' | 'Outcome'
): Promise<CategorySlice[]> {
  const previous = previousRange(range);
  const isIncome = concept === 'Income';
  const conceptTest = isIncome ? '=' : '<>';

  const current = buildRecordWhere({ from: range.from, to: range.to, preset: 'custom' });
  const prior = buildRecordWhere(
    { from: previous.from, to: previous.to, preset: 'custom' },
    current.params.length + 1
  );

  const { rows } = await db().query(
    `WITH current AS (
        SELECT r.category,
               COALESCE(SUM(${readValueSql()}), 0)::float8 AS total,
               COUNT(*)::int AS count
          FROM "record" r
          ${current.sql}
           ${current.sql ? 'AND' : 'WHERE'} UPPER(r.concept) ${conceptTest} 'INCOME' AND ${settledSql()}
         GROUP BY 1
     ),
     prior AS (
        SELECT r.category,
               COALESCE(SUM(${readValueSql()}), 0)::float8 AS total
          FROM "record" r
          ${prior.sql}
           ${prior.sql ? 'AND' : 'WHERE'} UPPER(r.concept) ${conceptTest} 'INCOME' AND ${settledSql()}
         GROUP BY 1
     )
     SELECT c.category,
            c.total,
            c.count,
            COALESCE(p.total, 0) AS previous_total,
            COALESCE(cat.color, '#94a3b8') AS color,
            COALESCE(cat.icon, 'dots') AS icon
       FROM current c
       LEFT JOIN prior p ON LOWER(p.category) = LOWER(c.category)
       LEFT JOIN "category" cat ON LOWER(cat.name) = LOWER(c.category)
      ORDER BY c.total DESC`,
    [...current.params, ...prior.params]
  );

  const grandTotal = rows.reduce((sum: number, row: any) => sum + (Number(row.total) || 0), 0);

  return rows.map((row: any) => ({
    category: row.category,
    color: row.color,
    icon: row.icon,
    total: round2(Number(row.total) || 0),
    count: Number(row.count) || 0,
    percent: percentage(Number(row.total) || 0, grandTotal),
    previousTotal: round2(Number(row.previous_total) || 0),
  }));
}

async function topExpenses(range: DateRange, limit = 5) {
  const where = buildRecordWhere({
    from: range.from,
    to: range.to,
    preset: 'custom',
    concept: 'Outcome',
    status: 'settled',
  });
  const { rows } = await db().query(
    `SELECT r.id,
            to_char(r.date, 'YYYY-MM-DD') AS date,
            r.category,
            COALESCE(r.description, '') AS description,
            ${readValueSql()} AS value,
            c.color
       FROM "record" r
       LEFT JOIN "category" c ON LOWER(c.name) = LOWER(r.category)
       ${where.sql}
      ORDER BY ${readValueSql()} DESC
      LIMIT $${where.params.length + 1}`,
    [...where.params, limit]
  );

  return rows.map((row: any) => ({
    id: Number(row.id),
    date: row.date,
    category: row.category,
    description: row.description,
    value: round2(Number(row.value) || 0),
    color: row.color ?? null,
  }));
}

function changePercent(current: number, previous: number): number {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

export async function overview(
  preset: string | undefined,
  from?: string | null,
  to?: string | null
): Promise<Overview> {
  const range = resolveRange((preset as PeriodPreset) ?? 'this-month', from, to);
  const previous = previousRange(range);

  const periodFilter: RecordFilter = { from: range.from, to: range.to, preset: 'custom' };

  // Everything the dashboard needs, resolved concurrently in a single request.
  const [
    current,
    prior,
    allTime,
    monthly,
    daily,
    expensesByCategory,
    incomeByCategory,
    budgets,
    top,
  ] = await Promise.all([
    totalsFor(periodFilter),
    previous.from ? totalsFor({ from: previous.from, to: previous.to, preset: 'custom' }) : null,
    totalsFor({ preset: 'all' }),
    monthlySeries(12),
    dailySeries(range),
    categoryBreakdown(range, 'Outcome'),
    categoryBreakdown(range, 'Income'),
    budgetProgress(),
    topExpenses(range),
  ]);

  const savings = round2(current.income - current.outcome);
  const budgetTotal = round2(budgets.reduce((sum, b) => sum + b.amount, 0));
  const budgetSpent = round2(budgets.reduce((sum, b) => sum + b.spent, 0));

  // Average daily spend uses the days actually elapsed in the range, so a
  // mid-month view is not diluted by days that have not happened yet.
  const days = (() => {
    if (!range.from || !range.to) return Math.max(1, daily.length);
    const start = parseIsoDate(range.from);
    const end = parseIsoDate(range.to);
    const today = new Date();
    const effectiveEnd = end.getTime() > today.getTime() ? today : end;
    return Math.max(1, Math.round((effectiveEnd.getTime() - start.getTime()) / 86_400_000) + 1);
  })();

  return {
    range,
    kpis: {
      balance: round2(allTime.income - allTime.outcome),
      income: current.income,
      outcome: current.outcome,
      savings,
      savingsRate: percentage(savings, current.income),
      pendingAmount: current.pendingAmount,
      pendingCount: current.pendingCount,
      transactionCount: current.count,
      avgDailySpend: round2(safeDivide(current.outcome, days)),
      largestExpense: current.largestExpense,
      budgetTotal,
      budgetSpent,
      budgetRemaining: round2(budgetTotal - budgetSpent),
      budgetUsedPercent: percentage(budgetSpent, budgetTotal),
    },
    comparison: {
      income: prior ? changePercent(current.income, prior.income) : 0,
      outcome: prior ? changePercent(current.outcome, prior.outcome) : 0,
      savings: prior ? changePercent(savings, prior.income - prior.outcome) : 0,
    },
    monthly,
    daily,
    expensesByCategory,
    incomeByCategory,
    budgets,
    topExpenses: top,
  };
}

/** Month-by-month cash flow used by the reports screen. */
export async function cashFlow(range: DateRange): Promise<MonthlyPoint[]> {
  const where = buildRecordWhere({
    from: range.from,
    to: range.to,
    preset: 'custom',
    status: 'settled',
  });
  const { rows } = await db().query(
    `SELECT to_char(r.date, 'YYYY-MM') AS month,
            COALESCE(SUM(CASE WHEN UPPER(r.concept) = 'INCOME'  AND ${settledSql()} THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS income,
            COALESCE(SUM(CASE WHEN UPPER(r.concept) <> 'INCOME' AND ${settledSql()} THEN ${readValueSql()} ELSE 0 END), 0)::float8 AS outcome
       FROM "record" r
       ${where.sql}
      GROUP BY 1
      ORDER BY 1`,
    where.params
  );

  let running = 0;
  return rows.map((row: any) => {
    const income = round2(Number(row.income) || 0);
    const outcome = round2(Number(row.outcome) || 0);
    running = round2(running + income - outcome);
    return { month: row.month, income, outcome, savings: round2(income - outcome), balance: running };
  });
}
