# Stickman Multiplayer

(Named "Ragdoll Archer .io" until 2026-10-10.)

2D multiplayer ragdoll archery game. Full design and plan: [ragdoll architecture.md](ragdoll%20architecture.md). Read it before starting a phase.

## How to work
- **Always go for the best solution, not the quickest patch.** If the asked-for approach has a flaw or a clearly better option exists, say so briefly and recommend it. Fix root causes, not symptoms.
- **Keep words simple.** Short sentences. When a technical term is needed, explain it in plain words the first time (e.g. "raycast: checking along a line for the first thing it touches").
- Keep `ragdoll architecture.md` up to date when a decision or phase status changes.

## Debugging is always on: read the logs, don't ask for screenshots
The user should never need to send a photo or video to explain a mechanics problem.
1. When the user reports something wrong in the game, **first read `logs/client-latest.jsonl`** (every browser since the dev server started; lines are tagged with `session` = one page load and `addr` = which device; `client-prev.jsonl` is the run before) **and `logs/server-latest.jsonl`** (online play: the server decides every hit; `src` is `room:<id>`; `joined_room` maps devices to player ids). Use Grep on event names (`"ev":"arrow_hit"`, `"lvl":"warn"`, `"lvl":"error"`).
2. Reproduce it headlessly where possible: add or adjust a scenario in `tools/sim.ts` (game mechanics) or `tools/netsim.ts` (anything network: real server + bots), run it, read `logs/sim-latest.jsonl` / `logs/netsim-latest.jsonl`.
3. If the logs can't explain the problem, **the logging is missing something**: add the events/numbers that would have explained it, then ask the user to reproduce once more. Only ask for a screenshot for purely visual issues (art, layout).

### Every new mechanic must ship with
- Log events for its key moments, with the numbers needed to explain what happened (rounded with `r3`/`rv`).
- Anomaly checks for how it can break (use `GameWorld.anomaly`, which limits repeats).
- A Vitest test in `shared/test/`, plus a `tools/sim.ts` scenario when it's about feel or tuning.
- Never log every frame. Per-tick data only goes in the `snapshot` event (every 1 s, only while something moves).

## Code rules
- **All game logic lives in `shared/`** (no Phaser, no `window`/DOM there). `client/` only draws and turns input into commands. The Phase 4 server will run the same `shared/` code.
- Units: meters, seconds, radians, **y points down**. Pixels = meters × `PX_PER_M`.
- Physics advances only in fixed `DT` (1/60 s) steps via `GameWorld.step()`.
- **Arenas are data** (`shared/src/arenas/`). Never hard-code an arena's size or positions: use `world.bounds` / `world.arena` (client: `welcome.arena`). A new arena is a data file plus one line in `ARENAS`; the validator test, the reach check (`arenaReach`: every place must lead to every other, using the jumps sim `jump_reach` measured), `arena_spawns` and `arena_fights` sims and the `arena` netsim check it automatically. Draft it with `tools/arena-map.ts` first.
- Tunable numbers go in `shared/src/constants.ts`, not inline.
- Bullets (still called `Arrow` in the code, from the bow days) are not physics bodies: they move with `stepArrow` and hit things by ray test, and vanish where they hit (`GameWorld.resolveHit` is the one place a bullet meets something). The aim preview must use the same code path, so preview = reality (the screen shows its first 0.5 s).
- **Never use `applyImpulse` / `applyTorqueImpulse` / `setLinvel` / `setAngvel` on bodies.** Ragdoll parts are multibody links and silently ignore them. Use `GameWorld.push()` / `twist()`.
- A loose object that's only there to look at (sent as a prop, e.g. the knocked-away gun) must not touch players (collision groups) and bullets must skip it: the client's preview can't see props, and one lying on a player pinned them (L5).
- Ragdoll poses: both legs must get the same target angles when standing (see `POSES` in `ragdoll.ts` for why).
- Rapier averages the friction of two touching colliders by default. When a friction value must really apply, set the combine rule (see `setSlipperyFeet`).
- Check every input where it enters the world (`setControls`, `fire`, `previewShot`): NaN, Infinity and out-of-range values are refused and logged. Network messages are checked first by `parseClientMessage`; the server never trusts a client (e.g. `GameWorld.fire` refuses a shot before the reload is done by the server's own tick, `fire_too_soon`). A shot is just an angle: the gun never wobbles (L7).
- **Anything that lasts lives in server state and reaches clients in snapshots (current state) or the welcome (things built up so far), never only in events.** Events are for moments (damage numbers, sparks, callouts). Otherwise a player who joins late sees a different game (L4 found bullet holes, wall holes and knocked-off hats that only came as events).
- Anything a client draws comes from snapshots/events; anything that decides the game happens on the server. Client-side "instant feel" is cosmetic only and must use the shared code (`traceArrow`, `launchPointFrom`, `raycastShapes`).
- Game rules (health, stamina, score, body damage ladders) live in `rules.ts` and are applied by `GameWorld`; the ragdoll stays pure physics. The screen reads game events from `GameWorld.takeEvents()`.
- Tune physics with numbers, not guesses: write a quick probe or sim scenario, compare settings, then pick (see the comments on `SOLVER_ITERATIONS` and `MOTOR`).

## Before saying something is done
Run all four and report the real result:
```
npm run typecheck
npm test
npm run sim
npm run netsim
```
For client changes also run the game (`.claude/launch.json` configs `server` + `client`; `server-short` instead of `server` gives 25 s matches for checking match changes) and check `logs/client-latest.jsonl` and `logs/server-latest.jsonl` for warnings and errors. The page talks to the game server only through its own address (`/ws`, `/rooms`, forwarded by Vite); the game server listens on 127.0.0.1 only. In the browser pane you can submit the join form with `document.getElementById('join-form').requestSubmit()` (or click `#new-room` / a room's Join button) and drive frames with `window.scene.game.step(performance.now(), 16.7)`. Note: when the browser pane is hidden, Chrome throttles it to ~1 fps, which shows up as `long_frame` / `frame_behind` / `low_fps`. That's the pane, not the game. You can step the world directly with `window.scene.world.step()`.
