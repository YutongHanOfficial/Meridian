'use strict';

const HL_STYLES = {
  good: ['rgba(61,220,151,0.88)', '#c9ffe6'],
  bad: ['rgba(255,77,109,0.88)', '#ffd0d9'],
  path: ['rgba(255,200,87,0.85)', '#fff1c9'],
  start: ['rgba(94,200,255,0.92)', '#d8f3ff'],
  end: ['rgba(255,122,217,0.92)', '#ffe0f6'],
  hint: ['rgba(255,255,255,0.22)', 'rgba(255,255,255,0.7)'],
};

const clampLat = v => Math.max(-85, Math.min(85, v));
const clampNum = (x, a, b) => Math.max(a, Math.min(b, x));

class Globe {
  constructor(canvas, world) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.features = world.features;
    this.proj = d3.geoOrthographic().clipAngle(90).precision(0.5);
    this.path = d3.geoPath(this.proj, this.ctx);
    this.sphere = { type: 'Sphere' };
    this.grat = d3.geoGraticule10();
    this.rot = [-15, -25];
    this.zoom = 1;
    this.minZoom = 0.75;
    this.maxZoom = 40;
    this.hl = new Map();
    this.markers = [];
    this.arcs = [];
    this.rings = [];
    this.bursts = [];
    this.hover = null;
    this.hoverEnabled = true;
    this.mapHover = f => f;
    this.interactive = false;
    this.autoSpin = 0;
    this.dim = 0;
    this.dimTarget = 0;
    this.anim = null;
    this.vel = null;
    this.dirty = true;
    this.onClick = null;
    this.onInteract = null;
    this.night = Globe.nightShape(new Date());
    this.pointers = new Map();
    this._hoverPt = null;
    this._bind();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this._t = performance.now();
    requestAnimationFrame(t => this._frame(t));
  }

  // Approximate day/night terminator for the current moment.
  static nightShape(date) {
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    const day = (date - start) / 864e5;
    const dec = -23.44 * Math.cos((2 * Math.PI / 365) * (day + 10));
    const hours = date.getUTCHours() + date.getUTCMinutes() / 60;
    const lon = (12 - hours) * 15;
    // Stacked translucent caps give the terminator a soft twilight edge.
    return [85, 88, 91, 94].map(r => d3.geoCircle().center([lon + 180, -dec]).radius(r)());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.c.width = Math.round(this.w * dpr);
    this.c.height = Math.round(this.h * dpr);
    this.c.style.width = this.w + 'px';
    this.c.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const narrow = this.w < 700;
    this.base = Math.min(this.w * (narrow ? 0.46 : 0.44), this.h * 0.36);
    this.cy = this.h * (narrow ? 0.56 : 0.55);
    this.dirty = true;
  }

  _apply() {
    this.proj.scale(this.base * this.zoom).translate([this.w / 2, this.cy]).rotate([this.rot[0], this.rot[1], 0]);
  }

  center() { return [-this.rot[0], -this.rot[1]]; }

  isVisible(ll) { return d3.geoDistance(ll, this.center()) < Math.PI / 2 - 0.015; }

  project(ll) {
    this._apply();
    return this.isVisible(ll) ? this.proj(ll) : null;
  }

  invert(x, y) {
    this._apply();
    const dx = x - this.w / 2, dy = y - this.cy, s = this.base * this.zoom;
    if (dx * dx + dy * dy > s * s) return null;
    return this.proj.invert([x, y]);
  }

  featureAt(ll) {
    if (!ll) return null;
    const [lon, lat] = ll;
    for (const f of this.features) {
      const b = f.bounds;
      if (lat < b[0][1] - 0.5 || lat > b[1][1] + 0.5) continue;
      const w = b[0][0], e = b[1][0];
      if (w <= e) { if (lon < w - 0.5 || lon > e + 0.5) continue; }
      else if (lon < w - 0.5 && lon > e + 0.5) continue;
      if (d3.geoContains(f, ll)) return f;
    }
    return null;
  }

  setZoom(z) {
    this.zoom = clampNum(z, this.minZoom, this.maxZoom);
    this.dirty = true;
  }

  // Zoom level that frames something with the given angular radius (degrees).
  zoomFor(deg) {
    const a = Math.min(Math.PI / 2, Math.max(2, deg) * Math.PI / 180);
    return clampNum((0.27 * Math.min(this.w, this.h)) / (this.base * Math.sin(a)), 1, 28);
  }

  flyTo(ll, zoom = this.zoom, dur = 1200) {
    const r0 = [...this.rot];
    const d = (((-ll[0] - r0[0]) % 360) + 540) % 360 - 180;
    const r1 = [r0[0] + d, clampLat(-ll[1])];
    this.anim = {
      r0, r1, z0: this.zoom, z1: clampNum(zoom, this.minZoom, this.maxZoom),
      t0: performance.now(), dur, ang: d3.geoDistance(this.center(), ll),
    };
    this.vel = null;
  }

  flyToFeature(f, dur) { this.flyTo(f.focus, this.zoomFor(f.radius * 1.15), dur); }

  setHL(f, style) {
    for (const i of f.group || [f.idx]) this.hl.set(i, style);
    this.dirty = true;
  }

  clearHL(f) {
    for (const i of f.group || [f.idx]) this.hl.delete(i);
    this.dirty = true;
  }

  reset() {
    this.hl.clear();
    this.markers = [];
    this.arcs = [];
    this.rings = [];
    this.dirty = true;
  }

  addMarker(ll, o = {}) {
    this.markers.push({ ll, color: o.color || '#fff', label: o.label, pulse: !!o.pulse, size: o.size || 5, born: performance.now() });
  }

  addArc(a, b, color, born = performance.now()) {
    this.arcs.push({ a, b, color, born, dur: 700 });
  }

  addRing(center, km, color) {
    this.rings.push({ geo: d3.geoCircle().center(center).radius(km / 111.195).precision(2)(), color });
    this.dirty = true;
  }

  burst([x, y], color, n = 28) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 4.5;
      this.bursts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5, life: 1, color, r: 1 + Math.random() * 2.4 });
    }
  }

  _bind() {
    const c = this.c;
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.anim = null;
      this.vel = null;
      if (this.pointers.size === 1) {
        this.down = { x: e.clientX, y: e.clientY, moved: 0, multi: false };
        this.track = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: this.zoom };
        if (this.down) this.down.multi = true;
      }
      c.classList.add('dragging');
      if (this.onInteract) this.onInteract();
    });
    c.addEventListener('pointermove', e => {
      const p = this.pointers.get(e.pointerId);
      if (!p) { this._hoverPt = [e.clientX, e.clientY]; return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (this.pointers.size === 1) {
        const k = 180 / (Math.PI * this.base * this.zoom);
        this.rot[0] += dx * k;
        this.rot[1] = clampLat(this.rot[1] - dy * k);
        if (this.down) this.down.moved += Math.abs(dx) + Math.abs(dy);
        this.track.push({ x: e.clientX, y: e.clientY, t: performance.now() });
        if (this.track.length > 6) this.track.shift();
      } else if (this.pointers.size === 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()];
        this.setZoom(this.pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.d);
      }
      this.hover = null;
      this.dirty = true;
    });
    const up = e => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size) return;
      c.classList.remove('dragging');
      const d = this.down;
      this.down = null;
      this.pinch = null;
      if (!d || d.multi) return;
      if (d.moved < 7 && e.type === 'pointerup') {
        const ll = this.invert(e.clientX, e.clientY);
        if (ll && this.interactive && this.onClick) this.onClick(ll, [e.clientX, e.clientY]);
        this._hoverPt = [e.clientX, e.clientY];
        return;
      }
      const tr = this.track;
      if (tr && tr.length >= 2) {
        const a = tr[0], b = tr[tr.length - 1], dt = b.t - a.t;
        if (dt > 0 && performance.now() - b.t < 80) {
          const k = 180 / (Math.PI * this.base * this.zoom);
          this.vel = { x: (b.x - a.x) / dt * k, y: -(b.y - a.y) / dt * k };
        }
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => {
      this._hoverPt = null;
      if (this.hover) { this.hover = null; this.dirty = true; }
    });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.anim = null;
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
  }

  _frame(t) {
    const dt = Math.min(64, t - this._t);
    this._t = t;
    let active = false;
    if (this.anim) {
      const a = this.anim;
      const k = clampNum((t - a.t0) / a.dur, 0, 1), e = d3.easeCubicInOut(k);
      this.rot = [a.r0[0] + (a.r1[0] - a.r0[0]) * e, a.r0[1] + (a.r1[1] - a.r0[1]) * e];
      const zl = Math.exp(Math.log(a.z0) + (Math.log(a.z1) - Math.log(a.z0)) * e);
      const dip = 1 - Math.min(0.45, a.ang / Math.PI * 0.8) * Math.sin(Math.PI * e) * (Math.max(a.z0, a.z1) > 1.6 ? 1 : 0.35);
      this.zoom = Math.max(this.minZoom, zl * dip);
      if (k >= 1) this.anim = null;
      active = true;
    } else if (this.vel) {
      this.rot[0] += this.vel.x * dt;
      this.rot[1] = clampLat(this.rot[1] + this.vel.y * dt);
      const f = Math.pow(0.93, dt / 16);
      this.vel.x *= f; this.vel.y *= f;
      if (Math.abs(this.vel.x) + Math.abs(this.vel.y) < 0.0004) this.vel = null;
      active = true;
    } else if (this.autoSpin && this.pointers.size === 0) {
      this.rot[0] += this.autoSpin * dt / 1000;
      active = true;
    }
    if (Math.abs(this.dim - this.dimTarget) > 0.004) {
      this.dim += (this.dimTarget - this.dim) * Math.min(1, dt / 160);
      active = true;
    } else this.dim = this.dimTarget;

    if (this._hoverPt && this.hoverEnabled && this.pointers.size === 0 && !this.anim) {
      const f = this.featureAt(this.invert(this._hoverPt[0], this._hoverPt[1]));
      this._hoverPt = null;
      const h = f ? this.mapHover(f) : null;
      if (h !== this.hover) { this.hover = h; this.dirty = true; }
    }
    if (this.markers.length || this.arcs.length || this.bursts.length) active = true;
    if (active || this.dirty) {
      this.draw(t, dt);
      this.dirty = false;
    }
    requestAnimationFrame(tt => this._frame(tt));
  }

  draw(t, dt) {
    const { ctx, path } = this;
    this._apply();
    const w = this.w, h = this.h, cx = w / 2, cy = this.cy, s = this.base * this.zoom;
    ctx.clearRect(0, 0, w, h);

    // atmosphere
    const R1 = s * 1.3;
    let g = ctx.createRadialGradient(cx, cy, s * 0.97, cx, cy, R1);
    g.addColorStop(0, 'rgba(94,230,255,0.34)');
    g.addColorStop(0.22, 'rgba(70,150,255,0.13)');
    g.addColorStop(1, 'rgba(40,80,200,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R1, 0, Math.PI * 2); ctx.fill();

    // ocean
    g = ctx.createRadialGradient(cx - s * 0.3, cy - s * 0.35, s * 0.05, cx, cy, s * 1.02);
    g.addColorStop(0, '#12497e'); g.addColorStop(0.55, '#0a2b54'); g.addColorStop(1, '#041331');
    ctx.beginPath(); path(this.sphere); ctx.fillStyle = g; ctx.fill();

    ctx.beginPath(); path(this.grat);
    ctx.strokeStyle = 'rgba(150,200,255,0.08)'; ctx.lineWidth = 0.7; ctx.stroke();

    // land (low-res when zoomed out keeps dragging smooth)
    const L = this.zoom > 2.4 ? this.world.hi : this.world.lo;
    ctx.beginPath(); path(L.land);
    ctx.fillStyle = '#1f4d6a'; ctx.fill();
    ctx.strokeStyle = 'rgba(110,225,255,0.55)'; ctx.lineWidth = 0.8; ctx.stroke();

    if (this.hover && this.hoverEnabled && !this.hl.has(this.hover.idx)) {
      ctx.beginPath();
      for (const i of this.hover.group || [this.hover.idx]) path(this.features[i]);
      ctx.fillStyle = 'rgba(160,230,255,0.17)'; ctx.fill();
    }
    for (const [i, st] of this.hl) {
      const [fill, stroke] = HL_STYLES[st];
      ctx.beginPath(); path(this.features[i]);
      ctx.fillStyle = fill; ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.beginPath(); path(L.borders);
    ctx.strokeStyle = 'rgba(170,215,255,0.32)'; ctx.lineWidth = 0.6; ctx.stroke();

    ctx.fillStyle = 'rgba(2,6,22,0.075)';
    for (const cap of this.night) { ctx.beginPath(); path(cap); ctx.fill(); }

    for (const r of this.rings) {
      ctx.beginPath(); path(r.geo);
      ctx.globalAlpha = 0.1; ctx.fillStyle = r.color; ctx.fill(); ctx.globalAlpha = 1;
      ctx.setLineDash([5, 4]); ctx.strokeStyle = r.color; ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([]);
    }

    for (const a of this.arcs) {
      const k = d3.easeCubicOut(clampNum((t - a.born) / a.dur, 0, 1));
      if (k <= 0) continue;
      const ip = d3.geoInterpolate(a.a, a.b), n = 48, coords = [];
      for (let i = 0; i <= n; i++) coords.push(ip(k * i / n));
      ctx.beginPath(); path({ type: 'LineString', coordinates: coords });
      ctx.strokeStyle = a.color; ctx.lineWidth = 2.2;
      ctx.shadowColor = a.color; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;
    }

    if (this.dim > 0.01) {
      ctx.beginPath(); path(this.sphere);
      ctx.fillStyle = `rgba(3,8,20,${this.dim})`; ctx.fill();
    }

    // specular + limb darkening + rim
    g = ctx.createRadialGradient(cx - s * 0.45, cy - s * 0.5, 0, cx - s * 0.45, cy - s * 0.5, s * 1.25);
    g.addColorStop(0, 'rgba(255,255,255,0.11)'); g.addColorStop(0.5, 'rgba(255,255,255,0.02)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath(); path(this.sphere); ctx.fillStyle = g; ctx.fill();
    g = ctx.createRadialGradient(cx, cy, s * 0.72, cx, cy, s);
    g.addColorStop(0, 'rgba(0,8,25,0)'); g.addColorStop(1, 'rgba(0,8,25,0.5)');
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(120,220,255,0.5)'; ctx.lineWidth = 1.2; ctx.stroke();

    ctx.font = '600 13px "Space Grotesk", system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const m of this.markers) {
      if (!this.isVisible(m.ll)) continue;
      const [x, y] = this.proj(m.ll);
      if (m.pulse) {
        for (let j = 0; j < 2; j++) {
          const ph = (((t - m.born) / 1400) + j * 0.5) % 1;
          ctx.beginPath(); ctx.arc(x, y, 6 + ph * 28, 0, Math.PI * 2);
          ctx.strokeStyle = m.color; ctx.globalAlpha = (1 - ph) * 0.9; ctx.lineWidth = 2; ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      const pop = clampNum((t - m.born) / 260, 0, 1);
      const r = Math.max(0, m.size * d3.easeBackOut(pop));
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = m.color; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#04101f'; ctx.stroke();
      if (m.label) {
        ctx.globalAlpha = pop;
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(2,8,20,0.92)'; ctx.lineJoin = 'round';
        ctx.strokeText(m.label, x, y - 13);
        ctx.fillStyle = '#fff'; ctx.fillText(m.label, x, y - 13);
        ctx.globalAlpha = 1;
      }
    }

    if (this.bursts.length) {
      const k = dt / 16;
      for (const b of this.bursts) {
        b.x += b.vx * k; b.y += b.vy * k; b.vy += 0.12 * k; b.vx *= 0.98; b.life -= dt / 750;
        if (b.life <= 0) continue;
        ctx.globalAlpha = b.life;
        ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      this.bursts = this.bursts.filter(b => b.life > 0);
    }
  }
}
