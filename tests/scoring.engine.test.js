'use strict';

const {
  cibilFactorScore, incomeEmiCoverageScore, securityCoverageScore, dpdHistoryScore,
  enquiryCountScore, guarantorQualityScore, decisionFor, computeScoreCard
} = require('../src/modules/scorecard/scoring.engine');

describe('cibilFactorScore (max 20, linear 300-900 scale)', () => {
  test('748 -> ~15 (matches the reference example exactly)', () => {
    expect(cibilFactorScore(748)).toBe(14.93);
  });
  test('minimum bureau score (300) -> 0', () => {
    expect(cibilFactorScore(300)).toBe(0);
  });
  test('maximum bureau score (900) -> 20', () => {
    expect(cibilFactorScore(900)).toBe(20);
  });
  test('null credit score -> 0, does not throw', () => {
    expect(cibilFactorScore(null)).toBe(0);
  });
  test('is clamped even if a score outside 300-900 is somehow passed', () => {
    expect(cibilFactorScore(950)).toBe(20);
    expect(cibilFactorScore(100)).toBe(0);
  });
});

describe('incomeEmiCoverageScore (max 20, FOIR band)', () => {
  test('FOIR < 30% -> 20', () => {
    expect(incomeEmiCoverageScore(50000, 5000, 5000)).toBe(20); // 10000/50000 = 20%
  });
  test('FOIR 30-44% -> 15', () => {
    expect(incomeEmiCoverageScore(50000, 10000, 10000)).toBe(15); // 40%
  });
  test('FOIR 45-59% -> 10', () => {
    expect(incomeEmiCoverageScore(50000, 15000, 12000)).toBe(10); // 54%
  });
  test('FOIR 60-74% -> 7.5', () => {
    expect(incomeEmiCoverageScore(50000, 20000, 15000)).toBe(7.5); // 70%
  });
  test('FOIR 75-94% -> 5', () => {
    expect(incomeEmiCoverageScore(50000, 25000, 15000)).toBe(5); // 80%
  });
  test('FOIR >= 95% -> 0', () => {
    expect(incomeEmiCoverageScore(50000, 30000, 20000)).toBe(0); // 100%
  });
  test('zero gross income -> 0, does not divide by zero', () => {
    expect(incomeEmiCoverageScore(0, 1000, 1000)).toBe(0);
  });
});

describe('securityCoverageScore (max 15)', () => {
  test('coverage ratio >= 125% -> 15', () => {
    expect(securityCoverageScore(1250000, 1000000)).toBe(15);
  });
  test('coverage ratio 100-124% -> 12', () => {
    expect(securityCoverageScore(1100000, 1000000)).toBe(12);
  });
  test('coverage ratio 80-99% -> 9', () => {
    expect(securityCoverageScore(850000, 1000000)).toBe(9);
  });
  test('coverage ratio 60-79% -> 6', () => {
    expect(securityCoverageScore(650000, 1000000)).toBe(6);
  });
  test('coverage ratio 40-59% -> 3', () => {
    expect(securityCoverageScore(450000, 1000000)).toBe(3);
  });
  test('coverage ratio < 40% -> 0', () => {
    expect(securityCoverageScore(300000, 1000000)).toBe(0);
  });
  test('zero loan amount -> 0, does not divide by zero', () => {
    expect(securityCoverageScore(500000, 0)).toBe(0);
  });
});

describe('dpdHistoryScore (max 20)', () => {
  test('null (never reported) -> 20 (clean)', () => {
    expect(dpdHistoryScore(null)).toBe(20);
  });
  test('0 days -> 20 (clean)', () => {
    expect(dpdHistoryScore(0)).toBe(20);
  });
  test('1-29 days -> 14', () => {
    expect(dpdHistoryScore(15)).toBe(14);
  });
  test('30-59 days -> 8', () => {
    expect(dpdHistoryScore(45)).toBe(8);
  });
  test('60-89 days -> 4', () => {
    expect(dpdHistoryScore(75)).toBe(4);
  });
  test('90+ days -> 0', () => {
    expect(dpdHistoryScore(120)).toBe(0);
  });
});

describe('enquiryCountScore (max 15)', () => {
  test('0 enquiries -> 15', () => {
    expect(enquiryCountScore(0)).toBe(15);
  });
  test('1-2 enquiries -> 12', () => {
    expect(enquiryCountScore(2)).toBe(12);
  });
  test('3-4 enquiries -> 8', () => {
    expect(enquiryCountScore(3)).toBe(8);
  });
  test('5-6 enquiries -> 4', () => {
    expect(enquiryCountScore(6)).toBe(4);
  });
  test('7+ enquiries -> 0', () => {
    expect(enquiryCountScore(10)).toBe(0);
  });
  test('null/undefined -> treated as 0 enquiries -> 15', () => {
    expect(enquiryCountScore(null)).toBe(15);
  });
});

