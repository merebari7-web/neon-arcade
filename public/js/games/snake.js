// Snake Battle cabinet.
import { makeCanvas, Particles, FloatText, backdrop, neonLine } from '../canvas.js';
import { $, el, fmtNum, overlay, clearOverlay, renderRoster, Sfx, isTouch } from '../ui.js';
import { SNAKE } from '../../shared/snake.js';

const CELL = 20;
const W = SNAKE.W * CELL;
const H = SNAKE.H * CELL;

export function mount(ctx = {}) {
  const { arena, session, meta } = ctx;
  const host = makeCanvas(arena, W, H);
  const { canvas, ctx: c } = host;
  const parts = new Particles();
  const floats = new FloatText();
  let prev = null;
  let cur = null;
  let snapAt = performance.now();
  let raf = 0;
  let last = performance.now();
  let alive = true;

  const hud = {
    score: $('#hudScore', arena.parentElement),
    rank: $('#hudRank', arena.parentElement),
    time: $('#hudTime', arena.parentElement),
    roster: $('#roster', arena.parentElement),
  };

  // ---- input ---------------------------------------------------------------
  const KEYS = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    w: 'up',
    s: 'down',
    a: 'left',
    d: 'right',
    W: 'up',
    S: 'down',
    A: 'left',
    D: 'right',
    k: 'up',
    j: 'down',
    h: 'left',
    l: 'right',
  };
  const onKey = (e) => {
    const dir = KEYS[e.key];
    if (!dir) return;
    e.preventDefault();
    steer(dir);
  };
  function steer(dir) {
    session.send({ t: 'input', dir });
    Sfx.play('step', 0.6);
    // nudge our own render so the turn feels instant
    if (cur?.players) {
      const me = cur.players.find((p) => p.id === session.pid || (session.mode === 'solo' && p.id === 'p0'));
      if (me && dir !== opposite(me.d)) me.d = dir;
    }
  }
  window.addEventListener('keydown', onKey);

  let touchStart = null;
  canvas.addEventListener('touchstart', (e) => (touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }), { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return steer('right');
    steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
    touchStart = null;
  });
  const padHost = $('.touch-pad', arena);
  if (padHost) {
    for (const [dir, label] of [['up', '▲'], ['down', '▼'], ['left', '◀'], ['right', '▶']]) {
      const b = el('button', { type: 'button', text: label, 'aria-label': dir });
      b.addEventListener('click', () => steer(dir));
      padHost.append(b);
    }
  }
  if (!isTouch) $('.touch-pad', arena)?.classList.add('hidden');

  // ---- state ---------------------------------------------------------------
  const off = [
    session.on('state', (msg) => {
      prev = cur;
      cur = msg.s;
      snapAt = performance.now();
      if (msg.ev?.length) applyEvents(msg.ev);
      if (cur.over) paintOver();
      else clearOverlay(arena);
      paintHud();
    }),
    session.on('ev', (msg) => applyEvents(msg.ev || [])),
    session.on('joined', (m) => {
      Sfx.play('join');
      if (m.room?.status === 'waiting') waitingOverlay(m.room);
    }),
    session.on('restarted', () => {
      clearOverlay(arena);
      parts.clear();
      floats.clear();
    }),
    session.on('roundOver', () => paintOver()),
  ];

  function applyEvents(events) {
    const players = cur?.players || [];
    for (const ev of events) {
      if (ev.k === 'eat') {
        const p = players.find((q) => q.id === ev.id);
        const hue = p?.h ?? 190;
        parts.burst((ev.x + 0.5) * CELL, (ev.y + 0.5) * CELL, { count: ev.golden ? 22 : 9, hue: ev.golden ? 52 : hue, speed: ev.golden ? 220 : 120, life: 0.45, size: 3 });
        floats.add((ev.x + 0.5) * CELL, (ev.y + 0.3) * CELL, `+${ev.points}`, ev.golden ? 52 : 150);
        Sfx.play(ev.golden ? 'golden' : 'eat');
      } else if (ev.k === 'kill') {
        const dead = players.find((q) => q.id === ev.victim);
        const hue = players.find((q) => q.id === ev.by)?.h ?? 320;
        parts.burst(...bodyCenter(dead), { count: 40, hue, speed: 280, life: 0.75, size: 4 });
        floats.add(...bodyCenter(dead), `+${ev.points} KO`, 52);
        Sfx.play('kill');
      } else if (ev.k === 'crash') {
        const p = players.find((q) => q.id === ev.id);
        parts.burst(...bodyCenter(p), { count: 20, hue: p?.h ?? 190, speed: 150, life: 0.5, size: 3 });
        Sfx.play('crash');
      } else if (ev.k === 'respawn') {
        const p = players.find((q) => q.id === ev.id);
        if (p) parts.ring(...bodyCenter(p), { hue: p.h, life: 0.5, size: 60 });
      }
    }
  }
  function bodyCenter(p) {
    if (!p?.b?.length) return [W / 2, H / 2];
    const tail = p.b[Math.min(3, p.b.length - 1)];
    return [(tail[0] + 0.5) * CELL, (tail[1] + 0.5) * CELL];
  }

  function paintHud() {
    if (!cur) return;
    const me = cur.players.find((p) => p.id === (session.pid || 'p0'));
    if (hud.score) hud.score.textContent = fmtNum(me?.s || 0);
    const ranked = [...cur.players].sort((a, b) => b.s - a.s);
    const rank = me ? ranked.indexOf(me) + 1 : 0;
    if (hud.rank) hud.rank.textContent = rank ? `${rank}/${cur.players.length}` : '-';
    if (hud.time) hud.time.textContent = `${cur.timeLeft}s`;
    renderRoster(
      hud.roster,
      cur.players.map((p) => ({ id: p.id, name: p.n, hue: p.h, score: p.s, alive: p.a, respawn: p.r, bot: p.bot })),
      { pid: session.pid }
    );
  }

  function waitingOverlay(room) {
    overlay(arena, {
      title: room.count >= 2 ? 'Round starting' : 'Waiting for rivals',
      sub: room.solo
        ? 'Solo run against the CPU snakes.'
        : `Share code ${room.id} - or hit Quick Play and we will drop you into any open arena.`,
      actions: [
        { label: 'Add CPU', cls: 'ghost', fn: () => session.send({ t: 'addCpu' }) },
        { label: 'Start now', cls: 'gr', fn: () => session.send({ t: 'addCpu' }) },
      ],
    });
  }

  function paintOver() {
    if (arena.querySelector('.overlay.over')) return;
    const rows = (cur?.players || [])
      .slice()
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((p, i) => ({ label: `#${i + 1} ${p.n}${p.bot ? ' · CPU' : ''}`, value: fmtNum(p.s) }));
    const me = (cur?.players || []).find((p) => p.id === (session.pid || 'p0'));
    const won = cur?.winner && cur.winner === me?.id;
    const box = overlay(arena, {
      title: won ? 'You take the arena' : cur?.winner ? `${(cur.players.find((p) => p.id === cur.winner) || {}).n || '?'} wins` : 'Round over',
      kind: won ? 'win' : 'lose',
      sub: 'Next round starts on its own - or jump straight back in.',
      rows,
      actions: [{ label: 'Play again now', cls: 'gr', fn: () => session.send({ t: 'restart' }) }],
    });
    box?.classList.add('over');
    Sfx.play(won ? 'win' : 'lose');
    if (session.mode === 'solo') session.results(me?.s || 0, 'solo');
  }

  // ---- render --------------------------------------------------------------
  function lerpBody(from, to, k) {
    if (!from?.b?.length || !to.b.length) return to.b;
    const out = [];
    for (let i = 0; i < to.b.length; i++) {
      const a = from.b[Math.min(i, from.b.length - 1)];
      const b = to.b[i];
      if (!a) {
        out.push(b);
        continue;
      }
      // only smooth small moves, so teleports (respawn) do not streak across the board
      const dx = Math.abs(a[0] - b[0]);
      const dy = Math.abs(a[1] - b[1]);
      if (dx > 2 || dy > 2) {
        out.push(b);
        continue;
      }
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }
    return out;
  }

  function frame(now) {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const interval = 1000 / (meta.tickHz || 15);
    const k = Math.min(1, (now - snapAt) / interval);

    backdrop(c, W, H, now / 1000, { hue: 200 });
    if (!cur) {
      c.fillStyle = 'rgba(233,247,255,.5)';
      c.font = '600 14px ui-monospace, Menlo, monospace';
      c.textAlign = 'center';
      c.fillText('booting arena…', W / 2, H / 2);
      raf = requestAnimationFrame(frame);
      return;
    }

    // arena walls
    neonLine(c, () => c.strokeRect(1, 1, W - 2, H - 2), { hue: 200, width: 2, blur: 22, alpha: 0.55 });

    // food
    for (const [x, y, golden] of cur.food) {
      const cx = (x + 0.5) * CELL;
      const cy = (y + 0.5) * CELL;
      const pulse = 0.7 + 0.3 * Math.sin(now / (golden ? 160 : 320) + x + y);
      if (golden) {
        neonLine(c, () => {
          c.strokeStyle = 'hsl(52 100% 62%)';
          c.lineWidth = 2;
          c.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + now / 700;
            const r = 7 * pulse + 2;
            c[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          }
          c.closePath();
          c.stroke();
        }, { hue: 52, blur: 20 });
      }
      c.save();
      c.shadowColor = golden ? 'hsl(52 100% 60%)' : 'hsl(150 100% 55%)';
      c.shadowBlur = 16 * pulse;
      c.fillStyle = golden ? 'hsl(52 100% 66%)' : 'hsl(150 95% 58%)';
      c.beginPath();
      c.arc(cx, cy, (golden ? 6 : 4.2) * (0.8 + pulse * 0.35), 0, Math.PI * 2);
      c.fill();
      c.restore();
    }

    // snakes
    for (const p of cur.players) {
      if (!p.a) {
        if (p.r > 0) {
          c.fillStyle = 'rgba(233,247,255,.45)';
          c.font = '700 12px ui-monospace, Menlo, monospace';
          c.textAlign = 'center';
          const [rx, ry] = bodyCenter(p);
          c.fillText(`${(p.r / (SNAKE.TICK_HZ || 15)).toFixed(1)}s`, rx, ry);
        }
        continue;
      }
      const body = prev ? lerpBody(prev.players.find((q) => q.id === p.id), p, k) : p.b;
      if (!body.length) continue;
      const pts = body.map(([x, y]) => [(x + 0.5) * CELL, (y + 0.5) * CELL]);
      neonLine(c, () => {
        c.strokeStyle = `hsl(${p.h} 96% 62%)`;
        c.lineWidth = CELL * 0.84;
        c.beginPath();
        c.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
        if (pts.length === 1) c.lineTo(pts[0][0] + 0.1, pts[0][1]);
        c.stroke();
      }, { hue: p.h, blur: 22 });
      // inner highlight
      neonLine(c, () => {
        c.strokeStyle = `hsl(${p.h} 100% 84% / .85)`;
        c.lineWidth = CELL * 0.3;
        c.beginPath();
        c.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
        c.stroke();
      }, { hue: p.h, blur: 8 });

      // head + eyes
      const [hx, hy] = pts[0];
      const v = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[p.d] || [1, 0];
      c.save();
      c.fillStyle = `hsl(${p.h} 100% 92%)`;
      c.shadowColor = `hsl(${p.h} 100% 70%)`;
      c.shadowBlur = 18;
      c.beginPath();
      c.arc(hx, hy, CELL * 0.46, 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;
      c.fillStyle = '#05030c';
      for (const side of [-1, 1]) {
        const ex = hx + v.x * 3 + (v.y ? side * 4 : 0);
        const ey = hy + v.y * 3 + (v.x ? side * 4 : 0);
        c.beginPath();
        c.arc(ex, ey, 1.9, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();

      c.fillStyle = `hsl(${p.h} 96% 78% / .8)`;
      c.font = '600 10px ui-monospace, Menlo, monospace';
      c.textAlign = 'center';
      c.fillText(p.n.slice(0, 9), hx, hy - CELL * 0.8);
      if (p.s > 0) {
        c.fillStyle = 'rgba(255,230,0,.75)';
        c.fillText(String(p.s), hx, hy + CELL * 1.15);
      }
    }

    parts.step(dt, c);
    floats.step(dt, c);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      for (const off_ of off) off_?.();
      host.destroy();
    },
    steer,
  };
}

function opposite(d) {
  return { up: 'down', down: 'up', left: 'right', right: 'left' }[d];
}
