// Game table: how each arcade cabinet is created, fed, ticked and scored.
// Lives in shared/ because BOTH sides need it: the authoritative server and the
// browser's solo mode (no server). Rules themselves are in snake.js/breakout.js/etc.
import { SnakeArena, SNAKE } from './snake.js';
import { BreakoutDuel, BREAK } from './breakout.js';
import { MemoryDuel, MEMORY } from './memory.js';
import { Versus2048, Grid2048 } from './g2048.js';
import { snakeBotDir, breakoutCpuTarget, memoryCpuFlip, g2048CpuMove } from './bots.js';

export const GAMES = {
  snake: {
    id: 'snake',
    name: 'Snake Battle',
    blurb: 'Up to 8 snakes, one arena. Grow, cut people off, survive.',
    minPlayers: 1,
    maxPlayers: SNAKE.MAX_PLAYERS,
    tickHz: SNAKE.TICK_HZ,
    perPlayerSnapshot: false,
    create: () => new SnakeArena({}),
    input(game, player, msg) {
      if (typeof msg.dir === 'string') game.steer(player.pid, msg.dir);
    },
    tick(game, room) {
      for (const p of game.players.values()) {
        if (p.bot) game.steer(p.id, snakeBotDir(game, p));
      }
      return game.step();
    },
    results(game) {
      return game.standings().map((s, i) => ({ pos: i + 1, name: s.name, score: s.score, sub: `${s.kills} KO · ${s.deaths} crashed` }));
    },
    leaderboard(game, player) {
      return Math.max(0, player.score || 0);
    },
  },

  breakout: {
    id: 'breakout',
    name: 'Breakout Duel',
    blurb: 'Two paddles, one ball, one shared wall. Hit it yourself to bank the bricks.',
    minPlayers: 1,
    maxPlayers: 2,
    tickHz: BREAK.TICK_HZ,
    stateHz: 30, // send snapshots at half the physics rate, clients interpolate
    perPlayerSnapshot: false,
    create: () => new BreakoutDuel({}),
    input(game, player, msg) {
      game.move(player.pid, { x: typeof msg.x === 'number' ? msg.x : undefined, dx: typeof msg.dx === 'number' ? msg.dx : undefined });
    },
    tick(game, room) {
      for (const p of game.players.values()) {
        if (p.bot) game.move(p.id, { x: breakoutCpuTarget(game, p, { skill: 0.78 }) });
      }
      const ev = game.step();
      for (const p of game.players.values()) if (p.bot && game.ball.stuck && game.ball.owner === p.side) game.launch(p.side);
      return ev;
    },
    results(game) {
      return game.standings().map((s, i) => ({ pos: i + 1, name: s.name, score: s.score, sub: `${s.broken} bricks · ${s.lives} lives · best chain x${s.best}` }));
    },
    leaderboard: (game, player) => player.score || 0,
  },

  memory: {
    id: 'memory',
    name: 'Memory Match',
    blurb: 'Take turns flipping tiles. Hit a pair and you keep the turn.',
    minPlayers: 1,
    maxPlayers: 2,
    tickHz: MEMORY.TICK_HZ,
    perPlayerSnapshot: true,
    create: () => new MemoryDuel({}),
    input(game, player, msg) {
      if (Number.isInteger(msg.idx)) game.flip(player.pid, msg.idx);
    },
    tick(game, room) {
      const me = game.currentId();
      const bot = game.players.get(me);
      if (bot?.bot && !game.over && game.resolveIn === 0) {
        room.botTimer = (room.botTimer || 0) + 1;
        if (room.botTimer >= 6) {
          room.botTimer = 0;
          if (!room.botSeen) room.botSeen = new Set();
          for (const i of game.open) room.botSeen.add(i);
          const pick = memoryCpuFlip(game, bot.id, room.botSeen);
          if (pick && Number.isInteger(pick.idx)) {
            game.flip(bot.id, pick.idx);
            for (const i of game.open) room.botSeen.add(i);
          }
        }
      }
      return game.step();
    },
    results(game) {
      return game.standings().map((s, i) => ({ pos: i + 1, name: s.name, score: s.score, sub: `${s.matched} pairs · ${s.misses} misses` }));
    },
    leaderboard: (game, player) => player.score || 0,
  },

  g2048: {
    id: 'g2048',
    name: '2048 Versus',
    blurb: 'Side-by-side boards. First to 2048 wins; otherwise highest score.',
    minPlayers: 1,
    maxPlayers: 2,
    tickHz: 8,
    perPlayerSnapshot: false,
    create: () => new Versus2048({}),
    input(game, player, msg) {
      if (game.players.get(player.pid)) game.report(player.pid, msg.state || msg);
    },
    tick(game, room) {
      room.botTimer = (room.botTimer || 0) + 1;
      for (const p of game.players.values()) {
        if (!p.bot || p.over) continue;
        if (room.botTimer % 10 !== 0) continue;
        if (!room.botGrids) room.botGrids = new Map();
        let grid = room.botGrids.get(p.id);
        if (!grid) {
          grid = new Grid2048({});
          room.botGrids.set(p.id, grid);
        }
        const dir = g2048CpuMove(grid, { noise: 90 });
        if (dir) grid.move(dir);
        game.report(p.id, { ...grid.snapshot(), over: grid.over });
      }
      return game.events.splice(0);
    },
    results(game) {
      return game.standings().map((s, i) => ({ pos: i + 1, name: s.name, score: s.score, sub: `best tile ${s.max}` }));
    },
    leaderboard: (game, player) => player.score || 0,
  },
};

