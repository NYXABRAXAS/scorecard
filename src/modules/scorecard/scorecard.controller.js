'use strict';

const service = require('./scorecard.service');
const { ok, created, noContent, paginationMeta } = require('../../utils/apiResponse');
const { asyncHandler } = require('../../middleware/errorHandler');
const { parseListQuery } = require('../../utils/pagination');

/** Builds the actor context every service call needs for audit logging. */
function actorFrom(req) {
  return {
    id: req.user.id,
    role: req.user.role,
    label: req.user.label || req.user.employeeId,
    ip: req.clientIp,
    userAgent: req.headers['user-agent']
  };
}

const SORTABLE_FIELDS = ['created_at', 'updated_at', 'final_weighted_score', 'status', 'application_id'];

module.exports = {
  // POST /score-cards
  create: asyncHandler(async (req, res) => {
    const result = await service.create(req.body, actorFrom(req));
    created(res, result);
  }),

  // GET /score-cards
  list: asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query, { sortableFields: SORTABLE_FIELDS });
    const merged = { ...listQuery, ...req.query };
    const { rows, totalRecords } = await service.list(merged);
    ok(res, rows, paginationMeta({ page: listQuery.page, pageSize: listQuery.pageSize, totalRecords }));
  }),

  // GET /score-cards/:id
  getById: asyncHandler(async (req, res) => {
    const result = await service.getById(req.params.id);
    ok(res, result);
  }),

  // GET /score-cards/application/:applicationId
  getByApplicationId: asyncHandler(async (req, res) => {
    const result = await service.getByApplicationId(req.params.applicationId);
    ok(res, result);
  }),

  // PUT /score-cards/:id
  update: asyncHandler(async (req, res) => {
    const result = await service.update(req.params.id, req.body, actorFrom(req));
    ok(res, result);
  }),

  // PATCH /score-cards/:id/draft
  saveDraft: asyncHandler(async (req, res) => {
    const result = await service.saveDraft(req.params.id, req.body, actorFrom(req));
    ok(res, result);
  }),

  // POST /score-cards/:id/validate
  validate: asyncHandler(async (req, res) => {
    const result = await service.validate(req.params.id, actorFrom(req));
    ok(res, result, null, result.valid ? 200 : 422);
  }),

  // POST /score-cards/:id/submit
  submit: asyncHandler(async (req, res) => {
    const result = await service.submit(req.params.id, actorFrom(req));
    ok(res, result);
  }),

  // POST /score-cards/:id/approve
  approve: asyncHandler(async (req, res) => {
    const result = await service.approve(req.params.id, req.body.remarks, actorFrom(req));
    ok(res, result);
  }),

  // POST /score-cards/:id/reject
  reject: asyncHandler(async (req, res) => {
    const result = await service.reject(req.params.id, req.body.rejectionReason, actorFrom(req));
    ok(res, result);
  }),

  // POST /score-cards/:id/recalculate
  recalculate: asyncHandler(async (req, res) => {
    const result = await service.recalculate(req.params.id, actorFrom(req));
    ok(res, result);
  }),

  // DELETE /score-cards/:id
  remove: asyncHandler(async (req, res) => {
    await service.remove(req.params.id, actorFrom(req));
    noContent(res);
  }),

  // GET /score-cards/:id/summary
  getSummary: asyncHandler(async (req, res) => {
    const result = await service.getSummary(req.params.id);
    ok(res, result);
  }),

  // GET /score-cards/:id/history
  getHistory: asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query, { sortableFields: ['version'], defaultSort: 'version' });
    const { rows, totalRecords } = await service.getHistory(req.params.id, listQuery);
    ok(res, rows, paginationMeta({ page: listQuery.page, pageSize: listQuery.pageSize, totalRecords }));
  }),

  // GET /score-cards/:id/audit-logs
  getAuditLogs: asyncHandler(async (req, res) => {
    const listQuery = parseListQuery(req.query, { sortableFields: ['created_at'], defaultSort: 'created_at' });
    const { rows, totalRecords } = await service.getAuditLogs(req.params.id, listQuery);
    ok(res, rows, paginationMeta({ page: listQuery.page, pageSize: listQuery.pageSize, totalRecords }));
  }),

  // POST /score-cards/:id/documents
  uploadDocument: asyncHandler(async (req, res) => {
    const result = await service.uploadDocument(req.params.id, req.body, actorFrom(req));
    created(res, result);
  }),

  // GET /score-cards/:id/documents
  getDocuments: asyncHandler(async (req, res) => {
    const result = await service.getDocuments(req.params.id);
    ok(res, result);
  })
};
