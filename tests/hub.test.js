// End-to-end multiplayer: boots the real server on a random port, drives it with
// two (and three) real WebSocket clients, and checks they stay in sync.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { connect, hello, waitFor } from './helpers.js';

let srv;
let wsUrl;
let dataDir;
const clients = [];

async function client(name, extra = {}) {
  const c = await hello(wsUrl, name, extra);
  clients.push(c);
  return c;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-arcade-test-'));
  srv = await startServer({ port: 0, host: '127.0.0.1', dataDir });
  wsUrl = `ws://127.0.0.1:${srv.port}/ws`;
});

after(async () => {
  for (const c of clients) c.close();
  srv.hub.shutdown();
  srv.leaderboard.flush();
  await new Promise((r) => srv.server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('http: health, info and the client bundle are served', async () => {
  const base = `http://127.0.0.1:${srv.port}`;
  const health = await fetch(`${base}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.equal(typeof health.uptime, 'number');

  const info = await fetch(`${base}/api/info`).then((r) => r.json());
  assert.equal(info.name, 'Neon Arcade');
  assert.deepEqual(info.games.map((g) => g.id).sort(), ['breakout', 'g2048', 'memory', 'snake']);

  const page = await fetch(`${base}/`).then((r) => r.text());
  assert.match(page, /NEON ARCADE/);
  assert.match(page, /Snake Battle/);

  const css = await fetch(`${base}/css/neon.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  // the shared rules module has to be loadable by the browser too
  const rules = await fetch(`${base}/shared/snake.js`);
  assert.equal(rules.status, 200);
  assert.match(rules.headers.get('content-type'), /javascript/);
  assert.match(await rules.text(), /export class SnakeArena/);

  const play = await fetch(`${base}/play.html?game=snake`);
  assert.equal(play.status, 200);

  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
});

test('ws: the welcome packet hands over games, rooms, stats and boards', async () => {
  const c = connect(wsUrl);
  clients.push(c);
  await c.ready;
  const msg = await c.wait('welcome');
  c.send({ t: 'hello', name: 'Welcomed' });
  assert.equal(msg.games.length, 4);
  assert.ok(Array.isArray(msg.rooms));
  assert.equal(typeof msg.online, 'number');
  assert.ok(msg.online >= 1);
  assert.equal(Object.keys(msg.leaderboard).sort().join(','), 'breakout,g2048,memory,snake');
});

test('ws: a room code is 5 unambiguous characters and two players sync', async () => {
  const a = await client('Roomy');
  a.send({ t: 'create', game: 'memory', private: true });
  const joined = await a.wait('joined');
  assert.match(joined.room.id, /^[A-Z2-9]{5}$/);
  assert.equal(joined.room.game, 'memory');
  assert.equal(joined.pid, 'p0');
  assert.equal(joined.room.count, 1);

  const b = await client('Joiner');
  b.send({ t: 'join', code: joined.room.id });
  const bJoined = await b.wait('joined');
  assert.equal(bJoined.room.id, joined.room.id);
  assert.equal(bJoined.pid, 'p1');
  assert.equal(bJoined.room.count, 2);
  assert.deepEqual(bJoined.room.players.map((p) => p.name).sort(), ['Joiner', 'Roomy']);

  // both sides must receive the same authoritative state stream
  const [sa, sb] = await Promise.all([a.wait('state'), b.wait('state')]);
  assert.equal(sa.s.t, sb.s.t);
  assert.equal(sa.s.cards.length, 16);
  assert.equal(sb.s.cards.length, 16);
  assert.equal(sa.s.players.length, 2);
});

test('ws: a bad code and a full room are refused politely', async () => {
  const c = await client('Lost');
  c.send({ t: 'join', code: 'ZZZZZ' });
  const err = await c.wait('err');
  assert.match(err.m, /No room ZZZZZ/);

  const a = await client('Host2');
  a.send({ t: 'create', game: 'memory', private: true });
  const { room } = await a.wait('joined');
  const b = await client('Guest2');
  b.send({ t: 'join', code: room.id });
  await b.wait('joined');
  const c2 = await client('Squeezed');
  c2.send({ t: 'join', code: room.id });
  const full = await c2.wait('err');
  assert.match(full.m, /full/);
});

test('ws: only the player on turn can flip, and the rival sees the tile', async () => {
  const a = await client('FlipHost');
  a.send({ t: 'create', game: 'memory', private: true });
  const ja = await a.wait('joined');
  const b = await client('FlipGuest');
  b.send({ t: 'join', code: ja.room.id });
  const jb = await b.wait('joined');
  // the host seats first, so the guest may not act yet
  const turnState = await b.wait('state');
  assert.equal(turnState.s.turn, ja.pid, 'host starts');
  assert.notEqual(jb.pid, ja.pid);

  b.send({ t: 'input', idx: 4 });
  await new Promise((r) => setTimeout(r, 500));
  const guestStates = b.drain().filter((m) => m.t === 'state');
  assert.ok(guestStates.length > 0, 'the stream keeps running');
  for (const st of guestStates) assert.ok(!st.s.open.includes(4), 'an out-of-turn flip must not register');

  a.send({ t: 'input', idx: 7 });
  const seenByGuest = await b.until((m) => (m.t === 'state' && m.s.open.includes(7) ? m : false), 2500);
  const face = seenByGuest.s.cards[7].sym;
  assert.ok(face, 'the host flip reaches the guest, face included');
  // hidden information: the guest is told WHICH tile is up, and its face, but never its twin
  const visible = seenByGuest.s.cards.filter((card) => card.sym === face);
  assert.equal(visible.length, 1, 'only the flipped tile leaks its symbol');
  assert.equal(seenByGuest.s.cards.filter((card) => !card.matched && !seenByGuest.s.open.includes(card.i) && card.sym).length, 0, 'closed tiles stay blank on the wire');
  const room = srv.hub.rooms.get(ja.room.id);
  assert.equal(room.game.cards.filter((card) => card.sym === face).length, 2, 'a real twin exists server-side');
});

test('ws: chat reaches the room and the lobby ticker', async () => {
  const a = await client('Chatty');
  a.send({ t: 'create', game: 'snake', private: true });
  const { room } = await a.wait('joined');
  const b = await client('Listener');
  b.send({ t: 'join', code: room.id });
  await b.wait('joined');
  a.send({ t: 'chat', text: 'gg in advance' });
  const msg = await b.until((m) => (m.t === 'chat' && m.text === 'gg in advance' ? m : false), 2500);
  assert.equal(msg.text, 'gg in advance');
  assert.equal(msg.from, 'Chatty');
});

test('ws: snake room runs a real authoritative loop with a cpu fill', async () => {
  const a = await client('SnakeHost');
  a.send({ t: 'create', game: 'snake', vsCpu: true });
  const joined = await a.wait('joined');
  assert.match(joined.room.id, /^[A-Z2-9]{5}$/);
  const first = await a.wait('state');
  assert.ok(first.s.players.length >= 2, 'cpu should fill an empty arena');
  const ticks = [first.s.t];
  for (let i = 0; i < 12; i++) {
    const s = await a.wait('state', 2000);
    ticks.push(s.s.t);
  }
  assert.ok(ticks[ticks.length - 1] > ticks[0], `arena must advance: ${ticks.join('>')}`);
  const uniq = new Set(ticks);
  assert.ok(uniq.size > 5, 'state should update every tick, not stall');
  for (const s of uniq) {
    const st = [...ticks].find((t) => t === s);
    assert.equal(typeof st, 'number');
  }
  const mine = first.s.players.find((p) => p.bot !== 1);
  assert.ok(mine, 'the host has a snake in the arena');
  assert.equal(mine.a, 1);
  assert.ok(mine.b.length >= 4, 'a fresh snake is 4 cells long');
});

test('ws: input moves my own snake on the server', async () => {
  const a = await client('Steerer');
  a.send({ t: 'create', game: 'snake', vsCpu: true });
  const j = await a.wait('joined');
  const before = await a.wait('state');
  const me = before.s.players.find((p) => p.id === j.pid);
  const heading = me.d;
  const turn = { up: 'left', left: 'down', down: 'right', right: 'up' }[heading];
  a.send({ t: 'input', dir: turn });
  const after2 = await a.until((m) => {
    if (m.t !== 'state') return false;
    const p = m.s.players.find((q) => q.id === j.pid);
    return p && p.d === turn ? m : false;
  }, 2500);
  assert.ok(after2, 'the server should adopt the new heading');
});

test('ws: 2048 versus relays reported progress to the rival and refuses nonsense', async () => {
  const a = await client('RaceA');
  a.send({ t: 'create', game: 'g2048', private: true });
  const { room } = await a.wait('joined');
  const b = await client('RaceB');
  b.send({ t: 'join', code: room.id });
  await b.wait('joined');

  a.send({ t: 'input', state: { score: 24, moves: 3, max: 8, grid: [[2, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 2]] } });
  const relayed = await b.until((m) => {
    if (m.t !== 'state') return false;
    const other = m.s.players.find((p) => p.n === 'RaceA');
    return other && other.score === 24 ? m : false;
  }, 2500);
  assert.ok(relayed.s.players.find((p) => p.n === 'RaceA').grid.length === 4, 'rival board is mirrored live');

  // an impossible jump must not land on the rival's screen
  a.send({ t: 'input', state: { score: 999999, moves: 4, max: 1024 } });
  await new Promise((r) => setTimeout(r, 350));
  const states = b.drain().filter((m) => m.t === 'state');
  for (const s of states) {
    const other = s.s.players.find((p) => p.n === 'RaceA');
    if (other) assert.ok(other.score < 1000, `cheating report leaked: ${other.score}`);
  }
});

test('ws: a finished round sends results, then restarts on request', async () => {
  const a = await client('Finisher');
  a.send({ t: 'create', game: 'memory', private: true, vsCpu: true });
  const j = await a.wait('joined');
  await a.wait('state');

  // white-box: end the match from the authoritative side so we test the wire, not the puzzle
  const room = srv.hub.rooms.get(j.room.id);
  assert.ok(room, 'room exists on the server');
  for (const card of room.game.cards) card.matched = true;
  room.game.finish('cleared');

  const over = await a.wait('roundOver', 3000);
  assert.equal(over.game, 'memory');
  assert.ok(Array.isArray(over.results) && over.results.length >= 1);
  assert.ok(over.results[0].name);

  a.send({ t: 'restart' });
  const restarted = await a.wait('restarted', 3000);
  assert.equal(restarted.info.game, 'memory');
  const fresh = await a.wait('state', 3000);
  assert.ok(fresh.s.cards.every((card) => card.matched === 0), 'a new board is shuffled and face down');
});

test('ws: a breakout round ends over the wire with readable results', async () => {
  const a = await client('Duelist');
  a.send({ t: 'create', game: 'breakout', private: true, vsCpu: true });
  const j = await a.wait('joined');
  await a.wait('state');
  const room = srv.hub.rooms.get(j.room.id);
  assert.ok(room && room.gameId === 'breakout');
  // the shared wall is what ends the match
  for (const brick of room.game.bricks) brick.hp = 0;
  const over = await a.wait('roundOver', 4000);
  assert.equal(over.game, 'breakout');
  assert.ok(over.results.length >= 1, 'at least one row');
  const line = JSON.stringify(over.results);
  assert.ok(!/undefined|NaN/.test(line), `results leaked a missing field: ${line}`);
  assert.match(over.results[0].sub, /bricks/);
  assert.equal(over.winner, over.results[0].name);
  // and the winner's score reached the leaderboard
  await waitFor(async () => {
    const board = await fetch(`http://127.0.0.1:${srv.port}/api/leaderboard`).then((r) => r.json());
    return board.board.breakout.some((row) => row.name === 'Duelist');
  }, 4000, 'breakout board row');
});

test('ws: solo scores land on the server leaderboard and survive a fetch', async () => {
  const a = await client('Scorer');
  a.send({ t: 'score', game: 'g2048', score: 4096, mode: 'solo' });
  await waitFor(async () => {
    const board = await fetch(`http://127.0.0.1:${srv.port}/api/leaderboard`).then((r) => r.json());
    return board.board.g2048.some((row) => row.name === 'Scorer' && row.score === 4096);
  }, 3000, 'leaderboard row');
  const board = await fetch(`http://127.0.0.1:${srv.port}/api/leaderboard`).then((r) => r.json());
  assert.equal(board.board.g2048[0].score, 4096);
  await waitFor(() => fs.existsSync(srv.leaderboard.file), 4000, 'leaderboard file');
  const saved = JSON.parse(fs.readFileSync(srv.leaderboard.file, 'utf8'));
  assert.ok(saved.g2048.some((row) => row.name === 'Scorer'), 'the saved file contains the row');
  // nonsense scores are ignored
  a.send({ t: 'score', game: 'g2048', score: -5 });
  a.send({ t: 'score', game: 'bogus', score: 10 });
  await new Promise((r) => setTimeout(r, 150));
  const after = await fetch(`http://127.0.0.1:${srv.port}/api/leaderboard`).then((r) => r.json());
  assert.ok(after.board.g2048.every((row) => row.score > 0));
});

test('ws: leaving a room updates the public list and closing the socket frees the seat', async () => {
  const a = await client('Leaver');
  a.send({ t: 'create', game: 'breakout', private: false });
  const { room } = await a.wait('joined');
  const listed = await waitFor(async () => {
    const { rooms } = await fetch(`http://127.0.0.1:${srv.port}/api/rooms`).then((r) => r.json());
    return rooms.find((r2) => r2.id === room.id) || false;
  }, 3000, 'room in list');
  assert.equal(listed.game, 'breakout');
  assert.ok(!listed.solo, 'public rooms are listed');

  a.send({ t: 'leave' });
  await waitFor(async () => {
    const { rooms } = await fetch(`http://127.0.0.1:${srv.port}/api/rooms`).then((r) => r.json());
    return !rooms.some((r2) => r2.id === room.id);
  }, 5000, 'room removed after leave');
});

test('ws: a socket that floods the server gets disconnected', async () => {
  const c = connect(wsUrl);
  clients.push(c);
  await c.ready;
  c.send({ t: 'hello', name: 'Spammer' });
  await c.wait('welcome');
  const closed = new Promise((resolve) => c.sock.on('close', (code) => resolve(code)));
  for (let i = 0; i < 400; i++) c.send({ t: 'input', x: i });
  const code = await Promise.race([closed, new Promise((r) => setTimeout(() => r(null), 3000))]);
  assert.equal(code, 1008, 'a flooding socket is closed with a policy-violation code');
});
