/**
 * Minimal RFC 4180 CSV writer.
 *
 * The BOM matters: without it Excel opens UTF-8 CSVs in the system codepage and
 * mangles every accented category name ("Categoría" → "CategorÃ­a").
 */

// Built from its code point rather than written as a literal, so it survives
// any re-encoding of this source file.
const BOM = String.fromCharCode(0xfeff);

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // A leading =, +, - or @ is interpreted as a formula by spreadsheet apps.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(
  headers: string[],
  rows: Array<Array<unknown>>,
  { includeBom = true } = {}
): string {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(','));
  }
  return (includeBom ? BOM : '') + lines.join('\r\n');
}
