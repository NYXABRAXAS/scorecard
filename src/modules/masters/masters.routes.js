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
 * /masters/score-bands:
 *   get:
 *     summary: Get Dropdown Masters — CAM Risk Score Bands
 *     tags: [Masters]
 */
router.get('/score-bands', controller.scoreBands);

/**
 * @openapi
 * /masters/employment-types:
 *   get:
 *     summary: Get Dropdown Masters — Employment Types
 *     tags: [Masters]
 */
router.get('/employment-types', controller.employmentTypes);

/**
 * @openapi
 * /masters/entity-types:
 *   get:
 *     summary: Get Dropdown Masters — Business Entity Types
 *     tags: [Masters]
 */
router.get('/entity-types', controller.entityTypes);

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
