// Room hub: matchmaking, the authoritative game loop, bot pacing and the wire protocol.
// One file owns "how a match runs"; public/shared/* owns "what the rules are".
import crypto from 'node:crypto';
import { GAMES, GAME_LIST } from '../public/shared/defs.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function roomCode() {
  const bytes = crypto.randomBytes(5);
  let out = '';
  for (let i = 0; i < 5; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const HUES = [188, 312, 62, 132, 268, 20, 210, 96];

// ---------------------------------------------------------------------------
// Per-game wiring. Each entry tells the hub how to create a match, feed it
// input, drive CPU players, read results and shape the wire payload.
// ---------------------------------------------------------------------------

export { GAMES, GAME_LIST };

// ---------------------------------------------------------------------------
export class Room {
  constructor(hub, gameId, opts = {}) {
    this.hub = hub;
    this.id = opts.code || roomCode();
    this.gameId = gameId;
    this.def = GAMES[gameId];
    this.private = !!opts.private;
    this.status = 'waiting'; // waiting | live | over | finished
    this.players = new Map(); // pid -> player
    this.seq = 0;
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.chat = [];
    this.loop = null;
    this.loopCount = 0;
    this.restartTimer = null;
    this.botTimer = 0;
    this.botSeen = new Set();
    this.botGrids = new Map();
    this.game = this.def.create();
  }

  get hostPid() {
    for (const p of this.players.values()) if (!p.bot) return p.pid;
    return null;
  }

  humanCount() {
    return [...this.players.values()].filter((p) => !p.bot).length;
  }

  info() {
    return {
      id: this.id,
      game: this.gameId,
      name: this.def.name,
      status: this.status,
      private: this.private,
      count: this.players.size,
      max: this.def.maxPlayers,
      players: [...this.players.values()].map((p) => ({ pid: p.pid, name: p.name, hue: p.hue, bot: p.bot ? 1 : 0, side: p.side || null })),
      host: this.hostPid,
      tickHz: this.def.tickHz,
    };
  }

  addBot() {
    if (this.players.size >= this.def.maxPlayers) return null;
    if ([...this.players.values()].some((p) => p.bot)) return null;
    const pid = this.nextPid();
    const player = { pid, id: pid, name: 'CPU', hue: 312, bot: true, sock: null, side: null };
    this.players.set(pid, player);
    this.game.addPlayer(pid, { name: 'CPU', hue: 312, bot: true, side: this.assignSide() });
    return player;
  }

  assignSide() {
    if (this.gameId !== 'breakout') return null;
    return this.players.size === 1 ? 'bottom' : 'top';
  }

  nextPid() {
    let n = this.seq++;
    while (this.players.has(`p${n}`)) n = this.seq++;
    return `p${n}`;
  }

  addPlayer(sock, meta = {}) {
    const pid = this.nextPid();
    const player = {
      pid,
      id: pid,
      name: (meta.name || 'Guest').slice(0, 18),
      hue: HUES[this.players.size % HUES.length],
      bot: false,
      sock,
      side: null,
      joinedAt: Date.now(),
    };
    player.side = this.gameId === 'breakout' ? (this.players.size === 0 ? 'bottom' : 'top') : null;
    this.players.set(pid, player);
    sock.pid = pid;
    sock.room = this.id;
    this.game.addPlayer(pid, { name: player.name, hue: player.hue, side: player.side });
    this.touch();
    return player;
  }

  removePlayer(pid) {
    const p = this.players.get(pid);
    if (!p) return;
    this.players.delete(pid);
    if (this.game.removePlayer) this.game.removePlayer(pid);
    if (this.players.size === 0) this.close();
    else if (this.humanCount() === 0) this.scheduleClose(20000);
  }

  canAccept(playerCount = this.players.size) {
    return playerCount < this.def.maxPlayers && this.status !== 'finished';
  }

  start() {
    if (this.loop || this.status === 'live') return;
    this.status = 'live';
    const period = Math.max(8, Math.round(1000 / this.def.tickHz));
    this.loop = setInterval(() => this.onTick(period), period);
    if (this.loop.unref) this.loop.unref();
    this.hub.broadcastRooms();
  }

  stop() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  scheduleClose(ms = 60000) {
    if (this.closeTimer) return;
    this.closeTimer = setTimeout(() => this.hub.closeRoom(this.id), ms);
    if (this.closeTimer.unref) this.closeTimer.unref();
  }

  touch() {
    this.lastActive = Date.now();
    if (this.closeTimer && this.players.size > 0) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  close() {
    this.stop();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.hub.closeRoom(this.id);
  }

  onTick(period) {
    this.loopCount += 1;
    let events = [];
    try {
      events = this.def.tick(this.game, this) || [];
    } catch (err) {
      console.error(`[room ${this.id}] tick failed:`, err);
      this.stop();
      this.broadcast({ t: 'err', m: 'Server hiccuped in that match - room is restarting.' });
      this.restartNow();
      return;
    }

    const every = this.def.stateHz ? Math.max(1, Math.round(this.def.tickHz / this.def.stateHz)) : 1;
    const sendState = this.loopCount % every === 0;

    if (sendState) {
      if (this.def.perPlayerSnapshot) {
        for (const p of this.players.values()) {
          if (!p.sock || p.bot) continue;
          this.send(p, { t: 'state', s: this.game.snapshot(p.pid), ev: events });
        }
      } else {
        this.broadcast({ t: 'state', s: this.game.snapshot(), ev: events });
      }
    } else if (events.length) {
      this.broadcast({ t: 'ev', ev: events });
    }

    if (this.game.over && this.status === 'live') this.endRound();
  }

  endRound() {
    this.status = 'over';
    this.stop();
    const results = this.def.results(this.game) || [];
    const winners = results[0];
    for (const p of this.players.values()) {
      if (p.bot || !p.sock) continue;
      const score = this.def.leaderboard ? this.def.leaderboard(this.game, this.game.players.get(p.pid) || {}) : 0;
      this.hub.leaderboard.record(this.gameId, { name: p.name, score, mode: 'online' });
    }
    this.hub.stats.matches += 1;
    this.broadcast({ t: 'roundOver', game: this.gameId, results, winner: winners?.name || null });
    this.hub.broadcastRooms();
    this.restartTimer = setTimeout(() => this.restartNow(), 9000);
    if (this.restartTimer.unref) this.restartTimer.unref();
  }

  restartNow() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.status = 'waiting';
    this.botSeen = new Set();
    this.botGrids = new Map();
    this.botTimer = 0;
    this.loopCount = 0;
    this.game = this.def.create();
    for (const p of this.players.values()) {
      this.game.addPlayer(p.pid, { name: p.name, hue: p.hue, bot: p.bot, side: p.side });
    }
    this.broadcast({ t: 'restarted', info: this.info() });
    if (this.players.size >= Math.max(1, this.def.minPlayers)) {
      if (this.players.size < 2 && this.hub.autoFill) this.hub.addCpu(this);
      this.start();
    }
  }

  send(player, msg) {
    const sock = player.sock;
    if (!sock || sock.readyState !== 1) return;
    try {
      sock.send(JSON.stringify(msg));
    } catch {
      /* socket died mid-write; cleanup happens on close */
    }
  }

  sendPid(pid, msg) {
    const p = this.players.get(pid);
    if (p) this.send(p, msg);
  }

  broadcast(msg, exceptPid = null) {
    const raw = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.bot || p.pid === exceptPid) continue;
      if (!p.sock || p.sock.readyState !== 1) continue;
      try {
        p.sock.send(raw);
      } catch {
        /* ignore */
      }
    }
  }

  chatSend(from, text) {
    const clean = String(text || '').slice(0, 140).replace(/[\u0000-\u001f]/g, ' ').trim();
    if (!clean) return;
    const msg = { t: 'chat', room: this.id, from: from.name, text: clean, at: Date.now() };
    this.chat.push(msg);
    if (this.chat.length > 60) this.chat.shift();
    this.broadcast(msg);
    this.hub.lobbyBroadcast(msg);
  }
}

