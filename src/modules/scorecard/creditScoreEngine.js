'use strict';

/**
 * Credit Score calculation engine — every parameter, option, weightage and
 * max-score value is loaded from the database (seeded verbatim from
 * "Credit Score.xlsx" — see db/seed_credit_score.sql and DOCUMENTATION.md
 * Section 19, Excel-to-Application Mapping). There are NO hardcoded scoring
 * values in this file; it is a pure calculator over whatever parameter
 * definitions and responses it is given.
 *
 * Model (mirrors the Excel exactly):
 *   - Each profile (SALARIED / BUSINESS) has its own independent set of
 *     parameters — no parameter is shared or blended across profiles.
 *   - Each QUANTITATIVE parameter is answered by selecting exactly one option
 *     from its fixed dropdown list. netScore = parameter.maxScore x option.weightage.
 *   - Each QUALITATIVE parameter is a yes/no flag with a fixed penalty.
 *     netScore = parameter.maxScore (already negative) x flag(0/1).
 *   - totalScore = sum of all QUANTITATIVE net scores (the Excel's "Total Score",
 *     which sums to 100 when every parameter is answered, since the max scores
 *     themselves sum to 100 for both profiles).
 *   - totalFinalScore = totalScore + sum of all QUALITATIVE net scores (the
 *     Excel's "Total Final Score").
 *   - This calculation is done ONCE PER PERSON (subscriber, or each guarantor
 *     independently) — the Excel has no cross-person blending formula.
 *
 * The Excel defines NO eligibility/pass-fail threshold on the Total Final
 * Score — it only computes the number. None is invented here either; see
 * DOCUMENTATION.md Section 20 "Open Questions".
 */

const ApiError = require('../../utils/ApiError');

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {object[]} parameterDefs - every parameter for this person's profile, each:
 *   { id, category: 'QUANTITATIVE'|'QUALITATIVE', maxScore, options: [{id, weightage}] }
 *   (options is only populated for QUANTITATIVE parameters)
 * @param {object[]} responses - the person's answers:
 *   [{ parameterId, selectedOptionId }] for QUANTITATIVE
 *   [{ parameterId, qualitativeFlag }] for QUALITATIVE
 * @returns {{ totalScore: number, totalFinalScore: number, totalPenalty: number, results: object[] }}
 */
function computeCreditScore(parameterDefs, responses) {
  const responseByParam = new Map(responses.map((r) => [String(r.parameterId), r]));

  let totalScore = 0;
  let totalPenalty = 0;
  const results = [];

  for (const param of parameterDefs) {
    const response = responseByParam.get(String(param.id));

    if (param.category === 'QUANTITATIVE') {
      if (!response || response.selectedOptionId == null) {
        results.push({ parameterId: param.id, category: param.category, netScore: 0, selectedOptionId: null, answered: false });
        continue;
      }
      const option = (param.options || []).find((o) => String(o.id) === String(response.selectedOptionId));
      if (!option) {
        throw ApiError.validation([{
          field: `responses.${param.id}`,
          message: `selectedOptionId ${response.selectedOptionId} does not belong to parameter "${param.name}".`
        }]);
      }
      const net = round2(param.maxScore * option.weightage);
      totalScore += net;
      results.push({ parameterId: param.id, category: param.category, netScore: net, selectedOptionId: option.id, answered: true });
    } else {
      const flagged = !!(response && response.qualitativeFlag);
      const net = flagged ? param.maxScore : 0; // maxScore is already negative for QUALITATIVE
      totalPenalty += net;
      results.push({ parameterId: param.id, category: param.category, netScore: net, qualitativeFlag: flagged, answered: true });
    }
  }

  totalScore = round2(totalScore);
  totalPenalty = round2(totalPenalty);
  const totalFinalScore = round2(totalScore + totalPenalty);

  return { totalScore, totalPenalty, totalFinalScore, results };
}

/** True once every QUANTITATIVE parameter for this profile has an answer — used by the cibilComplete-style submit guard. */
function isFullyAnswered(parameterDefs, responses) {
  const responseByParam = new Map(responses.map((r) => [String(r.parameterId), r]));
  return parameterDefs
    .filter((p) => p.category === 'QUANTITATIVE')
    .every((p) => {
      const r = responseByParam.get(String(p.id));
      return r && r.selectedOptionId != null;
    });
}

/** True once the CIBIL Score parameter specifically has an answer (mirrors the old cibilComplete guard). */
function hasCibilResponse(parameterDefs, responses) {
  const cibilParam = parameterDefs.find((p) => p.category === 'QUANTITATIVE' && /cibil/i.test(p.name));
  if (!cibilParam) return true; // defensive: if no CIBIL parameter exists for this profile, don't block on it
  const response = responses.find((r) => String(r.parameterId) === String(cibilParam.id));
  return !!(response && response.selectedOptionId != null);
}

module.exports = { computeCreditScore, isFullyAnswered, hasCibilResponse };
