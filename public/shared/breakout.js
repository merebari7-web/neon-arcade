// Breakout Duel - one shared wall, two paddles, one ball.
// Brick credit goes to whoever last hit the ball, so every rally is a race to
// out-hit your rival while never dropping the ball on your own baseline.
import { makeRng, randomSeed } from './rng.js';

export const BREAK = {
  W: 800,
  H: 600,
  TICK_HZ: 60,
  BRICK_COLS: 10,
  BRICK_ROWS: 6,
  BRICK_H: 26,
  WALL_TOP: 0.3, // fraction of field height where the wall starts / ends
  WALL_BOTTOM: 0.62,
  PAD_W: 116,
  PAD_H: 14,
  PAD_SPEED: 780,
  BALL_R: 8,
  BALL_SPEED: 380,
  BALL_SPEED_MAX: 640,
  LIVES: 3,
  MATCH_SECONDS: 120,
  SERVE_TICKS: 50,
};

export class BreakoutDuel {
  constructor(opts = {}) {
    this.cfg = { ...BREAK, ...opts.cfg };
    this.seed = opts.seed ?? randomSeed();
    this.rng = makeRng(this.seed);
    this.players = new Map();
    this.paddles = {}; // side -> player
    this.tick = 0;
    this.over = false;
    this.winnerId = null;
    this.events = [];
    this.shake = 0;
    this.serveTick = 0;
    this.bricks = this.buildBricks();
    this.ball = { x: this.cfg.W / 2, y: this.cfg.H - 120, vx: 0, vy: 0, speed: this.cfg.BALL_SPEED, r: this.cfg.BALL_R, stuck: true, hitter: null, owner: 'bottom', lastBrick: null };
  }

