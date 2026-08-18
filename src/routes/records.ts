import { Router } from 'express';
import { AppError } from '../lib/errors.ts';
import { asyncHandler, paginated, parseOrThrow } from '../lib/http.ts';
import {
  bulkDeleteSchema,
  createRecordSchema,
  recordQuerySchema,
  updateRecordSchema,
} from '../lib/schemas.ts';
import {
  createRecord,
  deleteRecord,
  deleteRecords,
  findDuplicates,
  getRecord,
  listRecords,
  updateRecord,
} from '../repositories/records.ts';

export const recordsRouter = Router();

function idParam(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? undefined : raw;
  const id = Number.parseInt(value ?? '', 10);

  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('Identificador inválido.');
  }

  return id;
}

recordsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(recordQuerySchema, req.query, 'filtros');
    const result = await listRecords(query);
    res.json({
      ...paginated(result.items, result.total, result.page, result.pageSize),
      totals: result.totals,
    });
  })
);

/**
 * Duplicate pre-check. The original app answered this by downloading every
 * record into the browser and filtering client-side.
 */
recordsRouter.get(
  '/duplicates',
  asyncHandler(async (req, res) => {
    const { date, category, value, excludeId } = req.query;
    if (!date || !category || value === undefined) {
      throw AppError.badRequest('Se requieren date, category y value.');
    }
    const matches = await findDuplicates(
      String(date),
      String(category),
      Number(value),
      excludeId ? Number(excludeId) : undefined
    );
    res.json({ duplicates: matches, hasDuplicates: matches.length > 0 });
  })
);

recordsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getRecord(idParam(req.params.id)));
  })
);

recordsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(createRecordSchema, req.body, 'datos del movimiento');
    const created = await createRecord(input);
    res.status(201).json(created);
  })
);

recordsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const input = parseOrThrow(updateRecordSchema, req.body, 'datos del movimiento');
    res.json(await updateRecord(id, input));
  })
);

// Accepting PUT as well keeps naive clients working.
recordsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const input = parseOrThrow(updateRecordSchema, req.body, 'datos del movimiento');
    res.json(await updateRecord(id, input));
  })
);

recordsRouter.post(
  '/bulk-delete',
  asyncHandler(async (req, res) => {
    const { ids } = parseOrThrow(bulkDeleteSchema, req.body, 'identificadores');
    const deleted = await deleteRecords(ids);
    res.json({ deleted });
  })
);

recordsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await deleteRecord(idParam(req.params.id));
    res.status(204).end();
  })
);
