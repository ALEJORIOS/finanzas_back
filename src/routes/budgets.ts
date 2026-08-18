import { Router } from 'express';
import { AppError } from '../lib/errors.ts';
import { asyncHandler, parseOrThrow } from '../lib/http.ts';
import { createBudgetSchema, updateBudgetSchema } from '../lib/schemas.ts';
import {
  budgetProgress,
  createBudget,
  deleteBudget,
  getBudget,
  updateBudget,
} from '../repositories/budgets.ts';

export const budgetsRouter = Router();

function idParam(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? undefined : raw;
  const id = Number.parseInt(value ?? '', 10);

  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('Identificador inválido.');
  }

  return id;
}

/** Always returns budgets with their live progress attached. */
budgetsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    const items = await budgetProgress(new Date(), includeInactive);
    res.json({
      items,
      summary: {
        total: items.reduce((sum, b) => sum + b.amount, 0),
        spent: items.reduce((sum, b) => sum + b.spent, 0),
        exceeded: items.filter((b) => b.status === 'exceeded').length,
        warning: items.filter((b) => b.status === 'warning').length,
      },
    });
  })
);

budgetsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getBudget(idParam(req.params.id)));
  })
);

budgetsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(createBudgetSchema, req.body, 'datos del presupuesto');
    res.status(201).json(await createBudget(input));
  })
);

budgetsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(updateBudgetSchema, req.body, 'datos del presupuesto');
    res.json(await updateBudget(idParam(req.params.id), input));
  })
);

budgetsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await deleteBudget(idParam(req.params.id));
    res.status(204).end();
  })
);
