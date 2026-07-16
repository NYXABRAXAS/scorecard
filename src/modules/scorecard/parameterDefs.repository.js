'use strict';

const { query } = require('../../config/db');

/**
 * Loads the ordered parameter + option matrix for one profile (SALARIED or
 * BUSINESS), exactly as seeded from Credit Score.xlsx (db/seed_credit_score.sql).
 * Shared by masters.controller.js (dropdown listing) and creditScoreEngine.js
 * (via scorecard.service.js) so both read the identical definition.
 */
async function loadParameterDefs(profileType) {
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

  return paramRows.map((p) => ({
    id: p.id,
    profileType: p.profile_type,
    slNo: p.sl_no,
    name: p.name,
    category: p.category,
    maxScore: Number(p.max_score),
    displayOrder: p.display_order,
    options: p.category === 'QUANTITATIVE' ? (optionsByParam.get(p.id) || []) : []
  }));
}

module.exports = { loadParameterDefs };
