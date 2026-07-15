'use strict';

/**
 * Server-side Accepted Value calculator for each security type — per the
 * "6.1 Security Type Matrix" in MuthootPappachan_LoanProcessing_FRD_v11 (Section 6,
 * Table: "# | Security Type | Holder Type | Validation | Input Fields |
 * Accepted Value Formula | Notes").
 *
 * Security type identifiers here match the canonical names already used across
 * the rest of MCF LOS (assets/json/security-types.json, bi-security-selection.html)
 * rather than the FRD table's literal wording (e.g. "Gold" not "Gold Ornaments",
 * "Chit Passbook Pledge" not "Chit Passbook") — only the accepted-value FORMULA is
 * taken from the FRD; the identifiers stay consistent with the rest of the system
 * so this API can key against the same security-type strings every other MCF LOS
 * screen already uses.
 *
 * This is the authoritative Accepted Value formula per the FRD — it is NOT a flat
 * LTV-cap percentage model. Most types accept 100% of face/surrender value; only
 * Mortgage and Demat Shares use a reduced formula. valueLoaded is always computed
 * here from the type-specific raw inputs — it is never trusted as a raw client-
 * supplied number, since that would let a caller bypass the accepted-value rule
 * entirely.
 */

const ApiError = require('../../utils/ApiError');

// FRD Table 20 row -> canonical MCF LOS security type name -> required raw inputs.
const REQUIRED_FIELDS = {
  'Gold Ornaments': ['netWeightGrams', 'ratePerGram'],        // Row 1 "Gold": Grams x Rate/Gram
  'LIC Policy': ['surrenderValue'],                            // Row 2: 100% of Surrender Value
  'Bank Guarantee': ['faceValue'],                             // Row 3: 100% of Face Value
  'Fixed Deposit': ['faceValue'],                              // Row 4: 100% of Face Value
  'Sub-Debt': ['apiSourcedValue', 'maturityDate'],             // Row 5 "Deposit with Group Co.": As per API
  'Mortgage (Property)': ['forcedSaleValue'],                  // Row 6: (FSV / 150) x 100
  'Chit Passbook': ['apiSourcedValue'],                        // Row 7 "Chit Passbook Pledge": As per API
  'Demat NCD': ['faceValue'],                                  // Row 8A: 100% of Face Value
  'Demat Shares': ['marketValue', 'liabilityToSecure'],        // Row 8B: 50%/40% formula
  'Personal Surety': []                                        // Not in Table 20 (Guarantee category, no security value)
};

const SECURITY_TYPES = Object.keys(REQUIRED_FIELDS);

function assertRequiredFields(security) {
  const required = REQUIRED_FIELDS[security.securityType];
  if (required === undefined) {
    throw ApiError.validation([{ field: 'securityType', message: `Unknown security type "${security.securityType}". Must be one of: ${SECURITY_TYPES.join(', ')}` }]);
  }
  const missing = required.filter((f) => security[f] === undefined || security[f] === null);
  if (missing.length) {
    throw ApiError.validation(
      missing.map((f) => ({ field: f, message: `"${f}" is required for security type "${security.securityType}" (Accepted Value Formula input per FRD Section 6.1).` }))
    );
  }
}

/**
 * Computes the Accepted Value ("valueLoaded") for one security, per the FRD's
 * exact per-type formula (Section 6.1, Table 20). Throws ApiError.validation if a
 * type-specific required input is missing.
 */
function computeAcceptedValue(security) {
  assertRequiredFields(security);
  const s = security;

  switch (s.securityType) {
    case 'Gold Ornaments':
      return round2(s.netWeightGrams * s.ratePerGram);

    case 'LIC Policy':
      return round2(s.surrenderValue);

    case 'Bank Guarantee':
    case 'Fixed Deposit':
    case 'Demat NCD':
      return round2(s.faceValue);

    case 'Sub-Debt':
    case 'Chit Passbook':
      // Value sourced from an external system (MChit / depository), not computed
      // here — accepted as given, but still explicitly required as input.
      return round2(s.apiSourcedValue);

    case 'Mortgage (Property)':
      return round2((s.forcedSaleValue / 150) * 100);

    case 'Demat Shares':
      return s.liabilityToSecure < 200000
        ? round2(0.5 * s.marketValue)
        : round2(Math.min(0.5 * s.marketValue, 0.4 * s.liabilityToSecure));

    case 'Personal Surety':
      // No tangible security value — guarantor net-worth is assessed separately
      // (see FRD Section 6.2, Subscriber Eligibility Screen), not as a security value.
      return 0;

    default:
      // Unreachable — assertRequiredFields already rejects unknown types.
      throw ApiError.validation([{ field: 'securityType', message: `Unhandled security type "${s.securityType}".` }]);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** The gross/reference value BEFORE the type-specific formula reduction (for display/audit). */
function freeValueOf(security) {
  const s = security;
  switch (s.securityType) {
    case 'Gold Ornaments':
      return round2(s.netWeightGrams * s.ratePerGram);
    case 'LIC Policy':
      return round2(s.surrenderValue);
    case 'Bank Guarantee':
    case 'Fixed Deposit':
    case 'Demat NCD':
      return round2(s.faceValue);
    case 'Sub-Debt':
    case 'Chit Passbook':
      return round2(s.apiSourcedValue);
    case 'Mortgage (Property)':
      return round2(s.forcedSaleValue);
    case 'Demat Shares':
      return round2(s.marketValue);
    case 'Personal Surety':
    default:
      return 0;
  }
}

/**
 * Takes one raw (validated) security input and returns the full persisted-shape
 * record: the type-specific raw inputs isolated into `valuationInputs` (stored as
 * JSONB), plus the computed `freeValue` (pre-formula) and `valueLoaded` (post-formula,
 * accepted value). This is the only place a security's accepted value is decided —
 * callers must never persist a client-supplied valueLoaded directly.
 */
function prepareSecurity(security) {
  assertRequiredFields(security);
  const required = REQUIRED_FIELDS[security.securityType];
  const valuationInputs = {};
  for (const field of required) valuationInputs[field] = security[field];

  return {
    securityType: security.securityType,
    holderName: security.holderName || null,
    loyaltyUsn: security.loyaltyUsn || null,
    valuationInputs,
    freeValue: freeValueOf(security),
    valueLoaded: computeAcceptedValue(security)
  };
}

module.exports = { SECURITY_TYPES, REQUIRED_FIELDS, computeAcceptedValue, freeValueOf, prepareSecurity };
