// backend/seed-insurers.js — McLarens Nexus Enterprise v5.0
// ESM export (required for Cloudflare Workers with "type":"module")

export const IRDAI_FALLBACK = {
  fire: {
    depreciation_table: [
      { age_to_months: 6,   pct: 0  }, { age_to_months: 12,  pct: 5  },
      { age_to_months: 24,  pct: 15 }, { age_to_months: 36,  pct: 25 },
      { age_to_months: 48,  pct: 35 }, { age_to_months: 60,  pct: 45 },
      { age_to_months: 999, pct: 50 }
    ],
    deductible_rules: { type: 'percentage_or_fixed', pct: 5, fixed: 10000, minimum: 10000 },
    penalty_rules:    { fr_pending_pct: 25, warranty_breach_pct: 15 },
    sla_days: 30
  },
  burglary: {
    depreciation_table: [
      { age_to_months: 12,  pct: 10 }, { age_to_months: 24,  pct: 20 },
      { age_to_months: 36,  pct: 30 }, { age_to_months: 60,  pct: 40 },
      { age_to_months: 999, pct: 50 }
    ],
    deductible_rules: { type: 'percentage_or_fixed', pct: 5, fixed: 10000, minimum: 10000 },
    penalty_rules:    { fr_pending_pct: 25, warranty_breach_pct: 15 },
    sla_days: 45
  },
  motor: {
    depreciation_table: [
      { age_to_months: 6,   pct: 5  }, { age_to_months: 12,  pct: 15 },
      { age_to_months: 24,  pct: 20 }, { age_to_months: 36,  pct: 30 },
      { age_to_months: 48,  pct: 40 }, { age_to_months: 999, pct: 50 }
    ],
    deductible_rules: { type: 'fixed', fixed: 2000 },
    penalty_rules:    { fr_pending_pct: 0, warranty_breach_pct: 10 },
    sla_days: 21
  },
  marine:      { depreciation_table: [], deductible_rules: { type: 'fixed', fixed: 5000 }, penalty_rules: { fr_pending_pct: 0, warranty_breach_pct: 10 }, sla_days: 30 },
  engineering: { depreciation_table: [], deductible_rules: { type: 'fixed', fixed: 10000 }, penalty_rules: { fr_pending_pct: 0, warranty_breach_pct: 10 }, sla_days: 45 },
  misc:        { depreciation_table: [], deductible_rules: { type: 'fixed', fixed: 5000 }, penalty_rules: { fr_pending_pct: 0, warranty_breach_pct: 10 }, sla_days: 30 }
};

