import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Grid2048, Versus2048, G2048 } from '../public/shared/g2048.js';
import { makeRng } from '../public/shared/rng.js';

function gridFrom(rows, seed = 1) {
  const g = new Grid2048({ seed });
  g.cells = rows.flat();
  return g;
}

test('2048: fresh board starts with exactly two tiles', () => {
  const g = new Grid2048({ seed: 9 });
  assert.equal(g.cells.filter((v) => v !== 0).length, 2);
  assert.ok(g.cells.every((v) => v === 0 || v === 2 || v === 4));
  assert.equal(g.score, 0);
  assert.equal(g.over, false);
});

test('2048: sliding left merges pairs once and pays their value', () => {
  const g = gridFrom([[2, 2, 4, 4], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4);
  g.spawn = () => -1; // no random tile for this assertion
  const res = g.move('left');
  assert.equal(res.moved, true);
  assert.equal(res.gained, 12);
  assert.deepEqual(g.cells.slice(0, 4), [4, 8, 0, 0]);
  assert.equal(g.score, 12);
});

test('2048: a row of four equal tiles merges two pairs, not a cascade', () => {
  const g = gridFrom([[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4);
  g.spawn = () => -1;
  g.move('left');
  assert.deepEqual(g.cells.slice(0, 4), [4, 4, 0, 0]);
  assert.equal(g.score, 8);
});

test('2048: no-op slides are rejected and cost nothing', () => {
  const g = gridFrom([[2, 4, 8, 16], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4);
  const before = g.cells.slice();
  const res = g.move('left');
  assert.equal(res.moved, false);
  assert.equal(g.moves, 0);
  assert.deepEqual(g.cells, before);
});

test('2048: every direction moves toward itself', () => {
  const g = gridFrom([[0, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4);
  g.spawn = () => -1;
  g.move('left');
  assert.equal(g.cells[0], 2);
  const g2 = gridFrom([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 0]], 4);
  g2.spawn = () => -1;
  g2.move('up');
  assert.equal(g2.cells[0], 2, 'column 0 slides to the top row');
  const g3 = gridFrom([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 0]], 4);
  g3.spawn = () => -1;
  g3.move('right');
  assert.equal(g3.cells[15], 2);
});

test('2048: a slide drops one new tile, and a merge pays for itself', () => {
  const plain = gridFrom([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 8]], 4);
  const before = plain.cells.filter((v) => v !== 0).length;
  const res = plain.move('left');
  assert.equal(res.moved, true);
  assert.equal(plain.cells.filter((v) => v !== 0).length, before + 1, 'a pure slide adds exactly one tile');

  const merged = gridFrom([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4);
  const r2 = merged.move('left');
  assert.equal(r2.gained, 4);
  assert.equal(merged.cells.filter((v) => v !== 0).length, 2, 'two tiles merged to one, spawn refilled');
  assert.equal(merged.cells[0], 4);
});

test('2048: reaching 2048 flags the win', () => {
  const g = gridFrom([[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], 4);
  g.spawn = () => -1;
  g.move('left');
  assert.equal(g.maxTile(), 2048);
  assert.equal(g.won, true);
  assert.ok(G2048.WIN_TILE === 2048);
});

test('2048: a full board with no merges is game over', () => {
  const g = gridFrom([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]], 4);
  assert.equal(g.canMove(), false);
  assert.deepEqual(
    ['up', 'down', 'left', 'right'].map((d) => g.move(d).moved),
    [false, false, false, false]
  );
  g.cells[0] = 4; // row 0 becomes 4,4 - a legal merge appears
  assert.equal(g.canMove(), true);
  assert.equal(g.move('left').moved, true);
});

test('2048: grid() and fromRows round-trip', () => {
  const rows = [[2, 4, 8, 16], [32, 64, 128, 256], [512, 1024, 2, 4], [8, 16, 32, 64]];
  const g = Grid2048.fromRows(rows, 3);
  assert.deepEqual(g.grid(), rows);
  assert.equal(g.over, true, 'that board has no legal merge left');
  const looser = Grid2048.fromRows([[2, 4, 8, 16], [32, 64, 128, 256], [512, 1024, 2, 4], [8, 16, 32, 32]], 3);
  assert.equal(looser.over, false, 'a repeat at the edge keeps it alive');
});

test('2048: long random game stays legal', () => {
  const g = new Grid2048({ seed: 21 });
  const rng = makeRng(5);
  const dirs = ['up', 'down', 'left', 'right'];
  let moved = 0;
  for (let i = 0; i < 800 && !g.over; i++) {
    const res = g.move(dirs[rng.int(4)]);
    if (res.moved) moved++;
    for (const v of g.cells) assert.ok(v === 0 || (v > 0 && (v & (v - 1)) === 0), `tile must be a power of two, got ${v}`);
    assert.equal(g.cells.filter((v) => v === 0).length + g.cells.filter((v) => v !== 0).length, 16);
  }
  assert.ok(moved > 100, `a random game should make progress, moved ${moved} times`);
  assert.ok(g.score > 0);
});

// --------------------------------------------------------------------------- versus
test('versus: reports are accepted while progress is plausible', () => {
  const v = new Versus2048({});
  v.addPlayer('a', { name: 'A' });
  v.addPlayer('b', { name: 'B' });
  assert.equal(v.report('a', { score: 8, moves: 1, max: 4, grid: [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] }), true);
  assert.equal(v.players.get('a').score, 8);
  assert.equal(v.report('a', { score: 40, moves: 2, max: 8 }), true);
  assert.equal(v.players.get('a').score, 40);
});

test('versus: impossible reports are refused (score down, tile not a power of two, move jumps)', () => {
  const v = new Versus2048({});
  v.addPlayer('a');
  v.report('a', { score: 100, moves: 3, max: 16 });
  assert.equal(v.report('a', { score: 20, moves: 4, max: 16 }), false, 'score cannot drop');
  assert.equal(v.report('a', { score: 120, moves: 2, max: 16 }), false, 'moves cannot go backwards');
  assert.equal(v.report('a', { score: 120, moves: 3, max: 16 }), false, 'no free points without a move');
  assert.equal(v.report('a', { score: 120, moves: 9, max: 16 }), false, 'one message cannot claim 6 moves');
  assert.equal(v.report('a', { score: 120, moves: 4, max: 17 }), false, '17 is not a tile');
  assert.equal(v.report('a', { score: 9_000_000, moves: 4, max: 16 }), false, 'absurd score is refused');
  assert.equal(v.players.get('a').score, 100, 'the last legal value survives');
});

test('versus: first reported 2048 wins the race', () => {
  const v = new Versus2048({});
  v.addPlayer('a');
  v.addPlayer('b');
  v.report('b', { score: 300, moves: 1, max: 64 });
  v.report('a', { score: 500, moves: 1, max: 2048 });
  assert.equal(v.over, true);
  assert.equal(v.winnerId, 'a');
  assert.equal(v.events.some((e) => e.k === 'over' && e.reason === 'reach2048'), true);
});

test('versus: when both boards lock up, the higher score takes it', () => {
  const v = new Versus2048({});
  v.addPlayer('a');
  v.addPlayer('b');
  v.report('a', { score: 640, moves: 1, max: 64, over: true });
  assert.equal(v.over, false, 'one stuck board is not a result');
  v.report('b', { score: 512, moves: 1, max: 32, over: true });
  assert.equal(v.over, true);
  assert.equal(v.winnerId, 'a');
});

test('versus: snapshots carry the rival board for the live mini-grid', () => {
  const v = new Versus2048({});
  v.addPlayer('a', { name: 'a' });
  v.addPlayer('b', { name: 'b' });
  const rows = [[2, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 2]];
  v.report('b', { score: 4, moves: 1, max: 4, grid: rows });
  const snap = v.snapshot();
  assert.equal(snap.players.length, 2);
  const rival = snap.players.find((p) => p.n === 'b');
  assert.deepEqual(rival.grid, rows);
  assert.equal(rival.score, 4);
  assert.equal(typeof snap.seconds, 'number');
  // junk rows are scrubbed, not trusted
  v.report('b', { score: 6, moves: 2, max: 4, grid: [[3, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] });
  assert.equal(v.snapshot().players.find((p) => p.n === 'b').grid[0][0], 0, 'a "3" tile is not a real 2048 tile');
});

test('versus: a forfeit hands the win to whoever remains', () => {
  const v = new Versus2048({});
  v.addPlayer('a');
  v.addPlayer('b');
  v.removePlayer('b');
  assert.equal(v.over, true);
  assert.equal(v.winnerId, 'a');
});
