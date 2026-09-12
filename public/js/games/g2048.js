// 2048 cabinet. Your board is always yours (client-owned, zero input lag);
// the server relays your score/tile progress to the rival and referees the race.
import { $, el, fmtNum, overlay, clearOverlay, renderRoster, Sfx, store } from '../ui.js';
import { Grid2048, G2048 } from '../../shared/g2048.js';

export function mount({ arena, session, rival } = {}) {
  const wrap = el('div', { style: 'display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,.65fr);gap:14px;padding:14px;background:#04020a' });
  const mine = el('div', { class: 'grid4' });
  const sidePanel = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
  const rivalCard = el('div', { class: 'rival' });
  const stats = el('div', { class: 'rival', style: 'display:flex;flex-direction:column;gap:4px' });
  sidePanel.append(el('div', { class: 'tiny muted', text: session.mode === 'solo' ? 'CPU rival' : 'Live rival board' }), rivalCard, stats);
  wrap.append(mine, sidePanel);
  arena.append(wrap);

  const cells = [];
  for (let i = 0; i < 16; i++) {
    const t = el('div', { class: 'tile4' });
    mine.append(t);
    cells.push(t);
  }
  const mini = [];
  const miniGrid = el('div', { class: 'mini4' });
  for (let i = 0; i < 16; i++) {
    const dot = el('i');
    miniGrid.append(dot);
    mini.push(dot);
  }
  const rivalName = el('div', { class: 'tiny muted', text: 'waiting for rival…' });
  const rivalScore = el('div', { style: 'font-size:22px;color:var(--mg);text-shadow:var(--glow-mg)', text: '0' });
  rivalCard.append(rivalName, miniGrid, el('div', { class: 'tiny muted', text: 'score' }), rivalScore);

  const hud = {
    score: $('#hudScore', arena.parentElement),
    best: $('#hudBest', arena.parentElement),
    tiles: $('#hudTiles', arena.parentElement),
    roster: $('#roster', arena.parentElement),
  };
  let best = store.get('na.best.g2048', 0) || 0;

  let grid = new Grid2048({});
  let snap = null;
  let newTile = -1;

  const paint = () => {
    const vals = grid.cells;
    for (let i = 0; i < 16; i++) {
      const v = vals[i];
      cells[i].dataset.v = v || '';
      cells[i].textContent = v || '';
      cells[i].classList.toggle('new', i === newTile);
    }
    if (hud.score) hud.score.textContent = fmtNum(grid.score);
    if (hud.best) hud.best.textContent = fmtNum(best);
    if (hud.tiles) hud.tiles.textContent = `best ${grid.maxTile()}`;
    report();
  };

  function report() {
    session.send({ t: 'input', state: grid.snapshot() });
  }

  const off = [
    session.on('state', (msg) => {
      snap = msg.s;
      paintRival();
      if (snap.over) paintRace();
    }),
    session.on('joined', (m) => {
      if (m.room?.status === 'waiting' && session.mode !== 'solo') {
        overlay(arena, {
          title: '2048 Versus',
          sub: `Both boards start on the same seed rule: first to mint a 2048 wins. Room code ${m.room.id}.`,
          actions: [
            { label: 'Race CPU now', cls: 'gr', fn: () => session.send({ t: 'addCpu' }) },
            { label: 'Just solo', cls: 'ghost', fn: () => (location.href = hrefWith({ mode: 'solo' })) },
          ],
        });
      }
      paintRival();
    }),
    session.on('ev', (msg) => {
      for (const ev of msg.ev || []) if (ev.k === 'over') paintRace();
    }),
    session.on('roundOver', () => paintRace()),
    session.on('restarted', () => {
      clearOverlay(arena);
      grid = new Grid2048({});
      newTile = -1;
      paint();
    }),
  ];

  function paintRival() {
    if (!snap) {
      rivalName.textContent = 'waiting for rival…';
      return;
    }
    const meId = session.pid || 'p0';
    const other = snap.players.find((p) => p.id !== meId) || null;
    rivalName.textContent = other ? `${other.n}${other.bot ? ' · CPU' : ''}${other.over ? ' · stuck' : ''}` : 'no rival - solo grind';
    rivalScore.textContent = fmtNum(other?.score || 0);
    const rows = other?.grid || [];
    const flat = rows.flat();
    for (let i = 0; i < 16; i++) {
      const v = flat[i] || 0;
      const hue = v >= G2048.WIN_TILE ? 0 : v >= 128 ? 30 : v >= 16 ? 312 : 190;
      const light = v ? Math.min(72, 28 + Math.log2(v) * 6) : 10;
      mini[i].style.background = v ? `hsl(${hue} 90% ${light}%)` : 'rgba(255,255,255,.05)';
      mini[i].title = v ? String(v) : '';
    }
    stats.innerHTML = '';
    for (const p of snap.players) {
      stats.append(
        el('div', { class: 'tiny', style: `display:flex;gap:8px;color:${p.id === meId ? 'var(--cy)' : 'var(--mg)'}` }, [
          el('span', { text: `${p.n}${p.bot ? ' · CPU' : ''}` }),
          el('span', { text: fmtNum(p.score) }),
          el('span', { class: 'muted', text: `tile ${p.max}` }),
          el('span', { class: 'muted', text: `${p.moves} moves` }),
        ])
      );
    }
    renderRoster(hud.roster, snap.players.map((p) => ({ id: p.id, name: p.n, hue: p.h, score: p.score, bot: p.bot })), { pid: session.pid });
  }

  function paintRace() {
    if (arena.querySelector('.overlay.over')) return;
    const meId = session.pid || 'p0';
    const won = snap?.winner === meId;
    const stuck = grid.over;
    let title = won ? 'You win the race' : snap?.winner ? 'Rival wins the race' : stuck ? 'Board locked' : 'Round over';
    if (grid.won && won) title = '2048 minted';
    const box = overlay(arena, {
      title,
      kind: won ? 'win' : 'lose',
      sub: `You finished on ${grid.maxTile()} with ${fmtNum(grid.score)} points in ${grid.moves} moves.`,
      rows: [
        { label: 'your score', value: fmtNum(grid.score) },
        { label: 'personal best', value: fmtNum(best) },
        ...(snap && snap.players.length > 1 ? [{ label: 'rival score', value: fmtNum(snap.players.find((p) => p.id !== meId)?.score || 0) }] : []),
      ],
      actions: [
        { label: 'New board', cls: 'gr', fn: () => session.send({ t: 'restart' }) },
        { label: 'Back to lobby', cls: 'ghost', fn: () => (location.href = indexPath()) },
      ],
    });
    box?.classList.add('over');
    Sfx.play(won || grid.won ? 'win' : 'lose');
    if (grid.score > best) {
      best = grid.score;
      store.set('na.best.g2048', best);
    }
    if (session.mode === 'solo') session.results(grid.score, 'solo');
  }

  const KEYS = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    w: 'up',
    s: 'down',
    a: 'left',
    d: 'right',
    W: 'up',
    S: 'down',
    A: 'left',
    D: 'right',
    k: 'up',
    j: 'down',
    h: 'left',
    l: 'right',
  };
  function doMove(dir) {
    if (grid.over) return;
    const before = grid.score;
    const res = grid.move(dir);
    if (!res.moved) {
      Sfx.play('wall', 0.5);
      return;
    }
    newTile = res.spawn?.i ?? -1;
    if (res.gained) Sfx.play('merge', Math.min(1.4, 0.7 + res.gained / 300));
    else Sfx.play('flip', 0.5);
    if (grid.won) Sfx.play('win');
    if (grid.score > best) {
      best = grid.score;
      store.set('na.best.g2048', best);
    }
    paint();
    if (grid.over) paintRace();
    void before;
  }
  const onKey = (e) => {
    const dir = KEYS[e.key];
    if (!dir) return;
    e.preventDefault();
    doMove(dir);
  };
  window.addEventListener('keydown', onKey);

  let t0 = null;
  const onTouchStart = (e) => {
    const t = e.touches[0];
    t0 = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e) => {
    if (!t0) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - t0.x;
    const dy = t.clientY - t0.y;
    t0 = null;
    if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
    doMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
  };
  arena.addEventListener('touchstart', onTouchStart, { passive: true });
  arena.addEventListener('touchend', onTouchEnd, { passive: true });

  const btns = el('div', { class: 'dpad', style: 'display:flex;gap:8px;justify-content:center;padding:0 14px 14px' });
  for (const [dir, label] of [['up', '▲'], ['down', '▼'], ['left', '◀'], ['right', '▶']]) {
    const b = el('button', { type: 'button', text: label, 'aria-label': `slide ${dir}` });
    b.addEventListener('click', () => doMove(dir));
    btns.append(b);
  }
  arena.append(btns);

  paint();
  paintRival();
  return {
    destroy() {
      window.removeEventListener('keydown', onKey);
      arena.removeEventListener('touchstart', onTouchStart);
      arena.removeEventListener('touchend', onTouchEnd);
      for (const f of off) f?.();
      wrap.remove();
      btns.remove();
    },
  };
}

function hrefWith(patch) {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(patch)) u.searchParams.set(k, v);
  return u.pathname + u.search;
}
function indexPath() {
  return location.pathname.replace(/play\.html$/, '') + (location.pathname.endsWith('/') ? '' : './');
}