  // ---------------------------------------------------------------- world
  buildBricks() {
    const { W, H, BRICK_COLS, BRICK_ROWS, WALL_TOP, WALL_BOTTOM } = this.cfg;
    const gap = 6;
    const bw = (W - gap * (BRICK_COLS + 1)) / BRICK_COLS;
    const rows = BRICK_ROWS;
    const y0 = Math.round(H * WALL_TOP);
    const bandH = Math.round(H * WALL_BOTTOM) - y0;
    const bh = Math.max(14, Math.floor((bandH - gap * (rows - 1)) / rows));
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < BRICK_COLS; c++) {
        const outer = r === 0 || r === rows - 1;
        out.push({
          id: out.length,
          row: r,
          col: c,
          x: gap + c * (bw + gap),
          y: y0 + r * (bh + gap),
          w: bw,
          h: bh,
          hp: outer ? 1 : 2,
          maxHp: outer ? 1 : 2,
        });
      }
    }
    return out;
  }

  liveBricks() {
    return this.bricks.filter((b) => b.hp > 0);
  }

  addPlayer(id, meta = {}) {
    const taken = new Set([...this.players.values()].map((p) => p.side));
    let side = meta.side;
    if (!side || taken.has(side)) side = taken.has('bottom') ? (taken.has('top') ? null : 'top') : 'bottom';
    const player = {
      id,
      name: meta.name || (side === 'bottom' ? 'You' : 'Rival'),
      hue: meta.hue ?? (side === 'bottom' ? 188 : 312),
      bot: !!meta.bot,
      side,
      padX: this.cfg.W / 2,
      padTarget: this.cfg.W / 2,
      lives: this.cfg.LIVES,
      broken: 0,
      steals: 0,
      combo: 0,
      best: 0,
      score: 0,
      dropped: 0,
    };
    this.players.set(id, player);
    if (side) this.paddles[side] = player;
    if (!this.ball.hitter && side) this.ball.hitter = id;
    this.events.push({ k: 'joined', id, side });
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (p.side && this.paddles[p.side] === p) delete this.paddles[p.side];
    if (this.ball.hitter === id) this.ball.hitter = [...this.players.values()][0]?.id ?? null;
    this.events.push({ k: 'left', id });
  }

  sideOf(id) {
    return this.players.get(id)?.side ?? null;
  }

  paddleY(side) {
    return side === 'bottom' ? this.cfg.H - 40 : 40 - this.cfg.PAD_H;
  }

  // ---------------------------------------------------------------- input
  move(id, input = {}) {
    const p = this.players.get(id);
    if (!p || this.over) return;
    const half = this.cfg.PAD_W / 2;
    if (typeof input.dx === 'number') p.padTarget = clamp(p.padTarget + input.dx, half, this.cfg.W - half);
    else if (typeof input.x === 'number') p.padTarget = clamp(input.x, half, this.cfg.W - half);
  }

  serve(side) {
    const owner = this.paddles[side];
    if (!owner) return;
    const b = this.ball;
    b.stuck = true;
    b.owner = side;
    b.hitter = owner.id;
    b.vx = 0;
    b.vy = 0;
    b.speed = this.cfg.BALL_SPEED;
    b.x = owner.padX;
    b.y = this.paddleY(side) + (side === 'bottom' ? -b.r - 2 : this.cfg.PAD_H + b.r + 2);
    this.serveTick = this.tick + this.cfg.SERVE_TICKS;
  }

  launch(side) {
    const owner = this.paddles[side];
    if (!owner) return;
    const b = this.ball;
    if (!b.stuck) return;
    const angle = this.rng.range(-0.5, 0.5);
    b.speed = this.cfg.BALL_SPEED;
    b.vx = Math.sin(angle) * b.speed;
    b.vy = (side === 'bottom' ? -1 : 1) * Math.abs(Math.cos(angle) * b.speed);
    b.stuck = false;
    b.hitter = owner.id;
    this.ensureAngle();
    this.events.push({ k: 'launch', side, id: owner.id });
  }

  // ---------------------------------------------------------------- loop
  step() {
    if (this.over) return this.events.splice(0);
    this.tick += 1;
    this.events.length = 0;
    const dt = 1 / this.cfg.TICK_HZ;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - 1);

    for (const p of this.players.values()) {
      const half = this.cfg.PAD_W / 2;
      const maxStep = this.cfg.PAD_SPEED * dt;
      p.padX = clamp(p.padX + clamp(p.padTarget - p.padX, -maxStep, maxStep), half, this.cfg.W - half);
    }
    // substep so a fast ball cannot tunnel through a paddle or a brick row
    for (let s = 0; s < 3; s++) {
      if (this.over) break;
      this.substep(dt / 3);
    }

    if (this.tick % this.cfg.TICK_HZ === 0) {
      const remaining = this.cfg.MATCH_SECONDS - this.tick / this.cfg.TICK_HZ;
      if (remaining <= 0) this.finish('time');
    }
    this.checkEnd();
    return this.events.slice();
  }

  substep(dt) {
    const b = this.ball;
    if (this.over) return;
    if (b.stuck) {
      const owner = this.paddles[b.owner];
      if (owner) {
        b.x = owner.padX;
        b.y = this.paddleY(b.owner) + (b.owner === 'bottom' ? -b.r - 2 : this.cfg.PAD_H + b.r + 2);
      }
      if (this.tick >= this.serveTick) this.launch(b.owner);
      return;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    if (b.x < b.r) {
      b.x = b.r;
      b.vx = Math.abs(b.vx);
      this.events.push({ k: 'wall', x: b.x, y: b.y });
    } else if (b.x > this.cfg.W - b.r) {
      b.x = this.cfg.W - b.r;
      b.vx = -Math.abs(b.vx);
      this.events.push({ k: 'wall', x: b.x, y: b.y });
    }

    for (const side of ['bottom', 'top']) this.hitPaddle(side);
    this.hitBricks();

    if (b.y > this.cfg.H + b.r) this.loseSide('bottom');
    else if (b.y < -b.r) this.loseSide('top');
  }

  hitPaddle(side) {
    const p = this.paddles[side];
    if (!p) return;
    const b = this.ball;
    const py = this.paddleY(side);
    const within = b.x >= p.padX - this.cfg.PAD_W / 2 - b.r && b.x <= p.padX + this.cfg.PAD_W / 2 + b.r;
    if (!within) return;
    if (side === 'bottom') {
      const line = py - b.r;
      if (b.vy > 0 && b.y >= line - 6 && b.y <= line + 16) {
        b.y = line;
        this.bounceOff(p, side);
      }
    } else {
      const line = py + this.cfg.PAD_H + b.r;
      if (b.vy < 0 && b.y <= line + 6 && b.y >= line - 16) {
        b.y = line;
        this.bounceOff(p, side);
      }
    }
  }

  bounceOff(p, side) {
    const b = this.ball;
    const rel = clamp((b.x - p.padX) / (this.cfg.PAD_W / 2), -1, 1);
    b.speed = Math.min(this.cfg.BALL_SPEED_MAX, b.speed + 9);
    const angle = rel * 1.02; // up to ~58 degrees off vertical
    b.vx = Math.sin(angle) * b.speed;
    b.vy = (side === 'bottom' ? -1 : 1) * Math.abs(Math.cos(angle) * b.speed);
    this.ensureAngle();
    b.hitter = p.id;
    b.owner = side;
    const rival = [...this.players.values()].find((q) => q.id !== p.id);
    if (rival && rival.combo > 0) {
      p.steals += 1;
      this.events.push({ k: 'steal', id: p.id, from: rival.id });
    }
    if (rival) rival.combo = 0;
    this.events.push({ k: 'paddle', side, id: p.id, x: b.x, y: this.paddleY(side), speed: Math.round(b.speed) });
  }

  // A dead-vertical rally is a stalemate: the ball would fly through the holes
  // the players already drilled and never touch another brick. Keep some lateral
  // travel in every shot so a duel always converges.
  ensureAngle() {
    const b = this.ball;
    const minVx = 0.24 * b.speed;
    if (Math.abs(b.vx) < minVx) b.vx = (b.vx < 0 ? -1 : 1) * minVx;
    const maxVy = 0.94 * b.speed;
    if (Math.abs(b.vy) > maxVy) b.vy = Math.sign(b.vy) * maxVy;
    const mag = Math.hypot(b.vx, b.vy) || 1;
    b.vx = (b.vx / mag) * b.speed;
    b.vy = (b.vy / mag) * b.speed;
  }

  overlaps(brick) {
    const b = this.ball;
    return b.x + b.r > brick.x && b.x - b.r < brick.x + brick.w && b.y + b.r > brick.y && b.y - b.r < brick.y + brick.h;
  }

  hitBricks() {
    const b = this.ball;
    if (b.lastBrick != null) {
      const prev = this.bricks[b.lastBrick];
      if (!prev || prev.hp <= 0 || !this.overlaps(prev)) b.lastBrick = null;
    }
    for (const brick of this.bricks) {
      if (brick.hp <= 0) continue;
      if (b.lastBrick === brick.id) return;
      const bxc = brick.x + brick.w / 2;
      const byc = brick.y + brick.h / 2;
      const dx = bxc - b.x;
      const dy = byc - b.y;
      const ox = brick.w / 2 + b.r - Math.abs(dx); // overlap on each axis
      const oy = brick.h / 2 + b.r - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;

      const hitter = this.players.get(b.hitter);
      const willBreak = brick.hp <= 1;

      if (willBreak) {
        // A destroyed brick does not bounce the ball - it punches through the hole.
        brick.hp = 0;
        brick.deadAt = this.tick;
        // a touch of jitter so the ball never gets stuck rattling in one column
        const jitter = (this.rng.next() - 0.5) * 0.22;
        b.vx += jitter * b.speed;
        const mag = Math.hypot(b.vx, b.vy) || 1;
        b.vx = (b.vx / mag) * b.speed;
        b.vy = (b.vy / mag) * b.speed;
        if (hitter) {
          hitter.broken += 1;
          hitter.combo += 1;
          hitter.best = Math.max(hitter.best, hitter.combo);
          const gained = 100 + Math.min(200, (hitter.combo - 1) * 25);
          hitter.score += gained;
          this.events.push({ k: 'break', id: hitter.id, x: bxc, y: byc, combo: hitter.combo, points: gained });
        }
        this.shake = 7;
      } else {
        // a tough brick survives and deflects the ball, resolved along the axis of
        // least penetration - pushed AWAY from the brick so corners never snag
        brick.hp -= 1;
        if (ox < oy) {
          b.x += dx > 0 ? -ox : ox;
          b.vx = dx > 0 ? -Math.abs(b.vx) : Math.abs(b.vx);
        } else {
          b.y += dy > 0 ? -oy : oy;
          b.vy = dy > 0 ? -Math.abs(b.vy) : Math.abs(b.vy);
        }
        if (hitter) {
          hitter.score += 25;
          this.events.push({ k: 'crack', id: hitter.id, x: bxc, y: byc });
        }
        b.lastBrick = brick.id;
        this.shake = 3;
      }
      return;
    }
  }

  loseSide(side) {
    const p = this.paddles[side];
    this.ball.speed = this.cfg.BALL_SPEED;
    if (p) {
      p.lives -= 1;
      p.combo = 0;
      p.dropped += 1;
      this.events.push({ k: 'miss', side, id: p.id, lives: p.lives });
      this.shake = 12;
      if (p.lives <= 0) {
        const rival = [...this.players.values()].find((q) => q.id !== p.id);
        this.finish('lives', rival?.id ?? null);
        return;
      }
    }
    // whoever just dropped it gets the next serve - never punished twice
    this.serve(side);
  }

  finish(reason, forcedWinner = null) {
    if (this.over) return;
    this.over = true;
    this.reason = reason;
    if (forcedWinner) {
      this.winnerId = forcedWinner;
    } else {
      const ranked = [...this.players.values()].sort(
        (a, b) => b.broken - a.broken || b.lives - a.lives || b.score - a.score
      );
      this.winnerId = ranked[0]?.id ?? null;
    }
    const winner = this.players.get(this.winnerId);
    if (winner) winner.score += 400;
    this.events.push({ k: 'over', reason, winner: this.winnerId });
  }

  checkEnd() {
    if (this.over) return;
    if (this.liveBricks().length === 0) this.finish('cleared');
  }

  standings() {
    return [...this.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        broken: p.broken,
        bricksLeft: this.liveBricks().length,
        lives: p.lives,
        combo: p.combo,
        best: p.best,
        dropped: p.dropped,
      }))
      .sort((a, b) => b.broken - a.broken || b.score - a.score || b.lives - a.lives);
  }

  snapshot() {
    return {
      t: this.tick,
      over: this.over,
      reason: this.reason || null,
      winner: this.winnerId,
      shake: this.shake,
      timeLeft: Math.max(0, this.cfg.MATCH_SECONDS - Math.floor(this.tick / this.cfg.TICK_HZ)),
      wallLeft: this.liveBricks().length,
      wallTotal: this.bricks.length,
      ball: [Math.round(this.ball.x), Math.round(this.ball.y), this.ball.stuck ? 1 : 0],
      bricks: this.bricks.map((b2) => [b2.x, b2.y, b2.w, b2.h, b2.hp, b2.row]),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        n: p.name,
        h: p.hue,
        side: p.side,
        x: Math.round(p.padX),
        y: this.paddleY(p.side),
        lives: p.lives,
        broken: p.broken,
        combo: p.combo,
        score: p.score,
        bot: p.bot ? 1 : 0,
      })),
    };
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
