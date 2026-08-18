import { Router } from 'express';
import { AppError } from '../lib/errors.ts';
import { asyncHandler, parseOrThrow } from '../lib/http.ts';
import { createCategorySchema, deleteCategorySchema, updateCategorySchema } from '../lib/schemas.ts';
import { resolveRange, type PeriodPreset } from '../lib/period.ts';
import {
  categoryUsage,
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from '../repositories/categories.ts';

export const categoriesRouter = Router();

function idParam(raw: string | undefined): number {
  const id = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('Identificador inválido.');
  return id;
}

categoriesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const withUsage = req.query.withUsage !== 'false';
    const includeArchived = req.query.includeArchived === 'true';
    const range = resolveRange(
      (req.query.preset as PeriodPreset) ?? 'all',
      req.query.from as string,
      req.query.to as string
    );

    const categories = await listCategories({
      includeArchived,
      withUsage,
      filter: { from: range.from, to: range.to, preset: 'custom' },
    });
    res.json({ items: categories });
  })
);

categoriesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const category = await getCategory(idParam(req.params.id));
    res.json({ ...category, usage: await categoryUsage(category.name) });
  })
);

categoriesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(createCategorySchema, req.body, 'datos de la categoría');
    res.status(201).json(await createCategory(input));
  })
);

categoriesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(updateCategorySchema, req.body, 'datos de la categoría');
    res.json(await updateCategory(idParam(req.params.id), input));
  })
);

/**
 * Deletion refuses to strand records: if the category is in use the caller must
 * pass `reassignTo`, otherwise a 409 explains how many records are affected.
 */
categoriesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { reassignTo } = parseOrThrow(
      deleteCategorySchema,
      { reassignTo: req.query.reassignTo ?? req.body?.reassignTo ?? null },
      'datos'
    );
    await deleteCategory(idParam(req.params.id), reassignTo);
    res.status(204).end();
  })
);
