import { Router } from 'express';
import { AppError } from '../lib/errors.ts';
import { asyncHandler, parseOrThrow } from '../lib/http.ts';
import { createAccountSchema, updateAccountSchema } from '../lib/schemas.ts';
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  updateAccount,
} from '../repositories/accounts.ts';

export const accountsRouter = Router();

function idParam(raw: string | undefined): number {
  const id = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('Identificador inválido.');
  return id;
}

accountsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await listAccounts(req.query.includeArchived === 'true');
    res.json({
      items,
      totalBalance: items.reduce((sum, account) => sum + (account.balance ?? 0), 0),
    });
  })
);

accountsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getAccount(idParam(req.params.id)));
  })
);

accountsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(createAccountSchema, req.body, 'datos de la cuenta');
    res.status(201).json(await createAccount(input));
  })
);

accountsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(updateAccountSchema, req.body, 'datos de la cuenta');
    res.json(await updateAccount(idParam(req.params.id), input));
  })
);

/** Records survive: they simply lose their account association. */
accountsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await deleteAccount(idParam(req.params.id));
    res.status(204).end();
  })
);
