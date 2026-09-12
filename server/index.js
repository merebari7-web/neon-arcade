// Neon Arcade entry point: static client + authoritative multiplayer rooms on one port.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { Hub, GAMES, GAME_LIST } from './hub.js';
import { Leaderboard } from './leaderboard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const publicDir = path.join(root, 'public');

export function createApp({ leaderboard, hub } = {}) {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.get('/health', (req, res) => {
    const stats = hub ? hub.publicStats() : { online: 0, rooms: 0 };
    res.json({ ok: true, uptime: Math.round(process.uptime()), ...stats });
  });

  app.get('/api/info', (req, res) => {
    res.json({
      name: 'Neon Arcade',
      games: GAME_LIST.map((g) => ({ ...g, players: g.maxPlayers })),
      stats: hub ? hub.publicStats() : null,
      leaderboard: leaderboard ? leaderboard.all() : null,
    });
  });

  app.get('/api/rooms', (req, res) => res.json({ rooms: hub ? hub.listRooms() : [] }));
  app.get('/api/leaderboard', (req, res) => res.json({ board: leaderboard ? leaderboard.all() : {} }));

  app.use(
    express.static(publicDir, {
      index: 'index.html',
      extensions: ['html'],
      setHeaders(res) {
        res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  app.get('/play', (req, res) => res.sendFile(path.join(publicDir, 'play.html')));
  // anything else is client-routed: real files already answered above
  app.use((req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return res.status(404).json({ error: 'not found' });
    res.status(200).sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}

export function startServer({ port, host, dataDir } = {}) {
  const dir = dataDir || process.env.DATA_DIR || path.join(root, 'data');
  const leaderboard = new Leaderboard({ dir });
  const hub = new Hub({ leaderboard });
  const app = createApp({ leaderboard, hub });
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  hub.attach(wss, server);

  return new Promise((resolve, reject) => {
    const wanted = Number(port ?? process.env.PORT ?? 3000);
    const bind = host || process.env.HOST || '0.0.0.0';
    server.once('error', reject);
    server.listen(wanted, bind, () => {
      const actual = server.address().port;
      console.log(`\n  NEON ARCADE  ·  http://localhost:${actual}`);
      console.log(`  ${Object.keys(GAMES).length} games · ws endpoint /ws · board file ${leaderboard.file}\n`);
      resolve({ app, server, wss, hub, leaderboard, port: actual });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer()
    .then(({ server, hub, leaderboard, wss }) => {
      let closing = false;
      const shutdown = (signal) => {
        if (closing) return;
        closing = true;
        console.log(`\n  ${signal} received - closing rooms and saving the board.`);
        hub.shutdown();
        leaderboard.flush();
        for (const client of wss.clients) {
          try {
            client.close(1001, 'server restarting');
          } catch {
            /* ignore */
          }
        }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
      };
      ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => shutdown(s)));
      process.on('uncaughtException', (err) => {
        console.error('[uncaught]', err);
        shutdown('uncaughtException');
      });
      process.on('unhandledRejection', (err) => console.error('[unhandled rejection]', err));
    })
    .catch((err) => {
      if (err && err.code === 'EADDRINUSE') console.error('Port is busy - set PORT to something else, e.g. PORT=4000 npm start');
      else console.error('Failed to start:', err);
      process.exit(1);
    });
}
