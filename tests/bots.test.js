import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnakeArena } from '../public/shared/snake.js';
import { BreakoutDuel } from '../public/shared/breakout.js';
import { MemoryDuel } from '../public/shared/memory.js';
import { Grid2048 } from '../public/shared/g2048.js';
import { makeRng } from '../public/shared/rng.js';
import { snakeBotDir, breakoutCpuTarget, memoryCpuFlip, g2048CpuMove, boardHeuristic } from '../public/shared/bots.js';

test('bots: snake CPU refuses suicide - always picks a survivable direction', () => {
  const a = new SnakeArena({ seed: 4, cfg: { FOOD_TARGET: 1 } });
  const p = a.addPlayer('b0', { bot: true });
  // head wedged in a corner with only one legal exit
  p.body = [
    { x: 0, y: 1 },
    { x: 0, y: 2 },
    { x: 0, y: 3 },
    { x: 0, y: 4 },
  ];
  p.dir = 'down';
  p.queued = 'down';
  const dir = snakeBotDir(a, p);
  assert.equal(dir, 'right', `expected an escape, chose ${dir}`);
});

test('bots: four CPU snakes run a whole match without dying out or breaking rules', () => {
  const a = new SnakeArena({ seed: 77, cfg: { FOOD_TARGET: 8 } });
  for (let i = 0; i < 4; i++) a.addPlayer(`b${i}`, { bot: true, name: `B${i}` });
  let moves = 0;
  for (let i = 0; i < a.cfg.TICK_HZ * 60; i++) {
    for (const p of a.players.values()) if (p.alive) a.steer(p.id, snakeBotDir(a, p, { rng: a.rng }));
    a.step();
    moves++;
    for (const p of a.players.values()) {
      if (!p.alive) continue;
      for (const c of p.body) {
        assert.ok(c.x >= 0 && c.y >= 0 && c.x < a.cfg.W && c.y < a.cfg.H, `bot body left the arena: ${c.x},${c.y}`);
      }
      assert.equal(new Set(p.body.map((c) => `${c.x},${c.y}`)).size, p.body.length, 'bot bodies must not overlap themselves');
    }
    if (a.over) break;
  }
  assert.ok(moves > 60, 'bots should survive long enough to matter');
  const total = [...a.players.values()].reduce((s, p) => s + p.score, 0);
  assert.ok(total > 0, `bots must eat pellets, total score ${total}`);
});

test('bots: breakout CPU keeps its paddle legal and follows the ball', () => {
  const d = new BreakoutDuel({ seed: 9 });
  d.addPlayer('you', { side: 'bottom' });
  const cpu = d.addPlayer('cpu', { side: 'top', bot: true });
  d.serve('bottom');
  const me = d.paddles.bottom;
  let close = 0;
  for (let i = 0; i < 60 * 45; i++) {
    d.move('you', { x: d.ball.x }); // a competent human on the other end
    const target = breakoutCpuTarget(d, cpu, { skill: 0.9 });
    assert.ok(Number.isFinite(target), 'cpu target is a number');
    assert.ok(target >= d.cfg.PAD_W / 2 - 0.01 && target <= d.cfg.W - d.cfg.PAD_W / 2 + 0.01, 'cpu target stays in the field');
    d.move(cpu.id, { x: target });
    const before = Math.abs(d.ball.x - cpu.padX);
    d.step();
    if (before < 70) close++;
    if (d.over) break;
  }
  assert.ok(close > 30, 'cpu should be near the ball a lot of the time');
  assert.ok(cpu.lives >= d.cfg.LIVES - 1, `a skilled cpu barely drops the ball, lost ${d.cfg.LIVES - cpu.lives}`);
  assert.ok(cpu.broken > 0, 'cpu must break bricks too, broke ' + cpu.broken);
  assert.ok(d.over || d.liveBricks().length < 60, 'a two-player rally empties the wall over time');
  void me;
});

test('bots: weak cpu is beatable - it misses on purpose sometimes', () => {
  const d = new BreakoutDuel({ seed: 31 });
  d.addPlayer('you', { side: 'bottom' });
  const cpu = d.addPlayer('cpu', { side: 'top', bot: true });
  d.serve('bottom');
  for (let i = 0; i < 60 * 180; i++) {
    d.move('you', { x: d.ball.x }); // perfect human
    d.move(cpu.id, { x: breakoutCpuTarget(d, cpu, { skill: 0.12 }) });
    d.step();
    if (d.over) break;
  }
  assert.equal(d.over, true, 'a sloppy cpu loses the duel');
  assert.equal(d.winnerId, 'you', `the flawless player should win, got ${d.winnerId}`);
});

test('bots: memory cpu takes a pair it already knows', () => {
  const d = new MemoryDuel({ seed: 13 });
  d.addPlayer('you');
  const cpu = d.addPlayer('cpu', { bot: true });
  const sym = d.cards[7].sym;
  const [a, b] = d.cards.filter((c) => c.sym === sym).map((c) => c.i);
  // pretend the cpu saw both tiles earlier in the round
  for (const i of [a, b]) {
    d.cards[i].seen = true;
    d.cards[i].flipTick = -1;
  }
  const seen = new Set([a, b]);
  const pick = memoryCpuFlip(d, cpu.id, seen);
  assert.ok([a, b].includes(pick.idx), `cpu should open a known pair, chose ${pick.idx}`);
});

test('bots: memory cpu completes a pair the player just exposed', () => {
  const d = new MemoryDuel({ seed: 17 });
  d.addPlayer('you');
  const cpu = d.addPlayer('cpu', { bot: true });
  const first = 3;
  d.flip('you', first); // turn is 'you', so the flip lands
  // hand the turn over, then let the cpu answer the exposed tile
  d.turn = d.order.indexOf(cpu.id);
  const partner = d.cards.find((c, i) => c.sym === d.cards[first].sym && i !== first).i;
  d.cards[partner].seen = true; // the cpu glimpsed it earlier in the round
  const pick = memoryCpuFlip(d, cpu.id, new Set());
  assert.equal(pick.idx, partner, 'cpu should close the pair it can see');
});

test('bots: 2048 cpu plays legally and gets somewhere', () => {
  const g = new Grid2048({ seed: 6 });
  const rng = makeRng(2);
  let plays = 0;
  while (!g.over && plays < 2000) {
    const dir = g2048CpuMove(g, { rng, noise: 30 });
    assert.ok(['up', 'down', 'left', 'right'].includes(dir), 'cpu must name a real direction');
    const res = g.move(dir);
    assert.equal(res.moved, true, 'the cpu never wastes a turn on a no-op slide');
    plays++;
  }
  assert.ok(g.maxTile() >= 16, `cpu should at least reach 16, got ${g.maxTile()}`);
  assert.ok(g.score > 0);
});

test('bots: board heuristic prefers open, monotonic boards', () => {
  const open = [2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const jammed = [2, 128, 4, 256, 512, 8, 16, 32, 64, 2, 4, 8, 1024, 16, 32, 64];
  assert.ok(boardHeuristic(open, 4) > boardHeuristic(jammed, 4), 'empty space is worth more than chaos');
});
