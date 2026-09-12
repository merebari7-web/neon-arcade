import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDuel, MEMORY } from '../public/shared/memory.js';

function duel(players = 2) {
  const d = new MemoryDuel({ seed: 5 });
  const ids = [];
  for (let i = 0; i < players; i++) {
    ids.push(`p${i}`);
    d.addPlayer(`p${i}`, { name: `P${i}` });
  }
  return { d, ids };
}
const pairOf = (d, sym) => d.cards.filter((c) => c.sym === sym).map((c) => c.i);

test('memory: 16 tiles, 8 pairs, nothing face up at the start', () => {
  const { d } = duel();
  assert.equal(d.cards.length, 16);
  assert.equal(new Set(d.cards.map((c) => c.sym)).size, 8);
  for (const sym of new Set(d.cards.map((c) => c.sym))) assert.equal(d.cards.filter((c) => c.sym === sym).length, 2);
  assert.equal(d.open.length, 0);
  assert.equal(d.left ?? d.cards.filter((c) => !c.matched).length, 16);
});

test('memory: no turns until two players are seated', () => {
  const solo = new MemoryDuel({ seed: 2 });
  solo.addPlayer('p0', { name: 'Alone' });
  assert.equal(solo.ready(), false);
  assert.deepEqual(solo.flip('p0', 0), { ok: false, why: 'waiting' });
});

test('memory: only the player on turn may flip', () => {
  const { d, ids } = duel();
  assert.equal(d.currentId(), ids[0]);
  assert.deepEqual(d.flip(ids[1], 0), { ok: false, why: 'not-your-turn' });
  assert.deepEqual(d.flip(ids[0], 999), { ok: false, why: 'no-such-card' });
  assert.equal(d.flip(ids[0], 3).ok, true);
});

test('memory: a matched pair scores, keeps the turn and cannot be flipped again', () => {
  const { d, ids } = duel();
  const [a, b] = pairOf(d, d.cards[4].sym);
  d.flip(ids[0], a);
  d.flip(ids[0], b);
  const me = d.players.get(ids[0]);
  assert.equal(me.matched, 1);
  assert.equal(me.score, MEMORY.PAIR_POINTS);
  assert.equal(d.currentId(), ids[0], 'a match keeps the turn');
  assert.equal(d.cards[a].matched, true);
  assert.deepEqual(d.flip(ids[0], a), { ok: false, why: 'matched' });
});

test('memory: a miss resolves after a beat and passes the turn', () => {
  const { d, ids } = duel();
  const symA = d.cards[0].sym;
  const mismatch = d.cards.findIndex((c) => c.sym !== symA);
  d.flip(ids[0], 0);
  d.flip(ids[0], mismatch);
  assert.equal(d.resolveIn, MEMORY.RESOLVE_TICKS, 'two open tiles pause for the reveal');
  assert.equal(d.cards[0].matched, false);
  for (let i = 0; i < MEMORY.RESOLVE_TICKS; i++) d.step();
  assert.equal(d.currentId(), ids[1], 'turn passes after the miss resolves');
  assert.equal(d.players.get(ids[0]).misses, 1);
  assert.equal(d.open.length, 0, 'both tiles close again');
});

test('memory: streaks pay a bonus and reset on a miss', () => {
  const { d, ids } = duel();
  const me = d.players.get(ids[0]);
  const syms = [...new Set(d.cards.map((c) => c.sym))];
  for (const sym of syms.slice(0, 2)) {
    const [a, b] = pairOf(d, sym);
    d.flip(ids[0], a);
    d.flip(ids[0], b);
  }
  assert.equal(me.matched, 2);
  assert.ok(me.score > MEMORY.PAIR_POINTS * 2, `streak bonus expected, got ${me.score}`);
  assert.equal(me.streak, 2);
  assert.equal(me.best, 2);
});

test('memory: dangling on one tile forfeits the turn', () => {
  const { d, ids } = duel();
  d.flip(ids[0], 1);
  for (let i = 0; i < MEMORY.TURN_TICKS; i++) d.step();
  assert.equal(d.currentId(), ids[1]);
  assert.equal(d.open.length, 0);
});

test('memory: three seats rotate in order', () => {
  const { d, ids } = duel(3);
  const symA = d.cards[0].sym;
  const mismatch = d.cards.findIndex((c) => c.sym !== symA);
  d.flip(ids[0], 0);
  d.flip(ids[0], mismatch);
  for (let i = 0; i <= MEMORY.RESOLVE_TICKS; i++) d.step();
  assert.equal(d.currentId(), ids[1]);
  d.flip(ids[1], 2);
  for (let i = 0; i < MEMORY.TURN_TICKS; i++) d.step();
  assert.equal(d.currentId(), ids[2]);
});

test('memory: clearing the board ends the match with the leader on top', () => {
  const { d, ids } = duel();
  for (const sym of new Set(d.cards.map((c) => c.sym))) {
    const [a, b] = pairOf(d, sym);
    d.flip(ids[0], a);
    if (!d.over) d.flip(d.currentId(), b);
    if (d.over) break;
  }
  assert.ok(d.over, 'board gets cleared and the match ends');
  assert.equal(d.winnerId, ids[0]);
  assert.equal(d.standings()[0].id, ids[0]);
});

test('memory: a player leaving reshuffles whose turn it is', () => {
  const { d, ids } = duel();
  d.removePlayer(ids[1]);
  assert.equal(d.order.length, 1);
  assert.equal(d.currentId(), ids[0]);
  d.addPlayer('p9', { name: 'Substitute' });
  assert.equal(d.order.length, 2);
});

test('memory: snapshots hide faces from the other player', () => {
  const { d, ids } = duel();
  d.flip(ids[0], 5);
  const forMe = d.snapshot(ids[0]);
  const forYou = d.snapshot(ids[1]);
  assert.equal(forMe.open.length, 1);
  assert.equal(forYou.open.length, 1, 'both need to see which tile is up');
  assert.equal(forMe.cards[5].sym, d.cards[5].sym, 'the flipper sees their own tile');
  assert.equal(forYou.cards[5].sym, d.cards[5].sym, 'an open tile is public');
  const hidden = forYou.cards.find((c, i) => !c.matched && !forYou.open.includes(i) && c.seen === 0);
  assert.equal(hidden.sym, '', 'seen-but-closed tiles stay hidden from the rival');
  assert.equal(forYou.players.length, 2);
  assert.equal(JSON.parse(JSON.stringify(d)).cards.length, d.cards.length, 'state survives JSON round-trip');
});
