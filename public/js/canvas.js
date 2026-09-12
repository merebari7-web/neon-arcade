// Canvas helpers: crisp DPR scaling, particles, floating score text.
export function makeCanvas(host, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  host.prepend(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  const view = { w, h, scale: 1, dpr: 1 };
  const fit = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = host.clientWidth || w;
    const cssH = (cssW * h) / w;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    view.dpr = dpr;
    view.scale = (cssW * dpr) / w;
    ctx.setTransform(view.scale, 0, 0, view.scale, 0, 0);
    ctx.imageSmoothingEnabled = true;
  };
  fit();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  ro?.observe(host);
  window.addEventListener('resize', fit);
  return {
    canvas,
    ctx,
    view,
    fit,
    // translate a pointer event into field coordinates
    point(ev) {
      const r = canvas.getBoundingClientRect();
      const t = ev.touches?.[0] || ev;
      return { x: ((t.clientX - r.left) / r.width) * w, y: ((t.clientY - r.top) / r.height) * h };
    },
    destroy() {
      ro?.disconnect();
      window.removeEventListener('resize', fit);
      canvas.remove();
    },
  };
}

export class Particles {
  constructor(max = 260) {
    this.items = [];
    this.max = max;
  }
  burst(x, y, { count = 14, hue = 190, speed = 190, life = 0.5, size = 3, gravity = 0, spread = Math.PI * 2, dir = 0 } = {}) {
    for (let i = 0; i < count; i++) {
      const a = dir + (Math.random() - 0.5) * spread;
      const s = speed * (0.35 + Math.random() * 0.9);
      this.items.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: life * (0.6 + Math.random() * 0.8),
        age: 0,
        size: size * (0.6 + Math.random()),
        hue: hue + (Math.random() - 0.5) * 30,
        gravity,
      });
    }
    while (this.items.length > this.max) this.items.shift();
  }
  ring(x, y, opts = {}) {
    this.items.push({ ring: true, x, y, age: 0, life: opts.life || 0.4, hue: opts.hue ?? 190, size: opts.size || 46 });
  }
  step(dt, ctx) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.items.splice(i, 1);
        continue;
      }
      const k = 1 - p.age / p.life;
      if (p.ring) {
        ctx.beginPath();
        ctx.strokeStyle = `hsl(${p.hue} 95% 65% / ${k * 0.7})`;
        ctx.lineWidth = 2 + k * 2;
        ctx.arc(p.x, p.y, p.size * (1 - k) + 6, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.gravity * dt;
      p.vx *= 0.985;
      p.vy *= 0.985;
      ctx.fillStyle = `hsl(${p.hue} 96% ${55 + k * 22}% / ${k})`;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size * (0.4 + k), p.size * (0.4 + k));
    }
  }
  clear() {
    this.items.length = 0;
  }
}

export class FloatText {
  constructor() {
    this.items = [];
  }
  add(x, y, text, hue = 52) {
    this.items.push({ x, y, text, hue, age: 0, life: 0.9 });
    if (this.items.length > 26) this.items.shift();
  }
  step(dt, ctx) {
    ctx.textAlign = 'center';
    ctx.font = '700 15px ui-monospace, Menlo, Consolas, monospace';
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.items.splice(i, 1);
        continue;
      }
      const k = 1 - p.age / p.life;
      ctx.fillStyle = `hsl(${p.hue} 100% 70% / ${k})`;
      ctx.shadowColor = `hsl(${p.hue} 100% 60% / ${k})`;
      ctx.shadowBlur = 14;
      ctx.fillText(p.text, p.x, p.y - (1 - k) * 26);
      ctx.shadowBlur = 0;
    }
  }
  clear() {
    this.items.length = 0;
  }
}

export function backdrop(ctx, w, h, t, { hue = 195 } = {}) {
  ctx.fillStyle = '#04020a';
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createRadialGradient(w / 2, h * 0.42, 40, w / 2, h * 0.5, Math.max(w, h) * 0.78);
  g.addColorStop(0, `hsl(${hue} 90% 55% / 0.09)`);
  g.addColorStop(1, 'transparent');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(140,170,255,0.055)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = 40;
  for (let x = 0; x <= w; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = 0; y <= h; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  // slow scan sweep
  const sweep = ((t * 0.06) % 1) * (h + 200) - 100;
  const sg = ctx.createLinearGradient(0, sweep - 70, 0, sweep + 70);
  sg.addColorStop(0, 'transparent');
  sg.addColorStop(0.5, 'rgba(34,230,255,0.05)');
  sg.addColorStop(1, 'transparent');
  ctx.fillStyle = sg;
  ctx.fillRect(0, sweep - 70, w, 140);
}

export function neonLine(ctx, draw, { hue, width = 2, blur = 18, alpha = 1, style } = {}) {
  ctx.save();
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = style || `hsl(${hue} 96% 64% / ${alpha})`;
  ctx.shadowColor = `hsl(${hue} 96% 60% / ${alpha})`;
  ctx.shadowBlur = blur;
  draw();
  ctx.restore();
}
