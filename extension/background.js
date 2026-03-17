// MailGuard Pro v7 — background.js (Local ML Server Edition)
// API runs at http://localhost:5000

const API_BASE     = "https://fortunate-dream.up.railway.app";
const ANALYZE_URL     = `${API_BASE}/api/analyze`;
const OPENAI_API_URL  = "https://api.openai.com/v1/chat/completions";
const POLL_INTERVAL   = 30;        // seconds
const AUTO_BLOCK_THRESHOLD = 3;    // critical emails before auto-block
const MAX_RESULTS     = 500;

// ── State ──────────────────────────────────────────────────────────────────
let state = {
  active: false,
  results: [],
  blockedSenders: {},
  xMailerSenders: {},
  userEmail: '',
  accessToken: null,
  theme: 'dark',
  lastChecked: null,
  cancelHistoryFetch: false,
  isHistoryFetching: false,
  openaiApiKey: '',
};

// ── Storage ────────────────────────────────────────────────────────────────
async function loadState() {
  const d = await chrome.storage.local.get([
    'analysisResults','detectionActive','blockedSenders',
    'xMailerSenders','openaiApiKey','theme','lastChecked','userEmail'
  ]);
  state.results        = d.analysisResults  || [];
  state.active         = d.detectionActive  || false;
  state.blockedSenders = d.blockedSenders   || {};
  state.xMailerSenders = d.xMailerSenders   || {};
  state.openaiApiKey   = d.openaiApiKey     || '';
  state.theme          = d.theme            || 'dark';
  state.lastChecked    = d.lastChecked      || null;
  state.userEmail      = d.userEmail        || '';
}

async function saveResults() {
  await chrome.storage.local.set({ analysisResults: state.results.slice(0, MAX_RESULTS) });
}

async function saveBlockedSenders() {
  await chrome.storage.local.set({ blockedSenders: state.blockedSenders });
}

// ── OAuth ──────────────────────────────────────────────────────────────────
async function getAccessToken(interactive = false) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(token);
    });
  });
}

async function ensureToken(interactive = false) {
  try {
    if (!state.accessToken) state.accessToken = await getAccessToken(interactive);
    return state.accessToken;
  } catch { return null; }
}

async function getUserEmail(token) {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const d = await r.json();
    return d.email || '';
  } catch { return ''; }
}

// ── Local ML API ───────────────────────────────────────────────────────────
async function callModelAPI(type, content, sender = '') {
  try {
    const r = await fetch(ANALYZE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, content, sender }),
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      const msg = e.error || `HTTP ${r.status}`;
      console.error(`[MailGuard] Model API error (${type}):`, msg);
      throw new Error(msg);
    }
    const result = await r.json();
    console.log(`[MailGuard] Model (${type}): prediction=${result.prediction}, confidence=${result.confidence}`);
    return result;
  } catch (e) {
    console.error(`[MailGuard] callModelAPI(${type}) failed:`, e.message);
    throw e;
  }
}

// ── OpenAI Suggestion ──────────────────────────────────────────────────────
async function getOpenAISuggestion(emailData) {
  const key = state.openaiApiKey;
  if (!key) return { error: 'No OpenAI API key set. Add it in Settings.' };
  const mr = emailData.modelResult || {};
  const hc = emailData.headerCheck || {};

  const prompt = `You are a cybersecurity expert. Analyse this email threat assessment and give a 4-5 sentence security assessment explaining the key red flags and exact recommended actions.

Email From: ${emailData.from || 'Unknown'}
Subject: ${emailData.subject || 'None'}
Risk Score: ${emailData.riskScore}/100 (${emailData.riskLabel})
Classification: ${emailData.classification}
ML Prediction: ${mr.prediction || 'N/A'} (${mr.confidence || 0}% confidence)
Risk Tier: ${mr.risk_tier || 'N/A'}
Auth: SPF=${hc.spfPass?'PASS':'FAIL'}, DKIM=${hc.dkimOk?'OK':'MISSING'}, DMARC=${hc.dmarcPass?'PASS':'N/A'}
X-Mailer: ${hc.xMailer?.value || 'None'}
Header Flags: ${(hc.flags||[]).map(f=>f.label).join(', ') || 'None'}
Links Flagged: ${emailData.links?.filter(l=>l.risk>=40).length || 0}
Evidence Tokens: ${(mr.evidence||[]).slice(0,4).map(e=>e.token||e.feature||'').join(', ')}
Body Preview: ${(emailData.bodyPreview||'').slice(0,200)}

Respond with a clear, actionable security assessment. No bullet points — flowing prose.`;

  try {
    const r = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await r.json();
    if (!r.ok) return { error: d.error?.message || `OpenAI error ${r.status}` };
    return { suggestion: d.choices[0]?.message?.content?.trim() || 'No response.' };
  } catch (e) { return { error: e.message }; }
}

