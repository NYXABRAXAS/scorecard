# MCF LOS — Score Card API

REST API for the Score Card module of the MCF Prize-Money-Against-Security Loan
Origination System — subscriber/guarantor credit risk scoring per the Risk-Assessment
Scoring Engine (Annexure 2), with a full Draft → Validate → Submit → Approve/Reject
lifecycle, audit trail, and version history.

**Full technical documentation: [DOCUMENTATION.md](DOCUMENTATION.md)**
**API reference: [openapi.yaml](openapi.yaml)** (also served at `GET /docs` once running)

## Quickstart

```bash
npm install
cp .env.example .env          # then edit DB_* and JWT_SECRET
createdb mcf_scorecard         # or: psql -c "CREATE DATABASE mcf_scorecard;"
npm run db:migrate
npm run db:seed
npm run dev                    # http://localhost:4000, docs at /docs
```

Demo login (seeded users, password `Password@123` for all):

| employeeId | role |
|---|---|
| EMP-1001 | BI (Branch Initiator) |
| EMP-1042 | FC (Credit Final Checker) |
| EMP-1005 | DEV (Deviation Authority) |
| EMP-1010 | CH (Credit Head) |
| EMP-9001 | ADMIN |

```bash
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"EMP-1001","password":"Password@123"}'
```

## Tests

```bash
npm test
```

136 tests (81 calculation-engine unit tests + 20 validation-schema tests + 35 API
integration tests), all runnable against a real PostgreSQL instance — see
[DOCUMENTATION.md §14](DOCUMENTATION.md#14-test-cases).

## Stack

Node.js 18+ · Express · PostgreSQL (`pg`, raw parameterised SQL — no ORM) · Joi
(validation) · JWT (`jsonwebtoken`) · Jest + Supertest (tests) · OpenAPI 3.0 +
Swagger UI (docs).
