'use strict';

const crypto = require('crypto');

/** Assigns a request id (for error/log correlation) and normalises client IP for audit logging. */
function requestContext(req, res, next) {
  req.id = crypto.randomUUID();
  req.clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = requestContext;
