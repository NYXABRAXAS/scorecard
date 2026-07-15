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
    chitValue: Number(row.chit_value),
    futureLiability: Number(row.future_liability),
    securityTotalValue: Number(row.security_total_value),
    documentsComplete: row.documents_complete,
    securityCoversLiability: row.security_covers_liability,
    cibilComplete: row.cibil_complete,
    grossMonthlyIncome: Number(row.gross_monthly_income),
    existingObligations: Number(row.existing_obligations),
    proposedEmi: Number(row.proposed_emi),
    scores: {
      cibilFactorScore: row.cibil_factor_score != null ? Number(row.cibil_factor_score) : null,
      incomeEmiScore: row.income_emi_score != null ? Number(row.income_emi_score) : null,
      securityCoverageScore: row.security_coverage_score != null ? Number(row.security_coverage_score) : null,
      dpdHistoryScore: row.dpd_history_score != null ? Number(row.dpd_history_score) : null,
      enquiryCountScore: row.enquiry_count_score != null ? Number(row.enquiry_count_score) : null,
      guarantorQualityScore: row.guarantor_quality_score != null ? Number(row.guarantor_quality_score) : null,
      totalScore: row.total_score != null ? Number(row.total_score) : null,
      eligible: row.eligible,
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
    creditScore: row.credit_score,
    worstDpdDays: row.worst_dpd_days,
    enquiryCount6Months: row.enquiry_count_6m,
    grossIncome: row.gross_income != null ? Number(row.gross_income) : null,
    netIncome: row.net_income != null ? Number(row.net_income) : null
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

  async list({ page, pageSize, offset, sortField, sortDir, status, eligible, applicationId, createdBy, fromDate, toDate }) {
    const where = ['is_deleted = FALSE'];
    const params = [];
    let i = 1;

    if (status) { where.push(`status = $${i++}`); params.push(status); }
    if (eligible !== undefined) { where.push(`eligible = $${i++}`); params.push(eligible); }
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
  async create({ applicationId, chitValue, futureLiability, documentsComplete, grossMonthlyIncome, existingObligations, proposedEmi, subscriber, guarantors, securities, createdBy }) {
    return withTransaction(async (client) => {
      const cardResult = await client.query(
        `INSERT INTO score_cards
           (application_id, chit_value, future_liability, documents_complete, gross_monthly_income, existing_obligations, proposed_emi, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [applicationId, chitValue, futureLiability, documentsComplete, grossMonthlyIncome, existingObligations || 0, proposedEmi, createdBy]
      );
      const card = cardResult.rows[0];

      await client.query(
        `INSERT INTO score_card_persons
           (score_card_id, person_role, name, employment_type, entity_type, credit_score, worst_dpd_days, enquiry_count_6m, gross_income, net_income)
         VALUES ($1,'SB',$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          card.id, subscriber.name, subscriber.employmentType, subscriber.entityType || null,
          subscriber.creditScore ?? null, subscriber.worstDpdDays ?? null, subscriber.enquiryCount6Months ?? null,
          subscriber.grossIncome || null, subscriber.netIncome || null
        ]
      );

      for (let idx = 0; idx < (guarantors || []).length; idx += 1) {
        const g = guarantors[idx];
        await client.query(
          `INSERT INTO score_card_persons
             (score_card_id, person_role, name, employment_type, entity_type, credit_score, worst_dpd_days, enquiry_count_6m, gross_income, net_income)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            card.id, `SURETY-${idx + 1}`, g.name, g.employmentType, g.entityType || null,
            g.creditScore ?? null, g.worstDpdDays ?? null, g.enquiryCount6Months ?? null,
            g.grossIncome || null, g.netIncome || null
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
      grossMonthlyIncome: 'gross_monthly_income',
      existingObligations: 'existing_obligations',
      proposedEmi: 'proposed_emi',
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
           (score_card_id, person_role, name, employment_type, entity_type, credit_score, worst_dpd_days, enquiry_count_6m, gross_income, net_income)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id, p.role, p.name, p.employmentType, p.entityType || null,
          p.creditScore ?? null, p.worstDpdDays ?? null, p.enquiryCount6Months ?? null,
          p.grossIncome || null, p.netIncome || null
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
         security_total_value = $1, security_covers_liability = $2, cibil_complete = $3,
         cibil_factor_score = $4, income_emi_score = $5, security_coverage_score = $6,
         dpd_history_score = $7, enquiry_count_score = $8, guarantor_quality_score = $9,
         total_score = $10, eligible = $11, decision_text = $12
       WHERE id = $13`,
      [
        computed.securityTotalValue, computed.securityCoversLiability, computed.cibilComplete,
        computed.factors.cibilScore.score, computed.factors.incomeEmiCoverage.score, computed.factors.securityCoverage.score,
        computed.factors.dpdHistory.score, computed.factors.enquiryCount.score, computed.factors.guarantorQuality.score,
        computed.totalScore, computed.eligible, computed.decisionText,
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
