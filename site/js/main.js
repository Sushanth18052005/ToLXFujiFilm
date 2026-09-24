// main.js — smooth scroll, scroll-telling, reveals, and the 3D camera wiring.
import { createCamera3D } from './camera3d.js';

window.__site_booted = true; // tells the inline failsafe the module is alive

const doc = document.documentElement;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
const hasGSAP = !!(gsap && ScrollTrigger);

// Never leave content hidden: if a CDN is blocked or anything throws, reveal all.
const failsafe = setTimeout(() => doc.classList.add('reveal-all'), 2800);

// ---------- registration link ----------
// Registration form URL (Google Form). Wired to every [data-register] CTA;
// left empty they gracefully fall back to their in-page anchor.
const REGISTER_URL = 'https://forms.gle/zMSLLJu3kXLkb6Uw8';
if (REGISTER_URL) {
  document.querySelectorAll('[data-register]').forEach((a) => {
    a.href = REGISTER_URL; a.target = '_blank'; a.rel = 'noopener';
  });
}

// ---------- loader ----------
function runLoader(onDone) {
  const loader = document.getElementById('loader');
  const pct = document.getElementById('loaderPct');
  if (!loader) { onDone(); return; }
  let p = 0, ended = false, loaded = document.readyState === 'complete';
  addEventListener('load', () => { loaded = true; }, { once: true });
  const finish = () => { loader.classList.add('is-done'); setTimeout(onDone, 520); };
  const step = () => {
    if (ended) return;
    p = Math.min(loaded ? 100 : 92, p + Math.random() * 13 + 3);
    if (pct) pct.textContent = Math.floor(p);
    if (p >= 100) { ended = true; setTimeout(finish, 260); return; }
    setTimeout(step, 80);
  };
  step();
  setTimeout(() => { if (!ended) { ended = true; if (pct) pct.textContent = '100'; finish(); } }, 4200);
}
// ---------- 3D stage ----------
function initScene() {
  const canvas = document.getElementById('gl');
  if (!canvas) { doc.classList.add('no-webgl'); return null; }
  try { return createCamera3D(canvas); }
  catch (e) { console.warn('3D disabled:', e.message); doc.classList.add('no-webgl'); return null; }
}

// pointer parallax → subtle camera lean
function wirePointer(cam) {
  if (!cam || REDUCED) return;
  let px = 0, py = 0, queued = false;
  addEventListener('pointermove', (e) => {
    px = (e.clientX / innerWidth) * 2 - 1;
    py = (e.clientY / innerHeight) * 2 - 1;
    if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; cam.setPointer(px, py); }); }
  }, { passive: true });
}

// Fallback camera driver when GSAP is unavailable: raw scroll math.
function nativeScrollDriver(cam) {
  const s3d = document.getElementById('scroll3d');
  if (!cam || !s3d) return;
  const upd = () => {
    const r = s3d.getBoundingClientRect();
    const total = r.height - innerHeight;
    cam.setProgress(total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 0);
  };
  addEventListener('scroll', upd, { passive: true });
  addEventListener('resize', () => { cam.resize(); upd(); });
  upd();
}
// ---------- motion (GSAP + Lenis) ----------
function initMotion(cam) {
  wirePointer(cam);

  if (!hasGSAP) { doc.classList.add('reveal-all'); nativeScrollDriver(cam); return; }
  gsap.registerPlugin(ScrollTrigger);

  let lenis = null;
  if (!REDUCED && window.Lenis) {
    lenis = new window.Lenis({ lerp: 0.09, wheelMultiplier: 1 });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
    doc.classList.add('lenis');
  }

  // smooth anchor navigation
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (id.length < 2) return;
      const el = document.querySelector(id);
      if (!el) return;
      e.preventDefault();
      if (lenis) lenis.scrollTo(el, { offset: -10 });
      else el.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
    });
  });

  // camera progress across the transparent 3D act
  const s3d = document.getElementById('scroll3d');
  if (cam && s3d) {
    ScrollTrigger.create({ trigger: s3d, start: 'top top', end: 'bottom bottom', scrub: true,
      onUpdate: (self) => cam.setProgress(self.progress) });
    addEventListener('resize', () => cam.resize());
  }
  // reveals
  gsap.utils.toArray('[data-rev]').forEach((el) => {
    gsap.fromTo(el, { opacity: 0, y: 26 }, {
      opacity: 1, y: 0, duration: 1, ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 85%' },
    });
  });
  gsap.utils.toArray('[data-beat-rev]').forEach((el) => {
    gsap.fromTo(el, { opacity: 0, y: 30 }, {
      opacity: 1, y: 0, duration: 1.1, ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 80%' },
    });
  });

  // gallery parallax (GSAP owns the transform; scale keeps the frame covered)
  gsap.utils.toArray('[data-parallax] img').forEach((img) => {
    gsap.fromTo(img, { yPercent: -6, scale: 1.12 }, {
      yPercent: 6, scale: 1.12, ease: 'none',
      scrollTrigger: { trigger: img.parentElement, start: 'top bottom', end: 'bottom top', scrub: true },
    });
  });

  // nav solidifies once past the hero
  const nav = document.getElementById('nav');
  if (nav) {
    ScrollTrigger.create({ start: 80, end: 'max',
      onToggle: (self) => nav.classList.toggle('is-solid', self.isActive) });
  }

  ScrollTrigger.refresh();
}

// ---------- boot ----------
// Set up motion immediately (independent of the loader) so scroll reveals arm
// early and the failsafe can be cleared right away; the loader just covers the
// first paint. A throw during setup still un-hides everything.
const cam = initScene();
try { initMotion(cam); clearTimeout(failsafe); }
catch (e) { console.warn('motion init failed:', e); doc.classList.add('reveal-all'); }
runLoader(() => {});
