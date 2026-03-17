// MailGuard Pro v5 — content.js
const ATTR = "mg-v5";

function badge(score, label) {
  const bg = score>=80?"#FF4757":score>=60?"#FF8C00":score>=35?"#FFD16666":"#00FFB2";
  const tx = score>=35?"#fff":"#05090F";
  return `<span style="display:inline-flex;align-items:center;gap:3px;background:${bg};color:${tx};
    font-size:9px;font-family:'IBM Plex Mono',monospace;font-weight:600;
    padding:2px 7px;border-radius:8px;margin-left:7px;vertical-align:middle;
    white-space:nowrap;cursor:pointer;letter-spacing:.03em;" 
    title="MailGuard: ${score}/100 — ${label}">&#9632; ${label} ${score}</span>`;
}

function getThreadId(row) {
  const d = row.getAttribute("data-thread-id") || row.getAttribute("jsthread");
  if (d) return d;
  const a = row.querySelector("a[href*='#']");
  if (a) { const m = a.href.match(/#(?:inbox|thread|all)\/([a-f0-9]+)/); return m ? m[1] : null; }
  return null;
}

function injectBadges() {
  const rows = document.querySelectorAll(`tr[role="row"]:not([${ATTR}]),div[role="row"]:not([${ATTR}])`);
  for (const row of rows) {
    row.setAttribute(ATTR, "1");
    const tid = getThreadId(row);
    if (!tid) continue;
    chrome.runtime.sendMessage({ type: "BADGE_DATA", threadId: tid }, (resp) => {
      if (chrome.runtime.lastError || !resp?.result) return;
      const r = resp.result;
      const cell = row.querySelector("span.bog") || row.querySelector("td:nth-child(4)") || row.querySelector("td.xY");
      if (!cell) return;
      cell.querySelectorAll("[data-mg5]").forEach(el => el.remove());
      const wrap = document.createElement("span");
      wrap.setAttribute("data-mg5","1");
      wrap.innerHTML = badge(r.riskScore, r.riskLabel);
      cell.appendChild(wrap);
    });
  }
}

const obs = new MutationObserver(() => { clearTimeout(window._mg5t); window._mg5t = setTimeout(injectBadges, 350); });
function init() {
  obs.observe(document.querySelector("[role='main']") || document.body, { childList:true, subtree:true });
  injectBadges();
}
document.readyState === "complete" ? init() : window.addEventListener("load", init);
