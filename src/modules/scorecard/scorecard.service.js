'use strict';

const repository = require('./scorecard.repository');
const { loadParameterDefs } = require('./parameterDefs.repository');
const { computeCreditScore, hasCibilResponse } = require('./creditScoreEngine');
const { prepareSecurity } = require('./securityValuation');
const ApiError = require('../../utils/ApiError');
const { withTransaction } = require('../../config/db');

/**
 * Computes freeValue/valueLoaded server-side for every security per the FRD's
 * Accepted Value Formula (securityValuation.js) — a client-supplied valueLoaded is
 * never trusted or persisted directly.
 */
function prepareSecurities(securities) {
  return (securities || []).map(prepareSecurity);
}

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

/** parameterDefs are the same for every person sharing a profileType within one request — load once, reuse. */
async function loadParameterDefsCached(cache, profileType) {
  if (!cache.has(profileType)) {
    cache.set(profileType, await loadParameterDefs(profileType));
  }
  return cache.get(profileType);
}

/**
 * Scores one person's raw responses ({parameterId, selectedOptionId|qualitativeFlag})
 * against their profile's parameter definitions, and returns the persistable shape:
 * name/profileType + totalScore/totalFinalScore + the answered responses with netScore.
 * QUALITATIVE parameters are always persisted (they default to un-flagged/0 unless
 * answered); unanswered QUANTITATIVE parameters are left out entirely — that's what
 * makes a partially-filled Credit Score sheet representable as a draft.
 */
async function computePerson(cache, person) {
  const defs = await loadParameterDefsCached(cache, person.profileType);
  const { totalScore, totalFinalScore, results } = computeCreditScore(defs, person.responses || []);
  return {
    name: person.name,
    profileType: person.profileType,
    totalScore,
    totalFinalScore,
    responses: results
      .filter((r) => r.category === 'QUALITATIVE' || r.answered)
      .map((r) => ({
        parameterId: r.parameterId,
        selectedOptionId: r.selectedOptionId ?? null,
        qualitativeFlag: r.qualitativeFlag ?? null,
        netScore: r.netScore
      }))
  };
}

/** Re-scores a person from their already-persisted responses (used by validate/recalculate). */
async function recomputeFromStoredResponses(cache, person) {
  const rawResponses = (person.responses || []).map((r) => ({
    parameterId: r.parameterId,
    selectedOptionId: r.selectedOptionId,
    qualitativeFlag: r.qualitativeFlag
  }));
  return computePerson(cache, { name: person.name, profileType: person.profileType, responses: rawResponses });
}

/** True once the subscriber and every guarantor has answered their profile's CIBIL Score parameter. */
async function isCibilComplete(cache, subscriber, guarantors) {
  const subscriberDefs = await loadParameterDefsCached(cache, subscriber.profileType);
  if (!hasCibilResponse(subscriberDefs, subscriber.responses || [])) return false;
  for (const g of guarantors || []) {
    const gDefs = await loadParameterDefsCached(cache, g.profileType);
    if (!hasCibilResponse(gDefs, g.responses || [])) return false;
  }
  return true;
}

/**
 * Security/liability guards — independent of the Credit Score matrix (the Excel
 * defines no formula for these; they mirror the pre-existing FRD Section 6.2 rule).
 */
function computeSecurityGuards(securities, futureLiability, documentsComplete) {
  const securityTotalValue = (securities || []).reduce((sum, s) => sum + (s.valueLoaded || 0), 0);
  return {
    securityTotalValue,
    securityCoversLiability: securityTotalValue >= (futureLiability || 0),
    documentsComplete: !!documentsComplete
  };
}