export const GAME_IDS = ['snake', 'breakout', 'memory', 'g2048'];

export const GAME_LIST = GAME_IDS.map((id) => {
  const g = GAMES[id];
  return { id: g.id, name: g.name, blurb: g.blurb, minPlayers: g.minPlayers, maxPlayers: g.maxPlayers, tickHz: g.tickHz };
});

export const GAME_META = {
  snake: {
    accent: '#22e6ff',
    accent2: '#7cff5a',
    icon: 'snake',
    controls: [['W A S D / arrows', 'steer'], ['space', 'hard turn (locks next tick)'], ['P', 'pause (solo)']],
    rules: 'Eat pellets to grow. Hitting a wall, yourself or another snake ends you. Bodies left behind are permanent obstacles, so cutting a rival off is worth more than a pellet.',
    scoring: 'Pellet +10 · golden pellet +40 · rival crashed into you +75 · every 5 in a row grows you 2 extra',
  },
  breakout: {
    accent: '#ff2bd1',
    accent2: '#22e6ff',
    icon: 'breakout',
    controls: [['mouse / trackpad / touch drag', 'move paddle'], ['left · right arrows', 'keyboard paddle'], ['space', 'serve early']],
    rules: 'One shared wall, one ball, two paddles. A brick is credited to whoever last touched the ball - so hit it yourself to bank the break. Steal the rally and their combo resets. Miss your own baseline and you lose a life.',
    scoring: 'Brick destroyed +100 · chain +25 per link (max +200) · cracked a tough brick +25 · clear the wall or drain 3 lives to win · +400 end bonus',
  },
  memory: {
    accent: '#ffe600',
    accent2: '#ff2bd1',
    icon: 'memory',
    controls: [['click / tap', 'flip a tile'], ['1-9, 0', 'flip by grid position'], ['Enter', 'flip the tile under the cursor']],
    rules: 'Two tiles per turn. A match keeps the turn and stacks a streak bonus; a miss passes it. Leave one tile dangling too long and the turn is forfeited.',
    scoring: 'Pair +100 · streak +25 per extra pair in a row · 3s turn clock',
  },
  g2048: {
    accent: '#7cff5a',
    accent2: '#ffe600',
    icon: '2048',
    controls: [['arrows / WASD', 'slide'], ['swipe', 'slide on touch'], ['U', 'undo one move (solo)']],
    rules: 'Slide the whole board; equal tiles merge and add their value. In Versus you race a live rival: first board to mint a 2048 wins, otherwise highest score when someone tops out.',
    scoring: 'Merged tile value is your score · Versus win by reaching 2048 first',
  },
};
