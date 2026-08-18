import { z } from 'zod';
import { DATE_RE, isValidDate } from './period.ts';

const isoDate = z
  .string()
  .trim()
  .regex(DATE_RE, 'Usa el formato AAAA-MM-DD.')
  .refine(isValidDate, 'La fecha no existe en el calendario.');

const optionalIsoDate = isoDate.nullish();

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Usa un color hexadecimal como #22c55e.');

/** Accepts `"1.234,56"`, `"$1234"` or `1234` and normalises to a positive number. */
const money = z
  .union([z.number(), z.string()])
  .transform((raw) => {
    if (typeof raw === 'number') return raw;
    const cleaned = raw.replace(/[^0-9.,-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    return Number.parseFloat(cleaned);
  })
  .refine((value) => Number.isFinite(value), 'Ingresa un monto numérico válido.')
  .refine((value) => value > 0, 'El monto debe ser mayor que cero.')
  .refine((value) => value < 1e15, 'El monto es demasiado grande.')
  .transform((value) => Math.round(value * 100) / 100);

export const conceptSchema = z
  .string()
  .trim()
  .transform((value) => (value.toUpperCase() === 'INCOME' ? 'Income' : 'Outcome'));

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

export const createRecordSchema = z.object({
  date: isoDate,
  concept: conceptSchema,
  category: z.string().trim().min(1, 'Elige una categoría.').max(80),
  description: z.string().trim().max(500, 'Máximo 500 caracteres.').default(''),
  value: money,
  accountId: z.coerce.number().int().positive().nullish(),
  /** Planned/unpaid movement: kept out of realised totals until settled. */
  pending: z.coerce.boolean().default(false),
});

/** Every field optional, but at least one must be present. */
export const updateRecordSchema = z
  .object({
    date: isoDate.optional(),
    concept: conceptSchema.optional(),
    category: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    value: money.optional(),
    accountId: z.coerce.number().int().positive().nullish(),
    pending: z.coerce.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'Envía al menos un campo para actualizar.');

export const recordQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  from: optionalIsoDate,
  to: optionalIsoDate,
  preset: z.string().trim().optional(),
  category: z.union([z.string(), z.array(z.string())]).optional(),
  concept: z.enum(['Income', 'Outcome', 'all']).catch('all').optional(),
  accountId: z.coerce.number().int().positive().optional(),
  minValue: z.coerce.number().optional(),
  maxValue: z.coerce.number().optional(),
  status: z.enum(['all', 'settled', 'pending']).catch('all').optional(),
  sort: z.enum(['date', 'value', 'category', 'concept', 'create_time']).catch('date').optional(),
  dir: z.enum(['asc', 'desc']).catch('desc').optional(),
  page: z.coerce.number().int().min(1).catch(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).catch(50).optional(),
});

export const bulkDeleteSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1, 'Selecciona al menos un registro.').max(500),
});

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio.').max(80),
  kind: z.enum(['income', 'outcome', 'both']).default('outcome'),
  color: hexColor.default('#6366f1'),
  icon: z.string().trim().max(40).default('dots'),
  sortOrder: z.coerce.number().int().default(0),
});

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    kind: z.enum(['income', 'outcome', 'both']).optional(),
    color: hexColor.optional(),
    icon: z.string().trim().max(40).optional(),
    archived: z.coerce.boolean().optional(),
    sortOrder: z.coerce.number().int().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'Envía al menos un campo para actualizar.');

/** Used when deleting a category that still has records attached. */
export const deleteCategorySchema = z.object({
  reassignTo: z.string().trim().min(1).max(80).nullish(),
});

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export const createAccountSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es obligatorio.').max(80),
  kind: z.enum(['cash', 'bank', 'card', 'wallet', 'other']).default('cash'),
  color: hexColor.default('#6366f1'),
  icon: z.string().trim().max(40).default('wallet'),
  openingBalance: z.coerce.number().default(0),
});

export const updateAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    kind: z.enum(['cash', 'bank', 'card', 'wallet', 'other']).optional(),
    color: hexColor.optional(),
    icon: z.string().trim().max(40).optional(),
    openingBalance: z.coerce.number().optional(),
    archived: z.coerce.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'Envía al menos un campo para actualizar.');

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

export const createBudgetSchema = z.object({
  category: z.string().trim().min(1).max(80).nullish(),
  amount: money,
  period: z.enum(['monthly', 'weekly', 'yearly', 'custom']).default('monthly'),
  startDate: isoDate,
  endDate: optionalIsoDate,
  alertThreshold: z.coerce.number().int().min(1).max(100).default(80),
  note: z.string().trim().max(300).default(''),
});

export const updateBudgetSchema = z
  .object({
    category: z.string().trim().min(1).max(80).nullish(),
    amount: money.optional(),
    period: z.enum(['monthly', 'weekly', 'yearly', 'custom']).optional(),
    startDate: isoDate.optional(),
    endDate: optionalIsoDate,
    alertThreshold: z.coerce.number().int().min(1).max(100).optional(),
    active: z.coerce.boolean().optional(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'Envía al menos un campo para actualizar.');

/* ------------------------------------------------------------------ */
/* Analytics / reports                                                 */
/* ------------------------------------------------------------------ */

export const analyticsQuerySchema = z.object({
  preset: z.string().trim().optional(),
  from: optionalIsoDate,
  to: optionalIsoDate,
});

export const reportQuerySchema = analyticsQuerySchema.extend({
  type: z
    .enum([
      'transactions',
      'expenses-by-category',
      'income-by-category',
      'budget-vs-actual',
      'cash-flow',
      'monthly-summary',
    ])
    .default('transactions'),
  format: z.enum(['csv', 'xlsx', 'pdf', 'json']).default('xlsx'),
  category: z.union([z.string(), z.array(z.string())]).optional(),
  concept: z.enum(['Income', 'Outcome', 'all']).catch('all').optional(),
  search: z.string().trim().max(120).optional(),
});

export type CreateRecordInput = z.infer<typeof createRecordSchema>;
export type UpdateRecordInput = z.infer<typeof updateRecordSchema>;
export type RecordQuery = z.infer<typeof recordQuerySchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;
export type ReportQuery = z.infer<typeof reportQuerySchema>;
