'use strict';

/**
 * Score Card calculation engine.
 *
 * This is a faithful, framework-agnostic port of the existing MCF LOS client-side
 * `CamEngine` scoring logic (assets/js/cam-engine.js), which itself implements
 * "Annexure 2: Risk-Assessment Scoring Engine" exactly. Kept as a pure module with
 * no DB/HTTP dependency so it can be unit-tested in isolation and re-used by both
 * the API layer and any future batch/offline recompute job.
 *
 * Do not change these formulas without a corresponding, signed-off change to the
 * Risk Assessment Annexure — see DOCUMENTATION.md Section 6 for the full reference.
 */

const CAM_SCORE_BANDS = [
  { min: 70, max: 100, grade: 'A', label: 'Low Risk', decision: 'Auto approval' },
  { min: 51, max: 69, grade: 'B', label: 'Moderate Risk', decision: 'Approve with Conditions' },
  { min: 40, max: 50, grade: 'C', label: 'High Risk', decision: 'Strong Justification Required' },
  { min: -100, max: 39, grade: 'D', label: 'Reject', decision: 'Not Recommended' }
];

// Section 2 of the Annexure: which security types count as tangible "Secured" collateral.
// Mortgage and Personal Surety carry no bankable collateral value, so a case backed only
// by those is scored as Unsecured even though a security row exists.
const SECURED_SECURITY_TYPES = [
  'Gold Ornaments', 'LIC Policy', 'Bank Guarantee', 'Fixed Deposit',
  'Chit Passbook', 'Sub-Debt', 'Demat NCD', 'Demat Shares'
];

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** True if any offered security type is in the tangible-collateral list. */
function isSecuredCase(securities) {
  const types = (securities || []).map((s) => s.securityType || s.security_type);
  if (!types.length) return false;
  return types.some((t) => SECURED_SECURITY_TYPES.indexOf(t) !== -1);
}

/**
 * Section 3 — Applicability Matrix (Security Type x Chit Value Range).
 * Determines the segment (secured/unsecured x value bucket) and, from that,
 * which KYC scoring method (simple/moderate/comprehensive) applies.
 */
function determineSegment(securities, chitValue) {
  const secured = isSecuredCase(securities);
  const value = chitValue || 0;

  if (secured) {
    return value <= 1000000
      ? { category: 'secured', bucket: '<=10L', label: 'Secured <=10L', method: 'simple' }
      : { category: 'secured', bucket: '>10L', label: 'Secured >10L', method: 'moderate' };
  }
  if (value <= 800000) return { category: 'unsecured', bucket: '<=8L', label: 'Unsecured <=8L', method: 'comprehensive' };
  if (value <= 2500000) return { category: 'unsecured', bucket: '8L-25L', label: 'Unsecured <=25L', method: 'comprehensive' };
  return { category: 'unsecured', bucket: '>25L', label: 'Unsecured >25L', method: 'comprehensive' };
}

/** 4.b — FOIR band, max 30 (Moderate KYC). */
function foirScoreModerate(foir) {
  const pct = (foir || 0) * 100;
  if (pct < 30) return 30;
  if (pct < 45) return 20;
  if (pct < 60) return 15;
  if (pct < 75) return 10;
  if (pct < 95) return 5;
  return 0;
}

/** 4.c.iv — FOIR band, max 40 (Comprehensive KYC). */
function foirScoreComprehensive(foir) {
  const pct = (foir || 0) * 100;
  if (pct < 30) return 40;
  if (pct < 45) return 30;
  if (pct < 60) return 20;
  if (pct < 75) return 15;
  if (pct < 95) return 10;
  return 0;
}

/** 4.c.i — Profile Strength, max 20. Salaried table or business/self-employed table. */
function profileStrengthScore(p) {
  const et = (p.employmentType || '').toLowerCase();
  if (et.includes('govt') || et.includes('psu')) return 20;

  if (et.includes('salaried')) {
    if (p.employeeCount != null) {
      if (p.employeeCount > 100 && (p.yearsInJob || 0) >= 3) return 16;
      if (p.employeeCount >= 20) return 12;
      return 8;
    }
    return 12; // reputed-corporate default when detailed employer size isn't captured
  }

  if (et.includes('business') || et.includes('self employed') || et.includes('professional')) {
    if (p.entityType === 'PvtLtd') return (p.yearsInBusiness || 0) >= 5 ? 20 : 17;
    if (p.entityType === 'Partnership') return (p.staffCount || 0) > 20 ? 18 : 14;
    if (p.entityType === 'Proprietorship') return (p.staffCount || 0) > 10 ? 15 : 10;
    return 8; // small/informal default when entity detail isn't captured
  }

  return 4; // unorganized / daily wage / agriculture / other
}

/** 4.c.ii — Relationship / Vintage / Visit Quality, max 5 (take the higher of the two). */
function vintageVisitScore(p) {
  const years = p.customerVintageYears;
  const vintageScore = years > 3 ? 5 : years >= 1 ? 3 : 1;
  const visits = p.personalVisits || 0;
  const visitScore = visits >= 3 ? 5 : visits >= 1 ? 3 : 0;
  return Math.max(vintageScore, visitScore);
}

