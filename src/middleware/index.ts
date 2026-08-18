import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.ts';
import { AppError, isAppError } from '../lib/errors.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/** Tags every request so a client-facing error id can be traced in the logs. */
export const requestId: RequestHandler = (req, res, next) => {
  const id = (req.headers['x-request-id'] as string) || randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};

export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startedAt;
    // Skip noise from health checks and preflight.
    if (req.method === 'OPTIONS') return;
    const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`;
    if (res.statusCode >= 500) console.error(`[http] ${line}`);
    else if (res.statusCode >= 400) console.warn(`[http] ${line}`);
    else if (!env.isProduction) console.log(`[http] ${line}`);
  });
  next();
};

/**
 * Optional shared-secret auth. With no API_KEY configured the API behaves
 * exactly as it always has, so enabling this is a deliberate choice and can
 * never lock out an existing deployment by surprise.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  if (!env.apiKey) return next();

  const isRead = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (isRead && !env.protectReads) return next();

  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const provided = bearer || (req.headers['x-api-key'] as string) || '';

  if (!provided || !timingSafeEqual(provided, env.apiKey)) {
    return next(AppError.unauthorized());
  }
  next();
};

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Small in-process rate limiter. Enough to blunt accidental request storms from
 * a runaway client; it is not a substitute for an edge limiter.
 */
export function rateLimit(): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Bounded cleanup so the map cannot grow without limit.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, env.rateLimitWindowMs).unref?.();

  return (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + env.rateLimitWindowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > env.rateLimitMax) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return next(AppError.tooManyRequests());
    }
    next();
  };
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`No existe la ruta ${req.method} ${req.path}.`));
};

/**
 * Central error handler. Clients get a stable, human-readable shape; internal
 * faults are logged in full but never serialised into the response.
 *
 * The previous implementation did `res.status(500).json(e)`, which leaked
 * database internals (and often serialised to `{}`, telling the user nothing).
 */
export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (isAppError(error)) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  const id = req.requestId ?? 'unknown';
  const pgCode = (error as { code?: string })?.code;
  console.error(`[error] request=${id}`, error);

  // Translate the handful of Postgres codes that are genuinely the caller's fault.
  if (pgCode === '23505') {
    res.status(409).json({
      error: { code: 'conflict', message: 'Ya existe un registro con esos datos.', requestId: id },
    });
    return;
  }
  if (pgCode === '23503') {
    res.status(409).json({
      error: {
        code: 'conflict',
        message: 'No se puede completar: hay datos relacionados.',
        requestId: id,
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Ocurrió un error inesperado. Intenta de nuevo.',
      requestId: id,
    },
  });
};
