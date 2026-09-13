# NEON ARCADE

**Live now:** <https://merebari7-web.github.io/neon-arcade/> — the four solo/CPU cabinets,
served straight off GitHub Pages by the [`pages.yml`](.github/workflows/pages.yml) workflow
in this repo. (Online rooms need the Node server: see
[Hosting on GitHub](#hosting-on-github), which takes about two minutes.)

A four-cabinet **online multiplayer arcade** you can host yourself: a Node server that
runs authoritative game rooms over WebSockets, and a neon CRT front end that is
plain HTML/CSS/canvas — no build step, no framework, no bundler.

Play against people with a five-letter room code, or against the CPUs when nobody is
online. Every cabinet also runs **with no server at all** (the rules engine ships to
the browser too), which is why the same folder works as a GitHub Pages site.

```
Snake Battle    up to 8 snakes, one arena, kill credit matters
Breakout Duel   1v1, one shared wall, one ball, brick credit goes to the last hitter
Memory Match    1v1 (or 3-4 way) turn-based tile duel with a turn clock
2048 Versus     side-by-side boards, live view of your rival, first 2048 wins
```

---

## Try it

```bash
npm install
npm start            # http://localhost:3000
npm run dev          # same, with --watch
npm test             # 73 tests: rules engines, bots, WebSocket integration, client boot
npm run smoke        # boots every page script in jsdom against a live server
```

Open two browser tabs, press **Open room** in one, **join by code** in the other.
Or press **Quick play** twice and you will land in the same arena.

## Why it is built this way

```
public/shared/      rules engines (snake.js, breakout.js, memory.js, g2048.js, bots.js)
                    ↓ imported by BOTH sides, unchanged
server/             hub.js  - rooms, matchmaking, tick loop, bot pacing, wire protocol
                    index.js - express static + /health + /api/* + ws upgrade
                    leaderboard.js - one JSON file
public/js/          session.js (one client, two transports), play.js (cabinet host),
                    lobby.js, ui.js, canvas.js, games/*.js (renderers + input)
```

* **One set of rules, two places.** `SnakeArena.step()` is the same function whether the
  server ticks it 15× a second for eight players, or your laptop ticks it for a solo run
  against three bots. No "client says X, server says Y" drift, and no reimplementation
  bugs. `tests/` exercise the engines directly, so the logic is covered without a browser.
* **Server-authoritative where it matters.** Snake, Breakout and Memory are simulated on
  the server and streamed as compact snapshots (`{t:'state', s}`) with the tick's events
  attached, so a client cannot teleport a paddle or un-crash a snake.
* **2048 is report-based.** Your board is yours — the client simulates it for zero input
  lag and reports `{score, moves, max, grid}`; the server referees the race and rejects
  implausible reports (score decreasing, non-power-of-two tiles, multiple moves per
  message, absurd totals). That is casual-grade fairness, not a hard security boundary,
  and it is documented as such in `public/shared/g2048.js`.
* **CPU rivals are shared code too.** `public/shared/bots.js` drives the snakes, the
  Breakout paddle (ball projection with an aiming error, so it is beatable), the Memory
  opponent (it remembers tiles it has seen) and the 2048 ghost (heuristic search). The
  server uses the same file to fill empty seats in online rooms, so a solo room and an
  online room with a CPU feel identical.
* **It degrades instead of dying.** If the WebSocket is unreachable the lobby says so and
  every solo cabinet still works. On `*.github.io` the play page starts in solo mode
  automatically, so the Pages deployment is never a dead error screen.

## Hosting on GitHub

### 1. Push the repo

```bash
git init -b main
git add -A
git commit -m "Neon Arcade: 4-game online multiplayer arcade"
git remote add origin git@github.com:merebari7-web/neon-arcade.git
git push -u origin main

# or, if this is a fork of someone else's copy:
gh repo create neon-arcade --public --source=. --push
```

### 2. Static solo build on GitHub Pages — free, one workflow

`.github/workflows/pages.yml` publishes `public/` verbatim (there is no build step).

1. Repo → **Settings → Pages → Source: GitHub Actions**
2. Push to `main`; the Actions tab gives you `https://merebari7-web.github.io/neon-arcade/`

Everything playable there: all four cabinets in solo/CPU mode, high scores saved in the
browser. What Pages cannot do is hold a WebSocket open — that is the next step.

### 3. Multiplayer — any Node host that allows WebSockets

| Host | How |
| --- | --- |
| **Render** | push the repo, it reads [`render.yaml`](render.yaml) (free tier, `plan: free`, `/health` check) |
| **Railway** | [`railway.json`](railway.json), or the `railway up` CLI |
| **Fly.io** | `fly launch --from-dockerfile` (the included `Dockerfile`) |
| **Any VPS** | `docker build -t arcade . && docker run -p 8080:8080 -v $PWD/data:/app/data arcade` |

Then point people at the app URL — the client derives the WebSocket URL from
`location.host` (`wss://your-host/ws`), so there is nothing to configure. To run
**Pages for the lobby and a separate host for rooms**, set the override before
loading:

```html
<script>window.ARCADE_WS = 'wss://arcade-on-render.onrender.com/ws';</script>
```

Free-tier notes worth knowing: Render's free web service sleeps after ~15 idle minutes
(first visitor waits a few seconds), and its filesystem is ephemeral, so the leaderboard
starts empty after a restart unless you attach a disk or set `DATA_DIR` somewhere
persistent. `data/leaderboard.json` is the only state the server keeps.

## The wire protocol

Single JSON message envelope on `/ws`, `t` is the type.

| direction | message | meaning |
| --- | --- | --- |
| → | `hello {name}` | set your display name, subscribe to the lobby feed |
| → | `quick {game, vsCpu}` | join the emptiest open room, else create one |
| → | `create {game, private, vsCpu}` | open a room, get a 5-letter code |
| → | `join {code}` | sit down in a specific room |
| → | `input {…}` | game-specific: `{dir}` snake, `{x\|dx}` breakout, `{idx}` memory, `{state}` 2048 |
| → | `addCpu` / `removeCpu` / `restart` / `leave` / `chat {text}` / `score {game,score,mode}` | room + board controls |
| ← | `welcome {games, rooms, stats, leaderboard}` | everything the lobby needs, no round trip |
| ← | `joined {room, pid, side, chat}` | seat assignment |
| ← | `state {s, ev}` / `ev {ev}` | snapshot + the tick's events (breaks, kills, misses…) |
| ← | `roster` `rooms` `chat` `leader` `cpu` `roundOver` `restarted` `closed` `err` | lobby + room lifecycle |

Tick rates are per cabinet (snake 15 Hz, breakout 60 Hz physics / 30 Hz snapshots,
memory 20 Hz, 2048 event-driven at 8 Hz). There is a 120 msg/s per-socket cap; over it
the socket is closed with policy code `1008` (there is a test for it).

## Testing

```
tests/snake.test.js     movement, growth, self/tail legality, rival-kill credit, respawn,
                        win conditions, snapshot shape, seed determinism
tests/breakout.test.js  brick credit + combos + steals, tough-brick deflection, life loss,
                        serve handoff, win paths, no tunnelling at 1000 px/s, wire size
tests/memory.test.js    deck build, turn ownership, match/mismatch/timeout, 3-way rotation,
                        hidden information
tests/g2048.test.js     merge rules, no-cascade, spawn accounting, win + deadlock detect,
                        versus referee plausibility checks
tests/bots.test.js      CPUs are legal and beatable (they will not suicide, they can miss)
tests/hub.test.js       REAL server + REAL WebSockets: static files, room codes, two synced
                        clients, out-of-turn rejection, chat relay, round end + restart,
                        leaderboard persistence, flood disconnect
tests/client.test.js    boots public/js/play.js and lobby.js in jsdom with a stub canvas and
                        asserts each cabinet renders, animates and reacts to keys/clicks
tests/visual.test.js    real Chromium: arena geometry, painted pixels, tile layout, sideways
                        overflow on a phone viewport - the things jsdom has no layout for
```

```bash
npm test                  # 82 checks; the browser file skips itself if Chromium is absent
npm run test:visual       # browser checks only, VISUAL_STRICT=1 in CI so a skip cannot pass
npm run smoke             # the jsdom client harness against a live server, per scenario
```

`test:visual` needs `npx playwright install chromium`. It is skipped (not failed) when no
browser is available, and fails loudly under `VISUAL_STRICT=1` so CI can never satisfy
itself with a wall of skips. It exists because of a real bug: `overlay()` used to clear
the arena it was painting into, so the moment a rival took their turn the Memory board was
destroyed and never came back. Every jsdom check still passed - the DOM nodes were simply
gone - and only a browser could see that the arena had collapsed to the height of its
border.

## Adding a fifth cabinet

1. Write the rules in `public/shared/yourgame.js` (pure, deterministic, `snapshot()` +
   `step()`), plus a CPU in `bots.js` if you want auto-fill.
2. Add one entry to `GAMES` in `public/shared/defs.js` — `create`, `input`, `tick`,
   `results`, `leaderboard` — and a block in `GAME_META` for rules/controls text.
3. Write a renderer in `public/js/games/yourgame.js` exporting `mount({arena, session, meta})`.
   It receives a `session` that is the same object online or solo; render from
   `state` messages, send `input` messages.
4. Add a tile to `public/index.html`, one line to `gameFile` in `play.js`, one entry in
   `server/leaderboard.js` `GAMES`, then add tests. Room handling, matchmaking, chat and
   the leaderboard come free.

## Deliberate limits

* Room codes are 5 chars from a non-ambiguous alphabet; rooms expire ~60s after the last
  player leaves. No accounts, no friends lists, no persistence beyond the score board.
* Snapshots + events, not client-side prediction (except the Breakout ball's visual
  extrapolation). At these tick rates and payload sizes that is the right trade; if you
  want 64-player rooms, add delta compression and input acks.
* The leaderboard is a JSON file with sanity caps. Do not point it at anything you care
  about until you add real auth.

## License

MIT — see [LICENSE](LICENSE).
