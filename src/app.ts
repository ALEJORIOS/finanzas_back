import express from 'express';
import cors from 'cors';
import { env } from './config/env.ts';
import {
  authenticate,
  errorHandler,
  notFound,
  rateLimit,
  requestId,
  requestLogger,
} from './middleware/index.ts';
import { accountsRouter } from './routes/accounts.ts';
import { analyticsRouter } from './routes/analytics.ts';
import { budgetsRouter } from './routes/budgets.ts';
import { categoriesRouter } from './routes/categories.ts';
import { legacyRouter } from './routes/legacy.ts';
import { recordsRouter } from './routes/records.ts';
import { reportsRouter } from './routes/reports.ts';
import { db } from './db/driver.ts';
import { schemaInfo } from './db/schema.ts';

export function createApp() {
  const app = express();

  // Vercel and most PaaS front the app with a proxy; without this `req.ip`
  // is the proxy's address and rate limiting buckets every user together.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(requestLogger);
  app.use(
    cors({
      origin: env.corsOrigins.length ? env.corsOrigins : true,
      exposedHeaders: ['Content-Disposition', 'X-Request-Id'],
    })
  );
  // A body limit stops a single oversized payload from exhausting memory.
  app.use(express.json({ limit: '1mb' }));
  app.use(rateLimit());

  app.get('/', (_req, res) => {
    res.send('Conectado exitosamente');
  });

  app.get('/health', async (_req, res) => {
    try {
      await db().query('SELECT 1');
      res.json({
        status: 'ok',
        driver: db().kind,
        valueColumn: schemaInfo().valueKind,
        authRequired: Boolean(env.apiKey),
        uptime: Math.round(process.uptime()),
      });
    } catch (error) {
      res.status(503).json({ status: 'degraded', message: 'Base de datos no disponible.' });
    }
  });

  app.use(authenticate);

  app.use('/api/v1/records', recordsRouter);
  app.use('/api/v1/categories', categoriesRouter);
  app.use('/api/v1/budgets', budgetsRouter);
  app.use('/api/v1/accounts', accountsRouter);
  app.use('/api/v1/analytics', analyticsRouter);
  app.use('/api/v1/reports', reportsRouter);

  // Original endpoints, kept so an already-installed PWA keeps working.
  app.use('/', legacyRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
