// Lobby page: live room browser, high scores, attract mode.
import { $, el, toast, store, renderBoard, wireName, wireSoundToggle, fmtNum } from './ui.js';
import { Session } from './session.js';
import { attract } from './attract.js';
import { GAME_LIST, GAME_META } from '../shared/defs.js';

// one source of truth for "which cabinets exist" - shared with the server
const GAME_ORDER = GAME_LIST.map((g) => g.id);
const NAMES = Object.fromEntries(GAME_ORDER.map((id) => [id, GAME_META[id]?.name || id]));

let session = null;
let filter = '';
let lastRooms = [];

// ---------------------------------------------------------------- attract mode
try {
  const host = $('#attract');
  if (host) {
    const demo = attract(host);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) demo.stop();
    });
  }
} catch (err) {
  console.warn('attract mode unavailable', err);
}

// ---------------------------------------------------------------- session
session = new Session({ mode: 'online', autoJoin: false, name: store.get('na.name', 'Guest') });
wireName($('#name'), session);
wireSoundToggle($('#sound'));

session.on('status', ({ status }) => {
  const note = $('#serverNote');
  if (!note) return;
  if (status === 'online') note.textContent = 'arcade server connected - rooms and chat are live';
  else if (status === 'connecting') note.textContent = 'connecting to the arcade server…';
  else note.textContent = 'no arcade server: online rooms are paused, but every solo cabinet still works';
  for (const btn of document.querySelectorAll('[data-needs-server]')) btn.disabled = status !== 'online';
});

session.on('err', (m) => toast(m.m, 'bad'));
session.on('rooms', ({ rooms, stats }) => {
  lastRooms = rooms || [];
  renderRooms();
  paintStats(stats);
});
session.on('leader', ({ board }) => paintBoard(board));

function paintBoard(board) {
  renderBoard($('#board'), board || {}, { games: GAME_ORDER.map((id) => ({ id, name: nameOf(id) })), highlight: store.get('na.name', '') });
}
session.on('welcome', (msg) => {
  paintBoard(msg.leaderboard);
  paintStats(msg.stats);
});
session.on('chat', (m) => {
  if (m.from === 'ARCADE') pushTicker(m.text);
});

const nameOf = (id) => NAMES[id] || id;

function paintStats(stats) {
  if (!stats) return;
  const set = (id, v) => {
    const n = $(id);
    if (n) n.textContent = v;
  };
  set('#stOnline', fmtNum(stats.online || 0));
  set('#stRooms', fmtNum(stats.rooms || 0));
  set('#stMatches', fmtNum(stats.matches || 0));
  set('#footOnline', fmtNum(stats.online || 0));
  const best = store.get('na.best.g2048', 0);
  set('#stBest', best ? fmtNum(best) : '0');
}

// ---------------------------------------------------------------- room list
function renderRooms() {
  const root = $('#roomList');
  if (!root) return;
  const rooms = lastRooms.filter((r) => !filter || r.game === filter);
  const note = $('#roomsHint');
  if (note) note.textContent = rooms.length ? `${rooms.length} room(s) you can drop into` : session.connected ? 'no open rooms - open one below' : 'no open rooms - solo cabinets still work offline';
  root.innerHTML = '';
  if (!rooms.length) {
    root.append(
      el('div', { class: 'empty', style: 'grid-column:1/-1' }, [
        el('div', { text: filter ? `no open ${nameOf(filter)} rooms` : 'no open rooms right now' }),
        el('div', { class: 'tiny', style: 'margin-top:8px' }, [
          el('a', { href: `./play.html?game=${filter || 'snake'}&new=1`, text: 'open one →', class: '' }),
        ]),
      ])
    );
    return;
  }
  for (const r of rooms) {
    const full = r.count >= r.max;
    const tile = el('div', { class: 'room', style: `--c:${accent(r.game)}` });
    tile.append(
      el('div', {}, [
        el('div', { class: 'code', text: r.id }),
        el('div', { class: 'meta' }, [`${nameOf(r.game)} · ${r.count}/${r.max}`]),
      ]),
      el('span', { class: 'grow' }),
      el('span', { class: `pill ${r.status === 'live' ? 'live' : 'warn'}` }, [el('span', { class: 'dot' }), el('span', { text: r.status === 'live' ? 'playing' : 'waiting' })]),
      full
        ? el('button', { class: 'btn ghost sm', type: 'button', disabled: true, text: 'full' })
        : el('a', { class: 'btn sm', href: `./play.html?room=${encodeURIComponent(r.id)}&game=${r.game}`, text: r.status === 'live' ? 'join next round' : 'join' })
    );
    tile.addEventListener('click', (e) => {
      if (e.target.tagName === 'A' || e.target.tagName === 'BUTTON') return;
      copy(r.id);
    });
    root.append(tile);
  }
}
const accent = (game) => ({ snake: 'var(--cy)', breakout: 'var(--mg)', memory: 'var(--yl)', g2048: 'var(--gr)' }[game] || 'var(--cy)');
function copy(code) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(code).then(() => toast(`room code ${code} copied`, 'good', 1500), () => {});
}

$('#roomFilter')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  filter = btn.dataset.game || '';
  for (const b of $('#roomFilter').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
  renderRooms();
});
$('#refreshRooms')?.addEventListener('click', () => {
  session.send({ t: 'rooms' });
  toast('room list refreshed', 'info', 1200);
});
$('#joinForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = ($('#joinCode').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (code.length < 4) return toast('That code is too short', 'bad');
  location.href = `./play.html?room=${code}`;
});
$('#rollId')?.addEventListener('click', () => {
  const pick = GAME_ORDER[Math.floor(Math.random() * GAME_ORDER.length)];
  location.href = `./play.html?game=${pick}&quick=1`;
});

// ---------------------------------------------------------------- marquee
const ticker = [];
function pushTicker(text) {
  ticker.push(text);
  while (ticker.length > 8) ticker.shift();
  paintMarquee();
}
function paintMarquee() {
  const root = $('#marquee');
  if (!root) return;
  const base = [
    'insert coin',
    '4 cabinets · snake up to 8 players',
    'share a 5-letter code to play a friend',
    'cpu rivals always on call',
    'no install, no account',
    ...ticker.slice(-3),
  ];
  const line = base.join('   ');
  root.innerHTML = '';
  root.append(el('span', { text: line }), el('span', { text: line }));
}
paintMarquee();
setInterval(paintMarquee, 8000);

// ---------------------------------------------------------------- connect
// paint the panels immediately so the lobby is never a blank page, server or no server
paintBoard({});
renderRooms();
session.connect().catch(() => {
  toast('arcade server not reachable - solo cabinets still work', 'warn', 3600);
});
// nudge the list occasionally in case another browser tab opened a room
setInterval(() => {
  if (session.connected) session.send({ t: 'rooms' });
}, 6000);
