import ExcelJS from 'exceljs';
import { env } from '../config/env.ts';
import type { MovementRecord } from '../repositories/records.ts';
import type { CategorySlice, MonthlyPoint } from '../repositories/analytics.ts';
import type { BudgetProgress } from '../repositories/budgets.ts';
import type { DateRange } from '../lib/period.ts';
import { round2 } from '../lib/money.ts';

const BRAND = 'FF4F46E5';
const HEADER_TEXT = 'FFFFFFFF';
const MONEY_FORMAT = '#,##0.00';

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: HEADER_TEXT }, size: 11 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  row.alignment = { vertical: 'middle', horizontal: 'left' };
  row.height = 22;
}

function autoFilterAndFreeze(sheet: ExcelJS.Worksheet, columnCount: number): void {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columnCount },
  };
}

function rangeLabel(range: DateRange): string {
  if (!range.from && !range.to) return 'Todo el histórico';
  return `${range.from ?? '…'} a ${range.to ?? '…'}`;
}

/**
 * Transactions workbook. Replaces the original single unformatted sheet with a
 * summary sheet plus a filterable, typed detail sheet.
 */
export async function buildTransactionsWorkbook(
  records: MovementRecord[],
  range: DateRange
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Finanzas';
  workbook.created = new Date();

  const income = round2(
    records.filter((r) => r.concept === 'Income' && !r.pending).reduce((s, r) => s + r.value, 0)
  );
  const outcome = round2(
    records.filter((r) => r.concept === 'Outcome' && !r.pending).reduce((s, r) => s + r.value, 0)
  );

  /* ---- Summary ---- */
  const summary = workbook.addWorksheet('Resumen');
  summary.columns = [
    { key: 'label', width: 28 },
    { key: 'value', width: 22 },
  ];
  summary.addRow({ label: 'Reporte', value: 'Movimientos' });
  summary.addRow({ label: 'Período', value: rangeLabel(range) });
  summary.addRow({ label: 'Generado', value: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  summary.addRow({ label: 'Moneda', value: env.currency });
  summary.addRow({});
  summary.addRow({ label: 'Movimientos', value: records.length });
  summary.addRow({ label: 'Ingresos', value: income });
  summary.addRow({ label: 'Gastos', value: outcome });
  summary.addRow({ label: 'Balance', value: round2(income - outcome) });

  summary.getColumn('label').font = { bold: true };
  [7, 8, 9].forEach((rowNumber) => {
    summary.getCell(`B${rowNumber}`).numFmt = MONEY_FORMAT;
  });
  summary.getCell('A1').font = { bold: true, size: 14, color: { argb: BRAND } };

  /* ---- Detail ---- */
  const sheet = workbook.addWorksheet('Movimientos');
  sheet.columns = [
    { header: 'Fecha', key: 'date', width: 14 },
    { header: 'Tipo', key: 'concept', width: 12 },
    { header: 'Categoría', key: 'category', width: 22 },
    { header: 'Descripción', key: 'description', width: 46 },
    { header: 'Cuenta', key: 'account', width: 18 },
    { header: 'Estado', key: 'status', width: 12 },
    { header: `Valor (${env.currency})`, key: 'value', width: 18 },
  ];

  for (const record of records) {
    sheet.addRow({
      date: record.date,
      concept: record.concept === 'Income' ? 'Ingreso' : 'Gasto',
      category: record.category,
      description: record.description,
      account: record.accountName ?? '',
      status: record.pending ? 'Pendiente' : 'Registrado',
      // Signed so the column sums to the net balance.
      value: record.concept === 'Income' ? record.value : -record.value,
    });
  }

  styleHeader(sheet.getRow(1));
  autoFilterAndFreeze(sheet, 7);
  sheet.getColumn('value').numFmt = MONEY_FORMAT;

  // Colour income green and expenses red.
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const isIncome = row.getCell('concept').value === 'Ingreso';
    row.getCell('value').font = { color: { argb: isIncome ? 'FF15803D' : 'FFB91C1C' } };
    if (row.getCell('status').value === 'Pendiente') {
      row.getCell('status').font = { color: { argb: 'FFB45309' }, italic: true };
    }
  });

  if (records.length) {
    const totalRow = sheet.addRow({
      date: '',
      concept: '',
      category: '',
      description: '',
      account: '',
      status: 'TOTAL',
      value: { formula: `SUM(G2:G${records.length + 1})` },
    });
    totalRow.font = { bold: true };
    totalRow.getCell('value').numFmt = MONEY_FORMAT;
  }

  return workbook;
}

