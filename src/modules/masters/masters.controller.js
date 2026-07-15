'use strict';

const { query } = require('../../config/db');
const { ok } = require('../../utils/apiResponse');
const { asyncHandler } = require('../../middleware/errorHandler');

const EMPLOYMENT_TYPES = [
  'Salaried-Govt', 'Salaried-PSU', 'Salaried-Private',
  'Business', 'Self Employed - Professional', 'Agriculture', 'Other'
];
const ENTITY_TYPES = ['PvtLtd', 'Partnership', 'Proprietorship'];
const DOCUMENT_TYPES = ['DPN', 'KYC', 'Gold Appraisal', 'Income Proof', 'Address Proof', 'Bank Statement', 'Other'];

module.exports = {
  // GET /masters/security-types
  securityTypes: asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT * FROM security_type_master WHERE status = 'Active' ORDER BY security_type`);
    ok(res, rows.map((r) => ({
      securityType: r.security_type,
      category: r.category,
      isSecured: r.is_secured,
      ltvCap: r.ltv_cap != null ? Number(r.ltv_cap) : null,
      approvalAuthority: r.approval_authority
    })));
  }),

  // GET /masters/score-bands
  scoreBands: asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT * FROM cam_score_band_master ORDER BY display_order`);
    ok(res, rows.map((r) => ({
      minScore: Number(r.min_score), maxScore: Number(r.max_score),
      grade: r.grade, label: r.label, decisionText: r.decision_text
    })));
  }),

  // GET /masters/employment-types
  employmentTypes: asyncHandler(async (req, res) => {
    ok(res, EMPLOYMENT_TYPES);
  }),

  // GET /masters/entity-types
  entityTypes: asyncHandler(async (req, res) => {
    ok(res, ENTITY_TYPES);
  }),

  // GET /masters/document-types
  documentTypes: asyncHandler(async (req, res) => {
    ok(res, DOCUMENT_TYPES);
  }),

  // GET /masters/roles
  roles: asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT role_code, role_label FROM role_master WHERE is_active = TRUE ORDER BY role_code`);
    ok(res, rows.map((r) => ({ code: r.role_code, label: r.role_label })));
  })
};
