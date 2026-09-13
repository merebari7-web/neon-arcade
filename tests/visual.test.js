// Real-browser checks: geometry, clipping and paint, which jsdom cannot see.
// Skipped (not failed) when playwright is not installed, so a bare `npm ci` in a
// dependency-free environment still gets a green run.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {
  chromium = null;
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Missing *browser* is as unrunnable as a missing package, and CI must not be able
// to satisfy itself with a wall of skips: VISUAL_STRICT=1 turns "cannot run" into a failure.
let blocked = chromium ? null : 'playwright not installed (npm i -D playwright && npx playwright install chromium)';
if (chromium) {
  // Ask the browser, not the file system: a headless-shell-only install has no
  // chromium executablePath() but launches perfectly well.
  try {
    const probe = await chromium.launch();
    await probe.close();
  } catch (err) {
    blocked = `no usable browser: ${String(err.message || err).split('\n')[0]}`;
  }
}

if (blocked && process.env.VISUAL_STRICT) {
  test('browser layout is runnable (VISUAL_STRICT=1)', () => assert.fail(blocked));
}

describe('browser layout', { skip: blocked || false }, () => {
  let server;
  let browser;
  let base;
  let dataDir;

  before(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'neon-visual-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.ok(await waitForHealth(base), 'server did not answer /health');
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    server?.kill('SIGTERM');
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function open(page, query, doc = 'play.html') {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));
    await page.goto(`${base}/${doc}${query}`, { waitUntil: 'load' });
    return errors;
  }

  for (const game of ['snake', 'breakout', 'memory', 'g2048']) {
    test(`${game}: the arena is sized and painted, not collapsed`, async () => {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      try {
        const errors = await open(page, `?game=${game}&mode=solo`);
        await page.waitForSelector('#arena canvas, #arena .mcard, #arena .grid4', { timeout: 15000 });
        await page.waitForTimeout(1200);

        const geo = await page.evaluate(
          ([sel]) => {
            const arena = document.querySelector('#arena');
            const ar = arena.getBoundingClientRect();
            const out = {
              arena: { w: Math.round(ar.width), h: Math.round(ar.height) },
              clipped: Math.round(ar.height) < 60 && arena.scrollHeight > ar.height + 40,
              scrollH: arena.scrollHeight,
              over: (sel ? [...arena.querySelectorAll(sel)] : []).map((n) => {
                const r = n.getBoundingClientRect();
                return {
                  w: Math.round(r.width),
                  h: Math.round(r.height),
                  inside: r.top >= ar.top - 1 && r.bottom <= ar.bottom + 1 && r.height > 8,
                };
              }),
            };
            const cv = arena.querySelector('canvas');
            if (cv) {
              const ctx = cv.getContext('2d');
              const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
              let lit = 0;
              for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
              out.painted = lit;
              out.canvasBox = { w: Math.round(cv.getBoundingClientRect().width), h: Math.round(cv.getBoundingClientRect().height) };
            }
            return out;
          },
          [game === 'memory' ? '.mcard' : game === 'g2048' ? '.tile4' : '']
        );

        assert.ok(geo.arena.h >= 260, `arena collapsed to ${geo.arena.h}px (scrollHeight ${geo.scrollH})`);
        assert.ok(!geo.clipped, `content overflows a clipped arena: ${geo.arena.h}px tall, ${geo.scrollH}px of content`);
        if (game === 'memory') {
          assert.equal(geo.over.length, 16, `expected 16 tiles, saw ${geo.over.length}`);
          assert.ok(geo.over.every((t) => t.inside && t.w >= 24), `tiles not laid out inside the arena: ${JSON.stringify(geo.over.slice(0, 3))}`);
        } else if (game === 'g2048') {
          assert.ok(geo.over.length >= 4, `expected tiles on the board, saw ${geo.over.length}`);
          assert.ok(geo.over.every((t) => t.inside), 'some tiles render outside the arena box');
        } else {
          assert.ok(geo.canvasBox.h >= 260, `canvas only ${geo.canvasBox.h}px tall`);
          assert.ok(geo.painted > 40, `canvas looks blank (${geo.painted} lit samples)`);
        }
        assert.deepEqual(errors, [], `page reported problems: ${errors.slice(0, 4).join(' | ')}`);
      } finally {
        await page.close();
      }
    });
  }

  test('memory: the rival turn keeps the board visible (regression: overlays wiped #arena)', async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    try {
      await open(page, '?game=memory&mode=solo');
      await page.waitForSelector('.mcard', { timeout: 15000 });

      const before = await page.evaluate(() => document.querySelectorAll('.mcard').length);
      assert.equal(before, 16, 'board missing before the first flip');

      // two mismatched flips hand the turn to the CPU; any pair of different faces does
      await page.click('.mcard[data-i="0"]');
      for (let i = 1; i < 16; i++) {
        const differs = await page.evaluate(
          (idx) => document.querySelector('.mcard[data-i="0"]')?.querySelector('.sym')?.textContent !== document.querySelector(`.mcard[data-i="${idx}"]`)?.querySelector('.sym')?.textContent,
          i
        );
        if (differs) {
          await page.click(`.mcard[data-i="${i}"]`);
          break;
        }
      }

      // wait for the rival to have the turn (banner appears) and assert the board survives
      const sawRival = await page
        .waitForSelector('.overlay.wait', { timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      const after = await page.evaluate(() => {
        const arena = document.querySelector('#arena');
        const ar = arena.getBoundingClientRect();
        const cards = [...arena.querySelectorAll('.mcard')];
        return {
          cards: cards.length,
          arenaH: Math.round(ar.height),
          visible: cards.filter((c) => {
            const r = c.getBoundingClientRect();
            return r.height > 20 && r.top >= ar.top - 1 && r.bottom <= ar.bottom + 1;
          }).length,
          banner: !!arena.querySelector('.overlay.wait'),
          bannerIsCurtain: (() => {
            const b = arena.querySelector('.overlay.wait');
            if (!b) return false;
            const r = b.getBoundingClientRect();
            return r.height > ar.height * 0.6;
          })(),
        };
      });
      assert.ok(sawRival || after.banner, 'never reached the rival turn, so the regression path went untested');
      assert.equal(after.cards, 16, `board vanished during the rival turn (${after.cards} cards left)`);
      assert.equal(after.visible, 16, `only ${after.visible}/16 tiles are actually laid out inside the arena`);
      assert.ok(after.arenaH >= 260, `arena collapsed to ${after.arenaH}px`);
      assert.ok(!after.bannerIsCurtain, 'the turn banner covers most of the arena instead of sitting as a strip');
    } finally {
      await page.close();
    }
  });

  test('lobby: hero canvas runs and the cabinet cards lay out', async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    try {
      const errors = await open(page, '', 'index.html');
      await page.waitForSelector('#attract canvas', { timeout: 15000 });
      const a = await page.evaluate(() => document.querySelector('#attract canvas').toDataURL());
      await page.waitForTimeout(700);
      const b64 = await page.evaluate(() => document.querySelector('#attract canvas').toDataURL());
      assert.notEqual(a, b64, 'attract-mode canvas is not animating');
      const tiles = await page.evaluate(() => {
        const list = [...document.querySelectorAll('.tile')];
        const ar = document.querySelector('#attract').getBoundingClientRect();
        return {
          n: list.length,
          tall: list.every((t) => t.getBoundingClientRect().height > 120),
          attractH: Math.round(ar.height),
        };
      });
      assert.equal(tiles.n, 4, 'the four cabinet cards did not render');
      assert.ok(tiles.tall, 'a cabinet card has no height');
      assert.ok(tiles.attractH > 150, `hero canvas collapsed to ${tiles.attractH}px`);
      assert.deepEqual(errors, [], `page reported problems: ${errors.slice(0, 4).join(' | ')}`);
    } finally {
      await page.close();
    }
  });

  test('mobile: no horizontal overflow and the touch pad appears', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      await open(page, '?game=snake&mode=solo');
      await page.waitForSelector('#arena canvas', { timeout: 15000 });
      await page.waitForTimeout(900);
      const m = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        pad: getComputedStyle(document.querySelector('#touchPad')).display,
        canvasH: Math.round(document.querySelector('#arena canvas').getBoundingClientRect().height),
      }));
      assert.ok(m.overflow <= 1, `layout overflows sideways by ${m.overflow}px`);
      assert.notEqual(m.pad, 'none', 'touch controls hidden on a phone-sized viewport');
      assert.ok(m.canvasH > 150, `arena canvas only ${m.canvasH}px tall on mobile`);
    } finally {
      await page.close();
    }
  });
});
