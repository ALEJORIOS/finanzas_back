import PDFDocument from 'pdfkit';
import { env } from '../config/env.ts';
import { formatMoney, percentage, round2 } from '../lib/money.ts';
import type { DateRange } from '../lib/period.ts';
import type { CategorySlice, MonthlyPoint } from '../repositories/analytics.ts';
import type { BudgetProgress } from '../repositories/budgets.ts';
import type { MovementRecord } from '../repositories/records.ts';

const COLORS = {
  brand: '#4f46e5',
  ink: '#0f172a',
  muted: '#64748b',
  line: '#e2e8f0',
  zebra: '#f8fafc',
  income: '#15803d',
  expense: '#b91c1c',
  warning: '#b45309',
};

const PAGE_MARGIN = 42;

interface Column {
  label: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

/** Collects the document into a Buffer so it can be sent in one response. */
function render(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => chunks.push(chunk as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      build(doc);
      addPageNumbers(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function addPageNumbers(doc: PDFKit.PDFDocument): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    const bottom = doc.page.height - 28;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLORS.muted)
      .text(
        `Página ${i + 1} de ${range.count}`,
        PAGE_MARGIN,
        bottom,
        { width: doc.page.width - PAGE_MARGIN * 2, align: 'right' }
      );
  }
}

function money(value: number): string {
  return formatMoney(value, env.currency, env.locale);
}

function rangeLabel(range: DateRange): string {
  if (!range.from && !range.to) return 'Todo el histórico';
  return `${range.from ?? '…'}  —  ${range.to ?? '…'}`;
}

function header(doc: PDFKit.PDFDocument, title: string, range: DateRange): void {
  const width = doc.page.width - PAGE_MARGIN * 2;

  doc.rect(0, 0, doc.page.width, 96).fill(COLORS.brand);
  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor('#ffffff')
    .text(title, PAGE_MARGIN, 30, { width });
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#e0e7ff')
    .text(rangeLabel(range), PAGE_MARGIN, 58, { width });
  doc
    .fontSize(8)
    .text(
      `Generado el ${new Date().toLocaleDateString(env.locale)} · Moneda ${env.currency}`,
      PAGE_MARGIN,
      74,
      { width }
    );

  doc.y = 120;
  doc.fillColor(COLORS.ink);
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string): void {
  ensureSpace(doc, 40);
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.ink).text(text);
  doc.moveDown(0.35);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > doc.page.height - 56) {
    doc.addPage();
    doc.y = PAGE_MARGIN;
  }
}

/** KPI cards laid out in a responsive grid. */
function kpiGrid(doc: PDFKit.PDFDocument, items: Array<{ label: string; value: string; tone?: string }>): void {
  const width = doc.page.width - PAGE_MARGIN * 2;
  const perRow = 3;
  const gap = 10;
  const cardWidth = (width - gap * (perRow - 1)) / perRow;
  const cardHeight = 52;

  items.forEach((item, index) => {
    const column = index % perRow;
    if (column === 0) ensureSpace(doc, cardHeight + gap);
    const row = Math.floor(index / perRow);
    const x = PAGE_MARGIN + column * (cardWidth + gap);
    const y = doc.y + row * (cardHeight + gap);

    doc.roundedRect(x, y, cardWidth, cardHeight, 6).fillAndStroke(COLORS.zebra, COLORS.line);
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(COLORS.muted)
      .text(item.label.toUpperCase(), x + 10, y + 10, { width: cardWidth - 20 });
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(item.tone ?? COLORS.ink)
      .text(item.value, x + 10, y + 25, { width: cardWidth - 20, ellipsis: true });
  });

  const rows = Math.ceil(items.length / perRow);
  doc.y += rows * (cardHeight + gap);
  doc.fillColor(COLORS.ink);
}

