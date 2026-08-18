import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { AppError } from './errors.ts';

/**
 * Express 5 forwards rejected promises automatically, but wrapping keeps the
 * behaviour explicit and identical if the app is ever downgraded.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

function formatZodError(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

/** Validates and returns typed data, or throws a 422 with per-field messages. */
export function parseOrThrow<T>(schema: ZodType<T>, data: unknown, label = 'datos'): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw AppError.unprocessable(
      `Revisa los ${label}: hay campos inválidos.`,
      formatZodError(result.error)
    );
  }
  return result.data;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function paginated<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number
): Paginated<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1,
  };
}

/** Sets download headers consistently across every export endpoint. */
export function attachment(res: Response, fileName: string, contentType: string): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  // Lets the browser read the filename when the API is on another origin.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
}
