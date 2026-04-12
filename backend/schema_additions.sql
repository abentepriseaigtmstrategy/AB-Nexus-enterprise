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
