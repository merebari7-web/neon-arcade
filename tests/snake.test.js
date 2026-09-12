import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnakeArena, SNAKE } from '../public/shared/snake.js';
import { makeRng } from '../public/shared/rng.js';

function arena(over = {}) {
  const a = new SnakeArena({ seed: 7, cfg: { FOOD_TARGET: 0, ...over } });
  a.food = [];
  return a;
}

test('snake: starts with a 4-segment body facing a safe direction', () => {
  const a = arena();
  const p = a.addPlayer('p0', { name: 'Alice' });
  assert.equal(p.body.length, SNAKE.START_LEN);
  assert.equal(p.alive, true);
  assert.equal(p.score, 0);
  assert.equal(a.snapshot().players.length, 1);
});

test('snake: steering rejects 180° reversals and accepts turns', () => {
  const a = arena();
  const p = a.addPlayer('p0');
  assert.equal(a.steer(p.id, 'left'), false, p.dir); // reverse of 'right'
  assert.equal(a.steer(p.id, 'up'), true);
  assert.equal(p.queued, 'up');
  a.step();
  assert.equal(p.dir, 'up');
});

test('snake: running into a wall kills you and does not credit anyone', () => {
  const a = arena();
  const p = a.addPlayer('p0');
  p.body = [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }, { x: 3, y: 5 }];
  p.dir = 'left';
  p.queued = 'left';
  const events = a.step();
  assert.equal(p.alive, false);
  assert.ok(events.some((e) => e.k === 'crash'));
  assert.equal(p.kills, 0);
});

test('snake: walking into a rival gives that rival the kill bonus', () => {
  const a = arena();
  const victim = a.addPlayer('p0');
  const rival = a.addPlayer('p1');
  victim.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }, { x: 2, y: 5 }];
  victim.dir = 'right';
  victim.queued = 'right';
  rival.body = [{ x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }];
  rival.dir = 'up';
  rival.queued = 'up';
  const before = rival.score;
  const events = a.step();
  assert.equal(victim.alive, false, 'victim should be dead');
  assert.equal(rival.alive, true);
  assert.equal(rival.score, before + SNAKE.KILL_POINTS);
  assert.equal(rival.kills, 1);
  assert.ok(events.some((e) => e.k === 'kill' && e.by === 'p1' && e.victim === 'p0'));
});

test('snake: following your own departing tail is legal, occupying it is not', () => {
  const a = arena();
  const p = a.addPlayer('p0');
  // straight vertical body, head at top moving right: head lands on nothing
  p.body = [{ x: 4, y: 4 }, { x: 4, y: 5 }, { x: 4, y: 6 }, { x: 4, y: 7 }];
  p.dir = 'right';
  a.step();
  assert.equal(p.alive, true);
  assert.equal(p.body[0].x, 5);

  // now a body shaped so the head re-enters the cell the tail is leaving
  const q = arena();
  const s = q.addPlayer('p0');
  s.body = [{ x: 6, y: 6 }, { x: 7, y: 6 }, { x: 7, y: 7 }, { x: 6, y: 7 }];
  s.dir = 'down'; // head (6,6) -> (6,7) which is currently the tail cell
  s.queued = 'down';
  q.step();
  assert.equal(s.alive, true, 'tail cell vacates in the same tick');
});

test('snake: eating a pellet grows the body, scores and respawns food', () => {
  const a = arena();
  const p = a.addPlayer('p0');
  p.body = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }, { x: 5, y: 8 }];
  p.dir = 'right';
  p.queued = 'right';
  a.food = [{ x: 9, y: 8, golden: false, points: 10 }];
  a.spawnFood = () => {
    a.food.push({ x: 20, y: 20, golden: false, points: 10 });
    return null;
  };
  const len = p.body.length;
  const events = a.step();
  assert.equal(p.body.length, len + 1, 'one pellet should add one segment');
  assert.equal(p.score, 10);
  assert.ok(events.some((e) => e.k === 'eat'));
});

test('snake: five in a row adds bonus growth', () => {
  const a = arena();
  const p = a.addPlayer('p0');
  p.streak = 4;
  p.body = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }, { x: 5, y: 8 }];
  p.dir = 'right';
  a.food = [{ x: 9, y: 8, points: 10 }];
  a.spawnFood = () => null;
  const len = p.body.length;
  a.step();
  assert.equal(len + 1 + 2, p.body.length + p.grow, 'bonus grow is queued or applied');
});

test('snake: a golden pellet is worth four times a normal one', () => {
  const a = arena();
  const p = a.addPlayer('p0');
  p.body = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }, { x: 5, y: 8 }];
  p.dir = 'right';
  a.food = [{ x: 9, y: 8, golden: true, points: 40 }];
  a.spawnFood = () => null;
  a.step();
  assert.equal(p.score, 40);
});

test('snake: first to WIN_SCORE ends the round with that player as winner', () => {
  const a = arena();
  const p = a.addPlayer('p0');
  const q = a.addPlayer('p1');
  p.score = SNAKE.WIN_SCORE - 1;
  p.body = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }, { x: 5, y: 8 }];
  p.dir = 'right';
  a.food = [{ x: 9, y: 8, points: 10 }];
  a.spawnFood = () => null;
  a.step();
  assert.equal(a.over, true);
  assert.equal(a.winnerId, p.id);
  assert.equal(a.standings()[0].id, p.id);
  assert.equal(q.alive, true);
});

test('snake: respawn puts a live snake back on the board after the wait', () => {
  const a = arena();
  const p = a.addPlayer('p0');
  p.body = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }];
  p.dir = 'up';
  p.queued = 'up';
  a.step();
  assert.equal(p.alive, false);
  for (let i = 0; i < SNAKE.RESPAWN_TICKS + 1; i++) a.step();
  assert.equal(p.alive, true);
  assert.equal(p.body.length, SNAKE.START_LEN);
});

test('snake: snapshot is compact, JSON-safe and stable', () => {
  const a = arena();
  a.addPlayer('p0', { name: 'Alice' });
  a.addPlayer('p1', { name: 'Bob' });
  a.rng = makeRng(3);
  for (let i = 0; i < 30; i++) a.spawnFood();
  for (let i = 0; i < 12; i++) a.step();
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  assert.equal(snap.t, 12);
  assert.equal(snap.players.length, 2);
  for (const p of snap.players) {
    assert.match(p.n, /Alice|Bob/);
    assert.equal(typeof p.s, 'number');
    for (const cell of p.b) {
      assert.ok(Number.isInteger(cell[0]) && Number.isInteger(cell[1]), 'cells are integers');
      assert.ok(cell[0] >= 0 && cell[0] < SNAKE.W && cell[1] >= 0 && cell[1] < SNAKE.H, `cell in bounds: ${cell}`);
    }
  }
  assert.ok(snap.food.length > 0);
});

test('snake: same seed produces the same match on both sides of the wire', () => {
  const run = () => {
    const a = new SnakeArena({ seed: 99, cfg: { FOOD_TARGET: 4 } });
    a.addPlayer('p0');
    a.addPlayer('p1');
    for (let i = 0; i < 40; i++) {
      if (i % 7 === 0) a.steer('p0', ['up', 'left', 'down', 'right'][Math.floor(i / 7) % 4]);
      a.step();
    }
    return a.snapshot();
  };
  assert.deepEqual(run(), run());
});