// ── X-Mailer analysis ──────────────────────────────────────────────────────
function analyzeXMailer(xMailer) {
  if (!xMailer) return null;
  const xl = xMailer.toLowerCase();
  const highRisk = ['phpmailer', 'sendmail', 'php/', 'php mail', 'swiftmailer', 'postfix', 'exim', 'sendgrid/php'];
  const suspicious = ['mailchimp', 'constantcontact', 'aweber', 'klaviyo', 'sendinblue', 'mailjet', 'marketo', 'hubspot', 'massmailer', 'bulk'];
  const isHigh = highRisk.some(s => xl.includes(s));
  const isSusp = !isHigh && suspicious.some(s => xl.includes(s));
  return { value: xMailer, detected: isHigh || isSusp, highRisk: isHigh, suspicious: isSusp, penalty: isHigh ? 25 : isSusp ? 12 : 0 };
}

function trackXMailerSender(email, xMailerInfo) {
  if (!email || !xMailerInfo?.detected) return;
  if (!state.xMailerSenders[email]) state.xMailerSenders[email] = { count: 0, xMailer: xMailerInfo.value };
  state.xMailerSenders[email].count++;
  chrome.storage.local.set({ xMailerSenders: state.xMailerSenders });
}

// ── Auto-block ─────────────────────────────────────────────────────────────
async function checkAndAutoBlock(senderEmail, riskScore) {
  if (!senderEmail || riskScore < 80) return;
  const history = state.results.filter(r => r.senderEmail === senderEmail && r.riskScore >= 80);
  if (history.length >= AUTO_BLOCK_THRESHOLD && !state.blockedSenders[senderEmail]) {
    state.blockedSenders[senderEmail] = { blockedAt: Date.now(), count: history.length, reason: `${history.length} critical emails` };
    await saveBlockedSenders();
    chrome.notifications.create(`blocked-${senderEmail}`, {
      type: 'basic', iconUrl: 'icons/icon48.png',
      title: 'Sender Auto-Blocked',
      message: `${senderEmail} has been blocked (${history.length} critical emails detected).`
    });
    broadcastToTabs({ type: 'SENDER_BLOCKED', sender: senderEmail });
  }
}

// ── Header parsing ─────────────────────────────────────────────────────────
function parseEmailHeaders(headers = []) {
  const hmap = {};
  headers.forEach(h => { hmap[h.name.toLowerCase()] = h.value; });

  const auth = hmap['authentication-results'] || hmap['arc-authentication-results'] || '';
  const spfPass   = /spf=pass/i.test(auth)  || /spf=pass/i.test(hmap['received-spf']||'');
  const dkimOk    = /dkim=pass/i.test(auth) || !!(hmap['dkim-signature']);
  const dmarcPass = /dmarc=pass/i.test(auth);

  const replyTo = hmap['reply-to'] || '';
  const returnPath = hmap['return-path'] || '';
  const from    = hmap['from'] || '';
  const xMailer = analyzeXMailer(hmap['x-mailer']);

  const fromDomain     = (from.match(/@([\w.-]+)/)?.[1]||'').toLowerCase();
  const replyToDomain  = (replyTo.match(/@([\w.-]+)/)?.[1]||'').toLowerCase();
  const returnDomain   = (returnPath.match(/@([\w.-]+)/)?.[1]||'').toLowerCase();

  const flags = [];
  let penalty = 0;
  if (!spfPass)  { flags.push({label:'SPF failed or missing',severity:'high'}); penalty += 20; }
  if (!dkimOk)   { flags.push({label:'DKIM signature not present',severity:'medium'}); penalty += 8; }
  if (!dmarcPass && spfPass) { /* soft */ }
  if (replyTo && fromDomain && replyToDomain !== fromDomain) { flags.push({label:`Reply-To domain mismatch: ${replyToDomain}`,severity:'high'}); penalty += 22; }
  if (returnPath && fromDomain && returnDomain !== fromDomain) { flags.push({label:`Return-Path domain mismatch`,severity:'medium'}); penalty += 12; }
  if (xMailer?.highRisk) { flags.push({label:`Risky mailer: ${xMailer.value}`,severity:'high'}); penalty += 25; }
  else if (xMailer?.suspicious) { flags.push({label:`Bulk mailer: ${xMailer.value}`,severity:'medium'}); penalty += 12; }

  return { spfPass, dkimOk, dmarcPass, flags, penalty, xMailer, from, replyTo, returnPath };
}

