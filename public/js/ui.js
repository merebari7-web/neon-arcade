// Small UI kit shared by the lobby and every cabinet: toasts, arcade sound,
// leaderboard/roster rendering, match overlays, chat dock, connection pill.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of [].concat(kids)) {
    if (kid == null) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode */
    }
  },
};

export const isTouch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
if (isTouch && typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => document.body.classList.add('touch'));

export function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}
export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
export function ago(ts) {
  const d = Math.round((Date.now() - ts) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
}
export const hsl = (h, s = 92, l = 62) => `hsl(${h} ${s}% ${l}%)`;

// ---------------------------------------------------------------------------
// Sound: two-line WebAudio synth. Off by default until first interaction so we
// never autospam, and muted for anyone who turns it off in the header.
// ---------------------------------------------------------------------------
const VOICES = {
  eat: { f: 620, f2: 900, d: 0.07, type: 'square', g: 0.05 },
  golden: { f: 700, f2: 1400, d: 0.14, type: 'square', g: 0.06 },
  kill: { f: 300, f2: 120, d: 0.18, type: 'sawtooth', g: 0.06 },
  crash: { f: 200, f2: 60, d: 0.24, type: 'triangle', g: 0.06 },
  step: { f: 180, f2: 180, d: 0.02, type: 'square', g: 0.012 },
  paddle: { f: 380, f2: 470, d: 0.05, type: 'square', g: 0.05 },
  wall: { f: 300, f2: 260, d: 0.04, type: 'square', g: 0.03 },
  break: { f: 520, f2: 980, d: 0.06, type: 'square', g: 0.05 },
  crack: { f: 240, f2: 300, d: 0.05, type: 'triangle', g: 0.04 },
  miss: { f: 260, f2: 90, d: 0.2, type: 'sawtooth', g: 0.05 },
  flip: { f: 480, f2: 620, d: 0.05, type: 'triangle', g: 0.04 },
  match: { f: 660, f2: 1180, d: 0.14, type: 'square', g: 0.05 },
  merge: { f: 420, f2: 760, d: 0.08, type: 'square', g: 0.045 },
  win: { f: 520, f2: 1560, d: 0.4, type: 'square', g: 0.06 },
  lose: { f: 420, f2: 90, d: 0.4, type: 'sawtooth', g: 0.05 },
  click: { f: 900, f2: 900, d: 0.02, type: 'square', g: 0.02 },
  join: { f: 520, f2: 880, d: 0.12, type: 'square', g: 0.04 },
  msg: { f: 760, f2: 760, d: 0.03, type: 'square', g: 0.02 },
};

export const Sfx = {
  ctx: null,
  enabled: store.get('na.sound', false),
  ready() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    return this.ctx;
  },
  set(on) {
    this.enabled = !!on;
    store.set('na.sound', this.enabled);
    if (on) this.play('click');
  },
  play(kind, vol = 1) {
    if (!this.enabled) return;
    const spec = VOICES[kind];
    const ctx = this.ready();
    if (!spec || !ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.f, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, spec.f2), t + spec.d);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(spec.g * vol, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + spec.d);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + spec.d + 0.02);
  },
};

// ---------------------------------------------------------------------------
let toastRoot = null;
export function toast(text, kind = 'info', ms = 2400) {
  if (!toastRoot) {
    toastRoot = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRoot);
  }
  const node = el('div', { class: `toast ${kind}`, text });
  toastRoot.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s, transform .3s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 320);
  }, ms);
  return node;
}

export function copyText(value) {
  const done = () => toast(`Copied ${value}`, 'good', 1400);
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value).then(done, () => fallback());
  fallback();
  function fallback() {
    const ta = el('textarea', { style: 'position:fixed;left:-9999px' });
    ta.value = value;
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch {
      toast('Copy failed - select it manually', 'bad');
    }
    ta.remove();
  }
}

