import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BreakoutDuel, BREAK } from '../public/shared/breakout.js';

function duel(opts = {}) {
  const d = new BreakoutDuel({ seed: opts.seed ?? 11, cfg: opts.cfg });
  d.addPlayer('you', { name: 'You', side: 'bottom' });
  d.addPlayer('cpu', { name: 'CPU', side: 'top', bot: true });
  d.serve('bottom');
  d.launch('bottom');
  return d;
}

// A believable player: tracks the ball with a small aiming wobble so the rally
// angle changes, exactly like a human dragging a paddle.
function autopilot(d, meId, otherId, tick) {
  const half = BREAK.PAD_W / 2;
  const clampX = (v) => Math.max(half, Math.min(BREAK.W - half, v));
  d.move(meId, { x: clampX(d.ball.x + Math.sin(tick / 41) * 16) });
  d.move(otherId, { x: clampX(d.ball.x + Math.cos(tick / 37) * 20) });
}

test('breakout: one shared wall, outer rows crack in one hit, core rows take two', () => {
  const d = duel();
  assert.equal(d.bricks.length, BREAK.BRICK_COLS * BREAK.BRICK_ROWS);
  assert.equal(d.liveBricks().length, 60);
  const rows = new Map();
  for (const b of d.bricks) rows.set(b.row, b.hp);
  assert.equal(rows.get(0), 1);
  assert.equal(rows.get(1), 2);
  assert.equal(rows.get(BREAK.BRICK_ROWS - 1), 1);
});

test('breakout: a destroyed brick credits whoever last hit the ball', () => {
  const d = duel();
  const brick = d.liveBricks()[0];
  const b = d.ball;
  b.stuck = false;
  b.hitter = 'you';
  b.speed = 200;
  b.vx = 0;
  b.vy = -200;
  b.x = brick.x + brick.w / 2;
  b.y = brick.y + brick.h + b.r - 3; // touching the underside, moving up
  for (const other of d.bricks) if (other !== brick) other.hp = 0; // isolate the collision
  const me = d.paddles.bottom;
  const events = d.step();
  assert.equal(brick.hp, 0, '1hp outer brick should die');
  assert.equal(me.broken, 1);
  assert.ok(events.some((e) => e.k === 'break' && e.id === 'you' && e.points === 100));
});

test('breakout: a tough brick only cracks and deflects the ball', () => {
  const d = duel();
  const tough = d.bricks.find((b) => b.hp === 2);
  for (const other of d.bricks) if (other !== tough) other.hp = 0; // isolate the collision
  const b = d.ball;
  b.stuck = false;
  b.hitter = 'cpu';
  b.speed = 220;
  b.vx = 0;
  b.vy = 220; // travelling down into the tough brick's top face
  b.x = tough.x + tough.w / 2;
  b.y = tough.y - b.r + 3; // touching the top face, moving down
  const rival = d.paddles.top;
  const before = b.vy;
  const events = d.step();
  assert.equal(tough.hp, 1, '2hp brick survives one hit');
  assert.equal(rival.broken, 0);
  assert.ok(b.vy < 0 && before > 0, 'ball deflects back the way it came');
  assert.ok(events.some((e) => e.k === 'crack' && e.id === 'cpu'));
});

test('breakout: hitting the ball resets the rival streak and scores a steal', () => {
  const d = duel();
  const me = d.paddles.bottom;
  const rival = d.paddles.top;
  rival.combo = 4;
  d.ball.stuck = false;
  d.ball.vy = 300;
  d.ball.vx = 0;
  d.ball.x = me.padX;
  d.ball.y = d.paddleY('bottom') - 10;
  const events = d.step();
  assert.equal(rival.combo, 0);
  assert.ok(events.some((e) => e.k === 'steal'));
});

test('breakout: chaining breaks pays a combo bonus', () => {
  const d = duel();
  const me = d.paddles.bottom;
  for (const brick of d.liveBricks().slice(0, 3)) {
    brick.hp = 1;
    d.ball.stuck = false;
    d.ball.hitter = 'you';
    d.ball.speed = 200;
    d.ball.vx = 0;
    d.ball.vy = -200;
    d.ball.x = brick.x + brick.w / 2;
    d.ball.y = brick.y + brick.h + d.ball.r - 3;
    d.step();
  }
  assert.equal(me.broken, 3);
  assert.ok(me.score > 300, `combo should add on top of 3x100, got ${me.score}`);
  assert.equal(me.best, 3);
});

test('breakout: missing your line costs a life and hands you the next serve', () => {
  const d = duel();
  const me = d.paddles.bottom;
  d.ball.stuck = false;
  d.ball.x = 140;
  d.ball.y = BREAK.H + 40;
  d.ball.vx = 40;
  d.ball.vy = 500;
  d.ball.owner = 'bottom';
  const events = d.step();
  assert.equal(me.lives, BREAK.LIVES - 1);
  assert.equal(me.dropped, 1);
  assert.equal(d.ball.stuck, true);
  assert.equal(d.ball.owner, 'bottom', 'the loser serves, never punished twice');
  assert.ok(events.some((e) => e.k === 'miss'));
});

