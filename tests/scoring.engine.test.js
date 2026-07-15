'use strict';

const {
  determineSegment, foirScoreModerate, foirScoreComprehensive, profileStrengthScore,
  vintageVisitScore, incomeStabilityScore, assetNetWorthScore, negativeScore,
  personScore, gradeFor, computeScoreCard, isSecuredCase
} = require('../src/modules/scorecard/scoring.engine');

describe('isSecuredCase', () => {
  test('true when a tangible-collateral security type is present', () => {
    expect(isSecuredCase([{ securityType: 'Gold Ornaments' }])).toBe(true);
  });
  test('false when only Personal Surety is offered (no tangible collateral)', () => {
    expect(isSecuredCase([{ securityType: 'Personal Surety' }])).toBe(false);
  });
  test('false when only Mortgage is offered (no bankable collateral value per Annexure)', () => {
    expect(isSecuredCase([{ securityType: 'Mortgage (Property)' }])).toBe(false);
  });
  test('false when no securities at all', () => {
    expect(isSecuredCase([])).toBe(false);
  });
});

describe('determineSegment', () => {
  test('Secured + chit value <= 10L -> simple KYC', () => {
    const seg = determineSegment([{ securityType: 'Gold Ornaments' }], 900000);
    expect(seg).toEqual({ category: 'secured', bucket: '<=10L', label: 'Secured <=10L', method: 'simple' });
  });
  test('Secured + chit value > 10L -> moderate KYC', () => {
    const seg = determineSegment([{ securityType: 'Gold Ornaments' }], 1500000);
    expect(seg.method).toBe('moderate');
  });
  test('Unsecured + chit value <= 8L -> comprehensive KYC', () => {
    const seg = determineSegment([{ securityType: 'Personal Surety' }], 500000);
    expect(seg).toEqual({ category: 'unsecured', bucket: '<=8L', label: 'Unsecured <=8L', method: 'comprehensive' });
  });
  test('Unsecured + chit value between 8L and 25L -> comprehensive KYC', () => {
    const seg = determineSegment([{ securityType: 'Personal Surety' }], 1500000);
    expect(seg.bucket).toBe('8L-25L');
  });
  test('Unsecured + chit value > 25L -> comprehensive KYC, >25L bucket', () => {
    const seg = determineSegment([{ securityType: 'Personal Surety' }], 3000000);
    expect(seg.bucket).toBe('>25L');
  });
  test('boundary: exactly 1000000 is still <=10L (inclusive)', () => {
    expect(determineSegment([{ securityType: 'Gold Ornaments' }], 1000000).bucket).toBe('<=10L');
  });
  test('boundary: exactly 1000001 crosses into >10L', () => {
    expect(determineSegment([{ securityType: 'Gold Ornaments' }], 1000001).bucket).toBe('>10L');
  });
});

describe('foirScoreModerate (max 30)', () => {
  test.each([
    [0.10, 30], [0.29, 30],
    [0.30, 20], [0.44, 20],
    [0.45, 15], [0.59, 15],
    [0.60, 10], [0.74, 10],
    [0.75, 5], [0.94, 5],
    [0.95, 0], [1.20, 0]
  ])('FOIR %p -> %p', (foir, expected) => {
    expect(foirScoreModerate(foir)).toBe(expected);
  });
});

describe('foirScoreComprehensive (max 40)', () => {
  test.each([
    [0.10, 40], [0.29, 40],
    [0.30, 30], [0.44, 30],
    [0.45, 20], [0.59, 20],
    [0.60, 15], [0.74, 15],
    [0.75, 10], [0.94, 10],
    [0.95, 0]
  ])('FOIR %p -> %p', (foir, expected) => {
    expect(foirScoreComprehensive(foir)).toBe(expected);
  });
});