function table(
  doc: PDFKit.PDFDocument,
  columns: Column[],
  rows: Array<Array<{ text: string; color?: string }>>
): void {
  const startX = PAGE_MARGIN;
  const rowHeight = 20;

  const drawHeader = () => {
    let x = startX;
    doc.rect(startX, doc.y, doc.page.width - PAGE_MARGIN * 2, rowHeight).fill(COLORS.brand);
    columns.forEach((column) => {
      doc
        .font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor('#ffffff')
        .text(column.label.toUpperCase(), x + 6, doc.y + 6, {
          width: column.width - 12,
          align: column.align ?? 'left',
          lineBreak: false,
        });
      x += column.width;
    });
    doc.y += rowHeight;
  };

  ensureSpace(doc, rowHeight * 3);
  drawHeader();

  rows.forEach((cells, rowIndex) => {
    if (doc.y + rowHeight > doc.page.height - 56) {
      doc.addPage();
      doc.y = PAGE_MARGIN;
      drawHeader();
    }

    if (rowIndex % 2 === 1) {
      doc.rect(startX, doc.y, doc.page.width - PAGE_MARGIN * 2, rowHeight).fill(COLORS.zebra);
    }

    let x = startX;
    cells.forEach((cell, columnIndex) => {
      const column = columns[columnIndex]!;
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(cell.color ?? COLORS.ink)
        .text(cell.text, x + 6, doc.y + 6, {
          width: column.width - 12,
          align: column.align ?? 'left',
          lineBreak: false,
          ellipsis: true,
        });
      x += column.width;
    });

    doc.y += rowHeight;
    doc
      .moveTo(startX, doc.y)
      .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
      .strokeColor(COLORS.line)
      .lineWidth(0.5)
      .stroke();
  });

  doc.fillColor(COLORS.ink);
}

/** Horizontal bar showing each category's share, drawn in its own colour. */
function categoryBars(doc: PDFKit.PDFDocument, slices: CategorySlice[], limit = 12): void {
  const width = doc.page.width - PAGE_MARGIN * 2;
  const labelWidth = 120;
  const valueWidth = 110;
  const barWidth = width - labelWidth - valueWidth - 16;
  const max = Math.max(...slices.map((s) => s.total), 1);

  slices.slice(0, limit).forEach((slice) => {
    ensureSpace(doc, 22);
    const y = doc.y;

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(COLORS.ink)
      .text(slice.category, PAGE_MARGIN, y + 3, { width: labelWidth - 8, ellipsis: true, lineBreak: false });

    const barX = PAGE_MARGIN + labelWidth;
    doc.roundedRect(barX, y + 4, barWidth, 10, 5).fill(COLORS.line);
    const filled = Math.max(2, (slice.total / max) * barWidth);
    doc.roundedRect(barX, y + 4, filled, 10, 5).fill(slice.color || COLORS.brand);

    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .fillColor(COLORS.ink)
      .text(`${money(slice.total)}  (${slice.percent}%)`, barX + barWidth + 8, y + 3, {
        width: valueWidth,
        align: 'right',
        lineBreak: false,
      });

    doc.y = y + 20;
  });

  doc.fillColor(COLORS.ink);
}

/* ------------------------------------------------------------------ */
/* Report builders                                                     */
/* ------------------------------------------------------------------ */

export function transactionsPdf(records: MovementRecord[], range: DateRange): Promise<Buffer> {
  const settled = records.filter((r) => !r.pending);
  const income = round2(
    settled.filter((r) => r.concept === 'Income').reduce((s, r) => s + r.value, 0)
  );
  const outcome = round2(
    settled.filter((r) => r.concept === 'Outcome').reduce((s, r) => s + r.value, 0)
  );

  return render((doc) => {
    header(doc, 'Reporte de movimientos', range);

    kpiGrid(doc, [
      { label: 'Ingresos', value: money(income), tone: COLORS.income },
      { label: 'Gastos', value: money(outcome), tone: COLORS.expense },
      { label: 'Balance', value: money(income - outcome), tone: income - outcome >= 0 ? COLORS.income : COLORS.expense },
      { label: 'Movimientos', value: String(records.length) },
      { label: 'Tasa de ahorro', value: `${percentage(income - outcome, income)}%` },
      { label: 'Gasto promedio', value: money(settled.length ? outcome / Math.max(1, settled.filter((r) => r.concept === 'Outcome').length) : 0) },
    ]);

    sectionTitle(doc, 'Detalle de movimientos');

    // Cap the detail table so a full-history export stays a usable document.
    const MAX_ROWS = 400;
    const shown = records.slice(0, MAX_ROWS);

    table(
      doc,
      [
        { label: 'Fecha', width: 62 },
        { label: 'Tipo', width: 52 },
        { label: 'Categoría', width: 96 },
        { label: 'Descripción', width: 175 },
        { label: 'Valor', width: 126, align: 'right' },
      ],
      shown.map((record) => [
        { text: record.date },
        {
          text: record.concept === 'Income' ? 'Ingreso' : 'Gasto',
          color: record.concept === 'Income' ? COLORS.income : COLORS.expense,
        },
        { text: record.category },
        { text: record.description || '—' },
        {
          text: `${record.concept === 'Income' ? '+' : '−'}${money(record.value)}${record.pending ? ' (pend.)' : ''}`,
          color: record.pending
            ? COLORS.warning
            : record.concept === 'Income'
              ? COLORS.income
              : COLORS.expense,
        },
      ])
    );

    if (records.length > MAX_ROWS) {
      doc.moveDown(0.5);
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(COLORS.muted)
        .text(
          `Se muestran los ${MAX_ROWS} movimientos más recientes de ${records.length}. Exporta a Excel o CSV para el detalle completo.`
        );
    }
  });
}

