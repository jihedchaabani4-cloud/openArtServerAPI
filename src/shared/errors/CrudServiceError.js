/**
 * CrudServiceError
 * Standard error raised by domain/system CRUD service layers.
 */
export class CrudServiceError extends Error {
  constructor(message, { statusCode = 500, errorCode = "CRUD_ERROR", ...fields } = {}) {
    super(message);
    this.name = "CrudServiceError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    Object.assign(this, fields);
    Error.captureStackTrace?.(this, this.constructor);
  }
}
