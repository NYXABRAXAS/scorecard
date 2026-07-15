'use strict';

const ApiError = require('../utils/ApiError');

/** 404 fallback for any route not matched. */
function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`No route matches ${req.method} ${req.originalUrl}`));
}

/**
 * Central error handler — every route funnels here (either by calling next(err)
 * or throwing inside an async handler wrapped by asyncHandler). Always returns
 * the standard envelope documented in DOCUMENTATION.md Section 9.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    const body = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details || undefined,
        requestId: req.id
      }
    };
    if (err.statusCode >= 500) {
      // eslint-disable-next-line no-console
      console.error(`[${req.id}]`, err);
    }
    return res.status(err.statusCode).json(body);
  }

  // Postgres unique-violation -> surface as 409 rather than a raw 500.
  if (err && err.code === '23505') {
    return res.status(409).json({
      success: false,
      error: { code: 'DUPLICATE_RECORD', message: 'A record with this key already exists.', requestId: req.id }
    });
  }
  if (err && err.code === '23503') {
    return res.status(409).json({
      success: false,
      error: { code: 'FOREIGN_KEY_VIOLATION', message: 'This action references a record that does not exist.', requestId: req.id }
    });
  }

  // eslint-disable-next-line no-console
  console.error(`[${req.id}] Unhandled error:`, err);
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred.', requestId: req.id }
  });
}

/** Wraps an async route handler so rejected promises reach errorHandler instead of crashing the process. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { notFoundHandler, errorHandler, asyncHandler };