test('breakout: empty lives ends the duel for the rival', () => {
  const d = duel();
  const me = d.paddles.bottom;
  for (let i = 0; i < BREAK.LIVES; i++) {
    d.ball.stuck = false;
    d.ball.x = 140;
    d.ball.y = BREAK.H + 40;
    d.ball.vx = 40;
    d.ball.vy = 600;
    d.step();
  }
  assert.equal(me.lives, 0);
  assert.equal(d.over, true);
  assert.equal(d.winnerId, 'cpu');
  assert.equal(d.reason, 'lives');
});

test('breakout: clearing the wall ends it and the most productive player wins', () => {
  const d = duel();
  d.paddles.bottom.broken = 5;
  d.paddles.top.broken = 2;
  for (const b of d.bricks) b.hp = 0;
  d.step();
  assert.equal(d.over, true);
  assert.equal(d.reason, 'cleared');
  assert.equal(d.winnerId, 'you');
  assert.ok(d.paddles.bottom.score >= 400, 'end bonus');
});

test('breakout: a dead-centre rally cannot stall - the ball keeps lateral speed', () => {
  const d = duel();
  const me = d.paddles.bottom;
  // perfect dead-centre tracking, the classic Pong stalemate
  for (let i = 0; i < 240; i++) {
    me.padTarget = d.ball.x;
    d.paddles.top.padTarget = d.ball.x;
    d.step();
  }
  assert.ok(Math.abs(d.ball.vx) > 0.15 * d.ball.speed, `vx should stay meaningful, got ${d.ball.vx.toFixed(1)}`);
  assert.ok(d.ball.y > 0 && d.ball.y < BREAK.H, 'ball stays in play');
});

test('breakout: a very fast ball never tunnels through a paddle', () => {
  const d = duel();
  const me = d.paddles.bottom;
  d.ball.stuck = false;
  d.ball.speed = 1000;
  d.ball.x = me.padX;
  d.ball.y = d.paddleY('bottom') - 300;
  d.ball.vx = 0;
  d.ball.vy = 1000;
  let saved = false;
  for (let i = 0; i < 60; i++) {
    me.padTarget = d.ball.x;
    const ev = d.step();
    if (ev.some((e) => e.k === 'paddle')) {
      saved = true;
      break;
    }
  }
  assert.ok(saved, 'paddle intercepts at 1000 px/s');
  assert.ok(d.ball.vy < 0, 'ball leaves the paddle upward');
});

test('breakout: long autoplay match - legal state throughout, always converges', () => {
  const d = duel({ seed: 7 });
  const seen = { breaks: 0, misses: 0 };
  for (let i = 0; i < 60 * (BREAK.MATCH_SECONDS + 2); i++) {
    autopilot(d, 'you', 'cpu', i);
    for (const e of d.step()) {
      if (e.k === 'break') seen.breaks += 1;
      if (e.k === 'miss') seen.misses += 1;
      assert.ok(Number.isFinite(d.ball.x) && Number.isFinite(d.ball.y), 'ball finite');
    }
    for (const p of d.players.values()) {
      assert.ok(p.padX >= BREAK.PAD_W / 2 - 0.01 && p.padX <= BREAK.W - BREAK.PAD_W / 2 + 0.01, `paddle clamped: ${p.padX}`);
      assert.ok(p.lives >= 0 && p.lives <= BREAK.LIVES, 'lives in range');
    }
    if (d.over) break;
  }
  assert.equal(d.over, true, 'the clock always finishes a duel');
  assert.ok(['time', 'cleared', 'lives'].includes(d.reason), `sane reason: ${d.reason}`);
  assert.ok(['you', 'cpu'].includes(d.winnerId), 'a real winner');
  assert.ok(seen.breaks > 20, `bricks should get broken, saw ${seen.breaks}`);
});

test('breakout: snapshot is wire-sized and JSON safe', () => {
  const d = duel();
  for (let i = 0; i < 150; i++) {
    autopilot(d, 'you', 'cpu', i);
    d.step();
  }
  const snap = JSON.parse(JSON.stringify(d.snapshot()));
  assert.equal(snap.bricks.length, 60, 'dead bricks are pruned client-side by hp=0');
  for (const b of snap.bricks) {
    assert.equal(b.length, 6);
    assert.ok(b[4] >= 0 && b[4] <= 2, 'hp');
  }
  assert.equal(snap.ball.length, 3);
  assert.equal(snap.players.length, 2);
  assert.equal(typeof snap.wallLeft, 'number');
  assert.equal(snap.wallTotal, 60);
  const json = JSON.stringify(snap);
  assert.ok(json.length < 12000, `snapshot should stay light on the wire, got ${json.length} bytes`);
});

test('breakout: a lone player still gets a full game (no ghost rival needed)', () => {
  const d = new BreakoutDuel({ seed: 3 });
  d.addPlayer('solo', { side: 'bottom' });
  d.serve('bottom');
  d.launch('bottom');
  for (let i = 0; i < 600; i++) {
    d.move('solo', { x: d.ball.x });
    d.step();
  }
  assert.ok(d.paddles.bottom.broken + d.bricks.filter((b) => b.hp === 0).length > 0, 'bricks broke');
  assert.equal(d.players.get('solo').lives, BREAK.LIVES, 'nobody to drain lives from the top side');
});
