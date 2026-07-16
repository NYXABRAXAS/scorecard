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
    profileType: row.profile_type,
    totalScore: row.total_score != null ? Number(row.total_score) : null,
    totalFinalScore: row.total_final_score != null ? Number(row.total_final_score) : null
  };
}

function mapResponseRow(row) {
  return {
    parameterId: row.parameter_id,
    selectedOptionId: row.selected_option_id,
    qualitativeFlag: row.qualitative_flag,
    netScore: Number(row.net_score)
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

/** Persists one person's already-computed responses (netScore per response, totals on the person row). */
async function insertPerson(client, scoreCardId, role, person) {
  const personResult = await client.query(
    `INSERT INTO score_card_persons (score_card_id, person_role, name, profile_type, total_score, total_final_score)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [scoreCardId, role, person.name, person.profileType, person.totalScore ?? null, person.totalFinalScore ?? null]
  );
  const personId = personResult.rows[0].id;

  for (const r of person.responses || []) {
    await client.query(
      `INSERT INTO score_card_person_responses
         (score_card_person_id, parameter_id, selected_option_id, qualitative_flag, net_score)
       VALUES ($1,$2,$3,$4,$5)`,
      [personId, r.parameterId, r.selectedOptionId ?? null, r.qualitativeFlag ?? null, r.netScore]
    );
  }
  return personId;
}

const repository = {
  mapScoreCardRow,
  mapPersonRow,
  mapResponseRow,
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

  /** Every person for this card, each with its nested `responses[]` (person-parameter answers). */
  async getPersons(scoreCardId) {
    const { rows } = await query(
      `SELECT * FROM score_card_persons WHERE score_card_id = $1 ORDER BY (person_role = 'SB') DESC, person_role ASC`,
      [scoreCardId]
    );
    const persons = rows.map(mapPersonRow);
    if (!persons.length) return persons;

    const { rows: responseRows } = await query(
      `SELECT r.* FROM score_card_person_responses r
       JOIN score_card_persons p ON p.id = r.score_card_person_id
       WHERE p.score_card_id = $1`,
      [scoreCardId]
    );
    const responsesByPerson = new Map();
    for (const r of responseRows) {
      const list = responsesByPerson.get(r.score_card_person_id) || [];
      list.push(mapResponseRow(r));
      responsesByPerson.set(r.score_card_person_id, list);
    }
    return persons.map((p) => ({ ...p, responses: responsesByPerson.get(p.id) || [] }));
  },

  async getSecurities(scoreCardId) {
    const { rows } = await query(`SELECT * FROM score_card_securities WHERE score_card_id = $1 ORDER BY id`, [scoreCardId]);
    return rows.map(mapSecurityRow);
  },

  async list({ page, pageSize, offset, sortField, sortDir, status, applicationId, createdBy, fromDate, toDate }) {
    const where = ['is_deleted = FALSE'];
    const params = [];
    let i = 1;

    if (status) { where.push(`status = $${i++}`); params.push(status); }
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

  /**
   * Creates the score card + its person/security children inside one transaction.
   * `subscriber`/`guarantors` are expected already-computed (totalScore, totalFinalScore,
   * responses[] with netScore) — computing them from raw input is scorecard.service.js's job.
   */
  async create({ applicationId, chitValue, futureLiability, documentsComplete, securityTotalValue, securityCoversLiability, cibilComplete, subscriber, guarantors, securities, createdBy }) {
    return withTransaction(async (client) => {
      const cardResult = await client.query(
        `INSERT INTO score_cards
           (application_id, chit_value, future_liability, documents_complete, security_total_value, security_covers_liability, cibil_complete, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [applicationId, chitValue, futureLiability, documentsComplete, securityTotalValue || 0, !!securityCoversLiability, !!cibilComplete, createdBy]
      );
      const card = cardResult.rows[0];

      await insertPerson(client, card.id, 'SB', subscriber);
      for (let idx = 0; idx < (guarantors || []).length; idx += 1) {
        await insertPerson(client, card.id, `SURETY-${idx + 1}`, guarantors[idx]);
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

  /** Persists a partial update to the score card's own fields (not persons/securities). */
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

  /** Replaces every person (+ their responses), leaving securities untouched — used to write back a fresh recalculation. */
  async replacePersons(id, { subscriber, guarantors }, client) {
    const runner = client || { query };
    await runner.query(`DELETE FROM score_card_persons WHERE score_card_id = $1`, [id]);
    await insertPerson(runner, id, 'SB', subscriber);
    for (let idx = 0; idx < (guarantors || []).length; idx += 1) {
      await insertPerson(runner, id, `SURETY-${idx + 1}`, guarantors[idx]);
    }
  },

  /** Replaces every person (+ their responses) and every security for this card with the given (already-computed) set. */
  async replacePersonsAndSecurities(id, { subscriber, guarantors, securities }, client) {
    const runner = client || { query };
    await runner.query(`DELETE FROM score_card_persons WHERE score_card_id = $1`, [id]);
    await runner.query(`DELETE FROM score_card_securities WHERE score_card_id = $1`, [id]);

    await insertPerson(runner, id, 'SB', subscriber);
    for (let idx = 0; idx < (guarantors || []).length; idx += 1) {
      await insertPerson(runner, id, `SURETY-${idx + 1}`, guarantors[idx]);
    }
    for (const s of securities || []) {
      await runner.query(
        `INSERT INTO score_card_securities (score_card_id, security_type, holder_name, loyalty_usn, valuation_inputs, free_value, value_loaded)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, s.securityType, s.holderName || null, s.loyaltyUsn || null, JSON.stringify(s.valuationInputs || {}), s.freeValue, s.valueLoaded]
      );
    }
  },

  /** Persists freshly-computed case-level guard values onto the score card row (per-person scores live on score_card_persons). */
  async applyComputedScores(id, computed, client) {
    const runner = client || { query };
    await runner.query(
      `UPDATE score_cards SET
         security_total_value = $1, security_covers_liability = $2, cibil_complete = $3
       WHERE id = $4`,
      [computed.securityTotalValue, computed.securityCoversLiability, computed.cibilComplete, id]
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
