// CPU opponents. Shared by solo mode (browser) and by online rooms that need a body
// filler ("Add CPU"), so a bot behaves identically wherever it runs.
import { makeRng } from './rng.js';

// ---- Snake ---------------------------------------------------------------
// Greedy toward food, but never walks into a wall, a body, or a square another
// snake is about to occupy. Medium difficulty by construction: it plans 5 cells
// ahead and takes the occasional shortcut.
export function snakeBotDir(arena, player, opts = {}) {
  const rng = opts.rng || arena.rng;
  const { W, H } = arena.cfg;
  const occ = arena.occupied();
  const heads = new Map();
  for (const p of arena.players.values()) {
    if (p.id !== player.id && p.alive) heads.set(`${p.body[0].x},${p.body[0].y}`, p.id);
  }
  const dirs = ['up', 'down', 'left', 'right'];
  const blockedAt = (x, y, selfTailSafe) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return true;
    const key = `${x},${y}`;
    if (selfTailSafe && key === `${player.body[player.body.length - 1].x},${player.body[player.body.length - 1].y}`) return false;
    if (occ.has(key)) return true;
    return false;
  };

  let best = null;
  for (const d of dirs) {
    if (d === opposite(player.dir)) continue;
    const v = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[d];
    const nx = player.body[0].x + v[0];
    const ny = player.body[0].y + v[1];
    if (blockedAt(nx, ny, true)) continue;

    // count survivable cells straight ahead (open corridor)
    let corridor = 0;
    let cx = nx;
    let cy = ny;
    for (let i = 0; i < 5; i++) {
      if (blockedAt(cx + v[0], cy + v[1], false)) break;
      corridor++;
      cx += v[0];
      cy += v[1];
    }
    if (corridor === 0) continue;

    let dist = 999;
    for (const f of arena.food) {
      const dd = Math.abs(f.x - nx) + Math.abs(f.y - ny) - (f.golden ? 3 : 0);
      dist = Math.min(dist, dd);
    }
    // pressure: cut off a rival's head a couple of cells ahead of it
    let pressure = 0;
    for (const [key] of heads) {
      const [hx, hy] = key.split(',').map(Number);
      const intercept = `${hx + (arena.players.get(heads.get(key))?.dir ? dirVec(arena.players.get(heads.get(key)).dir).x : 0)},${hy + (arena.players.get(heads.get(key))?.dir ? dirVec(arena.players.get(heads.get(key)).dir).y : 0)}`;
      if (intercept === `${nx},${ny}`) pressure = 40;
    }

    const score = corridor * 14 - dist * 10 + pressure + rng.next() * 6;
    if (!best || score > best.score) best = { dir: d, score };
  }
  return best ? best.dir : player.dir;
}

