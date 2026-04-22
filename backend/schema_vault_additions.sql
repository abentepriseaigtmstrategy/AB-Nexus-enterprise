-- =====================================================
-- VAULT SCHEMA ADDITIONS — AB Nexus Enterprise v5.1
-- Run via: wrangler d1 execute ab-nexus-db --file=schema_vault_additions.sql --remote
-- Safe to run multiple times — all statements use IF NOT EXISTS or ADD COLUMN
-- =====================================================

-- ── Lifecycle tracking columns on claims ──────────────────────────────
ALTER TABLE claims ADD COLUMN closed_at       INTEGER DEFAULT NULL;
ALTER TABLE claims ADD COLUMN closed_by       TEXT    DEFAULT NULL;
ALTER TABLE claims ADD COLUMN archived_at     INTEGER DEFAULT NULL;
ALTER TABLE claims ADD COLUMN archived_by     TEXT    DEFAULT NULL;
ALTER TABLE claims ADD COLUMN restored_at     INTEGER DEFAULT NULL;
ALTER TABLE claims ADD COLUMN restored_by     TEXT    DEFAULT NULL;
ALTER TABLE claims ADD COLUMN lifecycle_notes TEXT    DEFAULT NULL;

-- ── Fast vault filter index ────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_claims_vault
  ON claims(tenant_id, claim_status, created_at DESC);

-- ── Final Submission Snapshot table ───────────────────────────────────
-- Immutable record of claim state at moment of submission.
-- Never updated after creation.
CREATE TABLE IF NOT EXISTS claim_final_snapshots (
  id            TEXT    PRIMARY KEY,
  claim_id      TEXT    NOT NULL,
  tenant_id     TEXT    NOT NULL,
  snapshot_data TEXT    NOT NULL,
  submitted_by  TEXT,
  created_at    INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (claim_id)  REFERENCES claims(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_cfs_claim  ON claim_final_snapshots(claim_id);
CREATE INDEX IF NOT EXISTS idx_cfs_tenant ON claim_final_snapshots(tenant_id);