export const INSURERS = [
  {
    id:   'ins-icici-lombard',
    name: 'ICICI Lombard General Insurance',
    code: 'ICICI_LOMBARD',
    irdai_license: 'IRDA/NL-HLY/ICICI/P&CS/2001/021',
    claims_dept_email: 'claimsupport@icicilombard.com',
    claims_dept_phone: '1800-2666',
    portal_url: 'https://www.icicilombard.com/claims',
    rules: {
      fire: {
        depreciation_table: [
          { age_to_months: 6,   pct: 0  }, { age_to_months: 12,  pct: 5  },
          { age_to_months: 24,  pct: 15 }, { age_to_months: 36,  pct: 25 },
          { age_to_months: 48,  pct: 35 }, { age_to_months: 60,  pct: 45 },
          { age_to_months: 999, pct: 50 }
        ],
        deductible_rules:   { type: 'percentage_or_fixed', pct: 5, fixed: 10000, minimum: 10000 },
        penalty_rules:      { fr_pending_pct: 25, warranty_breach_pct: 15 },
        sla_days: 30,
        document_checklist: [
          { name: 'FIR Copy',                      mandatory: true,  party: 'insured'  },
          { name: 'Fire Brigade Report',           mandatory: true,  party: 'insured'  },
          { name: 'Electrical Audit Report',       mandatory: true,  party: 'insured'  },
          { name: 'Stock Register (Pre-Loss)',      mandatory: true,  party: 'insured'  },
          { name: 'Purchase Invoices',             mandatory: true,  party: 'insured'  },
          { name: 'Sales Register',                mandatory: true,  party: 'insured'  },
          { name: 'Sprinkler/Hydrant Certificate', mandatory: true,  party: 'insured'  },
          { name: 'CCTV Footage',                  mandatory: false, party: 'insured'  },
          { name: 'Claim Form (ICICI Format)',      mandatory: true,  party: 'insured'  },
          { name: 'Surveyor Appointment Letter',   mandatory: true,  party: 'insurer'  },
          { name: 'Loss Assessment Report',        mandatory: true,  party: 'surveyor' }
        ],
        warranties:      [ { clause: 'Sprinkler system maintained & operational', breach_penalty_pct: 20 }, { clause: 'Fire extinguishers serviced within 12 months', breach_penalty_pct: 10 }, { clause: 'Electrical wiring inspected within 3 years', breach_penalty_pct: 15 }, { clause: 'Watchman present at all times', breach_penalty_pct: 15 } ],
        exclusions:      [ 'War & nuclear risks', 'Willful negligence by insured', 'Spontaneous combustion (unless endorsed)', 'Consequential loss' ],
        policy_clauses:  [ 'Average Clause', 'Reinstatement Value Clause', 'Subrogation Clause', 'Declaration Policy' ],
        assessment_formula: { steps: ['gross_loss','subtract_salvage','apply_deductible','apply_fr_penalty','apply_warranty_penalty','apply_average_clause'], average_clause: true }
      },
      burglary: {
        depreciation_table: [
          { age_to_months: 12,  pct: 10 }, { age_to_months: 24,  pct: 20 },
          { age_to_months: 36,  pct: 30 }, { age_to_months: 60,  pct: 40 },
          { age_to_months: 999, pct: 50 }
        ],
        deductible_rules:   { type: 'percentage_or_fixed', pct: 5, fixed: 10000, minimum: 10000 },
        penalty_rules:      { fr_pending_pct: 25, warranty_breach_pct: 15 },
        sla_days: 45,
        document_checklist: [
          { name: 'FIR Copy',                               mandatory: true,  party: 'insured'  },
          { name: 'Police Final Report (FR)',               mandatory: true,  party: 'insured'  },
          { name: 'Stock Register',                         mandatory: true,  party: 'insured'  },
          { name: 'Purchase Invoices',                      mandatory: true,  party: 'insured'  },
          { name: 'Spot Survey Photographs (min 10)',        mandatory: true,  party: 'surveyor' },
          { name: 'Security Guard Statement',               mandatory: true,  party: 'insured'  },
          { name: 'CCTV Footage / DVR Images',              mandatory: false, party: 'insured'  },
          { name: 'Burglar Alarm Maintenance Certificate',  mandatory: false, party: 'insured'  },
          { name: 'Claim Form (ICICI Format)',               mandatory: true,  party: 'insured'  }
        ],
        warranties:      [ { clause: 'Security guard present 24/7', breach_penalty_pct: 15 }, { clause: 'CCTV system operational', breach_penalty_pct: 10 }, { clause: 'Burglar alarm operational', breach_penalty_pct: 10 }, { clause: 'Double locking on entry points', breach_penalty_pct: 5 } ],
        exclusions:      [ 'War risks', 'Mysterious disappearance', 'Employee theft (unless endorsed)', 'Consequential loss' ],
        policy_clauses:  [ 'Average Clause', 'Subrogation Clause', 'FR Pending Clause' ],
        assessment_formula: { steps: ['stock_reported','subtract_recovery','verify_with_invoices','apply_depreciation','apply_deductible','apply_fr_penalty','apply_warranty_penalty'] }
      },
      motor: {
        depreciation_table: [
          { age_to_months: 6,   pct: 5  }, { age_to_months: 12,  pct: 15 },
          { age_to_months: 24,  pct: 20 }, { age_to_months: 36,  pct: 30 },
          { age_to_months: 48,  pct: 40 }, { age_to_months: 60,  pct: 50 },
          { age_to_months: 999, pct: 60 }
        ],
        deductible_rules:   { type: 'fixed', fixed: 2000, compulsory_excess: 1000 },
        penalty_rules:      { fr_pending_pct: 0, warranty_breach_pct: 10 },
        sla_days: 21,
        document_checklist: [
          { name: 'RC Copy',                 mandatory: true,  party: 'insured'  },
          { name: 'Driving License',         mandatory: true,  party: 'insured'  },
          { name: 'FIR Copy (theft/TP)',     mandatory: false, party: 'insured'  },
          { name: 'Repair Invoice',          mandatory: true,  party: 'insured'  },
          { name: 'Spot/Loss Photographs',   mandatory: true,  party: 'surveyor' },
          { name: 'Fitness Certificate',     mandatory: false, party: 'insured'  },
          { name: 'Claim Form (ICICI Motor)',mandatory: true,  party: 'insured'  }
        ],
        warranties:      [ { clause: 'Valid driving license at time of loss', breach_penalty_pct: 100 }, { clause: 'Vehicle used as per permitted use', breach_penalty_pct: 50 } ],
        exclusions:      [ 'Wear & tear', 'Mechanical breakdown', 'Drunk driving', 'Consequential loss' ],
        policy_clauses:  [ 'Compulsory Deductible', 'Voluntary Deductible', 'NCB Clause', 'Betterment Clause' ],
        assessment_formula: { steps: ['repair_estimate','subtract_betterment','apply_depreciation','subtract_compulsory_deductible'], betterment_factor: 0.2 }
      }
    }
  },
  {
    id:   'ins-hdfc-ergo',
    name: 'HDFC ERGO General Insurance',
    code: 'HDFC_ERGO',
    irdai_license: 'IRDA/NL-HLY/HDFCERGO/P&CS/2002/012',
    claims_dept_email: 'customerservice@hdfcergo.com',
    claims_dept_phone: '022-61426242',
    portal_url: 'https://www.hdfcergo.com/claims',
    rules: {
      fire: {
        depreciation_table: [
          { age_to_months: 12,  pct: 0  }, { age_to_months: 24,  pct: 10 },
          { age_to_months: 36,  pct: 20 }, { age_to_months: 60,  pct: 35 },
          { age_to_months: 999, pct: 50 }
        ],
        deductible_rules:   { type: 'percentage_or_fixed', pct: 5, fixed: 15000, minimum: 15000 },
        penalty_rules:      { fr_pending_pct: 20, warranty_breach_pct: 20 },
        sla_days: 30,
        document_checklist: [
          { name: 'FIR Copy',                   mandatory: true,  party: 'insured'  },
          { name: 'Fire Brigade Report',         mandatory: true,  party: 'insured'  },
          { name: 'Stock Register',              mandatory: true,  party: 'insured'  },
          { name: 'Purchase Invoices',           mandatory: true,  party: 'insured'  },
          { name: 'CCTV Footage',                mandatory: true,  party: 'insured'  },
          { name: 'Claim Form (HDFC Format)',    mandatory: true,  party: 'insured'  },
          { name: 'Financial Statements (2 yr)', mandatory: false, party: 'insured'  },
          { name: 'Loss Assessment Report',      mandatory: true,  party: 'surveyor' }
        ],
        warranties:     [ { clause: 'Fire suppression system maintained', breach_penalty_pct: 20 }, { clause: 'Security guard deployed', breach_penalty_pct: 20 }, { clause: 'No hazardous goods stored', breach_penalty_pct: 30 } ],
        exclusions:     [ 'War', 'Riot (unless RSMD endorsed)', 'Spontaneous combustion', 'Willful negligence' ],
        policy_clauses: [ 'Average Clause', 'Reinstatement Value', 'Subrogation' ],
        assessment_formula: { steps: ['gross_loss','subtract_salvage','apply_deductible','apply_fr_penalty','apply_warranty_penalty'], average_clause: true }
      },
      burglary: {
        depreciation_table: [
          { age_to_months: 12,  pct: 10 }, { age_to_months: 24,  pct: 20 },
          { age_to_months: 60,  pct: 35 }, { age_to_months: 999, pct: 50 }
        ],
        deductible_rules:   { type: 'percentage_or_fixed', pct: 5, fixed: 15000, minimum: 15000 },
        penalty_rules:      { fr_pending_pct: 20, warranty_breach_pct: 20 },
        sla_days: 45,
        document_checklist: [
          { name: 'FIR Copy',                     mandatory: true,  party: 'insured'  },
          { name: 'FR / Charge Sheet',             mandatory: true,  party: 'insured'  },
          { name: 'Stock Register',                mandatory: true,  party: 'insured'  },
          { name: 'Purchase Invoices',             mandatory: true,  party: 'insured'  },
          { name: 'Spot Photographs',              mandatory: true,  party: 'surveyor' },
          { name: 'Security Arrangement Details',  mandatory: true,  party: 'insured'  },
          { name: 'Claim Form (HDFC Format)',       mandatory: true,  party: 'insured'  }
        ],
        warranties:     [ { clause: 'Security guard present 24/7', breach_penalty_pct: 20 }, { clause: 'CCTV operational', breach_penalty_pct: 15 }, { clause: 'Alarm system operational', breach_penalty_pct: 10 } ],
        exclusions:     [ 'Mysterious disappearance', 'Employee infidelity', 'Consequential loss' ],
        policy_clauses: [ 'Average Clause', 'Subrogation', 'FR Pending Clause' ],
        assessment_formula: { steps: ['stock_reported','verify_invoices','apply_depreciation','apply_deductible','apply_fr_penalty','apply_warranty_penalty'] }
      }
    }
  },
  {
    id:   'ins-new-india',
    name: 'New India Assurance Co. Ltd.',
    code: 'NEW_INDIA',
    irdai_license: 'IRDA/NL-HLY/NIAC/P&CS/2001/002',
    claims_dept_email: 'info@newindia.co.in',
    claims_dept_phone: '022-22708282',
    portal_url: 'https://www.newindia.co.in/content/Claims',
    rules: {
      fire: {
        depreciation_table: [
          { age_to_months: 6,   pct: 0  }, { age_to_months: 12,  pct: 5  },
          { age_to_months: 24,  pct: 15 }, { age_to_months: 36,  pct: 25 },
          { age_to_months: 48,  pct: 35 }, { age_to_months: 60,  pct: 45 },
          { age_to_months: 999, pct: 50 }
        ],
        deductible_rules:   { type: 'percentage_or_fixed', pct: 5, fixed: 10000, minimum: 10000 },
        penalty_rules:      { fr_pending_pct: 25, warranty_breach_pct: 15 },
        sla_days: 30,
        document_checklist: [
          { name: 'FIR Copy',                       mandatory: true,  party: 'insured'  },
          { name: 'Fire Brigade Report',             mandatory: true,  party: 'insured'  },
          { name: 'Electrical Audit Report',         mandatory: true,  party: 'insured'  },
          { name: 'Stock Register',                  mandatory: true,  party: 'insured'  },
          { name: 'Purchase Invoices',               mandatory: true,  party: 'insured'  },
          { name: 'Sprinkler/Hydrant Certificate',   mandatory: true,  party: 'insured'  },
          { name: 'Security Logs',                   mandatory: true,  party: 'insured'  },
          { name: 'Claim Form (NIA Format)',          mandatory: true,  party: 'insured'  },
          { name: 'Loss Assessment Report',          mandatory: true,  party: 'surveyor' },
          { name: 'Photographs (min 10)',             mandatory: true,  party: 'surveyor' }
        ],
        warranties:     [ { clause: 'Fire fighting equipment maintained', breach_penalty_pct: 15 }, { clause: 'Security guard deployed', breach_penalty_pct: 15 }, { clause: 'No overloading of electrical lines', breach_penalty_pct: 15 } ],
        exclusions:     [ 'War', 'Riot', 'Spontaneous combustion', 'Willful act' ],
        policy_clauses: [ 'Average Clause', 'Reinstatement', 'Subrogation', 'First Loss' ],
        assessment_formula: { steps: ['gross_loss','subtract_salvage','apply_deductible','apply_fr_penalty','apply_warranty_penalty','apply_average_clause'], average_clause: true }
      },
      burglary: {
        depreciation_table: [
          { age_to_months: 12,  pct: 10 }, { age_to_months: 24,  pct: 20 },
          { age_to_months: 36,  pct: 30 }, { age_to_months: 60,  pct: 40 },
          { age_to_months: 999, pct: 50 }
        ],
        deductible_rules:   { type: 'percentage_or_fixed', pct: 5, fixed: 10000, minimum: 10000 },
        penalty_rules:      { fr_pending_pct: 25, warranty_breach_pct: 15 },
        sla_days: 45,
        document_checklist: [
          { name: 'FIR Copy',                      mandatory: true,  party: 'insured'  },
          { name: 'Final Police Report',            mandatory: true,  party: 'insured'  },
          { name: 'Stock Register',                 mandatory: true,  party: 'insured'  },
          { name: 'Purchase Invoices',              mandatory: true,  party: 'insured'  },
          { name: 'Spot Photographs (min 10)',       mandatory: true,  party: 'surveyor' },
          { name: 'Mechanical Inspection Report',   mandatory: false, party: 'surveyor' },
          { name: 'Claim Form (NIA Format)',         mandatory: true,  party: 'insured'  }
        ],
        warranties:     [ { clause: 'Security guard present 24/7', breach_penalty_pct: 15 }, { clause: 'CCTV system operational', breach_penalty_pct: 10 } ],
        exclusions:     [ 'Employee theft', 'Mysterious disappearance', 'Consequential loss' ],
        policy_clauses: [ 'Average Clause', 'Subrogation', 'FR Pending Clause' ],
        assessment_formula: { steps: ['stock_reported','verify_invoices','apply_depreciation','apply_deductible','apply_fr_penalty','apply_warranty_penalty'] }
      }
    }
  },
  {
    id:   'ins-bajaj-allianz',
    name: 'Bajaj Allianz General Insurance',
    code: 'BAJAJ_ALLIANZ',
    irdai_license: 'IRDA/NL-HLY/BAGI/P&CS/2001/018',
    claims_dept_email: 'customercare@bajajallianz.co.in',
    claims_dept_phone: '1800-209-0144',
    portal_url: 'https://www.bajajallianz.com/claims.html',
    rules: {
      fire: {
        depreciation_table: [
          { age_to_months: 12,  pct: 0  }, { age_to_months: 24,  pct: 10 },
          { age_to_months: 36,  pct: 20 }, { age_to_months: 48,  pct: 30 },
          { age_to_months: 60,  pct: 40 }, { age_to_months: 999, pct: 50 }
        ],
        deductible_rules:   { type: 'percentage_or_fixed', pct: 5, fixed: 10000, minimum: 10000 },
        penalty_rules:      { fr_pending_pct: 20, warranty_breach_pct: 15 },
        sla_days: 30,
        document_checklist: [
          { name: 'FIR Copy',            mandatory: true,  party: 'insured'  },
          { name: 'Fire Brigade Report', mandatory: true,  party: 'insured'  },
          { name: 'Stock Register',      mandatory: true,  party: 'insured'  },
          { name: 'Purchase Invoices',   mandatory: true,  party: 'insured'  },
          { name: 'Surveyor Report',     mandatory: true,  party: 'surveyor' },
          { name: 'Claim Form (BA)',     mandatory: true,  party: 'insured'  }
        ],
        warranties:     [ { clause: 'Fire equipment maintained', breach_penalty_pct: 15 }, { clause: 'Security guard deployed', breach_penalty_pct: 15 } ],
        exclusions:     [ 'War', 'Willful negligence', 'Spontaneous combustion' ],
        policy_clauses: [ 'Average Clause', 'Reinstatement', 'Subrogation' ],
        assessment_formula: { steps: ['gross_loss','apply_deductible','apply_penalties'], average_clause: true }
      }
    }
  },
  {
    id:   'ins-oriental',
    name: 'Oriental Insurance Co. Ltd.',
    code: 'ORIENTAL',
    irdai_license: 'IRDA/NL-HLY/OIC/P&CS/2001/003',
    claims_dept_email: 'customercare@orientalinsurance.org.in',
    claims_dept_phone: '011-33208485',
    portal_url: 'http://www.orientalinsurance.org.in',
    rules: {}  // Will use IRDAI fallback
  }
];
