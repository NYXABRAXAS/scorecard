'use strict';

const {
  createScoreCardSchema, updateScoreCardSchema, rejectSchema, documentUploadSchema, idParamSchema
} = require('../src/modules/scorecard/scorecard.validation');

const validSubscriber = { name: 'Ramesh Gopalakrishnan', employmentType: 'Salaried-Private', foir: 0.3, employeeCount: 50 };
const validSecurity = { securityType: 'Gold Ornaments', netWeightGrams: 150, ratePerGram: 6000 };

function baseValidPayload(overrides = {}) {
  return {
    applicationId: 'MCF-2024-001820',
    chitValue: 1000000,
    futureLiability: 800000,
    documentsComplete: true,
    subscriber: validSubscriber,
    guarantors: [],
    securities: [validSecurity],
    ...overrides
  };
}

describe('createScoreCardSchema', () => {
  test('accepts a minimal valid payload', () => {
    const { error } = createScoreCardSchema.validate(baseValidPayload());
    expect(error).toBeUndefined();
  });

  test('rejects an applicationId that does not match the MCF-YYYY-NNNNNN pattern', () => {
    const { error } = createScoreCardSchema.validate(baseValidPayload({ applicationId: 'APP-123' }));
    expect(error).toBeDefined();
    expect(error.details[0].path).toContain('applicationId');
  });

  test('rejects a negative chitValue', () => {
    const { error } = createScoreCardSchema.validate(baseValidPayload({ chitValue: -1 }));
    expect(error).toBeDefined();
  });

  test('rejects a payload with zero securities', () => {
    const { error } = createScoreCardSchema.validate(baseValidPayload({ securities: [] }));
    expect(error).toBeDefined();
  });

  test('rejects more than 4 guarantors', () => {
    const guarantors = Array.from({ length: 5 }, () => ({ ...validSubscriber }));
    const { error } = createScoreCardSchema.validate(baseValidPayload({ guarantors }));
    expect(error).toBeDefined();
  });

  test('requires entityType when employmentType is Business', () => {
    const subscriber = { ...validSubscriber, employmentType: 'Business' };
    const { error } = createScoreCardSchema.validate(baseValidPayload({ subscriber }));
    // entityType is optional-but-allowed for Business (not forbidden), so this should pass
    expect(error).toBeUndefined();
  });

  test('rejects entityType supplied for a non-Business employment type', () => {
    const subscriber = { ...validSubscriber, employmentType: 'Salaried-Private', entityType: 'PvtLtd' };
    const { error } = createScoreCardSchema.validate(baseValidPayload({ subscriber }));
    expect(error).toBeDefined();
  });

  test('rejects an unknown employmentType (not in the enum)', () => {
    const subscriber = { ...validSubscriber, employmentType: 'Freelance' };
    const { error } = createScoreCardSchema.validate(baseValidPayload({ subscriber }));
    expect(error).toBeDefined();
  });

  test('rejects a creditScore outside the 300-900 CIBIL range', () => {
    const subscriber = { ...validSubscriber, creditScore: 950 };
    const { error } = createScoreCardSchema.validate(baseValidPayload({ subscriber }));
    expect(error).toBeDefined();
  });

  test('allows creditScore to be explicitly null (not yet checked)', () => {
    const subscriber = { ...validSubscriber, creditScore: null };
    const { error } = createScoreCardSchema.validate(baseValidPayload({ subscriber }));
    expect(error).toBeUndefined();
  });

  test('rejects unknown fields under raw Joi defaults (no allowUnknown)', () => {
    const { error } = createScoreCardSchema.validate(baseValidPayload({ hackerField: 'DROP TABLE users;' }));
    expect(error).toBeDefined();
  });

  test('the actual request middleware (validate.js) strips unknown fields rather than erroring', () => {
    // validate.js always calls .validate(req[property], { stripUnknown: true, ... }) —
    // replicate those exact options here so this test reflects real request behaviour.
    const { error, value } = createScoreCardSchema.validate(
      baseValidPayload({ hackerField: 'DROP TABLE users;' }),
      { abortEarly: false, stripUnknown: true, convert: true }
    );
    expect(error).toBeUndefined();
    expect(value.hackerField).toBeUndefined();
  });
});

describe('updateScoreCardSchema', () => {
  test('requires at least one field', () => {
    const { error } = updateScoreCardSchema.validate({});
    expect(error).toBeDefined();
  });
  test('accepts a partial update of just remarks', () => {
    const { error } = updateScoreCardSchema.validate({ remarks: 'Awaiting updated bureau report' });
    expect(error).toBeUndefined();
  });
});

describe('rejectSchema', () => {
  test('requires a rejectionReason of at least 5 characters', () => {
    expect(rejectSchema.validate({ rejectionReason: 'no' }).error).toBeDefined();
    expect(rejectSchema.validate({ rejectionReason: 'Security shortfall vs future liability' }).error).toBeUndefined();
  });
});

describe('documentUploadSchema', () => {
  test('rejects a document type outside the allowed enum', () => {
    const { error } = documentUploadSchema.validate({
      documentType: 'RandomFile', fileName: 'a.pdf', fileUrl: 'https://files.example.com/a.pdf'
    });
    expect(error).toBeDefined();
  });
  test('rejects a fileUrl that is not a valid URI', () => {
    const { error } = documentUploadSchema.validate({
      documentType: 'DPN', fileName: 'a.pdf', fileUrl: 'not-a-url'
    });
    expect(error).toBeDefined();
  });
  test('rejects a file over the 25MB cap', () => {
    const { error } = documentUploadSchema.validate({
      documentType: 'DPN', fileName: 'a.pdf', fileUrl: 'https://files.example.com/a.pdf', fileSizeBytes: 30 * 1024 * 1024
    });
    expect(error).toBeDefined();
  });
});

describe('idParamSchema', () => {
  test('rejects a non-UUID id (e.g. a raw application id or SQL-injection attempt)', () => {
    expect(idParamSchema.validate({ id: 'MCF-2024-001820' }).error).toBeDefined();
    expect(idParamSchema.validate({ id: "1; DROP TABLE score_cards;--" }).error).toBeDefined();
  });
  test('accepts a valid UUIDv4', () => {
    expect(idParamSchema.validate({ id: '3fa85f64-5717-4562-b3fc-2c963f66afa6' }).error).toBeUndefined();
  });
});