// ── Link scoring ───────────────────────────────────────────────────────────
async function scoreLinks(urls) {
  const scored = [];
  for (const url of urls.slice(0, 8)) {
    let risk = 5, flags = [], mr = null;
    try {
      mr   = await callModelAPI('url', url);
      // Use model confidence directly as risk score
      risk = mr.prediction === 'malicious' || mr.prediction === 'phishing' || mr.prediction === 'malware'
        ? Math.round(mr.confidence)
        : Math.round(100 - mr.confidence);
      if (mr.adversarial_flags?.length) flags = mr.adversarial_flags.slice(0, 3);
    } catch {
      // Only fall back to heuristics if server is unreachable
      const u = url.toLowerCase();
      if (/@/.test(u))                                                    { flags.push('at-symbol');     risk = 45; }
      if (/\d{1,3}(\.\d{1,3}){3}/.test(u))                               { flags.push('ip-address');    risk = 55; }
      if (/bit\.ly|tinyurl|goo\.gl|t\.co/.test(u))                       { flags.push('shortened-url'); risk = 35; }
      if (/\.xyz|\.top|\.click|\.loan|\.tk|\.ml|\.cf|\.ga/.test(u))      { flags.push('bad-tld');       risk = 40; }
    }
    scored.push({ url, risk: Math.min(100, Math.round(risk)), flags, modelResult: mr });
  }
  return scored;
}

// ── Extract URLs ───────────────────────────────────────────────────────────
function extractUrls(text = '') {
  const matches = text.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
  return [...new Set(matches.filter(u => !u.includes('google.com/mail') && !u.includes('gstatic.com')))].slice(0, 10);
}

// ── Composite risk ─────────────────────────────────────────────────────────
function calcRisk(modelResult) {
  if (!modelResult || modelResult.prediction === undefined) return null; // model failed
  const conf = modelResult.confidence || 0;
  const isDanger = ['phishing','malicious','malware','scam','injection'].includes(modelResult.prediction);
  return Math.min(100, Math.round(isDanger ? conf : 100 - conf));
}

function getRiskLabel(score) {
  if (score === null || score === undefined) return 'ERROR';
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 35) return 'MEDIUM';
  return 'SAFE';
}

function getClassification(modelResult) {
  if (!modelResult || modelResult.prediction === undefined) return 'error';
  const pred = (modelResult.prediction || '').toLowerCase();
  if (['phishing','malware','malicious'].includes(pred)) return 'phishing';
  if (pred === 'scam')       return 'scam';
  if (pred === 'spam')       return 'spam';
  if (pred === 'injection')  return 'suspicious';
  if (pred === 'suspicious') return 'suspicious';
  if (pred === 'safe' || pred === 'benign' || pred === 'legitimate') return 'legitimate';
  return 'unknown';
}