describe('profileStrengthScore (max 20)', () => {
  test('Govt/PSU salaried always scores 20', () => {
    expect(profileStrengthScore({ employmentType: 'Salaried-Govt' })).toBe(20);
    expect(profileStrengthScore({ employmentType: 'Salaried-PSU' })).toBe(20);
  });
  test('large private-sector employer with 3+ years tenure scores 16', () => {
    expect(profileStrengthScore({ employmentType: 'Salaried-Private', employeeCount: 150, yearsInJob: 4 })).toBe(16);
  });
  test('mid-size employer (>=20) scores 12', () => {
    expect(profileStrengthScore({ employmentType: 'Salaried-Private', employeeCount: 25 })).toBe(12);
  });
  test('small employer scores 8', () => {
    expect(profileStrengthScore({ employmentType: 'Salaried-Private', employeeCount: 5 })).toBe(8);
  });
  test('salaried without employer-size detail defaults to 12', () => {
    expect(profileStrengthScore({ employmentType: 'Salaried-Private' })).toBe(12);
  });
  test('PvtLtd business, >=5 years -> 20', () => {
    expect(profileStrengthScore({ employmentType: 'Business', entityType: 'PvtLtd', yearsInBusiness: 6 })).toBe(20);
  });
  test('PvtLtd business, <5 years -> 17', () => {
    expect(profileStrengthScore({ employmentType: 'Business', entityType: 'PvtLtd', yearsInBusiness: 2 })).toBe(17);
  });
  test('Partnership with >20 staff -> 18', () => {
    expect(profileStrengthScore({ employmentType: 'Business', entityType: 'Partnership', staffCount: 25 })).toBe(18);
  });
  test('Proprietorship with <=10 staff -> 10', () => {
    expect(profileStrengthScore({ employmentType: 'Self Employed - Professional', entityType: 'Proprietorship', staffCount: 3 })).toBe(10);
  });
  test('unorganised/agriculture/other -> 4', () => {
    expect(profileStrengthScore({ employmentType: 'Agriculture' })).toBe(4);
  });
});

describe('vintageVisitScore (max 5, best of the two)', () => {
  test('vintage > 3 years -> 5, even with zero visits', () => {
    expect(vintageVisitScore({ customerVintageYears: 5, personalVisits: 0 })).toBe(5);
  });
  test('3+ visits -> 5, even with zero vintage', () => {
    expect(vintageVisitScore({ customerVintageYears: 0, personalVisits: 3 })).toBe(5);
  });
  test('brand new customer, no visits -> 1 (vintage floor)', () => {
    expect(vintageVisitScore({ customerVintageYears: 0, personalVisits: 0 })).toBe(1);
  });
});

describe('incomeStabilityScore (max 5)', () => {
  test('Govt/PSU permanent overrides to 5 regardless of years', () => {
    expect(incomeStabilityScore({ employmentType: 'Salaried-Govt', yearsOfService: 0, permanentGovt: true })).toBe(5);
  });
  test('Govt but explicitly NOT permanent does not get the override', () => {
    expect(incomeStabilityScore({ employmentType: 'Salaried-Govt', yearsOfService: 3, permanentGovt: false })).toBe(3);
  });
  test('>7 years of service -> 5', () => {
    expect(incomeStabilityScore({ employmentType: 'Salaried-Private', yearsOfService: 8 })).toBe(5);
  });
  test('2-7 years -> 3', () => {
    expect(incomeStabilityScore({ employmentType: 'Salaried-Private', yearsOfService: 3 })).toBe(3);
  });
  test('<2 years -> 2', () => {
    expect(incomeStabilityScore({ employmentType: 'Salaried-Private', yearsOfService: 1 })).toBe(2);
  });
});

