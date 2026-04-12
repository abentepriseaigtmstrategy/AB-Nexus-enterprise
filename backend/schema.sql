-- =====================================================
-- McLARENS NEXUS ENTERPRISE v5.0 — DATABASE SCHEMA
-- INSURER-FIRST ARCHITECTURE
-- =====================================================

DROP TABLE IF EXISTS ai_audit_logs;
DROP TABLE IF EXISTS pending_documents;
DROP TABLE IF EXISTS claim_documents;
DROP TABLE IF EXISTS insurer_department_rules;
DROP TABLE IF EXISTS insurance_companies;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS chat_history;
DROP TABLE IF EXISTS survey_reports;
DROP TABLE IF EXISTS claims;
DROP TABLE IF EXISTS leave_requests;
DROP TABLE IF EXISTS leave_balances;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS payroll;
DROP TABLE IF EXISTS performance_reviews;
DROP TABLE IF EXISTS grievances;
DROP TABLE IF EXISTS recruitment_jobs;
DROP TABLE IF EXISTS candidates;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS attendance;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;
DROP TABLE IF EXISTS system_config;

-- =====================================================
-- TENANTS
-- =====================================================
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subscription_tier TEXT DEFAULT 'basic',
  isolation_level TEXT DEFAULT 'row',
  settings TEXT,
  logo_url TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER
);

-- =====================================================
-- USERS & AUTH
-- =====================================================
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'surveyor',
  tenant_id TEXT NOT NULL,
  insurer_id TEXT,
  password_hash TEXT,
  password_salt TEXT,
  google_id TEXT UNIQUE,
  magic_link_token TEXT,
  magic_link_expires INTEGER,
  email_verified INTEGER DEFAULT 0,
  avatar_url TEXT,
  department TEXT,
  phone TEXT,
  is_active INTEGER DEFAULT 1,
  last_login INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX idx_users_email  ON users(email);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_role   ON users(role);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  ip_address TEXT,
  user_agent TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- =====================================================
-- INSURANCE COMPANIES (Insurer-First Core)
-- =====================================================
CREATE TABLE insurance_companies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  irdai_license TEXT,
  has_custom_guidelines INTEGER DEFAULT 1,
  guideline_version TEXT DEFAULT '1.0',
  claims_dept_email TEXT,
  claims_dept_phone TEXT,
  portal_url TEXT,
  logo_url TEXT,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE(tenant_id, code)
);
CREATE INDEX idx_insurer_tenant ON insurance_companies(tenant_id);

-- =====================================================
-- INSURER x DEPARTMENT RULES MATRIX
-- =====================================================
CREATE TABLE insurer_department_rules (
  id TEXT PRIMARY KEY,
  insurer_id TEXT NOT NULL,
  department_code TEXT NOT NULL,
  rules_version TEXT DEFAULT '1.0',
  depreciation_table TEXT NOT NULL DEFAULT '[]',
  deductible_rules   TEXT NOT NULL DEFAULT '{}',
  penalty_rules      TEXT NOT NULL DEFAULT '{}',
  document_checklist TEXT NOT NULL DEFAULT '[]',
  warranties         TEXT NOT NULL DEFAULT '[]',
  exclusions         TEXT NOT NULL DEFAULT '[]',
  policy_clauses     TEXT NOT NULL DEFAULT '[]',
  assessment_formula TEXT NOT NULL DEFAULT '{}',
  sla_days           INTEGER DEFAULT 30,
  effective_from     INTEGER,
  effective_to       INTEGER,
  fallback_used      INTEGER DEFAULT 0,
  created_at         INTEGER DEFAULT (unixepoch()),
  updated_at         INTEGER,
  FOREIGN KEY (insurer_id) REFERENCES insurance_companies(id),
  UNIQUE(insurer_id, department_code)
);
CREATE INDEX idx_idr_insurer ON insurer_department_rules(insurer_id);
CREATE INDEX idx_idr_dept    ON insurer_department_rules(department_code);

