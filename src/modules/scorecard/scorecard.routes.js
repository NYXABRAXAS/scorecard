'use strict';

const router = require('express').Router();
const { authenticate } = require('../../middleware/auth');
const { requirePermission, requireOwnershipOrViewAll } = require('../../middleware/rbac');
const validate = require('../../middleware/validate');
const controller = require('./scorecard.controller');
const repository = require('./scorecard.repository');
const {
  createScoreCardSchema, updateScoreCardSchema, rejectSchema, approveSchema,
  documentUploadSchema, idParamSchema, applicationIdParamSchema, listQuerySchema
} = require('./scorecard.validation');

router.use(authenticate);

async function ownerOfCardId(req) {
  const card = await repository.findById(req.params.id, { includeDeleted: true });
  return card ? card.audit.createdBy : undefined; // undefined -> not found, let 404 surface downstream
}
async function ownerOfApplication(req) {
  const card = await repository.findByApplicationId(req.params.applicationId);
  return card ? card.audit.createdBy : undefined;
}
const readAccess = requireOwnershipOrViewAll(ownerOfCardId);
const readAccessByApplication = requireOwnershipOrViewAll(ownerOfApplication);
const writeAccess = requireOwnershipOrViewAll(ownerOfCardId);

/**
 * @openapi
 * /score-cards:
 *   post:
 *     summary: Create Score Card
 *     tags: [ScoreCard]
 *   get:
 *     summary: List score cards (paginated, filterable, sortable)
 *     tags: [ScoreCard]
 */
router.post('/', requirePermission('caseCreate'), validate(createScoreCardSchema), controller.create);
router.get('/', validate(listQuerySchema, 'query'), controller.list);

/**
 * @openapi
 * /score-cards/application/{applicationId}:
 *   get:
 *     summary: Get Score Card by Application ID
 *     tags: [ScoreCard]
 */
router.get(
  '/application/:applicationId',
  validate(applicationIdParamSchema, 'params'),
  readAccessByApplication,
  controller.getByApplicationId
);

/**
 * @openapi
 * /score-cards/{id}:
 *   get:
 *     summary: Get Score Card
 *     tags: [ScoreCard]
 *   put:
 *     summary: Update Score Card
 *     tags: [ScoreCard]
 *   delete:
 *     summary: Delete Score Card (soft delete, DRAFT only)
 *     tags: [ScoreCard]
 */
router.get('/:id', validate(idParamSchema, 'params'), readAccess, controller.getById);
router.put(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateScoreCardSchema),
  writeAccess,
  controller.update
);
router.delete('/:id', validate(idParamSchema, 'params'), requirePermission('caseEdit'), writeAccess, controller.remove);

/**
 * @openapi
 * /score-cards/{id}/draft:
 *   patch:
 *     summary: Save Draft
 *     tags: [ScoreCard]
 */
router.patch(
  '/:id/draft',
  validate(idParamSchema, 'params'),
  validate(updateScoreCardSchema),
  requirePermission('caseEdit'),
  writeAccess,
  controller.saveDraft
);

/**
 * @openapi
 * /score-cards/{id}/validate:
 *   post:
 *     summary: Validate Score Card (recomputes score + checks submit guards)
 *     tags: [ScoreCard]
 */
router.post('/:id/validate', validate(idParamSchema, 'params'), requirePermission('caseSubmit'), writeAccess, controller.validate);

/**
 * @openapi
 * /score-cards/{id}/submit:
 *   post:
 *     summary: Submit Score Card
 *     tags: [ScoreCard]
 */
router.post('/:id/submit', validate(idParamSchema, 'params'), requirePermission('caseSubmit'), writeAccess, controller.submit);

/**
 * @openapi
 * /score-cards/{id}/approve:
 *   post:
 *     summary: Approve Score Card
 *     tags: [ScoreCard]
 */
router.post(
  '/:id/approve',
  validate(idParamSchema, 'params'),
  validate(approveSchema),
  requirePermission('caseApprove'),
  controller.approve
);

/**
 * @openapi
 * /score-cards/{id}/reject:
 *   post:
 *     summary: Reject Score Card
 *     tags: [ScoreCard]
 */
router.post(
  '/:id/reject',
  validate(idParamSchema, 'params'),
  validate(rejectSchema),
  requirePermission('caseReject'),
  controller.reject
);

/**
 * @openapi
 * /score-cards/{id}/recalculate:
 *   post:
 *     summary: Recalculate Score
 *     tags: [ScoreCard]
 */
router.post(
  '/:id/recalculate',
  validate(idParamSchema, 'params'),
  writeAccess,
  controller.recalculate
);

/**
 * @openapi
 * /score-cards/{id}/summary:
 *   get:
 *     summary: Get Score Summary
 *     tags: [ScoreCard]
 */
router.get('/:id/summary', validate(idParamSchema, 'params'), readAccess, controller.getSummary);

/**
 * @openapi
 * /score-cards/{id}/history:
 *   get:
 *     summary: Get Score History (full version snapshots)
 *     tags: [ScoreCard]
 */
router.get('/:id/history', validate(idParamSchema, 'params'), readAccess, controller.getHistory);

/**
 * @openapi
 * /score-cards/{id}/audit-logs:
 *   get:
 *     summary: Get Audit Logs
 *     tags: [ScoreCard]
 */
router.get(
  '/:id/audit-logs',
  validate(idParamSchema, 'params'),
  requirePermission('auditView'),
  controller.getAuditLogs
);

/**
 * @openapi
 * /score-cards/{id}/documents:
 *   post:
 *     summary: Upload Supporting Documents
 *     tags: [ScoreCard]
 *   get:
 *     summary: List supporting documents
 *     tags: [ScoreCard]
 */
router.post(
  '/:id/documents',
  validate(idParamSchema, 'params'),
  validate(documentUploadSchema),
  requirePermission('docUpload'),
  writeAccess,
  controller.uploadDocument
);
router.get('/:id/documents', validate(idParamSchema, 'params'), readAccess, controller.getDocuments);

module.exports = router;
