'use strict';

const repository = require('./scorecard.repository');
const { computeScoreCard } = require('./scoring.engine');
const ApiError = require('../../utils/ApiError');
const { withTransaction } = require('../../config/db');

/** Legal status transitions — the single source of truth for the lifecycle guard. */
const TRANSITIONS = {
  DRAFT: ['VALIDATED'],
  VALIDATED: ['SUBMITTED', 'DRAFT'], // editing a VALIDATED card invalidates it back to DRAFT
  SUBMITTED: ['APPROVED', 'REJECTED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED'], // reserved: no v1 endpoint transitions a card INTO this state yet
  APPROVED: [],
  REJECTED: ['DRAFT'] // BI may correct and restart the cycle
};

function assertCanEdit(card) {
  if (!['DRAFT', 'VALIDATED', 'REJECTED'].includes(card.status)) {
    throw ApiError.businessRule(
      'INVALID_STATE_FOR_EDIT',
      `Score card in status ${card.status} cannot be edited. Only DRAFT, VALIDATED or REJECTED cards can be edited.`
    );
  }
}

async function buildComputedForCard(scoreCardId) {
  const [persons, securities] = await Promise.all([
    repository.getPersons(scoreCardId),
    repository.getSecurities(scoreCardId)
  ]);
  const card = await repository.findById(scoreCardId);
  const subscriber = persons.find((p) => p.role === 'SB');
  const guarantors = persons.filter((p) => p.role !== 'SB');

  const computed = computeScoreCard({
    subscriber,
    guarantors,
    securities,
    chitValue: card.chitValue,
    futureLiability: card.futureLiability,
    documentsComplete: card.documentsComplete
  });
  return { card, persons, securities, computed };
}

async function auditableStatusChange({ scoreCardId, applicationId, newStatus, actorFields, actor, action, detail, oldValue, newValue, changeReason }) {
  return withTransaction(async (client) => {
    await repository.setStatus(scoreCardId, newStatus, actorFields, client);
    const version = await repository.nextVersion(scoreCardId);
    const snapshot = await repository.findById(scoreCardId); // re-read fresh state for the immutable snapshot
    await repository.insertVersionSnapshot(
      { scoreCardId, version, status: newStatus, snapshot, changeReason, changedBy: actor.id },
      client
    );
    await repository.insertAuditLog(
      {
        scoreCardId, applicationId, actorUserId: actor.id, actorRole: actor.role, actorLabel: actor.label,
        action, detail, oldValue, newValue, ipAddress: actor.ip, userAgent: actor.userAgent
      },
      client
    );
  });
}