export function categoryPdf(
  slices: CategorySlice[],
  range: DateRange,
  title: string
): Promise<Buffer> {
  const total = round2(slices.reduce((sum, slice) => sum + slice.total, 0));

  return render((doc) => {
    header(doc, title, range);

    kpiGrid(doc, [
      { label: 'Total', value: money(total) },
      { label: 'Categorías', value: String(slices.length) },
      { label: 'Mayor categoría', value: slices[0]?.category ?? '—' },
    ]);

    sectionTitle(doc, 'Distribución');
    categoryBars(doc, slices);

    sectionTitle(doc, 'Detalle por categoría');
    table(
      doc,
      [
        { label: 'Categoría', width: 130 },
        { label: 'Total', width: 110, align: 'right' },
        { label: '%', width: 60, align: 'right' },
        { label: 'Movs.', width: 55, align: 'right' },
        { label: 'Período anterior', width: 156, align: 'right' },
      ],
      slices.map((slice) => {
        const delta = slice.previousTotal
          ? ((slice.total - slice.previousTotal) / slice.previousTotal) * 100
          : null;
        return [
          { text: slice.category },
          { text: money(slice.total) },
          { text: `${slice.percent}%` },
          { text: String(slice.count) },
          {
            text:
              delta === null
                ? money(slice.previousTotal)
                : `${money(slice.previousTotal)}  (${delta > 0 ? '+' : ''}${delta.toFixed(1)}%)`,
            color: delta === null ? COLORS.ink : delta > 0 ? COLORS.expense : COLORS.income,
          },
        ];
      })
    );
  });
}

export function budgetPdf(budgets: BudgetProgress[], range: DateRange): Promise<Buffer> {
  const total = round2(budgets.reduce((sum, b) => sum + b.amount, 0));
  const spent = round2(budgets.reduce((sum, b) => sum + b.spent, 0));

  return render((doc) => {
    header(doc, 'Presupuesto vs. gasto real', range);

    kpiGrid(doc, [
      { label: 'Presupuestado', value: money(total) },
      { label: 'Gastado', value: money(spent), tone: COLORS.expense },
      {
        label: 'Disponible',
        value: money(total - spent),
        tone: total - spent >= 0 ? COLORS.income : COLORS.expense,
      },
      { label: '% utilizado', value: `${percentage(spent, total)}%` },
      {
        label: 'Excedidos',
        value: String(budgets.filter((b) => b.status === 'exceeded').length),
        tone: COLORS.expense,
      },
      {
        label: 'Cerca del límite',
        value: String(budgets.filter((b) => b.status === 'warning').length),
        tone: COLORS.warning,
      },
    ]);

    sectionTitle(doc, 'Avance por presupuesto');

    const width = doc.page.width - PAGE_MARGIN * 2;
    for (const budget of budgets) {
      ensureSpace(doc, 46);
      const y = doc.y;
      const tone =
        budget.status === 'exceeded'
          ? COLORS.expense
          : budget.status === 'warning'
            ? COLORS.warning
            : COLORS.income;

      doc
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .fillColor(COLORS.ink)
        .text(budget.category ?? 'Global (todas las categorías)', PAGE_MARGIN, y, {
          width: width * 0.5,
          lineBreak: false,
        });
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(tone)
        .text(
          `${money(budget.spent)} de ${money(budget.amount)}  ·  ${budget.usedPercent}%`,
          PAGE_MARGIN + width * 0.5,
          y,
          { width: width * 0.5, align: 'right', lineBreak: false }
        );

      doc.roundedRect(PAGE_MARGIN, y + 15, width, 9, 4.5).fill(COLORS.line);
      const filled = Math.max(2, Math.min(1, budget.usedPercent / 100) * width);
      doc.roundedRect(PAGE_MARGIN, y + 15, filled, 9, 4.5).fill(tone);

      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(COLORS.muted)
        .text(
          `${budget.windowFrom} a ${budget.windowTo}  ·  quedan ${budget.daysRemaining} día(s)  ·  disponible ${money(Math.max(0, budget.remaining))}`,
          PAGE_MARGIN,
          y + 28,
          { width, lineBreak: false }
        );

      doc.y = y + 42;
    }

    doc.fillColor(COLORS.ink);
  });
}

