/**
 * End-to-end smoke test.
 *
 * Exercises every endpoint against a running server, including the legacy
 * routes, and asserts on the actual responses. Run with:
 *   BASE_URL=http://localhost:3310 node scripts/smoke.ts
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3310';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail).slice(0, 300)}`}`);
  }
}

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const type = response.headers.get('content-type') ?? '';

  // Always keep the raw bytes: `response.text()` strips a leading BOM per the
  // fetch spec, which would hide whether the CSV export actually emits one.
  const raw = Buffer.from(await response.arrayBuffer());
  const text = raw.toString('utf8');
  const body = type.includes('json') ? (text ? JSON.parse(text) : null) : type.includes('text') || type.includes('csv') ? text : raw;

  return { status: response.status, body, raw, headers: response.headers };
}

function section(title: string): void {
  console.log(`\n▸ ${title}`);
}

async function main() {
  console.log(`Smoke test against ${BASE}\n${'='.repeat(50)}`);

  /* -------------------------------------------------- */
  section('Health & legacy compatibility');

  const health = await api('/health');
  check('GET /health returns ok', health.status === 200 && health.body.status === 'ok', health.body);
  check('reports the money column type', health.body.valueColumn === 'money', health.body);

  const root = await api('/');
  check('GET / keeps original response', root.body === 'Conectado exitosamente', root.body);

  const legacyRecords = await api('/record');
  check('GET /record returns an array', Array.isArray(legacyRecords.body));
  const legacyFirst = legacyRecords.body[0];
  check(
    'GET /record keeps legacy money string (e.g. "$1,234.00")',
    typeof legacyFirst?.value === 'string' && legacyFirst.value.includes('$'),
    legacyFirst
  );
  check('GET /record now also exposes id', typeof legacyFirst?.id === 'number', legacyFirst);

  const legacyInsert = await api('/insert', {
    method: 'POST',
    body: JSON.stringify({
      date: '2026-03-15',
      concept: 'Outcome',
      category: 'Food',
      description: 'Legacy client insert',
      value: 12345,
    }),
  });
  check('POST /insert still returns {id}', legacyInsert.status === 200 && !!legacyInsert.body.id, legacyInsert.body);

  const legacyDownload = await api('/download');
  check(
    'GET /download returns an xlsx',
    legacyDownload.status === 200 && Buffer.isBuffer(legacyDownload.body) && legacyDownload.body.length > 1000,
    { status: legacyDownload.status, size: (legacyDownload.body as Buffer)?.length }
  );

  /* -------------------------------------------------- */
  section('Records CRUD');

  const created = await api('/api/v1/records', {
    method: 'POST',
    body: JSON.stringify({
      date: '2026-04-10',
      concept: 'Outcome',
      category: 'Tech',
      description: 'Teclado mecánico',
      value: 250000,
    }),
  });
  check('POST creates a record', created.status === 201, created.body);
  check('returns a numeric value, not a money string', typeof created.body.value === 'number', created.body);
  check('value round-trips exactly', created.body.value === 250000, created.body);
  check('date is a plain YYYY-MM-DD string', created.body.date === '2026-04-10', created.body);
  check('category colour is joined in', typeof created.body.categoryColor === 'string', created.body);

  const id = created.body.id;

  const fetched = await api(`/api/v1/records/${id}`);
  check('GET by id works', fetched.status === 200 && fetched.body.id === id, fetched.body);

  // The headline missing feature: correcting a mistyped amount.
  const updated = await api(`/api/v1/records/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ value: 199900, description: 'Teclado mecánico (corregido)' }),
  });
  check('PATCH updates the amount', updated.status === 200 && updated.body.value === 199900, updated.body);
  check('PATCH updates the description', updated.body.description === 'Teclado mecánico (corregido)', updated.body);
  check('PATCH leaves other fields alone', updated.body.category === 'Tech', updated.body);

  const partial = await api(`/api/v1/records/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ category: 'Entertainment' }),
  });
  check('PATCH can change only the category', partial.body.category === 'Entertainment' && partial.body.value === 199900, partial.body);

  const badUpdate = await api(`/api/v1/records/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ value: -50 }),
  });
  check('rejects a negative amount with 422', badUpdate.status === 422, badUpdate.body);
  check('error names the offending field', !!badUpdate.body?.error?.details?.value, badUpdate.body);

  const missing = await api('/api/v1/records/99999999');
  check('unknown id returns 404', missing.status === 404, missing.body);
  check('404 has a friendly message', typeof missing.body?.error?.message === 'string', missing.body);

  /* -------------------------------------------------- */
  section('Filtering, sorting, pagination, totals');

  const list = await api('/api/v1/records?pageSize=5&page=1&sort=value&dir=desc');
  check('list is paginated', list.body.items?.length === 5, { count: list.body.items?.length });
  check('reports total & totalPages', list.body.total > 5 && list.body.totalPages > 1, list.body);
  check(
    'sorts by value descending (numeric, not lexical)',
    list.body.items[0].value >= list.body.items[4].value,
    list.body.items?.map((r: any) => r.value)
  );
  check('totals cover the whole filtered set', typeof list.body.totals?.income === 'number', list.body.totals);
  check(
    'balance equals income - outcome',
    Math.abs(list.body.totals.balance - (list.body.totals.income - list.body.totals.outcome)) < 0.01,
    list.body.totals
  );

  const searched = await api('/api/v1/records?search=Gasolina&pageSize=100');
  check('search matches descriptions', searched.body.items.length > 0, { n: searched.body.items.length });
  check(
    'every search hit actually contains the term',
    searched.body.items.every((r: any) =>
      `${r.description} ${r.category} ${r.concept}`.toLowerCase().includes('gasolina')
    )
  );

  const filtered = await api('/api/v1/records?concept=Income&pageSize=100');
  check(
    'concept filter returns only income',
    filtered.body.items.length > 0 && filtered.body.items.every((r: any) => r.concept === 'Income')
  );
  check('outcome total is 0 when filtering income', filtered.body.totals.outcome === 0, filtered.body.totals);

  const byCategory = await api('/api/v1/records?category=Food&pageSize=100');
  check(
    'category filter works',
    byCategory.body.items.length > 0 && byCategory.body.items.every((r: any) => r.category === 'Food')
  );

  const ranged = await api('/api/v1/records?from=2026-01-01&to=2026-01-31&pageSize=200');
  check(
    'date range is inclusive on both ends',
    ranged.body.items.every((r: any) => r.date >= '2026-01-01' && r.date <= '2026-01-31'),
    ranged.body.items?.slice(0, 3)
  );

  const amountRange = await api('/api/v1/records?minValue=1000000&pageSize=100');
  check(
    'min amount filter works',
    amountRange.body.items.every((r: any) => r.value >= 1000000),
    amountRange.body.items?.slice(0, 3).map((r: any) => r.value)
  );

  const sqlAttempt = await api("/api/v1/records?sort=value;DROP TABLE record--&pageSize=1");
  check('rejects/ignores an injected sort column', sqlAttempt.status === 200, sqlAttempt.body);
  const stillThere = await api('/api/v1/records?pageSize=1');
  check('table survived the injection attempt', stillThere.status === 200 && stillThere.body.total > 0);

  /* -------------------------------------------------- */
  section('Duplicate detection');

  const dupes = await api('/api/v1/records/duplicates?date=2026-04-10&category=Entertainment&value=199900');
  check('finds the duplicate we just created', dupes.body.hasDuplicates === true, dupes.body);
  const noDupes = await api('/api/v1/records/duplicates?date=1999-01-01&category=Food&value=7');
  check('reports no duplicate when there is none', noDupes.body.hasDuplicates === false, noDupes.body);

  /* -------------------------------------------------- */
  section('Categories');

  const categories = await api('/api/v1/categories');
  check('lists categories with usage', categories.body.items.length > 0, { n: categories.body.items?.length });
  const food = categories.body.items.find((c: any) => c.name === 'Food');
  check('seeded from existing records', !!food, categories.body.items?.slice(0, 3));
  check('has a colour and icon', !!food?.color && !!food?.icon, food);
  check('reports spend per category', typeof food?.totalSpent === 'number' && food.totalSpent > 0, food);

  const newCategory = await api('/api/v1/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'Suscripciones', color: '#8b5cf6', icon: 'repeat', kind: 'outcome' }),
  });
  check('creates a category', newCategory.status === 201, newCategory.body);

  const dupCategory = await api('/api/v1/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'suscripciones', color: '#8b5cf6', icon: 'repeat' }),
  });
  check('rejects a duplicate name case-insensitively', dupCategory.status === 409, dupCategory.body);

  const badColor = await api('/api/v1/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'Mal color', color: 'rojo' }),
  });
  check('validates the colour format', badColor.status === 422, badColor.body);

  // Rename must follow through to the records that reference it by name.
  const renamed = await api(`/api/v1/categories/${newCategory.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Suscripciones Digitales' }),
  });
  check('renames a category', renamed.body.name === 'Suscripciones Digitales', renamed.body);

  await api('/api/v1/records', {
    method: 'POST',
    body: JSON.stringify({
      date: '2026-04-11',
      concept: 'Outcome',
      category: 'Suscripciones Digitales',
      description: 'Netflix',
      value: 44900,
    }),
  });

  const renamedAgain = await api(`/api/v1/categories/${newCategory.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Streaming' }),
  });
  check('rename succeeds while in use', renamedAgain.status === 200, renamedAgain.body);
  const movedRecords = await api('/api/v1/records?category=Streaming&pageSize=10');
  check(
    'renaming carries existing records along (no orphans)',
    movedRecords.body.items.length === 1,
    movedRecords.body.items
  );

  const blockedDelete = await api(`/api/v1/categories/${newCategory.body.id}`, { method: 'DELETE' });
  check('refuses to delete a category still in use', blockedDelete.status === 409, blockedDelete.body);
  check('explains how many records are affected', blockedDelete.body?.error?.details?.recordCount === 1, blockedDelete.body);

  const reassignDelete = await api(
    `/api/v1/categories/${newCategory.body.id}?reassignTo=Entertainment`,
    { method: 'DELETE' }
  );
  check('deletes when given a reassignment target', reassignDelete.status === 204, reassignDelete.body);
  const orphanCheck = await api('/api/v1/records?category=Streaming&pageSize=10');
  check('no records left stranded on the deleted category', orphanCheck.body.items.length === 0, orphanCheck.body.items);

  /* -------------------------------------------------- */
  section('Accounts');

  const accounts = await api('/api/v1/accounts');
  check('lists seeded accounts', accounts.body.items.length >= 3, { n: accounts.body.items?.length });
  check('computes a balance per account', typeof accounts.body.items[0].balance === 'number', accounts.body.items[0]);

  const newAccount = await api('/api/v1/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: 'Nequi', kind: 'wallet', color: '#ec4899', openingBalance: 50000 }),
  });
  check('creates an account', newAccount.status === 201, newAccount.body);

  const linked = await api('/api/v1/records', {
    method: 'POST',
    body: JSON.stringify({
      date: '2026-04-12',
      concept: 'Outcome',
      category: 'Food',
      description: 'Domicilio',
      value: 35000,
      accountId: newAccount.body.id,
    }),
  });
  check('links a record to an account', linked.body.accountId === newAccount.body.id, linked.body);
  check('resolves the account name', linked.body.accountName === 'Nequi', linked.body);

  const afterLink = await api('/api/v1/accounts');
  const nequi = afterLink.body.items.find((a: any) => a.name === 'Nequi');
  check('account balance reflects the movement', Math.abs(nequi.balance - (50000 - 35000)) < 0.01, nequi);

  const deletedAccount = await api(`/api/v1/accounts/${newAccount.body.id}`, { method: 'DELETE' });
  check('deletes an account', deletedAccount.status === 204);
  const survivor = await api(`/api/v1/records/${linked.body.id}`);
  check('its records survive with a null account', survivor.status === 200 && survivor.body.accountId === null, survivor.body);

  /* -------------------------------------------------- */
  section('Budgets');

  const budgets = await api('/api/v1/budgets');
  check('lists budgets with progress', budgets.body.items.length > 0, { n: budgets.body.items?.length });
  const budget = budgets.body.items[0];
  check('computes spent', typeof budget.spent === 'number', budget);
  check('computes remaining', Math.abs(budget.remaining - (budget.amount - budget.spent)) < 0.01, budget);
  check('computes used %', typeof budget.usedPercent === 'number', budget);
  check('assigns a status', ['on-track', 'warning', 'exceeded'].includes(budget.status), budget);
  check('resolves the current window', /^\d{4}-\d{2}-\d{2}$/.test(budget.windowFrom), budget);
  check('projects end-of-period spend', typeof budget.projectedSpend === 'number', budget);

  const newBudget = await api('/api/v1/budgets', {
    method: 'POST',
    body: JSON.stringify({
      category: 'Health',
      amount: 500000,
      period: 'monthly',
      startDate: '2026-01-01',
      alertThreshold: 70,
    }),
  });
  check('creates a budget', newBudget.status === 201, newBudget.body);

  const dupBudget = await api('/api/v1/budgets', {
    method: 'POST',
    body: JSON.stringify({ category: 'Health', amount: 100000, period: 'monthly', startDate: '2026-01-01' }),
  });
  check('prevents two active budgets for the same category+period', dupBudget.status === 409, dupBudget.body);

  const badBudget = await api('/api/v1/budgets', {
    method: 'POST',
    body: JSON.stringify({ category: 'No Existe', amount: 1000, period: 'monthly', startDate: '2026-01-01' }),
  });
  check('rejects a budget for an unknown category', badBudget.status === 400, badBudget.body);

  const updatedBudget = await api(`/api/v1/budgets/${newBudget.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ amount: 750000 }),
  });
  check('updates a budget amount', updatedBudget.body.amount === 750000, updatedBudget.body);
  check('deletes a budget', (await api(`/api/v1/budgets/${newBudget.body.id}`, { method: 'DELETE' })).status === 204);

  /* -------------------------------------------------- */
  section('Analytics');

  const overview = await api('/api/v1/analytics/overview?preset=this-month');
  check('overview responds', overview.status === 200, overview.body?.error);
  const k = overview.body.kpis;
  check('has all KPIs', [
    'balance', 'income', 'outcome', 'savings', 'savingsRate', 'pendingAmount',
    'pendingCount', 'budgetTotal', 'budgetSpent', 'budgetRemaining', 'budgetUsedPercent',
    'avgDailySpend', 'largestExpense', 'transactionCount',
  ].every((key) => typeof k?.[key] === 'number'), k);
  check('savings = income - outcome', Math.abs(k.savings - (k.income - k.outcome)) < 0.01, k);
  check('surfaces pending expenses', k.pendingCount > 0, k);
  check('budget remaining is consistent', Math.abs(k.budgetRemaining - (k.budgetTotal - k.budgetSpent)) < 0.01, k);
  check('monthly series present', overview.body.monthly?.length > 1, { n: overview.body.monthly?.length });
  check(
    'monthly balance is cumulative',
    overview.body.monthly.every((m: any, i: number, arr: any[]) =>
      i === 0 || Math.abs(m.balance - (arr[i - 1].balance + m.income - m.outcome)) < 0.01
    ),
    overview.body.monthly?.slice(0, 3)
  );
  check('expenses by category present', overview.body.expensesByCategory?.length > 0);
  check(
    'category percentages sum to ~100',
    Math.abs(overview.body.expensesByCategory.reduce((s: number, c: any) => s + c.percent, 0) - 100) < 1.5,
    overview.body.expensesByCategory?.map((c: any) => c.percent)
  );
  check('includes comparison vs previous period', typeof overview.body.comparison?.income === 'number', overview.body.comparison);
  check('includes top expenses', overview.body.topExpenses?.length > 0);
  check('includes budget progress', overview.body.budgets?.length > 0);

  const monthly = await api('/api/v1/analytics/monthly?limit=6');
  check('monthly endpoint honours limit', monthly.body.items.length <= 6, { n: monthly.body.items?.length });

  const daily = await api('/api/v1/analytics/daily?preset=this-month');
  check('daily series responds', daily.status === 200 && Array.isArray(daily.body.items));

  const cash = await api('/api/v1/analytics/cash-flow?preset=last-12-months');
  check('cash flow responds', cash.status === 200 && cash.body.items.length > 0);

  const catAnalytics = await api('/api/v1/analytics/by-category?preset=this-year&concept=Income');
  check('income breakdown responds', catAnalytics.status === 200 && Array.isArray(catAnalytics.body.items));

  /* -------------------------------------------------- */
  section('Reports & exports');

  const reportList = await api('/api/v1/reports');
  check('lists available reports', reportList.body.items.length === 6, reportList.body.items?.length);

  for (const type of [
    'transactions',
    'expenses-by-category',
    'income-by-category',
    'cash-flow',
    'monthly-summary',
    'budget-vs-actual',
  ]) {
    for (const format of ['pdf', 'xlsx', 'csv'] as const) {
      const report = await api(`/api/v1/reports/export?type=${type}&format=${format}&preset=this-year`);
      const size = Buffer.isBuffer(report.body) ? report.body.length : String(report.body).length;
      check(`${type} → ${format} (${size} bytes)`, report.status === 200 && size > 100, {
        status: report.status,
        size,
      });
      if (format === 'pdf' && Buffer.isBuffer(report.body)) {
        check(`${type} pdf has a valid header`, report.body.subarray(0, 4).toString() === '%PDF');
      }
      if (format === 'csv') {
        // Checked on the raw bytes: EF BB BF is what makes Excel read UTF-8.
        check(
          `${type} csv starts with a UTF-8 BOM`,
          report.raw.subarray(0, 3).toString('hex') === 'efbbbf',
          report.raw.subarray(0, 6).toString('hex')
        );
      }
      if (format === 'xlsx' && Buffer.isBuffer(report.body)) {
        check(`${type} xlsx is a zip container`, report.body.subarray(0, 2).toString() === 'PK');
      }
    }
  }

  const csvInjection = await api('/api/v1/reports/export?type=transactions&format=csv&preset=this-year');
  check('csv guards against formula injection', !/^[=+@]/m.test(String(csvInjection.body).replace(/^﻿/, '')));

  /* -------------------------------------------------- */
  section('Cleanup & bulk operations');

  const bulk = await api('/api/v1/records/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ids: [id, linked.body.id] }),
  });
  check('bulk delete removes records', bulk.body.deleted === 2, bulk.body);
  check('deleted record is gone', (await api(`/api/v1/records/${id}`)).status === 404);

  const badBulk = await api('/api/v1/records/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ids: [] }),
  });
  check('rejects an empty bulk delete', badBulk.status === 422, badBulk.body);

  const unknownRoute = await api('/api/v1/nope');
  check('unknown route returns a structured 404', unknownRoute.status === 404 && !!unknownRoute.body.error, unknownRoute.body);

  /* -------------------------------------------------- */
  console.log(`\n${'='.repeat(50)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((name) => console.log(`  - ${name}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Smoke run crashed:', error);
  process.exit(1);
});
