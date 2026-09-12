// Boots the real arcade server, then runs every client scenario in a child process
// (fresh module registry per page, like a browser would).  npm run smoke
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startServer } from '../server/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const SCENARIOS = process.argv[2] ? [process.argv[2]] : ['lobby', 'snake', 'breakout', 'memory', 'g2048', 'online'];

const srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(root, '.smoke-data') });
const wsUrl = `ws://127.0.0.1:${srv.port}/ws`;
let failures = 0;

for (const scenario of SCENARIOS) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, 'smoke-client.mjs'), scenario, '--server', wsUrl], { cwd: root, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      console.error(`TIMEOUT [${scenario}]`);
    }, 60000);
    child.on('exit', (exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
  if (code !== 0) failures += 1;
  console.log(`${code === 0 ? '  ok  ' : ' FAIL '} ${scenario}`);
}

srv.hub.shutdown();
srv.leaderboard.flush();
await new Promise((r) => srv.server.close(r));
try {
  fs.rmSync(path.join(root, '.smoke-data'), { recursive: true, force: true });
} catch {
  /* ignore */
}
console.log(failures ? `\n${failures} client scenario(s) failed` : `\nall ${SCENARIOS.length} client scenarios passed`);
process.exit(failures ? 1 : 0);
