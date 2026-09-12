// Test helpers: promise-based WebSocket client that waits for specific message types.
import { WebSocket } from 'ws';

export function connect(url, { name = 'Tester' } = {}) {
  const sock = new WebSocket(url);
  const queue = [];
  const waiters = [];
  const errors = [];
  let closed = false;

  sock.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      errors.push(new Error('server sent non-JSON'));
      return;
    }
    queue.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.type == null || w.type === msg.t) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  sock.on('error', (err) => {
    errors.push(err);
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  });
  sock.on('close', () => {
    closed = true;
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error('socket closed while waiting'));
    }
  });

  const ready = new Promise((resolve, reject) => {
    sock.on('open', resolve);
    sock.on('error', reject);
  });

  return {
    sock,
    get url() {
      return url;
    },
    ready,
    send(obj) {
      sock.send(JSON.stringify(obj));
    },
    /** Wait for the next message of `type` (or the next message at all when omitted). */
    wait(type, ms = 4000) {
      if (!type) return this.wait(null, ms);
      const found = queue.find((m) => m.t === type);
      if (found) {
        queue.splice(queue.indexOf(found), 1);
        return Promise.resolve(found);
      }
      if (closed) return Promise.reject(new Error('socket closed'));
      return new Promise((resolve, reject) => {
        const w = { type, resolve, timer: null };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timed out after ${ms}ms waiting for "${type}" (saw: ${queue.map((m) => m.t).join(',') || 'nothing'})`));
        }, ms);
        waiters.push(w);
      });
    },
    /** Collect messages until `pred` is satisfied or the deadline passes. */
    until(pred, ms = 4000) {
      const start = Date.now();
      return new Promise((resolve, reject) => {
        const poll = () => {
          for (let i = 0; i < queue.length; i++) {
            const msg = queue[i];
            const out = pred(msg);
            if (out) {
              queue.splice(i, 1);
              return resolve(out === true ? msg : out);
            }
          }
          if (Date.now() - start > ms) return reject(new Error(`predicate never matched within ${ms}ms`));
          setTimeout(poll, 20);
        };
        poll();
      });
    },
    drain() {
      return queue.splice(0);
    },
    errors,
    close() {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Handshake + hello so the server knows our name. */
export async function hello(url, name, extra = {}) {
  const client = connect(url, { name });
  await client.ready;
  client.send({ t: 'hello', name, ...extra });
  await client.wait('welcome');
  await client.wait('you');
  return client;
}

export async function waitFor(fn, ms = 3000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}
