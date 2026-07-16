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

-- ----------------------------------------------------------------------------
-- Credit Score parameter matrix — the single source of truth is "Credit Score.xlsx"
-- (two sheets: "Employee" = SALARIED profile, "Business" = BUSINESS profile).
-- Every parameter, option, weightage and max-score value below is loaded verbatim
-- from that workbook by db/seed_credit_score.sql (generated, not hand-typed) — see
-- DOCUMENTATION.md Section 19 "Excel-to-Application Mapping" for the full trace.
--
-- Design: QUANTITATIVE parameters are answered by picking one option from a fixed
-- dropdown list (scorecard_parameter_option_master); net score = maxScore x
-- option.weightage. QUALITATIVE parameters are yes/no flags with a fixed penalty;
-- net score = maxScore (already negative) x flag(0/1). This mirrors the Excel's
-- own structure exactly: every quantitative parameter has a merged "selector" cell
-- validated against a dropdown list of options immediately below it, and the 7
-- qualitative items are plain yes/no checks with a fixed penalty each.
--
-- NOTE: the Excel defines NO eligibility/pass-fail threshold on the Total Final
-- Score — it only computes the number. No such threshold is invented here either;
-- see DOCUMENTATION.md Section 20 "Open Questions".
-- ----------------------------------------------------------------------------

CREATE TABLE scorecard_parameter_master (
  id              BIGSERIAL    PRIMARY KEY,
  profile_type    VARCHAR(10)  NOT NULL,
  CONSTRAINT chk_param_profile CHECK (profile_type IN ('SALARIED','BUSINESS')),
  sl_no           VARCHAR(10)  NOT NULL,     -- '1'..'14' for quantitative, 'a'..'g' for qualitative
  name            TEXT         NOT NULL,     -- exact Excel wording, per profile
  category        VARCHAR(12)  NOT NULL,
  CONSTRAINT chk_param_category CHECK (category IN ('QUANTITATIVE','QUALITATIVE')),
  max_score       NUMERIC(6,2) NOT NULL,     -- negative for QUALITATIVE (a fixed penalty)
  display_order   INT          NOT NULL,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  UNIQUE (profile_type, sl_no)
);

CREATE INDEX idx_parameter_master_profile ON scorecard_parameter_master (profile_type, display_order);

CREATE TABLE scorecard_parameter_option_master (
  id              BIGSERIAL    PRIMARY KEY,
  parameter_id    BIGINT       NOT NULL REFERENCES scorecard_parameter_master(id) ON DELETE CASCADE,
  option_label    TEXT         NOT NULL,     -- exact Excel wording, incl. its typos/spacing
  weightage       NUMERIC(5,4) NOT NULL,     -- 0-1 ratio, as given in the Excel's weightage column
  display_order   INT          NOT NULL,
  UNIQUE (parameter_id, option_label)
);

CREATE INDEX idx_parameter_option_param ON scorecard_parameter_option_master (parameter_id, display_order);

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

  -- --- Inputs driving submit guards (independent of the Credit Score matrix) ---
  chit_value               NUMERIC(14,2) NOT NULL,       -- proposed loan / prize amount
  future_liability         NUMERIC(14,2) NOT NULL,
  security_total_value     NUMERIC(14,2) NOT NULL DEFAULT 0,
  documents_complete       BOOLEAN       NOT NULL DEFAULT FALSE,
  security_covers_liability BOOLEAN      NOT NULL DEFAULT FALSE,
  cibil_complete            BOOLEAN      NOT NULL DEFAULT FALSE,  -- true once every person has answered the "CIBIL Score" parameter

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
-- Subscriber + Guarantor person records.
--
-- Every scored attribute (age, occupation, income, CIBIL band, cheque-return
-- history, etc.) lives in score_card_person_responses below, driven by whichever
-- profile_type applies to this person — NOT as columns here. This mirrors the
-- Excel exactly: each sheet ("Employee"/"Business") is filled in once per
-- subscriber-or-guarantor, independently: there is no cross-person blending
-- formula anywhere in the workbook.
-- ----------------------------------------------------------------------------

CREATE TABLE score_card_persons (
  id                    BIGSERIAL    PRIMARY KEY,
  score_card_id         UUID         NOT NULL REFERENCES score_cards(id) ON DELETE CASCADE,
  person_role           VARCHAR(15)  NOT NULL,      -- 'SB' or 'SURETY-1', 'SURETY-2', ...
  CONSTRAINT chk_person_role CHECK (person_role = 'SB' OR person_role ~ '^SURETY-[0-9]+$'),
  name                  VARCHAR(120) NOT NULL,
  profile_type          VARCHAR(10)  NOT NULL,       -- which Excel sheet applies to this person
  CONSTRAINT chk_person_profile CHECK (profile_type IN ('SALARIED','BUSINESS')),

  -- Computed by src/modules/scorecard/creditScoreEngine.js — never hand-set.
  total_score           NUMERIC(6,2),    -- sum of QUANTITATIVE net scores (Excel "Total Score", max 100)
  total_final_score     NUMERIC(7,2),    -- total_score + sum of QUALITATIVE penalties (Excel "Total Final Score")

  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (score_card_id, person_role)
);

CREATE INDEX idx_score_card_persons_card ON score_card_persons (score_card_id);

-- ----------------------------------------------------------------------------
-- One row per (person, parameter) answer — the actual filled-in Credit Score sheet.
-- ----------------------------------------------------------------------------

CREATE TABLE score_card_person_responses (
  id                      BIGSERIAL    PRIMARY KEY,
  score_card_person_id    BIGINT       NOT NULL REFERENCES score_card_persons(id) ON DELETE CASCADE,
  parameter_id            BIGINT       NOT NULL REFERENCES scorecard_parameter_master(id),
  selected_option_id      BIGINT       REFERENCES scorecard_parameter_option_master(id), -- QUANTITATIVE
  qualitative_flag        BOOLEAN,                                                        -- QUALITATIVE
  net_score               NUMERIC(7,2) NOT NULL,   -- server-computed: maxScore x weightage, or maxScore x flag
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- One answer per parameter per person — the "no duplicate mappings" rule enforced at the DB level.
  UNIQUE (score_card_person_id, parameter_id)
);

CREATE INDEX idx_person_responses_person ON score_card_person_responses (score_card_person_id);

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

CREATE TRIGGER trg_person_responses_updated_at
  BEFORE UPDATE ON score_card_person_responses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
