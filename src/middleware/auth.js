'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

/**
 * Verifies the Bearer JWT on every protected route and attaches `req.user`:
 *   { id, employeeId, role, branchCode }
 * Token is issued by POST /auth/login (see auth.routes.js) with the same shape.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(ApiError.unauthorized('Missing or malformed Authorization header. Expected: Bearer <token>'));
  }

  jwt.verify(token, env.jwt.secret, (err, payload) => {
    if (err) {
      const message = err.name === 'TokenExpiredError' ? 'Access token has expired' : 'Invalid access token';
      return next(ApiError.unauthorized(message));
    }
    req.user = payload; // { id, employeeId, role, branchCode, iat, exp }
    next();
  });
}

module.exports = { authenticate };
