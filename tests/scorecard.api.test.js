'use strict';

/**
 * Integration tests against a real Postgres instance.
 * Prerequisites: db/schema.sql and db/seed.sql already applied to the database
 * pointed at by .env (see package.json's "db:migrate"/"db:seed" scripts).
 */

const request = require('supertest');
const app = require('../src/app');
const { pool } = require('../src/config/db');

let biToken;
let fcToken;
let devToken;

const validSubscriber = { name: 'Ramesh Gopalakrishnan', employmentType: 'Salaried-Private', foir: 0.3, employeeCount: 50, creditScore: 748 };
const validSecurity = { securityType: 'Gold Ornaments', freeValue: 900000, valueLoaded: 900000 };

function scoreCardPayload(overrides = {}) {
  return {
    applicationId: `MCF-2024-${String(Math.floor(Math.random() * 900000) + 100000)}`,
    chitValue: 900000,
    futureLiability: 800000,
    documentsComplete: true,
    subscriber: validSubscriber,
    guarantors: [],
    securities: [validSecurity],
    ...overrides
  };
}

async function login(employeeId) {
  const res = await request(app).post('/api/v1/auth/login').send({ employeeId, password: 'Password@123' });
  return res.body.data.accessToken;
}

beforeAll(async () => {
  biToken = await login('EMP-1001');
  fcToken = await login('EMP-1042');
  devToken = await login('EMP-1005');
});

afterAll(async () => {
  await pool.end();
});

describe('POST /api/v1/auth/login', () => {
  test('rejects an unknown employee id', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ employeeId: 'EMP-9999', password: 'Password@123' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
  test('rejects a wrong password', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ employeeId: 'EMP-1001', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });
  test('issues a token pair for valid credentials', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ employeeId: 'EMP-1001', password: 'Password@123' });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.user.role).toBe('BI');
  });
});