// ── Analyse single email ───────────────────────────────────────────────────
async function analyzeEmail(msg, gmailLabel = 'INBOX') {
  const headers = msg.payload?.headers || [];
  const getH = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';

  const from     = getH('From');
  const subject  = getH('Subject');
  const dateStr  = getH('Date');
  const msgId    = getH('Message-ID');

  // extract body
  let body = '';
  function extractBody(parts = []) {
    for (const p of parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) {
        body += atob(p.body.data.replace(/-/g,'+').replace(/_/g,'/'));
      }
      if (p.parts) extractBody(p.parts);
    }
  }
  if (msg.payload?.body?.data) body = atob(msg.payload.body.data.replace(/-/g,'+').replace(/_/g,'/'));
  else extractBody(msg.payload?.parts || []);

  const senderEmail = from.match(/<([^>]+)>/)?.[1] || from.split(' ')[0] || from;
  const headerCheck = parseEmailHeaders(headers);
  trackXMailerSender(senderEmail, headerCheck.xMailer);

  const urls  = extractUrls(body);
  const links = urls.length ? await scoreLinks(urls) : [];
  const maxLinkRisk = links.length ? Math.max(...links.map(l => l.risk)) : 0;

  let modelResult = null;
  let scanError   = null;
  try {
    modelResult = await callModelAPI('email', body || subject, senderEmail);
  } catch (e) {
    scanError = e.message;
    console.error('[MailGuard] Email model failed:', e.message);
    modelResult = null; // null = model failed, do NOT fake a score
  }

  // check for prompt injection in body
  let injResult = null;
  if (body.length > 20) {
    try { injResult = await callModelAPI('prompt', body.slice(0, 500)); } catch {}
  }
  if (injResult?.prediction === 'injection' && injResult.confidence > 60) {
    modelResult.prediction = modelResult.prediction === 'phishing' ? 'phishing' : 'suspicious';
    modelResult.confidence = Math.max(modelResult.confidence, injResult.confidence);
    modelResult.evidence = [...(modelResult.evidence||[]), ...(injResult.evidence||[])].slice(0,8);
  }

  const riskScore      = calcRisk(modelResult);
  const riskLabel      = getRiskLabel(riskScore);
  const classification = getClassification(modelResult);
  const modelFailed    = riskScore === null;

  const result = {
    id:             msg.id || crypto.randomUUID(),
    threadId:       msg.threadId,
    from,
    senderEmail,
    subject,
    date:           dateStr ? new Date(dateStr).getTime() : Date.now(),
    gmailLabel,
    riskScore,
    riskLabel,
    classification,
    modelFailed,
    aiConfidence:   modelResult?.confidence || 0,
    aiReasoning:    modelResult?.recommendation || (scanError ? `Model error: ${scanError}` : ''),
    modelResult,
    headerCheck,
    links,
    bodyPreview:    body.slice(0, 300).trim(),
    analysedAt:     Date.now(),
    source:         'gmail',
    scanError
  };

  // Only auto-block and badge if we have a real score
  if (!modelFailed) {
    await checkAndAutoBlock(senderEmail, riskScore);
    chrome.action.setBadgeText({ text: riskScore >= 60 ? '!' : '' });
    chrome.action.setBadgeBackgroundColor({ color: riskScore >= 80 ? '#F43F5E' : '#F97316' });
  }

  return result;
}

// ── Paste scan ─────────────────────────────────────────────────────────────
async function analyzePastedEmail(text, subject = '', from = '') {
  const urls  = extractUrls(text);
  const links = urls.length ? await scoreLinks(urls.slice(0,5)) : [];
  const maxLinkRisk = links.length ? Math.max(...links.map(l=>l.risk)) : 0;

  let modelResult;
  try {
    modelResult = await callModelAPI('email', text, from);
  } catch (e) {
    throw e;
  }

  const hc = { spfPass:false, dkimOk:false, dmarcPass:false, flags:[{label:'Paste scan — no headers available',severity:'low'}], penalty:0, xMailer:null };
  const riskScore      = calcRisk(modelResult);
  const riskLabel      = getRiskLabel(riskScore);
  const classification = getClassification(modelResult);
  const modelFailed    = riskScore === null;

  const result = {
    id:             crypto.randomUUID(),
    from:           from || 'Paste scan',
    senderEmail:    from || '',
    subject:        subject || 'Paste scan',
    date:           Date.now(),
    riskScore, riskLabel, classification, modelFailed,
    aiConfidence:   modelResult?.confidence || 0,
    aiReasoning:    modelResult?.recommendation || '',
    modelResult,
    headerCheck:    hc,
    links,
    bodyPreview:    text.slice(0, 300),
    analysedAt:     Date.now(),
    source:         'paste'
  };
  return result;
}