// ---------------------------------------------------------------------------
export function renderBoard(root, board, { games, highlight = null } = {}) {
  if (!root) return;
  root.innerHTML = '';
  const lists = games.map((g) => ({ id: g.id, name: g.name, rows: board?.[g.id] || [] }));
  const wrap = el('div', { class: 'board-tabs' });
  const tabs = el('div', { class: 'seg', style: 'margin-bottom:10px;flex-wrap:wrap' });
  const body = el('div');
  let active = lists[0].id;
  const paint = () => {
    body.innerHTML = '';
    const set = lists.find((l) => l.id === active);
    if (!set.rows.length) {
      body.append(el('div', { class: 'empty', text: 'No scores yet - be the first name on the wall' }));
      return;
    }
    const table = el('table', { class: 'board' });
    table.append(
      el('thead', {}, [el('tr', {}, [el('th', { text: '#' }), el('th', { text: 'Player' }), el('th', { text: '' }), el('th', { text: 'Score', style: 'text-align:right' })])])
    );
    const tb = el('tbody');
    set.rows.forEach((row, i) => {
      tb.append(
        el('tr', { class: highlight && row.name === highlight ? 'me' : '' }, [
          el('td', { class: 'pos', text: String(i + 1) }),
          el('td', { text: row.name }),
          el('td', { class: 'mode', text: row.mode === 'online' ? 'online' : 'solo' }),
          el('td', { class: 'score', text: fmtNum(row.score) }),
        ])
      );
    });
    table.append(tb);
    body.append(table);
  };
  for (const set of lists) {
    const btn = el('button', { type: 'button', text: set.name, 'aria-pressed': set.id === active });
    btn.addEventListener('click', () => {
      active = set.id;
      for (const b of $$('button', tabs)) b.setAttribute('aria-pressed', String(b === btn));
      paint();
    });
    tabs.append(btn);
  }
  wrap.append(tabs, body);
  root.append(wrap);
  paint();
}

export function renderRoster(root, players, { pid, turnId, game } = {}) {
  if (!root) return;
  root.innerHTML = '';
  for (const p of players) {
    const classes = ['chip'];
    if (turnId && p.id === turnId) classes.push('turn');
    if (p.alive === 0) classes.push('dead');
    root.append(
      el('div', { class: classes.join(' '), style: `--h:${p.hue ?? 190}` }, [
        el('i'),
        el('span', { text: p.name + (p.bot ? ' · CPU' : '') }),
        p.score != null ? el('b', { text: fmtNum(p.score), style: 'margin-left:6px;color:var(--ink)' }) : null,
        p.lives != null ? el('span', { class: 'muted', text: `♥${p.lives}`, style: 'margin-left:6px' }) : null,
        p.respawn ? el('span', { class: 'muted tiny', text: `${(p.respawn / 15).toFixed(1)}s` }) : null,
        p.id === pid ? el('span', { class: 'tiny', text: 'YOU', style: 'color:var(--yl)' }) : null,
      ])
    );
  }
}

// ---------------------------------------------------------------------------
// Overlays live in a layer of their own, never in the host directly. The host is
// the arena that holds the cabinet's canvas or DOM board, and clearing it to show
// a "waiting" card used to destroy the board - a canvas is not re-created by the
// renderer, and the memory board never came back after the rival's turn.
function overlayLayer(root) {
  for (const child of root.children) if (child.classList?.contains('overlay-layer')) return child;
  const layer = el('div', { class: 'overlay-layer' });
  root.append(layer);
  return layer;
}

export function overlay(root, opts = {}) {
  if (!root) return null;
  const layer = overlayLayer(root);
  layer.innerHTML = '';
  const box = el('div', { class: `overlay${opts.banner ? ' banner' : ''}` });
  box.append(el('h2', { class: `big ${opts.kind === 'lose' ? 'mg' : ''}`, text: opts.title || '' }));
  if (opts.sub) box.append(el('p', { text: opts.sub }));
  if (opts.rows?.length) {
    const cards = el('div', { class: 'cards' });
    for (const r of opts.rows) {
      cards.append(
        el('div', { class: 'panel', style: 'padding:10px 14px;min-width:132px' }, [
          el('div', { class: 'tiny muted', text: r.label }),
          el('div', { style: 'font-size:20px;color:var(--cy);text-shadow:var(--glow-cy)', text: String(r.value) }),
        ])
      );
    }
    box.append(cards);
  }
  const row = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px' });
  for (const a of opts.actions || []) {
    const btn = el('button', { class: `btn ${a.cls || ''}`, type: 'button', text: a.label });
    btn.addEventListener('click', () => {
      Sfx.play('click');
      a.fn?.();
    });
    row.append(btn);
  }
  if (row.children.length) box.append(row);
  if (opts.countdown != null) box.append(el('div', { class: 'tiny muted', text: opts.countdown, 'data-countdown': '' }));
  layer.append(box);
  box.countdown = (text) => {
    const node = box.querySelector('[data-countdown]');
    if (node) node.textContent = text;
    else box.append(el('div', { class: 'tiny muted', text, 'data-countdown': '' }));
  };
  return box;
}
export function clearOverlay(root) {
  if (!root) return;
  for (const o of [...root.querySelectorAll('.overlay')]) o.remove();
  const layer = overlayLayer(root);
  if (!layer.children.length) layer.remove(); // do not leave an empty click blocker behind
}

