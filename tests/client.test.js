import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Boots the real server and drives every page script through jsdom + a stub canvas.
// This is the test that proves the shipped client actually works, so it is part of
// `npm test` and CI. Skip with ARCADE_SKIP_SMOKE=1 if you have no devDependencies.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

test(
  'client smoke: lobby + four cabinets + online session boot for real',
  { timeout: 180000, skip: process.env.ARCADE_SKIP_SMOKE ? 'skipped by env' : false },
  async () => {
    const script = path.join(root, 'scripts', 'smoke-all.mjs');
    assert.ok(fs.existsSync(script), 'smoke runner is missing');
    if (!fs.existsSync(path.join(root, 'node_modules', 'jsdom'))) {
      console.log('jsdom not installed, run `npm install` (dev deps) to enable the client smoke test');
      return;
    }
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, [script], { cwd: root }, (err, stdout, stderr) =>
        err ? reject(new Error(`${err.message}\n${stdout}\n${stderr}`)) : resolve(`${stdout}\n${stderr}`)
      );
    });
    assert.match(out, /all 6 client scenarios passed/, `smoke output:\n${out}`);
    assert.doesNotMatch(out, /FAIL/, `smoke output:\n${out}`);
  }
);