// ── Gmail poll ─────────────────────────────────────────────────────────────
async function pollNewEmails() {
  if (!state.active) return;
  broadcastToTabs({ type: 'SCAN_PROGRESS', phase: 'connecting', detail: 'Connecting to Gmail…', current: 0, total: 0 });

  const token = await ensureToken(false);
  if (!token) { broadcastToTabs({ type: 'SCAN_PROGRESS', phase: 'error', detail: 'Not authenticated', current: 0, total: 0 }); return; }

  try {
    const since = state.lastChecked ? `after:${Math.floor(state.lastChecked/1000)}` : 'newer_than:1d';
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(since + ' -category:promotions')}&maxResults=20`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const d = await r.json();
    const msgs = d.messages || [];
    if (!msgs.length) {
      broadcastToTabs({ type: 'SCAN_PROGRESS', phase: 'idle', detail: 'No new emails', current: 0, total: 0 });
      state.lastChecked = Date.now();
      chrome.storage.local.set({ lastChecked: state.lastChecked });
      return;
    }

    broadcastToTabs({ type: 'SCAN_PROGRESS', phase: 'found', detail: `${msgs.length} emails found`, current: 0, total: msgs.length });
    const existingIds = new Set(state.results.map(r => r.id));
    let processed = 0;

    for (const m of msgs) {
      if (existingIds.has(m.id)) { processed++; continue; }
      const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
        headers: { 'Authorization': `Bearer ${token}` }
      }).then(r => r.json()).catch(() => null);

      if (!msg) continue;
      broadcastToTabs({ type: 'SCAN_PROGRESS', phase: 'ai', detail: `Analysing: ${msg.payload?.headers?.find(h=>h.name==='From')?.value?.slice(0,40)||'…'}`, current: processed, total: msgs.length });
      const result = await analyzeEmail(msg);
      state.results = [result, ...state.results].slice(0, MAX_RESULTS);
      processed++;
      broadcastToTabs({ type: 'SCAN_PROGRESS', phase: 'scored', detail: `${result.riskLabel}: ${result.from?.slice(0,40)}`, current: processed, total: msgs.length });
    }

    await saveResults();
    state.lastChecked = Date.now();
    chrome.storage.local.set({ lastChecked: state.lastChecked });
    broadcastToTabs({ type: 'NEW_RESULTS', count: processed });
    broadcastToTabs({ type: 'SCAN_PROGRESS', phase: 'done', detail: `${processed} emails processed`, current: processed, total: msgs.length });
  } catch (e) {
    broadcastToTabs({ type: 'SCAN_PROGRESS', phase: 'error', detail: e.message, current: 0, total: 0 });
  }
}

// ── Fetch all history ──────────────────────────────────────────────────────
async function fetchAllHistory(daysBack = 0) {
  state.cancelHistoryFetch = false;
  state.isHistoryFetching  = true;

  const token = await ensureToken(false);
  if (!token) { broadcastToTabs({ type: 'HISTORY_PROGRESS', phase: 'error', detail: 'Not authenticated', current: 0, total: 0 }); return; }

  const q = daysBack > 0 ? `newer_than:${daysBack}d` : '';
  let pageToken = null, allMsgs = [];

  broadcastToTabs({ type: 'HISTORY_PROGRESS', phase: 'fetching', detail: 'Loading email list…', current: 0, total: 0 });

  do {
    if (state.cancelHistoryFetch) break;
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${q ? `q=${encodeURIComponent(q)}&` : ''}maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const d = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } }).then(r => r.json()).catch(() => ({}));
    allMsgs.push(...(d.messages || []));
    pageToken = d.nextPageToken || null;
    broadcastToTabs({ type: 'HISTORY_PROGRESS', phase: 'fetching', detail: `${allMsgs.length} emails found…`, current: allMsgs.length, total: 0 });
  } while (pageToken && !state.cancelHistoryFetch);

  const existingIds = new Set(state.results.map(r => r.id));
  const newMsgs = allMsgs.filter(m => !existingIds.has(m.id));

  for (let i = 0; i < newMsgs.length; i++) {
    if (state.cancelHistoryFetch) { broadcastToTabs({ type: 'HISTORY_PROGRESS', phase: 'cancelled', detail: 'Cancelled', current: i, total: newMsgs.length }); break; }
    const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${newMsgs[i].id}?format=full`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }).then(r => r.json()).catch(() => null);
    if (!msg) continue;
    broadcastToTabs({ type: 'HISTORY_PROGRESS', phase: 'ai', detail: msg.payload?.headers?.find(h=>h.name==='From')?.value?.slice(0,40)||'…', current: i+1, total: newMsgs.length });
    try {
      const result = await analyzeEmail(msg);
      state.results = [result, ...state.results].slice(0, MAX_RESULTS);
    } catch {}
    if (i % 10 === 0) { await saveResults(); broadcastToTabs({ type: 'NEW_RESULTS', count: i+1 }); }
  }

  await saveResults();
  broadcastToTabs({ type: 'NEW_RESULTS', count: newMsgs.length });
  broadcastToTabs({ type: 'HISTORY_PROGRESS', phase: 'done', detail: `${newMsgs.length} emails analysed`, current: newMsgs.length, total: newMsgs.length });
  state.isHistoryFetching = false;
}