/** 4.c.iii — Income & Stability, max 5, with a Govt/PSU permanent override to 5. */
function incomeStabilityScore(p) {
  const years = p.yearsOfService != null ? p.yearsOfService : p.yearsInBusiness != null ? p.yearsInBusiness : 2;
  let score = years > 7 ? 5 : years >= 2 ? 3 : 2;
  const et = (p.employmentType || '').toLowerCase();
  if ((et.includes('govt') || et.includes('psu')) && p.permanentGovt !== false) score = 5;
  return score;
}

/** 4.c.v — Asset & Net Worth Strength, max 30. Property must be worth > 2x the chit value. */
function assetNetWorthScore(p, chitValue) {
  const count = p.propertyCount != null ? p.propertyCount : 0;
  const value = p.propertyValue != null ? p.propertyValue : 0;
  const qualifies = chitValue > 0 && value >= 2 * chitValue;
  if (count >= 2 && qualifies) return 30;
  if (count >= 1 && qualifies) return 20;
  return 0;
}

function positiveScore(p, segment, chitValue) {
  if (segment.method === 'simple') return 100;
  if (segment.method === 'moderate') return 70 + foirScoreModerate(p.foir);
  return (
    profileStrengthScore(p) +
    vintageVisitScore(p) +
    incomeStabilityScore(p) +
    foirScoreComprehensive(p.foir) +
    assetNetWorthScore(p, chitValue)
  );
}

/** Negative Scoring Reference Table — capped at -150 total. */
function negativeScore(p, segment) {
  let neg = 0;
  if (p.suitFiled) neg += 100;
  const isSecuredLE10L = segment.category === 'secured' && segment.bucket === '<=10L';
  const isSecuredAny = segment.category === 'secured';
  if (p.prlFlag && !isSecuredLE10L) neg += 30;
  if (p.cc3Flag && !isSecuredAny) neg += 10;
  if ((p.chequeBounceCount || 0) > 2 && !isSecuredAny) neg += 10;
  return Math.min(neg, 150);
}

/** Full positive/negative/final score for one person (subscriber or a guarantor). */
function personScore(p, segment, chitValue) {
  if (!p) return { positive: 0, negative: 0, final: 0 };
  const positive = positiveScore(p, segment, chitValue);
  const negative = negativeScore(p, segment);
  const final = clamp(positive - negative, 0, 100);
  return { positive: round2(positive), negative, final: round2(final) };
}

function gradeFor(score) {
  return CAM_SCORE_BANDS.find((b) => score >= b.min && score <= b.max) || CAM_SCORE_BANDS[CAM_SCORE_BANDS.length - 1];
}

/**
 * Compute the complete score card result for a case.
 *
 * @param {object} input
 * @param {object} input.subscriber          - person fields for the SB (see schema score_card_persons)
 * @param {object[]} input.guarantors        - array of guarantor person objects
 * @param {object[]} input.securities        - array of { securityType, valueLoaded, freeValue, ... }
 * @param {number} input.chitValue           - chit/prize amount used for segmentation & asset test
 * @param {number} input.futureLiability     - used for the securityCoversLiability guard
 * @param {boolean} input.documentsComplete  - mandatory-document checklist flag
 */
function computeScoreCard(input) {
  const { subscriber = {}, guarantors = [], securities = [], chitValue = 0, futureLiability = 0, documentsComplete = false } = input;

  const segment = determineSegment(securities, chitValue);

  const sbScore = personScore(subscriber, segment, chitValue);
  const gScores = guarantors.map((g) => personScore(g, segment, chitValue));
  const avgGuarantorScore = gScores.length ? gScores.reduce((s, g) => s + g.final, 0) / gScores.length : 0;

  const finalWeightedScore = gScores.length ? round2(sbScore.final * 0.6 + avgGuarantorScore * 0.4) : sbScore.final;

  const band = gradeFor(finalWeightedScore);

  const securityTotalValue = (securities || []).reduce((sum, s) => sum + (s.valueLoaded || s.value_loaded || 0), 0);
  const securityCoversLiability = securityTotalValue >= (futureLiability || 0);

  const cibilComplete = subscriber.creditScore != null && guarantors.every((g) => g.creditScore != null);

  return {
    segment,
    sb: sbScore,
    guarantors: gScores,
    avgGuarantorScore: round2(avgGuarantorScore),
    sbWeightage: 0.6,
    guarantorWeightage: 0.4,
    finalWeightedScore,
    riskGrade: band.grade,
    riskLabel: band.label,
    decisionText: band.decision,
    securityTotalValue,
    securityCoversLiability,
    documentsComplete: !!documentsComplete,
    cibilComplete,
    // The three guards that gate SUBMIT — mirrors workflow-engine.js's
    // BRANCH_WIP -> SCRUTINY_PENDING guard array exactly.
    readyToSubmit: !!documentsComplete && securityCoversLiability && cibilComplete
  };
}

module.exports = {
  CAM_SCORE_BANDS,
  SECURED_SECURITY_TYPES,
  isSecuredCase,
  determineSegment,
  foirScoreModerate,
  foirScoreComprehensive,
  profileStrengthScore,
  vintageVisitScore,
  incomeStabilityScore,
  assetNetWorthScore,
  positiveScore,
  negativeScore,
  personScore,
  gradeFor,
  computeScoreCard
};
