-- =====================================================
-- SurveyorOS Stage Deadlines + Snapshot Tables
-- Run with: npx wrangler d1 execute ab-nexus-db --remote --file=schema_new.sql
-- Safe: all IF NOT EXISTS, no drops
-- =====================================================

-- Per-stage deadline tracking with override support
CREATE TABLE IF NOT EXISTS stage_deadlines (
  id               TEXT PRIMARY KEY,
  claim_id         TEXT NOT NULL,
  tenant_id        TEXT NOT NULL,
  stage            TEXT NOT NULL,              -- jir / spot / lor / psr / interim / fsr
  deadline_type    TEXT DEFAULT 'fixed',       -- fixed / extended / overridden
  original_deadline INTEGER,                   -- epoch ms
  current_deadline  INTEGER,                   -- epoch ms (may be extended)
  extended_deadline INTEGER,                   -- epoch ms when extension granted
  extension_reason  TEXT,
  override_reason   TEXT,
  override_approved_by TEXT,
  status            TEXT DEFAULT 'active',     -- active / extended / overridden / met / missed
  created_by        TEXT,
  created_at        INTEGER DEFAULT (unixepoch()),
  updated_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sd_claim   ON stage_deadlines(claim_id);
CREATE INDEX IF NOT EXISTS idx_sd_tenant  ON stage_deadlines(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sd_stage   ON stage_deadlines(claim_id, stage);

-- Versioned snapshots for each report stage
-- Each save creates a new row; latest is also upserted into survey_reports_pipeline
CREATE TABLE IF NOT EXISTS stage_snapshots (
  id               TEXT PRIMARY KEY,
  claim_id         TEXT NOT NULL,
  tenant_id        TEXT NOT NULL,
  stage            TEXT NOT NULL,              -- jir / spot / lor / psr / interim / fsr
  version          INTEGER NOT NULL DEFAULT 1,
  snapshot_data    TEXT,                       -- full JSON of form fields + computed values
  status           TEXT DEFAULT 'saved',       -- saved / submitted / accepted
  saved_by         TEXT,
  generated_output TEXT,                       -- PDF url or rendered output reference
  note             TEXT,
  created_at       INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ss_claim   ON stage_snapshots(claim_id);
CREATE INDEX IF NOT EXISTS idx_ss_stage   ON stage_snapshots(claim_id, stage);
CREATE INDEX IF NOT EXISTS idx_ss_version ON stage_snapshots(claim_id, stage, version);

-- Add current_stage to claims if not present
-- (SQLite ALTER TABLE ADD COLUMN is safe and idempotent if wrapped)
