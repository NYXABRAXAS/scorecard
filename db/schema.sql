-- ============================================================================
-- MCF LOS — Score Card Module — PostgreSQL Schema
-- ============================================================================
-- Design notes:
--   * "score_cards" always holds exactly one CURRENT row per application_id
--     (enforced by the partial unique index below). Every mutation additionally
--     writes an immutable snapshot into "score_card_versions" for history/audit.
--   * Soft delete throughout via is_deleted/deleted_at/deleted_by — no hard
--     DELETE is ever issued against score_cards; see API DELETE /score-cards/:id.
--   * All monetary columns are NUMERIC(14,2). All percentage/ratio columns
--     (foir, ltv_cap) are NUMERIC(5,4) stored as a 0-1 ratio, matching the
--     convention already used by the rest of MCF LOS (see workflow-engine.js).
--   * created_at/updated_at are managed by the trigger at the bottom of this
--     file so application code never has to remember to set them.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Reference / master tables
-- ----------------------------------------------------------------------------

CREATE TABLE role_master (
  role_code       VARCHAR(10)  PRIMARY KEY,
  role_label      VARCHAR(80)  NOT NULL,
  permissions     JSONB        NOT NULL DEFAULT '[]', -- e.g. ["camView","camGenerate",...]
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id              BIGSERIAL    PRIMARY KEY,
  employee_id     VARCHAR(20)  NOT NULL UNIQUE,       -- e.g. EMP-1042
  full_name       VARCHAR(120) NOT NULL,
  role_code       VARCHAR(10)  NOT NULL REFERENCES role_master(role_code),
  branch_code     VARCHAR(20),
  password_hash   VARCHAR(255) NOT NULL,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- NOTE: ltv_cap here is informational/admin-display only (kept for the dropdown-master
-- endpoint and historical continuity with the rest of MCF LOS). It is NOT used to
-- compute a security's accepted value — that is done by the formula-based calculator
-- in src/modules/scorecard/securityValuation.js, per the FRD's Section 6.1 Accepted
-- Value Formula table (which is per-type: 100% face/surrender value for most types,
-- with special formulas only for Mortgage and Demat Shares — not a flat LTV cap).
CREATE TABLE security_type_master (
  security_type   VARCHAR(40)  PRIMARY KEY,           -- e.g. 'Gold Ornaments'
  category        VARCHAR(20)  NOT NULL,              -- Primary / Collateral / Subordinate / Guarantee
  is_secured      BOOLEAN      NOT NULL,              -- drives Secured vs Unsecured segment determination
  ltv_cap         NUMERIC(5,4),                        -- informational only — see note above
  approval_authority VARCHAR(60) NOT NULL,
  status          VARCHAR(10)  NOT NULL DEFAULT 'Active',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Decision thresholds for the total_score (out of 100) computed by the 6-factor
-- Score Card engine. NOTE: these thresholds (75 / 60) are an engineering DEFAULT
-- pending Client confirmation — see DOCUMENTATION.md Section 6 "Assumptions".
CREATE TABLE scorecard_decision_band_master (
  id              SMALLSERIAL  PRIMARY KEY,
  min_score       NUMERIC(6,2) NOT NULL,
  max_score       NUMERIC(6,2) NOT NULL,
  band_code       VARCHAR(20)  NOT NULL,               -- ELIGIBLE / CONDITIONAL / NOT_ELIGIBLE
  label           VARCHAR(60)  NOT NULL,
  decision_text   VARCHAR(60)  NOT NULL,
  display_order   SMALLINT     NOT NULL,
  CONSTRAINT chk_band_range CHECK (max_score >= min_score)
);

-- ----------------------------------------------------------------------------
-- Core Score Card entity (one CURRENT row per application_id)
-- ----------------------------------------------------------------------------

CREATE TABLE score_cards (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          VARCHAR(30)   NOT NULL,      -- e.g. MCF-2024-001842 (external LOS case id)
  version                 INT           NOT NULL DEFAULT 1,
  status                  VARCHAR(20)   NOT NULL DEFAULT 'DRAFT',
  -- CHECK enforces the only legal values; see Section 7 (Workflow) of DOCUMENTATION.md
  CONSTRAINT chk_status CHECK (status IN
    ('DRAFT','VALIDATED','SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED')),

  -- --- Inputs driving the 6-factor score & submit guards ---
  chit_value               NUMERIC(14,2) NOT NULL,       -- also treated as the proposed loan amount for Security Coverage
  future_liability         NUMERIC(14,2) NOT NULL,
  security_total_value     NUMERIC(14,2) NOT NULL DEFAULT 0,
  documents_complete       BOOLEAN       NOT NULL DEFAULT FALSE,
  security_covers_liability BOOLEAN      NOT NULL DEFAULT FALSE,
  cibil_complete            BOOLEAN      NOT NULL DEFAULT FALSE,
  gross_monthly_income      NUMERIC(14,2) NOT NULL DEFAULT 0,  -- subscriber's gross monthly income (Income-EMI Coverage input)
  existing_obligations      NUMERIC(14,2) NOT NULL DEFAULT 0,  -- subscriber's existing monthly EMI/obligations
  proposed_emi              NUMERIC(14,2) NOT NULL DEFAULT 0,  -- this loan's proposed monthly instalment

  -- --- Computed 6-factor scoring outputs (see src/modules/scorecard/scoring.engine.js) ---
  -- NOTE: these band boundaries are engineering DEFAULTS pending Client confirmation —
  -- see DOCUMENTATION.md Section 6 "Assumptions" — unlike the security valuation
  -- formula (Section 5.7), which IS sourced from the signed-off FRD.
  cibil_factor_score        NUMERIC(5,2),   -- max 20
  income_emi_score          NUMERIC(5,2),   -- max 20
  security_coverage_score   NUMERIC(5,2),   -- max 15
  dpd_history_score         NUMERIC(5,2),   -- max 20
  enquiry_count_score       NUMERIC(5,2),   -- max 15
  guarantor_quality_score   NUMERIC(5,2),   -- max 10
  total_score               NUMERIC(5,2),   -- sum of the 6 factors, max 100
  eligible                  BOOLEAN,        -- total_score >= 75 (see decisionFor() for the exact threshold)
  decision_text             VARCHAR(60),    -- "Eligible for Approval" / "Conditional - Manual Review Required" / "Not Eligible"

  -- --- Workflow / lifecycle actors ---
  created_by                BIGINT       NOT NULL REFERENCES app_user(id),
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by                BIGINT       REFERENCES app_user(id),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  validated_by               BIGINT       REFERENCES app_user(id),
  validated_at               TIMESTAMPTZ,
  submitted_by               BIGINT       REFERENCES app_user(id),
  submitted_at               TIMESTAMPTZ,
  reviewed_by                 BIGINT       REFERENCES app_user(id),
  reviewed_at                 TIMESTAMPTZ,
  approved_by                 BIGINT       REFERENCES app_user(id),
  approved_at                 TIMESTAMPTZ,
  rejected_by                  BIGINT       REFERENCES app_user(id),
  rejected_at                  TIMESTAMPTZ,
  rejection_reason             TEXT,
  remarks                      TEXT,

  -- --- Soft delete ---
  is_deleted                   BOOLEAN      NOT NULL DEFAULT FALSE,
  deleted_by                   BIGINT       REFERENCES app_user(id),
  deleted_at                   TIMESTAMPTZ
);

-- Exactly one CURRENT (non-deleted) score card per application.
CREATE UNIQUE INDEX uq_score_cards_current_application
  ON score_cards (application_id) WHERE is_deleted = FALSE;

CREATE INDEX idx_score_cards_status ON score_cards (status) WHERE is_deleted = FALSE;
CREATE INDEX idx_score_cards_created_by ON score_cards (created_by);

-- ----------------------------------------------------------------------------
-- Immutable version history — one snapshot row per recompute/update/status change
-- ----------------------------------------------------------------------------

CREATE TABLE score_card_versions (
  id                 BIGSERIAL   PRIMARY KEY,
  score_card_id      UUID        NOT NULL REFERENCES score_cards(id) ON DELETE CASCADE,
  version            INT         NOT NULL,
  status             VARCHAR(20) NOT NULL,
  snapshot           JSONB       NOT NULL,          -- full score_cards row + persons + securities at that point
  change_reason      VARCHAR(40) NOT NULL,          -- CREATE / UPDATE / RECALCULATE / SUBMIT / APPROVE / REJECT
  changed_by         BIGINT      NOT NULL REFERENCES app_user(id),
  changed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (score_card_id, version)
);

CREATE INDEX idx_score_card_versions_card ON score_card_versions (score_card_id, version DESC);

-- ----------------------------------------------------------------------------
-- Subscriber + Guarantor person records (Annexure 2, Section 4)
-- ----------------------------------------------------------------------------

CREATE TABLE score_card_persons (
  id                    BIGSERIAL    PRIMARY KEY,
  score_card_id         UUID         NOT NULL REFERENCES score_cards(id) ON DELETE CASCADE,
  person_role           VARCHAR(15)  NOT NULL,      -- 'SB' or 'SURETY-1', 'SURETY-2', ...
  CONSTRAINT chk_person_role CHECK (person_role = 'SB' OR person_role ~ '^SURETY-[0-9]+$'),
  name                  VARCHAR(120) NOT NULL,
  employment_type       VARCHAR(40),                -- Salaried-Govt / Salaried-Private / Business / Self Employed / Agriculture / Other
  entity_type           VARCHAR(20),                -- PvtLtd / Partnership / Proprietorship (business only)
  years_in_business      NUMERIC(4,1),
  years_of_service       NUMERIC(4,1),
  employee_count         INT,
  staff_count            INT,
  permanent_govt         BOOLEAN,
  customer_vintage_years NUMERIC(4,1),
  personal_visits        INT          NOT NULL DEFAULT 0,
  property_count         INT          NOT NULL DEFAULT 0,
  property_value         NUMERIC(14,2) NOT NULL DEFAULT 0,
  credit_score            INT,                       -- CIBIL / bureau score
  -- Bureau-fetched fields (Section 6.2 factors) — these come from the CIBIL/bureau
  -- report pull, never typed in manually by the Branch Initiator at the score card
  -- step. worst_dpd_days/enquiry_count_6m are read from the SUBSCRIBER row by the
  -- scoring engine; a guarantor row may also carry them for completeness/audit.
  worst_dpd_days          INT,                        -- worst days-past-due across the bureau history; NULL/0 = clean
  enquiry_count_6m        INT,                         -- hard enquiries in the last 6 months
  foir                    NUMERIC(5,4),               -- ratio 0-1
  gross_income            NUMERIC(14,2),
  net_income              NUMERIC(14,2),
  direct_exposure         NUMERIC(14,2) NOT NULL DEFAULT 0,
  indirect_exposure       NUMERIC(14,2) NOT NULL DEFAULT 0,
  suit_filed              BOOLEAN      NOT NULL DEFAULT FALSE,
  prl_flag                BOOLEAN      NOT NULL DEFAULT FALSE,
  cc3_flag                BOOLEAN      NOT NULL DEFAULT FALSE,
  cheque_bounce_count     INT          NOT NULL DEFAULT 0,

  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (score_card_id, person_role)
);

CREATE INDEX idx_score_card_persons_card ON score_card_persons (score_card_id);

-- ----------------------------------------------------------------------------
-- Securities offered (drives security_total_value + is_secured segmentation)
-- ----------------------------------------------------------------------------

CREATE TABLE score_card_securities (
  id                BIGSERIAL   PRIMARY KEY,
  score_card_id     UUID        NOT NULL REFERENCES score_cards(id) ON DELETE CASCADE,
  security_type     VARCHAR(40) NOT NULL REFERENCES security_type_master(security_type),
  holder_name       VARCHAR(120),
  loyalty_usn       VARCHAR(40),
  -- Type-specific raw inputs to the Accepted Value Formula (FRD Section 6.1, Table 20)
  -- e.g. {"netWeightGrams":145,"ratePerGram":6200} for Gold, {"surrenderValue":250000}
  -- for LIC Policy, etc. — see src/modules/scorecard/securityValuation.js. Kept as JSONB
  -- since required fields differ by type; free_value/value_loaded below are always the
  -- server-computed summary, never trusted from client input.
  valuation_inputs  JSONB       NOT NULL DEFAULT '{}',
  free_value        NUMERIC(14,2) NOT NULL,           -- gross/reference value before any formula reduction
  value_loaded      NUMERIC(14,2) NOT NULL,           -- accepted value AFTER the type-specific formula — server-computed
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_score_card_securities_card ON score_card_securities (score_card_id);

-- ----------------------------------------------------------------------------
-- Supporting documents
-- ----------------------------------------------------------------------------

CREATE TABLE score_card_documents (
  id                BIGSERIAL   PRIMARY KEY,
  score_card_id     UUID        NOT NULL REFERENCES score_cards(id) ON DELETE CASCADE,
  document_type     VARCHAR(40) NOT NULL,             -- DPN / KYC / Gold Appraisal / Income Proof / ...
  file_name         VARCHAR(255) NOT NULL,
  file_url          TEXT        NOT NULL,
  mime_type         VARCHAR(100),
  file_size_bytes   BIGINT,
  uploaded_by       BIGINT      NOT NULL REFERENCES app_user(id),
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted        BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX idx_score_card_documents_card ON score_card_documents (score_card_id) WHERE is_deleted = FALSE;

-- ----------------------------------------------------------------------------
-- Audit log — append-only, every mutating action writes exactly one row here
-- ----------------------------------------------------------------------------

CREATE TABLE score_card_audit_logs (
  id                BIGSERIAL   PRIMARY KEY,
  score_card_id     UUID        REFERENCES score_cards(id) ON DELETE SET NULL,
  application_id    VARCHAR(30) NOT NULL,             -- denormalised for fast lookup even if score card is later hard-purged
  actor_user_id     BIGINT      NOT NULL REFERENCES app_user(id),
  actor_role        VARCHAR(10) NOT NULL,
  actor_label       VARCHAR(80) NOT NULL,
  action            VARCHAR(20) NOT NULL,
  CONSTRAINT chk_audit_action CHECK (action IN
    ('CREATE','UPDATE','SAVE_DRAFT','VALIDATE','SUBMIT','APPROVE','REJECT','RECALCULATE','DELETE','DOC_UPLOAD')),
  detail            TEXT,
  old_value         JSONB,
  new_value         JSONB,
  ip_address        INET,
  user_agent        VARCHAR(255),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_card ON score_card_audit_logs (score_card_id, created_at DESC);
CREATE INDEX idx_audit_logs_application ON score_card_audit_logs (application_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- updated_at maintenance trigger
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_score_cards_updated_at
  BEFORE UPDATE ON score_cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_score_card_persons_updated_at
  BEFORE UPDATE ON score_card_persons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