export function cashFlowPdf(points: MonthlyPoint[], range: DateRange): Promise<Buffer> {
  const income = round2(points.reduce((sum, p) => sum + p.income, 0));
  const outcome = round2(points.reduce((sum, p) => sum + p.outcome, 0));

  return render((doc) => {
    header(doc, 'Flujo de caja', range);

    kpiGrid(doc, [
      { label: 'Ingresos totales', value: money(income), tone: COLORS.income },
      { label: 'Gastos totales', value: money(outcome), tone: COLORS.expense },
      {
        label: 'Ahorro neto',
        value: money(income - outcome),
        tone: income - outcome >= 0 ? COLORS.income : COLORS.expense,
      },
      { label: 'Meses analizados', value: String(points.length) },
      { label: 'Tasa de ahorro', value: `${percentage(income - outcome, income)}%` },
      {
        label: 'Mejor mes',
        value: points.length
          ? points.reduce((best, p) => (p.savings > best.savings ? p : best)).month
          : '—',
      },
    ]);

    sectionTitle(doc, 'Ingresos vs. gastos por mes');

    // Grouped bars, drawn directly — no chart dependency needed.
    const width = doc.page.width - PAGE_MARGIN * 2;
    const chartHeight = 150;
    ensureSpace(doc, chartHeight + 30);
    const baseY = doc.y + chartHeight;
    const max = Math.max(...points.map((p) => Math.max(p.income, p.outcome)), 1);
    const slot = width / Math.max(points.length, 1);
    const barWidth = Math.max(3, Math.min(14, slot / 2.6));

    doc.moveTo(PAGE_MARGIN, baseY).lineTo(PAGE_MARGIN + width, baseY).strokeColor(COLORS.line).lineWidth(1).stroke();

    points.forEach((point, index) => {
      const centre = PAGE_MARGIN + slot * index + slot / 2;
      const incomeHeight = (point.income / max) * chartHeight;
      const outcomeHeight = (point.outcome / max) * chartHeight;

      doc.rect(centre - barWidth - 1, baseY - incomeHeight, barWidth, incomeHeight).fill(COLORS.income);
      doc.rect(centre + 1, baseY - outcomeHeight, barWidth, outcomeHeight).fill(COLORS.expense);

      if (points.length <= 18) {
        doc
          .font('Helvetica')
          .fontSize(6.5)
          .fillColor(COLORS.muted)
          .text(point.month.slice(2), centre - slot / 2, baseY + 5, {
            width: slot,
            align: 'center',
            lineBreak: false,
          });
      }
    });

    doc.y = baseY + 20;

    sectionTitle(doc, 'Detalle mensual');
    table(
      doc,
      [
        { label: 'Mes', width: 70 },
        { label: 'Ingresos', width: 100, align: 'right' },
        { label: 'Gastos', width: 100, align: 'right' },
        { label: 'Ahorro', width: 100, align: 'right' },
        { label: 'Balance acum.', width: 141, align: 'right' },
      ],
      points.map((point) => [
        { text: point.month },
        { text: money(point.income), color: COLORS.income },
        { text: money(point.outcome), color: COLORS.expense },
        { text: money(point.savings), color: point.savings >= 0 ? COLORS.income : COLORS.expense },
        { text: money(point.balance) },
      ])
    );
  });
}
