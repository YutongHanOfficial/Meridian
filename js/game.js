'use strict';

(() => {
  const R = 6371;
  // If audio.js fails to load, play silently instead of crashing.
  const silent = { isMuted: () => true, toggle: () => true };
  const sfx = typeof Sfx !== 'undefined' ? Sfx : new Proxy(silent, { get: (t, k) => t[k] || (() => {}) });
  const COLORS = { good: '#3ddc97', bad: '#ff4d6d', warn: '#ffc857', cyan: '#5ee6ff', pink: '#ff7ad9', white: '#ffffff' };
  const $ = s => document.querySelector(s);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const fmt = n => Math.round(n).toLocaleString('en-US');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const kmBetween = (a, b) => d3.geoDistance(a, b) * R;
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function bearing(a, b) {
    const toR = Math.PI / 180;
    const [l1, p1] = [a[0] * toR, a[1] * toR], [l2, p2] = [b[0] * toR, b[1] * toR];
    const y = Math.sin(l2 - l1) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
    return (Math.atan2(y, x) / toR + 360) % 360;
  }
  const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  const arrowFor = deg => ARROWS[Math.round(deg / 45) % 8];

  const DAY_ONE = Date.UTC(2026, 9, 22); // Daily #1

  function todayKey() {
    const d = new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  function dailyNumber() {
    const d = new Date();
    return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - DAY_ONE) / 864e5) + 1;
  }

  // ---------- world ----------
  let W, globe, POOL, NAME_INDEX, GUESS_NAMES;

  function buildWorld(t50, t110) {
    const features = topojson.feature(t50, t50.objects.countries).features;
    const nb = topojson.neighbors(t50.objects.countries.geometries);
    const byRaw = new Map();
    features.forEach((f, i) => {
      const raw = f.properties.name;
      f.idx = i; f.raw = raw; f.name = DISPLAY_NAMES[raw] || raw;
      byRaw.set(raw, f);
      f.bounds = d3.geoBounds(f);
      f.area = d3.geoArea(f) * R * R;
      const rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      const polys = rings.map(c => {
        const g = { type: 'Polygon', coordinates: c };
        return { c, a: d3.geoArea(g) * R * R, ctr: d3.geoCentroid(g) };
      });
      let main = polys[0];
      for (const p of polys) if (p.a > main.a) main = p;
      f.focus = main.ctr;
      let rad = 0;
      for (const pt of main.c[0]) rad = Math.max(rad, d3.geoDistance(pt, f.focus));
      f.radius = rad * 180 / Math.PI;
      const lim = Math.max(10, f.radius * 2.2);
      const keep = polys.filter(p => d3.geoDistance(p.ctr, f.focus) * 180 / Math.PI <= lim && p.a >= main.a * 0.003);
      f.shape = { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: keep.map(p => p.c) } };
      f.spots = polys.filter(p => p.a < 6000).map(p => p.ctr);
      f.territory = TERRITORIES.has(raw);
    });
    features.forEach(f => {
      f.canon = f.raw in CANON_OF ? (CANON_OF[f.raw] ? byRaw.get(CANON_OF[f.raw]) : null) : f;
    });
    features.forEach(f => { if (f.canon === f) { f.group = [f.idx]; f.adj = new Set(); } });
    features.forEach(f => { if (f.canon && f.canon !== f) f.canon.group.push(f.idx); });
    features.forEach((f, i) => {
      if (!f.canon) return;
      for (const j of nb[i]) {
        const g = features[j].canon;
        if (g && g !== f.canon) f.canon.adj.add(g.idx);
      }
    });
    features.forEach(f => { if (f.canon === f) f.garea = f.group.reduce((s, i) => s + features[i].area, 0); });
    const mk = t => ({
      land: topojson.feature(t, t.objects.land),
      borders: topojson.mesh(t, t.objects.countries, (a, b) => a !== b),
    });
    return { features, hi: mk(t50), lo: mk(t110) };
  }

  function buildPools() {
    const canon = W.features.filter(f => f.canon === f);
    const hunt = canon.filter(f => !f.territory).sort((a, b) => b.garea - a.garea);
    hunt.forEach((f, i) => { f.rank = i / (hunt.length - 1); });
    const shape = hunt.filter(f => f.garea > 2500);
    shape.forEach((f, i) => { f.srank = i / (shape.length - 1); });
    const border = hunt.filter(f => f.adj.size > 0);
    POOL = { hunt, shape, border };

    NAME_INDEX = new Map();
    for (const f of canon) { NAME_INDEX.set(norm(f.name), f); NAME_INDEX.set(norm(f.raw), f); }
    for (const [alias, name] of Object.entries(ALIASES)) {
      const f = NAME_INDEX.get(norm(name));
      if (f) NAME_INDEX.set(norm(alias), f);
    }
    GUESS_NAMES = canon.filter(f => f.raw !== 'Antarctica').map(f => f.name).sort((a, b) => a.localeCompare(b));
  }

  // ---------- game state ----------
  let G = null;
  const DUR = { hunt: r => clamp(18 - r * 0.7, 7, 18), pin: r => clamp(16 - r * 0.45, 9, 16), shape: r => clamp(34 - r, 18, 34) };

  const mult = () => 1 + Math.min(3, Math.floor(G.streak / 3) * 0.5);
  const timeFrac = () => G.timer ? clamp(1 - (performance.now() - G.timer.t0) / G.timer.dur, 0, 1) : 0;

  function pickByRank(pool, r, key, rankKey = 'rank') {
    const hi = clamp(0.2 + r * 0.055, 0.2, 1), lo = Math.max(0, hi - 0.38);
    let c = pool.filter(f => f[rankKey] >= lo && f[rankKey] <= hi && !G.used.has(key + f.idx));
    if (!c.length) c = pool.filter(f => !G.used.has(key + f.idx));
    if (!c.length) c = pool;
    const f = c[Math.floor(G.rng() * c.length)];
    G.used.add(key + f.idx);
    return f;
  }

  function pickCity(r) {
    const maxT = r < 3 ? 1 : r < 8 ? 2 : 3;
    const minT = r < 11 ? 1 : r < 16 ? 2 : 3;
    const top = G.rng() < 0.6;
    let c = CITIES.filter(x => (top ? x[4] === maxT : x[4] >= minT && x[4] <= maxT) && !G.used.has('c' + x[0]));
    if (!c.length) c = CITIES.filter(x => !G.used.has('c' + x[0]));
    if (!c.length) c = CITIES;
    const city = c[Math.floor(G.rng() * c.length)];
    G.used.add('c' + city[0]);
    return city;
  }

  function bfs(src) {
    const dist = new Map([[src.idx, 0]]), prev = new Map(), q = [src];
    while (q.length) {
      const f = q.shift();
      for (const j of f.adj) {
        if (dist.has(j)) continue;
        dist.set(j, dist.get(f.idx) + 1);
        prev.set(j, f.idx);
        q.push(W.features[j]);
      }
    }
    return { dist, prev };
  }

  function pickBorder(r) {
    for (let want = clamp(2 + Math.floor(r / 2), 2, 8); want >= 2; want--) {
      for (let tries = 0; tries < 60; tries++) {
        const s = POOL.border[Math.floor(G.rng() * POOL.border.length)];
        const { dist, prev } = bfs(s);
        const cands = POOL.border.filter(f => dist.get(f.idx) === want && !G.used.has('b' + f.idx));
        if (!cands.length) continue;
        const e = cands[Math.floor(G.rng() * cands.length)];
        G.used.add('b' + e.idx); G.used.add('b' + s.idx);
        const route = [e];
        let k = e.idx;
        while (prev.has(k)) { k = prev.get(k); route.unshift(W.features[k]); }
        return { s, e, par: want, route };
      }
    }
    throw new Error('no border pair');
  }

  function distToFeature(ll, f) {
    let best = Infinity;
    for (const i of f.group) {
      const g = W.features[i];
      if (d3.geoContains(g, ll)) return 0;
      const rings = g.geometry.type === 'Polygon' ? [g.geometry.coordinates] : g.geometry.coordinates;
      for (const poly of rings) for (const pt of poly[0]) best = Math.min(best, d3.geoDistance(ll, pt));
    }
    return best * R;
  }

  // Tiny islands and microstates: a click within a few pixels counts.
  function nearSmall(f, xy) {
    for (const i of f.group) {
      for (const spot of W.features[i].spots) {
        const p = globe.project(spot);
        if (p && Math.hypot(p[0] - xy[0], p[1] - xy[1]) < 16) return true;
      }
    }
    return false;
  }

  function fitTwo(a, b, pad) {
    const mid = d3.geoInterpolate(a, b)(0.5);
    const deg = d3.geoDistance(a, b) * 90 / Math.PI + pad;
    globe.flyTo(mid, globe.zoomFor(deg * 1.15), 1300);
  }

  function revealCountry(f, color = COLORS.good) {
    globe.setHL(f, 'good');
    globe.flyToFeature(f);
    globe.addMarker(f.focus, { label: f.name, color, pulse: f.radius < 3 });
  }

  // ---------- rounds ----------
  const ROUNDS = {
    hunt(r) {
      const target = pickByRank(POOL.hunt, r, 'h');
      return {
        type: 'hunt', label: 'Find', main: esc(target.name),
        sub: `Click it on the globe · ${sizeHint(target)}`,
        duration: DUR.hunt(r), hover: true,
        start() { if (globe.zoom > 1.6) globe.flyTo(globe.center(), 1.2, 700); },
        click(ll, f, xy) {
          if (f === target || nearSmall(target, xy)) {
            const tf = timeFrac();
            globe.burst(xy, COLORS.good);
            resolve({
              ok: true, base: 100 + Math.round(160 * tf), grade: tf > 0.45 ? 'g' : 'y',
              title: target.name, detail: tf > 0.7 ? 'Lightning fast' : tf > 0.45 ? 'Direct hit' : 'Found it',
              stat: { found: target.name },
              reveal: () => revealCountry(target),
            });
            return;
          }
          const d = distToFeature(ll, target);
          globe.burst(xy, COLORS.bad, 16);
          resolve({
            ok: false, title: f ? `That's ${f.name}` : 'That’s open ocean',
            detail: `${target.name} was ${fmt(d)} km away`,
            stat: { miss: target.name },
            reveal: () => {
              if (f) { globe.setHL(f, 'bad'); globe.addMarker(ll, { color: COLORS.bad, size: 4 }); }
              globe.addArc(ll, target.focus, COLORS.bad);
              revealCountry(target);
            },
          });
        },
        timeout() {
          resolve({ ok: false, title: 'Out of time', detail: `${target.name} is here`, stat: { miss: target.name }, reveal: () => revealCountry(target) });
        },
      };
    },

    pin(r) {
      const city = pickCity(r);
      const ll = [city[3], city[2]];
      const thr = Math.round(Math.max(250, 2000 * Math.pow(0.86, r)) / 10) * 10;
      const showCity = (ok, from) => {
        globe.addRing(ll, thr, ok ? COLORS.good : COLORS.bad);
        globe.addMarker(ll, { label: city[0], color: ok ? COLORS.good : COLORS.warn, pulse: true });
        if (from) {
          globe.addArc(from, ll, ok ? COLORS.good : COLORS.bad);
          fitTwo(from, ll, thr / 111 * 1.1);
        } else globe.flyTo(ll, globe.zoomFor(thr / 111 * 1.6));
      };
      return {
        type: 'pin', label: 'Drop a pin on', main: esc(city[0]),
        sub: `${esc(city[1])} · must land within <b>${fmt(thr)} km</b>`,
        duration: DUR.pin(r), hover: false,
        start() { if (globe.zoom > 1.6) globe.flyTo(globe.center(), 1.2, 700); },
        click(cl, f, xy) {
          const d = kmBetween(cl, ll);
          G.dists.push(d);
          const ok = d <= thr, tf = timeFrac();
          globe.addMarker(cl, { color: COLORS.white, size: 4 });
          globe.burst(xy, ok ? COLORS.good : COLORS.bad, ok ? 28 : 14);
          const bull = d < 30;
          resolve({
            ok, great: bull,
            base: ok ? Math.round(550 * (1 - d / thr)) + 100 + Math.round(100 * tf) + (bull ? 250 : 0) : 0,
            grade: d < thr * 0.3 ? 'g' : ok ? 'y' : 'r',
            title: ok ? (bull ? 'Bullseye!' : d < thr * 0.3 ? 'Sharp shot' : 'Inside the zone') : 'Outside the zone',
            detail: `${fmt(d)} km from ${city[0]}`,
            stat: { km: d, city: city[0] },
            reveal: () => showCity(ok, cl),
          });
        },
        timeout() {
          G.dists.push(thr * 2);
          resolve({ ok: false, title: 'Out of time', detail: `${city[0]} is here`, reveal: () => showCity(false) });
        },
      };
    },

    border(r) {
      const { s, e, par, route } = pickBorder(r);
      const chain = [s];
      let moves = 0;
      const drawChain = () => {
        globe.hl.clear();
        globe.setHL(s, 'start'); globe.setHL(e, 'end');
        for (const c of chain.slice(1)) if (c !== e) globe.setHL(c, 'path');
        const now = performance.now();
        globe.arcs = [];
        for (let i = 1; i < chain.length; i++) {
          globe.addArc(chain[i - 1].focus, chain[i].focus, COLORS.warn, i === chain.length - 1 ? now : now - 2000);
        }
        renderChain(chain, e, par);
      };
      const h = {
        type: 'border', label: 'Connect',
        main: `<span class="c-start">${esc(s.name)}</span><span class="c-arrow">→</span><span class="c-end">${esc(e.name)}</span>`,
        sub: `Par <b>${par}</b> · click bordering countries one by one`,
        duration: 30 + par * 8, hover: true, strikes: 0,
        start() {
          drawChain();
          $('#chain').classList.remove('hidden');
          fitTwo(s.focus, e.focus, Math.max(s.radius, e.radius) + 4);
        },
        click(ll, f, xy) {
          if (!f) { toast('That’s open water'); return; }
          const tip = chain[chain.length - 1];
          const at = chain.indexOf(f);
          if (at >= 0) {
            if (at < chain.length - 1) { chain.splice(at + 1); sfx.soft(); drawChain(); }
            return;
          }
          if (!tip.adj.has(f.idx)) {
            h.strikes++;
            globe.setHL(f, 'bad');
            setTimeout(() => { if (G && G.h === h && !chain.includes(f) && f !== e) globe.clearHL(f); }, 650);
            globe.burst(xy, COLORS.bad, 12);
            strike(`${f.name} doesn’t border ${tip.name}`);
            return;
          }
          chain.push(f); moves++;
          sfx.click();
          globe.burst(xy, COLORS.warn, 12);
          drawChain();
          if (f === e) {
            const perfect = moves === par && h.strikes === 0;
            resolve({
              ok: true, great: perfect,
              base: Math.max(50, Math.round(500 * par / moves) + Math.round(200 * timeFrac()) - (G.daily ? h.strikes * 75 : 0)),
              grade: perfect ? 'g' : 'y',
              stat: { perfect },
              title: perfect ? 'Perfect route!' : moves === par ? 'Par route' : `Connected in ${moves}`,
              detail: moves === par ? `Matched par ${par}` : `Par was ${par}: ${route.map(c => c.name).join(' → ')}`,
              reveal: () => chain.forEach((c, i) => globe.addMarker(c.focus, { label: c.name, color: i === 0 ? COLORS.cyan : i === chain.length - 1 ? COLORS.pink : COLORS.warn, size: 3 })),
            });
          }
        },
        timeout() { resolve({ ok: false, title: 'Out of time', detail: 'One shortest route is lit up', reveal: showRoute }); },
        fail(title) { resolve({ ok: false, noLife: true, title, detail: 'One shortest route is lit up', reveal: showRoute }); },
        cleanup() { $('#chain').classList.add('hidden'); },
      };
      function showRoute() {
        globe.arcs = [];
        route.slice(1, -1).forEach(c => { if (!chain.includes(c)) globe.setHL(c, 'hint'); });
        const now = performance.now();
        route.forEach((c, i) => {
          if (i) globe.addArc(route[i - 1].focus, c.focus, COLORS.good, now + i * 120);
          globe.addMarker(c.focus, { label: c.name, color: COLORS.good, size: 3 });
        });
      }
      return h;
    },

    shape(r) {
      const target = pickByRank(POOL.shape, r, 's', 'srank');
      const rotate = r >= 7 && (r >= 11 || G.rng() < 0.5) ? 30 + Math.floor(G.rng() * 300) : 0;
      const wrong = [];
      const reveal = () => {
        hideShape();
        globe.dimTarget = 0; globe.autoSpin = 0;
        revealCountry(target);
      };
      const h = {
        type: 'shape', label: 'Identify', main: 'Name this country',
        sub: `${rotate ? '<span class="tag">Rotated</span> ' : ''}3 guesses · type to search`,
        duration: DUR.shape(r), hover: false, clickable: false,
        start() {
          globe.dimTarget = 0.55; globe.autoSpin = 3;
          if (globe.zoom > 1.3) globe.flyTo(globe.center(), 1, 700);
          showShape(target, rotate);
        },
        submit(name) {
          const f = NAME_INDEX.get(norm(name));
          if (!f) { shakeInput('Not a country on this map'); return; }
          if (wrong.includes(f)) { shakeInput('Already guessed'); return; }
          if (f === target) {
            resolve({
              ok: true, great: wrong.length === 0,
              base: [320, 200, 110][wrong.length] + Math.round(140 * timeFrac()),
              grade: wrong.length === 0 ? 'g' : 'y', title: target.name,
              detail: wrong.length ? `Got it on guess ${wrong.length + 1}` : 'First guess',
              stat: { found: target.name, first: wrong.length === 0 },
              reveal,
            });
            return;
          }
          wrong.push(f);
          sfx.soft();
          addGuessRow(f, target);
          if (wrong.length === 1) { drawShape(target, rotate, true); addBadge('Surroundings revealed'); }
          if (wrong.length === 2) addBadge(`Starts with “${target.name[0]}”`);
          if (wrong.length >= 3) resolve({ ok: false, title: 'Out of guesses', detail: `It was ${target.name}`, stat: { miss: target.name }, reveal });
        },
        timeout() { resolve({ ok: false, title: 'Out of time', detail: `It was ${target.name}`, stat: { miss: target.name }, reveal }); },
        cleanup() { hideShape(); globe.dimTarget = 0; globe.autoSpin = 0; },
      };
      return h;
    },
  };

  function sizeHint(f) {
    if (f.garea > 1e6) return 'huge';
    if (f.garea > 2.5e5) return 'large';
    if (f.garea > 5e4) return 'medium';
    if (f.garea > 5000) return 'small';
    return 'tiny, zoom in';
  }

  // ---------- flow ----------
  async function startGame(mode) {
    sfx.unlock();
    const daily = mode === 'daily';
    G = {
      mode, daily, round: 0, score: 0, lives: daily ? Infinity : 3, streak: 0, bestStreak: 0,
      hits: 0, total: 0, grades: [], used: new Set(), dists: [],
      rng: daily ? mulberry32(todayKey() * 7919) : Math.random, state: 'countdown', h: null, timer: null,
      // Only the first daily attempt of the day counts; replays are practice.
      official: daily && !lsGet('meridian.daily.' + todayKey(), null),
    };
    $('#menu').classList.add('hidden');
    $('#over').classList.add('hidden');
    $('#hud').classList.remove('hidden');
    $('#controls').classList.add('in-game');
    $('#hud-mode').textContent = MODES[mode].name + (daily && !G.official ? ' · Practice' : '');
    shownScore = 0;
    $('#hud-score').dataset.v = 0;
    globe.reset();
    globe.autoSpin = 0;
    globe.flyTo(globe.center(), 1, 800);
    setPrompt('Get ready', '&nbsp;', '');
    renderHud();
    await countdown();
    if (G && G.state === 'countdown') startRound();
  }

  function startRound() {
    globe.reset();
    const spec = G.daily ? DAILY_SEQ[G.round] : { type: G.mode, lvl: G.round };
    G.h = ROUNDS[spec.type](spec.lvl);
    setPrompt(G.h.label, G.h.main, G.h.sub);
    G.state = 'playing';
    globe.interactive = G.h.clickable !== false;
    globe.hoverEnabled = !!G.h.hover;
    globe.hover = null;
    document.body.classList.toggle('playing', globe.interactive);
    G.h.start && G.h.start();
    G.timer = { t0: performance.now(), dur: G.h.duration * 1000, lastTick: 99 };
    // Lock the official attempt the moment it starts, so quitting can't buy a retry.
    if (G.official && G.round === 0) saveDailyProgress(false);
    renderHud();
  }

  function strike(msg) {
    sfx.bad();
    shake();
    toast(msg, 'bad');
    if (G.daily) return;
    G.lives--;
    G.streak = 0;
    renderHud(true);
    if (G.lives <= 0) G.h.fail('Out of lives');
  }

  function resolve(res) {
    if (!G || G.state !== 'playing') return;
    G.state = 'reveal';
    globe.interactive = false;
    document.body.classList.remove('playing');
    globe.hoverEnabled = false;
    globe.hover = null;
    G.total++;
    let pts = 0;
    if (res.ok) {
      G.streak++;
      G.hits++;
      G.bestStreak = Math.max(G.bestStreak, G.streak);
      pts = Math.round(res.base * mult());
      (res.great || res.grade === 'g' ? sfx.great : sfx.good)();
    } else {
      G.streak = 0;
      if (!G.daily && !res.noLife) G.lives--;
      sfx.bad();
      shake();
    }
    G.score += pts;
    G.grades.push(res.ok ? (res.grade || 'g') : 'r');
    const secs = G.timer ? (performance.now() - G.timer.t0) / 1000 : 0;
    G.timer = null;
    recordRound(G.h.type, res, secs);
    renderHud(!res.ok);
    if (res.reveal) res.reveal();
    G.over = G.daily ? G.round >= DAILY_SEQ.length - 1 : G.lives <= 0;
    if (G.official) saveDailyProgress(G.over);
    showFeedback(res, pts);
    clearTimeout(G.auto);
    G.auto = setTimeout(next, G.over ? 3400 : 3600);
  }

  function next() {
    if (!G || G.state !== 'reveal') return;
    clearTimeout(G.auto);
    $('#feedback').classList.add('hidden');
    if (G.h && G.h.cleanup) G.h.cleanup();
    if (G.over) return gameOver();
    G.round++;
    startRound();
  }

  function gameOver() {
    G.state = 'over';
    sfx.over();
    globe.reset();
    globe.interactive = false;
    globe.hoverEnabled = false;
    globe.flyTo(globe.center(), 1, 1200);
    globe.autoSpin = 5;
    $('#hud').classList.add('hidden');
    $('#controls').classList.remove('in-game');
    const practice = G.daily && !G.official;
    const key = 'meridian.best.' + G.mode;
    const prevBest = lsGet(key, 0);
    const isBest = !practice && G.score > prevBest;
    if (isBest) lsSet(key, G.score);
    recordGame();
    const official = G.daily ? lsGet('meridian.daily.' + todayKey(), null) : null;

    const acc = G.total ? Math.round(100 * G.hits / G.total) : 0;
    const stats = [
      ['Rounds', G.daily ? `${G.hits}/${G.total}` : String(G.total)],
      ['Accuracy', acc + '%'],
      ['Best streak', String(G.bestStreak)],
    ];
    if (G.mode === 'pin' && G.dists.length) {
      const avg = G.dists.reduce((a, b) => a + b, 0) / G.dists.length;
      stats.push(['Avg miss', fmt(avg) + ' km']);
    } else stats.push(['Personal best', fmt(Math.max(prevBest, G.score))]);

    $('#over-mode').textContent = MODES[G.mode].name + (G.daily ? ` #${dailyNumber()}` : '') + (practice ? ' · Practice' : '');
    $('#over-title').textContent = practice ? 'Practice run' : G.daily ? 'Gauntlet complete' : rankTitle(G.total);
    $('#over-note').innerHTML = practice && official
      ? `Practice doesn\u2019t count. Today\u2019s official score: <b>${fmt(official.score)}</b>`
      : G.daily ? `Official score locked in. Daily streak: <b>${dailyStreaks().current}</b>` : '';
    $('#over-score').textContent = '0';
    countUp($('#over-score'), G.score, 1200);
    $('#over-best').classList.toggle('hidden', !isBest || G.score === 0);
    $('#over-stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><div class="stat-v">${v}</div><div class="stat-k">${k}</div></div>`).join('');
    $('#over-grid').innerHTML = G.grades.map(g => `<span class="cell cell-${g}"></span>`).join('');
    $('#share-btn').classList.toggle('hidden', !G.daily);
    $('#over').classList.remove('hidden');
  }

  function rankTitle(n) {
    if (n >= 25) return 'Cartographer supreme';
    if (n >= 18) return 'World walker';
    if (n >= 12) return 'Seasoned navigator';
    if (n >= 7) return 'Promising explorer';
    if (n >= 3) return 'Lost tourist';
    return 'Still at the airport';
  }

  function quit() {
    if (!G) return showMenu();
    clearTimeout(G.auto);
    if (G.h && G.h.cleanup) G.h.cleanup();
    G = null;
    globe.reset();
    globe.interactive = false;
    globe.hoverEnabled = false;
    $('#feedback').classList.add('hidden');
    $('#hud').classList.add('hidden');
    $('#countdown').classList.remove('show');
    showMenu();
  }

  // ---------- HUD ----------
  function setPrompt(label, mainHtml, subHtml) {
    $('#p-label').textContent = label;
    $('#p-main').innerHTML = mainHtml;
    $('#p-sub').innerHTML = subHtml;
    const card = $('#prompt');
    card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop');
  }

  let shownScore = 0;
  function renderHud(hurt) {
    if (!G) return;
    $('#hud-round').textContent = G.daily ? `Round ${G.round + 1}/${DAILY_SEQ.length}` : `Round ${G.round + 1}`;
    countUp($('#hud-score'), G.score, 500, shownScore);
    shownScore = G.score;
    const m = mult();
    const mEl = $('#hud-mult');
    mEl.textContent = m > 1 ? `×${m}` : '';
    mEl.classList.toggle('on', m > 1);
    $('#hud-streak').textContent = G.streak >= 2 ? `${G.streak} streak` : '';
    const lives = $('#hud-lives');
    if (G.daily) lives.innerHTML = '';
    else {
      lives.innerHTML = [0, 1, 2].map(i => `<span class="heart ${i < G.lives ? '' : 'lost'}">${HEART}</span>`).join('');
      if (hurt) { lives.classList.remove('hurt'); void lives.offsetWidth; lives.classList.add('hurt'); }
    }
  }
  const HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.3 2.4.7-1.3 2.2-2.4 4.3-2.4 3.7 0 5.8 3.8 4.3 7.2C19.5 16.4 12 21 12 21z"/></svg>';

  function countUp(el, to, dur, from = Number(el.dataset.v || 0)) {
    el.dataset.v = to;
    const t0 = performance.now();
    const step = t => {
      const k = clamp((t - t0) / dur, 0, 1);
      el.textContent = fmt(from + (to - from) * d3.easeCubicOut(k));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function timerLoop() {
    requestAnimationFrame(timerLoop);
    const fill = $('#timer-fill');
    if (!G || G.state !== 'playing' || !G.timer) {
      if (!G || G.state !== 'playing') { fill.style.transform = 'scaleX(0)'; $('#timer-text').textContent = ''; }
      return;
    }
    const left = Math.max(0, G.timer.dur - (performance.now() - G.timer.t0));
    const frac = left / G.timer.dur;
    fill.style.transform = `scaleX(${frac})`;
    fill.classList.toggle('warn', frac < 0.3);
    $('#timer-text').textContent = (left / 1000).toFixed(1) + 's';
    const secs = Math.ceil(left / 1000);
    if (secs <= 3 && secs < G.timer.lastTick && secs > 0) { G.timer.lastTick = secs; sfx.tick(); }
    if (left <= 0) G.h.timeout();
  }

  function showFeedback(res, pts) {
    const fb = $('#feedback');
    fb.className = res.ok ? 'good' : 'bad';
    $('#fb-points').textContent = res.ok ? `+${fmt(pts)}` : (G.daily ? 'MISS' : (G.lives <= 0 ? 'GAME OVER' : '−1 LIFE'));
    $('#fb-title').textContent = res.title;
    $('#fb-detail').textContent = res.detail;
    const m = mult();
    $('#fb-extra').textContent = res.ok && m > 1 ? `Streak ${G.streak} · ×${m} multiplier` : '';
    $('#next-btn').innerHTML = G.over ? 'See results <kbd>Space</kbd>' : 'Next <kbd>Space</kbd>';
    fb.classList.remove('hidden');
  }

  let toastTimer;
  function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, 1800);
  }

  function shake() {
    const b = document.body;
    b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake');
  }

  async function countdown() {
    const el = $('#countdown');
    for (const t of ['3', '2', '1', 'GO']) {
      if (!G || G.state !== 'countdown') return;
      el.textContent = t;
      el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
      (t === 'GO' ? sfx.go : sfx.count)();
      await sleep(t === 'GO' ? 450 : 620);
    }
    el.classList.remove('show');
  }

  function renderChain(chain, end, par) {
    const items = chain.map((c, i) => `<span class="chip ${i === 0 ? 'chip-start' : c === end ? 'chip-end' : 'chip-path'}">${esc(c.name)}</span>`);
    if (chain[chain.length - 1] !== end) items.push(`<span class="chip chip-end ghost">${esc(end.name)}</span>`);
    const steps = chain.length - 1;
    $('#chain').innerHTML = `<div class="chain-row">${items.join('<span class="chain-sep">›</span>')}</div>
      <div class="chain-meta">Steps <b>${steps}</b> / par ${par} · click an earlier country to backtrack</div>`;
    const row = $('#chain .chain-row');
    row.scrollLeft = row.scrollWidth;
  }

  // ---------- Shape Shift UI ----------
  let sugIdx = -1;

  function showShape(target, rotate) {
    $('#shape-panel').classList.remove('hidden');
    $('#guess-list').innerHTML = '';
    $('#shape-badges').innerHTML = '';
    const input = $('#guess-input');
    input.value = '';
    input.disabled = false;
    renderSuggest();
    drawShape(target, rotate, false);
    setTimeout(() => input.focus(), 50);
  }

  function hideShape() {
    $('#shape-panel').classList.add('hidden');
    $('#guess-input').disabled = true;
    $('#guess-input').blur();
  }

  function drawShape(target, rotate, context) {
    const cv = $('#shape-canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const proj = d3.geoAzimuthalEqualArea()
      .rotate([-target.focus[0], -target.focus[1]]).angle(rotate).clipAngle(75)
      .fitExtent([[26, 26], [w - 26, h - 26]], target.shape);
    const path = d3.geoPath(proj, ctx);
    if (context) {
      ctx.beginPath();
      for (const f of W.features) {
        if (f.canon === target || d3.geoDistance(f.focus, target.focus) > 0.75) continue;
        path(f);
      }
      ctx.fillStyle = 'rgba(120,170,230,0.13)'; ctx.fill();
      ctx.strokeStyle = 'rgba(150,200,255,0.4)'; ctx.lineWidth = 0.8; ctx.stroke();
    }
    ctx.beginPath(); path(target.shape);
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#7cf3ff'); g.addColorStop(1, '#3a7bff');
    ctx.shadowColor = 'rgba(94,230,255,0.75)'; ctx.shadowBlur = 22;
    ctx.fillStyle = g; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#e6fbff'; ctx.lineWidth = 1.2; ctx.stroke();
  }

  function addGuessRow(f, target) {
    const d = kmBetween(f.focus, target.focus);
    const row = document.createElement('div');
    row.className = 'guess-row';
    row.innerHTML = `<span class="g-name">${esc(f.name)}</span><span class="g-dist">${fmt(d)} km</span><span class="g-dir">${arrowFor(bearing(f.focus, target.focus))}</span>`;
    $('#guess-list').appendChild(row);
    $('#guess-input').value = '';
    renderSuggest();
  }

  function addBadge(text) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = text;
    $('#shape-badges').appendChild(b);
  }

  function shakeInput(msg) {
    const box = $('#guess-box');
    box.classList.remove('shake-x'); void box.offsetWidth; box.classList.add('shake-x');
    toast(msg);
  }

  function suggestions(q) {
    const n = norm(q);
    if (!n) return [];
    const starts = [], has = [];
    for (const name of GUESS_NAMES) {
      const k = norm(name);
      if (k.startsWith(n)) starts.push(name);
      else if (k.includes(n)) has.push(name);
    }
    const aliasHit = Object.keys(ALIASES).filter(a => norm(a) === n).map(a => ALIASES[a]);
    return [...new Set([...aliasHit, ...starts, ...has])].slice(0, 6);
  }

  function renderSuggest() {
    const list = suggestions($('#guess-input').value);
    sugIdx = list.length ? 0 : -1;
    $('#suggest').innerHTML = list.map((n, i) => `<li class="${i === sugIdx ? 'on' : ''}" data-name="${esc(n)}">${esc(n)}</li>`).join('');
  }

  function submitGuess(name) {
    if (!G || G.state !== 'playing' || !G.h.submit) return;
    G.h.submit(name);
  }

  // ---------- lifetime stats ----------
  const STATS_KEY = 'meridian.stats';
  const freshStats = () => ({
    games: {}, rounds: {}, wins: {}, points: 0, bestStreak: 0, found: {}, misses: {},
    pins: 0, pinKm: 0, bullseyes: 0, closest: null, perfectRoutes: 0, firstGuess: 0, fastest: null,
    since: Date.now(),
  });
  let STATS = Object.assign(freshStats(), lsGet(STATS_KEY, {}));
  const saveStats = () => lsSet(STATS_KEY, STATS);
  const inc = (obj, k, n = 1) => { obj[k] = (obj[k] || 0) + n; };
  const sum = obj => Object.values(obj).reduce((a, b) => a + b, 0);

  function recordRound(type, res, secs) {
    const s = res.stat || {};
    inc(STATS.rounds, type);
    if (res.ok) inc(STATS.wins, type);
    if (s.found) STATS.found[s.found] = true;
    if (s.miss) inc(STATS.misses, s.miss);
    if (type === 'hunt' && res.ok && (!STATS.fastest || secs < STATS.fastest.secs)) STATS.fastest = { secs, name: s.found };
    if (s.km != null) {
      STATS.pins++;
      STATS.pinKm += s.km;
      if (s.km < 30) STATS.bullseyes++;
      if (!STATS.closest || s.km < STATS.closest.km) STATS.closest = { km: s.km, city: s.city };
    }
    if (s.perfect) STATS.perfectRoutes++;
    if (s.first) STATS.firstGuess++;
    STATS.bestStreak = Math.max(STATS.bestStreak, G.streak);
    saveStats();
  }

  function recordGame() {
    inc(STATS.games, G.mode);
    STATS.points += G.score;
    saveStats();
  }

  function saveDailyProgress(done) {
    lsSet('meridian.daily.' + todayKey(), { score: G.score, grades: G.grades, done });
    const log = lsGet('meridian.dailyLog', {});
    log[dailyNumber()] = { score: G.score, hits: G.hits, done };
    lsSet('meridian.dailyLog', log);
  }

  function dailyStreaks() {
    const log = lsGet('meridian.dailyLog', {});
    const today = dailyNumber();
    let current = 0;
    for (let d = log[today] ? today : today - 1; log[d]; d--) current++;
    let max = 0, run = 0, prev = null;
    for (const d of Object.keys(log).map(Number).sort((a, b) => a - b)) {
      run = prev === d - 1 ? run + 1 : 1;
      max = Math.max(max, run);
      prev = d;
    }
    return { current, max, log };
  }

  function tile(v, k, accent = '') {
    return `<div class="stat ${accent}"><div class="stat-v">${v}</div><div class="stat-k">${k}</div></div>`;
  }

  function renderStats() {
    const rounds = sum(STATS.rounds), wins = sum(STATS.wins), games = sum(STATS.games);
    const body = $('#stats-body');
    if (!rounds) {
      body.innerHTML = '<p class="stats-empty">No rounds yet. Play anything and your record starts here.</p>';
      $('#stats-since').textContent = '';
      return;
    }
    const acc = Math.round(100 * wins / rounds);

    // atlas
    const total = POOL.hunt.length;
    const found = POOL.hunt.filter(f => STATS.found[f.name]).length;
    const atlasPct = Math.round(100 * found / total);

    // modes
    const modeRows = Object.entries(MODES).filter(([k]) => k !== 'daily').map(([k, m]) => {
      const r = STATS.rounds[k] || 0, w = STATS.wins[k] || 0, pct = r ? Math.round(100 * w / r) : 0;
      return `<div class="mrow">
        <span class="mrow-name">${m.name}</span>
        <span class="mrow-best">${lsGet('meridian.best.' + k, 0) ? fmt(lsGet('meridian.best.' + k, 0)) : '–'}</span>
        <span class="mrow-bar" title="${w} of ${r} rounds won"><i style="width:${pct}%"></i></span>
        <span class="mrow-pct">${r ? pct + '%' : '–'}</span>
      </div>`;
    }).join('');

    // daily history: last 14 days, official runs only
    const { current, max, log } = dailyStreaks();
    const played = Object.keys(log).length;
    const today = dailyNumber();
    const days = [];
    for (let d = today - 13; d <= today; d++) days.push(d);
    const scores = Object.values(log).map(x => x.score);
    const top = Math.max(1, ...scores);
    const bars = days.map(d => {
      if (d < 1) return '<div class="dcol pre"></div>';
      const e = log[d];
      const h = e ? Math.max(4, Math.round(100 * e.score / top)) : 0;
      const tip = e ? `#${d} · ${fmt(e.score)} pts · ${e.hits}/${DAILY_SEQ.length}${e.done ? '' : ' (unfinished)'}` : `#${d} · not played`;
      return `<div class="dcol${d === today ? ' today' : ''}" data-tip="${tip}">
        ${e ? `<i class="dbar" style="height:${h}%"></i>` : '<i class="dnone"></i>'}
      </div>`;
    }).join('');
    const dayLabels = days.map(d => `<span>${d === today ? 'Today' : d >= 1 && (today - d) % 3 === 0 ? '#' + d : ''}</span>`).join('');

    // highlights
    const hl = [
      STATS.fastest ? [`${STATS.fastest.secs.toFixed(1)}s`, `Fastest find · ${esc(STATS.fastest.name)}`] : null,
      STATS.closest ? [`${fmt(STATS.closest.km)} km`, `Closest pin · ${esc(STATS.closest.city)}`] : null,
      STATS.pins ? [`${fmt(STATS.pinKm / STATS.pins)} km`, 'Average pin miss'] : null,
      [fmt(STATS.bullseyes), 'Bullseyes (&lt;30 km)'],
      [fmt(STATS.perfectRoutes), 'Perfect border routes'],
      [fmt(STATS.firstGuess), 'First-guess shapes'],
    ].filter(Boolean).map(([v, k]) => tile(v, k)).join('');

    const nemesis = Object.entries(STATS.misses).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const worst = nemesis.length ? nemesis[0][1] : 1;
    const nemesisHtml = nemesis.length
      ? nemesis.map(([n, c]) => `<div class="nrow"><span>${esc(n)}</span><span class="nbar"><i style="width:${Math.round(100 * c / worst)}%"></i></span><span class="ncount">${c}×</span></div>`).join('')
      : '<p class="stats-muted">Nothing has beaten you yet.</p>';

    body.innerHTML = `
      <div class="stats-tiles">
        ${tile(fmt(games), 'Games')}${tile(fmt(rounds), 'Rounds')}${tile(acc + '%', 'Accuracy')}
        ${tile(fmt(STATS.points), 'Total points')}${tile(fmt(STATS.bestStreak), 'Best streak')}
      </div>

      <h3>Atlas</h3>
      <div class="atlas">
        <div class="atlas-top"><span><b>${found}</b> of ${total} countries found</span><span class="atlas-pct">${atlasPct}%</span></div>
        <div class="atlas-bar"><i style="width:${atlasPct}%"></i></div>
        <p class="stats-muted">Countries you’ve found in Country Hunt or named in Shape Shift.</p>
      </div>

      <h3>Modes</h3>
      <div class="mtable">
        <div class="mrow mhead"><span>Mode</span><span>Best</span><span>Rounds won</span><span></span></div>
        ${modeRows}
      </div>

      <h3>Daily Gauntlet</h3>
      <div class="stats-tiles four">
        ${tile(fmt(played), 'Days played')}${tile(fmt(current), 'Current streak', current > 1 ? 'hot' : '')}
        ${tile(fmt(max), 'Longest streak')}${tile(fmt(lsGet('meridian.best.daily', 0)), 'Best score')}
      </div>
      <div class="dchart" aria-label="Official daily scores, last 14 days">
        <div class="dbars">${bars}</div>
        <div class="dlabels">${dayLabels}</div>
      </div>

      <h3>Highlights</h3>
      <div class="stats-tiles three">${hl}</div>

      <h3>Nemesis countries</h3>
      <div class="nemesis">${nemesisHtml}</div>
    `;
    $('#stats-since').textContent = 'Tracking since ' + new Date(STATS.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function showStats() {
    renderStats();
    $('#stats').classList.remove('hidden');
  }

  function hideStats() {
    $('#stats').classList.add('hidden');
    $('#chart-tip').classList.remove('show');
  }

  // ---------- menu ----------
  function showMenu() {
    $('#menu').classList.remove('hidden');
    $('#over').classList.add('hidden');
    $('#controls').classList.remove('in-game');
    globe.autoSpin = 5;
    globe.dimTarget = 0;
    renderMenu();
  }

  function renderMenu() {
    const daily = lsGet('meridian.daily.' + todayKey(), null);
    $('#mode-grid').innerHTML = Object.entries(MODES).map(([k, m]) => {
      const best = lsGet('meridian.best.' + k, 0);
      const pips = [1, 2, 3, 4].map(i => `<i class="${i <= m.diff ? 'on' : ''}"></i>`).join('');
      let foot = best ? `Best <b>${fmt(best)}</b>` : 'Not played yet';
      if (k === 'daily') {
        const streak = dailyStreaks().current;
        foot = daily
          ? `Today <b>${fmt(daily.score)}</b>${daily.done ? '' : ' (unfinished)'} · replays are practice`
          : `#${dailyNumber()} · your first run counts`;
        if (streak > 1) foot += ` · ${streak}-day streak`;
      }
      return `<button class="mode-card ${k === 'daily' ? 'daily' : ''}" data-mode="${k}">
        <div class="mc-top"><span class="mc-icon">${m.icon}</span><span class="pips" title="Difficulty">${pips}</span></div>
        <div class="mc-name">${m.name}</div>
        <div class="mc-desc">${m.desc}</div>
        <div class="mc-foot">${foot}</div>
      </button>`;
    }).join('');
  }

  function shareDaily() {
    const rows = [];
    const rec = lsGet('meridian.daily.' + todayKey(), null) || { score: G.score, grades: G.grades };
    const cells = rec.grades.map(g => ({ g: '🟩', y: '🟨', r: '🟥' }[g]));
    for (let i = 0; i < cells.length; i += 5) rows.push(cells.slice(i, i + 5).join(''));
    const text = `MERIDIAN Daily #${dailyNumber()} · ${fmt(rec.score)} pts\n${rows.join('\n')}\n${location.href.split('#')[0]}`;
    const done = () => toast('Copied to clipboard', 'good');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => window.prompt('Copy your result:', text));
    else window.prompt('Copy your result:', text);
  }

  function drawStars() {
    const c = $('#stars'), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = innerWidth, h = innerHeight;
    c.width = w * dpr; c.height = h * dpr;
    c.style.width = w + 'px'; c.style.height = h + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rnd = mulberry32(42);
    const n = Math.round(w * h / 2600);
    for (let i = 0; i < n; i++) {
      const r = rnd() < 0.92 ? rnd() * 0.9 + 0.2 : rnd() * 1.4 + 0.8;
      ctx.globalAlpha = 0.25 + rnd() * 0.7;
      ctx.fillStyle = rnd() < 0.15 ? '#ffd9a8' : rnd() < 0.3 ? '#a8d4ff' : '#ffffff';
      ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------- wiring ----------
  function wire() {
    $('#mode-grid').addEventListener('click', e => {
      const card = e.target.closest('.mode-card');
      if (card) startGame(card.dataset.mode);
    });
    $('#again-btn').addEventListener('click', () => startGame(G.mode));
    $('#menu-btn').addEventListener('click', quit);
    $('#share-btn').addEventListener('click', shareDaily);
    $('#stats-btn').addEventListener('click', showStats);
    $('#over-stats-btn').addEventListener('click', showStats);
    $('#stats-close').addEventListener('click', hideStats);
    $('#stats').addEventListener('click', e => { if (e.target.id === 'stats') hideStats(); });
    $('#stats-reset').addEventListener('click', () => {
      if (!window.confirm('Reset all stats and best scores? Today\u2019s daily result stays locked.')) return;
      STATS = freshStats();
      saveStats();
      Object.keys(MODES).forEach(k => lsSet('meridian.best.' + k, 0));
      lsSet('meridian.dailyLog', {});
      renderStats();
      renderMenu();
    });
    // One tooltip for the daily chart; the whole column is the hit target.
    const tip = $('#chart-tip');
    $('#stats-body').addEventListener('pointerover', e => {
      const col = e.target.closest('.dcol');
      if (!col) { tip.classList.remove('show'); return; }
      tip.textContent = col.dataset.tip;
      const r = col.getBoundingClientRect();
      tip.style.left = (r.left + r.width / 2) + 'px';
      tip.style.top = (r.top - 8) + 'px';
      tip.classList.add('show');
    });
    $('#stats-body').addEventListener('pointerleave', () => tip.classList.remove('show'));
    $('#next-btn').addEventListener('click', next);
    $('#quit-btn').addEventListener('click', quit);
    $('#zin').addEventListener('click', () => { globe.anim = null; globe.setZoom(globe.zoom * 1.5); });
    $('#zout').addEventListener('click', () => { globe.anim = null; globe.setZoom(globe.zoom / 1.5); });
    $('#zreset').addEventListener('click', () => globe.flyTo(globe.center(), 1, 700));
    const muteBtn = $('#mute');
    const syncMute = () => muteBtn.classList.toggle('muted', sfx.isMuted());
    muteBtn.addEventListener('click', () => { sfx.unlock(); sfx.toggle(); syncMute(); });
    syncMute();

    globe.onClick = (ll, xy) => {
      if (!G || G.state !== 'playing' || !G.h.click) return;
      const f = globe.featureAt(ll);
      G.h.click(ll, f ? f.canon : null, xy);
    };
    globe.mapHover = f => f.canon || null;
    globe.onInteract = () => {
      // Exploring the reveal pauses auto-advance.
      if (G && G.state === 'reveal') clearTimeout(G.auto);
    };

    const input = $('#guess-input');
    input.addEventListener('input', renderSuggest);
    input.addEventListener('keydown', e => {
      const items = [...document.querySelectorAll('#suggest li')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.classList.toggle('on', i === sugIdx));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = items[sugIdx] ? items[sugIdx].dataset.name : input.value;
        if (pick.trim()) submitGuess(pick);
      } else if (e.key === 'Escape') {
        input.value = ''; renderSuggest();
      }
    });
    $('#suggest').addEventListener('mousedown', e => {
      const li = e.target.closest('li');
      if (li) { e.preventDefault(); submitGuess(li.dataset.name); }
    });

    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if ((e.key === ' ' || e.key === 'Enter') && G && G.state === 'reveal') { e.preventDefault(); next(); }
      else if (e.key === '+' || e.key === '=') globe.setZoom(globe.zoom * 1.4);
      else if (e.key === '-' || e.key === '_') globe.setZoom(globe.zoom / 1.4);
      else if (e.key === 'Escape' && !$('#stats').classList.contains('hidden')) hideStats();
      else if (e.key === 'Escape' && G && G.state !== 'over') quit();
    });
    window.addEventListener('resize', drawStars);
    // Switching tabs shouldn't burn the clock.
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hiddenAt = performance.now();
      else if (hiddenAt && G && G.timer) G.timer.t0 += performance.now() - hiddenAt;
    });
  }

  async function boot() {
    drawStars();
    try {
      const [t50, t110] = await Promise.all([
        fetch('data/countries-50m.json').then(r => r.json()),
        fetch('data/countries-110m.json').then(r => r.json()),
      ]);
      W = buildWorld(t50, t110);
    } catch (err) {
      $('#loading').innerHTML = '<p>Couldn’t load the map data.<br><small>Serve this folder over http (GitHub Pages or a local server), not file://</small></p>';
      console.error(err);
      return;
    }
    try {
      globe = new Globe($('#globe'), W);
      globe.autoSpin = 5;
      globe.hoverEnabled = false;
      buildPools();
      wire();
      renderMenu();
      timerLoop();
    } catch (err) {
      $('#loading').innerHTML = `<p>Something went wrong starting the game.<br><small>${esc(err.message)}</small></p>`;
      console.error(err);
      return;
    }
    $('#loading').classList.add('done');
    setTimeout(() => $('#loading').classList.add('hidden'), 700);
    $('#menu').classList.remove('hidden');
    window.__meridian = { get G() { return G; }, globe, POOL, W };
  }

  boot();
})();