const service = {
  async create(input, actor) {
    const existing = await repository.findByApplicationId(input.applicationId);
    if (existing) {
      throw ApiError.conflict('DUPLICATE_SCORE_CARD', `A score card already exists for application ${input.applicationId}.`, {
        existingId: existing.id
      });
    }

    const id = await repository.create({ ...input, createdBy: actor.id });

    // Compute the initial segment/score/guard preview immediately, so the create
    // response already reflects real numbers instead of all-null/default-zero
    // placeholders that only a subsequent /validate or /recalculate would fill in.
    const { computed } = await buildComputedForCard(id);
    await repository.applyComputedScores(id, computed);

    await repository.insertVersionSnapshot({
      scoreCardId: id, version: 1, status: 'DRAFT',
      snapshot: await repository.findById(id), changeReason: 'CREATE', changedBy: actor.id
    });
    await repository.insertAuditLog({
      scoreCardId: id, applicationId: input.applicationId, actorUserId: actor.id, actorRole: actor.role,
      actorLabel: actor.label, action: 'CREATE', detail: 'Score card created', ipAddress: actor.ip, userAgent: actor.userAgent
    });
    return this.getById(id);
  },

  async getById(id) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    const [persons, securities] = await Promise.all([repository.getPersons(id), repository.getSecurities(id)]);
    return { ...card, subscriber: persons.find((p) => p.role === 'SB'), guarantors: persons.filter((p) => p.role !== 'SB'), securities };
  },

  async getByApplicationId(applicationId) {
    const card = await repository.findByApplicationId(applicationId);
    if (!card) throw ApiError.notFound(`No score card exists for application ${applicationId}.`);
    return this.getById(card.id);
  },

  async list(listQuery) {
    const { rows, totalRecords } = await repository.list(listQuery);
    return { rows, totalRecords };
  },

  /** PUT — full business update; recomputes scores but does not change status (except VALIDATED -> DRAFT). */
  async update(id, patch, actor) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    assertCanEdit(card);

    const oldValue = await this.getById(id);

    await withTransaction(async (client) => {
      await repository.update(id, patch, client);
      if (patch.subscriber || patch.guarantors || patch.securities) {
        const merged = {
          subscriber: patch.subscriber || oldValue.subscriber,
          guarantors: patch.guarantors || oldValue.guarantors,
          securities: patch.securities || oldValue.securities
        };
        await repository.replacePersonsAndSecurities(id, merged, client);
      }
      const { computed } = await buildComputedForCard(id);
      await repository.applyComputedScores(id, computed, client);

      // Any edit to an already-VALIDATED card invalidates it — must be re-validated before submit.
      if (card.status === 'VALIDATED' || card.status === 'REJECTED') {
        await repository.setStatus(id, 'DRAFT', { updated_by: actor.id }, client);
      } else {
        await client.query('UPDATE score_cards SET updated_by = $1 WHERE id = $2', [actor.id, id]);
      }

      const version = await repository.nextVersion(id);
      const snapshot = await repository.findById(id);
      await repository.insertVersionSnapshot({ scoreCardId: id, version, status: snapshot.status, snapshot, changeReason: 'UPDATE', changedBy: actor.id }, client);
      await repository.insertAuditLog({
        scoreCardId: id, applicationId: card.applicationId, actorUserId: actor.id, actorRole: actor.role,
        actorLabel: actor.label, action: 'UPDATE', detail: 'Score card fields updated',
        oldValue, newValue: patch, ipAddress: actor.ip, userAgent: actor.userAgent
      }, client);
    });

    return this.getById(id);
  },

  /** Persists the current in-progress state without any validation gate or status change. */
  async saveDraft(id, patch, actor) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    if (card.status === 'SUBMITTED' || card.status === 'APPROVED') {
      throw ApiError.businessRule('INVALID_STATE_FOR_DRAFT_SAVE', `Cannot save draft on a score card in status ${card.status}.`);
    }
    await repository.update(id, patch, null);
    if (patch.subscriber || patch.guarantors || patch.securities) {
      const current = await this.getById(id);
      await repository.replacePersonsAndSecurities(id, {
        subscriber: patch.subscriber || current.subscriber,
        guarantors: patch.guarantors || current.guarantors,
        securities: patch.securities || current.securities
      }, null);
    }
    await repository.insertAuditLog({
      scoreCardId: id, applicationId: card.applicationId, actorUserId: actor.id, actorRole: actor.role,
      actorLabel: actor.label, action: 'SAVE_DRAFT', detail: 'Draft saved', ipAddress: actor.ip, userAgent: actor.userAgent
    });
    return this.getById(id);
  },

  /**
   * Recomputes the score and evaluates the three submit guards
   * (documentsComplete, securityCoversLiability, cibilComplete) — mirrors
   * workflow-engine.js's BRANCH_WIP -> SCRUTINY_PENDING guard array exactly.
   * On success, transitions DRAFT -> VALIDATED. Does NOT throw on guard failure —
   * returns { valid: false, failedGuards } so the caller (BI) sees exactly what's missing.
   */
  async validate(id, actor) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    if (!['DRAFT'].includes(card.status)) {
      throw ApiError.businessRule('INVALID_STATE_FOR_VALIDATE', `Only a DRAFT score card can be validated (current status: ${card.status}).`);
    }

    const { computed } = await buildComputedForCard(id);
    await repository.applyComputedScores(id, computed);

    const failedGuards = [];
    if (!computed.documentsComplete) failedGuards.push({ guard: 'documentsComplete', message: 'Mandatory documents (incl. DPN) are still pending upload.' });
    if (!computed.securityCoversLiability) failedGuards.push({ guard: 'securityCoversLiability', message: 'Accepted security value is below the Future Liability.' });
    if (!computed.cibilComplete) failedGuards.push({ guard: 'cibilComplete', message: 'CIBIL score is mandatory for the subscriber and every guarantor.' });

    if (failedGuards.length === 0) {
      await auditableStatusChange({
        scoreCardId: id, applicationId: card.applicationId, newStatus: 'VALIDATED',
        actorFields: { validated_by: actor.id, validated_at: new Date() },
        actor, action: 'VALIDATE', detail: 'All guards passed', changeReason: 'VALIDATE'
      });
    } else {
      await repository.insertAuditLog({
        scoreCardId: id, applicationId: card.applicationId, actorUserId: actor.id, actorRole: actor.role,
        actorLabel: actor.label, action: 'VALIDATE', detail: `Validation failed: ${failedGuards.map((g) => g.guard).join(', ')}`,
        ipAddress: actor.ip, userAgent: actor.userAgent
      });
    }

    return { valid: failedGuards.length === 0, failedGuards, scoreCard: await this.getById(id) };
  },

  async submit(id, actor) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    if (card.status !== 'VALIDATED') {
      throw ApiError.businessRule('INVALID_STATE_FOR_SUBMIT', `Only a VALIDATED score card can be submitted (current status: ${card.status}). Call /validate first.`);
    }
    await auditableStatusChange({
      scoreCardId: id, applicationId: card.applicationId, newStatus: 'SUBMITTED',
      actorFields: { submitted_by: actor.id, submitted_at: new Date() },
      actor, action: 'SUBMIT', detail: 'Submitted for review', changeReason: 'SUBMIT'
    });
    return this.getById(id);
  },

  async approve(id, remarks, actor) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    if (!['SUBMITTED', 'UNDER_REVIEW'].includes(card.status)) {
      throw ApiError.businessRule('INVALID_STATE_FOR_APPROVE', `Only a SUBMITTED score card can be approved (current status: ${card.status}).`);
    }
    await auditableStatusChange({
      scoreCardId: id, applicationId: card.applicationId, newStatus: 'APPROVED',
      actorFields: { approved_by: actor.id, approved_at: new Date(), reviewed_by: actor.id, reviewed_at: new Date(), remarks: remarks || card.remarks },
      actor, action: 'APPROVE', detail: remarks || 'Approved', changeReason: 'APPROVE'
    });
    return this.getById(id);
  },

  async reject(id, rejectionReason, actor) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    if (!['SUBMITTED', 'UNDER_REVIEW'].includes(card.status)) {
      throw ApiError.businessRule('INVALID_STATE_FOR_REJECT', `Only a SUBMITTED score card can be rejected (current status: ${card.status}).`);
    }
    await auditableStatusChange({
      scoreCardId: id, applicationId: card.applicationId, newStatus: 'REJECTED',
      actorFields: { rejected_by: actor.id, rejected_at: new Date(), reviewed_by: actor.id, reviewed_at: new Date(), rejection_reason: rejectionReason },
      actor, action: 'REJECT', detail: rejectionReason, changeReason: 'REJECT'
    });
    return this.getById(id);
  },

  /** Recomputes scores from current inputs without any status change — e.g. after a late bureau update. */
  async recalculate(id, actor) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    if (['APPROVED', 'REJECTED'].includes(card.status)) {
      throw ApiError.businessRule('INVALID_STATE_FOR_RECALCULATE', `Cannot recalculate a score card that is already ${card.status}.`);
    }
    const before = await this.getById(id);
    const { computed } = await buildComputedForCard(id);
    await repository.applyComputedScores(id, computed);

    const version = await repository.nextVersion(id);
    const snapshot = await repository.findById(id);
    await repository.insertVersionSnapshot({ scoreCardId: id, version, status: snapshot.status, snapshot, changeReason: 'RECALCULATE', changedBy: actor.id });
    await repository.insertAuditLog({
      scoreCardId: id, applicationId: card.applicationId, actorUserId: actor.id, actorRole: actor.role,
      actorLabel: actor.label, action: 'RECALCULATE', detail: 'Score recalculated',
      oldValue: before.scores, newValue: computed, ipAddress: actor.ip, userAgent: actor.userAgent
    });
    return this.getById(id);
  },

  async remove(id, actor) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    if (card.status !== 'DRAFT') {
      throw ApiError.businessRule('INVALID_STATE_FOR_DELETE', `Only a DRAFT score card can be deleted (current status: ${card.status}). Reject it instead if it has been submitted.`);
    }
    await repository.softDelete(id, actor.id);
    await repository.insertAuditLog({
      scoreCardId: id, applicationId: card.applicationId, actorUserId: actor.id, actorRole: actor.role,
      actorLabel: actor.label, action: 'DELETE', detail: 'Score card soft-deleted', ipAddress: actor.ip, userAgent: actor.userAgent
    });
  },

  async getSummary(id) {
    const card = await this.getById(id);
    return {
      applicationId: card.applicationId,
      status: card.status,
      segment: card.segment,
      finalWeightedScore: card.scores.finalWeightedScore,
      riskGrade: card.scores.riskGrade,
      riskLabel: card.scores.riskLabel,
      decisionText: card.scores.decisionText,
      readyToSubmit: card.documentsComplete && card.securityCoversLiability && card.cibilComplete,
      guardStatus: {
        documentsComplete: card.documentsComplete,
        securityCoversLiability: card.securityCoversLiability,
        cibilComplete: card.cibilComplete
      }
    };
  },

  async getHistory(id, listQuery) {
    const card = await repository.findById(id, { includeDeleted: true });
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    return repository.getHistory(id, listQuery);
  },

  async getAuditLogs(id, listQuery) {
    const card = await repository.findById(id, { includeDeleted: true });
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    return repository.getAuditLogs(id, listQuery);
  },

  async uploadDocument(id, doc, actor) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    const saved = await repository.insertDocument({ scoreCardId: id, ...doc, uploadedBy: actor.id });
    await repository.insertAuditLog({
      scoreCardId: id, applicationId: card.applicationId, actorUserId: actor.id, actorRole: actor.role,
      actorLabel: actor.label, action: 'DOC_UPLOAD', detail: `Uploaded ${doc.documentType}: ${doc.fileName}`,
      ipAddress: actor.ip, userAgent: actor.userAgent
    });
    return saved;
  },

  async getDocuments(id) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    return repository.getDocuments(id);
  }
};

module.exports = service;