export async function buildCategoryWorkbook(
  slices: CategorySlice[],
  range: DateRange,
  title: string
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Finanzas';

  const sheet = workbook.addWorksheet(title.slice(0, 30));
  sheet.columns = [
    { header: 'Categoría', key: 'category', width: 26 },
    { header: `Total (${env.currency})`, key: 'total', width: 18 },
    { header: '% del total', key: 'percent', width: 14 },
    { header: 'Movimientos', key: 'count', width: 14 },
    { header: 'Período anterior', key: 'previous', width: 20 },
    { header: 'Variación', key: 'delta', width: 14 },
  ];

  for (const slice of slices) {
    const delta = slice.previousTotal
      ? (slice.total - slice.previousTotal) / slice.previousTotal
      : null;
    sheet.addRow({
      category: slice.category,
      total: slice.total,
      percent: slice.percent / 100,
      count: slice.count,
      previous: slice.previousTotal,
      delta,
    });
  }

  styleHeader(sheet.getRow(1));
  autoFilterAndFreeze(sheet, 6);
  sheet.getColumn('total').numFmt = MONEY_FORMAT;
  sheet.getColumn('previous').numFmt = MONEY_FORMAT;
  sheet.getColumn('percent').numFmt = '0.0%';
  sheet.getColumn('delta').numFmt = '+0.0%;-0.0%;0.0%';

  sheet.insertRow(1, []);
  sheet.getCell('A1').value = `${title} — ${rangeLabel(range)}`;
  sheet.getCell('A1').font = { bold: true, size: 13, color: { argb: BRAND } };

  return workbook;
}

export async function buildBudgetWorkbook(
  budgets: BudgetProgress[]
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Presupuesto vs Real');

  sheet.columns = [
    { header: 'Categoría', key: 'category', width: 26 },
    { header: 'Período', key: 'period', width: 14 },
    { header: 'Ventana', key: 'window', width: 26 },
    { header: `Presupuesto (${env.currency})`, key: 'amount', width: 20 },
    { header: `Gastado (${env.currency})`, key: 'spent', width: 18 },
    { header: `Disponible (${env.currency})`, key: 'remaining', width: 20 },
    { header: '% usado', key: 'used', width: 12 },
    { header: 'Estado', key: 'status', width: 16 },
  ];

  const statusLabel: Record<string, string> = {
    'on-track': 'En control',
    warning: 'Cerca del límite',
    exceeded: 'Excedido',
  };

  for (const budget of budgets) {
    sheet.addRow({
      category: budget.category ?? 'Global (todas)',
      period: budget.period,
      window: `${budget.windowFrom} a ${budget.windowTo}`,
      amount: budget.amount,
      spent: budget.spent,
      remaining: budget.remaining,
      used: budget.usedPercent / 100,
      status: statusLabel[budget.status] ?? budget.status,
    });
  }

  styleHeader(sheet.getRow(1));
  autoFilterAndFreeze(sheet, 8);
  ['amount', 'spent', 'remaining'].forEach((key) => {
    sheet.getColumn(key).numFmt = MONEY_FORMAT;
  });
  sheet.getColumn('used').numFmt = '0.0%';

  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const status = row.getCell('status').value;
    if (status === 'Excedido') {
      row.getCell('status').font = { color: { argb: 'FFB91C1C' }, bold: true };
    } else if (status === 'Cerca del límite') {
      row.getCell('status').font = { color: { argb: 'FFB45309' }, bold: true };
    }
  });

  return workbook;
}

export async function buildCashFlowWorkbook(
  points: MonthlyPoint[],
  range: DateRange
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Flujo de caja');

  sheet.columns = [
    { header: 'Mes', key: 'month', width: 14 },
    { header: `Ingresos (${env.currency})`, key: 'income', width: 20 },
    { header: `Gastos (${env.currency})`, key: 'outcome', width: 20 },
    { header: `Ahorro (${env.currency})`, key: 'savings', width: 20 },
    { header: '% ahorro', key: 'rate', width: 12 },
    { header: `Balance acumulado (${env.currency})`, key: 'balance', width: 26 },
  ];

  for (const point of points) {
    sheet.addRow({
      month: point.month,
      income: point.income,
      outcome: point.outcome,
      savings: point.savings,
      rate: point.income ? point.savings / point.income : 0,
      balance: point.balance,
    });
  }

  styleHeader(sheet.getRow(1));
  autoFilterAndFreeze(sheet, 6);
  ['income', 'outcome', 'savings', 'balance'].forEach((key) => {
    sheet.getColumn(key).numFmt = MONEY_FORMAT;
  });
  sheet.getColumn('rate').numFmt = '0.0%';

  sheet.insertRow(1, []);
  sheet.getCell('A1').value = `Flujo de caja — ${rangeLabel(range)}`;
  sheet.getCell('A1').font = { bold: true, size: 13, color: { argb: BRAND } };

  return workbook;
}
