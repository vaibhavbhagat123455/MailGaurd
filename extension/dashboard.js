// dashboard.js — MailGuard Pro v7 (Local ML)
const $ = id => document.getElementById(id);

let allResults = [], blockedSenders = {}, xMailerSenders = {};
let selectedId = null, activeFilter = 'all', sortByRisk = false;
let isActive = false, hasOpenAI = false, currentTheme = 'dark';
let logCount = 0;

// ── ROBUST MESSAGE SENDER — retries if service worker is asleep ────────────
function sendMsg(msg, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      chrome.runtime.sendMessage(msg, response => {
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message || '';
          if (n > 0 && (err.includes('Receiving end') || err.includes('establish connection'))) {
            setTimeout(() => attempt(n - 1), 300);
          } else {
            reject(new Error(err));
          }
        } else {
          resolve(response);
        }
      });
    };
    attempt(retries);
  });
}

// FIX #1: use correct SVG id 'ti' (was 'theme-icon' — crashed init() before emails ever rendered)
function applyTheme(t) {
  currentTheme = t;
  document.documentElement.setAttribute('data-theme', t);
  const ti = $('ti');
  if (ti) {
    ti.innerHTML = t === 'dark'
      ? `<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>`
      : `<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>`;
  }
  ['th-dark','th-light'].forEach(id => { const el = $(id); if (el) el.classList.toggle('active', el.dataset.theme === t); });
}

$('theme-btn').addEventListener('click', () => {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
  sendMsg({ type:'SAVE_SETTINGS', theme:currentTheme, openaiApiKey:$('oai-key').value });
});

// ── SERVER ─────────────────────────────────────────────────────────────────
// FIX #2: removed non-existent srv-pill / srv-pill-lbl references
async function checkServer() {
  const dot = $('srv-dot'), st = $('srv-status');
  try {
    const r = await fetch('http://localhost:5000/api/health', { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      if (dot) dot.className = 'srv-dot on';
      if (st)  { st.className = 'srv-status on'; st.textContent = 'Online'; }
      $('det-btn').disabled = false;
      return true;
    }
  } catch {}
  if (dot) dot.className = 'srv-dot';
  if (st)  { st.className = 'srv-status off'; st.textContent = 'Offline'; }
  return false;
}

// ── INIT ───────────────────────────────────────────────────────────────────
async function init() {
  const s = await sendMsg({ type:'GET_STATE' });
  if (!s) {
    setTimeout(init, 1000);
    return;
  }
  allResults     = s.results || [];
  blockedSenders = s.blockedSenders || {};
  xMailerSenders = s.xMailerSenders || {};
  isActive       = s.active;
  hasOpenAI      = s.hasOpenAI;

  applyTheme(s.theme || 'dark');
  if (s.userEmail) { $('user-chip').textContent = s.userEmail; $('user-chip').classList.add('show'); }
  chrome.storage.local.get(['openaiApiKey'], d => { if (d.openaiApiKey) $('oai-key').value = d.openaiApiKey; });

  updateTopBar(); updateMetrics(); renderList(); updateBlockedBadge();
  checkServer();
  setInterval(checkServer, 30000);
  if ($('sb-crit'))  $('sb-crit').textContent  = allResults.filter(r => r.riskScore >= 80).length;
  if ($('sb-total')) $('sb-total').textContent = allResults.length;

  // FIX #5: home-btn now properly wired (was never reached due to applyTheme crash)
  if ($('home-btn')) {
    $('home-btn').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('home.html') });
    });
  }
}

// ── TOPBAR ─────────────────────────────────────────────────────────────────
function updateTopBar() {
  const btn = $('det-btn'), lbl = $('det-lbl'), ico = $('det-ico');
  btn.disabled = false;
  if (isActive) {
    btn.className = 'det-btn on';
    lbl.textContent = 'STOP';
    ico.innerHTML = `<rect x="6" y="6" width="12" height="12"/>`;
  } else {
    btn.className = 'det-btn off';
    lbl.textContent = 'START';
    ico.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"/>`;
  }
}

$('det-btn').addEventListener('click', async () => {
  $('det-btn').disabled = true;
  const r = await sendMsg({ type: isActive ? 'STOP_DETECTION' : 'START_DETECTION' });
  if (r.ok) { isActive = !isActive; updateTopBar(); }
  else { alert(r.error || 'Error'); $('det-btn').disabled = false; }
});

