'use strict';

/**
 * Score Card calculation engine — 6-factor model.
 *
 * IMPORTANT — read before changing any band boundary: these point bands are
 * ENGINEERING DEFAULTS proposed pending the Client's confirmation. Unlike
 * securityValuation.js (grounded in the signed-off FRD Section 6.1), no document
 * defines this model's exact bands at the time this file was written — they are a
 * reasonable, standard-practice placeholder built from a single reference example
 * (CIBIL 748 -> 15/20 checks out exactly against a linear 300-900 scale; the other
 * five factors' bands are this engine's best-judgement default). See
 * DOCUMENTATION.md Section 6 "Assumptions" for the full list of what still needs
 * Credit Policy sign-off.
 *
 * All inputs to every factor here are meant to be SYSTEM-SOURCED — fetched from the
 * bureau (CIBIL) report or carried over from earlier application-intake steps — not
 * typed in manually by the user at the Score Card step itself.
 *
 * Factors (sum to 100):
 *   1. CIBIL Score            (max 20) - linear scale across the 300-900 CIBIL range
 *   2. Income-EMI Coverage    (max 20) - FOIR band: (existing obligations + proposed EMI) / gross income
 *   3. Security Coverage/LTV  (max 15) - accepted security value vs. proposed loan amount
 *   4. DPD History            (max 20) - worst days-past-due in the bureau report
 *   5. Enquiry Count          (max 15) - hard enquiries in the last 6 months (bureau report)
 *   6. Guarantor Quality      (max 10) - guarantor CIBIL + income adequacy; neutral 10 if no guarantor
 *
 * Decision: total >= 75 -> Eligible for Approval; 60-74 -> Conditional - Manual
 * Review Required; < 60 -> Not Eligible.
 */

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 1. CIBIL Score, max 20 — linear scale across the 300-900 bureau score range. */
function cibilFactorScore(cibilScore) {
  if (cibilScore == null) return 0;
  return round2(clamp(((cibilScore - 300) / 600) * 20, 0, 20));
}

/** 2. Income-EMI Coverage, max 20 — FOIR band ((existing obligations + proposed EMI) / gross income). */
function incomeEmiCoverageScore(grossMonthlyIncome, existingObligations, proposedEmi) {
  if (!grossMonthlyIncome) return 0;
  const foirPct = (((existingObligations || 0) + (proposedEmi || 0)) / grossMonthlyIncome) * 100;
  if (foirPct < 30) return 20;
  if (foirPct < 45) return 15;
  if (foirPct < 60) return 10;
  if (foirPct < 75) return 7.5;
  if (foirPct < 95) return 5;
  return 0;
}

/** 3. Security Coverage / LTV, max 15 — accepted security value vs. proposed loan amount. */
function securityCoverageScore(acceptedSecurityValue, loanAmount) {
  if (!loanAmount) return 0;
  const ratio = acceptedSecurityValue / loanAmount;
  if (ratio >= 1.25) return 15;
  if (ratio >= 1.0) return 12;
  if (ratio >= 0.8) return 9;
  if (ratio >= 0.6) return 6;
  if (ratio >= 0.4) return 3;
  return 0;
}

/** 4. DPD History, max 20 — worst days-past-due across the bureau history. Clean (0/null) = max. */
function dpdHistoryScore(worstDpdDays) {
  if (worstDpdDays == null || worstDpdDays <= 0) return 20;
  if (worstDpdDays <= 29) return 14;
  if (worstDpdDays <= 59) return 8;
  if (worstDpdDays <= 89) return 4;
  return 0;
}

/** 5. Enquiry Count, max 15 — hard enquiries in the last 6 months. */
function enquiryCountScore(enquiryCount6Months) {
  const n = enquiryCount6Months || 0;
  if (n === 0) return 15;
  if (n <= 2) return 12;
  if (n <= 4) return 8;
  if (n <= 6) return 4;
  return 0;
}

/**
 * 6. Guarantor Quality, max 10 — composite of guarantor CIBIL (max 6) and income
 * adequacy relative to the proposed EMI (max 4). No guarantor present/required ->
 * neutral full marks (10), since a guarantor is conditional, not mandatory, per the
 * FRD's Section 6.2 eligibility rule.
 */
