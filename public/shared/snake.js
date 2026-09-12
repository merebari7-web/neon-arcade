// Snake Battle - free-for-all arena.
// Pure + deterministic: the server runs one of these to be authoritative, and the
// browser runs one of these for solo/CPU practice. Same rules either way.
import { makeRng, randomSeed } from './rng.js';

export const SNAKE = {
  W: 40,
  H: 24,
  TICK_HZ: 15,
  START_LEN: 4,
  MAX_PLAYERS: 8,
  FOOD_TARGET: 9,
  FOOD_POINTS: 10,
  KILL_POINTS: 75,
  RESPAWN_TICKS: 24,
  WIN_SCORE: 750,
  ROUND_TICKS: SNAKE_TICKS(120), // 120 second rounds
};

const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

function SNAKE_TICKS(seconds) {
  return 15 * seconds;
}

export class SnakeArena {
  constructor(opts = {}) {
    this.cfg = { ...SNAKE, ...opts.cfg };
    this.seed = opts.seed ?? randomSeed();
    this.rng = makeRng(this.seed);
    this.tick = 0;
    this.over = false;
    this.winnerId = null;
    this.food = [];
    this.players = new Map();
    this.events = [];
    for (let i = 0; i < this.cfg.FOOD_TARGET; i++) this.spawnFood();
  }

  // ---- roster -------------------------------------------------------------
  addPlayer(id, meta = {}) {
    const taken = new Set([...this.players.values()].map((p) => p.id));
    let slot = 0;
    while (taken.has(`p${slot}`)) slot++;
    const spawns = this.spawnPoints();
    const spot = spawns[slot % spawns.length];
    const facing = DIRS[spot.dir]; // the vector, not the direction name
    const body = [];
    for (let i = 0; i < this.cfg.START_LEN; i++) {
      body.push({ x: spot.x - facing.x * i, y: spot.y - facing.y * i });
    }
    const player = {
      id,
      name: meta.name || `Player ${slot + 1}`,
      hue: meta.hue ?? (slot * 47) % 360,
      bot: !!meta.bot,
      dir: spot.dir,
      queued: spot.dir,
      body,
      grow: 0,
      alive: true,
      deadFor: 0,
      score: 0,
      kills: 0,
      deaths: 0,
      lastHitBy: null,
      streak: 0,
    };
    this.players.set(id, player);
    this.events.push({ k: 'joined', id, name: player.name });
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.events.push({ k: 'left', id, name: p.name });
  }

  // Cells we start snakes in: four pockets, then mid edges. Keeps openings fair.
  spawnPoints() {
    const { W, H } = this.cfg;
    return [
      { x: 6, y: 6, dir: 'right' },
      { x: W - 7, y: H - 7, dir: 'left' },
      { x: 6, y: H - 7, dir: 'up' },
      { x: W - 7, y: 6, dir: 'down' },
      { x: Math.floor(W / 2), y: 4, dir: 'left' },
      { x: Math.floor(W / 2), y: H - 5, dir: 'right' },
      { x: 4, y: Math.floor(H / 2), dir: 'down' },
      { x: W - 5, y: Math.floor(H / 2), dir: 'up' },
    ];
  }

  // ---- input --------------------------------------------------------------
  steer(id, dir) {
    const p = this.players.get(id);
    if (!p || !DIRS[dir]) return false;
    // One turn per tick: compare against the direction actually moving.
    if (dir === OPPOSITE[p.dir] || dir === p.dir) return false;
    p.queued = dir;
    return true;
  }

