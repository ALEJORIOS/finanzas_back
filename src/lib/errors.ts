/**
 * Errors that are safe to show to a client. Anything that is not an AppError is
 * treated as an internal fault: it gets logged in full but the response body
 * only carries a generic message and a correlation id.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'bad_request', message, details);
  }

  static unauthorized(message = 'Credenciales inválidas o ausentes.') {
    return new AppError(401, 'unauthorized', message);
  }

  static forbidden(message = 'No tienes permisos para esta operación.') {
    return new AppError(403, 'forbidden', message);
  }

  static notFound(message = 'El recurso solicitado no existe.') {
    return new AppError(404, 'not_found', message);
  }

  static conflict(message: string, details?: unknown) {
    return new AppError(409, 'conflict', message, details);
  }

  static unprocessable(message: string, details?: unknown) {
    return new AppError(422, 'unprocessable_entity', message, details);
  }

  static tooManyRequests(message = 'Demasiadas solicitudes. Intenta de nuevo en un momento.') {
    return new AppError(429, 'rate_limited', message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
