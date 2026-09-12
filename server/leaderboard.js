// Tiny JSON-file leaderboard. Casual arcade board, not a database.
import fs from 'node:fs';
import path from 'node:path';

const GAMES = ['snake', 'breakout', 'memory', 'g2048'];

export class Leaderboard {
  constructor(opts = {}) {
    this.file = opts.file || path.join(opts.dir || path.join(process.cwd(), 'data'), 'leaderboard.json');
    this.max = opts.max || 25;
    this.show = opts.show || 10;
    this.dirty = false;
    this.timer = null;
    this.data = Object.fromEntries(GAMES.map((g) => [g, []]));
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const g of GAMES) if (Array.isArray(parsed[g])) this.data[g] = parsed[g].slice(0, this.max);
    } catch {
      /* first boot - nothing saved yet */
    }
  }

  record(game, entry) {
    if (!this.data[game] || !entry || !Number.isFinite(entry.score)) return null;
    const row = {
      name: String(entry.name || 'Guest').slice(0, 18),
      score: Math.max(0, Math.floor(entry.score)),
      mode: entry.mode === 'online' ? 'online' : 'solo',
      at: Date.now(),
    };
    if (row.score <= 0) return null;
    this.data[game].push(row);
    this.data[game].sort((a, b) => b.score - a.score || a.at - b.at);
    this.data[game] = this.data[game].slice(0, this.max);
    this.saveSoon();
    return row;
  }

  top(game) {
    return (this.data[game] || []).slice(0, this.show);
  }

  all() {
    return Object.fromEntries(GAMES.map((g) => [g, this.top(g)]));
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1500);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.ready = true;
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      return true;
    } catch (err) {
      // Read-only filesystems are normal on some free hosts; the board just won't persist.
      if (!this.warned) {
        this.warned = true;
        console.warn('[leaderboard] persist disabled:', err.code || err.message);
      }
      return false;
    }
  }
}
