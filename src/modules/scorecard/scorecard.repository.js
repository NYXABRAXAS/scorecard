'use strict';

const { query, withTransaction } = require('../../config/db');

/** Maps a DB row (snake_case) to the camelCase API shape. Kept centralised so every
 *  controller/response looks identical regardless of which query produced the row. */
function mapScoreCardRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    applicationId: row.application_id,
    version: row.version,
    status: row.status,
    segment: {
      category: row.segment_category,
      bucket: row.segment_bucket,
      method: row.scoring_method
    },
    chitValue: Number(row.chit_value),
    futureLiability: Number(row.future_liability),
    securityTotalValue: Number(row.security_total_value),
    documentsComplete: row.documents_complete,
    securityCoversLiability: row.security_covers_liability,
    cibilComplete: row.cibil_complete,
    scores: {
      sbPositiveScore: row.sb_positive_score != null ? Number(row.sb_positive_score) : null,
      sbNegativeScore: row.sb_negative_score != null ? Number(row.sb_negative_score) : null,
      sbFinalScore: row.sb_final_score != null ? Number(row.sb_final_score) : null,
      avgGuarantorScore: Number(row.avg_guarantor_score),
      sbWeightage: Number(row.sb_weightage),
      guarantorWeightage: Number(row.guarantor_weightage),
      finalWeightedScore: row.final_weighted_score != null ? Number(row.final_weighted_score) : null,
      riskGrade: row.risk_grade,
      riskLabel: row.risk_label,
      decisionText: row.decision_text
    },
    audit: {
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
      validatedBy: row.validated_by,
      validatedAt: row.validated_at,
      submittedBy: row.submitted_by,
      submittedAt: row.submitted_at,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      rejectedBy: row.rejected_by,
      rejectedAt: row.rejected_at
    },
    rejectionReason: row.rejection_reason,
    remarks: row.remarks,
    isDeleted: row.is_deleted
  };
}

function mapPersonRow(row) {
  return {
    id: row.id,
    role: row.person_role,
    name: row.name,
    employmentType: row.employment_type,
    entityType: row.entity_type,
    yearsInBusiness: row.years_in_business != null ? Number(row.years_in_business) : null,
    yearsOfService: row.years_of_service != null ? Number(row.years_of_service) : null,
    employeeCount: row.employee_count,
    staffCount: row.staff_count,
    permanentGovt: row.permanent_govt,
    customerVintageYears: row.customer_vintage_years != null ? Number(row.customer_vintage_years) : null,
    personalVisits: row.personal_visits,
    propertyCount: row.property_count,
    propertyValue: Number(row.property_value),
    creditScore: row.credit_score,
    foir: row.foir != null ? Number(row.foir) : null,
    grossIncome: row.gross_income != null ? Number(row.gross_income) : null,
    netIncome: row.net_income != null ? Number(row.net_income) : null,
    directExposure: Number(row.direct_exposure),
    indirectExposure: Number(row.indirect_exposure),
    suitFiled: row.suit_filed,
    prlFlag: row.prl_flag,
    cc3Flag: row.cc3_flag,
    chequeBounceCount: row.cheque_bounce_count,
    positiveScore: row.positive_score != null ? Number(row.positive_score) : null,
    negativeScore: row.negative_score != null ? Number(row.negative_score) : null,
    finalScore: row.final_score != null ? Number(row.final_score) : null
  };
}

function mapSecurityRow(row) {
  return {
    id: row.id,
    securityType: row.security_type,
    holderName: row.holder_name,
    loyaltyUsn: row.loyalty_usn,
    valuationInputs: row.valuation_inputs,
    freeValue: Number(row.free_value),
    valueLoaded: Number(row.value_loaded)
  };
}

