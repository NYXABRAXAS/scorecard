'use strict';

const router = require('express').Router();
const { authenticate } = require('../../middleware/auth');
const controller = require('./masters.controller');

router.use(authenticate);

/**
 * @openapi
 * /masters/security-types:
 *   get:
 *     summary: Get Dropdown Masters — Security Types (incl. LTV cap, secured/unsecured flag)
 *     tags: [Masters]
 */
router.get('/security-types', controller.securityTypes);

/**
 * @openapi
 * /masters/credit-score-parameters:
 *   get:
 *     summary: Get Credit Score Card parameter + option matrix for a profile (SALARIED or BUSINESS), sourced from Credit Score.xlsx
 *     tags: [Masters]
 *     parameters:
 *       - in: query
 *         name: profileType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [SALARIED, BUSINESS]
 */
router.get('/credit-score-parameters', controller.creditScoreParameters);

/**
 * @openapi
 * /masters/document-types:
 *   get:
 *     summary: Get Dropdown Masters — Supporting Document Types
 *     tags: [Masters]
 */
router.get('/document-types', controller.documentTypes);

/**
 * @openapi
 * /masters/roles:
 *   get:
 *     summary: Get Dropdown Masters — Roles
 *     tags: [Masters]
 */
router.get('/roles', controller.roles);

module.exports = router;
