'use strict';

const { computeCreditScore, isFullyAnswered, hasCibilResponse } = require('../src/modules/scorecard/creditScoreEngine');
const ApiError = require('../src/utils/ApiError');

/**
 * Builds parameterDefs (with synthetic-but-stable numeric ids) from a compact
 * spec shaped exactly like db/seed_credit_score.sql's source data (Credit
 * Score.xlsx). Quantitative parameters get ids 1..N in array order; each
 * option gets a 100*paramIndex+optionIndex id. Qualitative parameters get ids
 * 1000+index.
 */
function buildDefs(quantitative, qualitative) {
  const defs = quantitative.map((p, i) => ({
    id: i + 1,
    category: 'QUANTITATIVE',
    name: p.name,
    maxScore: p.maxScore,
    options: p.options.map((o, j) => ({ id: (i + 1) * 100 + j, label: o.label, weightage: o.weightage }))
  }));
  qualitative.forEach((q, i) => {
    defs.push({ id: 1000 + i, category: 'QUALITATIVE', name: q.label, maxScore: q.penaltyScore, options: [] });
  });
  return defs;
}

function optionIdFor(defs, parameterId, label) {
  const param = defs.find((d) => d.id === parameterId);
  const option = param.options.find((o) => o.label === label);
  if (!option) throw new Error(`No option "${label}" on parameter ${parameterId}`);
  return option.id;
}

// The exact SALARIED (Employee) sheet from Credit Score.xlsx — 13 quantitative
// parameters (max scores sum to 100) + 7 qualitative flags. Verified against
// the workbook's own cached VLOOKUP results during extraction (see
// DOCUMENTATION.md Section 19).
const SALARIED_QUANTITATIVE = [
  { name: 'Age', maxScore: 5, options: [{ label: '18 to 25 Years', weightage: 0.7 }, { label: '26 to 30 Years', weightage: 0.8 }, { label: '31 to 40 Years', weightage: 1 }, { label: '41 to 50 Years', weightage: 0.9 }, { label: '51to 55 Years', weightage: 0.7 }, { label: '56 to 60 Years', weightage: 0.3 }, { label: 'Above 60 Years', weightage: 0 }] },
  { name: 'Occupation', maxScore: 8, options: [{ label: 'Employee:  Government', weightage: 1 }, { label: 'Employee:  Financial Institutions', weightage: 0.7 }, { label: 'Employee:  Proprietary Concern', weightage: 0.1 }] },
  { name: 'Years of Service', maxScore: 5, options: [{ label: 'More than 20 Years', weightage: 0.9 }, { label: '15 to 20 Years', weightage: 1 }, { label: '< 2 Years', weightage: 0.2 }] },
  { name: 'Annual Income', maxScore: 5, options: [{ label: 'Above Rs 25 Lakhs', weightage: 1 }, { label: 'No income', weightage: 0 }] },
  { name: 'Chit Subscription to Net Income', maxScore: 20, options: [{ label: 'More than 5 times', weightage: 1 }, { label: 'More than 2 times', weightage: 0.4 }, { label: 'Less than 1 time', weightage: 0 }] },
  { name: 'Other Income to Total Income', maxScore: 5, options: [{ label: 'Less than 20% of total income', weightage: 1 }, { label: '81% to 100% of total income', weightage: 0.1 }] },
  { name: 'Property Value to Future Liability', maxScore: 10, options: [{ label: 'More than 1000%', weightage: 1 }, { label: '501% 1000%', weightage: 0.8 }, { label: 'Do not own property', weightage: 0 }] },
  { name: 'CIBIL Score', maxScore: 13, options: [{ label: '750 and above', weightage: 1 }, { label: '700 to 749', weightage: 0.8 }, { label: 'Less than 600', weightage: 0 }] },
  { name: 'Unexpired Chit Period', maxScore: 8, options: [{ label: 'Less than 12 months', weightage: 1 }, { label: '25 to 36 months', weightage: 0.6 }, { label: '37 to 48 months', weightage: 0.4 }] },
  { name: 'Track Record of Subscription Payment', maxScore: 8, options: [{ label: 'Always before due date', weightage: 1 }, { label: 'Always on time / on due date', weightage: 0.9 }, { label: 'More than 5 instances of delayed payment of more than 30 days', weightage: 0.2 }] },
  { name: 'Cheque Returns', maxScore: 5, options: [{ label: 'No cheque returns', weightage: 1 }, { label: 'More than Eight cheque Return', weightage: 0 }] },
  { name: 'Mode of Payment', maxScore: 3, options: [{ label: 'in cash', weightage: 0.7 }, { label: 'through NEFT', weightage: 1 }] },
  { name: 'Follow-up Effort', maxScore: 5, options: [{ label: 'Subscription received without follow up', weightage: 1 }, { label: 'Collected by recovery team / MFL staff with follow up', weightage: 0.5 }] }
];
const SALARIED_QUALITATIVE = [
  { code: 'a', label: 'Politically influenced', penaltyScore: -100 },
  { code: 'b', label: 'Constitutional position', penaltyScore: -100 },
  { code: 'c', label: 'Police Department', penaltyScore: -100 },
  { code: 'd', label: 'Lawyer / advocate', penaltyScore: -50 },
  { code: 'e', label: 'Trouble shooter / Litigant', penaltyScore: -80 },
  { code: 'f', label: 'Critical illness', penaltyScore: -50 },
  { code: 'g', label: 'Recently hospitalized', penaltyScore: -50 }
];