describe('guarantorQualityScore (max 10)', () => {
  test('no guarantor present -> neutral full marks (10)', () => {
    expect(guarantorQualityScore(null, 20000)).toBe(10);
  });
  test('strong guarantor: high CIBIL + income >= 1.5x EMI -> near max', () => {
    // cibilComponent = (900-300)/600*6 = 6; incomeComponent = 4 (ratio >= 1.5)
    expect(guarantorQualityScore({ creditScore: 900, monthlyIncome: 40000 }, 20000)).toBe(10);
  });
  test('weak guarantor: low CIBIL + income < 0.5x EMI -> low score', () => {
    // cibilComponent = (300-300)/600*6 = 0; incomeComponent = 0 (ratio < 0.5)
    expect(guarantorQualityScore({ creditScore: 300, monthlyIncome: 5000 }, 20000)).toBe(0);
  });
  test('guarantor income exactly 1x EMI -> incomeComponent 3', () => {
    expect(guarantorQualityScore({ creditScore: 300, monthlyIncome: 20000 }, 20000)).toBe(3);
  });
  test('zero proposed EMI -> incomeRatio treated as 0, does not divide by zero', () => {
    expect(guarantorQualityScore({ creditScore: 600, monthlyIncome: 10000 }, 0)).toBe(3); // cibilComponent = 3, incomeComponent = 0
  });
  test('falls back to grossIncome if monthlyIncome is not supplied', () => {
    expect(guarantorQualityScore({ creditScore: 300, grossIncome: 40000 }, 20000)).toBe(4); // incomeComponent 4 (ratio 2.0)
  });
});

describe('decisionFor', () => {
  test('>= 75 -> Eligible for Approval', () => {
    expect(decisionFor(75)).toEqual({ eligible: true, decisionText: 'Eligible for Approval' });
    expect(decisionFor(100)).toEqual({ eligible: true, decisionText: 'Eligible for Approval' });
  });
  test('60-74.99 -> Conditional - Manual Review Required', () => {
    expect(decisionFor(60)).toEqual({ eligible: false, decisionText: 'Conditional - Manual Review Required' });
    expect(decisionFor(74.9)).toEqual({ eligible: false, decisionText: 'Conditional - Manual Review Required' });
  });
  test('< 60 -> Not Eligible', () => {
    expect(decisionFor(0)).toEqual({ eligible: false, decisionText: 'Not Eligible' });
    expect(decisionFor(59.9)).toEqual({ eligible: false, decisionText: 'Not Eligible' });
  });
});

describe('computeScoreCard — end-to-end', () => {
  test('all six factors sum correctly into totalScore', () => {
    const result = computeScoreCard({
      subscriber: { creditScore: 748, worstDpdDays: 0, enquiryCount6Months: 0 },
      guarantors: [],
      securities: [{ securityType: 'Gold Ornaments', valueLoaded: 1500000 }],
      chitValue: 1000000,
      futureLiability: 800000,
      documentsComplete: true,
      grossMonthlyIncome: 50000,
      existingObligations: 5000,
      proposedEmi: 5000
    });
    // cibil 14.93 + incomeEmi 20 (FOIR 20%) + securityCoverage 15 (150% ratio) + dpd 20 (clean) + enquiry 15 (0) + guarantor 10 (none)
    expect(result.factors.cibilScore.score).toBe(14.93);
    expect(result.factors.incomeEmiCoverage.score).toBe(20);
    expect(result.factors.securityCoverage.score).toBe(15);
    expect(result.factors.dpdHistory.score).toBe(20);
    expect(result.factors.enquiryCount.score).toBe(15);
    expect(result.factors.guarantorQuality.score).toBe(10);
    expect(result.totalScore).toBe(94.93);
    expect(result.eligible).toBe(true);
    expect(result.decisionText).toBe('Eligible for Approval');
  });

  test('readyToSubmit is false when CIBIL is missing for a guarantor', () => {
    const result = computeScoreCard({
      subscriber: { creditScore: 700 },
      guarantors: [{ creditScore: null }],
      securities: [{ securityType: 'Gold Ornaments', valueLoaded: 900000 }],
      chitValue: 900000, futureLiability: 800000, documentsComplete: true,
      grossMonthlyIncome: 50000, existingObligations: 0, proposedEmi: 5000
    });
    expect(result.cibilComplete).toBe(false);
    expect(result.readyToSubmit).toBe(false);
  });

  test('readyToSubmit is false when security does not cover future liability', () => {
    const result = computeScoreCard({
      subscriber: { creditScore: 700 },
      guarantors: [],
      securities: [{ securityType: 'Gold Ornaments', valueLoaded: 300000 }],
      chitValue: 900000, futureLiability: 800000, documentsComplete: true,
      grossMonthlyIncome: 50000, existingObligations: 0, proposedEmi: 5000
    });
    expect(result.securityCoversLiability).toBe(false);
    expect(result.readyToSubmit).toBe(false);
  });

  test('readyToSubmit is true only when all three guards pass', () => {
    const result = computeScoreCard({
      subscriber: { creditScore: 700 },
      guarantors: [],
      securities: [{ securityType: 'Gold Ornaments', valueLoaded: 900000 }],
      chitValue: 900000, futureLiability: 800000, documentsComplete: true,
      grossMonthlyIncome: 50000, existingObligations: 0, proposedEmi: 5000
    });
    expect(result.readyToSubmit).toBe(true);
  });

  test('only the first guarantor feeds Guarantor Quality (documented assumption)', () => {
    const result = computeScoreCard({
      subscriber: { creditScore: 700 },
      guarantors: [{ creditScore: 900, monthlyIncome: 100000 }, { creditScore: 300, monthlyIncome: 0 }],
      securities: [{ securityType: 'Gold Ornaments', valueLoaded: 900000 }],
      chitValue: 900000, futureLiability: 800000, documentsComplete: true,
      grossMonthlyIncome: 50000, existingObligations: 0, proposedEmi: 5000
    });
    // If the weak second guarantor were averaged in, this would be lower than the max.
    expect(result.factors.guarantorQuality.score).toBe(10);
  });
});