/** Re-derives every computed value for a card from its currently-persisted state (validate/recalculate). */
async function buildComputedForCard(scoreCardId) {
  const [persons, securities, card] = await Promise.all([
    repository.getPersons(scoreCardId),
    repository.getSecurities(scoreCardId),
    repository.findById(scoreCardId)
  ]);
  const cache = new Map();
  const recomputed = [];
  for (const p of persons) {
    recomputed.push({ ...(await recomputeFromStoredResponses(cache, p)), role: p.role });
  }
  const subscriber = recomputed.find((p) => p.role === 'SB');
  const guarantors = recomputed.filter((p) => p.role !== 'SB');
  const cibilComplete = await isCibilComplete(cache, subscriber, guarantors);
  const guards = computeSecurityGuards(securities, card.futureLiability, card.documentsComplete);
  return { card, subscriber, guarantors, securities, cibilComplete, ...guards };
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

    const cache = new Map();
    const subscriber = await computePerson(cache, input.subscriber);
    const guarantors = await Promise.all((input.guarantors || []).map((g) => computePerson(cache, g)));
    const securities = prepareSecurities(input.securities);
    const cibilComplete = await isCibilComplete(cache, subscriber, guarantors);
    const guards = computeSecurityGuards(securities, input.futureLiability, input.documentsComplete);

    const id = await repository.create({
      applicationId: input.applicationId,
      chitValue: input.chitValue,
      futureLiability: input.futureLiability,
      documentsComplete: guards.documentsComplete,
      securityTotalValue: guards.securityTotalValue,
      securityCoversLiability: guards.securityCoversLiability,
      cibilComplete,
      subscriber,
      guarantors,
      securities,
      createdBy: actor.id
    });

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

  /** PUT — full business update; recomputes scores but does not change status (except VALIDATED/REJECTED -> DRAFT). */
  async update(id, patch, actor) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    assertCanEdit(card);

    const oldValue = await this.getById(id);

    await withTransaction(async (client) => {
      await repository.update(id, patch, client);

      const cache = new Map();
      const subscriber = patch.subscriber ? await computePerson(cache, patch.subscriber) : oldValue.subscriber;
      const guarantors = patch.guarantors
        ? await Promise.all(patch.guarantors.map((g) => computePerson(cache, g)))
        : oldValue.guarantors;
      const securities = patch.securities ? prepareSecurities(patch.securities) : oldValue.securities;

      if (patch.subscriber || patch.guarantors || patch.securities) {
        await repository.replacePersonsAndSecurities(id, { subscriber, guarantors, securities }, client);
      }

      const cibilComplete = await isCibilComplete(cache, subscriber, guarantors);
      const guards = computeSecurityGuards(
        securities,
        patch.futureLiability !== undefined ? patch.futureLiability : card.futureLiability,
        patch.documentsComplete !== undefined ? patch.documentsComplete : card.documentsComplete
      );
      await repository.applyComputedScores(id, { ...guards, cibilComplete }, client);

      // Any edit to an already-VALIDATED/REJECTED card invalidates it — must be re-validated before submit.
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
      const cache = new Map();
      const subscriber = patch.subscriber ? await computePerson(cache, patch.subscriber) : current.subscriber;
      const guarantors = patch.guarantors
        ? await Promise.all(patch.guarantors.map((g) => computePerson(cache, g)))
        : current.guarantors;
      const securities = patch.securities ? prepareSecurities(patch.securities) : current.securities;
      await repository.replacePersonsAndSecurities(id, { subscriber, guarantors, securities }, null);

      const cibilComplete = await isCibilComplete(cache, subscriber, guarantors);
      const guards = computeSecurityGuards(
        securities,
        patch.futureLiability !== undefined ? patch.futureLiability : card.futureLiability,
        patch.documentsComplete !== undefined ? patch.documentsComplete : card.documentsComplete
      );
      await repository.applyComputedScores(id, { ...guards, cibilComplete }, null);
    }

    await repository.insertAuditLog({
      scoreCardId: id, applicationId: card.applicationId, actorUserId: actor.id, actorRole: actor.role,
      actorLabel: actor.label, action: 'SAVE_DRAFT', detail: 'Draft saved', ipAddress: actor.ip, userAgent: actor.userAgent
    });
    return this.getById(id);
  },

  /**
   * Recomputes every person's score and evaluates the three submit guards
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

    const { subscriber, guarantors, cibilComplete, securityTotalValue, securityCoversLiability, documentsComplete } = await buildComputedForCard(id);
    await withTransaction(async (client) => {
      await repository.replacePersons(id, { subscriber, guarantors }, client);
      await repository.applyComputedScores(id, { securityTotalValue, securityCoversLiability, cibilComplete }, client);
    });

    const failedGuards = [];
    if (!documentsComplete) failedGuards.push({ guard: 'documentsComplete', message: 'Mandatory documents (incl. DPN) are still pending upload.' });
    if (!securityCoversLiability) failedGuards.push({ guard: 'securityCoversLiability', message: 'Accepted security value is below the Future Liability.' });
    if (!cibilComplete) failedGuards.push({ guard: 'cibilComplete', message: 'CIBIL Score is mandatory for the subscriber and every guarantor.' });

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

  /** Recomputes scores from current inputs without any status change — e.g. after a parameter-master correction. */
  async recalculate(id, actor) {
    const card = await repository.findById(id);
    if (!card) throw ApiError.notFound(`Score card ${id} not found.`);
    if (['APPROVED', 'REJECTED'].includes(card.status)) {
      throw ApiError.businessRule('INVALID_STATE_FOR_RECALCULATE', `Cannot recalculate a score card that is already ${card.status}.`);
    }
    const before = await this.getById(id);
    const { subscriber, guarantors, cibilComplete, securityTotalValue, securityCoversLiability } = await buildComputedForCard(id);
    await withTransaction(async (client) => {
      await repository.replacePersons(id, { subscriber, guarantors }, client);
      await repository.applyComputedScores(id, { securityTotalValue, securityCoversLiability, cibilComplete }, client);
    });

    const version = await repository.nextVersion(id);
    const snapshot = await repository.findById(id);
    await repository.insertVersionSnapshot({ scoreCardId: id, version, status: snapshot.status, snapshot, changeReason: 'RECALCULATE', changedBy: actor.id });
    await repository.insertAuditLog({
      scoreCardId: id, applicationId: card.applicationId, actorUserId: actor.id, actorRole: actor.role,
      actorLabel: actor.label, action: 'RECALCULATE', detail: 'Score recalculated',
      oldValue: { subscriber: before.subscriber, guarantors: before.guarantors },
      newValue: { subscriber, guarantors },
      ipAddress: actor.ip, userAgent: actor.userAgent
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
    const personSummary = (p) => p && {
      id: p.id, role: p.role, name: p.name, profileType: p.profileType,
      totalScore: p.totalScore, totalFinalScore: p.totalFinalScore
    };
    return {
      applicationId: card.applicationId,
      status: card.status,
      subscriber: personSummary(card.subscriber),
      guarantors: card.guarantors.map(personSummary),
      readyToSubmit: !!card.documentsComplete && !!card.securityCoversLiability && !!card.cibilComplete,
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
