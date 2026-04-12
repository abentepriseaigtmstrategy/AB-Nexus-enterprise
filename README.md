# AB Nexus Enterprise v5.1

**AI-first insurance surveyor platform. 80–90% workload reduction via auto-drive processing.**

---

## Project Structure

```
AB-Nexus-enterprise/
├── frontend/                    ← Cloudflare Pages (deploy this folder)
│   ├── index.html               ← Login (password, magic link, Google SSO)
│   ├── surveyor-dashboard.html  ← Surveyor command centre
│   ├── hrms-dashboard.html      ← HR management
│   ├── sw.js                    ← PWA service worker (v7 — SW bug fixed)
│   ├── manifest.json            ← PWA manifest
│   ├── _redirects               ← Cloudflare Pages SPA routing
│   ├── _headers                 ← Cloudflare Pages response headers
│   └── src/js/
│       ├── utils.js             ← Shared utilities (API, formatting, toast)
│       ├── surveyor.js          ← Surveyor API layer + offline queue
│       └── hrms.js              ← HRMS API layer
│
├── backend/                     ← Cloudflare Worker (deploy this folder)
│   ├── index.js                 ← Main Worker (all API routes)
│   ├── auth.js                  ← JWT, magic link, Google OAuth, password hashing
│   ├── rbac.js                  ← Role-based access control
│   ├── openai-chat.js           ← Claude + GPT-4o AI engine
│   ├── notifications.js         ← Email (Resend) + SMS (Twilio)
│   ├── seed-insurers.js         ← 32 insurers + IRDAI fallback rules
│   ├── seed.js                  ← Initial data seeder
│   ├── durable-objects.js       ← WebSocket real-time hub
│   ├── schema.sql               ← Complete D1 database schema
│   ├── wrangler.toml            ← Cloudflare Worker config
│   └── package.json
└── README.md
```

---

## What's in v5.1

### Bug Fixes
- **SW chrome-error:// loop fixed** — `sw.js` no longer calls `skipWaiting()` on install. The `controllerchange` reload is guarded by `navigator.onLine + document.readyState + location.protocol` checks.
- **Stale API URL fixed** — all JS files now point to `ab-nexus-api.amitbhavikmnm.workers.dev`.
- **Absolute redirect paths** — `routeByRole` uses `/surveyor-dashboard.html` instead of relative paths.
- **Stale SW cleanup** — login page unregisters old broken service workers on every load.
- **Cloudflare Pages headers** — `sw.js` served with correct MIME type and `Service-Worker-Allowed: /`.

### New Features
- **AI document pipeline** — every upload triggers GPT-4o (images) or Claude (PDFs): classify → extract → merge into claim → conflict-detect
- **Auto claim creation** — claim fields auto-populated from uploaded documents
- **Document checklist engine** — auto-generated from insurer rules; blocks FSR when mandatory docs missing
- **Auto report drafting** — Spot Report and LOR auto-drafted when checklist ≥ 50% complete
- **Financial calculation engine** — AI-calculated with transparent formula steps; override logging
- **Vault** — all submitted reports auto-saved with full metadata; searchable and filterable
- **Conflict detection** — cross-document AI analysis flags FIR vs JIR mismatches, amount discrepancies
- **Claude API support** — `openai-chat.js` now uses Claude Sonnet as primary + GPT-4o as fallback
- **Merged schema** — `schema.sql` + `schema_additions.sql` merged into single clean file; new tables: `document_checklist`, `vault_entries`, `fsr_calculations` enhanced

---

## Deployment

### 1. Backend (Cloudflare Worker)

```bash
cd backend
npm install

# Set secrets
wrangler secret put JWT_SECRET
wrangler secret put OPENAI_API_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put RESEND_API_KEY

# Create D1 database (first time)
wrangler d1 create ab-nexus-db
# → copy the database_id into wrangler.toml

# Run schema
npm run db:init

# Create R2 bucket (first time)
wrangler r2 bucket create ab-nexus-documents

# Deploy
wrangler deploy
```

### 2. Frontend (Cloudflare Pages)

Deploy the `frontend/` folder to Cloudflare Pages.

```bash
# Via Wrangler CLI
wrangler pages deploy frontend --project-name ab-nexus-enterprise

# Or connect your Git repo to Cloudflare Pages dashboard.
# Build output directory: frontend
# Build command: (none — static files)
```

### 3. Create first user

```bash
cd backend
node seed.js
# Creates admin@mclarens.com / Admin@2026
# Or sign up via the UI → creates a new tenant automatically
```

---

## Demo Credentials

| Field    | Value                    |
|----------|--------------------------|
| Email    | admin@mclarens.com       |
| Password | Admin@2026               |

---

## AI Pipeline Flow

```
Document Upload
    ↓
AI Classification (GPT-4o / Claude)
    ↓
Structured Extraction → Merge into Claim
    ↓
Cross-Document Conflict Detection
    ↓
Checklist Auto-Update
    ↓
[If checklist ≥ 50%] Auto-draft Spot Report + LOR
    ↓
Exception Alerts (missing docs, conflicts, SLA)
    ↓
Human Review → Approve → Submit → Vault
```

---

## Environment Variables

| Key                  | Required | Description                |
|----------------------|----------|----------------------------|
| `JWT_SECRET`         | ✅       | 32+ char random string     |
| `MAGIC_LINK_SECRET`  | ✅       | 32+ char random string     |
| `OPENAI_API_KEY`     | ✅       | GPT-4o Vision for OCR      |
| `ANTHROPIC_API_KEY`  | ✅       | Claude for reports + chat  |
| `GOOGLE_CLIENT_ID`   | Optional | Google SSO                 |
| `RESEND_API_KEY`     | Optional | Transactional email        |
| `TWILIO_ACCOUNT_SID` | Optional | SMS reminders              |
| `TWILIO_AUTH_TOKEN`  | Optional | SMS reminders              |
| `TWILIO_FROM_NUMBER` | Optional | SMS sender number          |

---

## Roles

| Role          | Access                                |
|---------------|---------------------------------------|
| `super_admin` | All tenants, system config            |
| `admin`       | Full access within tenant             |
| `surveyor`    | Claims, documents, reports, vault     |
| `hr_admin`    | HRMS module                           |
| `employee`    | HRMS self-service                     |
| `viewer`      | Read-only claims and reports          |
