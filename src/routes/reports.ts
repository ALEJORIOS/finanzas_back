import { Router } from 'express';
import type { Response } from 'express';
import { env } from '../config/env.ts';
import { AppError } from '../lib/errors.ts';
import { asyncHandler, attachment, parseOrThrow } from '../lib/http.ts';
import { resolveRange, type DateRange, type PeriodPreset } from '../lib/period.ts';
import { reportQuerySchema, type ReportQuery } from '../lib/schemas.ts';
import { cashFlow, categoryBreakdown, type CategorySlice } from '../repositories/analytics.ts';
import { budgetProgress } from '../repositories/budgets.ts';
import { listAllForExport } from '../repositories/records.ts';
import { toCsv } from '../services/csv.ts';
import {
  buildBudgetWorkbook,
  buildCashFlowWorkbook,
  buildCategoryWorkbook,
  buildTransactionsWorkbook,
} from '../services/excel.ts';
import { budgetPdf, cashFlowPdf, categoryPdf, transactionsPdf } from '../services/pdf.ts';

export const reportsRouter = Router();

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const REPORT_LABELS: Record<ReportQuery['type'], string> = {
  transactions: 'Movimientos',
  'expenses-by-category': 'Gastos por categoría',
  'income-by-category': 'Ingresos por categoría',
  'budget-vs-actual': 'Presupuesto vs. gasto real',
  'cash-flow': 'Flujo de caja',
  'monthly-summary': 'Resumen mensual',
};

function fileName(type: string, format: string, range: DateRange): string {
  const suffix = range.from && range.to ? `${range.from}_${range.to}` : 'historico';
  return `${type}-${suffix}.${format}`;
}

async function sendWorkbook(res: Response, workbook: any, name: string): Promise<void> {
  const content = await workbook.xlsx.writeBuffer();
  attachment(res, name, XLSX_MIME);
  res.status(200).send(Buffer.from(content));
}

function sendPdf(res: Response, buffer: Buffer, name: string): void {
  attachment(res, name, 'application/pdf');
  res.status(200).send(buffer);
}

function sendCsv(res: Response, csv: string, name: string): void {
  attachment(res, name, 'text/csv; charset=utf-8');
  res.status(200).send(csv);
}

function categoryCsv(slices: CategorySlice[]): string {
  return toCsv(
    ['Categoría', `Total (${env.currency})`, '% del total', 'Movimientos', 'Período anterior'],
    slices.map((s) => [s.category, s.total, s.percent, s.count, s.previousTotal])
  );
}

/** Lists the available reports so the UI never hard-codes them. */
reportsRouter.get('/', (_req, res) => {
  res.json({
    items: Object.entries(REPORT_LABELS).map(([id, label]) => ({
      id,
      label,
      formats: ['pdf', 'xlsx', 'csv', 'json'],
    })),
  });
});

reportsRouter.get(
  '/export',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(reportQuerySchema, req.query, 'parámetros del reporte');
    const range = resolveRange(
      (query.preset as PeriodPreset) ?? (query.type === 'cash-flow' ? 'last-12-months' : 'this-month'),
      query.from,
      query.to
    );

    switch (query.type) {
      case 'transactions': {
        const records = await listAllForExport({
          from: range.from,
          to: range.to,
          preset: 'custom',
          category: query.category,
          concept: query.concept,
          search: query.search,
        });

        if (query.format === 'json') return void res.json({ range, items: records });
        if (query.format === 'csv') {
          return sendCsv(
            res,
            toCsv(
              ['Fecha', 'Tipo', 'Categoría', 'Descripción', 'Cuenta', 'Estado', `Valor (${env.currency})`],
              records.map((r) => [
                r.date,
                r.concept === 'Income' ? 'Ingreso' : 'Gasto',
                r.category,
                r.description,
                r.accountName ?? '',
                r.pending ? 'Pendiente' : 'Registrado',
                r.concept === 'Income' ? r.value : -r.value,
              ])
            ),
            fileName('movimientos', 'csv', range)
          );
        }
        if (query.format === 'pdf') {
          return sendPdf(res, await transactionsPdf(records, range), fileName('movimientos', 'pdf', range));
        }
        return sendWorkbook(
          res,
          await buildTransactionsWorkbook(records, range),
          fileName('movimientos', 'xlsx', range)
        );
      }

      case 'expenses-by-category':
      case 'income-by-category': {
        const concept = query.type === 'income-by-category' ? 'Income' : 'Outcome';
        const label = REPORT_LABELS[query.type];
        const slices = await categoryBreakdown(range, concept);
        const base = query.type === 'income-by-category' ? 'ingresos-por-categoria' : 'gastos-por-categoria';

        if (query.format === 'json') return void res.json({ range, items: slices });
        if (query.format === 'csv') {
          return sendCsv(res, categoryCsv(slices), fileName(base, 'csv', range));
        }
        if (query.format === 'pdf') {
          return sendPdf(res, await categoryPdf(slices, range, label), fileName(base, 'pdf', range));
        }
        return sendWorkbook(
          res,
          await buildCategoryWorkbook(slices, range, label),
          fileName(base, 'xlsx', range)
        );
      }

      case 'budget-vs-actual': {
        const budgets = await budgetProgress();
        if (!budgets.length) {
          throw AppError.badRequest(
            'Aún no has creado presupuestos. Crea uno para generar este reporte.'
          );
        }

        if (query.format === 'json') return void res.json({ range, items: budgets });
        if (query.format === 'csv') {
          return sendCsv(
            res,
            toCsv(
              ['Categoría', 'Período', 'Desde', 'Hasta', 'Presupuesto', 'Gastado', 'Disponible', '% usado', 'Estado'],
              budgets.map((b) => [
                b.category ?? 'Global',
                b.period,
                b.windowFrom,
                b.windowTo,
                b.amount,
                b.spent,
                b.remaining,
                b.usedPercent,
                b.status,
              ])
            ),
            fileName('presupuesto-vs-real', 'csv', range)
          );
        }
        if (query.format === 'pdf') {
          return sendPdf(res, await budgetPdf(budgets, range), fileName('presupuesto-vs-real', 'pdf', range));
        }
        return sendWorkbook(
          res,
          await buildBudgetWorkbook(budgets),
          fileName('presupuesto-vs-real', 'xlsx', range)
        );
      }

      case 'cash-flow':
      case 'monthly-summary': {
        const points = await cashFlow(range);
        const base = query.type === 'cash-flow' ? 'flujo-de-caja' : 'resumen-mensual';

        if (query.format === 'json') return void res.json({ range, items: points });
        if (query.format === 'csv') {
          return sendCsv(
            res,
            toCsv(
              ['Mes', 'Ingresos', 'Gastos', 'Ahorro', 'Balance acumulado'],
              points.map((p) => [p.month, p.income, p.outcome, p.savings, p.balance])
            ),
            fileName(base, 'csv', range)
          );
        }
        if (query.format === 'pdf') {
          return sendPdf(res, await cashFlowPdf(points, range), fileName(base, 'pdf', range));
        }
        return sendWorkbook(res, await buildCashFlowWorkbook(points, range), fileName(base, 'xlsx', range));
      }

      default:
        throw AppError.badRequest('Tipo de reporte no reconocido.');
    }
  })
);
