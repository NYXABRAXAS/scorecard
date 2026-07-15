'use strict';

/**
 * Verifies the Accepted Value Formula per FRD Section 6.1 ("6.1 Security Type
 * Matrix", Table 20) — see src/modules/scorecard/securityValuation.js.
 */

const { computeAcceptedValue, freeValueOf, prepareSecurity, SECURITY_TYPES } = require('../src/modules/scorecard/securityValuation');

describe('computeAcceptedValue', () => {
  test('Gold Ornaments: Grams x Rate/Gram, no haircut', () => {
    expect(computeAcceptedValue({ securityType: 'Gold Ornaments', netWeightGrams: 145, ratePerGram: 6200 })).toBe(899000);
  });

  test('LIC Policy: 100% of Surrender Value', () => {
    expect(computeAcceptedValue({ securityType: 'LIC Policy', surrenderValue: 250000 })).toBe(250000);
  });

  test('Bank Guarantee: 100% of Face Value', () => {
    expect(computeAcceptedValue({ securityType: 'Bank Guarantee', faceValue: 500000 })).toBe(500000);
  });

  test('Fixed Deposit: 100% of Face Value', () => {
    expect(computeAcceptedValue({ securityType: 'Fixed Deposit', faceValue: 300000 })).toBe(300000);
  });

  test('Demat NCD: 100% of Face Value', () => {
    expect(computeAcceptedValue({ securityType: 'Demat NCD', faceValue: 400000 })).toBe(400000);
  });

  test('Sub-Debt: value is "As per API" (accepted as given)', () => {
    expect(computeAcceptedValue({ securityType: 'Sub-Debt', apiSourcedValue: 275000, maturityDate: '2028-01-01' })).toBe(275000);
  });

  test('Chit Passbook: value is "As per API" (accepted as given)', () => {
    expect(computeAcceptedValue({ securityType: 'Chit Passbook', apiSourcedValue: 120000 })).toBe(120000);
  });

  test('Mortgage (Property): (FSV / 150) x 100', () => {
    expect(computeAcceptedValue({ securityType: 'Mortgage (Property)', forcedSaleValue: 3000000 })).toBe(2000000);
  });

  test('Demat Shares: liability < Rs.2L -> 50% of market value', () => {
    expect(computeAcceptedValue({ securityType: 'Demat Shares', marketValue: 500000, liabilityToSecure: 150000 })).toBe(250000);
  });

  test('Demat Shares: liability >= Rs.2L -> min(50% MV, 40% liability)', () => {
    // 50% of 1,000,000 = 500,000; 40% of 300,000 = 120,000 -> min is 120,000
    expect(computeAcceptedValue({ securityType: 'Demat Shares', marketValue: 1000000, liabilityToSecure: 300000 })).toBe(120000);
  });

  test('Demat Shares boundary: liability exactly Rs.2L uses the >= branch', () => {
    // 50% of 1,000,000 = 500,000; 40% of 200,000 = 80,000 -> min is 80,000
    expect(computeAcceptedValue({ securityType: 'Demat Shares', marketValue: 1000000, liabilityToSecure: 200000 })).toBe(80000);
  });

  test('Personal Surety: no tangible security value -> 0', () => {
    expect(computeAcceptedValue({ securityType: 'Personal Surety' })).toBe(0);
  });

  test('throws a validation error for an unknown security type', () => {
    expect(() => computeAcceptedValue({ securityType: 'Bitcoin' })).toThrow();
  });

  test('throws a validation error when a required field is missing (e.g. Gold without ratePerGram)', () => {
    expect(() => computeAcceptedValue({ securityType: 'Gold Ornaments', netWeightGrams: 100 })).toThrow();
  });
});

describe('freeValueOf (gross reference value before formula reduction)', () => {
  test('equals the accepted value for 100%-formula types (no reduction)', () => {
    const s = { securityType: 'Bank Guarantee', faceValue: 500000 };
    expect(freeValueOf(s)).toBe(computeAcceptedValue(s));
  });

  test('is the pre-reduction gross value for Mortgage (differs from accepted value)', () => {
    const s = { securityType: 'Mortgage (Property)', forcedSaleValue: 3000000 };
    expect(freeValueOf(s)).toBe(3000000);
    expect(computeAcceptedValue(s)).toBe(2000000);
    expect(freeValueOf(s)).toBeGreaterThan(computeAcceptedValue(s));
  });

  test('is the pre-reduction gross value for Demat Shares (differs from accepted value)', () => {
    const s = { securityType: 'Demat Shares', marketValue: 1000000, liabilityToSecure: 300000 };
    expect(freeValueOf(s)).toBe(1000000);
    expect(computeAcceptedValue(s)).toBe(120000);
  });
});

describe('prepareSecurity (full persisted-shape record)', () => {
  test('isolates only the relevant raw inputs into valuationInputs', () => {
    const prepared = prepareSecurity({
      securityType: 'Gold Ornaments', netWeightGrams: 150, ratePerGram: 6000,
      holderName: 'Kalaivani Natarajan', loyaltyUsn: 'USN7106'
    });
    expect(prepared.valuationInputs).toEqual({ netWeightGrams: 150, ratePerGram: 6000 });
    expect(prepared.freeValue).toBe(900000);
    expect(prepared.valueLoaded).toBe(900000);
    expect(prepared.holderName).toBe('Kalaivani Natarajan');
    expect(prepared.loyaltyUsn).toBe('USN7106');
  });

  test('every declared SECURITY_TYPES entry is handled without throwing, given its required fields', () => {
    const sampleInputs = {
      'Gold Ornaments': { netWeightGrams: 10, ratePerGram: 6000 },
      'LIC Policy': { surrenderValue: 10000 },
      'Bank Guarantee': { faceValue: 10000 },
      'Fixed Deposit': { faceValue: 10000 },
      'Sub-Debt': { apiSourcedValue: 10000, maturityDate: '2030-01-01' },
      'Mortgage (Property)': { forcedSaleValue: 15000 },
      'Chit Passbook': { apiSourcedValue: 10000 },
      'Demat NCD': { faceValue: 10000 },
      'Demat Shares': { marketValue: 10000, liabilityToSecure: 5000 },
      'Personal Surety': {}
    };
    for (const type of SECURITY_TYPES) {
      expect(() => prepareSecurity({ securityType: type, ...sampleInputs[type] })).not.toThrow();
    }
  });
});
