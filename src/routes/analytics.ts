import { Router } from 'express';
import { asyncHandler, parseOrThrow } from '../lib/http.ts';
import { analyticsQuerySchema } from '../lib/schemas.ts';
import { resolveRange, type PeriodPreset } from '../lib/period.ts';
import {
  cashFlow,
  categoryBreakdown,
  dailySeries,
  monthlySeries,
  overview,
} from '../repositories/analytics.ts';

export const analyticsRouter = Router();

/**
 * One request powers the whole dashboard. Splitting this into eight endpoints
 * would mean eight round trips and eight sequential database connections on a
 * cold serverless start.
 */
analyticsRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(analyticsQuerySchema, req.query, 'parámetros');
    res.json(await overview(query.preset, query.from, query.to));
  })
);

analyticsRouter.get(
  '/monthly',
  asyncHandler(async (req, res) => {
    const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 12));
    res.json({ items: await monthlySeries(limit) });
  })
);

analyticsRouter.get(
  '/daily',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(analyticsQuerySchema, req.query, 'parámetros');
    const range = resolveRange((query.preset as PeriodPreset) ?? 'this-month', query.from, query.to);
    res.json({ range, items: await dailySeries(range) });
  })
);

analyticsRouter.get(
  '/by-category',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(analyticsQuerySchema, req.query, 'parámetros');
    const range = resolveRange((query.preset as PeriodPreset) ?? 'this-month', query.from, query.to);
    const concept = String(req.query.concept ?? 'Outcome') === 'Income' ? 'Income' : 'Outcome';
    res.json({ range, concept, items: await categoryBreakdown(range, concept) });
  })
);

analyticsRouter.get(
  '/cash-flow',
  asyncHandler(async (req, res) => {
    const query = parseOrThrow(analyticsQuerySchema, req.query, 'parámetros');
    const range = resolveRange(
      (query.preset as PeriodPreset) ?? 'last-12-months',
      query.from,
      query.to
    );
    res.json({ range, items: await cashFlow(range) });
  })
);
