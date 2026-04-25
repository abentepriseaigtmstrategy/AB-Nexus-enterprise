-- ════════════════════════════════════════════════════════════════════
-- AB Nexus Enterprise — Migration V2
-- Skips ALTER TABLE (columns already exist from previous run)
-- Only runs CREATE TABLE IF NOT EXISTS (100% safe, never fails)
-- Run with: wrangler d1 execute ab-nexus-db --remote --file=migration_v2.sql
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS survey_reports_pipeline (
  id            TEXT PRIMARY KEY,
  claim_id      TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  report_type   TEXT NOT NULL,
  report_number TEXT,
  report_data   TEXT,
  status        TEXT DEFAULT 'draft',
  ai_suggestions TEXT,
  ai_applied    INTEGER DEFAULT 0,
  submitted_to  TEXT,
  submitted_at  INTEGER,
  accepted_at   INTEGER,
  version       INTEGER DEFAULT 1,
  created_by    TEXT,
  created_at    INTEGER DEFAULT (unixepoch()),
  updated_at    INTEGER,
  UNIQUE(claim_id, report_type)
);
CREATE INDEX IF NOT EXISTS idx_srp_claim   ON survey_reports_pipeline(claim_id);
CREATE INDEX IF NOT EXISTS idx_srp_type    ON survey_reports_pipeline(report_type);
CREATE INDEX IF NOT EXISTS idx_srp_status  ON survey_reports_pipeline(status);
CREATE INDEX IF NOT EXISTS idx_srp_tenant  ON survey_reports_pipeline(tenant_id);

CREATE TABLE IF NOT EXISTS report_audit (
  id          TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL,
  claim_id    TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  report_type TEXT NOT NULL,
  action      TEXT NOT NULL,
  old_status  TEXT,
  new_status  TEXT,
  changed_by  TEXT,
  ip_address  TEXT,
  created_at  INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ra_claim  ON report_audit(claim_id);
CREATE INDEX IF NOT EXISTS idx_ra_report ON report_audit(report_id);

CREATE TABLE IF NOT EXISTS stage_deadlines (
  id                   TEXT PRIMARY KEY,
  claim_id             TEXT NOT NULL,
  tenant_id            TEXT NOT NULL,
  stage                TEXT NOT NULL,
  deadline_type        TEXT DEFAULT 'fixed',
  original_deadline    INTEGER,
  current_deadline     INTEGER,
  extended_deadline    INTEGER,
  extension_reason     TEXT,
  override_reason      TEXT,
  override_approved_by TEXT,
  status               TEXT DEFAULT 'active',
  created_by           TEXT,
  created_at           INTEGER DEFAULT (unixepoch()),
  updated_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sd_claim  ON stage_deadlines(claim_id);
CREATE INDEX IF NOT EXISTS idx_sd_tenant ON stage_deadlines(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sd_stage  ON stage_deadlines(claim_id, stage);

CREATE TABLE IF NOT EXISTS stage_snapshots (
  id            TEXT PRIMARY KEY,
  claim_id      TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  stage         TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  snapshot_data TEXT,
  status        TEXT DEFAULT 'saved',
  saved_by      TEXT,
  note          TEXT,
  created_at    INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ss_claim   ON stage_snapshots(claim_id);
CREATE INDEX IF NOT EXISTS idx_ss_stage   ON stage_snapshots(claim_id, stage);
CREATE INDEX IF NOT EXISTS idx_ss_version ON stage_snapshots(claim_id, stage, version);

CREATE TABLE IF NOT EXISTS fsr_calculations (
  id                  TEXT PRIMARY KEY,
  claim_id            TEXT NOT NULL,
  tenant_id           TEXT NOT NULL,
  gross_assessed      REAL DEFAULT 0,
  deductible          REAL DEFAULT 0,
  salvage             REAL DEFAULT 0,
  fr_penalty_pct      REAL DEFAULT 0,
  fr_penalty_amt      REAL DEFAULT 0,
  warranty_pct        REAL DEFAULT 0,
  warranty_amt        REAL DEFAULT 0,
  avg_clause_applied  INTEGER DEFAULT 0,
  avg_ratio           REAL DEFAULT 1.0,
  sum_insured         REAL DEFAULT 0,
  total_value         REAL DEFAULT 0,
  net_settlement      REAL DEFAULT 0,
  settlement_pct      REAL DEFAULT 0,
  depreciation_pct    REAL DEFAULT 0,
  depreciation_amt    REAL DEFAULT 0,
  asset_age_months    INTEGER DEFAULT 0,
  ai_calculated       INTEGER DEFAULT 0,
  ai_confidence       REAL,
  ai_reasoning        TEXT,
  rules_source        TEXT DEFAULT 'insurer_custom',
  is_overridden       INTEGER DEFAULT 0,
  override_reason     TEXT,
  overridden_by       TEXT,
  created_at          INTEGER DEFAULT (unixepoch()),
  updated_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fsrc_claim  ON fsr_calculations(claim_id);
CREATE INDEX IF NOT EXISTS idx_fsrc_tenant ON fsr_calculations(tenant_id);

CREATE TABLE IF NOT EXISTS vault_entries (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  claim_id         TEXT,
  claim_number     TEXT,
  insured_name     TEXT,
  insurer_name     TEXT,
  department       TEXT,
  report_type      TEXT,
  status           TEXT DEFAULT 'active',
  entry_data       TEXT,
  last_accessed_by TEXT,
  last_accessed_at INTEGER,
  access_count     INTEGER DEFAULT 0,
  created_at       INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ve_tenant ON vault_entries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ve_claim  ON vault_entries(claim_id);

CREATE TABLE IF NOT EXISTS document_checklist (
  id            TEXT PRIMARY KEY,
  claim_id      TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  document_name TEXT NOT NULL,
  document_type TEXT,
  is_mandatory  INTEGER DEFAULT 1,
  required_from TEXT DEFAULT 'insured',
  status        TEXT DEFAULT 'pending',
  waiver_reason TEXT,
  waived_by     TEXT,
  waived_at     INTEGER,
  sort_order    INTEGER DEFAULT 0,
  created_at    INTEGER DEFAULT (unixepoch()),
  updated_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dc_claim  ON document_checklist(claim_id);
CREATE INDEX IF NOT EXISTS idx_dc_tenant ON document_checklist(tenant_id);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sess_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sess_expires ON sessions(expires_at);

SELECT 'Migration V2 complete — all tables ready.' AS status;
