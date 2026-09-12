// Memory Match Duel - 4x4 grid, alternate turns, match to keep the turn.
import { makeRng, randomSeed } from './rng.js';

export const MEMORY = {
  SYMBOLS: ['⚡', '✦', '◆', '▲', '✚', '☾', '❋', '♆'],
  TICK_HZ: 20,
  PAIR_POINTS: 100,
  STREAK_BONUS: 25,
  MISS_PENALTY: 0,
  TURN_TICKS: 60, // 3s to line up a second card
  RESOLVE_TICKS: 7,
};

export class MemoryDuel {
  constructor(opts = {}) {
    this.cfg = { ...MEMORY, ...opts.cfg };
    this.rng = makeRng(opts.seed ?? randomSeed());
    this.tick = 0;
    this.cards = this.buildDeck();
    this.players = new Map();
    this.order = [];
    this.turn = 0;
    this.open = []; // indices currently face up
    this.resolveIn = 0;
    this.over = false;
    this.winnerId = null;
    this.events = [];
    this.history = [];
  }

  buildDeck() {
    const pairs = this.cfg.SYMBOLS.slice(0, 8);
    const deck = this.rng.shuffle([...pairs, ...pairs]);
    return deck.map((sym, i) => ({ i, sym, matched: false, seen: false, flipTick: 0 }));
  }

  addPlayer(id, meta = {}) {
    const player = {
      id,
      name: meta.name || `Player ${this.players.size + 1}`,
      hue: meta.hue ?? (this.players.size === 0 ? 188 : 312),
      bot: !!meta.bot,
      score: 0,
      matched: 0,
      misses: 0,
      streak: 0,
      best: 0,
    };
    this.players.set(id, player);
    this.order.push(id);
    this.events.push({ k: 'joined', id });
    return player;
  }

  removePlayer(id) {
    if (!this.players.has(id)) return;
    this.players.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.turn = this.turn % Math.max(1, this.order.length);
    this.events.push({ k: 'left', id });
  }

  ready() {
    return this.order.length >= 2;
  }

  currentId() {
    return this.order[this.turn % this.order.length];
  }

  isTurn(id) {
    return this.currentId() === id;
  }

  flip(id, idx) {
    this.events.length = 0;
    if (this.over) return { ok: false, why: 'over' };
    if (!this.ready()) return { ok: false, why: 'waiting' };
    if (!this.isTurn(id)) return { ok: false, why: 'not-your-turn' };
    if (this.resolveIn > 0) return { ok: false, why: 'resolving' };
    const card = this.cards[idx];
    if (!card) return { ok: false, why: 'no-such-card' };
    if (card.matched) return { ok: false, why: 'matched' };
    if (this.open.includes(idx)) return { ok: false, why: 'already-open' };
    if (this.open.length === 2) return { ok: false, why: 'too-many' };

    card.seen = true;
    card.flipTick = this.tick;
    this.open.push(idx);
    this.turnTicks = 0;
    const player = this.players.get(id);
    this.events.push({ k: 'flip', id, idx, sym: card.sym });

    if (this.open.length === 2) {
      const [a, b] = this.open.map((i) => this.cards[i]);
      if (a.sym === b.sym) this.resolveMatch(player, a, b);
      else this.resolveIn = this.cfg.RESOLVE_TICKS;
    }
    return { ok: true };
  }

  resolveMatch(player, a, b) {
    for (const c of [a, b]) c.matched = true;
    player.matched += 1;
    player.streak += 1;
    player.best = Math.max(player.best, player.streak);
    player.score += this.cfg.PAIR_POINTS + Math.max(0, player.streak - 1) * this.cfg.STREAK_BONUS;
    this.open = [];
    this.resolveIn = 0;
    this.events.push({ k: 'match', id: player.id, a: a.i, b: b.i, sym: a.sym, score: player.score, streak: player.streak });
    this.history.push({ id: player.id, match: true });
    if (this.cards.every((c) => c.matched)) this.finish('cleared');
  }

  endTurn(swap = true) {
    for (const i of this.open) this.cards[i].flipTick = -1;
    this.open = [];
    if (swap) this.turn = (this.turn + 1) % this.order.length;
    this.turnTicks = 0;
    this.events.push({ k: 'turn', id: this.currentId() });
  }

  step() {
    this.tick += 1;
    if (this.over) return this.events.splice(0);
    this.turnTicks = (this.turnTicks || 0) + 1;
    if (this.resolveIn > 0) {
      this.resolveIn -= 1;
      if (this.resolveIn === 0) {
        const loser = this.players.get(this.currentId());
        if (loser) {
          loser.misses += 1;
          loser.streak = 0;
          if (this.cfg.MISS_PENALTY) loser.score = Math.max(0, loser.score - this.cfg.MISS_PENALTY);
          this.history.push({ id: loser.id, match: false });
          this.events.push({ k: 'miss', id: loser.id, a: this.open[0], b: this.open[1] });
        }
        this.endTurn(true);
      }
      return this.events.slice();
    }
    // let a card dangle only so long, then close it and pass the turn
    if (this.open.length === 1 && this.turnTicks >= this.cfg.TURN_TICKS) {
      this.events.push({ k: 'timeout', id: this.currentId() });
      this.endTurn(true);
    }
    return this.events.slice();
  }

  finish(reason) {
    if (this.over) return;
    this.over = true;
    this.winnerId = this.standings()[0]?.id ?? null;
    this.events.push({ k: 'over', reason });
  }

  standings() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, score: p.score, matched: p.matched, misses: p.misses, best: p.best }))
      .sort((a, b) => b.score - a.score || b.matched - a.matched || a.misses - b.misses);
  }

  snapshot(forId = null) {
    return {
      t: this.tick,
      over: this.over,
      winner: this.winnerId,
      turn: this.currentId(),
      turnTicks: this.turnTicks || 0,
      turnBudget: this.cfg.TURN_TICKS,
      open: this.open.slice(),
      resolveIn: this.resolveIn,
      cards: this.cards.map((c) => ({
        i: c.i,
        matched: c.matched ? 1 : 0,
        // only expose the face when it should be visible to this viewer
        sym: c.matched || this.open.includes(c.i) || (forId && this.players.get(forId)?.bot === false && c.seen && this.over) ? c.sym : '',
        seen: c.seen ? 1 : 0,
      })),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        n: p.name,
        h: p.hue,
        score: p.score,
        matched: p.matched,
        misses: p.misses,
        streak: p.streak,
        bot: p.bot ? 1 : 0,
      })),
      left: this.cards.filter((c) => !c.matched).length,
    };
  }
}
