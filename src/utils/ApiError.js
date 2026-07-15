'use strict';

/**
 * Standardised application error. Every thrown error a route handler cares about
 * should be one of these, so errorHandler.js can produce a consistent envelope
 * (see DOCUMENTATION.md Section 9 — Error Handling).
 */
class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code; // machine-readable, e.g. 'VALIDATION_ERROR'
    this.details = details || null;
  }

  static badRequest(code, message, details) {
    return new ApiError(400, code || 'BAD_REQUEST', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Resource not found') {
    return new ApiError(404, 'NOT_FOUND', message);
  }
  static conflict(code, message, details) {
    return new ApiError(409, code || 'CONFLICT', message, details);
  }
  static validation(details) {
    return new ApiError(422, 'VALIDATION_ERROR', 'One or more fields failed validation', details);
  }
  static businessRule(code, message, details) {
    return new ApiError(422, code, message, details);
  }
  static internal(message = 'An unexpected error occurred') {
    return new ApiError(500, 'INTERNAL_SERVER_ERROR', message);
  }
}

module.exports = ApiError;
