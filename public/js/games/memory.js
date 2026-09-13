// Memory Match cabinet - DOM grid, flip on click, turn clock on screen.
import { $, el, fmtNum, overlay, clearOverlay, renderRoster, Sfx } from '../ui.js';
import { MEMORY } from '../../shared/memory.js';

export function mount({ arena, session } = {}) {
  const board = el('div', { class: 'grid-cards' });
  arena.append(board);
  const cards = [];
  for (let i = 0; i < 16; i++) {
    const btn = el('button', { class: 'mcard', type: 'button', 'data-i': i, 'aria-label': `tile ${i + 1}` });
    btn.addEventListener('click', () => {
      Sfx.play('flip');
      session.send({ t: 'input', idx: i });
    });
    board.append(btn);
    cards.push({ btn, face: el('span', { class: 'q', text: '?' }), sym: el('span', { class: 'sym' }) });
    cards[i].btn.append(cards[i].face, cards[i].sym);
  }

  const hud = {
    score: $('#hudScore', arena.parentElement),
    time: $('#hudTime', arena.parentElement),
    clock: $('#hudClock', arena.parentElement),
    pairs: $('#hudPairs', arena.parentElement),
    roster: $('#roster', arena.parentElement),
  };
  const clockBar = hud.clock?.querySelector('.bar') || makeBar(hud.clock);

  let snap = null;
  const off = [
    session.on('state', (msg) => {
      snap = msg.s;
      paint();
      if (snap.over) paintOver();
      else if (snap.turn === (session.pid || 'p0')) clearOverlay(arena);
      else if (!arena.querySelector('.overlay.wait')) paintWaiting();
    }),
    session.on('joined', (m) => {
      if (m.room?.status === 'waiting') {
        overlay(arena, {
          title: 'Pick your tiles',
          sub: m.room.solo ? 'Solo: the CPU remembers every tile it has seen.' : `First flip starts the duel. Room code ${m.room.id}.`,
          actions: [{ label: 'Play CPU now', cls: 'gr', fn: () => session.send({ t: 'addCpu' }) }],
        });
      }
    }),
    session.on('ev', (msg) => applyEvents(msg.ev || [])),
    session.on('restarted', () => {
      clearOverlay(arena);
    }),
    session.on('roundOver', () => paintOver()),
  ];

  function applyEvents(events) {
    for (const ev of events) {
      if (ev.k === 'match') Sfx.play('match');
      else if (ev.k === 'miss') Sfx.play('crack');
      else if (ev.k === 'timeout') Sfx.play('miss');
      else if (ev.k === 'flip') Sfx.play('flip');
    }
  }

  function paintWaiting() {
    if (arena.querySelector('.overlay')) return;
    const who = snap?.players.find((p) => p.id === snap.turn);
    // a banner, not a curtain: the whole point of the rival's turn is to watch it
    const box = overlay(arena, {
      banner: true,
      title: `${who?.n || 'Rival'}'s turn`,
      sub: 'Watch the tiles - every card they flip is information you get for free.',
    });
    box?.classList.add('wait');
  }

  function paint() {
    if (!snap) return;
    const open = new Set(snap.open || []);
    snap.cards.forEach((card, i) => {
      const set = cards[i];
      set.btn.classList.toggle('gone', !!card.matched);
      set.btn.classList.toggle('up', !!card.matched || open.has(i));
      const show = card.matched || open.has(i) ? card.sym : '';
      set.sym.textContent = show;
      set.face.style.display = show ? 'none' : '';
      set.btn.disabled = snap.over || !!card.matched || !myTurn() || (snap.resolveIn || 0) > 0;
    });
    const me = snap.players.find((p) => p.id === (session.pid || 'p0')) || snap.players[0];
    if (hud.score) hud.score.textContent = fmtNum(me?.score || 0);
    if (hud.pairs) hud.pairs.textContent = `${me?.matched || 0} pairs`;
    if (hud.time) {
      const left = Math.max(0, (snap.turnBudget || MEMORY.TURN_TICKS) - (snap.turnTicks || 0)) / MEMORY.TICK_HZ;
      hud.time.textContent = `${(left || 0).toFixed(1)}s`;
    }
    if (clockBar) {
      const k = 1 - Math.min(1, (snap.turnTicks || 0) / (snap.turnBudget || 60));
      clockBar.style.width = `${Math.round(k * 100)}%`;
      clockBar.style.background = k > 0.4 ? 'var(--cy)' : 'var(--rd)';
      clockBar.style.boxShadow = `0 0 14px ${k > 0.4 ? 'var(--cy)' : 'var(--rd)'}`;
    }
    renderRoster(
      hud.roster,
      snap.players.map((p) => ({ id: p.id, name: p.n, hue: p.h, score: p.score, bot: p.bot })),
      { pid: session.pid, turnId: snap.turn }
    );
  }

  function myTurn() {
    return snap?.turn === (session.pid || 'p0');
  }

  function paintOver() {
    if (arena.querySelector('.overlay.over')) return;
    const me = snap?.players.find((p) => p.id === (session.pid || 'p0'));
    const won = snap?.winner && snap.winner === me?.id;
    const box = overlay(arena, {
      title: won ? 'Memory wins the duel' : 'Out-memorised',
      kind: won ? 'win' : 'lose',
      sub: `Pairs, streaks and misses all count. Next board is already shuffling.`,
      rows: (snap?.players || []).map((p) => ({ label: `${p.n} · ${p.matched} pairs`, value: fmtNum(p.score) })),
      actions: [{ label: 'New board', cls: 'gr', fn: () => session.send({ t: 'restart' }) }],
    });
    box?.classList.add('over');
    Sfx.play(won ? 'win' : 'lose');
    if (session.mode === 'solo') session.results(me?.score || 0, 'solo');
  }

  const onKey = (e) => {
    if (/^[0-9]$/.test(e.key)) {
      const n = e.key === '0' ? 9 : Number(e.key) - 1;
      cards[n]?.btn.click();
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', onKey);

  return {
    destroy() {
      window.removeEventListener('keydown', onKey);
      for (const f of off) f?.();
      board.remove();
    },
  };
}

function makeBar(host) {
  if (!host) return null;
  host.innerHTML = '';
  const track = el('div', { style: 'height:5px;border-radius:99px;background:rgba(140,170,255,.16);overflow:hidden;width:110px' });
  const bar = el('div', { class: 'bar', style: 'height:100%;width:100%;background:var(--cy);border-radius:99px' });
  track.append(bar);
  host.append(track);
  return bar;
}