describe('creditScoreEngine.computeCreditScore', () => {
  const defs = buildDefs(SALARIED_QUANTITATIVE, SALARIED_QUALITATIVE);

  test('reproduces the Excel-verified example total (76.5) when every parameter is answered as in the workbook', () => {
    const selections = [
      ['41 to 50 Years', 1], ['Employee:  Financial Institutions', 2], ['15 to 20 Years', 3],
      ['Above Rs 25 Lakhs', 4], ['More than 2 times', 5], ['Less than 20% of total income', 6],
      ['501% 1000%', 7], ['700 to 749', 8], ['25 to 36 months', 9],
      ['Always on time / on due date', 10], ['No cheque returns', 11], ['through NEFT', 12],
      ['Subscription received without follow up', 13]
    ];
    const responses = selections.map(([label, paramId]) => ({ parameterId: paramId, selectedOptionId: optionIdFor(defs, paramId, label) }));

    const result = computeCreditScore(defs, responses);
    expect(result.totalScore).toBe(76.5);
    expect(result.totalPenalty).toBe(0); // no qualitative response given -> all default un-flagged
    expect(result.totalFinalScore).toBe(76.5);
  });

  test('lowest-possible option on every parameter yields the minimum achievable total', () => {
    const responses = [
      { parameterId: 1, selectedOptionId: optionIdFor(defs, 1, 'Above 60 Years') }, // weightage 0
      { parameterId: 4, selectedOptionId: optionIdFor(defs, 4, 'No income') } // weightage 0
    ];
    const result = computeCreditScore(defs, responses);
    const ageResult = result.results.find((r) => r.parameterId === 1);
    const incomeResult = result.results.find((r) => r.parameterId === 4);
    expect(ageResult.netScore).toBe(0);
    expect(incomeResult.netScore).toBe(0);
  });

  test('highest-possible option (weightage 1) on a parameter yields exactly its maxScore', () => {
    const responses = [{ parameterId: 8, selectedOptionId: optionIdFor(defs, 8, '750 and above') }];
    const result = computeCreditScore(defs, responses);
    expect(result.results.find((r) => r.parameterId === 8).netScore).toBe(13);
  });

  test('a fractional weightage produces the exact maxScore x weightage net score', () => {
    const responses = [{ parameterId: 6, selectedOptionId: optionIdFor(defs, 6, '81% to 100% of total income') }]; // weightage 0.1
    const result = computeCreditScore(defs, responses);
    expect(result.results.find((r) => r.parameterId === 6).netScore).toBeCloseTo(5 * 0.1, 5);
  });

  test('an unanswered QUANTITATIVE parameter contributes 0 and is marked answered:false (draft state)', () => {
    const result = computeCreditScore(defs, []);
    expect(result.totalScore).toBe(0);
    expect(result.results.every((r) => r.category !== 'QUANTITATIVE' || r.answered === false)).toBe(true);
  });

  test('a flagged QUALITATIVE parameter applies its fixed negative penalty to totalFinalScore only', () => {
    const responses = [
      { parameterId: 1000, qualitativeFlag: true } // "Politically influenced", -100
    ];
    const result = computeCreditScore(defs, responses);
    expect(result.totalScore).toBe(0);
    expect(result.totalPenalty).toBe(-100);
    expect(result.totalFinalScore).toBe(-100);
  });

  test('an un-flagged QUALITATIVE parameter (or omitted) contributes 0 penalty', () => {
    const result = computeCreditScore(defs, [{ parameterId: 1000, qualitativeFlag: false }]);
    expect(result.results.find((r) => r.parameterId === 1000).netScore).toBe(0);
  });

  test('throws ApiError.validation when selectedOptionId does not belong to the given parameter', () => {
    expect(() => computeCreditScore(defs, [{ parameterId: 1, selectedOptionId: 99999 }])).toThrow(ApiError);
  });

  test('rejects an option that belongs to a different parameter (cross-parameter mismatch)', () => {
    const wrongOptionId = optionIdFor(defs, 2, 'Employee:  Government'); // belongs to parameter 2 (Occupation)
    expect(() => computeCreditScore(defs, [{ parameterId: 1, selectedOptionId: wrongOptionId }])).toThrow(ApiError);
  });
});

describe('creditScoreEngine.isFullyAnswered', () => {
  const defs = buildDefs(SALARIED_QUANTITATIVE, SALARIED_QUALITATIVE);

  test('false when at least one QUANTITATIVE parameter is unanswered', () => {
    const responses = [{ parameterId: 1, selectedOptionId: optionIdFor(defs, 1, '31 to 40 Years') }];
    expect(isFullyAnswered(defs, responses)).toBe(false);
  });

  test('true once every QUANTITATIVE parameter has a selectedOptionId (qualitative flags are not required)', () => {
    const responses = SALARIED_QUANTITATIVE.map((p, i) => ({
      parameterId: i + 1,
      selectedOptionId: optionIdFor(defs, i + 1, p.options[0].label)
    }));
    expect(isFullyAnswered(defs, responses)).toBe(true);
  });
});

describe('creditScoreEngine.hasCibilResponse', () => {
  const defs = buildDefs(SALARIED_QUANTITATIVE, SALARIED_QUALITATIVE);
  const cibilParamId = 8;

  test('false when the CIBIL Score parameter has not been answered', () => {
    expect(hasCibilResponse(defs, [])).toBe(false);
  });

  test('true once the CIBIL Score parameter has a selectedOptionId', () => {
    const responses = [{ parameterId: cibilParamId, selectedOptionId: optionIdFor(defs, cibilParamId, '700 to 749') }];
    expect(hasCibilResponse(defs, responses)).toBe(true);
  });

  test('defensively returns true when no CIBIL parameter exists on the given defs at all', () => {
    const noCibilDefs = defs.filter((d) => d.id !== cibilParamId);
    expect(hasCibilResponse(noCibilDefs, [])).toBe(true);
  });
});
