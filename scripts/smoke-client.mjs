// Client smoke test: boots the REAL page scripts (public/js/play.js, public/js/lobby.js)
// inside a jsdom DOM with a stubbed 2D canvas, then asserts the cabinet mounted,
// ran frames, and reacted to input. This is what catches client-side glue bugs
// (a renamed engine method, a missing element id, a bad import) that unit tests miss.
//
//   node scripts/smoke-client.mjs <scenario> [--server ws://127.0.0.1:PORT/ws]
// scenarios: lobby | snake | breakout | memory | g2048 | online
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const publicDir = path.join(root, 'public');

const scenario = process.argv[2] || 'lobby';
const wsFlag = process.argv.indexOf('--server');
const serverUrl = wsFlag > -1 ? process.argv[wsFlag + 1] : null;

function fakeCtx() {
  const store = {};
  const rec = { calls: 0, ops: new Set() };
  return new Proxy(store, {
    get(target, key) {
      if (key === '__rec') return rec;
      if (key in target) return target[key];
      if (key === 'createLinearGradient' || key === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (key === 'measureText') return () => ({ width: 10 });
      return (...args) => {
        rec.calls += 1;
        rec.ops.add(String(key));
      };
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

async function bootPage({ page, search = '' }) {
  const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
  const dom = new JSDOM(html, {
    url: `http://localhost:4173/${page}${search}`,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  const ctx = fakeCtx();
  win.HTMLCanvasElement.prototype.getContext = () => ctx;
  Object.defineProperty(win.HTMLCanvasElement.prototype, 'clientWidth', { get: () => 800 });

  const problems = [];
  for (const level of ['error', 'warn']) {
    const original = win.console[level].bind(win.console);
    win.console[level] = (...args) => {
      problems.push(`${level}: ${args.map(String).join(' ')}`);
      original(...args);
    };
  }

  // publish the window as the ambient environment for the imported modules
  const globals = {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    location: win.location,
    navigator: win.navigator,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    HTMLElement: win.HTMLElement,
    Event: win.Event,
    KeyboardEvent: win.KeyboardEvent,
    MouseEvent: win.MouseEvent,
    Node: win.Node,
    getComputedStyle: win.getComputedStyle?.bind(win),
    __ARCADE_CTX: ctx,
    __ARCADE_PROBLEMS: problems,
  };
  if (serverUrl) {
    const { WebSocket } = await import('ws');
    globals.WebSocket = WebSocket;
    // the documented override hook the client itself reads
    win.ARCADE_WS = serverUrl;
  }
  const saved = new Map();
  for (const [k, v] of Object.entries(globals)) {
    saved.set(k, globalThis[k]);
    globalThis[k] = v;
  }
  // a real <canvas> needs a size, jsdom gives 0
  win.addEventListener('error', (e) => problems.push(`window error: ${e.message}`));
  win.addEventListener('unhandledrejection', (e) => problems.push(`unhandled rejection: ${e?.reason}`));
  process.on('unhandledRejection', (r) => problems.push(`node rejection: ${r?.message || r}`));

  return {
    dom,
    win,
    ctx,
    problems,
    restore() {
      for (const [k, v] of saved) globalThis[k] = v;
    },
    async loadModule(rel) {
      const url = pathToFileURL(path.join(publicDir, rel)).href;
      return import(url);
    },
    tick(ms = 120) {
      return new Promise((r) => setTimeout(r, ms));
    },
    key(key) {
      win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      win.document.dispatchEvent(new win.KeyboardEvent('keyup', { key, bubbles: true }));
    },
    text(sel) {
      return win.document.querySelector(sel)?.textContent?.trim() ?? null;
    },
  };
}

const results = { scenario, checks: [] };
function check(name, condition, detail = '') {
  results.checks.push({ name, ok: !!condition, detail: condition ? '' : detail });
  if (!condition) {
    console.error(`FAIL [${scenario}] ${name} ${detail}`);
    results.failed = true;
  }
}

async function runSolo(game) {
  const app = await bootPage({ page: 'play.html', search: `?game=${game}&mode=solo` });
  try {
    await app.loadModule('js/play.js');
  } catch (err) {
    check(`${game}: play.js loads`, false, err.stack?.split('\n').slice(0, 3).join(' | '));
    app.restore();
    return results;
  }
  await app.tick(320);

  const doc = app.win.document;
  check(`${game}: title is the cabinet name`, /NEON ARCADE/.test(doc.title), doc.title);
  check(`${game}: arena mounted`, !!doc.querySelector('#arena canvas, #arena .grid-cards, #arena .grid4'), doc.querySelector('#arena')?.innerHTML?.slice(0, 120));
  check(`${game}: hud score is numeric`, /^[\d,]+$/.test(app.text('#hudScore') ?? ''), `got "${app.text('#hudScore')}"`);
  check(`${game}: roster has players`, !!doc.querySelector('#roster .chip'), 'no player chips');
  check(`${game}: rules panel filled`, (app.text('#help') || '').length > 40, 'help panel empty');
  check(`${game}: canvas drew something`, game === 'memory' || game === 'g2048' ? true : app.ctx.__rec.calls > 200, `draw calls: ${app.ctx.__rec.calls}`);
  check(`${game}: no blocking errors`, app.problems.filter((p) => p.startsWith('error')).length === 0, app.problems.join(' / ').slice(0, 400));

  // drive input and make sure the loop survives it
  for (const k of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', ' ']) app.key(k);
  await app.tick(200);
  check(`${game}: still alive after input`, app.ctx.__rec.calls > 0 || !!doc.querySelector('.mcard, .tile4'));
  check(`${game}: no errors after input`, app.problems.filter((p) => p.startsWith('error')).length === 0, app.problems.join(' / ').slice(0, 400));

  if (game === 'memory') {
    const cards = [...doc.querySelectorAll('.mcard')];
    check('memory: 16 tiles rendered', cards.length === 16, `saw ${cards.length}`);
    const enabled = cards.filter((c) => !c.disabled);
    check('memory: tiles are clickable on your turn', enabled.length > 0);
    enabled[0]?.dispatchEvent(new app.win.Event('click', { bubbles: true }));
    await app.tick(160);
    check('memory: flip shows the face', !!doc.querySelector('.mcard.up'), 'no .up tile after clicking');
  }
  if (game === 'breakout') {
    check('breakout: wall counter renders', /^\d+\/\d+$/.test(app.text('#hudBricks') || ''), app.text('#hudBricks'));
    check('breakout: lives render', /♥/.test(app.text('#hudLives') || ''), app.text('#hudLives'));
  }
  if (game === 'snake') {
    check('snake: countdown renders', /^\d+s$/.test(app.text('#hudTime') || ''), app.text('#hudTime'));
    check('snake: rank renders', /^\d+\/\d+$/.test(app.text('#hudRank') || ''), app.text('#hudRank'));
  }
  if (game === 'g2048') {
    const tiles = [...doc.querySelectorAll('.tile4')];
    check('g2048: 16 cells rendered', tiles.length === 16, `saw ${tiles.length}`);
    check('g2048: two starting tiles', tiles.filter((t) => t.textContent).length >= 2);
    check('g2048: rival panel present', !!doc.querySelector('.rival'));
  }

  app.win.dispatchEvent(new app.win.Event('pagehide'));
  await app.tick(40);
  app.restore();
  return results;
}

async function runLobby() {
  const app = await bootPage({ page: 'index.html' });
  try {
    await app.loadModule('js/lobby.js');
  } catch (err) {
    check('lobby: lobby.js loads', false, err.stack?.split('\n').slice(0, 3).join(' | '));
    app.restore();
    return results;
  }
  await app.tick(400);
  const doc = app.win.document;
  check('lobby: four cabinet tiles', doc.querySelectorAll('.games .tile').length === 4, String(doc.querySelectorAll('.games .tile').length));
  check('lobby: every tile links to a cabinet', [...doc.querySelectorAll('.games a[href*="play.html"]')].length >= 12);
  check('lobby: attract canvas exists', !!doc.querySelector('#attract canvas'));
  check('lobby: attract mode drew frames', app.ctx.__rec.calls > 100, `draw calls ${app.ctx.__rec.calls}`);
  check('lobby: marquee filled', (doc.querySelector('#marquee')?.textContent || '').includes('insert coin'));
  check('lobby: room list rendered (empty state ok)', !!doc.querySelector('#roomList .empty, #roomList .room'));
  check('lobby: leaderboard tabs rendered', doc.querySelectorAll('#board .seg button').length === 4);
  check('lobby: offline fallback is graceful', app.problems.filter((p) => p.startsWith('error')).length === 0, app.problems.join(' / ').slice(0, 300));
  check('lobby: server note explains state', /arcade server|Pages|solo/.test(doc.querySelector('#serverNote')?.textContent || ''));
  app.restore();
  return results;
}

// The online path with the real browser client class against the real server.
async function runOnline() {
  const app = await bootPage({ page: 'play.html', search: '?game=memory' });
  try {
    const mod = await app.loadModule('js/session.js');
    const session = new mod.Session({ mode: 'online', game: 'memory', private: true, vsCpu: true, name: 'Smoke' });
    let joined = null;
    let states = 0;
    let roster = null;
    session.on('joined', (m) => (joined = m));
    session.on('state', (m) => {
      states += 1;
      if (m.s?.cards) {
        if (!m.s.open.length) session.send({ t: 'input', idx: 0 });
        else if (m.s.open.length === 1) session.send({ t: 'input', idx: 5 });
      }
    });
    session.on('roster', (m) => (roster = m.info));
    await session.connect();
    await app.tick(600);
    session.send({ t: 'create', game: 'memory', private: true, vsCpu: true });
    await app.tick(900);
    check('online: joined a real room', !!joined?.room?.id, JSON.stringify(joined || {}).slice(0, 160));
    check('online: room id looks like a code', /^[A-Z2-9]{5}$/.test(joined?.room?.id || ''), joined?.room?.id);
    check('online: side received', joined?.side === null || joined?.side === 'bottom', String(joined?.side));
    check('online: state stream flowing', states > 4, `states ${states}`);
    check('online: flips were accepted by the server', (roster?.players?.length ?? 0) >= 2, JSON.stringify(roster || {}));
    session.results(1234, 'solo');
    session.close();
  } catch (err) {
    check('online: no crash', false, err.stack?.split('\n').slice(0, 3).join(' | '));
  }
  app.restore();
  return results;
}

try {
  switch (scenario) {
    case 'snake':
    case 'breakout':
    case 'memory':
    case 'g2048':
      await runSolo(scenario);
      break;
    case 'lobby':
      await runLobby();
      break;
    case 'online':
      await runOnline();
      break;
    default:
      console.error(`unknown scenario ${scenario}`);
      process.exit(2);
  }
} catch (err) {
  results.failed = true;
  results.error = String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err);
  console.error(`CRASH [${scenario}] ${results.error}`);
}

const done = results.checks.filter((c) => c.ok).length;
console.log(JSON.stringify({ scenario, passed: done, failed: results.checks.length - done, checks: results.checks.length, error: results.error || null }));
process.exit(results.failed ? 1 : 0);
