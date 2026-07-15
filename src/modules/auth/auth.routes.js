'use strict';

const router = require('express').Router();
const validate = require('../../middleware/validate');
const { loginSchema, refreshSchema } = require('./auth.validation');
const controller = require('./auth.controller');

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Authenticate and obtain a JWT access + refresh token pair
 *     tags: [Auth]
 */
router.post('/login', validate(loginSchema), controller.login);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     summary: Exchange a valid refresh token for a new access token
 *     tags: [Auth]
 */
router.post('/refresh', validate(refreshSchema), controller.refresh);

module.exports = router;