// ── METRICS ────────────────────────────────────────────────────────────────
// FIX: use correct animation class '.nf' (was '.num-flash')
function flashNum(el, newVal) {
  const oldVal = el.textContent;
  if (String(oldVal) === String(newVal)) return;
  el.textContent = newVal;
  el.classList.remove('nf');
  void el.offsetWidth;
  el.classList.add('nf');
}

function updateMetrics() {
  flashNum($('m-total'), allResults.length);
  flashNum($('m-crit'),  allResults.filter(r => r.riskScore >= 80).length);
  flashNum($('m-high'),  allResults.filter(r => r.riskScore >= 60 && r.riskScore < 80).length);
  flashNum($('m-med'),   allResults.filter(r => r.riskScore >= 35 && r.riskScore < 60).length);
  flashNum($('m-safe'),  allResults.filter(r => r.riskScore < 35).length);
}

function activeTab() {
  return document.querySelector('.tab.active')?.dataset?.tab || 'detail';
}

document.querySelectorAll('.metric').forEach(m => m.addEventListener('click', () => {
  document.querySelectorAll('.metric').forEach(x => x.classList.remove('sel'));
  m.classList.add('sel');
  setFilter(m.dataset.f);
}));

// ── FILTER / SORT ──────────────────────────────────────────────────────────
function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.fp').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  document.querySelectorAll('.metric').forEach(b => b.classList.toggle('sel', b.dataset.f === f));
  renderList();
}
document.querySelectorAll('.fp').forEach(b => b.addEventListener('click', () => setFilter(b.dataset.f)));

let sortDir = false;
$('sort-btn').addEventListener('click', () => {
  sortDir = !sortDir;
  $('sort-btn').textContent = sortDir ? '⇅ RISK' : '⇅ LATEST';
  renderList();
});

$('clear-btn').addEventListener('click', () => {
  if (!confirm('Clear all results?')) return;
  sendMsg({ type:'CLEAR_RESULTS' });
  allResults = []; selectedId = null;
  updateMetrics(); renderList();
  $('detail-content').innerHTML = `<div class="no-detail"><div class="nd-title">Cleared</div><div class="nd-desc">Start detection to scan new emails.</div></div>`;
});

// ── HELPERS ────────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function rc(s) { if(s>=80) return 'var(--red)'; if(s>=60) return 'var(--org)'; if(s>=35) return 'var(--yel)'; return 'var(--grn)'; }
function rb(s) { if(s>=80) return 'rgba(255,77,106,.08)'; if(s>=60) return 'rgba(255,144,70,.06)'; if(s>=35) return 'rgba(255,214,10,.06)'; return 'rgba(0,229,160,.06)'; }
function tc(t) { return 'tc-'+(t||'low'); }

function getFiltered() {
  let r = [...allResults];
  switch (activeFilter) {
    case 'critical': r = r.filter(x => x.riskScore >= 80); break;
    case 'high':     r = r.filter(x => x.riskScore >= 60 && x.riskScore < 80); break;
    case 'medium':   r = r.filter(x => x.riskScore >= 35 && x.riskScore < 60); break;
    case 'safe':     r = r.filter(x => x.riskScore < 35); break;
    case 'phishing': r = r.filter(x => x.classification === 'phishing'); break;
    case 'spam':     r = r.filter(x => x.classification === 'spam'); break;
    case 'paste':    r = r.filter(x => x.source === 'paste'); break;
  }
  return sortDir ? r.sort((a,b) => b.riskScore - a.riskScore) : r.sort((a,b) => b.analysedAt - a.analysedAt);
}

