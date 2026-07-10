/* ============================================================
   THE PRIVATE LEDGER — interaction engine
   One canvas. No frameworks. ~60fps or it degrades gracefully.
   ============================================================ */
(() => {
  'use strict';

  const doc = document.documentElement;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const touchOnly = matchMedia('(hover: none)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const easeOutQuint = t => 1 - Math.pow(1 - t, 5);
  const easeOutBack = t => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
  let perfLite = false;

  /* Failsafe: the hero must never stay hidden if something below throws. */
  setTimeout(() => doc.classList.add('hero-ready'), 2600);

  /* ============================================================
     HERO — the Career Index chart
     ============================================================ */
  const hero = document.querySelector('.hero');
  const canvas = document.getElementById('career-chart');
  const tooltip = document.getElementById('chart-tooltip');
  const tooltipText = document.getElementById('chart-tooltip-text');

  const chart = (() => {
    if (!hero || !canvas) return { startDraw() {} };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { startDraw() {} };

    const T0 = 2022.05, T1 = 2026.95;
    const MILESTONES = [
      { t: 2022.45, v: 0.16, label: 'JUN 2022 — JUNIOR SOFTWARE ENGINEER · ORISYSINDIA, KERALA' },
      { t: 2023.55, v: 0.42, label: 'JUL 2023 — SOFTWARE ENGINEER · ORISYSINDIA · ▲ PROMOTED' },
      { t: 2024.78, v: 0.68, label: 'OCT 2024 — WEB DEVELOPER · POSITIVEZONE, DUBAI, UAE' },
      { t: 2026.50, v: 0.94, label: '2026 — SENIOR FULL-STACK ENGINEER · DUBAI, UAE' },
    ];
    const WOBBLE = [
      { t: 2022.05, v: 0.10 }, { t: 2022.80, v: 0.21 }, { t: 2023.05, v: 0.26 },
      { t: 2023.30, v: 0.31 }, { t: 2023.90, v: 0.47 }, { t: 2024.20, v: 0.45 },
      { t: 2024.50, v: 0.56 }, { t: 2025.10, v: 0.66 }, { t: 2025.45, v: 0.75 },
      { t: 2025.85, v: 0.73 }, { t: 2026.15, v: 0.85 }, { t: 2026.95, v: 0.97 },
    ];
    const POINTS = [...MILESTONES.map(m => ({ ...m, node: true })), ...WOBBLE]
      .sort((a, b) => a.t - b.t);

    let w = 0, h = 0, dpr = 1;
    let plotW = 0;             // timeline width — shrinks to clear the ID card on wide screens
    let samples = [];          // dense {x, y} polyline
    let nodes = [];            // milestone px positions + state
    let staticLayer, curveLayer;
    let mode = 'waiting';      // waiting → drawing → idle
    let drawElapsed = 0;       // accrues only across rendered frames
    let curveDone = reduceMotion;
    let heroVisible = true;
    let rafId = null;
    let dirty = true;

    // crosshair state
    let crossActive = false;
    let crossX = -1, targetX = -1;
    let currentLabel = '';
    // touch auto-sweep: one pass only (WCAG 2.2.2 — auto-motion ≤5s)
    let sweepEnabled = true, sweepStart = 0;

    // fps probe
    const frameTimes = [];
    let lastFrame = 0;

    const tx = t => ((t - T0) / (T1 - T0)) * plotW;
    const vy = v => {
      const top = h * 0.50, bottom = h * 0.92;
      return bottom - v * (bottom - top);
    };

    function buildGeometry() {
      const pts = POINTS.map(p => ({ x: tx(p.t), y: vy(p.v) }));
      samples = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i],
              p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
        const steps = 26;
        for (let s = 0; s < steps; s++) {
          const u = s / steps, u2 = u * u, u3 = u2 * u;
          samples.push({
            x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
            y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3),
          });
        }
      }
      samples.push(pts[pts.length - 1]);
      nodes = MILESTONES.map(m => ({ x: tx(m.t), y: vy(m.v), label: m.label, appearAt: 0 }));
    }

    function paintStatic() {
      staticLayer = document.createElement('canvas');
      staticLayer.width = w * dpr; staticLayer.height = h * dpr;
      const c = staticLayer.getContext('2d');
      c.scale(dpr, dpr);
      c.strokeStyle = 'rgba(255,255,255,0.035)';
      c.lineWidth = 1;
      for (let x = 0.5; x < w; x += 72) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
      for (let y = 0.5; y < h; y += 72) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
      c.font = '10px "IBM Plex Mono", monospace';
      c.fillStyle = 'rgba(147,160,180,0.85)';
      c.textAlign = 'center';
      for (let yr = 2022; yr <= 2026; yr++) {
        const x = tx(yr + 0.5);
        if (x > 20 && x < w - 20) c.fillText("'" + String(yr).slice(2), x, h - 14);
      }
    }

    function paintCurve(endX) {
      curveLayer = curveLayer || document.createElement('canvas');
      curveLayer.width = w * dpr; curveLayer.height = h * dpr;
      const c = curveLayer.getContext('2d');
      c.scale(dpr, dpr);
      const pts = samples.filter(p => p.x <= endX);
      if (pts.length < 2) return;
      // area fill
      const grad = c.createLinearGradient(0, h * 0.5, 0, h * 0.95);
      grad.addColorStop(0, 'rgba(46,230,168,0.10)');
      grad.addColorStop(1, 'rgba(46,230,168,0)');
      c.beginPath();
      c.moveTo(pts[0].x, h * 0.95);
      pts.forEach(p => c.lineTo(p.x, p.y));
      c.lineTo(pts[pts.length - 1].x, h * 0.95);
      c.closePath();
      c.fillStyle = grad;
      c.fill();
      // glow pass then core stroke
      c.lineJoin = 'round'; c.lineCap = 'round';
      c.beginPath();
      pts.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y));
      c.shadowColor = 'rgba(46,230,168,0.6)';
      c.shadowBlur = perfLite ? 0 : 18;
      c.strokeStyle = 'rgba(46,230,168,0.35)';
      c.lineWidth = 3;
      c.stroke();
      c.shadowBlur = 0;
      c.strokeStyle = '#2EE6A8';
      c.lineWidth = 2;
      c.stroke();
    }

    function yAt(x) {
      if (!samples.length) return h * 0.7;
      let lo = 0, hi = samples.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].x < x) lo = mid + 1; else hi = mid;
      }
      return samples[lo].y;
    }

    function labelAt(x) {
      let label = nodes[0].label;
      for (const n of nodes) if (x >= n.x - 4) label = n.label;
      return label;
    }

    function drawNodes(now, endX) {
      for (const n of nodes) {
        if (n.x > endX) continue;
        if (!n.appearAt) n.appearAt = now;
        const pop = reduceMotion ? 1 : easeOutBack(clamp((now - n.appearAt) / 350, 0, 1));
        const breathe = (reduceMotion || perfLite) ? 0 : (Math.sin(now / 1500 + n.x) + 1) / 2;
        const r = 5 * pop;
        if (r <= 0) continue;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + breathe * 1.4, 0, Math.PI * 2);
        ctx.fillStyle = '#05070A';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = '#2EE6A8';
        ctx.lineWidth = 1.5;
        ctx.shadowColor = 'rgba(46,230,168,0.8)';
        ctx.shadowBlur = perfLite ? 0 : 8 + breathe * 8;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }

    function drawCross() {
      if (crossX < 0) return;
      const y = yAt(crossX);
      ctx.strokeStyle = 'rgba(212,175,106,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(crossX + 0.5, 0);
      ctx.lineTo(crossX + 0.5, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(crossX, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#D4B15F';
      ctx.shadowColor = 'rgba(212,177,95,0.8)';
      ctx.shadowBlur = perfLite ? 0 : 10;
      ctx.fill();
      ctx.shadowBlur = 0;

      if (tooltip) {
        const label = labelAt(crossX);
        if (label !== currentLabel) { currentLabel = label; tooltipText.textContent = label; }
        const tw = tooltip.offsetWidth || 240;
        // keep the tooltip within the plot area (left of the ID card): prefer the
        // right of the crosshair, flip left when it would overflow past plotW
        const px = (crossX + 16 + tw <= plotW)
          ? crossX + 16
          : Math.max(8, crossX - 16 - tw);
        const py = clamp(y - 52, 70, h - 40);
        tooltip.style.transform = `translate3d(${px}px, ${py}px, 0)`;
        tooltip.classList.add('visible');
      }
    }

    function hideCross() {
      crossActive = false;
      crossX = targetX = -1;
      if (tooltip) tooltip.classList.remove('visible');
      dirty = true;
      requestFrame();
    }

    function frame(now) {
      rafId = null;
      const prevFrame = lastFrame;
      // fps probe during the draw-in animation
      if (mode === 'drawing' && lastFrame) {
        frameTimes.push(now - lastFrame);
        if (frameTimes.length === 24) {
          const sorted = [...frameTimes].sort((a, b) => a - b);
          if (sorted[Math.floor(sorted.length / 2)] > 24) {
            perfLite = true;
            doc.classList.add('perf-lite');
          }
        }
      }
      lastFrame = now;

      const sweeping = touchOnly && !reduceMotion && curveDone && sweepEnabled;
      if (sweeping) {
        if (!sweepStart) sweepStart = now;
        if (now - sweepStart > 4200) {
          sweepEnabled = false;
          hideCross();
        } else {
          // one full out-and-back pass, starting from the left edge
          targetX = plotW * (0.5 + 0.45 * Math.sin(((now - sweepStart) / 4200) * Math.PI * 2 - Math.PI / 2));
          crossActive = true;
        }
      }
      if (crossActive) {
        if (crossX < 0) crossX = targetX;
        crossX += (targetX - crossX) * 0.12;
      }

      let endX = plotW;
      if (mode === 'drawing') {
        // accrue progress only across frames that actually render, so the
        // draw-in survives background tabs and offscreen starts; the cap
        // swallows long hidden gaps
        if (prevFrame) drawElapsed += Math.min(now - prevFrame, 50);
        const p = clamp(drawElapsed / 1800, 0, 1);
        endX = easeOutQuint(p) * plotW;
        paintCurve(endX);
        if (p >= 1) { mode = 'idle'; curveDone = true; }
        dirty = true;
      }

      const needsRepaint = dirty || crossActive || (!reduceMotion && !perfLite && curveDone);
      if (needsRepaint) {
        ctx.clearRect(0, 0, w, h);
        if (staticLayer) ctx.drawImage(staticLayer, 0, 0, w, h);
        if (curveLayer) ctx.drawImage(curveLayer, 0, 0, w, h);
        drawNodes(now, mode === 'drawing' ? endX : w);
        if (curveDone) drawCross();
        dirty = false;
      }

      // re-evaluate the sweep term fresh: curveDone may have flipped this frame
      const keepRunning = heroVisible && !document.hidden &&
        (mode === 'drawing' || crossActive ||
         (touchOnly && !reduceMotion && curveDone && sweepEnabled) ||
         (!reduceMotion && !perfLite && curveDone));
      if (keepRunning) requestFrame();
    }

    function requestFrame() {
      if (rafId == null) rafId = requestAnimationFrame(frame);
    }

    function resize() {
      const r = hero.getBoundingClientRect();
      w = Math.round(r.width); h = Math.round(r.height);
      // Reserve a right gutter so the timeline ends before the ID card
      // (only when the card sits beside the content — wide layout).
      plotW = w;
      const card = document.querySelector('.idcard');
      if (card && innerWidth > 1100) {
        const cr = card.getBoundingClientRect();
        plotW = Math.round(clamp(cr.left - r.left - 36, w * 0.5, w));
      }
      dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildGeometry();
      paintStatic();
      if (curveDone) paintCurve(w);
      dirty = true;
      requestFrame();
    }

    // pointer scrubbing (any device with a pointer; auto-sweep covers touch)
    hero.addEventListener('pointermove', e => {
      if (touchOnly) return;
      // over the ID card: don't scrub — the chart detail must not surface on the card
      if (e.target.closest && e.target.closest('.idcard')) { hideCross(); return; }
      const r = hero.getBoundingClientRect();
      targetX = clamp(e.clientX - r.left, 0, plotW);
      if (!crossActive) { crossActive = true; crossX = targetX; }
      requestFrame();
    });
    hero.addEventListener('pointerleave', hideCross);

    new IntersectionObserver(entries => {
      heroVisible = entries[entries.length - 1].isIntersecting;
      if (heroVisible) { dirty = true; requestFrame(); }
    }, { threshold: 0.05 }).observe(hero);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { lastFrame = 0; dirty = true; requestFrame(); }
    });

    let resizeTimer;
    addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    });

    resize();
    return {
      startDraw() {
        if (reduceMotion) {
          curveDone = true;
          mode = 'idle';
          paintCurve(w);
          nodes.forEach(n => { n.appearAt = 1; });
          dirty = true;
        } else {
          mode = 'drawing';
          drawElapsed = 0;
          lastFrame = 0;
        }
        requestFrame();
      },
    };
  })();

  /* ============================================================
     Glyph-scramble name reveal (runs once, aria-safe)
     ============================================================ */
  function scramble(el, done) {
    const text = el.textContent;
    const GLYPHS = '01▲$£₿€#<>/';
    el.setAttribute('aria-label', text);
    const wrap = document.createElement('span');
    wrap.setAttribute('aria-hidden', 'true');
    const spans = [...text].map(chr => {
      const s = document.createElement('span');
      s.className = 'ch';
      s.textContent = chr;
      if (chr === ' ') s.dataset.locked = '1';
      return s;
    });
    spans.forEach(s => wrap.appendChild(s));
    el.textContent = '';
    el.appendChild(wrap);
    const start = performance.now();
    const iv = setInterval(() => {
      const elapsed = performance.now() - start;
      let allLocked = true;
      spans.forEach((s, i) => {
        if (s.dataset.locked) return;
        if (elapsed >= i * 42 + 220) {
          s.textContent = text[i];
          s.dataset.locked = '1';
        } else {
          s.textContent = GLYPHS[(Math.random() * GLYPHS.length) | 0];
          allLocked = false;
        }
      });
      if (allLocked) { clearInterval(iv); if (done) done(); }
    }, 40);
  }

  /* ---- intro choreography, gated on fonts so Fraunces never misses ---- */
  const fontsReady = document.fonts
    ? Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1600))])
    : Promise.resolve();
  fontsReady.then(() => {
    doc.classList.add('hero-ready');
    const name = document.getElementById('hero-name');
    if (name && !reduceMotion) scramble(name);
    setTimeout(() => chart.startDraw(), reduceMotion ? 0 : 300);
  });

  /* ============================================================
     Reveal system
     ============================================================ */
  const reveals = [...document.querySelectorAll('[data-reveal]')];
  const groups = new Map();
  reveals.forEach(el => {
    const parent = el.parentElement;
    const idx = groups.get(parent) || 0;
    groups.set(parent, idx + 1);
    el.style.setProperty('--d', `${Math.min(idx, 3) * 90}ms`);
  });
  if ('IntersectionObserver' in window) {
    const ro = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (en.isIntersecting) {
          en.target.classList.add('revealed');
          setTimeout(() => en.target.classList.add('settled'), 900);
          ro.unobserve(en.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -5% 0px' });
    reveals.forEach(el => ro.observe(el));

    const so = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (en.isIntersecting) {
          en.target.classList.add('in-view');
          so.unobserve(en.target);
        }
      });
    }, { threshold: 0.2 });
    document.querySelectorAll('[data-sechead]').forEach(el => so.observe(el));
  } else {
    reveals.forEach(el => el.classList.add('revealed', 'settled'));
    document.querySelectorAll('[data-sechead]').forEach(el => el.classList.add('in-view'));
  }
  if (window.__revealFailsafe) clearTimeout(window.__revealFailsafe);

  /* ============================================================
     Scroll-linked: nav state, progress hairline, ledger rail
     ============================================================ */
  const nav = document.getElementById('nav');
  const progressBar = document.getElementById('scroll-progress');
  const ledger = document.getElementById('ledger');
  const railFill = document.getElementById('rail-fill');
  let scrollScheduled = false;

  // scroll-linked parallax: layers drift at their own rate relative to viewport
  const parallaxEls = reduceMotion ? [] :
    [...document.querySelectorAll('[data-parallax]')].map(el => ({
      el, s: parseFloat(el.getAttribute('data-parallax')) || 0.1
    }));

  function onScroll() {
    scrollScheduled = false;
    const y = scrollY;
    if (nav) nav.classList.toggle('scrolled', y > 40);
    if (progressBar) {
      const max = document.documentElement.scrollHeight - innerHeight;
      progressBar.style.transform = `scaleX(${max > 0 ? clamp(y / max, 0, 1) : 0})`;
    }
    if (ledger && railFill) {
      const r = ledger.getBoundingClientRect();
      const p = clamp((innerHeight * 0.72 - r.top) / r.height, 0, 1);
      railFill.style.transform = `scaleY(${p})`;
    }
    if (parallaxEls.length) {
      const mid = innerHeight / 2;
      for (const p of parallaxEls) {
        const r = p.el.getBoundingClientRect();
        const off = (r.top + r.height / 2) - mid;
        p.el.style.transform = `translate3d(0, ${(-off * p.s).toFixed(1)}px, 0)`;
      }
    }
  }
  addEventListener('scroll', () => {
    if (!scrollScheduled) { scrollScheduled = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  onScroll();

  /* ============================================================
     Odometer stat roll
     ============================================================ */
  const odos = [...document.querySelectorAll('.odo')];
  odos.forEach(o => {
    const val = o.dataset.value || o.textContent;
    o.setAttribute('role', 'img');
    o.setAttribute('aria-label', val);
    o.textContent = '';
    o._cols = [];
    [...val].forEach(chr => {
      if (!/\d/.test(chr)) {
        const s = document.createElement('span');
        s.textContent = chr;
        o.appendChild(s);
        return;
      }
      const col = document.createElement('span');
      col.className = 'odo__col';
      const strip = document.createElement('span');
      strip.className = 'odo__strip';
      for (let cycle = 0; cycle < 2; cycle++) {
        for (let d = 0; d < 10; d++) {
          const dd = document.createElement('span');
          dd.textContent = d;
          strip.appendChild(dd);
        }
      }
      col.appendChild(strip);
      o.appendChild(col);
      o._cols.push({ strip, target: 10 + Number(chr) });
    });
  });
  // shared print hooks: anything visual that completes lazily must be
  // forced to its final state before the print snapshot
  const printHooks = [];
  const runPrintHooks = () => printHooks.forEach(fn => fn());
  addEventListener('beforeprint', runPrintHooks);
  const printMq = matchMedia('print');
  if (printMq.addEventListener) {
    printMq.addEventListener('change', e => { if (e.matches) runPrintHooks(); });
  }

  const snapOdos = () => odos.forEach(o => (o._cols || []).forEach(c => {
    c.strip.style.transform = `translateY(-${c.target}em)`;
  }));
  printHooks.push(snapOdos);
  if (odos.length && 'IntersectionObserver' in window) {
    const oo = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        en.target._cols.forEach((c, i) => {
          setTimeout(() => { c.strip.style.transform = `translateY(-${c.target}em)`; }, reduceMotion ? 0 : i * 60);
        });
        oo.unobserve(en.target);
      });
    }, { threshold: 0.4 });
    odos.forEach(o => oo.observe(o));
  } else {
    snapOdos();
  }

  /* ============================================================
     Sparklines — each holding gets a tiny self-drawing chart
     ============================================================ */
  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function drawSpark(cv, seed) {
    const rand = mulberry32(seed * 1013 + 7);
    const n = 26;
    const data = [];
    for (let i = 0; i < n; i++) data.push(0.15 + (i / (n - 1)) * 0.55 + (rand() - 0.5) * 0.22);
    const cw = 220, ch = 48;
    const sdpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = cw * sdpr; cv.height = ch * sdpr;
    const c = cv.getContext('2d');
    c.scale(sdpr, sdpr);
    const px = i => (i / (n - 1)) * (cw - 8) + 4;
    const py = v => ch - 6 - v * (ch - 12);
    let t0 = null;
    function paint(now) {
      if (t0 == null) t0 = now;
      const p = reduceMotion ? 1 : clamp((now - t0) / 700, 0, 1);
      const upTo = Math.max(2, Math.ceil(easeOutQuint(p) * n));
      c.clearRect(0, 0, cw, ch);
      c.beginPath();
      for (let i = 0; i < upTo; i++) i ? c.lineTo(px(i), py(data[i])) : c.moveTo(px(i), py(data[i]));
      c.strokeStyle = 'rgba(46,230,168,0.85)';
      c.lineWidth = 1.5;
      c.lineJoin = 'round';
      c.stroke();
      const li = upTo - 1;
      c.beginPath();
      c.arc(px(li), py(data[li]), 2.2, 0, Math.PI * 2);
      c.fillStyle = '#D4B15F';
      c.fill();
      if (p < 1) requestAnimationFrame(paint);
    }
    requestAnimationFrame(paint);
  }
  const sparks = [...document.querySelectorAll('.card__spark')];
  if (sparks.length && 'IntersectionObserver' in window) {
    const sp = new IntersectionObserver(entries => {
      entries.forEach(en => {
        if (!en.isIntersecting) return;
        drawSpark(en.target, Number(en.target.dataset.spark) + 1);
        sp.unobserve(en.target);
      });
    }, { threshold: 0.3 });
    sparks.forEach(s => sp.observe(s));
  } else {
    sparks.forEach(s => drawSpark(s, Number(s.dataset.spark) + 1));
  }

  /* ============================================================
     Card tilt + border spotlight
     ============================================================ */
  document.querySelectorAll('[data-tilt]').forEach(card => {
    card.addEventListener('pointermove', e => {
      const r = card.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      card.style.setProperty('--mx', mx + 'px');
      card.style.setProperty('--my', my + 'px');
      if (!finePointer || reduceMotion || perfLite) return;
      // don't fight the reveal transition while the card is still entering
      if (!card.classList.contains('settled')) return;
      clearTimeout(card._tiltReset);
      const ry = clamp((mx / r.width - 0.5) * 8, -4, 4);
      const rx = clamp(-(my / r.height - 0.5) * 8, -4, 4);
      card.style.transition = 'transform 0.12s linear';
      card.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg)`;
    });
    card.addEventListener('pointerleave', () => {
      if (!card.style.transform) return;
      card.style.transition = 'transform 0.5s cubic-bezier(0.22,1,0.36,1)';
      card.style.transform = '';
      // hand transition ownership back to the stylesheet after settling
      clearTimeout(card._tiltReset);
      card._tiltReset = setTimeout(() => { card.style.transition = ''; }, 520);
    });
  });

  /* ============================================================
     Magnetic buttons
     ============================================================ */
  if (finePointer && !reduceMotion) {
    document.querySelectorAll('.magnetic').forEach(el => {
      el.addEventListener('pointermove', e => {
        if (perfLite) return;
        const r = el.getBoundingClientRect();
        const dx = clamp((e.clientX - (r.left + r.width / 2)) * 0.2, -6, 6);
        const dy = clamp((e.clientY - (r.top + r.height / 2)) * 0.2, -6, 6);
        // transform transitions live in the stylesheet — an inline
        // `transition` here would clobber the hover sweep/glow fades
        el.style.transform = `translate(${dx}px, ${dy}px)`;
      });
      el.addEventListener('pointerleave', () => {
        el.style.transform = '';
      });
    });
  }

  /* ============================================================
     Skill dependency trace (pointer + keyboard parity)
     ============================================================ */
  const skillWrap = document.querySelector('.skills');
  if (skillWrap) {
    const skills = [...skillWrap.querySelectorAll('.skill')];
    const byId = {};
    skills.forEach(s => { byId[s.dataset.skill] = s; });
    const nameOf = s => s.childNodes[0].textContent.trim();
    let pinned = null;

    // expose the dependency relations textually for screen readers, and
    // make the buttons genuinely activatable (click pins the trace)
    skills.forEach(s => {
      s.setAttribute('aria-pressed', 'false');
      const rels = (s.dataset.rel || '').split(/\s+/)
        .map(id => byId[id]).filter(Boolean).map(nameOf);
      if (rels.length) {
        const sp = document.createElement('span');
        sp.className = 'sr-only';
        sp.id = `skillrel-${s.dataset.skill}`;
        sp.textContent = `Related: ${rels.join(', ')}`;
        s.appendChild(sp);
        s.setAttribute('aria-describedby', sp.id);
      }
    });

    const traceFrom = origin => {
      skillWrap.classList.add('skill-tracing');
      skills.forEach(s => s.classList.remove('is-origin', 'is-linked'));
      origin.classList.add('is-origin');
      (origin.dataset.rel || '').split(/\s+/).forEach(id => {
        if (byId[id]) byId[id].classList.add('is-linked');
      });
    };
    const clearTrace = () => {
      skillWrap.classList.remove('skill-tracing');
      skills.forEach(s => s.classList.remove('is-origin', 'is-linked'));
    };
    // hover/focus show a transient trace; releasing falls back to the pin
    const restore = () => { if (pinned) traceFrom(pinned); else clearTrace(); };
    const unpin = () => {
      if (!pinned) return;
      pinned.setAttribute('aria-pressed', 'false');
      pinned = null;
    };

    skills.forEach(s => {
      s.addEventListener('click', () => {
        if (pinned === s) { unpin(); clearTrace(); return; }
        unpin();
        pinned = s;
        s.setAttribute('aria-pressed', 'true');
        traceFrom(s);
      });
      if (!touchOnly) {
        s.addEventListener('mouseenter', () => traceFrom(s));
        s.addEventListener('mouseleave', restore);
      }
      s.addEventListener('focus', () => traceFrom(s));
      s.addEventListener('blur', restore);
    });
    document.addEventListener('pointerdown', e => {
      if (pinned && !e.target.closest('.skill')) { unpin(); clearTrace(); }
    }, { passive: true });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && pinned) { unpin(); clearTrace(); }
    });
  }

  /* ============================================================
     ID-card photo: fall back to the monogram until a real
     photo exists at assets/profile.jpg
     ============================================================ */
  const profileImg = document.getElementById('profile-photo');
  if (profileImg) {
    const card = profileImg.closest('.idcard');
    const usePlaceholder = () => card && card.classList.add('no-photo');
    profileImg.addEventListener('error', usePlaceholder);
    if (profileImg.complete && profileImg.naturalWidth === 0) usePlaceholder();
  }

  /* ============================================================
     Ticker pause/play control (WCAG 2.2.2)
     ============================================================ */
  const ticker = document.querySelector('.ticker');
  const tickerToggle = document.querySelector('.ticker__toggle');
  if (ticker && tickerToggle) {
    tickerToggle.addEventListener('click', () => {
      const paused = ticker.classList.toggle('is-paused');
      tickerToggle.setAttribute('aria-pressed', String(paused));
      tickerToggle.setAttribute('aria-label', paused ? 'Play skills ticker' : 'Pause skills ticker');
      tickerToggle.textContent = paused ? '▶' : '❚❚';
    });
  }

  /* ============================================================
     Copy-email micro-transaction
     ============================================================ */
  const copyBtn = document.getElementById('copy-email');
  if (copyBtn) {
    const originalLabel = copyBtn.textContent;
    const statusEl = document.getElementById('copy-status');
    // keep the accessible name stable while the visual label scrambles
    copyBtn.setAttribute('aria-label', 'Copy email address to clipboard');
    let busy = false;
    copyBtn.addEventListener('click', async () => {
      const email = copyBtn.dataset.email;
      let ok = true;
      try {
        await navigator.clipboard.writeText(email);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = email;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        ta.remove();
      }
      if (busy) return;
      busy = true;
      if (statusEl) {
        statusEl.textContent = ok
          ? 'Email address copied to clipboard.'
          : 'Copy failed. The email address is shown beside the button.';
      }
      const CONFIRM = ok ? 'COPIED ✓ CONFIRMED' : 'COPY FAILED — SELECT MANUALLY';
      const GLYPHS = '01▲$£₿€#';
      if (!reduceMotion && ok) {
        let ticks = 0;
        const iv = setInterval(() => {
          copyBtn.textContent = [...CONFIRM].map(chr =>
            chr === ' ' ? ' ' : (Math.random() < ticks / 6 ? chr : GLYPHS[(Math.random() * GLYPHS.length) | 0])
          ).join('');
          if (++ticks > 6) {
            clearInterval(iv);
            copyBtn.textContent = CONFIRM;
          }
        }, 40);
      } else {
        copyBtn.textContent = CONFIRM;
      }
      if (ok) copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = originalLabel;
        copyBtn.classList.remove('copied');
        if (statusEl) statusEl.textContent = '';
        busy = false;
      }, 2000);
    });
  }

  /* ============================================================
     Fig. 1 — self-drawing topology diagram
     ============================================================ */
  const fig = document.getElementById('topology');
  if (fig) {
    const drawEls = [...fig.querySelectorAll('.draw')];
    drawEls.forEach((el, i) => {
      el.style.setProperty('--i', i);
      if (!reduceMotion) {
        try {
          const L = el.getTotalLength();
          el.style.strokeDasharray = String(L);
          el.style.strokeDashoffset = String(L);
        } catch { /* non-geometry element */ }
      }
    });
    const holder = fig.closest('.card__fig');
    const reveal = () => holder && holder.classList.add('fig-drawn');
    // for print, the CSS animation won't run — clear the inline dash
    // hiding so strokes render fully drawn on paper
    const forceDrawn = () => {
      drawEls.forEach(el => {
        el.style.strokeDasharray = '';
        el.style.strokeDashoffset = '';
      });
      reveal();
    };
    if ('IntersectionObserver' in window) {
      const fo = new IntersectionObserver(entries => {
        if (entries[entries.length - 1].isIntersecting) { reveal(); fo.disconnect(); }
      }, { threshold: 0.35 });
      fo.observe(fig);
    } else forceDrawn();
    printHooks.push(forceDrawn);
  }
})();
