// One session abstraction, two transports.
//   online -> WebSocket to the authoritative server (server/hub.js)
//   solo   -> the exact same shared engines running in this tab, no server needed
// Game code only ever talks `session.send(msg)` / `session.on('state'|'joined'|...)`,
// so every cabinet works identically whether or not the arcade is deployed.
import { GAMES } from '../shared/defs.js';

export class Emitter {
  constructor() {
    this.map = new Map();
  }
  on(type, fn) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type).add(fn);
    return () => this.map.get(type).delete(fn);
  }
  emit(type, payload) {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[${type}] handler failed`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Solo room: a miniature of server/hub.js Room, driving the shared defs.
// ---------------------------------------------------------------------------
class SoloRoom extends Emitter {
  constructor(gameId, opts = {}) {
    super();
    this.def = GAMES[gameId];
    if (!this.def) throw new Error(`no such game: ${gameId}`);
    this.gameId = gameId;
    this.id = 'SOLO';
    this.status = 'waiting';
    this.private = true;
    this.autoFill = true;
    this.players = new Map();
    this.botTimer = 0;
    this.botSeen = new Set();
    this.botGrids = new Map();
    this.loopCount = 0;
    this.loop = null;
    this.game = this.def.create();
    this.addLocal(opts.name || 'You');
    if (opts.vs !== 'none') this.addCpu();
  }

  addLocal(name) {
    const player = { pid: 'p0', id: 'p0', name: String(name).slice(0, 18) || 'You', hue: 188, bot: false, sock: null, side: null };
    if (this.gameId === 'breakout') player.side = 'bottom';
    this.players.set(player.pid, player);
    this.game.addPlayer(player.pid, { name: player.name, hue: player.hue, side: player.side });
    return player;
  }

  addCpu() {
    if (this.players.size >= this.def.maxPlayers) return null;
    const cpu = { pid: 'cpu', id: 'cpu', name: 'CPU', hue: 312, bot: true, sock: null, side: null };
    if (this.gameId === 'breakout') cpu.side = this.players.size === 0 ? 'bottom' : 'top';
    this.players.set(cpu.pid, cpu);
    this.game.addPlayer(cpu.pid, { name: cpu.name, hue: cpu.hue, bot: true, side: cpu.side });
    return cpu;
  }

  info() {
    return {
      id: 'SOLO',
      game: this.gameId,
      name: this.def.name,
      status: this.status,
      solo: true,
      count: this.players.size,
      max: this.def.maxPlayers,
      tickHz: this.def.tickHz,
      players: [...this.players.values()].map((p) => ({ pid: p.pid, name: p.name, hue: p.hue, bot: p.bot ? 1 : 0, side: p.side })),
    };
  }

  start() {
    if (this.loop) return;
    this.status = 'live';
    const period = Math.max(8, Math.round(1000 / this.def.tickHz));
    this.loop = setInterval(() => this.onTick(), period);
    this.emit('joined', { room: this.info(), pid: 'p0', side: this.players.get('p0').side, chat: [] });
  }

  stop() {
    clearInterval(this.loop);
    this.loop = null;
  }

  onTick() {
    this.loopCount += 1;
    let events = [];
    try {
      events = this.def.tick(this.game, this) || [];
    } catch (err) {
      console.error('[solo] tick failed', err);
      this.stop();
      return;
    }
    const every = this.def.stateHz ? Math.max(1, Math.round(this.def.tickHz / this.def.stateHz)) : 1;
    if (this.loopCount % every === 0) {
      const snap = this.def.perPlayerSnapshot ? this.game.snapshot('p0') : this.game.snapshot();
      this.emit('state', { s: snap, ev: events });
    } else if (events.length) {
      this.emit('ev', { ev: events });
    }
    if (this.game.over && this.status === 'live') this.endRound();
  }

  endRound() {
    this.status = 'over';
    this.stop();
    this.emit('roundOver', { game: this.gameId, results: this.def.results(this.game) || [], winner: null, solo: true });
    this.restartTimer = setTimeout(() => this.restartNow(), 7000);
  }

  restartNow() {
    clearTimeout(this.restartTimer);
    this.status = 'waiting';
    this.botTimer = 0;
    this.botSeen = new Set();
    this.botGrids = new Map();
    this.loopCount = 0;
    this.game = this.def.create();
    const keep = [...this.players.values()];
    this.players.clear();
    for (const p of keep) {
      this.players.set(p.pid, p);
      this.game.addPlayer(p.pid, { name: p.name, hue: p.hue, bot: p.bot, side: p.side });
    }
    this.emit('restarted', { info: this.info() });
    this.emit('state', { s: this.def.perPlayerSnapshot ? this.game.snapshot('p0') : this.game.snapshot(), ev: [] });
    this.start();
  }

  send(msg) {
    if (msg.t === 'input') {
      this.touch();
      this.def.input(this.game, this.players.get('p0'), msg);
      if (this.game.over && this.status === 'live') this.endRound();
      return;
    }
    if (msg.t === 'restart' && this.status === 'over') this.restartNow();
    if (msg.t === 'pause') {
      if (this.loop) {
        this.stop();
        this.status = 'paused';
        this.emit('paused', { paused: true });
      } else if (this.status === 'paused') {
        this.status = 'live';
        this.start();
        this.emit('paused', { paused: false });
      }
    }
    if (msg.t === 'addCpu') {
      this.addCpu();
      this.start();
    }
    if (msg.t === 'removeCpu') {
      this.players.delete('cpu');
      if (this.game.removePlayer) this.game.removePlayer('cpu');
    }
  }
  touch() {}
  close() {
    this.stop();
    clearTimeout(this.restartTimer);
  }
}

// ---------------------------------------------------------------------------
export class Session extends Emitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.game = opts.game;
    this.mode = opts.mode || 'online';
    this.sock = null;
    this.room = null;
    this.status = 'idle'; // idle | connecting | online | offline
    this.rooms = [];
    this.stats = { online: 0, rooms: 0, matches: 0 };
    this.board = {};
    this.retries = 0;
    this.closed = false;
    this.url = opts.url || wsUrl();
  }

  get connected() {
    return !!this.sock && this.sock.readyState === 1;
  }

  connect() {
    if (this.mode === 'solo') {
      this.status = 'local';
      this.room = new SoloRoom(this.game, this.opts);
      this.room.on('joined', (m) => this.emit('joined', m));
      this.room.on('state', (m) => this.emit('state', m));
      this.room.on('ev', (m) => this.emit('ev', m));
      this.room.on('roundOver', (m) => this.emit('roundOver', m));
      this.room.on('restarted', (m) => this.emit('restarted', m));
      this.room.on('paused', (m) => this.emit('paused', m));
      if (this.opts.autoStart !== false) this.room.start();
      this.emit('status', { status: 'local', mode: 'solo' });
      return Promise.resolve({ local: true });
    }
    return this.openSocket();
  }

  openSocket() {
    if (!this.url) {
      this.status = 'offline';
      this.emit('status', { status: 'offline', mode: this.mode });
      return Promise.reject(new Error('no websocket url'));
    }
    this.status = 'connecting';
    this.emit('status', { status: 'connecting', mode: this.mode });
    let sock;
    try {
      sock = new WebSocket(this.url);
    } catch (err) {
      this.status = 'offline';
      this.emit('status', { status: 'offline', mode: this.mode });
      return Promise.reject(err);
    }
    this.sock = sock;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          try {
            sock.close();
          } catch {
            /* ignore */
          }
          reject(new Error('timeout'));
        }
      }, 4000);

      sock.onopen = () => {
        settled = true;
        clearTimeout(timer);
        this.status = 'online';
        this.retries = 0;
        this.emit('status', { status: 'online', mode: this.mode });
        this.send({ t: 'hello', name: this.opts.name || 'Guest' });
        if (this.pending?.length) {
          for (const msg of this.pending.splice(0)) this.send(msg);
        }
        resolve(true);
      };
      sock.onmessage = (e) => this.onRaw(e.data);
      sock.onerror = () => {
        clearTimeout(timer);
        if (!settled) reject(new Error('socket error'));
      };
      sock.onclose = () => {
        clearTimeout(timer);
        this.sock = null;
        this.status = 'offline';
        this.emit('status', { status: 'offline', mode: this.mode });
        if (!this.closed) this.scheduleReconnect();
        if (!settled) reject(new Error('socket closed'));
      };
    });
  }

  scheduleReconnect() {
    if (this.closed || this.mode === 'solo') return;
    if (this.retries >= 3) {
      this.emit('notice', { text: 'Server unreachable - solo mode still works.' });
      return;
    }
    this.retries += 1;
    const wait = 600 * this.retries;
    setTimeout(() => {
      if (!this.closed) this.openSocket().catch(() => {});
    }, wait);
  }

  onRaw(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'welcome':
        this.rooms = msg.rooms || [];
        this.stats = msg.stats || this.stats;
        this.board = msg.leaderboard || {};
        this.emit('welcome', msg);
        this.emit('rooms', { rooms: this.rooms, stats: this.stats });
        this.emit('leader', { board: this.board });
        if (this.opts.autoJoin) this.autoJoin();
        break;
      case 'you':
        this.emit('you', msg);
        break;
      case 'rooms':
        this.rooms = msg.rooms || [];
        this.stats = msg.stats || this.stats;
        this.emit('rooms', msg);
        break;
      case 'leader':
        this.board = msg.board || {};
        this.emit('leader', msg);
        break;
      case 'joined':
        this.joined(msg);
        break;
      case 'state':
      case 'ev':
      case 'roundOver':
      case 'restarted':
      case 'roster':
      case 'chat':
      case 'cpu':
      case 'closed':
        if (msg.t === 'roster' && this.roomInfo) Object.assign(this.roomInfo, msg.info || {});
        if (msg.t === 'closed') this.emit('closedRoom', msg);
        this.emit(msg.t, msg);
        break;
      case 'err':
        this.emit('err', msg);
        break;
      default:
        this.emit(msg.t, msg);
        break;
    }
  }

  joined(msg) {
    this.pid = msg.pid;
    this.roomInfo = msg.room;
    this.roomCode = msg.room?.id || null;
    this.emit('joined', msg);
  }

  autoJoin() {
    const { code, game, quick } = this.opts;
    if (code) this.send({ t: 'join', code });
    else if (quick !== false && game) this.send({ t: 'quick', game, vsCpu: !!this.opts.vsCpu });
    else if (game) this.send({ t: 'create', game, private: !!this.opts.private, vsCpu: !!this.opts.vsCpu });
  }

  send(msg) {
    if (this.mode === 'solo') {
      this.room?.send(msg);
      return;
    }
    if (this.connected) this.sock.send(JSON.stringify(msg));
    else {
      this.pending = this.pending || [];
      if (this.pending.length < 24) this.pending.push(msg);
    }
  }

  results(score, mode = 'solo') {
    if (this.mode === 'solo') {
      const key = `na.best.${this.game}`;
      try {
        const best = Math.max(score || 0, Number(localStorage.getItem(key) || 0));
        localStorage.setItem(key, String(best));
        this.emit('best', { best, key });
      } catch {
        /* private mode storage - ignore */
      }
    } else {
      this.send({ t: 'score', game: this.game, score, mode });
    }
  }

  close() {
    this.closed = true;
    this.stopLocal();
    if (this.sock) {
      try {
        this.sock.close();
      } catch {
        /* ignore */
      }
      this.sock = null;
    }
  }

  stopLocal() {
    if (this.room && this.room.stop) this.room.stop();
  }
}

export function wsUrl() {
  if (typeof location === 'undefined') return null;
  // An explicit server always wins, so a Pages front end can still be wired to a
  // faraway arcade: set window.ARCADE_WS = 'wss://your-host/ws' before this runs.
  const forced = typeof window !== 'undefined' ? window.ARCADE_WS : null;
  if (forced) return forced;
  if (location.protocol === 'file:') return null;
  // GitHub Pages only serves the static bundle: dialling /ws there cannot work, and
  // the handshake 404 is a red console error for every visitor. Treat the host as
  // "no server" instead, which is the path the UI already labels as offline.
  if (/\.github\.io$/.test(location.hostname)) return null;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export function parseQuery(search = (typeof location !== 'undefined' ? location.search : '')) {
  const out = {};
  for (const [k, v] of new URLSearchParams(search)) out[k] = v;
  return out;
}