-- =====================================================
-- CLAIMS (Insurer-First)
-- =====================================================
CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  claim_number TEXT UNIQUE NOT NULL,
  tenant_id TEXT NOT NULL,
  insurer_id TEXT NOT NULL,
  policy_number TEXT,
  insured_name TEXT NOT NULL,
  department TEXT NOT NULL,
  sum_insured INTEGER,
  loss_amount INTEGER,
  claim_status TEXT DEFAULT 'intimated',
  priority TEXT DEFAULT 'medium',
  surveyor_id TEXT,
  incident_date INTEGER,
  intimation_date INTEGER,
  survey_date INTEGER,
  fir_number TEXT,
  police_station TEXT,
  legal_section TEXT,
  circumstances TEXT,
  security_measures TEXT,
  assessment_data TEXT,
  warranty_breaches TEXT DEFAULT '[]',
  ai_suggestions TEXT DEFAULT '[]',
  settlement_amount INTEGER,
  settlement_percentage REAL,
  rules_snapshot TEXT,
  fallback_rules_used INTEGER DEFAULT 0,
  report_generated INTEGER DEFAULT 0,
  report_url TEXT,
  created_by TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER,
  FOREIGN KEY (tenant_id)  REFERENCES tenants(id),
  FOREIGN KEY (insurer_id) REFERENCES insurance_companies(id),
  FOREIGN KEY (surveyor_id) REFERENCES users(id)
);
CREATE INDEX idx_claims_tenant   ON claims(tenant_id);
CREATE INDEX idx_claims_surveyor ON claims(surveyor_id);
CREATE INDEX idx_claims_status   ON claims(claim_status);
CREATE INDEX idx_claims_number   ON claims(claim_number);
CREATE INDEX idx_claims_insurer  ON claims(insurer_id);

-- =====================================================
-- CLAIM DOCUMENTS (with OCR + Geo-tagging)
-- =====================================================
CREATE TABLE claim_documents (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  document_type TEXT,
  r2_key TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  uploaded_by TEXT,
  ocr_extracted_data TEXT,
  verification_score REAL,
  geo_lat REAL,
  geo_lng REAL,
  geo_timestamp INTEGER,
  caption TEXT,
  is_handwritten_upload INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (claim_id)  REFERENCES claims(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX idx_docs_claim  ON claim_documents(claim_id);
CREATE INDEX idx_docs_tenant ON claim_documents(tenant_id);

-- =====================================================
-- PENDING DOCUMENTS TRACKER
-- =====================================================
CREATE TABLE pending_documents (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  insurer_id TEXT NOT NULL,
  document_name TEXT NOT NULL,
  document_type TEXT,
  is_mandatory INTEGER DEFAULT 1,
  required_by TEXT DEFAULT 'insured',
  due_date INTEGER,
  status TEXT DEFAULT 'pending',
  submitted_doc_id TEXT,
  reminder_count INTEGER DEFAULT 0,
  last_reminder_sent INTEGER,
  notes TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER,
  FOREIGN KEY (claim_id)  REFERENCES claims(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (insurer_id) REFERENCES insurance_companies(id)
);
CREATE INDEX idx_pendoc_claim  ON pending_documents(claim_id);
CREATE INDEX idx_pendoc_status ON pending_documents(status);

-- =====================================================
-- AI AUDIT LOGS
-- =====================================================
CREATE TABLE ai_audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  claim_id TEXT,
  session_id TEXT,
  action TEXT NOT NULL,
  ai_reasoning TEXT,
  proposed_changes TEXT,
  source_used TEXT,
  user_confirmed INTEGER DEFAULT 0,
  confirmed_by TEXT,
  confirmed_at INTEGER,
  rejected_by TEXT,
  rejected_at INTEGER,
  ip_address TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (claim_id)  REFERENCES claims(id)
);
CREATE INDEX idx_ailog_claim  ON ai_audit_logs(claim_id);
CREATE INDEX idx_ailog_tenant ON ai_audit_logs(tenant_id);

-- =====================================================
-- SURVEY REPORTS
-- =====================================================
CREATE TABLE survey_reports (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  report_number TEXT UNIQUE,
  report_data TEXT,
  pdf_url TEXT,
  digital_signature TEXT,
  signed_by TEXT,
  status TEXT DEFAULT 'draft',
  generated_at INTEGER,
  FOREIGN KEY (claim_id) REFERENCES claims(id)
);

-- =====================================================
-- HRMS
-- =====================================================
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE,
  tenant_id TEXT NOT NULL,
  employee_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  department TEXT NOT NULL,
  designation TEXT NOT NULL,
  reporting_manager TEXT,
  location TEXT,
  geo_fence_lat REAL,
  geo_fence_lng REAL,
  geo_fence_radius INTEGER DEFAULT 200,
  employment_type TEXT DEFAULT 'full_time',
  status TEXT DEFAULT 'active',
  joining_date INTEGER,
  confirmation_date INTEGER,
  exit_date INTEGER,
  ctc INTEGER,
  bank_account TEXT,
  pan_number TEXT,
  aadhar_number TEXT,
  emergency_contact TEXT,
  personal_email TEXT,
  date_of_birth INTEGER,
  gender TEXT,
  marital_status TEXT,
  address TEXT,
  documents_data TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_employees_tenant     ON employees(tenant_id);
CREATE INDEX idx_employees_department ON employees(department);
CREATE INDEX idx_employees_status     ON employees(status);

CREATE TABLE leave_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  leave_type TEXT NOT NULL,
  from_date INTEGER NOT NULL,
  to_date INTEGER NOT NULL,
  days REAL NOT NULL,
  reason TEXT,
  status TEXT DEFAULT 'pending',
  approved_by TEXT,
  approved_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);
CREATE INDEX idx_leave_employee ON leave_requests(employee_id);
CREATE INDEX idx_leave_status   ON leave_requests(status);

CREATE TABLE leave_balances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  casual_balance REAL DEFAULT 12,
  sick_balance   REAL DEFAULT 12,
  annual_balance REAL DEFAULT 15,
  earned_balance REAL DEFAULT 0,
  lop_days REAL DEFAULT 0,
  updated_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  UNIQUE(employee_id, year)
);

