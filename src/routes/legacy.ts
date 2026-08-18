import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/driver.ts';
import { asyncHandler, attachment, parseOrThrow } from '../lib/http.ts';
import { schemaInfo, writeValueSql } from '../db/schema.ts';
import { buildTransactionsWorkbook } from '../services/excel.ts';
import { listAllForExport } from '../repositories/records.ts';

/**
 * The original three endpoints, preserved verbatim.
 *
 * A PWA installed on someone's phone keeps running the old bundle until it
 * updates, so these must keep answering in exactly the shape the old client
 * expects — including `value` as a pre-formatted `money` string.
 */
export const legacyRouter = Router();

legacyRouter.get(
  '/record',
  asyncHandler(async (_req, res) => {
    // Same projection and ordering as before, plus `id` (additive: the old
    // client ignores unknown fields, and the new one needs it to edit).
    const { rows } = await db().query(
      `SELECT id, date, concept, category, description, value, create_time
         FROM "record"
        ORDER BY date DESC`
    );
    res.status(200).json(rows);
  })
);

/**
 * Deliberately lenient: it accepts anything the old client could already send
 * (including a zero amount) so an un-updated PWA never starts failing. The
 * v1 API applies the stricter rules.
 */
const legacyInsertSchema = z.object({
  date: z.string().trim().min(1),
  concept: z.string().trim().min(1),
  category: z.string().trim().min(1),
  description: z.string().trim().max(500).nullish(),
  value: z.coerce.number().finite(),
});

legacyRouter.post(
  '/insert',
  asyncHandler(async (req, res) => {
    const input = parseOrThrow(legacyInsertSchema, req.body, 'datos del movimiento');
    const info = schemaInfo();

    const columns = ['date', 'concept', 'category', 'description', 'value', 'create_time'];
    const values = ['$1::date', '$2', '$3', '$4', writeValueSql('$5'), 'NOW()'];
    const params: unknown[] = [
      input.date,
      input.concept,
      input.category,
      input.description ?? '',
      input.value,
    ];

    if (info.hasPending) {
      columns.push('pending');
      values.push('FALSE');
    }

    const { rows } = await db().query(
      `INSERT INTO "record" (${columns.join(', ')}) VALUES (${values.join(', ')}) RETURNING id`,
      params
    );
    res.status(200).json({ id: rows[0].id });
  })
);

legacyRouter.get(
  '/download',
  asyncHandler(async (_req, res) => {
    const records = await listAllForExport({ preset: 'all' });
    const workbook = await buildTransactionsWorkbook(records, {
      from: null,
      to: null,
      preset: 'all',
    });
    const content = await workbook.xlsx.writeBuffer();
    const fileName = `records-${new Date().toISOString().slice(0, 10)}.xlsx`;

    attachment(
      res,
      fileName,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.status(200).send(Buffer.from(content));
  })
);
