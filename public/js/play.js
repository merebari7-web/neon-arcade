// Cabinet host: builds a session (online room or local solo), mounts the game,
// and wires the shared dock (chat, board, rules, pills).
import { $, $$, el, toast, store, overlay, clearOverlay, connectionPill, wireChat, renderBoard, Sfx, fmtNum } from './ui.js';
import { Session, parseQuery } from './session.js';
import { GAMES, GAME_META } from '../shared/defs.js';

const q = parseQuery();
const GAME = q.game && GAMES[q.game] ? q.game : 'snake';
// GitHub Pages (and opening the file straight off disk) has no Node server behind it,
// so the cabinets default to the local engine there instead of a dead connection screen.
const STATIC_HOST = typeof location !== 'undefined' && (location.protocol === 'file:' || /github\.io$/.test(location.hostname));
const MODE = q.mode === 'solo' || (!q.mode && STATIC_HOST && !q.room) ? 'solo' : 'online';
const meta = GAMES[GAME];
const def = GAMES[GAME];
const gm = GAME_META[GAME] || {};

document.title = `${meta.name} · NEON ARCADE`;
$('#gameName').textContent = meta.name.toUpperCase();
$('#hint').textContent = gm.rules || '';

// HUD cells this cabinet does not use get hidden, so the bar stays tight.
const USED = {
  snake: ['score', 'rank', 'time'],
  breakout: ['score', 'lives', 'bricks', 'time'],
  memory: ['score', 'pairs', 'clock'],
  g2048: ['score', 'tiles', 'best'],
}[GAME] || ['score'];
for (const cell of $$('#hud .cell')) cell.classList.toggle('hidden', !USED.includes(cell.dataset.for));

const session = new Session({
  mode: MODE,
  game: GAME,
  code: q.room ? String(q.room).toUpperCase() : null,
  quick: !q.new,
  private: !!q.new,
  vsCpu: q.cpu === '1',
  name: store.get('na.name', 'Guest'),
});

connectionPill($('#connPill'), session);

// ---------------------------------------------------------------- room pill
let roomCode = null;
const roomPill = $('#roomPill');
function paintRoom() {
  const codeEl = $('#roomCode');
  codeEl.innerHTML = '';
  if (MODE === 'solo') {
    codeEl.append(el('span', { text: 'SOLO', style: 'letter-spacing:.2em' }));
    roomPill.title = 'Local engine - no server needed, works offline';
    $('#btnCpu').classList.add('hidden');
    return;
  }
  if (!roomCode) {
    codeEl.append(el('span', { text: q.room ? String(q.room).toUpperCase() : 'joining…' }));
    roomPill.title = 'waiting for the arcade server';
    return;
  }
  codeEl.append(
    el('span', { text: roomCode, style: 'letter-spacing:.24em' }),
    el('button', {
      class: 'btn sm ghost',
      type: 'button',
      text: 'copy code',
      style: 'margin-left:8px',
      onclick: () => {
        if (!navigator.clipboard?.writeText) return toast(`code is ${roomCode}`, 'info');
        navigator.clipboard.writeText(roomCode).then(
          () => toast(`code ${roomCode} copied`, 'good', 1600),
          () => toast('copy blocked by the browser', 'bad')
        );
      },
    })
  );
  roomPill.title = 'Send this code to a friend - they use “join by code” in the lobby';
}
paintRoom();

// ---------------------------------------------------------------- help panel
(function buildHelp() {
  const root = $('#help');
  root.innerHTML = '';
  root.append(el('p', { class: 'muted', style: 'margin:0 0 10px', text: gm.rules || '' }));
  const dl = el('dl');
  if (gm.controls?.length) {
    dl.append(el('dt', { text: 'controls' }));
    const list = el('dd');
    for (const [keys, what] of gm.controls) list.append(el('div', { style: 'margin-bottom:5px' }, [el('kbd', { text: keys }), ' ', el('span', { class: 'muted', text: what })]));
    dl.append(list);
  }
  dl.append(el('dt', { text: 'scoring' }), el('dd', { class: 'muted', text: gm.scoring || '—' }));
  root.append(dl);
  root.append(
    el('p', { class: 'tiny muted', style: 'margin:12px 0 0' }, [
      el('a', { href: './', text: 'Lobby' }),
      ' · rounds restart themselves a few seconds after every result.',
    ])
  );
})();

// ---------------------------------------------------------------- board + chat
renderBoard($('#board'), {}, { games: [{ id: GAME, name: meta.name }], highlight: store.get('na.name', '') });
$('#boardNote').textContent = MODE === 'solo' ? 'saved in this browser' : `server board · ${meta.name}`;
wireChat($('#chatLog'), $('#chatForm'), session, { me: store.get('na.name', 'You'), enabled: MODE === 'online' });
$('#chatState').textContent = MODE === 'online' ? 'connecting' : 'solo mode';