// ── Broadcast ──────────────────────────────────────────────────────────────
function broadcastToTabs(msg) {
  chrome.tabs.query({}, tabs => {
    tabs.forEach(t => { try { chrome.tabs.sendMessage(t.id, msg); } catch {} });
  });
  // Use callback form so lastError is consumed and never surfaces in console
  chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; });
}

// ── Alarm / poll ───────────────────────────────────────────────────────────
// ── Keep service worker alive (MV3 dies after 30s inactivity) ─────────────
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // every 24s
chrome.alarms.create('poll',      { periodInMinutes: POLL_INTERVAL / 60 });

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'keepalive') return; // just wakes the worker
  if (a.name === 'poll' && state.active) pollNewEmails();
});

// ── Message handler ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  (async () => {
    switch (msg.type) {

      case 'GET_STATE':
        send({ ...state, hasOpenAI: !!state.openaiApiKey, results: state.results });
        break;

      case 'START_DETECTION': {
        const token = await ensureToken(true);
        if (!token) { send({ ok: false, error: 'Authentication failed. Please sign in.' }); return; }
        if (!state.userEmail) { state.userEmail = await getUserEmail(token); chrome.storage.local.set({ userEmail: state.userEmail }); }
        state.active = true;
        state.accessToken = token;
        chrome.storage.local.set({ detectionActive: true });
        send({ ok: true });
        pollNewEmails();
        break;
      }

      case 'STOP_DETECTION':
        state.active = false;
        chrome.storage.local.set({ detectionActive: false });
        chrome.action.setBadgeText({ text: '' });
        send({ ok: true });
        break;

      case 'CLEAR_RESULTS':
        state.results = [];
        await saveResults();
        send({ ok: true });
        break;

      case 'POLL_NOW':
        send({ ok: true });
        pollNewEmails();
        break;

      case 'FETCH_ALL_HISTORY':
        send({ ok: true });
        fetchAllHistory(msg.daysBack || 0);
        break;

      case 'CANCEL_HISTORY_FETCH':
        state.cancelHistoryFetch = true;
        send({ ok: true });
        break;

      case 'ANALYZE_PASTE': {
        try {
          const result = await analyzePastedEmail(msg.text, msg.subject, msg.from);
          state.results = [result, ...state.results].slice(0, MAX_RESULTS);
          await saveResults();
          broadcastToTabs({ type: 'NEW_RESULTS', count: 1 });
          send({ result });
        } catch (e) { send({ error: e.message }); }
        break;
      }

      case 'UNBLOCK_SENDER':
        delete state.blockedSenders[msg.sender];
        await saveBlockedSenders();
        send({ ok: true });
        break;

      case 'SAVE_SETTINGS':
        if (msg.openaiApiKey !== undefined) {
          state.openaiApiKey = msg.openaiApiKey;
          chrome.storage.local.set({ openaiApiKey: msg.openaiApiKey });
        }
        if (msg.theme) { state.theme = msg.theme; chrome.storage.local.set({ theme: msg.theme }); }
        send({ ok: true });
        break;

      case 'GET_AI_SUGGESTION': {
        const r = await getOpenAISuggestion(msg.emailData);
        send(r);
        break;
      }

      case 'OPEN_DASHBOARD':
        chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
        send({ ok: true });
        break;

      case 'BADGE_DATA':
        send({ criticalCount: state.results.filter(r => r.riskScore >= 80).length });
        break;

      default:
        send({ ok: false, error: 'Unknown message type' });
    }
  })();
  return true; // async response
});

// ── Install / Startup ──────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await loadState();
  if (state.active) pollNewEmails();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadState();
  if (state.active) pollNewEmails();
});

loadState();