  // ---- world --------------------------------------------------------------
  occupied() {
    const map = new Map(); // "x,y" -> { id, head }
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      p.body.forEach((c, i) => {
        if (!map.has(`${c.x},${c.y}`)) map.set(`${c.x},${c.y}`, { id: p.id, head: i === 0 });
      });
    }
    return map;
  }

  freeCells() {
    const busy = this.occupied();
    for (const f of this.food) busy.set(`${f.x},${f.y}`, { id: 'food' });
    const free = [];
    for (let y = 0; y < this.cfg.H; y++) {
      for (let x = 0; x < this.cfg.W; x++) {
        if (!busy.has(`${x},${y}`)) free.push({ x, y });
      }
    }
    return free;
  }

  spawnFood() {
    const free = this.freeCells();
    if (!free.length) return null;
    const cell = free[this.rng.int(free.length)];
    const golden = this.rng.bool(0.12);
    const item = { x: cell.x, y: cell.y, golden, points: golden ? 40 : this.cfg.FOOD_POINTS };
    this.food.push(item);
    return item;
  }

  respawn(p) {
    const spots = this.spawnPoints().filter((s) => !this.occupied().has(`${s.x},${s.y}`));
    const spot = spots.length ? this.rng.pick(spots) : this.spawnPoints()[0];
    const facing = DIRS[spot.dir];
    p.body = [];
    for (let i = 0; i < this.cfg.START_LEN; i++) p.body.push({ x: spot.x - facing.x * i, y: spot.y - facing.y * i });
    p.dir = spot.dir;
    p.queued = spot.dir;
    p.alive = true;
    p.deadFor = 0;
    p.grow = 0;
    p.streak = 0;
    this.events.push({ k: 'respawn', id: p.id });
  }

  kill(p, causeId) {
    if (!p.alive) return;
    p.alive = false;
    p.deadFor = 0;
    p.deaths += 1;
    p.streak = 0;
    let credit = causeId && causeId !== p.id ? this.players.get(causeId) : null;
    if (!credit && p.lastHitBy && p.lastHitBy !== p.id) credit = this.players.get(p.lastHitBy);
    if (credit) {
      credit.kills += 1;
      credit.score += this.cfg.KILL_POINTS;
      credit.streak += 1;
      this.events.push({ k: 'kill', by: credit.id, victim: p.id, points: this.cfg.KILL_POINTS });
    } else {
      this.events.push({ k: 'crash', id: p.id });
    }
  }

  step() {
    if (this.over) return this.events.splice(0);
    this.tick += 1;
    this.events.length = 0;
    const occ = this.occupied();

    for (const p of this.players.values()) {
      if (!p.alive) {
        p.deadFor += 1;
        if (p.deadFor >= this.cfg.RESPAWN_TICKS) this.respawn(p);
        continue;
      }
      if (DIRS[p.queued] && p.queued !== OPPOSITE[p.dir]) p.dir = p.queued;
      const v = DIRS[p.dir];
      const head = { x: p.body[0].x + v.x, y: p.body[0].y + v.y };

      if (head.x < 0 || head.y < 0 || head.x >= this.cfg.W || head.y >= this.cfg.H) {
        this.kill(p, null);
        continue;
      }
      const blocker = occ.get(`${head.x},${head.y}`);
      const tail = p.body[p.body.length - 1];
      const tailMoving = p.grow === 0 && tail.x === head.x && tail.y === head.y;
      if (blocker && !(blocker.id === p.id && tailMoving)) {
        if (blocker.id !== p.id) {
          const other = this.players.get(blocker.id);
          if (other) other.lastHitBy = other.lastHitBy ?? p.id;
        }
        this.kill(p, blocker.id);
        continue;
      }

      p.body.unshift(head);
      const fi = this.food.findIndex((f) => f.x === head.x && f.y === head.y);
      if (fi >= 0) {
        const eaten = this.food.splice(fi, 1)[0];
        p.score += eaten.points;
        p.streak += 1;
        p.grow += 1; // one unshifted head with no tail pop == one new segment
        if (p.streak % 5 === 0) p.grow += 2; // streak bonus bulk
        this.events.push({ k: 'eat', id: p.id, x: head.x, y: head.y, points: eaten.points, golden: eaten.golden });
        this.spawnFood();
      }
      occ.set(`${head.x},${head.y}`, { id: p.id, head: true });
      if (p.grow > 0) p.grow -= 1;
      else p.body.pop();
    }

    // Golden food rots if nobody claims it, so rounds keep moving.
    if (this.tick % 45 === 0) {
      const stale = this.food.find((f) => f.golden);
      if (stale) {
        this.food.splice(this.food.indexOf(stale), 1);
        this.spawnFood();
      }
    }

    this.checkEnd();
    return this.events.slice();
  }

  checkEnd() {
    const humans = [...this.players.values()].filter((p) => !p.bot);
    const leader = [...this.players.values()].sort((a, b) => b.score - a.score)[0];
    if (leader && leader.score >= this.cfg.WIN_SCORE) {
      this.over = true;
      this.winnerId = leader.id;
      this.events.push({ k: 'over', reason: 'score' });
    } else if (this.tick >= this.cfg.ROUND_TICKS) {
      this.over = true;
      this.winnerId = leader ? leader.id : null;
      this.events.push({ k: 'over', reason: 'time' });
    } else if (humans.length >= 2 && humans.every((p) => !p.alive)) {
      // everyone still in the round is dead at once: keep it short
      this.over = true;
      const first = [...this.players.values()].sort((a, b) => b.score - a.score)[0];
      this.winnerId = first ? first.id : null;
      this.events.push({ k: 'over', reason: 'wipeout' });
    }
  }

  standings() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, score: p.score, kills: p.kills, deaths: p.deaths, alive: p.alive }))
      .sort((a, b) => b.score - a.score);
  }

  // Small wire format - the client interpolates between snapshots.
  snapshot() {
    return {
      t: this.tick,
      over: this.over,
      winner: this.winnerId,
      timeLeft: Math.max(0, Math.ceil((this.cfg.ROUND_TICKS - this.tick) / this.cfg.TICK_HZ)),
      food: this.food.map((f) => [f.x, f.y, f.golden ? 1 : 0]),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        n: p.name,
        h: p.hue,
        b: p.alive ? p.body.map((c) => [c.x, c.y]) : [],
        d: p.dir,
        s: p.score,
        k: p.kills,
        dl: p.deaths,
        a: p.alive ? 1 : 0,
        r: p.alive ? 0 : Math.max(0, this.cfg.RESPAWN_TICKS - p.deadFor),
        bot: p.bot ? 1 : 0,
      })),
    };
  }
}

export const SNAKE_DIRS = DIRS;
