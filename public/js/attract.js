// Attract mode: the hero screen runs the real shared Snake engine with four CPU
// snakes. No server involved - it is the same code the arcade's rooms run, so what
// you watch is what you play.
import { SnakeArena } from '../shared/snake.js';
import { snakeBotDir } from '../shared/bots.js';
import { makeCanvas, Particles, backdrop } from './canvas.js';

const NAMES = ['VIPER', 'NEON', 'GLITCH', 'BYTE', 'ZAP'];

export function attract(host, opts = {}) {
  const arena = new SnakeArena({});
  const hueBySlot = [188, 312, 62, 132, 268];
  for (let i = 0; i < (opts.snakes || 4); i++) {
    arena.addPlayer(`b${i}`, { name: NAMES[i % NAMES.length], hue: hueBySlot[i % hueBySlot.length], bot: true });
  }
  const view = makeCanvas(host, arena.cfg.W * 16, arena.cfg.H * 16);
  const parts = new Particles(140);
  const CELL = 16;
  let raf = 0;
  let acc = 0;
  let last = performance.now();
  let alive = true;
  const stepMs = 1000 / arena.cfg.TICK_HZ;

  const loop = (now) => {
    if (!alive) return;
    const dt = Math.min(0.12, (now - last) / 1000);
    last = now;
    acc += now - last + dt * 1000;
    // fixed-step the rules, then render
    let guard = 0;
    while (acc >= stepMs && guard++ < 4) {
      acc -= stepMs;
      for (const p of arena.players.values()) {
        if (p.bot) arena.steer(p.id, snakeBotDir(arena, p));
      }
      const ev = arena.step();
      for (const e of ev) {
        if (e.k === 'eat') parts.burst((e.x + 0.5) * CELL, (e.y + 0.5) * CELL, { count: 6, hue: e.golden ? 52 : 150, speed: 90, life: 0.4, size: 2.4 });
        if (e.k === 'kill' || e.k === 'crash') {
          const p = arena.players.get(e.victim || e.id);
          if (p?.body?.[0]) parts.burst((p.body[0].x + 0.5) * CELL, (p.body[0].y + 0.5) * CELL, { count: 18, hue: p.hue, speed: 180, life: 0.5, size: 3 });
        }
      }
      if (arena.over) {
        arena.over = false;
        arena.winnerId = null;
        arena.tick = 0;
      }
    }
    render(now);
    raf = requestAnimationFrame(loop);
  };

  function render(now) {
    const { ctx: c } = view;
    backdrop(c, arena.cfg.W * CELL, arena.cfg.H * CELL, now / 1000, { hue: 195 });
    for (const f of arena.food) {
      c.fillStyle = f.golden ? 'hsl(52 100% 66%)' : 'hsl(150 95% 58%)';
      c.shadowColor = c.fillStyle;
      c.shadowBlur = 12;
      c.beginPath();
      c.arc((f.x + 0.5) * CELL, (f.y + 0.5) * CELL, f.golden ? 4.4 : 3, 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;
    }
    for (const p of arena.players.values()) {
      if (!p.alive) continue;
      c.lineJoin = 'round';
      c.lineCap = 'round';
      c.strokeStyle = `hsl(${p.hue} 96% 62%)`;
      c.shadowColor = c.strokeStyle;
      c.shadowBlur = 16;
      c.lineWidth = CELL * 0.8;
      c.beginPath();
      p.body.forEach((seg, i) => {
        const x = (seg.x + 0.5) * CELL;
        const y = (seg.y + 0.5) * CELL;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      });
      c.stroke();
      c.shadowBlur = 0;
      c.fillStyle = 'hsl(0 0% 100% / .9)';
      c.beginPath();
      c.arc((p.body[0].x + 0.5) * CELL, (p.body[0].y + 0.5) * CELL, 2, 0, Math.PI * 2);
      c.fill();
    }
    parts.step(1 / 60, c);
  }

  raf = requestAnimationFrame(loop);
  return {
    stop() {
      alive = false;
      cancelAnimationFrame(raf);
      view.destroy();
    },
  };
}