function dirVec(d) {
  return { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[d] || [0, 0];
}
function opposite(d) {
  return { up: 'down', down: 'up', left: 'right', right: 'left' }[d];
}

// ---- Breakout ------------------------------------------------------------
// Projects the ball against the side walls to find where it crosses the line.
// Difficulty adds aiming error, so it is beatable.
export function breakoutCpuTarget(duel, player, opts = {}) {
  const rng = opts.rng || duel.rng;
  const { W, PAD_W } = duel.cfg;
  const b = duel.ball;
  const lineY = duel.paddleY(player.side) + (player.side === 'bottom' ? 0 : duel.cfg.PAD_H);
  const skill = opts.skill ?? 0.75;
  const error = (1 - skill) * 150;

  if (b.stuck) return W / 2;
  const goingToMe = player.side === 'bottom' ? b.vy > 0 : b.vy < 0;
  const time = goingToMe ? Math.abs((lineY - b.y) / (b.vy || 1)) : 0;

  let aim = W / 2;
  if (goingToMe && time > 0) {
    let x = b.x + b.vx * time;
    const span = W - b.r * 2;
    // fold the trajectory across the walls
    let folded = ((x - b.r) % (span * 2) + span * 2) % (span * 2);
    if (folded > span) folded = span * 2 - folded;
    x = folded + b.r;
    aim = x + (rng.next() - 0.5) * error;
    // hit the wall a touch off-centre so the return angle keeps changing
    if (duel.liveBricks().length && rng.bool(0.35)) aim += (rng.next() - 0.5) * 26;
  } else if (!goingToMe) {
    // ball is on the rival's side: shadow it, ready to catch a rebound
    aim = b.x + (rng.next() - 0.5) * error * 1.5;
  }
  const half = PAD_W / 2;
  return Math.max(half, Math.min(W - half, aim));
}

// ---- Memory --------------------------------------------------------------
// Remembers everything it has seen (as a human would) and takes free pairs.
export function memoryCpuFlip(duel, playerId, seenByCpu) {
  const rng = duel.rng;
  const unknown = [];
  const bySym = new Map();
  for (const c of duel.cards) {
    if (c.matched) continue;
    const isFlipping = duel.open.includes(c.i);
    if (c.seen || seenByCpu.has(c.i)) {
      if (!bySym.has(c.sym)) bySym.set(c.sym, []);
      bySym.get(c.sym).push(c.i);
    }
    if (!isFlipping) unknown.push(c.i);
  }
  for (const [sym, list] of bySym) {
    if (duel.open.length === 1) {
      // the player exposed a tile: finish the pair if we know where its twin is
      const openIdx = duel.open[0];
      if (duel.cards[openIdx].sym === sym) {
        const partner = list.find((i) => i !== openIdx && !duel.open.includes(i));
        if (partner != null) return { idx: partner, why: 'complete-pair' };
      }
      continue;
    }
    const live = list.filter((i) => !duel.open.includes(i));
    if (live.length >= 2) return { idx: live[0], why: 'known-pair' };
  }
  if (duel.open.length === 1) {
    const fresh = unknown.filter((i) => !seenByCpu.has(i) && i !== duel.open[0]);
    const pool = fresh.length ? fresh : unknown.filter((i) => i !== duel.open[0]);
    return { idx: rng.pick(pool), why: 'guess' };
  }
  const first = unknown.length ? rng.pick(unknown) : 0;
  return { idx: first, why: 'open' };
}

// ---- 2048 ----------------------------------------------------------------
// One-ply search with corner/monotonicity heuristics, plus a little noise so the
// CPU is strong-but-not-soulless. Also reused for the online "ghost".
export function g2048CpuMove(grid, opts = {}) {
  const rng = opts.rng || makeRng((opts.seed ?? Date.now()) >>> 0);
  const size = grid.size;
  let best = null;
  for (const dir of ['up', 'down', 'left', 'right']) {
    const trial = new grid.constructor({ size, seed: 1 });
    trial.cells = grid.cells.slice();
    trial.score = 0;
    trial.won = true; // don't trip win logic in the sandbox
    const res = trial.move(dir);
    if (!res.moved) continue;
    // reward board quality, and weight the immediate merge gain
    const score = boardHeuristic(trial.cells, size) + res.gained * 1.4 + rng.next() * (opts.noise ?? 40);
    if (!best || score > best.score) best = { dir, score };
  }
  return best ? best.dir : null;
}

export function boardHeuristic(cells, size) {
  let empty = 0;
  let mono = 0;
  let smooth = 0;
  for (const v of cells) if (v === 0) empty++;
  for (let r = 0; r < size; r++) {
    let prev = 0;
    for (let c = 0; c < size; c++) {
      const v = cells[r * size + c];
      if (v > prev) mono += v;
      if (prev) smooth -= Math.abs(v - prev);
      prev = v;
    }
    prev = 0;
    for (let c = size - 1; c >= 0; c--) {
      const v = cells[r * size + c];
      if (v > prev) mono += v * 0.5;
      if (prev) smooth -= Math.abs(v - prev);
      prev = v;
    }
  }
  for (let c = 0; c < size; c++) {
    let prev = 0;
    for (let r = 0; r < size; r++) {
      const v = cells[r * size + c];
      if (prev) smooth -= Math.abs(v - prev);
      prev = v;
    }
  }
  const corner = cells[0] * 4 + cells[size - 1] * 2 + cells[size * (size - 1)] * 2;
  return empty * 160 + mono * 0.5 + smooth * 1.2 + corner;
}