describe('assetNetWorthScore (max 30)', () => {
  const chitValue = 1000000;
  test('2+ qualifying properties (value >= 2x chit value) -> 30', () => {
    expect(assetNetWorthScore({ propertyCount: 2, propertyValue: 2500000 }, chitValue)).toBe(30);
  });
  test('1 qualifying property -> 20', () => {
    expect(assetNetWorthScore({ propertyCount: 1, propertyValue: 2500000 }, chitValue)).toBe(20);
  });
  test('property value below the 2x threshold -> 0 even with 2 properties', () => {
    expect(assetNetWorthScore({ propertyCount: 2, propertyValue: 1000000 }, chitValue)).toBe(0);
  });
  test('no property -> 0', () => {
    expect(assetNetWorthScore({ propertyCount: 0, propertyValue: 0 }, chitValue)).toBe(0);
  });
});

describe('negativeScore (capped at -150)', () => {
  const unsecuredSegment = { category: 'unsecured', bucket: '8L-25L' };
  const securedLE10L = { category: 'secured', bucket: '<=10L' };
  const securedGT10L = { category: 'secured', bucket: '>10L' };

  test('suit filed -> -100 regardless of segment', () => {
    expect(negativeScore({ suitFiled: true }, unsecuredSegment)).toBe(100);
    expect(negativeScore({ suitFiled: true }, securedLE10L)).toBe(100);
  });
  test('PRL flag -> -30 in unsecured segment', () => {
    expect(negativeScore({ prlFlag: true }, unsecuredSegment)).toBe(30);
  });
  test('PRL flag is EXEMPT for Secured <=10L (simple KYC)', () => {
    expect(negativeScore({ prlFlag: true }, securedLE10L)).toBe(0);
  });
  test('PRL flag still applies for Secured >10L', () => {
    expect(negativeScore({ prlFlag: true }, securedGT10L)).toBe(30);
  });
  test('CC3 and cheque-bounce>2 are exempt for ANY secured segment', () => {
    expect(negativeScore({ cc3Flag: true, chequeBounceCount: 5 }, securedGT10L)).toBe(0);
  });
  test('CC3 and cheque-bounce>2 both apply for unsecured, -10 each', () => {
    expect(negativeScore({ cc3Flag: true, chequeBounceCount: 5 }, unsecuredSegment)).toBe(20);
  });
  test('cheque bounce count of exactly 2 does NOT trigger the penalty (threshold is >2)', () => {
    expect(negativeScore({ chequeBounceCount: 2 }, unsecuredSegment)).toBe(0);
  });
  test('total negative score is capped at 150 even if all penalties stack', () => {
    const worst = { suitFiled: true, prlFlag: true, cc3Flag: true, chequeBounceCount: 10 };
    expect(negativeScore(worst, unsecuredSegment)).toBe(150); // 100+30+10+10=150, already at cap
  });
});

describe('personScore', () => {
  test('simple KYC always yields positive=100 before any negative deduction', () => {
    const segment = { category: 'secured', bucket: '<=10L', method: 'simple' };
    const result = personScore({ foir: 0.9 }, segment, 900000);
    expect(result.positive).toBe(100);
    expect(result.negative).toBe(0);
    expect(result.final).toBe(100);
  });
  test('final score is clamped to a 0-100 floor even under heavy negative scoring', () => {
    const segment = { category: 'unsecured', bucket: '<=8L', method: 'comprehensive' };
    const p = { employmentType: 'Agriculture', foir: 0.99, suitFiled: true, prlFlag: true, cc3Flag: true, chequeBounceCount: 10 };
    const result = personScore(p, segment, 500000);
    expect(result.final).toBe(0); // positive is small (4+1+2+0+0=7), negative capped at 150 -> clamp(7-150,0,100)=0
  });
  test('missing person returns all-zero score rather than throwing', () => {
    expect(personScore(null, { method: 'simple' }, 100000)).toEqual({ positive: 0, negative: 0, final: 0 });
  });
});