// ---------------------------------------------------------------- dock buttons
$('#btnCpu').addEventListener('click', (e) => {
  const hasCpu = session.roomInfo?.players?.some((p) => p.bot);
  session.send({ t: hasCpu ? 'removeCpu' : 'addCpu' });
  e.currentTarget.textContent = hasCpu ? 'add cpu' : 'remove cpu';
});
$('#btnRestart').addEventListener('click', () => {
  session.send({ t: 'restart' });
  toast('restarting the round', 'info', 1400);
});
$('#btnFull').addEventListener('click', () => {
  if (document.fullscreenElement) return document.exitFullscreen?.();
  document.documentElement.requestFullscreen?.().catch(() => toast('fullscreen blocked by the browser', 'bad', 1600));
});
window.addEventListener('beforeunload', () => session.send({ t: 'leave' }));

// ---------------------------------------------------------------- session hooks
session.on('joined', (msg) => {
  roomCode = msg.room?.id || null;
  session.roomInfo = msg.room;
  paintRoom();
  $('#chatState').textContent = 'live';
  if (msg.room?.players?.some((p) => p.bot)) $('#btnCpu').textContent = 'remove cpu';
  clearOverlay($('#arena'));
  if (GAME === 'breakout' && msg.side) toast(`you are the ${msg.side} paddle`, 'info', 2600);
  else if (MODE === 'online') toast(`room ${roomCode} - invite a friend with the code`, 'info', 2600);
});
session.on('roster', (msg) => {
  if (msg.info) session.roomInfo = msg.info;
  if (msg.joined) toast(`${msg.joined} joined`, 'info', 1600);
  if (msg.info?.players?.some((p) => p.bot)) $('#btnCpu').textContent = 'remove cpu';
  else $('#btnCpu').textContent = 'add cpu';
});
session.on('restarted', () => clearOverlay($('#arena')));
session.on('cpu', (m) => toast(m.added ? 'CPU rival added' : 'CPU rival removed', 'info', 1600));
session.on('err', (m) => toast(m.m, 'bad', 3000));
session.on('notice', (m) => toast(m.text, 'warn', 3000));
session.on('closedRoom', () => {
  overlay($('#arena'), {
    title: 'room closed',
    kind: 'lose',
    sub: 'The host shut the room down, or the arcade server restarted.',
    actions: [
      { label: 'play solo here', cls: 'gr', fn: () => (location.href = `./play.html?game=${GAME}&mode=solo`) },
      { label: 'back to the lobby', cls: 'ghost', fn: () => (location.href = './') },
    ],
  });
});
session.on('leader', ({ board }) => renderBoard($('#board'), board || {}, { games: [{ id: GAME, name: meta.name }], highlight: store.get('na.name', '') }));
session.on('best', ({ best }) => {
  $('#hudBest').textContent = fmtNum(best);
  toast(`personal best ${fmtNum(best)}`, 'good', 1800);
});
session.on('status', ({ status }) => {
  if (MODE === 'online' && status === 'offline') {
    $('#chatState').textContent = 'offline';
    if (!$('#arena').querySelector('.overlay')) offlineFallback();
  }
});

function offlineFallback() {
  overlay($('#arena'), {
    title: 'arcade server offline',
    kind: 'lose',
    sub: 'Online rooms need the Node server (npm start). The solo cabinet runs entirely in this tab, so you can play right now.',
    actions: [
      { label: 'play solo', cls: 'gr', fn: () => (location.href = `./play.html?game=${GAME}&mode=solo`) },
      { label: 'try the server again', cls: 'ghost', fn: () => location.reload() },
      { label: 'back to lobby', cls: 'ghost', fn: () => (location.href = './') },
    ],
  });
}

// ---------------------------------------------------------------- boot
let game = null;
const gameFile = { snake: './games/snake.js', breakout: './games/breakout.js', memory: './games/memory.js', g2048: './games/g2048.js' }[GAME];

(async function boot() {
  if (MODE === 'online') overlay($('#arena'), { title: 'booting cabinet', sub: `${meta.name} · connecting to the arcade server` });
  try {
    const mod = await import(gameFile);
    game = mod.mount({ arena: $('#arena'), session, meta: { tickHz: def.tickHz, stateHz: def.stateHz || def.tickHz } });
  } catch (err) {
    console.error('[mount]', err);
    toast('this cabinet failed to load', 'bad', 3000);
    return;
  }
  if (MODE === 'online') {
    try {
      await session.connect();
    } catch (err) {
      console.warn('[connect]', err?.message);
      offlineFallback();
    }
  } else {
    await session.connect();
  }
})();

window.addEventListener('pagehide', () => {
  try {
    session.send({ t: 'leave' });
  } catch {
    /* ignore */
  }
  game?.destroy?.();
  session.close();
});
void Sfx;