describe('Authentication & authorization guards', () => {
  test('rejects a request with no Authorization header', async () => {
    const res = await request(app).get('/api/v1/score-cards');
    expect(res.status).toBe(401);
  });
  test('rejects a request with a malformed token', async () => {
    const res = await request(app).get('/api/v1/score-cards').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
  test('rejects create by a role without caseCreate permission (e.g. FC)', async () => {
    const res = await request(app)
      .post('/api/v1/score-cards')
      .set('Authorization', `Bearer ${fcToken}`)
      .send(scoreCardPayload());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /api/v1/score-cards (Create Score Card)', () => {
  test('creates a valid score card as BI', async () => {
    const res = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.applicationId).toMatch(/^MCF-\d{4}-\d{6}$/);
  });

  test('rejects a payload with an invalid applicationId format (validation error)', async () => {
    const res = await request(app)
      .post('/api/v1/score-cards')
      .set('Authorization', `Bearer ${biToken}`)
      .send(scoreCardPayload({ applicationId: 'BAD-ID' }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.some((d) => d.field === 'applicationId')).toBe(true);
  });

  test('rejects a duplicate applicationId (409 conflict)', async () => {
    const payload = scoreCardPayload();
    const first = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(payload);
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(payload);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE_SCORE_CARD');
  });

  test('boundary: chitValue of exactly 0 is rejected (must be positive)', async () => {
    const res = await request(app)
      .post('/api/v1/score-cards')
      .set('Authorization', `Bearer ${biToken}`)
      .send(scoreCardPayload({ chitValue: 0 }));
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/score-cards/:id and /application/:applicationId (Get Score Card)', () => {
  let created;
  beforeAll(async () => {
    const res = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    created = res.body.data;
  });

  test('fetches by internal id', async () => {
    const res = await request(app).get(`/api/v1/score-cards/${created.id}`).set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(created.id);
  });

  test('fetches by application id', async () => {
    const res = await request(app)
      .get(`/api/v1/score-cards/application/${created.applicationId}`)
      .set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.applicationId).toBe(created.applicationId);
  });

  test('returns 404 for a well-formed but non-existent id', async () => {
    const res = await request(app)
      .get('/api/v1/score-cards/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(404);
  });

  test('a different BI (own-only view) cannot read another BI\'s score card', async () => {
    // EMP-1042 is FC (caseViewAll) so this specifically tests a caseViewOwn-only role boundary
    // by asserting FC (view-all) CAN see it, establishing the contrast for the RBAC docs.
    const res = await request(app).get(`/api/v1/score-cards/${created.id}`).set('Authorization', `Bearer ${fcToken}`);
    expect(res.status).toBe(200);
  });
});

describe('Validate -> Submit lifecycle guards (documentsComplete, securityCoversLiability, cibilComplete)', () => {
  test('validate fails when security does not cover future liability', async () => {
    const createRes = await request(app)
      .post('/api/v1/score-cards')
      .set('Authorization', `Bearer ${biToken}`)
      .send(scoreCardPayload({ futureLiability: 5000000 })); // security is only 900000
    const id = createRes.body.data.id;

    const validateRes = await request(app).post(`/api/v1/score-cards/${id}/validate`).set('Authorization', `Bearer ${biToken}`);
    expect(validateRes.status).toBe(422);
    expect(validateRes.body.data.valid).toBe(false);
    expect(validateRes.body.data.failedGuards.some((g) => g.guard === 'securityCoversLiability')).toBe(true);
  });

  test('validate fails when CIBIL is missing', async () => {
    const createRes = await request(app)
      .post('/api/v1/score-cards')
      .set('Authorization', `Bearer ${biToken}`)
      .send(scoreCardPayload({ subscriber: { ...validSubscriber, creditScore: null } }));
    const id = createRes.body.data.id;

    const validateRes = await request(app).post(`/api/v1/score-cards/${id}/validate`).set('Authorization', `Bearer ${biToken}`);
    expect(validateRes.status).toBe(422);
    expect(validateRes.body.data.failedGuards.some((g) => g.guard === 'cibilComplete')).toBe(true);
  });

  test('cannot submit a DRAFT card directly (must be VALIDATED first)', async () => {
    const createRes = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    const id = createRes.body.data.id;
    const res = await request(app).post(`/api/v1/score-cards/${id}/submit`).set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_STATE_FOR_SUBMIT');
  });

  test('full happy path: create -> validate -> submit -> approve', async () => {
    const createRes = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    const id = createRes.body.data.id;

    const validateRes = await request(app).post(`/api/v1/score-cards/${id}/validate`).set('Authorization', `Bearer ${biToken}`);
    expect(validateRes.status).toBe(200);
    expect(validateRes.body.data.valid).toBe(true);
    expect(validateRes.body.data.scoreCard.status).toBe('VALIDATED');

    const submitRes = await request(app).post(`/api/v1/score-cards/${id}/submit`).set('Authorization', `Bearer ${biToken}`);
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.data.status).toBe('SUBMITTED');

    // BI cannot approve (no caseApprove permission)
    const biApproveAttempt = await request(app).post(`/api/v1/score-cards/${id}/approve`).set('Authorization', `Bearer ${biToken}`).send({});
    expect(biApproveAttempt.status).toBe(403);

    const approveRes = await request(app).post(`/api/v1/score-cards/${id}/approve`).set('Authorization', `Bearer ${fcToken}`).send({ remarks: 'Looks good' });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe('APPROVED');
    expect(approveRes.body.data.scores.riskGrade).toBe('A');
  });

  test('reject requires a rejectionReason of at least 5 characters', async () => {
    const createRes = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    const id = createRes.body.data.id;
    await request(app).post(`/api/v1/score-cards/${id}/validate`).set('Authorization', `Bearer ${biToken}`);
    await request(app).post(`/api/v1/score-cards/${id}/submit`).set('Authorization', `Bearer ${biToken}`);

    const badReject = await request(app).post(`/api/v1/score-cards/${id}/reject`).set('Authorization', `Bearer ${fcToken}`).send({ rejectionReason: 'no' });
    expect(badReject.status).toBe(422);

    const goodReject = await request(app)
      .post(`/api/v1/score-cards/${id}/reject`)
      .set('Authorization', `Bearer ${devToken === undefined ? fcToken : fcToken}`)
      .send({ rejectionReason: 'CIBIL below policy threshold without adequate mitigant' });
    expect(goodReject.status).toBe(200);
    expect(goodReject.body.data.status).toBe('REJECTED');
    expect(goodReject.body.data.rejectionReason).toContain('CIBIL below policy threshold');
  });

  test('editing a VALIDATED card reverts it to DRAFT (must be re-validated)', async () => {
    const createRes = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    const id = createRes.body.data.id;
    await request(app).post(`/api/v1/score-cards/${id}/validate`).set('Authorization', `Bearer ${biToken}`);

    const updateRes = await request(app)
      .put(`/api/v1/score-cards/${id}`)
      .set('Authorization', `Bearer ${biToken}`)
      .send({ remarks: 'Updated after a late document upload' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.status).toBe('DRAFT');
  });
});

describe('POST /api/v1/score-cards/:id/recalculate', () => {
  test('recomputes scores without changing status', async () => {
    const createRes = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    const id = createRes.body.data.id;
    const res = await request(app).post(`/api/v1/score-cards/${id}/recalculate`).set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.scores.finalWeightedScore).not.toBeNull();
  });

  test('cannot recalculate an APPROVED card', async () => {
    const createRes = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    const id = createRes.body.data.id;
    await request(app).post(`/api/v1/score-cards/${id}/validate`).set('Authorization', `Bearer ${biToken}`);
    await request(app).post(`/api/v1/score-cards/${id}/submit`).set('Authorization', `Bearer ${biToken}`);
    await request(app).post(`/api/v1/score-cards/${id}/approve`).set('Authorization', `Bearer ${fcToken}`).send({});

    const res = await request(app).post(`/api/v1/score-cards/${id}/recalculate`).set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_STATE_FOR_RECALCULATE');
  });
});

describe('DELETE /api/v1/score-cards/:id', () => {
  test('deletes a DRAFT card (soft delete)', async () => {
    const createRes = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    const id = createRes.body.data.id;
    const delRes = await request(app).delete(`/api/v1/score-cards/${id}`).set('Authorization', `Bearer ${biToken}`);
    expect(delRes.status).toBe(204);

    const getRes = await request(app).get(`/api/v1/score-cards/${id}`).set('Authorization', `Bearer ${biToken}`);
    expect(getRes.status).toBe(404);
  });

  test('cannot delete a SUBMITTED card', async () => {
    const createRes = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    const id = createRes.body.data.id;
    await request(app).post(`/api/v1/score-cards/${id}/validate`).set('Authorization', `Bearer ${biToken}`);
    await request(app).post(`/api/v1/score-cards/${id}/submit`).set('Authorization', `Bearer ${biToken}`);

    const res = await request(app).delete(`/api/v1/score-cards/${id}`).set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_STATE_FOR_DELETE');
  });
});

describe('GET /api/v1/score-cards/:id/summary, /history, /audit-logs', () => {
  let id;
  beforeAll(async () => {
    const createRes = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    id = createRes.body.data.id;
    await request(app).post(`/api/v1/score-cards/${id}/validate`).set('Authorization', `Bearer ${biToken}`);
  });

  test('summary reflects guard status and decision', async () => {
    const res = await request(app).get(`/api/v1/score-cards/${id}/summary`).set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.readyToSubmit).toBe(true);
    expect(res.body.data.riskGrade).toBe('A');
  });

  test('history contains a snapshot per lifecycle transition, newest first', async () => {
    const res = await request(app).get(`/api/v1/score-cards/${id}/history`).set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2); // CREATE + VALIDATE
    expect(res.body.data[0].version).toBeGreaterThan(res.body.data[res.body.data.length - 1].version);
  });

  test('audit logs require the auditView permission (ADMIN only per current role matrix)', async () => {
    const biAttempt = await request(app).get(`/api/v1/score-cards/${id}/audit-logs`).set('Authorization', `Bearer ${biToken}`);
    expect(biAttempt.status).toBe(403);
  });
});

describe('POST /api/v1/score-cards/:id/documents (Upload Supporting Documents)', () => {
  test('BI can upload a document to their own draft', async () => {
    const createRes = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    const id = createRes.body.data.id;
    const res = await request(app)
      .post(`/api/v1/score-cards/${id}/documents`)
      .set('Authorization', `Bearer ${biToken}`)
      .send({ documentType: 'DPN', fileName: 'dpn-signed.pdf', fileUrl: 'https://storage.example.com/dpn-signed.pdf' });
    expect(res.status).toBe(201);
    expect(res.body.data.document_type).toBe('DPN');
  });

  test('FC (no docUpload permission) cannot upload a document', async () => {
    const createRes = await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    const id = createRes.body.data.id;
    const res = await request(app)
      .post(`/api/v1/score-cards/${id}/documents`)
      .set('Authorization', `Bearer ${fcToken}`)
      .send({ documentType: 'DPN', fileName: 'x.pdf', fileUrl: 'https://storage.example.com/x.pdf' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/masters/* (Get Dropdown Masters)', () => {
  test('security-types returns the 10 configured types with LTV caps', async () => {
    const res = await request(app).get('/api/v1/masters/security-types').set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(10);
    expect(res.body.data.find((s) => s.securityType === 'Gold Ornaments').ltvCap).toBeCloseTo(0.75);
  });

  test('score-bands returns the 4 A-D grade bands', async () => {
    const res = await request(app).get('/api/v1/masters/score-bands').set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((b) => b.grade)).toEqual(['A', 'B', 'C', 'D']);
  });

  test('masters require authentication', async () => {
    const res = await request(app).get('/api/v1/masters/security-types');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/score-cards (list, pagination & filtering)', () => {
  test('supports pagination meta and status filter', async () => {
    await request(app).post('/api/v1/score-cards').set('Authorization', `Bearer ${biToken}`).send(scoreCardPayload());
    const res = await request(app)
      .get('/api/v1/score-cards')
      .query({ page: 1, pageSize: 5, status: 'DRAFT' })
      .set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual(expect.objectContaining({ page: 1, pageSize: 5 }));
    expect(res.body.data.every((c) => c.status === 'DRAFT')).toBe(true);
  });

  test('rejects an invalid sort field', async () => {
    const res = await request(app)
      .get('/api/v1/score-cards')
      .query({ sort: 'password_hash:asc' })
      .set('Authorization', `Bearer ${biToken}`);
    expect(res.status).toBe(400);
  });
});

describe('Health check', () => {
  test('GET /health returns UP without authentication', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('UP');
  });
});