describe('gradeFor', () => {
  test.each([
    [100, 'A'], [70, 'A'],
    [69, 'B'], [51, 'B'],
    [50, 'C'], [40, 'C'],
    [39, 'D'], [0, 'D'], [-50, 'D']
  ])('score %p -> grade %p', (score, grade) => {
    expect(gradeFor(score).grade).toBe(grade);
  });
});

describe('computeScoreCard — end-to-end (mirrors the worked example in Annexure 2)', () => {
  test('secured <=10L case with one guarantor: weighted 60/40 blend', () => {
    const result = computeScoreCard({
      subscriber: { foir: 0.2, creditScore: 763 },
      guarantors: [{ foir: 0.25, creditScore: 809 }],
      securities: [{ securityType: 'Chit Passbook', valueLoaded: 3300000 }, { securityType: 'Mortgage (Property)', valueLoaded: 2200000 }],
      chitValue: 6750000,
      futureLiability: 6000000,
      documentsComplete: true
    });
    // Secured (Chit Passbook counts) but chit value > 10L -> moderate KYC, not simple.
    expect(result.segment.method).toBe('moderate');
    // Moderate: 70 + foirScoreModerate(0.2)=30 -> 100 for both SB and guarantor.
    expect(result.sb.final).toBe(100);
    expect(result.guarantors[0].final).toBe(100);
    expect(result.finalWeightedScore).toBe(100);
    expect(result.riskGrade).toBe('A');
    // Securities total 3.3M + 2.2M = 5.5M, which is BELOW the 6M future liability —
    // securityCoversLiability correctly reports false here (that guard would block
    // submission at the earlier BRANCH_WIP stage; it is independent of the risk score).
    expect(result.securityCoversLiability).toBe(false);
  });

  test('unsecured comprehensive case with no guarantors: SB score alone is final', () => {
    const result = computeScoreCard({
      subscriber: {
        employmentType: 'Salaried-Govt', foir: 0.15, creditScore: 720,
        customerVintageYears: 4, propertyCount: 2, propertyValue: 2000000
      },
      guarantors: [],
      securities: [{ securityType: 'Personal Surety', valueLoaded: 0 }],
      chitValue: 500000,
      futureLiability: 400000,
      documentsComplete: true
    });
    expect(result.segment.method).toBe('comprehensive');
    // Govt profile(20) + vintage(5) + income-stability(5, govt override) + FOIR<30%(40) + asset(propertyValue 2M < 2*500k*2=... )
    expect(result.guarantors).toHaveLength(0);
    expect(result.finalWeightedScore).toBe(result.sb.final);
  });

  test('readyToSubmit is false when CIBIL is missing for a guarantor', () => {
    const result = computeScoreCard({
      subscriber: { foir: 0.2, creditScore: 700 },
      guarantors: [{ foir: 0.2, creditScore: null }],
      securities: [{ securityType: 'Gold Ornaments', valueLoaded: 900000 }],
      chitValue: 900000,
      futureLiability: 800000,
      documentsComplete: true
    });
    expect(result.cibilComplete).toBe(false);
    expect(result.readyToSubmit).toBe(false);
  });

  test('readyToSubmit is false when security does not cover future liability', () => {
    const result = computeScoreCard({
      subscriber: { foir: 0.2, creditScore: 700 },
      guarantors: [],
      securities: [{ securityType: 'Gold Ornaments', valueLoaded: 300000 }],
      chitValue: 900000,
      futureLiability: 800000,
      documentsComplete: true
    });
    expect(result.securityCoversLiability).toBe(false);
    expect(result.readyToSubmit).toBe(false);
  });

  test('readyToSubmit is true only when all three guards pass', () => {
    const result = computeScoreCard({
      subscriber: { foir: 0.2, creditScore: 700 },
      guarantors: [],
      securities: [{ securityType: 'Gold Ornaments', valueLoaded: 900000 }],
      chitValue: 900000,
      futureLiability: 800000,
      documentsComplete: true
    });
    expect(result.readyToSubmit).toBe(true);
  });
});