CREATE TABLE attendance (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  claim_id TEXT,
  date INTEGER NOT NULL,
  check_in TEXT,
  check_out TEXT,
  total_hours REAL,
  geo_location TEXT,
  geo_verified INTEGER DEFAULT 0,
  status TEXT DEFAULT 'present',
  notes TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  UNIQUE(employee_id, date)
);
CREATE INDEX idx_attendance_date     ON attendance(date);
CREATE INDEX idx_attendance_employee ON attendance(employee_id);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  claim_id TEXT,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  expense_date INTEGER NOT NULL,
  description TEXT,
  receipt_url TEXT,
  status TEXT DEFAULT 'pending',
  approved_by TEXT,
  approved_at INTEGER,
  reimbursement_date INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);

CREATE TABLE payroll (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  month TEXT NOT NULL,
  year INTEGER NOT NULL,
  basic INTEGER,
  hra INTEGER,
  ta INTEGER,
  da INTEGER,
  other_allowances INTEGER,
  gross_salary INTEGER,
  pf_deduction INTEGER,
  professional_tax INTEGER,
  tds INTEGER,
  loan_deduction INTEGER,
  lop_deduction INTEGER,
  other_deductions INTEGER,
  net_salary INTEGER,
  bank_reference TEXT,
  status TEXT DEFAULT 'processing',
  payment_date INTEGER,
  payslip_url TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  UNIQUE(employee_id, month, year)
);

CREATE TABLE performance_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  review_cycle TEXT NOT NULL,
  kpi_score INTEGER,
  claims_handled INTEGER DEFAULT 0,
  avg_turnaround_days REAL,
  total_settlement_value INTEGER,
  cost_savings INTEGER,
  warranty_breach_detections INTEGER DEFAULT 0,
  doc_compliance_rate REAL,
  sla_adherence_pct REAL,
  goals_achieved TEXT,
  strengths TEXT,
  areas_improvement TEXT,
  rating TEXT,
  recommendations TEXT,
  status TEXT DEFAULT 'draft',
  submitted_at INTEGER,
  reviewed_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (reviewer_id) REFERENCES employees(id)
);