// ── EMAIL LIST ─────────────────────────────────────────────────────────────
// FIX #3: use .ecard/.ecard-inner/.ecard-body/.efrom etc. (was .erow/.erow-top etc.)
function renderList() {
  const list = getFiltered(), el = $('email-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg><div>No results</div></div>`;
    return;
  }
  el.innerHTML = list.map(r => {
    const xm  = r.headerCheck?.xMailer?.detected;
    const blk = !!blockedSenders[r.senderEmail];
    const d   = r.date ? new Date(r.date).toLocaleDateString('en-IN',{month:'short',day:'numeric'}) : '';
    const col = r.modelFailed ? 'var(--tx3)' : rc(r.riskScore);
    const scoreDisplay = r.modelFailed ? 'ERR' : r.riskScore;
    return `<div class="ecard${selectedId===r.id?' sel':''}" data-id="${r.id}">
      <div class="ecard-inner">
        <div class="ecard-accent" style="background:${col}"></div>
        <div class="ecard-body">
          <div class="efrom">${esc(r.from||'(unknown)')}</div>
          <div class="esubj">${esc(r.subject||'(no subject)')}</div>
          <div class="emeta">
            ${r.modelFailed
              ? `<span class="etag" style="background:rgba(255,140,0,.1);border-color:rgba(255,140,0,.4);color:var(--org)">MODEL ERROR</span>`
              : `<span class="etag etag-${r.classification||'unknown'}">${(r.classification||'unknown').toUpperCase()}</span>`
            }
            ${r.source==='paste' ? `<span class="etag etag-paste">PASTE</span>` : ''}
            ${xm ? `<span class="etag etag-xm">X-MAILER</span>` : ''}
            ${blk ? `<span class="etag etag-blocked">BLOCKED</span>` : ''}
          </div>
        </div>
        <div class="ecard-right">
          <div class="ecard-score" style="color:${col};font-size:${r.modelFailed?'9px':'16px'}">${scoreDisplay}</div>
          <div class="ecard-date">${d}</div>
        </div>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.ecard').forEach(card => card.addEventListener('click', () => {
    selectedId = card.dataset.id;
    el.querySelectorAll('.ecard').forEach(x => x.classList.remove('sel'));
    card.classList.add('sel');
    const r = allResults.find(x => x.id === selectedId);
    if (r) renderDetail(r);
    switchTab('detail');
  }));
}

// ── DETAIL ─────────────────────────────────────────────────────────────────
// FIX #4: use CSS classes defined in dashboard.html
// (.score-hero/.sh-*/.card/.card-hd/.auth-row/.flag-row/.link-row etc.)
function renderDetail(r) {
  if (r.modelFailed) {
    $('detail-content').innerHTML = `<div class="dp">
      <div class="notice err">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        MODEL SCAN FAILED — ${esc(r.scanError||'Unknown model error')}
      </div>
      <div style="padding:14px 0 0;font-size:12px;color:var(--tx3);line-height:1.8">
        Check: <code style="color:var(--acl)">start.bat</code> is running &middot; all 10 .pkl files in <code style="color:var(--acl)">server/models/</code> &middot; visit <code style="color:var(--acl)">http://localhost:5000/api/health</code>
      </div>
    </div>`;
    return;
  }

  const col = rc(r.riskScore);
  const mr  = r.modelResult || {}, hc = r.headerCheck || {};
  const blk = blockedSenders[r.senderEmail];

  let h = `<div class="dp">`;

  // ── Score Hero ──
  h += `<div class="score-hero">
    <div class="sh-top">
      <div class="sh-num-box">
        <div class="sh-big" style="color:${col}">${r.riskScore}</div>
        <div class="sh-label" style="color:${col}">${r.riskLabel || ''}</div>
        <div class="sh-tier ${tc(mr.risk_tier)}">${(mr.prediction||r.classification||'—').toUpperCase()}</div>
      </div>
      <div class="sh-meta">
        <div class="sh-row">
          <span class="sh-key">FROM</span>
          <span class="sh-val" style="font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px">${esc(r.from||'—')}</span>
        </div>
        <div class="sh-row">
          <span class="sh-key">CONFIDENCE</span>
          <div class="conf-bar"><div class="conf-fill" style="width:${r.aiConfidence||0}%;background:${col}"></div></div>
          <span class="sh-val" style="color:${col}">${(r.aiConfidence||0).toFixed(1)}%</span>
        </div>
        <div class="sh-row">
          <span class="sh-key">RISK TIER</span>
          <span class="sh-val">${(mr.risk_tier||'low').toUpperCase()} &middot; ${hc.flags?.length||0} FLAG${hc.flags?.length!==1?'S':''}</span>
        </div>
      </div>
    </div>
    <div class="sh-rec">
      <div class="sh-rec-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      </div>
      <div class="sh-rec-text">${esc(mr.recommendation||r.aiReasoning||'No analysis available.')}</div>
    </div>
  </div>`;

  // ── Blocked notice ──
  if (blk) h += `<div class="notice err"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>SENDER BLOCKED: ${esc(r.senderEmail||r.from)}</div>`;

  // ── Adversarial card ──
  if (mr.adversarial_flags?.length) h += `<div class="card ac-adv">
    <div class="card-hd">
      <span class="card-title">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        ADVERSARIAL PATTERN DETECTED
      </span>
    </div>
    <div style="padding:10px 16px 12px;font-size:12px;color:var(--tx2);line-height:1.65">${esc(mr.adversarial_warning||mr.adversarial_flags[0])}</div>
  </div>`;

  // ── X-Mailer card ──
  if (hc.xMailer?.detected) h += `<div class="card ac-xm">
    <div class="card-hd">
      <span class="card-title">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--org)" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        X-MAILER: ${esc(hc.xMailer.value||'')}
      </span>
    </div>
    <div style="padding:10px 16px 12px;font-size:12px;color:var(--tx2)">${hc.xMailer.highRisk?'PHP-class mailer detected — HIGH RISK (+25 score penalty)':'Bulk/marketing mailer detected — SUSPICIOUS (+12 score penalty)'}</div>
  </div>`;

  // ── ML Evidence ──
  if (mr.evidence?.length) {
    const ev = [...mr.evidence].sort((a,b)=>Math.abs(b.weight??b.shap_value??0)-Math.abs(a.weight??a.shap_value??0)).slice(0,8);
    const mx = Math.max(...ev.map(e=>Math.abs(e.weight??e.shap_value??0)),.001);
    h += `<div class="card">
      <div class="card-hd">
        <span class="card-title">ML EVIDENCE</span>
        <span class="card-badge ${mr.prediction==='phishing'||mr.prediction==='malicious'?'tc-critical':'tc-low'}">${(mr.prediction||'—').toUpperCase()} ${(mr.confidence||0).toFixed(0)}%</span>
      </div>
      <div class="ev-list">
        ${ev.map(e => {
          const w = e.weight??e.shap_value??0;
          const pct = (Math.abs(w)/mx*100).toFixed(0);
          const lbl = (e.token||e.feature||'').replace(/_/g,' ');
          return `<div class="ev-row"><span class="ev-tok">${esc(lbl)}</span><div class="ev-track"><div class="${w>=0?'ev-pos':'ev-neg'}" style="width:${pct}%"></div></div><span class="ev-w">${w>=0?'+':''}${w.toFixed(3)}</span></div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // ── URL Threat Profile ──
  const lw = (r.links||[]).find(l=>l.modelResult?.all_class_scores);
  if (lw) {
    const cs=lw.modelResult.all_class_scores, tot=Object.values(cs).reduce((a,b)=>a+b,0)||1;
    h += `<div class="card">
      <div class="card-hd"><span class="card-title">URL THREAT PROFILE</span></div>
      <div class="url-bar">
        <div class="url-seg" style="width:${(cs.benign/tot*100).toFixed(1)}%;background:var(--grn)"></div>
        <div class="url-seg" style="width:${(cs.phishing/tot*100).toFixed(1)}%;background:var(--org)"></div>
        <div class="url-seg" style="width:${(cs.malware/tot*100).toFixed(1)}%;background:var(--red)"></div>
        <div class="url-seg" style="width:${(cs.defacement/tot*100).toFixed(1)}%;background:var(--pink)"></div>
      </div>
      <div class="url-legend">
        <span class="ul-item"><div class="ul-dot" style="background:var(--grn)"></div>BENIGN ${(cs.benign||0).toFixed(1)}%</span>
        <span class="ul-item"><div class="ul-dot" style="background:var(--org)"></div>PHISHING ${(cs.phishing||0).toFixed(1)}%</span>
        <span class="ul-item"><div class="ul-dot" style="background:var(--red)"></div>MALWARE ${(cs.malware||0).toFixed(1)}%</span>
        <span class="ul-item"><div class="ul-dot" style="background:var(--pink)"></div>DEFACEMENT ${(cs.defacement||0).toFixed(1)}%</span>
      </div>
    </div>`;
  }

  // ── Email Authentication ──
  h += `<div class="card">
    <div class="card-hd">
      <span class="card-title">EMAIL AUTHENTICATION</span>
      <span class="card-badge ${hc.flags?.length?'tc-critical':'tc-low'}">${hc.flags?.length||0} FLAGS</span>
    </div>
    <div class="auth-row"><span>SPF</span><span class="${hc.spfPass?'aok':'afail'}">${hc.spfPass?'✓ PASS':'✗ FAIL'}</span></div>
    <div class="auth-row"><span>DKIM</span><span class="${hc.dkimOk?'aok':'afail'}">${hc.dkimOk?'✓ SIGNED':'✗ UNSIGNED'}</span></div>
    <div class="auth-row"><span>DMARC</span><span class="${hc.dmarcPass?'aok':'ana'}">${hc.dmarcPass?'✓ PASS':'— N/A'}</span></div>
    ${(hc.flags||[]).map(f=>`<div class="flag-row"><div class="fdot" style="background:${f.severity==='high'?'var(--red)':f.severity==='medium'?'var(--org)':'var(--yel)'}"></div><div style="flex:1;font-size:12px">${esc(f.label)}</div><span class="fsev ${f.severity}">${f.severity.toUpperCase()}</span></div>`).join('')}
  </div>`;

  // ── Links ──
  if (r.links?.length) h += `<div class="card">
    <div class="card-hd">
      <span class="card-title">LINKS (${r.links.length})</span>
      <span class="card-badge ${r.links.filter(l=>l.risk>=40).length?'tc-critical':'tc-low'}">${r.links.filter(l=>l.risk>=40).length} SUSPICIOUS</span>
    </div>
    ${r.links.map(l=>`<div class="link-row">
      <div class="link-top"><div class="ldot" style="background:${rc(l.risk)}"></div><div class="lurl">${esc(l.url)}</div><div class="lpct ${tc(l.risk>=80?'critical':l.risk>=60?'high':l.risk>=35?'medium':'low')}">${l.risk}%</div></div>
      ${l.flags?.length?`<div style="padding:2px 16px 6px;display:flex;gap:4px;flex-wrap:wrap">${l.flags.map(f=>`<span class="lflag">${esc(f).toUpperCase()}</span>`).join('')}</div>`:''}
    </div>`).join('')}
  </div>`;

  // ── Body Preview ──
  if (r.bodyPreview) h += `<div class="card">
    <div class="card-hd"><span class="card-title">BODY PREVIEW</span></div>
    <div class="body-pre">${esc(r.bodyPreview)}</div>
  </div>`;

  // ── AI Assessment ──
  h += `<div class="card ac-ai">
    <div class="card-hd">
      <span class="card-title">AI SECURITY ASSESSMENT</span>
      <span class="ai-chip">GPT-4o-mini</span>
    </div>
    ${hasOpenAI
      ? `<button class="ai-btn" id="ai-btn" data-id="${r.id}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>Request AI Analysis</button><div id="ai-result"></div>`
      : `<div class="ai-no-key">Add your OpenAI API key in Settings to enable GPT-4o-mini deep security assessment per email.</div>`
    }
  </div>`;

  h += `</div>`;
  $('detail-content').innerHTML = h;

  // Animate bars on next frame
  requestAnimationFrame(() => {
    document.querySelectorAll('.ev-pos,.ev-neg,.conf-fill,.url-seg').forEach(b => {
      const w = b.style.width; b.style.width = '0';
      requestAnimationFrame(() => { b.style.width = w; });
    });
  });

  const aibtn = $('ai-btn');
  if (aibtn) aibtn.addEventListener('click', async () => {
    aibtn.disabled = true;
    aibtn.innerHTML = `<div class="sp"></div> Querying GPT-4o-mini…`;
    const res = await sendMsg({ type:'GET_AI_SUGGESTION', emailData:r });
    const el = $('ai-result');
    if (res.suggestion) { el.innerHTML = `<div class="ai-text">${esc(res.suggestion)}</div>`; aibtn.style.display='none'; }
    else { el.innerHTML = `<div class="ai-no-key" style="color:var(--red)">ERROR: ${esc(res.error||'Failed')}</div>`; aibtn.disabled=false; aibtn.textContent='Retry'; }
  });
}

// ── TABS ───────────────────────────────────────────────────────────────────
const TAB_TITLES = {detail:'Threat Analysis',paste:'Paste & Scan',overview:'Overview',blocked:'Blocked Senders',settings:'Settings'};
function switchTab(t) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab===t));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id===`panel-${t}`));
  document.querySelectorAll('.nav-item[data-tab]').forEach(n => n.classList.toggle('active', n.dataset.tab===t));
  if ($('topbar-title')) $('topbar-title').textContent = TAB_TITLES[t] || t;
  if ($('tab-bar')) $('tab-bar').style.display = 'flex';
  if (t==='overview') renderOverview();
  if (t==='blocked')  renderBlocked();
}
document.querySelectorAll('.tab, .nav-item[data-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// ── OVERVIEW ───────────────────────────────────────────────────────────────
function renderOverview() {
  $('ov-grid').innerHTML = `
    <div class="ov-card"><div class="ov-n" style="color:var(--tx)">${allResults.length}</div><div class="ov-l">TOTAL</div></div>
    <div class="ov-card"><div class="ov-n" style="color:var(--red)">${allResults.filter(r=>r.riskScore>=80).length}</div><div class="ov-l">CRITICAL</div></div>
    <div class="ov-card"><div class="ov-n" style="color:var(--org)">${allResults.filter(r=>r.riskScore>=60&&r.riskScore<80).length}</div><div class="ov-l">HIGH</div></div>
    <div class="ov-card"><div class="ov-n" style="color:var(--yel)">${Object.keys(blockedSenders).length}</div><div class="ov-l">BLOCKED</div></div>`;

  const cats=['phishing','scam','malware','spam','legitimate','unknown'];
  const cc={phishing:'var(--red)',scam:'var(--red)',malware:'var(--red)',spam:'var(--org)',legitimate:'var(--grn)',unknown:'var(--tx3)'};
  const counts={};
  allResults.forEach(r=>{counts[r.classification]=(counts[r.classification]||0)+1});
  const mx=Math.max(...Object.values(counts),1);
  $('brow-list').innerHTML=cats.filter(c=>counts[c]).map(c=>`<div class="brow"><span class="brow-l" style="color:${cc[c]}">${c}</span><div class="brow-track"><div class="brow-bar" style="width:${(counts[c]/mx*100).toFixed(0)}%;background:${cc[c]}"></div></div><span class="brow-n" style="color:${cc[c]}">${counts[c]}</span></div>`).join('')||`<div class="brow" style="color:var(--tx3)">No data</div>`;

  const sm={};
  allResults.forEach(r=>{const s=r.from||'?';if(!sm[s])sm[s]={c:0,mx:0};sm[s].c++;sm[s].mx=Math.max(sm[s].mx,r.riskScore)});
  const top=Object.entries(sm).filter(([,v])=>v.mx>=40).sort(([,a],[,b])=>b.mx-a.mx).slice(0,8);
  $('top-senders').innerHTML=top.length?top.map(([s,v])=>`<div class="brow"><span class="brow-l" style="font-size:9px;font-family:'DM Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">${esc(s)}</span><div class="brow-track"><div class="brow-bar" style="width:${v.mx}%;background:${rc(v.mx)}"></div></div><span class="brow-n" style="color:${rc(v.mx)}">${v.mx}</span></div>`).join(''):`<div class="brow" style="color:var(--tx3)">No high-risk senders</div>`;

  const xme=Object.entries(xMailerSenders).slice(0,8);
  $('xmailer-ov').innerHTML=xme.length?xme.map(([a,i])=>`<div class="brow"><span class="brow-l" style="font-size:9px;font-family:'DM Mono',monospace">${esc(a)}</span><span style="font-size:8px;color:var(--org);font-family:'DM Mono',monospace">${esc(i.xMailer||'—')}</span><span class="brow-n" style="color:var(--tx3)">${i.count}×</span></div>`).join(''):`<div class="brow" style="color:var(--tx3)">No X-Mailer senders</div>`;
}

// ── BLOCKED ────────────────────────────────────────────────────────────────
function renderBlocked() {
  const entries = Object.entries(blockedSenders);
  $('blocked-list').innerHTML = entries.length
    ? entries.map(([s,i])=>`<div class="blk-item"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg><div class="blk-s">${esc(s)}</div><div class="blk-r">${esc(i.reason||'')}</div><button class="unblk" data-s="${esc(s)}">Unblock</button></div>`).join('')
    : `<div style="padding:30px;text-align:center;color:var(--tx3);font-size:12px">No blocked senders.<br><br><span style="font-size:11px">3+ critical emails from the same sender triggers auto-block.</span></div>`;

  $('blocked-list').querySelectorAll('.unblk').forEach(b => b.addEventListener('click', async () => {
    await sendMsg({ type:'UNBLOCK_SENDER', sender:b.dataset.s });
    delete blockedSenders[b.dataset.s]; updateBlockedBadge(); renderBlocked();
  }));
}

function updateBlockedBadge() {
  const n = Object.keys(blockedSenders).length;
  [$('blk-badge'), $('blk-tab-badge')].forEach(el => {
    if (!el) return;
    el.textContent = n;
    el.classList.toggle('show', n>0);
  });
  if ($('sb-crit'))  $('sb-crit').textContent  = allResults.filter(r=>r.riskScore>=80).length;
  if ($('sb-total')) $('sb-total').textContent = allResults.length;
}

// ── SETTINGS ───────────────────────────────────────────────────────────────
document.querySelectorAll('.th-opt').forEach(o => o.addEventListener('click', () => {
  document.querySelectorAll('.th-opt').forEach(x => x.classList.remove('active'));
  o.classList.add('active'); applyTheme(o.dataset.theme);
}));

$('save-btn').addEventListener('click', async () => {
  const key = $('oai-key').value.trim();
  await sendMsg({ type:'SAVE_SETTINGS', openaiApiKey:key, theme:currentTheme });
  hasOpenAI = !!key;
  const n = $('settings-notice');
  n.innerHTML = `<div class="notice ok"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Settings saved</div>`;
  setTimeout(() => { n.innerHTML=''; }, 3000);
});

// ── FETCH ──────────────────────────────────────────────────────────────────
$('fetch-btn').addEventListener('click', () => {
  sendMsg({ type:'FETCH_ALL_HISTORY', daysBack:parseInt($('fetch-range').value) });
  $('fetch-btn').disabled = true;
  $('cancel-btn').classList.add('show');
});
$('cancel-btn').addEventListener('click', () => {
  sendMsg({ type:'CANCEL_HISTORY_FETCH' });
  $('cancel-btn').classList.remove('show'); $('fetch-btn').disabled = false;
});

// ── PASTE ──────────────────────────────────────────────────────────────────
$('p-btn').addEventListener('click', async () => {
  const body = $('p-body').value.trim();
  if (!body) { alert('Paste email content first.'); return; }
  const btn = $('p-btn');
  btn.disabled = true;
  btn.innerHTML = `<div class="sp"></div> Scanning…`;
  const res = await sendMsg({ type:'ANALYZE_PASTE', text:body, subject:$('p-subj').value, from:$('p-from').value });
  btn.disabled = false;
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>Analyse with Local ML`;
  const el = $('p-result');
  if (res.error) { el.innerHTML = `<div class="notice err">ERROR: ${esc(res.error)}</div>`; return; }
  const r = res.result;
  allResults = [r, ...allResults.filter(x => x.id!==r.id)];
  updateMetrics(); renderList();
  if (r.modelFailed) {
    el.innerHTML = `<div class="notice err">MODEL ERROR: ${esc(r.scanError||'Model did not return a score')}</div>`;
  } else {
    el.innerHTML = `<div class="notice ${r.riskScore>=60?'err':r.riskScore>=35?'info':'ok'}">Result: ${r.riskLabel} (${r.riskScore}/100) · ${(r.classification||'').toUpperCase()} — click the email in the list for full analysis.</div>`;
  }
  selectedId = r.id; renderList();
});

// ── TOAST ──────────────────────────────────────────────────────────────────
// FIX #6: correct IDs — 'scan-toast' → 'toast',  'toast-close' → 'toast-x'
const toast = $('toast');
$('toast-x').addEventListener('click', () => toast.classList.add('hidden'));

function addLog(msg, cls='') {
  const t = new Date().toLocaleTimeString('en-IN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const row = document.createElement('div');
  row.className = 'tlog';
  row.innerHTML = `<span class="tlog-t">${t}</span><span class="tlog-m ${cls}">${esc(msg)}</span>`;
  $('toast-log').prepend(row);
  if (++logCount > 18) $('toast-log').lastChild?.remove();
}

// ── MESSAGE LISTENER ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'SCAN_PROGRESS') {
    toast.classList.remove('hidden');
    $('toast-title').textContent = msg.phase==='done' ? 'COMPLETE' : 'SCANNING';
    $('toast-detail').textContent = msg.detail || '';
    const bar = $('toast-bar');
    if (msg.total > 0) {
      bar.classList.remove('indet'); bar.style.width=(msg.current/msg.total*100).toFixed(0)+'%';
      $('toast-cnt').textContent=`${msg.current}/${msg.total}`;
    } else {
      bar.classList.add('indet'); $('toast-cnt').textContent='';
    }
    const pm = {connecting:'CONNECTING…',fetching:'FETCHING EMAILS',found:'EMAILS FOUND',loading:'LOADING',ai:'ANALYSING',scored:'SCORED',done:'COMPLETE',idle:'IDLE',error:'ERROR'};
    $('toast-phase').textContent = pm[msg.phase] || msg.phase;
    const dot = $('tdot');
    dot.className = msg.phase==='done'||msg.phase==='idle' ? 'tdot done' : msg.phase==='error' ? 'tdot err' : 'tdot';

    if (msg.phase==='scored') {
      const cls=msg.detail.includes('CRITICAL')?'log-crit':msg.detail.includes('HIGH')?'log-warn':'log-ok';
      addLog(msg.detail, cls);
      // live feed in overview
      const feed = $('live-feed');
      if (feed) {
        const isCrit = msg.detail.includes('CRITICAL'), isHigh = msg.detail.includes('HIGH');
        const col = isCrit ? 'var(--red)' : isHigh ? 'var(--org)' : 'var(--grn)';
        const t = new Date().toLocaleTimeString('en-IN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;padding:5px 12px;border-bottom:1px solid var(--bd);font-size:9px';
        row.innerHTML = `<span style="color:var(--tx3);font-family:'DM Mono',monospace;flex-shrink:0">${t}</span><span style="color:${col};font-family:'DM Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(msg.detail)}</span>`;
        feed.prepend(row);
        while (feed.children.length > 25) feed.lastChild.remove();
        // FIX #7: 'live-feed-section' → 'live-feed-card'
        const lfc = $('live-feed-card'); if (lfc) lfc.style.display = 'block';
      }
      sendMsg({ type:'GET_STATE' }).then(s => {
        if (!s) return;
        allResults=s.results||[]; blockedSenders=s.blockedSenders||{};
        updateMetrics(); renderList(); updateBlockedBadge();
        if (activeTab() === 'overview') renderOverview();
      });
    }

    // FIX #8: 'scan-pill' → 'scanning-chip'
    const chip = $('scanning-chip');
    if (chip) chip.style.display = (msg.phase!=='done'&&msg.phase!=='idle'&&msg.phase!=='error') ? 'flex' : 'none';

    if (msg.phase==='done'||msg.phase==='idle') {
      const lfc = $('live-feed-card');
      if (lfc) setTimeout(() => { lfc.style.display='none'; const lf=$('live-feed'); if(lf)lf.innerHTML=''; }, 4000);
    }
  }

  if (msg.type === 'HISTORY_PROGRESS') {
    toast.classList.remove('hidden');
    $('toast-title').textContent = 'HISTORY';
    $('toast-detail').textContent = msg.detail || '';
    $('toast-phase').textContent = msg.phase?.toUpperCase() || '…';
    if (msg.total>0){$('toast-bar').classList.remove('indet');$('toast-bar').style.width=(msg.current/msg.total*100).toFixed(0)+'%';$('toast-cnt').textContent=`${msg.current}/${msg.total}`;}
    else{$('toast-bar').classList.add('indet');}
    if (msg.phase==='done'||msg.phase==='cancelled'){$('cancel-btn').classList.remove('show');$('fetch-btn').disabled=false;}
  }

  if (msg.type === 'NEW_RESULTS') {
    sendMsg({ type:'GET_STATE' }).then(s => {
      if (!s) return;
      allResults=s.results||[]; blockedSenders=s.blockedSenders||{}; xMailerSenders=s.xMailerSenders||{}; hasOpenAI=s.hasOpenAI;
      updateMetrics(); renderList(); updateBlockedBadge();
      if (activeTab() === 'overview') renderOverview();
      if (activeTab() === 'blocked')  renderBlocked();
    });
  }

  if (msg.type === 'SENDER_BLOCKED') {
    sendMsg({ type:'GET_STATE' }).then(s => {
      if (!s) return;
      blockedSenders=s.blockedSenders||{}; updateBlockedBadge();
      if (activeTab() === 'blocked') renderBlocked();
    });
  }
});

init();
