// Breakout Duel cabinet: shared wall, two paddles, one ball.
import { makeCanvas, Particles, FloatText, backdrop, neonLine } from '../canvas.js';
import { $, fmtNum, overlay, clearOverlay, renderRoster, Sfx } from '../ui.js';
import { BREAK } from '../../shared/breakout.js';

const W = BREAK.W;
const H = BREAK.H;
const R = BREAK.BALL_R;

export function mount({ arena, session, meta } = {}) {
  const host = makeCanvas(arena, W, H);
  const { canvas, ctx: c } = host;
  const parts = new Particles(320);
  const floats = new FloatText();
  const hud = {
    score: $('#hudScore', arena.parentElement),
    lives: $('#hudLives', arena.parentElement),
    time: $('#hudTime', arena.parentElement),
    bricks: $('#hudBricks', arena.parentElement),
    roster: $('#roster', arena.parentElement),
  };

  let snap = null;
  let last = performance.now();
  let alive = true;
  let shake = 0;
  let ball = { x: W / 2, y: H - 120, vx: 0, vy: 0, stuck: true };
  let ballSnapT = performance.now();
  let prevBall = null;

  // ---- input: pointer + keys ------------------------------------------------
  let sendX = null;
  let queued = false;
  const sendPointer = (e) => {
    sendX = Math.max(0, Math.min(W, host.point(e).x));
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (sendX != null) session.send({ t: 'input', x: sendX });
    });
  };
  const onMove = (e) => {
    e.preventDefault();
    sendPointer(e);
  };
  canvas.addEventListener('pointermove', sendPointer);
  canvas.addEventListener('pointerdown', sendPointer);
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchstart', onMove, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const keys = { left: false, right: false };
  const onDown = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'h') keys.left = true;
    else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'l') keys.right = true;
    else if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'w') {
      e.preventDefault();
      if (snap?.ball?.[2]) session.send({ t: 'input', x: null, serve: true });
      return;
    } else return;
    e.preventDefault();
  };
  const onUp = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'h') keys.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'l') keys.right = false;
  };
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  let keyAcc = 0;

  const meId = () => session.pid || 'p0';
  const me = () => snap?.players?.find((p) => p.id === meId()) || snap?.players?.[0];

  const off = [
    session.on('state', (msg) => {
      prevBall = snap?.ball ? snap.ball.slice() : null;
      snap = msg.s;
      ballSnapT = performance.now();
      const [bx, by, stuck] = snap.ball;
      if (stuck) {
        ball.stuck = true;
        ball.x = bx;
        ball.y = by;
        ball.vx = 0;
        ball.vy = 0;
      } else {
        const dt = BREAK.TICK_HZ / (meta.stateHz || BREAK.TICK_HZ);
        if (prevBall && !prevBall[2]) {
          const ivx = (bx - prevBall[0]) / dt;
          const ivy = (by - prevBall[1]) / dt;
          // trust the sign, reuse the live magnitude - interpolation stays stable
          ball.vx = Math.abs(ivx) > 4 ? ivx * dt * BREAK.TICK_HZ : ball.vx || 60;
          ball.vy = Math.abs(ivy) > 4 ? ivy * dt * BREAK.TICK_HZ : ball.vy || -300;
        } else if (!ball.vx) {
          ball.vx = 60;
          ball.vy = by < H / 2 ? 300 : -300;
        }
        ball.stuck = false;
        ball.x = bx;
        ball.y = by;
      }
      if (msg.ev?.length) applyEvents(msg.ev);
      if (snap.over) paintOver();
      else clearOverlay(arena);
      paintHud();
    }),
    session.on('ev', (msg) => applyEvents(msg.ev || [])),
    session.on('joined', (m) => {
      Sfx.play('join');
      if (m.room?.status === 'waiting') {
        overlay(arena, {
          title: 'duel room open',
          sub: m.room.solo
            ? 'Solo: you are the bottom paddle, the CPU defends the top line.'
            : `Send code ${m.room.id} to a rival - or race the CPU now and take the points anyway.`,
          actions: [{ label: 'race the cpu', cls: 'gr', fn: () => session.send({ t: 'addCpu' }) }],
        });
      }
    }),
    session.on('restarted', () => {
      clearOverlay(arena);
      parts.clear();
      floats.clear();
    }),
    session.on('roundOver', () => paintOver()),
  ];

  function applyEvents(events) {
    for (const ev of events) {
      if (ev.k === 'break') {
        parts.burst(ev.x, ev.y, { count: 14, hue: ev.id === meId() ? 188 : 312, speed: 210, life: 0.5, size: 3.4 });
        if (ev.combo > 1) floats.add(ev.x, ev.y, `x${ev.combo}`, 52);
        Sfx.play('break', Math.min(1.4, 0.8 + (ev.combo || 1) * 0.1));
        shake = Math.max(shake, 4);
      } else if (ev.k === 'crack') {
        parts.burst(ev.x, ev.y, { count: 5, hue: 200, speed: 110, life: 0.3, size: 2.4 });
        Sfx.play('crack');
      } else if (ev.k === 'paddle') {
        parts.ring(ev.x, ev.y, { hue: ev.side === 'bottom' ? 188 : 312, life: 0.28, size: 38 });
        Sfx.play('paddle');
      } else if (ev.k === 'wall') {
        parts.burst(ev.x, ev.y, { count: 4, hue: 210, speed: 90, life: 0.25, size: 2 });
        Sfx.play('wall');
      } else if (ev.k === 'miss') {
        const y = ev.side === 'bottom' ? H - 8 : 8;
        parts.burst(ball.x, y, { count: 26, hue: 350, speed: 240, life: 0.6, size: 3.6, gravity: 320 });
        floats.add(ball.x, y + (ev.side === 'bottom' ? -22 : 22), `-${1} life`, 350);
        Sfx.play('miss');
        shake = 12;
      } else if (ev.k === 'steal') {
        floats.add(ball.x, H / 2, 'combo stolen', 30);
      } else if (ev.k === 'launch') {
        ball.stuck = false;
      }
    }
  }

  function paintHud() {
    if (!snap) return;
    const m = me();
    if (hud.score) hud.score.textContent = fmtNum(m?.score || 0);
    if (hud.lives) hud.lives.textContent = `${m?.lives ?? 0}♥`;
    if (hud.bricks) hud.bricks.textContent = `${snap.wallLeft}/${snap.wallTotal}`;
    if (hud.time) hud.time.textContent = `${snap.timeLeft}s`;
    renderRoster(
      hud.roster,
      snap.players.map((p) => ({ id: p.id, name: p.n, hue: p.h, score: p.score, lives: p.lives, bot: p.bot })),
      { pid: meId() }
    );
  }

  function paintOver() {
    if (arena.querySelector('.overlay.over')) return;
    const m = me();
    const won = snap?.winner && snap.winner === m?.id;
    const why = { cleared: 'The wall came down.', lives: 'Out of lives.', time: 'Clock ran out.' }[snap?.reason] || 'Match over';
    const box = overlay(arena, {
      title: won ? 'duel won' : 'duel lost',
      kind: won ? 'win' : 'lose',
      sub: `${why} Rematch starts on its own in a few seconds.`,
      rows: (snap?.players || []).map((p) => ({ label: `${p.n} · ${p.broken} bricks · ${p.lives}♥`, value: fmtNum(p.score) })),
      actions: [{ label: 'rematch now', cls: 'gr', fn: () => session.send({ t: 'restart' }) }],
    });
    box?.classList.add('over');
    Sfx.play(won ? 'win' : 'lose');
    if (session.mode === 'solo') session.results(m?.score || 0, 'solo');
  }

  // ---- render --------------------------------------------------------------
  function frame(now) {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    let ox = 0;
    let oy = 0;
    if (shake > 0) {
      shake = Math.max(0, shake - dt * 26);
      ox = (Math.random() - 0.5) * shake;
      oy = (Math.random() - 0.5) * shake;
    }
    c.save();
    c.translate(ox, oy);
    backdrop(c, W, H, now / 1000, { hue: 292 });

    if (!snap) {
      readyText(c, 'warming up the tubes…');
      c.restore();
      raf = requestAnimationFrame(frame);
      return;
    }

    // keyboard paddle (also works while waiting on a state message)
    if (keys.left || keys.right) {
      keyAcc += dt;
      if (keyAcc > 0.02) {
        keyAcc = 0;
        session.send({ t: 'input', dx: (keys.right ? 1 : -1) * 26 });
      }
    }

    // danger tint on the baseline the ball is heading for
    if (!ball.stuck) {
      const towardBottom = ball.vy > 0;
      const y = towardBottom ? H : 0;
      const grad = c.createLinearGradient(0, y, 0, y + (towardBottom ? -110 : 110));
      grad.addColorStop(0, 'rgba(255,77,106,.28)');
      grad.addColorStop(1, 'transparent');
      c.fillStyle = grad;
      c.fillRect(0, towardBottom ? H - 110 : 0, W, 110);
    }

    // wall
    for (const [x, y, w, h, hp, row] of snap.bricks) {
      const tough = hp > 1;
      const hue = 188 + row * 22;
      c.save();
      c.fillStyle = `hsl(${hue} ${tough ? 45 : 88}% ${tough ? 24 : 17}% / .96)`;
      c.shadowColor = `hsl(${hue} 96% 60% / ${tough ? 0.35 : 0.8})`;
      c.shadowBlur = tough ? 8 : 18;
      roundRect(c, x, y, w, h, 6);
      c.fill();
      c.shadowBlur = 0;
      c.strokeStyle = `hsl(${hue} 96% ${tough ? 58 : 66}% / .95)`;
      c.lineWidth = tough ? 2 : 1.3;
      roundRect(c, x, y, w, h, 6);
      c.stroke();
      if (tough) {
        c.strokeStyle = 'rgba(255,255,255,.18)';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x + 5, y + 5);
        c.lineTo(x + w - 5, y + 5);
        c.stroke();
      }
      c.restore();
    }

    // midline
    neonLine(c, () => {
      c.strokeStyle = 'rgba(140,170,255,.18)';
      c.setLineDash([12, 14]);
      c.beginPath();
      c.moveTo(0, H / 2);
      c.lineTo(W, H / 2);
      c.stroke();
      c.setLineDash([]);
    }, { blur: 0 });

    // paddles
    for (const p of snap.players) {
      const x = p.x - BREAK.PAD_W / 2;
      neonLine(c, () => {
        c.fillStyle = `hsl(${p.h} 96% 62%)`;
        roundRect(c, x, p.y, BREAK.PAD_W, BREAK.PAD_H, 7);
        c.fill();
      }, { hue: p.h, blur: 26 });
      c.fillStyle = `hsl(${p.h} 100% 92%)`;
      c.beginPath();
      c.arc(p.x, p.y + BREAK.PAD_H / 2, 2.4, 0, Math.PI * 2);
      c.fill();
      c.font = '600 11px ui-monospace, Menlo, monospace';
      c.textAlign = 'center';
      c.fillStyle = p.id === meId() ? 'rgba(255,230,0,.9)' : `hsl(${p.h} 96% 80% / .8)`;
      c.fillText(`${p.n}${p.id === meId() ? ' (you)' : p.bot ? ' · cpu' : ''}`, p.x, p.side === 'bottom' ? p.y - 12 : p.y + BREAK.PAD_H + 20);
    }

    // ball with extrapolation + trail
    if (!ball.stuck) {
      const t = Math.min(0.06, (now - ballSnapT) / 1000);
      ball.x += ball.vx * t;
      ball.y += ball.vy * t;
      ball.x = Math.max(R, Math.min(W - R, ball.x));
    } else if (snap.ball) {
      ball.x = snap.ball[0];
      ball.y = snap.ball[1];
    }
    for (let i = 5; i >= 1; i--) {
      const k = i / 5;
      c.fillStyle = `hsla(${ball.stuck ? 52 : 190}, 100%, 72%, ${0.13 * (1 - k)})`;
      c.beginPath();
      c.arc(ball.x - ball.vx * 0.014 * i, ball.y - ball.vy * 0.014 * i, R * (1 - k * 0.5), 0, Math.PI * 2);
      c.fill();
    }
    c.save();
    c.shadowColor = ball.stuck ? 'hsl(52 100% 65%)' : 'hsl(190 100% 72%)';
    c.shadowBlur = 28;
    c.fillStyle = '#eafcff';
    c.beginPath();
    c.arc(ball.x, ball.y, R, 0, Math.PI * 2);
    c.fill();
    c.restore();
    if (ball.stuck) {
      c.font = '600 11px ui-monospace, Menlo, monospace';
      c.textAlign = 'center';
      c.fillStyle = 'rgba(255,230,0,.85)';
      c.fillText('serving…', ball.x, ball.y - 18);
    }

    parts.step(dt, c);
    floats.step(dt, c);
    c.restore();
    raf = requestAnimationFrame(frame);
  }
  let raf = requestAnimationFrame(frame);

  return {
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointermove', sendPointer);
      canvas.removeEventListener('pointerdown', sendPointer);
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      for (const f of off) f?.();
      host.destroy();
    },
  };
}

function readyText(c, text) {
  c.fillStyle = 'rgba(233,247,255,.5)';
  c.font = '600 14px ui-monospace, Menlo, monospace';
  c.textAlign = 'center';
  c.fillText(text, W / 2, H / 2);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