// ---------------------------------------------------------------------------
export class Hub {
  constructor({ leaderboard, autoFill = true } = {}) {
    this.rooms = new Map();
    this.lobby = new Set(); // sockets watching the lobby feed
    this.leaderboard = leaderboard;
    this.autoFill = autoFill;
    this.stats = { matches: 0, joins: 0, started: Date.now() };
    this.reapTimer = setInterval(() => this.reap(), 10000);
    if (this.reapTimer.unref) this.reapTimer.unref();
  }

  attach(wss, server) {
    this.wss = wss;
    wss.on('connection', (sock, req) => this.onConnection(sock, req));
    if (server) {
      server.on('upgrade', (req, socket, head) => {
        // let ws handle /ws only; everything else gets a clean reset
        const url = new URL(req.url, 'http://x');
        if (url.pathname !== '/ws') {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });
    }
  }

  online() {
    return this.wss ? this.wss.clients.size : 0;
  }

  onConnection(sock, req) {
    sock.isAlive = true;
    sock.meta = { name: 'Guest', room: null, pid: null, joinedAt: Date.now(), msgs: 0, lastInput: 0 };
    sock.on('pong', () => {
      sock.isAlive = true;
    });
    sock.on('message', (raw) => this.onMessage(sock, raw));
    sock.on('close', () => this.onClose(sock));
    sock.on('error', () => {
      try {
        sock.close();
      } catch {
        /* already gone */
      }
    });
    if (!this.pingTimer) this.startPing();
    this.send(sock, {
      t: 'welcome',
      online: this.online(),
      games: GAME_LIST,
      stats: { ...this.publicStats() },
      leaderboard: this.leaderboard.all(),
      rooms: this.listRooms(),
      serverTime: Date.now(),
    });
  }

  startPing() {
    this.pingTimer = setInterval(() => {
      for (const sock of this.wss.clients) {
        if (!sock.isAlive) {
          try {
            sock.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
        sock.isAlive = false;
        try {
          sock.ping();
        } catch {
          /* ignore */
        }
      }
    }, 25000);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  publicStats() {
    return {
      online: this.online(),
      rooms: this.rooms.size,
      matches: this.stats.matches,
      uptimeSec: Math.round((Date.now() - this.stats.started) / 1000),
    };
  }

  listRooms() {
    return [...this.rooms.values()]
      .filter((r) => !r.private)
      .map((r) => r.info())
      .sort((a, b) => a.count - b.count || b.createdAt - a.createdAt)
      .slice(0, 24);
  }

  broadcastRooms() {
    const msg = { t: 'rooms', rooms: this.listRooms(), stats: this.publicStats() };
    this.lobbyBroadcast(msg);
    for (const r of this.rooms.values()) r.broadcast({ t: 'roster', info: r.info() });
  }

  lobbyBroadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const sock of this.lobby) {
      if (sock.readyState === 1) {
        try {
          sock.send(raw);
        } catch {
          /* ignore */
        }
      }
    }
  }

  send(sock, msg) {
    if (sock.readyState === 1) {
      try {
        sock.send(JSON.stringify(msg));
      } catch {
        /* ignore */
      }
    }
  }

  createRoom(gameId, opts = {}) {
    if (!GAMES[gameId]) return null;
    const room = new Room(this, gameId, opts);
    this.rooms.set(room.id, room);
    return room;
  }

  closeRoom(id) {
    const room = this.rooms.get(id);
    if (!room) return;
    for (const p of room.players.values()) {
      if (p.sock) this.send(p.sock, { t: 'closed', room: id });
      if (p.sock) {
        p.sock.room = null;
        p.sock.pid = null;
      }
    }
    room.stop();
    this.rooms.delete(id);
    this.broadcastRooms();
  }

  addCpu(room) {
    if (!room) return;
    const bot = room.addBot();
    if (bot) room.broadcast({ t: 'cpu', added: true });
    return bot;
  }

  removeCpu(room) {
    const bot = [...room.players.values()].find((p) => p.bot);
    if (!bot) return;
    room.removePlayer(bot.pid);
    room.broadcast({ t: 'cpu', added: false });
  }

  findOpenRoom(gameId) {
    const open = [...this.rooms.values()].filter(
      (r) => r.gameId === gameId && !r.private && r.status === 'waiting' && r.canAccept()
    );
    open.sort((a, b) => b.players.size - a.players.size || a.createdAt - b.createdAt);
    return open[0] || null;
  }

  joinRoom(sock, room, opts = {}) {
    const prev = sock.meta.room ? this.rooms.get(sock.meta.room) : null;
    if (prev) prev.removePlayer(sock.meta.pid);
    const player = room.addPlayer(sock, { name: sock.meta.name });
    sock.meta.room = room.id;
    sock.meta.pid = player.pid;
    this.stats.joins += 1;
    this.send(sock, {
      t: 'joined',
      room: room.info(),
      pid: player.pid,
      side: player.side,
      chat: room.chat.slice(-12),
    });
    room.broadcast({ t: 'roster', info: room.info(), joined: player.name }, player.pid);
    room.chatSend({ name: 'ARCADE', room: room.id }, `${player.name} entered ${room.def.name}`);
    if (opts.vsCpu && room.humanCount() === 1) this.addCpu(room);
    const need = Math.max(2, room.def.minPlayers);
    if (opts.vsCpu || room.players.size >= need) {
      if (room.players.size < 2 && !room.private) this.addCpu(room);
      room.start();
    }
    this.broadcastRooms();
    return player;
  }

  onMessage(sock, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return this.send(sock, { t: 'err', m: 'Expected JSON.' });
    }
    if (!msg || typeof msg.t !== 'string') return;

    // crude flood control: one second window, 120 messages max
    const now = Date.now();
    if (!sock.meta.windowStart || now - sock.meta.windowStart > 1000) {
      sock.meta.windowStart = now;
      sock.meta.burst = 0;
    }
    sock.meta.burst = (sock.meta.burst || 0) + 1;
    if (sock.meta.burst > 120) {
      this.send(sock, { t: 'err', m: 'Slow down - too many messages.' });
      sock.close(1008, 'rate limit');
      return;
    }

    switch (msg.t) {
      case 'hello': {
        const name = String(msg.name || '').slice(0, 18).replace(/[^\w \-.!'#]/g, '').trim();
        sock.meta.name = name || `Guest${Math.floor(Math.random() * 900 + 100)}`;
        if (msg.watch !== false) this.lobby.add(sock);
        this.send(sock, { t: 'you', name: sock.meta.name, online: this.online() });
        break;
      }
      case 'rooms':
        this.send(sock, { t: 'rooms', rooms: this.listRooms(), stats: this.publicStats() });
        break;
      case 'leader':
        this.send(sock, { t: 'leader', board: this.leaderboard.all() });
        break;
      case 'create': {
        if (!GAMES[msg.game]) return this.send(sock, { t: 'err', m: 'Unknown game.' });
        const room = this.createRoom(msg.game, { private: !!msg.private });
        this.joinRoom(sock, room, { vsCpu: msg.vsCpu });
        break;
      }
      case 'quick': {
        const room = this.findOpenRoom(msg.game) || this.createRoom(msg.game, {});
        if (!room) return this.send(sock, { t: 'err', m: 'That game is not available.' });
        this.joinRoom(sock, room, { vsCpu: msg.vsCpu });
        break;
      }
      case 'join': {
        const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const room = this.rooms.get(code);
        if (!room) return this.send(sock, { t: 'err', m: `No room ${code || '??'}. Check the code.` });
        if (!room.canAccept()) return this.send(sock, { t: 'err', m: `${room.def.name} room is full (${room.def.maxPlayers} max).` });
        this.joinRoom(sock, room, {});
        break;
      }
      case 'addCpu': {
        const room = this.rooms.get(sock.meta.room);
        if (!room) return;
        if (room.hostPid !== sock.meta.pid) return this.send(sock, { t: 'err', m: 'Only the room host can add a CPU.' });
        this.addCpu(room);
        room.start();
        break;
      }
      case 'removeCpu': {
        const room = this.rooms.get(sock.meta.room);
        if (!room) return;
        if (room.hostPid !== sock.meta.pid) return this.send(sock, { t: 'err', m: 'Only the room host can remove the CPU.' });
        this.removeCpu(room);
        break;
      }
      case 'restart': {
        const room = this.rooms.get(sock.meta.room);
        if (room && room.status === 'over') room.restartNow();
        break;
      }
      case 'input': {
        const room = this.rooms.get(sock.meta.room);
        if (!room || !room.players.has(sock.meta.pid)) return;
        const player = room.players.get(sock.meta.pid);
        room.touch();
        room.def.input(room.game, player, msg);
        if (room.gameId === 'g2048' && room.game.over) room.endRound();
        if (room.game.over && room.status === 'live') room.endRound();
        break;
      }
      case 'chat': {
        const room = this.rooms.get(sock.meta.room);
        if (!room) return this.send(sock, { t: 'chat', from: sock.meta.name, text: String(msg.text || '').slice(0, 140), at: Date.now() });
        room.chatSend({ name: sock.meta.name }, msg.text);
        break;
      }
      case 'score': {
        const score = Math.floor(Number(msg.score));
        const game = GAMES[msg.game] ? msg.game : null;
        if (!game || !Number.isFinite(score) || score < 0 || score > 5_000_000) return;
        this.leaderboard.record(game, { name: sock.meta.name, score, mode: msg.mode === 'solo' ? 'solo' : 'online' });
        this.lobbyBroadcast({ t: 'leader', board: this.leaderboard.all() });
        break;
      }
      case 'leave': {
        const room = this.rooms.get(sock.meta.room);
        if (room) room.removePlayer(sock.meta.pid);
        sock.meta.room = null;
        sock.meta.pid = null;
        this.broadcastRooms();
        break;
      }
      default:
        break;
    }
  }

  onClose(sock) {
    this.lobby.delete(sock);
    const room = sock.meta?.room ? this.rooms.get(sock.meta.room) : null;
    if (room && sock.meta.pid) room.removePlayer(sock.meta.pid);
    this.broadcastRooms();
  }

  reap() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.players.size === 0 && now - room.lastActive > 60000) this.closeRoom(room.id);
      else if (room.humanCount() === 0 && now - room.lastActive > 120000) this.closeRoom(room.id);
      else if (now - room.createdAt > 6 * 60 * 60 * 1000 && room.humanCount() === 0) this.closeRoom(room.id);
    }
  }

  shutdown() {
    clearInterval(this.pingTimer);
    clearInterval(this.reapTimer);
    for (const room of this.rooms.values()) {
      room.stop();
      room.broadcast({ t: 'closed', reason: 'server' });
    }
    this.rooms.clear();
  }
}
