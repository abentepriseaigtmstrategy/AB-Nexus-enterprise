// backend/openai-chat.js — McLarens Nexus Enterprise v5.0
// GPT-4o Vision OCR + Insurer-aware AI + Structured breach detection

const OPENAI_BASE = 'https://api.openai.com/v1';

async function openAIFetch(env, endpoint, body) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  const res = await fetch(`${OPENAI_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

// ── Unified Document Intelligence (Vision + Text) ────────────────────────
export async function analyzeDocumentContent(env, { imageBase64, textContent, mimeType, context, isTruncated = false }) {
  const isImage = !!imageBase64;
  const truncateNotice = isTruncated ? "\n(NOTE: Content was truncated due to size limits. Extract based on available context.)" : "";
  
  const systemPrompt = (context === 'handwritten_report'
    ? `Extract all text from this handwritten insurance survey note (Indian field surveyor). 
Detect the input language automatically.
Return ONLY valid JSON.
{
  "raw_text": "...",
  "structured": {"date":null,"location":null,"contact_person":null,"fir_number":null,"police_station":null,"loss_description":null,"observations":[],"amounts":[],"surveyor_name":null,"signature_present":false},
  "confidence": 85,
  "language_detected": "...",
  "truncated": ${isTruncated}
}`
    : `Extract all text from this insurance document.
Detect the input language automatically.
Return ONLY valid JSON.
{
  "raw_text": "...",
  "document_type": "fir|invoice|stock_register|certificate|photo|other",
  "key_fields": {"amount":null,"date":null,"reference_number":null,"parties":[]},
  "confidence": 85,
  "language_detected": "...",
  "truncated": ${isTruncated}
}`) + truncateNotice;

  const userContent = isImage 
    ? [
        { type: 'image_url', image_url: { url: `data:${mimeType||'image/jpeg'};base64,${imageBase64}`, detail: 'high' } },
        { type: 'text', text: systemPrompt }
      ]
    : `DOCUMENT CONTENT:\n${textContent}\n\n${systemPrompt}`;

  async function callAI() {
    return await openAIFetch(env, '/chat/completions', {
      model: 'gpt-4o',
      max_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: userContent }]
    });
  }

  let data, raw;
  try {
    data = await callAI();
    raw  = data.choices[0]?.message?.content || '{}';
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[AI Analysis] First attempt failed, retrying...', err.message);
    try {
      data = await callAI();
      raw  = data.choices[0]?.message?.content || '{}';
      return JSON.parse(raw);
    } catch (retryErr) {
      console.error('[AI Analysis] Critical failure after retry:', retryErr.message);
      return { raw_text: raw || "Extraction failed.", confidence: 0, structured: {}, language_detected: 'unknown', truncated: isTruncated, error: true };
    }
  }
}

// ── Main chat handler (insurer-aware) ─────────────────────────────────────
export async function handleChatRequest(message, platform, user, env) {
  const sysPrompts = {
    surveyor: `You are a senior insurance claims AI for McLarens India — India's top independent loss assessors.

Expert in: IRDAI regulations, ICICI Lombard/HDFC ERGO/New India/Oriental/Bajaj claims manuals, BNS 2023, IPC, Insurance Act 1938, MV Act 1988, loss assessment methodology, depreciation tables, average clause, subrogation.

RULES:
- Use INSURER's custom rules first. IRDAI is FALLBACK only.
- ALL write suggestions must include JSON action block starting with ACTION_PROPOSAL:
- Never finalize settlement — propose for human confirmation only.
User: ${user.name} (${user.role})`,

    surveyor_ai: `Return ONLY valid JSON. No markdown, no preamble.`,

    hrms: `You are an AI HR assistant for McLarens India HRMS.
Topics: leave policies, payroll queries, performance management, grievances, Indian labour law.
User: ${user.name} (${user.role})`
  };

  // Get recent context
  let history = [];
  try {
    const rows = await env.DB.prepare(
      'SELECT role,content FROM chat_history WHERE user_id=? AND platform=? ORDER BY created_at DESC LIMIT 8'
    ).bind(user.id, platform).all();
    history = [...(rows.results || [])].reverse().map(r => ({ role: r.role, content: r.content }));
  } catch {}

  const messages = [
    { role: 'system', content: sysPrompts[platform] || sysPrompts.surveyor },
    ...history,
    { role: 'user', content: message }
  ];

  try {
    const data = await openAIFetch(env, '/chat/completions', {
      model: 'gpt-4o',
      messages,
      temperature: platform === 'surveyor_ai' ? 0.1 : 0.5,
      max_tokens: 1200
    });
    return data.choices[0]?.message?.content || 'No response.';
  } catch (err) {
    console.error('[AI Chat]', err.message);
    return platform === 'hrms'
      ? 'AI unavailable. Contact your HR administrator for urgent matters.'
      : 'AI unavailable. Refer to Surveyor Manual or contact your senior surveyor.';
  }
}

// ── Warranty breach detection ─────────────────────────────────────────────
export async function detectWarrantyBreaches(env, { claimData, uploadedDocs, warranties, insurerName, departmentCode }) {
  const docs = uploadedDocs.map(d => ({
    type: d.document_type, name: d.filename,
    ocr: d.ocr_extracted_data ? JSON.parse(d.ocr_extracted_data) : null
  }));

  const prompt = `Insurance claim warranty breach analysis.
Insurer: ${insurerName} | Dept: ${departmentCode} | Claim: ${claimData.claim_number}
Loss Date: ${claimData.incident_date ? new Date(claimData.incident_date).toLocaleDateString('en-IN') : 'Unknown'}
Loss: ₹${(claimData.loss_amount||0).toLocaleString()}

Warranties (${insurerName} manual):
${warranties.map((w,i)=>`${i+1}. ${w.clause} → Penalty: ${w.breach_penalty_pct}%`).join('\n')}

Uploaded docs OCR: ${JSON.stringify(docs)}

Return ONLY JSON:
{"breaches":[{"warranty":"...","breach_detected":true,"confidence":85,"evidence":"...","penalty_pct":15,"recommendation":"apply|review|dismiss"}],"overall_assessment":"...","recommended_total_penalty_pct":0,"source":"${insurerName} claims manual"}`;

  try {
    const data = await openAIFetch(env, '/chat/completions', {
      model: 'gpt-4o', temperature: 0.1, max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    });
    return JSON.parse(data.choices[0]?.message?.content || '{}');
  } catch (err) {
    console.error('[AI Breach]', err.message);
    return { breaches: [], overall_assessment: 'AI analysis failed — manual review required.', recommended_total_penalty_pct: 0 };
  }
}

// ── Cross-document verification ───────────────────────────────────────────
// ── Compute settlement using insurer rules ────────────────────────────────
export function computeSettlementFromRules({ grossLoss, sumInsured, ageMonths, recoveredAmount=0, rules, frPending=false, additionalWarrantyPct=0, insurerName, departmentCode }) {
  const depTable = rules?.depreciation_table || [];
  let depnPct = 0;
  for (const tier of depTable) {
    const ageTo = tier.age_to_months ?? tier.age_to ?? 999;
    if (ageMonths <= ageTo) { depnPct = tier.pct || 0; break; }
  }
  const ded = rules?.deductible_rules || {};
  let deductible;
  if (ded.type === 'fixed') {
    deductible = ded.fixed || 2000;
  } else {
    const pctAmt = grossLoss * ((ded.pct || 5) / 100);
    deductible = Math.max(pctAmt, ded.minimum || ded.fixed || 10000);
  }
  const pen = rules?.penalty_rules || {};
  const frPct = frPending ? (pen.fr_pending_pct || 25) : 0;
  const warrantyPct = additionalWarrantyPct || 0;
  const depnAmt = Math.round(grossLoss * depnPct / 100);
  let net = grossLoss - depnAmt - deductible - recoveredAmount;
  net = Math.max(0, net);
  net = Math.round(net * (1 - frPct/100));
  net = Math.round(net * (1 - warrantyPct/100));
  const avgClause = sumInsured > 0 && sumInsured < grossLoss;
  if (avgClause) net = Math.round(net * (sumInsured / grossLoss));
  return { gross_loss: grossLoss, depreciation_pct: depnPct, depreciation_amount: depnAmt, deductible: Math.round(deductible), fr_penalty_pct: frPct, warranty_penalty_pct: warrantyPct, average_clause_applied: avgClause, net_settlement: net, settlement_pct: grossLoss > 0 ? parseFloat(((net/grossLoss)*100).toFixed(1)) : 0, source: `${insurerName} ${departmentCode} rules v${rules?.rules_version||'1.0'}` };
}

// ── Generate claim insights ───────────────────────────────────────────────
export async function generateClaimInsights(claimData, env) {
  const prompt = `Analyse Indian insurance claim. Be concise.\nClaim: ${claimData.claim_number} | Dept: ${claimData.department}\nLoss: Rs.${(claimData.loss_amount||0).toLocaleString()} | Status: ${claimData.claim_status}\nCircumstances: ${claimData.circumstances || 'Not provided'}\nReturn: fraud risk level + reasoning, 3 investigation steps, key clauses to verify, settlement range estimate.`;
  try {
    const data = await openAIFetch(env, '/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], temperature: 0.4, max_tokens: 500 });
    return data.choices[0]?.message?.content || null;
  } catch { return null; }
}

// ── Generate report draft ─────────────────────────────────────────────────
export async function generateReportDraft(env, reportType, claimData, documents, calculation) {
  const typeDesc = { jir:'Joint Inspection Report', spot:'Spot Report', lor:'Letter of Requirements', psr:'Preliminary Survey Report', interim:'Interim Survey Report', fsr:'Final Survey Report' };
  const docList = (documents||[]).map(d => `- ${d.document_type}: ${d.filename}`).join('\n') || 'None uploaded yet';
  const schemas = {
    jir:  '{"report_date":"","insured_details":{},"incident_summary":"","preliminary_observations":"","damage_observed":"","immediate_recommendations":"","next_steps":"","narrative":""}',
    spot: '{"report_date":"","survey_observations":"","damage_assessment":"","preliminary_loss_estimate":0,"further_documents_required":[],"narrative":""}',
    lor:  '{"date":"","salutation":"Dear Sir/Madam,","reference":"","requirements":[{"item":"","reason":"","party":"insured"}],"closing":"","narrative":""}',
    psr:  '{"report_date":"","executive_summary":"","insured_profile":{},"policy_synopsis":{},"incident_analysis":"","survey_findings":"","documents_received":[],"documents_pending":[],"narrative":""}',
    interim: '{"report_date":"","progress_summary":"","updated_findings":"","preliminary_quantum":0,"outstanding_issues":"","narrative":""}',
    fsr:  '{"report_date":"","executive_summary":"","insured_profile":{},"policy_details":{},"incident_analysis":"","cause_of_loss":"","survey_findings":"","documents_reviewed":[],"financial_assessment":{},"net_liability_recommended":0,"surveyor_comments":"","recommendation":"","narrative":""}'
  };
  const prompt = `You are a senior IRDAI-licensed insurance surveyor writing a formal ${reportType.toUpperCase()} (${typeDesc[reportType]||reportType}).\nCLAIM: ${claimData.claim_number} | Insurer: ${claimData.insurer_name||'N/A'} | Dept: ${claimData.department}\nInsured: ${claimData.insured_name} | SI: Rs.${(claimData.sum_insured||0).toLocaleString('en-IN')} | Claimed: Rs.${(claimData.loss_amount||0).toLocaleString('en-IN')}\nDate of Loss: ${claimData.incident_date ? new Date(claimData.incident_date).toDateString() : 'N/A'}\nCircumstances: ${claimData.circumstances||'N/A'}\nDocuments: ${docList}\nFinancials: ${JSON.stringify(calculation||{})}\nReturn ONLY valid JSON matching: ${schemas[reportType]||schemas.fsr}`;
  try {
    const data = await openAIFetch(env, '/chat/completions', { model: 'gpt-4o', max_tokens: 3000, temperature: 0.2, messages: [{ role:'system', content:'Return ONLY valid JSON, no markdown.' }, { role:'user', content:prompt }] });
    const raw = data.choices[0]?.message?.content || '{}';
    try { return JSON.parse(raw.replace(/```json|```/g,'').trim()); }
    catch { return { narrative: raw, generated_at: Date.now() }; }
  } catch (err) { return { narrative: '', error: err.message, generated_at: Date.now() }; }
}

export async function crossVerifyDocuments(env, claimId, documents) {
  if (!documents || documents.length < 2) return { conflicts: [] };

  const docSummaries = documents
    .filter(d => d.ocr_extracted_data)
    .map(d => {
      try { return { type: d.document_type, data: JSON.parse(d.ocr_extracted_data) }; }
      catch { return null; }
    }).filter(Boolean);

  if (docSummaries.length < 2) return { conflicts: [] };

  const prompt = `Analyse these insurance documents for claim ${claimId} and identify ALL data conflicts.
Focus on: date discrepancies, name mismatches, amount inconsistencies, policy number conflicts.
Documents: ${JSON.stringify(docSummaries)}
Return ONLY JSON: {"conflicts":[{"field":"","doc1_type":"","doc1_value":"","doc2_type":"","doc2_value":"","severity":"low|medium|high"}],"overall_consistency":"high|medium|low"}`;

  try {
    const data = await openAIFetch(env, '/chat/completions', {
      model: 'gpt-4o',
      max_tokens: 1000,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'You are an insurance fraud detection AI. Return ONLY valid JSON.' },
        { role: 'user', content: prompt }
      ]
    });
    const raw = data.choices[0]?.message?.content || '{"conflicts":[]}';
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { conflicts: [] };
  }
}



// ── Scanned PDF → Vision OCR ─────────────────────────────────────────────
// Converts scanned PDF buffer to base64 and sends to GPT-4o vision.
// Exported and called from both /api/ocr and /api/upload in index.js.
export async function analyzeScannedPDF(env, pdfBuffer, filename, context = 'document') {
  const bytes = new Uint8Array(pdfBuffer);
  const CHUNK = 32768;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    for (let j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
  }
  const imageBase64 = btoa(binary);
  return await analyzeDocumentContent(env, {
    imageBase64,
    mimeType: 'application/pdf',
    context,
    isTruncated: false
  });
}