function guarantorQualityScore(guarantor, proposedEmi) {
  if (!guarantor) return 10;
  const cibilComponent = guarantor.creditScore != null ? clamp(((guarantor.creditScore - 300) / 600) * 6, 0, 6) : 0;
  const emi = proposedEmi || 0;
  const incomeRatio = emi > 0 ? (guarantor.monthlyIncome || guarantor.grossIncome || 0) / emi : 0;
  let incomeComponent;
  if (incomeRatio >= 1.5) incomeComponent = 4;
  else if (incomeRatio >= 1.0) incomeComponent = 3;
  else if (incomeRatio >= 0.5) incomeComponent = 2;
  else incomeComponent = 0;
  return round2(cibilComponent + incomeComponent);
}

function decisionFor(totalScore) {
  if (totalScore >= 75) return { eligible: true, decisionText: 'Eligible for Approval' };
  if (totalScore >= 60) return { eligible: false, decisionText: 'Conditional - Manual Review Required' };
  return { eligible: false, decisionText: 'Not Eligible' };
}

/**
 * Computes the full Score Card result for a case.
 *
 * @param {object} input
 * @param {object} input.subscriber          - person fields; creditScore/worstDpdDays/enquiryCount6Months are bureau-fetched
 * @param {object[]} input.guarantors        - only the first guarantor feeds Guarantor Quality (see Assumptions)
 * @param {object[]} input.securities        - array of { securityType, valueLoaded, ... }
 * @param {number} input.chitValue           - treated as the proposed loan amount for Security Coverage
 * @param {number} input.futureLiability     - used for the securityCoversLiability guard
 * @param {boolean} input.documentsComplete
 * @param {number} input.grossMonthlyIncome  - subscriber's gross monthly income (Income-EMI Coverage input)
 * @param {number} input.existingObligations - subscriber's existing monthly EMI/obligations
 * @param {number} input.proposedEmi         - this loan's proposed monthly instalment
 */
function computeScoreCard(input) {
  const {
    subscriber = {}, guarantors = [], securities = [],
    chitValue = 0, futureLiability = 0, documentsComplete = false,
    grossMonthlyIncome = 0, existingObligations = 0, proposedEmi = 0
  } = input;

  const securityTotalValue = (securities || []).reduce((sum, s) => sum + (s.valueLoaded || s.value_loaded || 0), 0);
  const loanAmount = chitValue;

  const cibilScore = cibilFactorScore(subscriber.creditScore);
  const incomeEmi = incomeEmiCoverageScore(grossMonthlyIncome, existingObligations, proposedEmi);
  const securityCoverage = securityCoverageScore(securityTotalValue, loanAmount);
  const dpdHistory = dpdHistoryScore(subscriber.worstDpdDays);
  const enquiryCount = enquiryCountScore(subscriber.enquiryCount6Months);
  const primaryGuarantor = guarantors[0] || null;
  const guarantorQuality = guarantorQualityScore(primaryGuarantor, proposedEmi);

  const totalScore = round2(cibilScore + incomeEmi + securityCoverage + dpdHistory + enquiryCount + guarantorQuality);
  const { eligible, decisionText } = decisionFor(totalScore);

  const securityCoversLiability = securityTotalValue >= (futureLiability || 0);
  const cibilComplete = subscriber.creditScore != null && guarantors.every((g) => g.creditScore != null);

  return {
    factors: {
      cibilScore: { score: cibilScore, max: 20 },
      incomeEmiCoverage: { score: incomeEmi, max: 20 },
      securityCoverage: { score: securityCoverage, max: 15 },
      dpdHistory: { score: dpdHistory, max: 20 },
      enquiryCount: { score: enquiryCount, max: 15 },
      guarantorQuality: { score: guarantorQuality, max: 10 }
    },
    totalScore,
    eligible,
    decisionText,
    securityTotalValue,
    securityCoversLiability,
    documentsComplete: !!documentsComplete,
    cibilComplete,
    // The three guards that gate SUBMIT — mirrors workflow-engine.js's
    // BRANCH_WIP -> SCRUTINY_PENDING guard array in the rest of MCF LOS.
    readyToSubmit: !!documentsComplete && securityCoversLiability && cibilComplete
  };
}

module.exports = {
  cibilFactorScore,
  incomeEmiCoverageScore,
  securityCoverageScore,
  dpdHistoryScore,
  enquiryCountScore,
  guarantorQualityScore,
  decisionFor,
  computeScoreCard
};
