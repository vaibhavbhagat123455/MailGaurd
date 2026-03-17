const $ = id => document.getElementById(id);

function sendMsg(msg, retries=3) {
  return new Promise(resolve => {
    const attempt = n => {
      chrome.runtime.sendMessage(msg, res => {
        if (chrome.runtime.lastError) {
          const e = chrome.runtime.lastError.message||'';
          if (n>0 && (e.includes('Receiving end')||e.includes('establish connection')))
            setTimeout(()=>attempt(n-1), 300);
          else resolve(null);
        } else resolve(res);
      });
    };
    attempt(retries);
  });
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('ti').innerHTML = t==='dark'
    ? '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>'
    : '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>';
}

$('theme-btn').addEventListener('click', () => {
  const t = document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
  applyTheme(t);
  sendMsg({type:'SAVE_SETTINGS',theme:t,openaiApiKey:''});
});

$('home-btn').addEventListener('click', () => {
  chrome.tabs.create({url: chrome.runtime.getURL('home.html')});
  window.close();
});

async function checkServer() {
  try {
    const r = await fetch('http://localhost:5000/api/health',{signal:AbortSignal.timeout(3000)});
    if (r.ok) {
      $('srv-dot').className='srv-dot on';
      $('srv-text').className='srv-text on';
      $('srv-text').textContent='Server online';
      $('main-btn').disabled=false;
      return true;
    }
  } catch {}
  $('srv-dot').className='srv-dot off';
  $('srv-text').className='srv-text off';
  $('srv-text').textContent='Server offline — run start.bat';
  return false;
}

async function init() {
  const s = await sendMsg({type:'GET_STATE'});
  if (!s) { $('srv-text').textContent='Extension error — reload'; return; }

  applyTheme(s.theme||'dark');
  if (s.userEmail) $('user-tag').textContent=s.userEmail;

  const res = s.results||[];
  $('sc').textContent = res.filter(r=>r.riskScore>=80).length;
  $('sh').textContent = res.filter(r=>r.riskScore>=60&&r.riskScore<80).length;
  $('st').textContent = res.length;

  const blk = Object.keys(s.blockedSenders||{}).length;
  if (blk>0) { $('blk-banner').classList.add('show'); $('blk-txt').textContent=`${blk} sender${blk>1?'s':''} auto-blocked`; }

  if (s.active) {
    $('ring').classList.add('on');
    $('det-label').innerHTML='Detection <b>active</b>';
    $('main-btn').className='main-btn stop';
    $('btn-ico').innerHTML='<rect x="6" y="6" width="12" height="12" rx="2"/>';
    $('btn-txt').textContent='Stop Detection';
  }

  const online = await checkServer();
  if (!online) $('main-btn').disabled=true;

  $('main-btn').addEventListener('click', async () => {
    $('main-btn').disabled=true;
    $('main-btn').innerHTML='<div class="sp"></div><span>Please wait…</span>';
    await sendMsg({type:s.active?'STOP_DETECTION':'START_DETECTION'});
    window.close();
  });
}

$('open-btn').addEventListener('click', () => { sendMsg({type:'OPEN_DASHBOARD'}); window.close(); });
init();