const repository = {
  mapScoreCardRow,
  mapPersonRow,
  mapSecurityRow,

  async findById(id, { includeDeleted = false } = {}) {
    const sql = `SELECT * FROM score_cards WHERE id = $1 ${includeDeleted ? '' : 'AND is_deleted = FALSE'}`;
    const { rows } = await query(sql, [id]);
    return mapScoreCardRow(rows[0]);
  },

  async findByApplicationId(applicationId) {
    const { rows } = await query(
      `SELECT * FROM score_cards WHERE application_id = $1 AND is_deleted = FALSE`,
      [applicationId]
    );
    return mapScoreCardRow(rows[0]);
  },

  async getPersons(scoreCardId) {
    const { rows } = await query(
      `SELECT * FROM score_card_persons WHERE score_card_id = $1 ORDER BY (person_role = 'SB') DESC, person_role ASC`,
      [scoreCardId]
    );
    return rows.map(mapPersonRow);
  },

  async getSecurities(scoreCardId) {
    const { rows } = await query(`SELECT * FROM score_card_securities WHERE score_card_id = $1 ORDER BY id`, [scoreCardId]);
    return rows.map(mapSecurityRow);
  },

  async list({ page, pageSize, offset, sortField, sortDir, status, riskGrade, applicationId, createdBy, fromDate, toDate }) {
    const where = ['is_deleted = FALSE'];
    const params = [];
    let i = 1;

    if (status) { where.push(`status = $${i++}`); params.push(status); }
    if (riskGrade) { where.push(`risk_grade = $${i++}`); params.push(riskGrade); }
    if (applicationId) { where.push(`application_id = $${i++}`); params.push(applicationId); }
    if (createdBy) { where.push(`created_by = $${i++}`); params.push(createdBy); }
    if (fromDate) { where.push(`created_at >= $${i++}`); params.push(fromDate); }
    if (toDate) { where.push(`created_at <= $${i++}`); params.push(toDate); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortColumn = /^[a-z_]+$/.test(sortField) ? sortField : 'created_at';

    const countResult = await query(`SELECT COUNT(*)::int AS total FROM score_cards ${whereSql}`, params);
    const dataResult = await query(
      `SELECT * FROM score_cards ${whereSql} ORDER BY ${sortColumn} ${sortDir} LIMIT $${i++} OFFSET $${i++}`,
      [...params, pageSize, offset]
    );

    return {
      rows: dataResult.rows.map(mapScoreCardRow),
      totalRecords: countResult.rows[0].total
    };
  },

  /** Creates the score card + its person/security children inside one transaction. */
  async create({ applicationId, chitValue, futureLiability, documentsComplete, subscriber, guarantors, securities, createdBy }) {
    return withTransaction(async (client) => {
      const cardResult = await client.query(
        `INSERT INTO score_cards
           (application_id, chit_value, future_liability, documents_complete, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [applicationId, chitValue, futureLiability, documentsComplete, createdBy]
      );
      const card = cardResult.rows[0];

      await client.query(
        `INSERT INTO score_card_persons
           (score_card_id, person_role, name, employment_type, entity_type, years_in_business, years_of_service,
            employee_count, staff_count, permanent_govt, customer_vintage_years, personal_visits,
            property_count, property_value, credit_score, foir, gross_income, net_income,
            direct_exposure, indirect_exposure, suit_filed, prl_flag, cc3_flag, cheque_bounce_count)
         VALUES ($1,'SB',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [
          card.id, subscriber.name, subscriber.employmentType, subscriber.entityType || null,
          subscriber.yearsInBusiness || null, subscriber.yearsOfService || null,
          subscriber.employeeCount || null, subscriber.staffCount || null, subscriber.permanentGovt ?? null,
          subscriber.customerVintageYears || null, subscriber.personalVisits || 0,
          subscriber.propertyCount || 0, subscriber.propertyValue || 0, subscriber.creditScore || null,
          subscriber.foir, subscriber.grossIncome || null, subscriber.netIncome || null,
          subscriber.directExposure || 0, subscriber.indirectExposure || 0,
          subscriber.suitFiled || false, subscriber.prlFlag || false, subscriber.cc3Flag || false,
          subscriber.chequeBounceCount || 0
        ]
      );

      for (let idx = 0; idx < (guarantors || []).length; idx += 1) {
        const g = guarantors[idx];
        await client.query(
          `INSERT INTO score_card_persons
             (score_card_id, person_role, name, employment_type, entity_type, years_in_business, years_of_service,
              employee_count, staff_count, permanent_govt, customer_vintage_years, personal_visits,
              property_count, property_value, credit_score, foir, gross_income, net_income,
              direct_exposure, indirect_exposure, suit_filed, prl_flag, cc3_flag, cheque_bounce_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
          [
            card.id, `SURETY-${idx + 1}`, g.name, g.employmentType, g.entityType || null,
            g.yearsInBusiness || null, g.yearsOfService || null, g.employeeCount || null, g.staffCount || null,
            g.permanentGovt ?? null, g.customerVintageYears || null, g.personalVisits || 0,
            g.propertyCount || 0, g.propertyValue || 0, g.creditScore || null, g.foir,
            g.grossIncome || null, g.netIncome || null, g.directExposure || 0, g.indirectExposure || 0,
            g.suitFiled || false, g.prlFlag || false, g.cc3Flag || false, g.chequeBounceCount || 0
          ]
        );
      }

      for (const s of securities) {
        await client.query(
          `INSERT INTO score_card_securities (score_card_id, security_type, holder_name, loyalty_usn, valuation_inputs, free_value, value_loaded)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [card.id, s.securityType, s.holderName || null, s.loyaltyUsn || null, JSON.stringify(s.valuationInputs || {}), s.freeValue, s.valueLoaded]
        );
      }

      return card.id;
    });
  },

  /** Persists a partial update to the score card + replaces person/security children if supplied. */
  async update(id, patch, client) {
    const fieldMap = {
      chitValue: 'chit_value',
      futureLiability: 'future_liability',
      documentsComplete: 'documents_complete',
      remarks: 'remarks'
    };
    const sets = [];
    const params = [];
    let i = 1;
    for (const [key, column] of Object.entries(fieldMap)) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = $${i++}`);
        params.push(patch[key]);
      }
    }
    if (!sets.length) return;
    params.push(id);
    const runner = client || { query };
    await runner.query(`UPDATE score_cards SET ${sets.join(', ')} WHERE id = $${i}`, params);
  },

  async replacePersonsAndSecurities(id, { subscriber, guarantors, securities }, client) {
    const runner = client || { query };
    await runner.query(`DELETE FROM score_card_persons WHERE score_card_id = $1`, [id]);
    await runner.query(`DELETE FROM score_card_securities WHERE score_card_id = $1`, [id]);

    const people = [{ ...subscriber, role: 'SB' }, ...(guarantors || []).map((g, i) => ({ ...g, role: `SURETY-${i + 1}` }))];
    for (const p of people) {
      await runner.query(
        `INSERT INTO score_card_persons
           (score_card_id, person_role, name, employment_type, entity_type, years_in_business, years_of_service,
            employee_count, staff_count, permanent_govt, customer_vintage_years, personal_visits,
            property_count, property_value, credit_score, foir, gross_income, net_income,
            direct_exposure, indirect_exposure, suit_filed, prl_flag, cc3_flag, cheque_bounce_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [
          id, p.role, p.name, p.employmentType, p.entityType || null, p.yearsInBusiness || null, p.yearsOfService || null,
          p.employeeCount || null, p.staffCount || null, p.permanentGovt ?? null, p.customerVintageYears || null,
          p.personalVisits || 0, p.propertyCount || 0, p.propertyValue || 0, p.creditScore || null, p.foir,
          p.grossIncome || null, p.netIncome || null, p.directExposure || 0, p.indirectExposure || 0,
          p.suitFiled || false, p.prlFlag || false, p.cc3Flag || false, p.chequeBounceCount || 0
        ]
      );
    }
    for (const s of securities || []) {
      await runner.query(
        `INSERT INTO score_card_securities (score_card_id, security_type, holder_name, loyalty_usn, valuation_inputs, free_value, value_loaded)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, s.securityType, s.holderName || null, s.loyaltyUsn || null, JSON.stringify(s.valuationInputs || {}), s.freeValue, s.valueLoaded]
      );
    }
  },

  /** Persists freshly-computed scoring output onto the score card row. */
  async applyComputedScores(id, computed, client) {
    const runner = client || { query };
    await runner.query(
      `UPDATE score_cards SET
         segment_category = $1, segment_bucket = $2, scoring_method = $3,
         security_total_value = $4, security_covers_liability = $5, cibil_complete = $6,
         sb_positive_score = $7, sb_negative_score = $8, sb_final_score = $9,
         avg_guarantor_score = $10, final_weighted_score = $11,
         risk_grade = $12, risk_label = $13, decision_text = $14
       WHERE id = $15`,
      [
        computed.segment.category, computed.segment.bucket, computed.segment.method,
        computed.securityTotalValue, computed.securityCoversLiability, computed.cibilComplete,
        computed.sb.positive, computed.sb.negative, computed.sb.final,
        computed.avgGuarantorScore, computed.finalWeightedScore,
        computed.riskGrade, computed.riskLabel, computed.decisionText,
        id
      ]
    );
  },

  async setStatus(id, status, actorFields, client) {
    const runner = client || { query };
    const columns = { status };
    Object.assign(columns, actorFields);
    const sets = Object.keys(columns).map((k, idx) => `${toSnake(k)} = $${idx + 1}`);
    const params = Object.values(columns);
    params.push(id);
    await runner.query(`UPDATE score_cards SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  },

  async softDelete(id, deletedBy) {
    await query(`UPDATE score_cards SET is_deleted = TRUE, deleted_by = $1, deleted_at = now() WHERE id = $2`, [deletedBy, id]);
  },

  async nextVersion(id) {
    const { rows } = await query(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM score_card_versions WHERE score_card_id = $1`, [id]);
    return rows[0].next;
  },

  async insertVersionSnapshot({ scoreCardId, version, status, snapshot, changeReason, changedBy }, client) {
    const runner = client || { query };
    await runner.query(
      `INSERT INTO score_card_versions (score_card_id, version, status, snapshot, change_reason, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [scoreCardId, version, status, JSON.stringify(snapshot), changeReason, changedBy]
    );
    await runner.query(`UPDATE score_cards SET version = $1 WHERE id = $2`, [version, scoreCardId]);
  },

  async getHistory(scoreCardId, { page, pageSize, offset }) {
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM score_card_versions WHERE score_card_id = $1`, [scoreCardId]);
    const { rows } = await query(
      `SELECT id, version, status, change_reason, changed_by, changed_at, snapshot
       FROM score_card_versions WHERE score_card_id = $1
       ORDER BY version DESC LIMIT $2 OFFSET $3`,
      [scoreCardId, pageSize, offset]
    );
    return { rows, totalRecords: countResult.rows[0].total };
  },

  async insertAuditLog({ scoreCardId, applicationId, actorUserId, actorRole, actorLabel, action, detail, oldValue, newValue, ipAddress, userAgent }, client) {
    const runner = client || { query };
    await runner.query(
      `INSERT INTO score_card_audit_logs
         (score_card_id, application_id, actor_user_id, actor_role, actor_label, action, detail, old_value, new_value, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [scoreCardId, applicationId, actorUserId, actorRole, actorLabel, action, detail || null,
        oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null,
        ipAddress || null, userAgent || null]
    );
  },

  async getAuditLogs(scoreCardId, { page, pageSize, offset }) {
    const countResult = await query(`SELECT COUNT(*)::int AS total FROM score_card_audit_logs WHERE score_card_id = $1`, [scoreCardId]);
    const { rows } = await query(
      `SELECT * FROM score_card_audit_logs WHERE score_card_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [scoreCardId, pageSize, offset]
    );
    return { rows, totalRecords: countResult.rows[0].total };
  },

  async insertDocument({ scoreCardId, documentType, fileName, fileUrl, mimeType, fileSizeBytes, uploadedBy }) {
    const { rows } = await query(
      `INSERT INTO score_card_documents (score_card_id, document_type, file_name, file_url, mime_type, file_size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [scoreCardId, documentType, fileName, fileUrl, mimeType || null, fileSizeBytes || null, uploadedBy]
    );
    return rows[0];
  },

  async getDocuments(scoreCardId) {
    const { rows } = await query(
      `SELECT * FROM score_card_documents WHERE score_card_id = $1 AND is_deleted = FALSE ORDER BY uploaded_at DESC`,
      [scoreCardId]
    );
    return rows;
  }
};

function toSnake(s) {
  return s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

module.exports = repository;
