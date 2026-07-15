'use strict';

/**
 * Lightweight recursive input sanitizer — strips <script> tags and null bytes from
 * every string in req.body/query/params. Defence-in-depth alongside parameterised
 * SQL (which is what actually prevents injection — see db.js) and Joi validation
 * (which is what actually prevents malformed input — see validate.js).
 */
const SCRIPT_TAG = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;

function sanitizeValue(value) {
  if (typeof value === 'string') {
    return value.replace(SCRIPT_TAG, '').replace(/\0/g, '');
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeValue(v);
    return out;
  }
  return value;
}

function sanitize(req, res, next) {
  if (req.body) req.body = sanitizeValue(req.body);
  if (req.query) req.query = sanitizeValue(req.query);
  if (req.params) req.params = sanitizeValue(req.params);
  next();
}

module.exports = sanitize;