// ---------------------------------------------------------------------------
export function wireChat(logEl, formEl, session, { me = 'You', enabled = true } = {}) {
  if (!logEl || !formEl) return () => {};
  const seen = new Set();
  const push = (msg) => {
    const key = `${msg.at}-${msg.from}-${msg.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    const mine = msg.from === me;
    logEl.append(
      el('div', { class: msg.from === 'ARCADE' ? 'sys' : mine ? 'me' : '' }, [
        el('span', { class: 'who', text: `${msg.from}: ` }),
        el('span', { text: msg.text }),
      ])
    );
    while (logEl.children.length > 120) logEl.firstChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  };
  const off = session.on('chat', push);
  const offJoin = session.on('joined', (m) => {
    for (const msg of m.chat || []) push(msg);
  });
  if (!enabled) {
    const input = formEl.querySelector('input');
    if (input) {
      input.disabled = true;
      input.placeholder = 'Chat needs an online room';
    }
    return () => {
      off?.();
      offJoin?.();
    };
  }
  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = formEl.querySelector('input');
    const text = (input.value || '').trim();
    if (!text) return;
    session.send({ t: 'chat', text });
    input.value = '';
    Sfx.play('msg');
  });
  return () => {
    off?.();
    offJoin?.();
  };
}

// ---------------------------------------------------------------------------
export function connectionPill(node, session) {
  if (!node) return;
  const paint = ({ status, mode }) => {
    const label = { online: 'ONLINE', connecting: 'CONNECTING', offline: 'SERVER OFFLINE', local: 'SOLO MODE' }[status] || status;
    const cls = status === 'online' ? 'live' : status === 'offline' ? 'bad' : status === 'local' ? 'warn' : '';
    node.className = `pill ${cls}`;
    node.innerHTML = '';
    node.append(el('span', { class: 'dot' }), el('span', { text: mode === 'solo' && status === 'local' ? 'SOLO · LOCAL ENGINE' : label }));
    if (session?.stats?.online != null && status === 'online') {
      node.append(el('b', { text: String(session.stats.online), title: 'players online' }));
    }
  };
  paint({ status: session.status, mode: session.mode });
  session.on('status', paint);
}

export function wireName(input, session) {
  const saved = store.get('na.name', '');
  if (saved) input.value = saved;
  const apply = () => {
    const name = (input.value || '').trim().slice(0, 18) || `Guest${Math.floor(Math.random() * 900 + 100)}`;
    store.set('na.name', name);
    input.value = name;
    session?.send({ t: 'hello', name });
  };
  input.addEventListener('change', apply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      apply();
      input.blur();
    }
  });
  apply();
  return apply;
}

export function wireSoundToggle(btn) {
  const paint = () => {
    btn.textContent = Sfx.enabled ? '♪ sound on' : '♪ sound off';
    btn.setAttribute('aria-pressed', String(Sfx.enabled));
  };
  btn.addEventListener('click', () => {
    Sfx.set(!Sfx.enabled);
    paint();
  });
  paint();
}

export function fpsMeter(node, get) {
  if (!node) return () => {};
  let last = performance.now();
  let frames = 0;
  let value = 0;
  const loop = () => {
    frames += 1;
    const now = performance.now();
    if (now - last > 500) {
      value = Math.round((frames * 1000) / (now - last));
      node.textContent = `${value} fps`;
      frames = 0;
      last = now;
    }
    if (get() !== false) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
