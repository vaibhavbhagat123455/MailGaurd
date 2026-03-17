// home.js — MailGuard Pro v7
// MV3-compliant: no inline scripts

// ── Theme toggle ─────────────────────────────────────────────────────────
const MOON = '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>';
const SUN  = '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>';

function applyTheme(t) {
  const html = document.documentElement;
  html.setAttribute('data-theme', t);
  const ico = document.getElementById('theme-icon');
  if (ico) {
    ico.setAttribute('viewBox','0 0 24 24');
    ico.setAttribute('fill','none');
    ico.setAttribute('stroke','currentColor');
    ico.setAttribute('stroke-width','2');
    ico.innerHTML = t === 'dark' ? SUN : MOON;
  }
  try { localStorage.setItem('mg-theme', t); } catch(e) {}
}

// Restore saved theme
(function() {
  try {
    const saved = localStorage.getItem('mg-theme');
    if (saved) applyTheme(saved);
  } catch(e) {}
})();

document.getElementById('theme-btn').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ── Navbar scroll ────────────────────────────────────────────────────────
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  if (window.scrollY > 20) {
    navbar.classList.add('scrolled');
  } else {
    navbar.classList.remove('scrolled');
  }
}, { passive: true });

// ── Scroll fade-in animations ────────────────────────────────────────────
const observer = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('visible');
      observer.unobserve(e.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -30px 0px' });

document.querySelectorAll('.fade-up').forEach(el => observer.observe(el));

// ── Download button ──────────────────────────────────────────────────────
const dlBtn = document.getElementById('dl-btn');
if (dlBtn) {
  dlBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = 'mailguard_v7_local.zip';
    a.download = 'mailguard_v7_local.zip';
    a.click();
  });
}

// ── Smooth scroll nav links ──────────────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth' });
    }
  });
});
