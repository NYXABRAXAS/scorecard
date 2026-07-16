-- ============================================================================
-- Seed data for master tables — mirrors the live MCF LOS configuration
-- (assets/json/security-types.json, product-config.json, roles-permissions.json)
-- so Score Card calculations match the rest of the LOS exactly.
-- ============================================================================

INSERT INTO role_master (role_code, role_label, permissions) VALUES
  ('BI',    'Branch Initiator',        '["caseCreate","caseEdit","caseSubmit","caseViewOwn","docUpload","reportsView"]'),
  ('BS',    'Branch Scrutinizer',      '["caseViewAll","caseApprove","caseReject","caseReturn","docVerify","docRequest","reportsView"]'),
  ('HUB',   'Credit Hub Controller',   '["caseViewAll","docVerify","fiAssign","reportsView"]'),
  ('FI',    'Field Investigator',      '["fiAccept","fiVisit","fiSubmitReport","caseViewOwn","reportsView"]'),
  ('FC',    'Credit Final Checker',    '["caseViewAll","camView","camGenerate","camEdit","financialAnalysis","riskAnalysis","caseApprove","caseReject","caseReturn","reportsView"]'),
  ('DEV',   'Deviation Authority',     '["caseViewAll","camView","deviationApprove","deviationReject","reportsView"]'),
  ('RA',    'Recommending Authority',  '["caseViewAll","camView","camEdit","caseApprove","caseReject","caseHold","reportsView"]'),
  ('CH',    'Credit Head',             '["caseViewAll","camView","camEdit","caseApprove","caseReject","loanModify","roiModify","tenureModify","reportsView"]'),
  ('FA',    'Final Approval Authority','["caseViewAll","camView","caseApprove","caseReject","reportsView"]'),
  ('BA',    'Business Approver',       '["caseViewAll","camView","caseApprove","caseReject","caseHold","reportsView"]'),
  ('DISB',  'Disbursement Team',       '["caseViewAll","sanctionLetter","agreementGenerate","nachUpload","loanAccountGenerate","disburse","reportsView"]'),
  ('ADMIN', 'System Admin',            '["caseViewAll","camView","adminUserManage","adminConfig","auditView","reportsView"]');

INSERT INTO security_type_master (security_type, category, is_secured, ltv_cap, approval_authority) VALUES
  ('Gold Ornaments',     'Primary',     TRUE,  0.75, 'Branch Manager'),
  ('LIC Policy',         'Primary',     TRUE,  0.85, 'Hub Controller'),
  ('Bank Guarantee',     'Primary',     TRUE,  1.00, 'Credit Head'),
  ('Fixed Deposit',      'Primary',     TRUE,  0.90, 'Hub Controller'),
  ('Mortgage (Property)','Collateral',  FALSE, 0.60, 'Credit Head'),
  ('Chit Passbook',      'Primary',     TRUE,  0.80, 'Branch Manager'),
  ('Sub-Debt',           'Subordinate', TRUE,  0.70, 'Recommending Authority'),
  ('Demat NCD',          'Primary',     TRUE,  0.83, 'Hub Controller'),
  ('Demat Shares',       'Primary',     TRUE,  0.60, 'Credit Head'),
  ('Personal Surety',    'Guarantee',   FALSE, NULL, 'Branch Manager');

-- A minimal set of demo users, one per role, for local development / Swagger try-it-out.
-- password_hash below is bcrypt('Password@123', 10) — CHANGE before any non-local use.
INSERT INTO app_user (employee_id, full_name, role_code, branch_code, password_hash) VALUES
  ('EMP-1001', 'Arun Kumar S',       'BI',    'BR-CHN-01', '$2a$10$pAeDdgtEUuE9qb4iAamU6.upGn.t5mThKhX9Lo16kDO59b0.vLqVG'),
  ('EMP-1005', 'Deviation Desk',     'DEV',   NULL,         '$2a$10$pAeDdgtEUuE9qb4iAamU6.upGn.t5mThKhX9Lo16kDO59b0.vLqVG'),
  ('EMP-1010', 'Credit Head Office', 'CH',    NULL,         '$2a$10$pAeDdgtEUuE9qb4iAamU6.upGn.t5mThKhX9Lo16kDO59b0.vLqVG'),
  ('EMP-1042', 'Priya Narayanan',    'FC',    'HUB-CHN',    '$2a$10$pAeDdgtEUuE9qb4iAamU6.upGn.t5mThKhX9Lo16kDO59b0.vLqVG'),
  ('EMP-9001', 'System Admin',      'ADMIN', NULL,          '$2a$10$pAeDdgtEUuE9qb4iAamU6.upGn.t5mThKhX9Lo16kDO59b0.vLqVG');