CREATE TABLE grievances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  employee_id TEXT,
  claim_id TEXT,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'open',
  assigned_to TEXT,
  resolution TEXT,
  is_anonymous INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  resolved_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE recruitment_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  department TEXT NOT NULL,
  location TEXT,
  employment_type TEXT,
  experience_required TEXT,
  salary_range TEXT,
  description TEXT,
  requirements TEXT,
  openings INTEGER DEFAULT 1,
  status TEXT DEFAULT 'open',
  posted_by TEXT,
  posted_date INTEGER,
  closed_date INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  resume_url TEXT,
  experience TEXT,
  current_ctc TEXT,
  expected_ctc TEXT,
  notice_period TEXT,
  stage TEXT DEFAULT 'applied',
  interview_scores TEXT,
  feedback TEXT,
  status TEXT DEFAULT 'active',
  applied_date INTEGER,
  hired_date INTEGER,
  converted_employee_id TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (job_id) REFERENCES recruitment_jobs(id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  assigned_to TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'todo',
  due_date INTEGER,
  module TEXT,
  module_id TEXT,
  completed_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- =====================================================
-- COMMUNICATION
-- =====================================================
CREATE TABLE chat_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_chat_session ON chat_history(session_id);
CREATE INDEX idx_chat_user    ON chat_history(user_id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT,
  channel TEXT DEFAULT 'in_app',
  link TEXT,
  is_read INTEGER DEFAULT 0,
  sent_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- =====================================================
-- AUDIT
-- =====================================================
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id TEXT,
  old_data TEXT,
  new_data TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX idx_audit_tenant  ON audit_logs(tenant_id);
CREATE INDEX idx_audit_user    ON audit_logs(user_id);
CREATE INDEX idx_audit_action  ON audit_logs(action);
CREATE INDEX idx_audit_created ON audit_logs(created_at);

-- =====================================================
-- SYSTEM CONFIG
-- =====================================================
CREATE TABLE system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at INTEGER
);
INSERT INTO system_config (key, value, description, updated_at) VALUES
  ('maintenance_mode',  'false',     'System maintenance mode flag',              unixepoch()),
  ('max_upload_size',   '10485760',  'Maximum file upload size in bytes (10MB)',  unixepoch()),
  ('session_timeout',   '604800000', 'Session timeout in ms (7 days)',            unixepoch()),
  ('doc_reminder_days', '2',         'Days between pending doc reminders',        unixepoch()),
  ('irdai_fallback',    'true',      'Use IRDAI guidelines as fallback',          unixepoch()),
  ('geo_tag_required',  'true',      'Require geo-tagging on all site photos',    unixepoch());

-- =====================================================
-- VIEWS
-- =====================================================
CREATE VIEW v_active_claims AS
SELECT c.*, u.name AS surveyor_name, u.email AS surveyor_email,
       t.name AS tenant_name, ic.name AS insurer_name, ic.code AS insurer_code
FROM claims c
LEFT JOIN users u               ON c.surveyor_id = u.id
JOIN  tenants t                 ON c.tenant_id   = t.id
LEFT JOIN insurance_companies ic ON c.insurer_id = ic.id
WHERE c.claim_status NOT IN ('settled','rejected');

CREATE VIEW v_pending_docs_summary AS
SELECT pd.claim_id,
  COUNT(*) AS total_docs,
  SUM(CASE WHEN pd.status='pending'   THEN 1 ELSE 0 END) AS pending_count,
  SUM(CASE WHEN pd.status='submitted' THEN 1 ELSE 0 END) AS submitted_count,
  SUM(CASE WHEN pd.status='verified'  THEN 1 ELSE 0 END) AS verified_count,
  SUM(CASE WHEN pd.is_mandatory=1 AND pd.status='pending' THEN 1 ELSE 0 END) AS critical_pending
FROM pending_documents pd
GROUP BY pd.claim_id;

CREATE VIEW v_employee_leave_summary AS
SELECT e.id, e.name, e.department, e.employee_code,
  COUNT(CASE WHEN l.status='pending'  THEN 1 END) AS pending_leaves,
  COUNT(CASE WHEN l.status='approved' THEN 1 END) AS approved_leaves,
  SUM(CASE WHEN l.status='approved'   THEN l.days ELSE 0 END) AS total_days_taken
FROM employees e
LEFT JOIN leave_requests l ON e.id = l.employee_id
GROUP BY e.id;

CREATE VIEW v_monthly_payroll AS
SELECT tenant_id, month, year,
  COUNT(*) AS employee_count,
  SUM(gross_salary) AS total_gross,
  SUM(net_salary)   AS total_net,
  SUM(pf_deduction) AS total_pf,
  SUM(tds)          AS total_tds
FROM payroll
GROUP BY tenant_id, month, year;
-- =====================================================
-- McLARENS NEXUS ENTERPRISE v5.0 — SCHEMA ADDITIONS
-- SURVEYOR COMPANY MANAGEMENT
-- Run AFTER the main schema.sql has been applied.
-- These statements use CREATE TABLE IF NOT EXISTS so
-- they are safe to run multiple times.
-- No foreign key constraints are added so existing data
-- is never broken. All columns allow NULL.
-- =====================================================

-- =====================================================
-- SURVEYOR COMPANIES
-- Stores surveyor firm / agency details.
-- An organisation can have many surveyor companies.
-- A surveyor company is identified by its IRDA license.
-- =====================================================
CREATE TABLE IF NOT EXISTS surveyor_companies (
  id               TEXT    PRIMARY KEY,
  tenant_id        TEXT,
  name             TEXT    NOT NULL,
  irda_license     TEXT,
  contact_email    TEXT,
  contact_phone    TEXT,
  address          TEXT,
  city             TEXT,
  state            TEXT,
  pincode          TEXT,
  website          TEXT,
  specializations  TEXT,   -- JSON array of dept codes e.g. ["fire","burglary","motor"]
  is_active        INTEGER DEFAULT 1,
  notes            TEXT,
  created_by       TEXT,
  created_at       INTEGER DEFAULT (unixepoch()),
  updated_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sc_tenant   ON surveyor_companies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sc_active   ON surveyor_companies(is_active);
CREATE INDEX IF NOT EXISTS idx_sc_license  ON surveyor_companies(irda_license);

-- =====================================================
-- SURVEYORS
-- Links individual surveyors (users) to their company.
-- expertise stored as JSON. All relationship columns are
-- nullable so existing users are not broken.
-- =====================================================
CREATE TABLE IF NOT EXISTS surveyors (
  id                  TEXT    PRIMARY KEY,
  user_id             TEXT,   -- references users(id) — nullable, no FK constraint
  company_id          TEXT,   -- references surveyor_companies(id) — nullable, no FK constraint
  tenant_id           TEXT,
  license_number      TEXT,
  license_expiry      INTEGER,
  expertise           TEXT,   -- JSON array: ["fire","burglary","marine","motor","engineering","misc"]
  location            TEXT,
  city                TEXT,
  state               TEXT,
  is_active           INTEGER DEFAULT 1,
  joining_date        INTEGER,
  notes               TEXT,
  created_at          INTEGER DEFAULT (unixepoch()),
  updated_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_surveyors_user    ON surveyors(user_id);
CREATE INDEX IF NOT EXISTS idx_surveyors_company ON surveyors(company_id);
CREATE INDEX IF NOT EXISTS idx_surveyors_tenant  ON surveyors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_surveyors_active  ON surveyors(is_active);

-- =====================================================
-- COMPANY ASSIGNMENTS
-- Audit log only. Records which internal employee of a
-- tenant assigned which claim to which surveyor company.
-- NO enforcement is applied — the surveyor company
-- decides internally who handles each claim.
-- All columns are nullable. No FK constraints.
-- =====================================================
CREATE TABLE IF NOT EXISTS company_assignments (
  id              TEXT    PRIMARY KEY,
  tenant_id       TEXT,
  claim_id        TEXT,   -- references claims(id) — nullable, no FK constraint
  company_id      TEXT,   -- references surveyor_companies(id) — nullable, no FK constraint
  assigned_by     TEXT,   -- user_id of the internal employee who made the assignment
  assigned_at     INTEGER DEFAULT (unixepoch()),
  notes           TEXT,
  priority        TEXT,   -- low / medium / high / critical (informational only)
  expected_survey_date INTEGER,
  internal_ref    TEXT,   -- optional internal reference number
  created_at      INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ca_claim   ON company_assignments(claim_id);
CREATE INDEX IF NOT EXISTS idx_ca_company ON company_assignments(company_id);
CREATE INDEX IF NOT EXISTS idx_ca_tenant  ON company_assignments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ca_assigned_by ON company_assignments(assigned_by);
-- =====================================================
-- McLARENS NEXUS ENTERPRISE v5.0 — SCHEMA ADDITIONS v2
-- REPORT PIPELINE: JIR → Spot → LOR → PSR → Interim → FSR
-- Safe to run multiple times (IF NOT EXISTS throughout)
-- Appended to schema_additions.sql
-- =====================================================

-- =====================================================
-- SURVEY REPORTS PIPELINE
-- One row per report type per claim.
-- report_type: jir | spot | lor | psr | interim | fsr
-- report_data: JSON blob of all form fields
-- status: draft | saved | submitted | accepted | rejected
-- All fields nullable — no FK constraints — safe for existing data
-- =====================================================
CREATE TABLE IF NOT EXISTS survey_reports_pipeline (
  id             TEXT    PRIMARY KEY,
  claim_id       TEXT    NOT NULL,
  tenant_id      TEXT,
  report_type    TEXT    NOT NULL,  -- jir|spot|lor|psr|interim|fsr
  report_number  TEXT,              -- e.g. MCL/FSR/2026/001
  report_data    TEXT,              -- JSON: all form fields
  status         TEXT    DEFAULT 'draft',   -- draft|saved|submitted|accepted|rejected
  ai_suggestions TEXT,             -- JSON: AI suggestions for this report
  ai_applied     INTEGER DEFAULT 0, -- 1 if surveyor accepted AI suggestions
  submitted_to   TEXT,             -- insurer email / portal
  submitted_at   INTEGER,
  accepted_at    INTEGER,
  rejected_at    INTEGER,
  rejection_reason TEXT,
  version        INTEGER DEFAULT 1, -- incremented on each save
  created_by     TEXT,
  created_at     INTEGER DEFAULT (unixepoch()),
  updated_at     INTEGER,
  UNIQUE(claim_id, report_type)    -- one active report per type per claim
);
CREATE INDEX IF NOT EXISTS idx_srp_claim   ON survey_reports_pipeline(claim_id);
CREATE INDEX IF NOT EXISTS idx_srp_type    ON survey_reports_pipeline(report_type);
CREATE INDEX IF NOT EXISTS idx_srp_status  ON survey_reports_pipeline(status);
CREATE INDEX IF NOT EXISTS idx_srp_tenant  ON survey_reports_pipeline(tenant_id);

-- =====================================================
-- REPORT AUDIT TRAIL
-- Every save/submit/accept/reject of every report is
-- recorded here for IRDAI compliance and dispute resolution.
-- =====================================================
CREATE TABLE IF NOT EXISTS report_audit (
  id             TEXT    PRIMARY KEY,
  report_id      TEXT,             -- references survey_reports_pipeline(id)
  claim_id       TEXT,
  tenant_id      TEXT,
  report_type    TEXT,
  action         TEXT    NOT NULL, -- saved|submitted|accepted|rejected|ai_applied|printed
  old_status     TEXT,
  new_status     TEXT,
  changed_by     TEXT,             -- user_id
  change_note    TEXT,
  ip_address     TEXT,
  created_at     INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ra_report  ON report_audit(report_id);
CREATE INDEX IF NOT EXISTS idx_ra_claim   ON report_audit(claim_id);
CREATE INDEX IF NOT EXISTS idx_ra_action  ON report_audit(action);

-- =====================================================
-- FSR CALCULATION SNAPSHOT
-- Stores the confirmed calculation values for FSR.
-- Each field has: value, source (manual|ai|document),
-- confirmed_by, confirmed_at.
-- This provides a complete audit trail of every number
-- in the final settlement.
-- =====================================================
CREATE TABLE IF NOT EXISTS fsr_calculations (
  id                 TEXT    PRIMARY KEY,
  claim_id           TEXT    NOT NULL,
  report_id          TEXT,
  tenant_id          TEXT,

  -- Trading Account (for stock claims)
  opening_stock      INTEGER,   opening_stock_source TEXT,
  purchases          INTEGER,   purchases_source TEXT,
  sales              INTEGER,   sales_source TEXT,
  gp_rate            REAL,      gp_rate_source TEXT,
  book_stock         INTEGER,   -- computed
  undamaged_stock    INTEGER,   undamaged_stock_source TEXT,
  stock_claimed      INTEGER,   -- computed
  invoice_loss       INTEGER,   invoice_loss_source TEXT,
  surveyor_assess    INTEGER,   surveyor_assess_source TEXT,

  -- Fixed Asset / Vehicle
  replacement_val    INTEGER,   replacement_val_source TEXT,
  asset_age_months   INTEGER,
  depreciation_pct   REAL,      depreciation_source TEXT,
  depreciation_amt   INTEGER,   -- computed

  -- Common to all types
  gross_assessed     INTEGER    NOT NULL DEFAULT 0,
  deductible         INTEGER    DEFAULT 0,
  salvage            INTEGER    DEFAULT 0,
  fr_penalty_pct     REAL       DEFAULT 0,
  fr_penalty_amt     INTEGER    DEFAULT 0,
  warranty_pct       REAL       DEFAULT 0,
  warranty_amt       INTEGER    DEFAULT 0,
  gst_excluded       INTEGER    DEFAULT 0,
  avg_clause_applied INTEGER    DEFAULT 0,
  sum_insured        INTEGER,
  total_value        INTEGER,
  avg_ratio          REAL       DEFAULT 1.0,
  net_settlement     INTEGER    NOT NULL DEFAULT 0,
  settlement_pct     REAL,

  -- Confirmation tracking
  all_confirmed      INTEGER    DEFAULT 0,  -- 1 when surveyor confirmed every field
  confirmed_by       TEXT,
  confirmed_at       INTEGER,

  -- AI assistance
  ai_calculated      INTEGER    DEFAULT 0,
  ai_confidence      INTEGER,
  ai_reasoning       TEXT,

  rules_source       TEXT,      -- insurer_custom | irdai_fallback
  created_at         INTEGER    DEFAULT (unixepoch()),
  updated_at         INTEGER,
  UNIQUE(claim_id)
);
CREATE INDEX IF NOT EXISTS idx_fsrc_claim ON fsr_calculations(claim_id);

-- =====================================================
-- McLARENS NEXUS ENTERPRISE v5.0 — SCHEMA ADDITIONS
-- SURVEYOR COMPANY MANAGEMENT
-- Run AFTER the main schema.sql has been applied.
-- These statements use CREATE TABLE IF NOT EXISTS so
-- they are safe to run multiple times.
-- No foreign key constraints are added so existing data
-- is never broken. All columns allow NULL.
-- =====================================================

-- =====================================================
-- SURVEYOR COMPANIES
-- Stores surveyor firm / agency details.
-- An organisation can have many surveyor companies.
-- A surveyor company is identified by its IRDA license.
-- =====================================================
CREATE TABLE IF NOT EXISTS surveyor_companies (
  id               TEXT    PRIMARY KEY,
  tenant_id        TEXT,
  name             TEXT    NOT NULL,
  irda_license     TEXT,
  contact_email    TEXT,
  contact_phone    TEXT,
  address          TEXT,
  city             TEXT,
  state            TEXT,
  pincode          TEXT,
  website          TEXT,
  specializations  TEXT,   -- JSON array of dept codes e.g. ["fire","burglary","motor"]
  is_active        INTEGER DEFAULT 1,
  notes            TEXT,
  created_by       TEXT,
  created_at       INTEGER DEFAULT (unixepoch()),
  updated_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sc_tenant   ON surveyor_companies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sc_active   ON surveyor_companies(is_active);
CREATE INDEX IF NOT EXISTS idx_sc_license  ON surveyor_companies(irda_license);

-- =====================================================
-- SURVEYORS
-- Links individual surveyors (users) to their company.
-- expertise stored as JSON. All relationship columns are
-- nullable so existing users are not broken.
-- =====================================================
CREATE TABLE IF NOT EXISTS surveyors (
  id                  TEXT    PRIMARY KEY,
  user_id             TEXT,   -- references users(id) — nullable, no FK constraint
  company_id          TEXT,   -- references surveyor_companies(id) — nullable, no FK constraint
  tenant_id           TEXT,
  license_number      TEXT,
  license_expiry      INTEGER,
  expertise           TEXT,   -- JSON array: ["fire","burglary","marine","motor","engineering","misc"]
  location            TEXT,
  city                TEXT,
  state               TEXT,
  is_active           INTEGER DEFAULT 1,
  joining_date        INTEGER,
  notes               TEXT,
  created_at          INTEGER DEFAULT (unixepoch()),
  updated_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_surveyors_user    ON surveyors(user_id);
CREATE INDEX IF NOT EXISTS idx_surveyors_company ON surveyors(company_id);
CREATE INDEX IF NOT EXISTS idx_surveyors_tenant  ON surveyors(tenant_id);
CREATE INDEX IF NOT EXISTS idx_surveyors_active  ON surveyors(is_active);

-- =====================================================
-- COMPANY ASSIGNMENTS
-- Audit log only. Records which internal employee of a
-- tenant assigned which claim to which surveyor company.
-- NO enforcement is applied — the surveyor company
-- decides internally who handles each claim.
-- All columns are nullable. No FK constraints.
-- =====================================================
CREATE TABLE IF NOT EXISTS company_assignments (
  id              TEXT    PRIMARY KEY,
  tenant_id       TEXT,
  claim_id        TEXT,   -- references claims(id) — nullable, no FK constraint
  company_id      TEXT,   -- references surveyor_companies(id) — nullable, no FK constraint
  assigned_by     TEXT,   -- user_id of the internal employee who made the assignment
  assigned_at     INTEGER DEFAULT (unixepoch()),
  notes           TEXT,
  priority        TEXT,   -- low / medium / high / critical (informational only)
  expected_survey_date INTEGER,
  internal_ref    TEXT,   -- optional internal reference number
  created_at      INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ca_claim   ON company_assignments(claim_id);
CREATE INDEX IF NOT EXISTS idx_ca_company ON company_assignments(company_id);
CREATE INDEX IF NOT EXISTS idx_ca_tenant  ON company_assignments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ca_assigned_by ON company_assignments(assigned_by);

-- =====================================================
-- REPORT PIPELINE TABLES (v5.1 additions)
-- Safe to run multiple times (IF NOT EXISTS throughout)
-- =====================================================

CREATE TABLE IF NOT EXISTS survey_reports_pipeline (
  id             TEXT    PRIMARY KEY,
  claim_id       TEXT    NOT NULL,
  tenant_id      TEXT,
  report_type    TEXT    NOT NULL,
  report_number  TEXT,
  report_data    TEXT,
  status         TEXT    DEFAULT 'draft',
  ai_suggestions TEXT,
  ai_applied     INTEGER DEFAULT 0,
  submitted_to   TEXT,
  submitted_at   INTEGER,
  accepted_at    INTEGER,
  rejected_at    INTEGER,
  rejection_reason TEXT,
  version        INTEGER DEFAULT 1,
  created_by     TEXT,
  created_at     INTEGER DEFAULT (unixepoch()),
  updated_at     INTEGER,
  UNIQUE(claim_id, report_type)
);
CREATE INDEX IF NOT EXISTS idx_srp_claim   ON survey_reports_pipeline(claim_id);
CREATE INDEX IF NOT EXISTS idx_srp_type    ON survey_reports_pipeline(report_type);
CREATE INDEX IF NOT EXISTS idx_srp_status  ON survey_reports_pipeline(status);
CREATE INDEX IF NOT EXISTS idx_srp_tenant  ON survey_reports_pipeline(tenant_id);

CREATE TABLE IF NOT EXISTS report_audit (
  id           TEXT PRIMARY KEY,
  report_id    TEXT,
  claim_id     TEXT,
  tenant_id    TEXT,
  report_type  TEXT,
  action       TEXT NOT NULL,
  old_status   TEXT,
  new_status   TEXT,
  changed_by   TEXT,
  change_note  TEXT,
  ip_address   TEXT,
  created_at   INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ra_report ON report_audit(report_id);
CREATE INDEX IF NOT EXISTS idx_ra_claim  ON report_audit(claim_id);

CREATE TABLE IF NOT EXISTS fsr_calculations (
  id                  TEXT    PRIMARY KEY,
  claim_id            TEXT    NOT NULL,
  report_id           TEXT,
  tenant_id           TEXT,
  opening_stock       INTEGER, opening_stock_source TEXT,
  purchases           INTEGER, purchases_source TEXT,
  sales               INTEGER, sales_source TEXT,
  gp_rate             REAL,    gp_rate_source TEXT,
  book_stock          INTEGER,
  undamaged_stock     INTEGER, undamaged_stock_source TEXT,
  stock_claimed       INTEGER,
  invoice_loss        INTEGER, invoice_loss_source TEXT,
  surveyor_assess     INTEGER, surveyor_assess_source TEXT,
  replacement_val     INTEGER, replacement_val_source TEXT,
  asset_age_months    INTEGER,
  depreciation_pct    REAL,    depreciation_source TEXT,
  depreciation_amt    INTEGER,
  gross_assessed      INTEGER NOT NULL DEFAULT 0,
  deductible          INTEGER DEFAULT 0,
  salvage             INTEGER DEFAULT 0,
  fr_penalty_pct      REAL    DEFAULT 0,
  fr_penalty_amt      INTEGER DEFAULT 0,
  warranty_pct        REAL    DEFAULT 0,
  warranty_amt        INTEGER DEFAULT 0,
  gst_excluded        INTEGER DEFAULT 0,
  avg_clause_applied  INTEGER DEFAULT 0,
  avg_ratio           REAL    DEFAULT 1.0,
  sum_insured         INTEGER,
  total_value         INTEGER,
  net_settlement      INTEGER NOT NULL DEFAULT 0,
  settlement_pct      REAL,
  all_confirmed       INTEGER DEFAULT 0,
  confirmed_by        TEXT,
  confirmed_at        INTEGER,
  ai_calculated       INTEGER DEFAULT 0,
  ai_confidence       INTEGER,
  ai_reasoning        TEXT,
  rules_source        TEXT,
  is_overridden       INTEGER DEFAULT 0,
  override_reason     TEXT,
  overridden_by       TEXT,
  created_at          INTEGER DEFAULT (unixepoch()),
  updated_at          INTEGER,
  UNIQUE(claim_id)
);
CREATE INDEX IF NOT EXISTS idx_fsrc_claim ON fsr_calculations(claim_id);

-- Document checklist (auto-generated from insurer rules)
CREATE TABLE IF NOT EXISTS document_checklist (
  id              TEXT PRIMARY KEY,
  claim_id        TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  document_name   TEXT NOT NULL,
  document_type   TEXT,
  is_mandatory    INTEGER DEFAULT 1,
  required_party  TEXT DEFAULT 'insured',
  status          TEXT DEFAULT 'pending',
  document_id     TEXT,
  waiver_reason   TEXT,
  waived_by       TEXT,
  waived_at       INTEGER,
  blocking_report TEXT,
  sort_order      INTEGER DEFAULT 0,
  notes           TEXT,
  created_at      INTEGER DEFAULT (unixepoch()),
  updated_at      INTEGER,
  UNIQUE(claim_id, document_type)
);
CREATE INDEX IF NOT EXISTS idx_dchk_claim  ON document_checklist(claim_id);
CREATE INDEX IF NOT EXISTS idx_dchk_status ON document_checklist(status);

-- Vault (enterprise DMS — auto-saves submitted reports)
CREATE TABLE IF NOT EXISTS vault_entries (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  claim_id       TEXT,
  claim_number   TEXT,
  insured_name   TEXT,
  insurer_name   TEXT,
  report_type    TEXT,
  report_id      TEXT,
  document_id    TEXT,
  version        INTEGER DEFAULT 1,
  status         TEXT,
  surveyor_name  TEXT,
  r2_key         TEXT,
  file_size      INTEGER,
  incident_type  TEXT,
  loss_type      TEXT,
  financial_value INTEGER,
  ai_indexed     INTEGER DEFAULT 0,
  visibility     TEXT DEFAULT 'tenant',
  last_accessed_by TEXT,
  last_accessed_at INTEGER,
  access_count   INTEGER DEFAULT 0,
  created_at     INTEGER DEFAULT (unixepoch()),
  updated_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vault_tenant  ON vault_entries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vault_claim   ON vault_entries(claim_id);
CREATE INDEX IF NOT EXISTS idx_vault_type    ON vault_entries(report_type);

-- View: checklist completion status
CREATE VIEW IF NOT EXISTS v_checklist_status AS
SELECT
  claim_id,
  COUNT(*) AS total_items,
  SUM(CASE WHEN is_mandatory=1 THEN 1 ELSE 0 END) AS total_mandatory,
  SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed_count,
  SUM(CASE WHEN is_mandatory=1 AND status='pending' THEN 1 ELSE 0 END) AS pending_mandatory,
  SUM(CASE WHEN blocking_report='fsr' AND status NOT IN ('completed','waived') THEN 1 ELSE 0 END) AS fsr_blockers,
  CAST(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS REAL) /
    NULLIF(COUNT(*),0) * 100 AS completion_pct
FROM document_checklist
GROUP BY claim_id;