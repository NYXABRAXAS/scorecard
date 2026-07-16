'use strict';

const { query } = require('../../config/db');
const { ok } = require('../../utils/apiResponse');
const { asyncHandler } = require('../../middleware/errorHandler');
const ApiError = require('../../utils/ApiError');

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

  /**
   * GET /masters/credit-score-parameters?profileType=SALARIED|BUSINESS
   * Returns the full parameter + option matrix for one profile, exactly as
   * loaded from Credit Score.xlsx (db/seed_credit_score.sql) — this is what
   * the UI renders as the score card form for that profile.
   */
  creditScoreParameters: asyncHandler(async (req, res) => {
    const profileType = String(req.query.profileType || '').toUpperCase();
    if (!['SALARIED', 'BUSINESS'].includes(profileType)) {
      throw ApiError.badRequest('INVALID_PROFILE_TYPE', 'profileType query parameter must be SALARIED or BUSINESS.');
    }

    const { rows: paramRows } = await query(
      `SELECT * FROM scorecard_parameter_master WHERE profile_type = $1 AND is_active = TRUE ORDER BY display_order`,
      [profileType]
    );
    const { rows: optionRows } = await query(
      `SELECT o.* FROM scorecard_parameter_option_master o
       JOIN scorecard_parameter_master p ON p.id = o.parameter_id
       WHERE p.profile_type = $1 ORDER BY o.parameter_id, o.display_order`,
      [profileType]
    );

    const optionsByParam = new Map();
    for (const o of optionRows) {
      const list = optionsByParam.get(o.parameter_id) || [];
      list.push({ id: o.id, label: o.option_label, weightage: Number(o.weightage), displayOrder: o.display_order });
      optionsByParam.set(o.parameter_id, list);
    }

    ok(res, paramRows.map((p) => ({
      id: p.id,
      profileType: p.profile_type,
      slNo: p.sl_no,
      name: p.name,
      category: p.category,
      maxScore: Number(p.max_score),
      displayOrder: p.display_order,
      options: p.category === 'QUANTITATIVE' ? (optionsByParam.get(p.id) || []) : undefined
    })));
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
