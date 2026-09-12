// 2048 - classic rules. Solo locally, or mirrored against a rival in Versus mode.
import { makeRng, randomSeed } from './rng.js';

export const G2048 = { SIZE: 4, WIN_TILE: 2048 };
export const MOVES = { up: -4, down: 4, left: -1, right: 1 };

export class Grid2048 {
  constructor(opts = {}) {
    this.size = opts.size ?? G2048.SIZE;
    this.rng = makeRng(opts.seed ?? randomSeed());
    this.cells = new Array(this.size * this.size).fill(0);
    this.score = 0;
    this.moves = 0;
    this.won = false;
    this.over = false;
    this.spawn();
    this.spawn();
  }

  idx(r, c) {
    return r * this.size + c;
  }

  empties() {
    const out = [];
    this.cells.forEach((v, i) => v === 0 && out.push(i));
    return out;
  }

  spawn(value = 0) {
    const free = this.empties();
    if (!free.length) return -1;
    const i = free[this.rng.int(free.length)];
    this.cells[i] = value || (this.rng.bool(0.9) ? 2 : 4);
    return i;
  }

  maxTile() {
    return Math.max(...this.cells);
  }

  // dir: 'up' | 'down' | 'left' | 'right'
  move(dir) {
    if (this.over || !MOVES[dir]) return { moved: false, gained: 0, merges: [] };
    const vertical = dir === 'up' || dir === 'down';
    const backwards = dir === 'down' || dir === 'right';
    const size = this.size;
    const next = this.cells.slice();
    const merges = [];
    let gained = 0;
    let moved = false;

    for (let line = 0; line < size; line++) {
      const cells = [];
      for (let k = 0; k < size; k++) cells.push(vertical ? this.cells[this.idx(k, line)] : this.cells[this.idx(line, k)]);
      if (backwards) cells.reverse();

      const packed = cells.filter((v) => v !== 0);
      const row = [];
      for (let i = 0; i < packed.length; i++) {
        if (packed[i] === packed[i + 1]) {
          const val = packed[i] * 2;
          row.push(val);
          gained += val;
          merges.push({ value: val, line, pos: row.length - 1 });
          if (val >= G2048.WIN_TILE) this.won = true;
          i++;
        } else {
          row.push(packed[i]);
        }
      }
      while (row.length < size) row.push(0);
      if (backwards) row.reverse();
      for (let k = 0; k < size; k++) {
        const target = vertical ? this.idx(k, line) : this.idx(line, k);
        if (next[target] !== row[k]) moved = true;
        next[target] = row[k];
      }
    }

    if (!moved) return { moved: false, gained: 0, merges: [] };
    this.cells = next;
    this.score += gained;
    this.moves += 1;
    const spawned = this.spawn();
    if (!this.canMove()) this.over = true;
    return { moved: true, gained, merges, spawn: { i: spawned, value: this.cells[spawned] } };
  }

  canMove() {
    if (this.empties().length) return true;
    const size = this.size;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const v = this.cells[this.idx(r, c)];
        if (c + 1 < size && this.cells[this.idx(r, c + 1)] === v) return true;
        if (r + 1 < size && this.cells[this.idx(r + 1, c)] === v) return true;
      }
    }
    return false;
  }

  grid() {
    const rows = [];
    for (let r = 0; r < this.size; r++) rows.push(this.cells.slice(r * this.size, (r + 1) * this.size));
    return rows;
  }

  static fromRows(rows, seed) {
    const g = new Grid2048({ size: rows.length, seed });
    g.cells = rows.flat();
    g.score = 0;
    g.over = !g.canMove();
    return g;
  }

  snapshot() {
    return { grid: this.grid(), score: this.score, moves: this.moves, max: this.maxTile(), over: this.over, won: this.won };
  }
}

// Versus referee: each client plays its own board locally and reports its state.
// The server relays rival progress and calls the race, with plausibility checks so
// a tab cannot claim a 1e12 score. Casual-grade fairness, not a security boundary.
export class Versus2048 {
  constructor(opts = {}) {
    this.cfg = { ...G2048, ...opts.cfg };
    this.players = new Map();
    this.over = false;
    this.winnerId = null;
    this.events = [];
    this.startedAt = Date.now();
  }

  addPlayer(id, meta = {}) {
    const p = {
      id,
      name: meta.name || `Player ${this.players.size + 1}`,
      hue: meta.hue ?? (this.players.size === 0 ? 188 : 312),
      bot: !!meta.bot,
      score: 0,
      max: 0,
      moves: 0,
      over: false,
      won: false,
      grid: null,
      lastAt: Date.now(),
    };
    this.players.set(id, p);
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    if ([...this.players.values()].filter((p) => !p.bot).length <= 1 && !this.over) {
      const left = [...this.players.values()].find((p) => !p.bot);
      if (left && this.players.size === 1) this.finish(left.id, 'forfeit');
    }
  }

  // Accept a reported board. Returns false when the numbers do not add up.
  report(id, state) {
    const p = this.players.get(id);
    if (!p || this.over || !state) return false;
    const score = Number(state.score) || 0;
    const moves = Number(state.moves) || 0;
    const max = Number(state.max) || 0;
    const delta = moves - p.moves;
    if (score < p.score || delta < 0) return false;
    if (delta === 0 && score > p.score) return false; // no free points without a move
    // the first report from a board that was already in play establishes a
    // baseline; after that, exactly one move per message or it is refused
    if (delta > 1 && p.moves !== 0) return false;
    if (moves > 100000) return false;
    if (max && (max & (max - 1)) !== 0) return false; // tile values are powers of two
    if (score > 1_000_000 || score > 4096 * Math.max(1, moves)) return false;
    p.score = score;
    p.moves = moves;
    p.max = Math.max(p.max, max);
    p.over = !!state.over;
    p.won = p.won || max >= this.cfg.WIN_TILE;
    p.grid = Array.isArray(state.grid) ? state.grid.map((row) => row.map((v) => clampTile(v))) : p.grid;
    p.lastAt = Date.now();
    this.events.push({ k: 'progress', id, score: p.score, max: p.max, moves: p.moves });
    if (p.won) this.finish(p.id, 'reach2048');
    else {
      const humans = [...this.players.values()].filter((q) => !q.bot);
      if (humans.length >= 2 && humans.every((q) => q.over)) {
        const best = humans.slice().sort((a, b) => b.score - a.score)[0];
        this.finish(best.id, 'both-stuck');
      }
    }
    return true;
  }

  finish(id, reason) {
    if (this.over) return;
    this.over = true;
    this.winnerId = id;
    this.events.push({ k: 'over', reason, id });
  }

  standings() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, score: p.score, max: p.max, moves: p.moves, over: p.over, won: p.won }))
      .sort((a, b) => b.score - a.score || b.max - a.max);
  }

  snapshot() {
    return {
      over: this.over,
      winner: this.winnerId,
      seconds: Math.round((Date.now() - this.startedAt) / 1000),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        n: p.name,
        h: p.hue,
        score: p.score,
        max: p.max,
        moves: p.moves,
        over: p.over ? 1 : 0,
        won: p.won ? 1 : 0,
        grid: p.grid,
        bot: p.bot ? 1 : 0,
        lag: Date.now() - p.lastAt,
      })),
    };
  }
}

function clampTile(v) {
  const n = Math.max(0, Math.min(131072, Math.floor(Number(v) || 0)));
  return (n & (n - 1)) === 0 || n === 0 ? n : 0;
}
