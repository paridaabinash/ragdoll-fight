# Slapstick Update: Final Spec

The agreed plan for making the game funnier and more replayable. It replaces the first draft of this file.
Decisions were made together on 2026-10-06/07. Numbers marked *(start)* are starting values to tune with sim runs.

> **Look & Feel + Body Damage update (decided 2026-10-08): read section 11 first.** The bow is replaced by a **gun** (point
> and click, fixed bullet speed with drop, pump/bolt reload); the look becomes **flat bright stick figures on dark, moody
> arenas**; the tone is **stylized gritty**: bullet holes, limbs shot down to stumps, critical hits that leave you with a
> melee weapon, bodies breaking apart, but **no blood or realistic gore**. Movement gets snappier and callouts smaller.
> Sections 0–9 and 11–13 describe the game as it should be; lines marked **[L]** changed in this update. Section 10 is
> history (what S1–S7 built with the bow). The code and `ragdoll architecture.md` still describe the bow until the
> matching L phase is built; where they disagree with this file, this file is the plan.
>
> **PAUSED 2026-10-10 (resume here):** L7 steps 1-8 are all built and pass all four checks (typecheck, 248 tests, sim 0 problems, netsim 0 problems): speed dial (0.85 for testing; final pick still open), no gun wobble / hand loss, no replays, no cursor + character-relative aim (**locked**), step 2 part 1 (no background silhouettes, quiet wind, players panel + "YOU"), 3 (headshot 50, 2 s shield, bots 24%), 4 (rarer, clearer disarms), 5 (hits knock the body), 6 (melee: bat upswing / mace sweep, hit along the drawn weapon), 7 (LEG OFF! banner, flying shin, stump cap, awards), 8 (springy legs). **Next:** the user looks at the arena designs (`arena-maps.html`, regenerate with `npx tsx tools/arena-map.ts`) and the background themes (`bg-themes.html`, 6 dark themes with more detail) and decides; step 2's colours (neon characters, glowing bullets, the gun's look) wait for the user's colour references. Separate task (its own worktree): bots flip-flopping over pits.
>
> **Feel pass L7 (decided 2026-10-08, after playing L0-L6): section 11, "L7".** Clean, easy-to-read visuals; hits you
> can feel; fewer one-shot deaths; rare, clearly shown disarms; a redesigned melee swing (no pointer, timed clicks).

---

## 0. Decisions (final)

| Topic | Decision |
|---|---|
| Tone **[L]** | **Stylized gritty.** Bullet holes, legs shot down to stumps, glove dents, bodies breaking apart, all drawn in the flat stick-figure style: **no blood, no realistic gore**, only cartoonish, funny damage. (Was: cartoony toy theme with colour splashes.) |
| Hit effects **[L]** | **Bullets don't stick**: a bullet vanishes on impact. On a wall: a small bullet hole + dust puff. On a player: a white impact spark + a few small chips in the part's own colour, and a **bullet hole** in that part that stays until the player respawns. Short effects (head sway, arm wobble) still run for a few seconds. (Was: arrows stayed stuck, wobbled, then dropped out.) |
| Body damage **[L]** | Hits add up over one life, per body area, as a **damage ladder**: legs go trip → dragging limp → one leg shot to a thigh stump → both legs stumps. **[L7]** No hand loss (it wasn't funny, and its wobbling gun was annoying). A boxing glove leaves the part dented. **A health apple (or respawn) puts you back together.** Details: section 11, L4. |
| Critical hits + melee **[L]** | Rare critical hits knock your gun away; you fight on with a melee weapon (bat, gada/mace) **until you die** (no getting the gun back). Melee hits break limbs; after 2–3 the body breaks into pieces. Details: section 11, L5. **[L7]** Crits are rarer (8%, only a real airborne moment) and shown as a clear beat (the gun spins away, a banner, a short empty-handed moment, then the weapon is drawn). Melee has **no pointer**: one click = one swing toward where you face, timed by you; two swing motions (section 11, L7). |
| Hits **[L7]** | **Hits are felt:** every bullet knocks the body back a little (a runner is set back, a head hit snaps the head back, a leg hit sweeps the legs back so the body pitches forward, a hit in the air cuts the jump short). Headshots ×2.5 (were ×5: a one-shot kill). Spawn protection 2 s, shown as a shield bubble. |
| Clarity **[L7]** | Everything easy to tell apart: clean backgrounds that stay behind the action, a clearly readable gun direction, one simple cursor, a camera that keeps you steady on screen. Chaotic, never confusing. |
| Big heads / boots | **[L]** Head **drawn the same size as its hitbox** (what you see is what you can hit); heavy boots stay as *physics only* (not drawn). The "Big Head Mode" chaos round still makes heads huge for 20 s. (Was option C: drawn head ×1.6 + drawn boots.) |
| Weapon **[L]** | A **gun** instead of a bow (a real-looking gun in the flat style, not a toy). It always points at the mouse pointer; how far away the pointer is doesn't matter. Click to fire (hold to keep firing). Every bullet flies at the same speed and drops with gravity. A **pump/bolt reload** after each shot (start 0.7 s) and a **stamina cost per shot** stop spamming. |
| Look **[L]** | Vibe of *Stick Fight* + *Shadow Fight 2*, not a copy: flat bright stick figures (no outline, no face), on dark, moody arenas with layered silhouette backgrounds. |
| Callouts **[L]** | Two sizes: small tags just above the victim's head, and big moments in a banner at the top of the screen. |
| Movement **[L]** | Snappier: faster run, quick stops, more air control, coyote time, jump buffering, tap-or-hold jump height. Dust puffs on jump, land, run and turn. |
| Match format | **Short matches** (3 min or first to 15 points), results screen, next arena. Replaces endless play. |
| Next arena | **Fixed rotation.** |
| Filler bots | **Yes**, in quiet rooms. |
| Arena | Closed walls, bigger than the screen, camera follows you, 3 height tiers, pits in the floor. Arena width depends on player count. |
| New concepts | All accepted: instant replay, chaos modifiers, bounty crown, wall pins, hazards, taunt, cosmetic hats. |
| Order **[L]** | Decide → spike (test limb loss in the sim) → look + movement → gun → body damage → crits + melee → re-check → arenas (section 11). |

## 1. Rules for every slapstick feature

1. **Short jokes.** Every *effect* on a victim (sway, wobble, slip, pin, balloon...) ends within about 2–6 s. **[L] The one deliberate exception is body damage** (holes, stumps, dents, being stuck with melee): it lasts the whole life, because the joke is fighting on anyway ("it's just a flesh wound"). It's always undone by a **health apple** (except holes and melee) or by respawning.
2. **The victim can always fight back.** They can still shoot while dizzy or on stumps, and they can mash jump to get up faster from trips and pins. Every handicap makes you worse in a specific, visible way, never helpless.
3. **The server decides everything.** Effects, slips, pins, callouts and modifiers are decided in `shared/` by the server's `GameWorld`, and every screen shows the same joke. Clients only draw.
4. **The preview arc never lies.** Anything that changes bullet flight (wind, gravity modifiers; **[L7]** the gun itself never wobbles) is shown in the preview, using the same code as the real bullet. **[L]** The preview shows only the first part of the path (start 0.5 s of flight), but that part is exact.
5. **Every mechanic ships with log events, anomaly checks, a Vitest test, and a sim scenario** when it's about feel (see `CLAUDE.md`).

---

## 2. Build with this in mind (architecture changes)

These affect almost everything, so they come first and every later feature must fit them:

- **Arenas are data, not code.** Each arena is a data file in `shared/` with its size, platforms, cover, pits, hazards, spawn points, pickup spots and apple spots. The fixed `ARENA` constant (32 × 18 m) goes away. Everything that uses it (bullet out-of-bounds check, client canvas size, level builder) reads the current arena instead.
- **Arena width follows player count.** It's picked at match start and never changes during a match: about 40 m for 2–4 players, 64 m for 5–8 *(start)*. The side walls move in; the arena data marks which pieces belong to the outer zones.
- **Camera follows you.** The arena is bigger than the screen; you see about 36 m of width *(start)* (section 7). The camera stays inside the arena walls.
- **Match loop on the server.** States: `playing` → `results` → next arena. The world is rebuilt from the next arena file between matches.
- **Status effects are one shared system.** One list per player of effects with a type, a body part, a start tick and an end tick (hit effects, pins, balloon, oil slip, feather laugh...). The ragdoll stays pure physics; `GameWorld` turns effects into motor and balance changes each tick. Effects are sent in snapshots as compact flags, so clients can draw them.
- **Callouts are decided on the server** and sent as part of hit/death events (`callout` field), so every client shows the same banner.
- **Bots run on the server** as normal players whose inputs come from a bot brain instead of a socket. They reuse the netsim bot logic. They are named clearly (e.g. `Wobbles (bot)`).

---

## 3. Hit consequences (body-part effects)

**[L] Bullets don't stick.** A bullet vanishes when it hits. The hit leaves a **bullet hole** in that part (it stays until respawn) and starts the effects below.

Head and arm hits give that part a short effect for **5 s** *(start)*. A second hit on the same part restarts the timer; it doesn't stack stronger. Effects end on death. **[L]** Leg hits and upper-body hits also climb the lasting **damage ladders** (section 11, L4).

- **Head: The Pendulum.** The neck motor gets weaker and the head heavier while the effect lasts, so the head sways by itself when walking. A sudden stop tips the body forward and triggers a **stumble**.
- **Arm: The Noodle Flail.** The back arm swings in wide circles while walking. **[L7]** The gun's aim is never affected: no swinging gun (it was annoying). (Was [L]: the aim swung up and down by itself for 5 s, with a network window for the swing tick.)
- **Legs: the leg damage ladder** **[L]** (replaces the old 5 s high-step limp, "The Charlie Brown"): 1st leg hit = a trip; 2nd = a **dragging limp** (walks on the good leg, the hurt one hangs and is pulled along, body slightly crouched); 3rd = that leg is shot down to a **thigh stump** (hops on the good leg); 4th–5th = **both legs stumps** (tiny steps, tiny jumps). Full rules in section 11, L4. **[L]** Jumps stay normal while limping (decided 2026-10-08: no misfires, they made it frustrating; the dragging leg is the joke).
- **Stumble (shared reaction).** When the body tips forward past a limit while on the ground, the legs do 2–4 fast short steps to catch it. Used by head hits, hard stops, skids, oil and landings.

### Wall pins
If a bullet hits an **arm or leg** and there's a wall or static surface within 0.6 m *(start)* behind it along the bullet's path, the limb is **stuck to the wall** for 2 s *(start)*. Each jump press cuts 0.3 s off. Callout `PINNED!`. **[L]** No bullet stays in it: the limb is drawn held against a bullet hole in the wall.

---

## 4. Pickups (power-up bubbles)

- Bubbles float at the arena's **pickup spots** (usually the risky open middle). **You shoot the bubble to get it**, the same way as apples.
- It gives **one special bullet** for your next shot, shown loaded in your gun **[L]**. Lost on death. A new bubble appears 15 s *(start)* after one is taken, with a random type.
- **[L]** Specials whose effect *is* an object still show it while it lasts (the balloon, the plunger and its rope, the sticky bomb, the oil puddle); every other special bullet vanishes on impact like a normal one.
- **[L]** The specials stay the same, fired from the gun as special rounds: boxing glove, helium balloon, oil, plunger, sticky bomb, banana, swap, feather.

| Special bullet | What it does |
|---|---|
| **Boxing Glove** | **[L]** A little damage (was 0) and a **dent**: the part it hits stays bent in the shape of a fist until respawn (section 11, L4). A huge push (about 8× a normal bullet *(start)*), balance off for 1.5 s. The victim flies into a wall: if the wall impact is fast enough, `SPLAT!` plus a cartoon dent. Near a pit it means a ring-out. Callout `OUTTA HERE!` |
| **Helium Balloon** | A balloon is tied to the part it hits for 4 s. On the torso it lifts about 1.2× body weight *(start)*, so the victim floats up slowly. On a limb it lifts that limb (hopping on one foot). **The balloon can be shot to pop it**, and the victim drops. |
| **Oil** | Bursts into a 4 m *(start)* puddle on the floor under where it lands, for 8 s. Feet in oil have almost zero friction (with the "Min" combine rule so it really applies). Standing still means the feet slowly slide into a split and the body collapses. Walking means the legs scramble for 0.5 s, then the body shoots forward and slides on its stomach. Callout `SLIP 'N SLIDE!` |
| **Plunger** | Sticks and drags the victim toward the shooter on a rubber rope for 1.5 s. |
| **Sticky Bomb** | Sticks and beeps for 2 s, then a big push blast hits everyone nearby. |
| **Banana** | Splits into 3 smaller bullets mid-air. |
| **Swap** | You trade places with whoever you hit. |
| **Feather** | 0 damage. The victim laughs: arms flail and they can't aim for 1.5 s. |


---

## 5. Callouts

These replace plain damage numbers with comic text. The server picks the callout; a harder impact makes it a little bigger.

**[L] Two sizes, so they never cover the fight:**
- **Small tag** (most callouts): about 60% of the old size, no big shape behind it, sits just above the victim's head (above the health bar), follows the head, lasts about 0.6 s. One per player at a time: a new one replaces the old.
- **Big banner** (`DOUBLE KILL`, `RING OUT!`, `REVENGE!`, `KABOOM!`, `OUTTA HERE!`, L5: `DISARMED!`, `SHATTERED!`): at the top of the screen in the HUD, like the chaos-round countdown, about 1.2 s, at most 2 queued.
- Damage numbers get smaller too.

| Callout | When | Size **[L]** |
|---|---|---|
| `CRACKED!` | Headshot | tag |
| `ANKLE BREAKER!` | Leg hit | tag |
| `SLIP 'N SLIDE!` | Oil slip | tag |
| `SPLAT!` | Fast wall impact | tag |
| `PINNED!` | Wall pin | tag |
| `AIRBALL!` | Hit while the victim is in the air | tag |
| `SNIPED!` | Very long distance hit | tag |
| `POINT BLANK!` | Very short distance hit | tag |
| `BONK!` | Knocked by a swinging wrecking ball | tag |
| `SWAPPED!` | Swap round | tag |
| `HA HA HA!` | Feather round | tag |
| `SELF-OWN!` | Dying from your own glove bounce or bomb | tag |
| `HUMBLED!` | Hit while taunting | tag |
| `OUTTA HERE!` | Boxing glove hit | banner |
| `KABOOM!` | Sticky bomb blast | banner |
| `RING OUT!` | Death in a pit | banner |
| `REVENGE!` | Killing your last killer | banner |
| `DOUBLE KILL` | 2 kills within 3 s | banner |
| `DISARMED!` | A critical hit knocked the gun away (L5) | banner |
| `SHATTERED!` | The 3rd melee hit broke the body into pieces (L5) | banner |

Each callout keeps its own text colour so they're easy to tell apart, but no big shapes (bursts, boxes, rings) behind them any more **[L]**.

Impact accents **[L]**: a white impact spark, a few small chips in the hit part's own colour, the bullet hole, a 2-frame white flash on the part, and a small screen shake only on big hits that involve you. No blood, no colour splashes.

---

## 6. Look and movement

### Proportions **[L]**
- **Head drawn at its hitbox size** (hitbox stays about 1.15× the original *(start)*); headshot stays ×5. What you see is what you can hit.
- **Heavy boots stay as physics only** (low center of gravity, quicker get-up, funny falls). They are not drawn.
- **Thick round-ended limbs** (drawing only, start 0.1 m), like Stick Fight.
- **Big Head Mode** (chaos modifier): hitbox 2×, head multiplier ×2 for those 20 s, so it isn't a one-shot lottery. It's funnier now, by contrast with the normal small heads.

### Arms **[L]**
- The **gun arm always points at the mouse pointer** (on mobile: at the aim stick's direction; with no input it points forward). The back hand works the pump/bolt.
- The arms go limp only when stamina is empty (arms down), when stunned, and when dead. (Was: limp whenever you weren't drawing the bow.)
- Bullets still launch from a fixed point (shoulder + 0.8 m along the aim), not the hand, so the floppy body never changes where a shot goes.

### Running **[L]**
- **Real physics:** a small forward lean while running, a **short** skid on stop (Stick Fight stops fast), a tilt forward then snap back on hard stops (may trigger a stumble).
- The spinning-legs blur is **removed**; dust puffs show speed instead (section 11, L2).

### Look: "moody world, bright players" **[L]**
Vibe taken from *Stick Fight* (flat bright figures, simple shapes, funny physics) and *Shadow Fight 2* (dark atmospheric depth, silhouettes, soft light). Not a copy of either. All drawn in code: almost no art files.
- **Players:** each one is **one flat bright colour**, no outline, no face. Plain round head, thick round-ended limbs; back limbs a shade darker for depth. Dead: the body turns dark and fades (no X eyes). Crown and hats stay, sized to the head.
- **Damage drawing (stylized gritty, no blood):** bullet holes are small dark see-through holes in the part; a stump ends in a flat, darker cut; a dented part is drawn bent; a lost piece (shin, hand) lies on the ground in the player's colour until they respawn.
- **Arena palette (data, per arena):** a dark, muted sky gradient; 2–3 **parallax silhouette layers** behind the play area (city skyline, trees, hills, chains...), each farther layer lighter and hazier (Shadow Fight 2 depth); terrain as a **dark silhouette with one bright accent edge** on top (crimson grass, glowing lava rim, neon roof edge); an optional soft glow for light sources (lava, lamps).
- **Readability rule:** the background is the darkest and dullest thing, players and bullets the brightest. A test checks every arena palette: all 8 player colours and the bullet tracer colour must stand out against its sky and terrain (minimum contrast).
- **Bullets:** a bright white/yellow tracer with a short trail in the shooter's colour (you can see whose shot it is).
- **Aim preview:** dots in your own colour, fading out along the path.
- **Gun:** a simple flat gun silhouette (pump or bolt action), dark grey with a coloured stripe in the player's colour. The pump/bolt moves during the reload, so the gun itself shows when it's ready (plus a small ring on the HUD).
- **HUD:** dark translucent panels to match.
- The debug wireframe stays on F2.

---

## 7. Camera

- Follows you and shows about **36 m** of width *(start)* **[L]**, staying inside the arena walls.
- **[L]** No more "zoom out while drawing" (there's no drawing). Instead the camera **leans toward the mouse pointer** (up to about a third of the way to the screen edge *(start)*), so looking far ahead is something you choose. Re-checked against the arena sizes in L4. **[L7]** Tighter: the camera keeps you steadier on screen (less lag, a smaller lean) so the aim doesn't drift while you run (section 11, L7).
- **Edge markers:** small triangles at the screen edge point at off-screen enemies, so nobody gets sniped by someone they couldn't know about.
- Mobile may need a slightly wider view; tune it in Phase 5.

---

## 8. Arenas

### How an arena avoids "everyone kills everyone"
- **Three heights (tiers):** ground, mid platforms, high platforms. Platforms block shots from above and below.
- **Cover:** blocks and crates to hide behind and peek out from.
- **Gravity limits range:** close fights are easy, far ones take skill. **[L]** Bullets all fly at the same speed, so long shots are high lobs (see the bullet drop and the wind).
- **8 spread-out spawns** across all tiers, far from enemies, with 1 s of protection.
- **A risky middle:** power-up bubbles and the best spots sit in the open; safe sides have apples but no power-ups. **[L]** Apples matter more now: a health apple also puts a damaged body back together.

### Example layout: Construction Site (64 × 26 m; heights re-checked against the new jump in L4)
- Ground floor with a **pit** in the middle.
- Left and right: mid platforms (7 m up) and high platforms (14 m up), with apples above the high ones.
- Girders (10 m up) on both sides of the middle, and a **crane deck** (20 m up) across the center that sees everything but is exposed.
- A **wrecking ball** hangs from the crane over the pit; shoot it to make it swing.
- **Trampolines** on the ground on both sides as a fast but exposed way up.
- The **power-up bubble** floats over the pit.
- Concrete blocks and crates on the ground for cover.

### Hazards
| Hazard | What it does |
|---|---|
| **Pit** | Gap in the floor. Falling in = death; the last hitter within 3 s gets the kill (`RING OUT!`). |
| **Trampoline** | Bounces anyone standing on it up hard. |
| **Seesaw** | Platform on a hinge; a heavy hit on one end launches whoever is on the other. |
| **Wrecking ball / swinging log** | Shoot it to make it swing; it knocks people over or into pits. |
| **Fan** | A steady wind box: pushes players and bends bullets (the preview shows it exactly). Built always-on instead of 10 s gusts, so the preview can't be wrong at a gust's edge. |
| **Conveyor belt** | Moves whoever stands on it. |

Pushes from hazards go through `GameWorld.push()` (ragdoll parts ignore direct impulses).

### Rotation (fixed order)
Each arena has one signature gimmick. **[L]** Which arenas ship, and in what order, is **not decided yet**: it's decided
after the Look & Feel update (section 12). Rotation since L6: Windy Rooftop → Construction Site → Test Lab → Backyard.

Candidates (more in section 13):

| Arena | Gimmick | Status |
|---|---|---|
| **Windy Rooftop** | Wind rising from an alley and spilling over two roofs; lobs float and get pushed back. Duel-first (its small size is a 40 m 1v1). | **In the game (L6)**, first in the rotation |
| **Playground** | Seesaws, trampolines, a slide. | Idea |
| **Construction Site** | Pit, scaffolding tiers, wrecking ball (example layout above; as built: mid decks 6 m, girders 10.8 m, crane deck 14.4 m). | **In the game (L6)**, second in the rotation |
| **Ice Rink** | Whole floor slippery; skids and splats. | Idea |
| **Castle** | Two tall towers with a moat (pit) between; long-range duels. | Idea |
| **Bouncy Castle** | Whole floor bounces. | Idea |
| **Kitchen** | Conveyor counters, hot stove (a pit). | Idea |
| **Backyard**, **Test Lab** | Placeholders used for testing; kept in the rotation (decided 2026-10-08). | In the game, after the two final arenas |

---

## 9. Matches

- **Length:** 3 minutes or first to 15 points *(start)*.
- **Players joining mid-match** spawn in normally and play the rest of it.
- **Score:** 1 per kill, 2 for killing the crown holder.
- **Results screen (about 10 s):** winner, plus fun awards: *Most Splats*, *Biggest Self-Own*, *Longest Shot*, *Crown Holder* (most seconds), *Most Pinned*. The best moment is named (**[L7]** no replay any more), then "Next arena: ...".
- **Next arena:** the fixed rotation above.

### Bounty crown
- Turns on with **3 or more players** (bots count).
- The kill leader wears the crown. Killing them gives +2 and moves the crown to you.

### Chaos modifiers
- Every 60 s a chaos round runs for 20 s *(start)*, announced 3 s before it starts. Each match goes through the rounds in a shuffled order (each once before any repeats).
- **Pool:** Moon Gravity, Big Head Mode, Boxing Gloves Only (**[L]** every shot is a glove round; a held special waits), Oil Floor, Everyone Has Balloons. More can be added later.

### Filler bots
- The server fills quiet rooms up to 4 players *(start)* with bots. A bot leaves when a real player joins.
- Bots use the same `shared/` controls as players (aim, walk, jump, fire), so they can't do anything a player can't.
- Bot skill is tunable. Bots should feel beatable, not perfect.

### Instant replay
**[Removed in L7 (2026-10-09): it took over the screen mid-game. Maybe later.]**
- On death (during the 3 s respawn wait), your screen replays the last 2–3 s in slow motion from the snapshots your client already keeps.
- The match's best moment (e.g. a long-distance kill or a ring-out) replays on the results screen.

### Taunt and hats
- **Taunt button (T):** a silly dance; getting hit while taunting gives `HUMBLED!`.
- **Cosmetic hats** (built in S7; **[L]** redrawn to sit on the smaller head) unlocked by funny achievements (e.g. pin 10 players, self-own 5 times), saved on the device for now. Hats fly off on headshots.

---

## 10. Build phases (S1–S7)

> These are **done** and describe what was built with the bow. Section 11 changes the weapon, look and movement on top of them.

Each phase is **built and tested together**: the tests, sim scenarios and log events for a feature are written in the same phase as the feature, not afterwards. Every phase ends with something you can play.

At the time, the plan was that after S7 only the final arenas and character looks were left (the Look & Feel update in section 11 came after). So S1–S7 built those as *plug-in content*:
- **Arenas** are data files. A shared validator, a sim scenario and a netsim scenario test **every** arena file automatically, so a new arena is "write the file, run the checks".
- **Character looks** are split in two. The *body* (hitbox sizes, weights, motor strengths) is numbers in `constants.ts`, with a sim report that measures how it feels. The *skin* (how it's drawn) is a swappable drawing module in `client/`. The final look = new skin + adjusted numbers, re-checked by the report.

### Done rule for every phase (S and L phases)
1. `npm run typecheck`, `npm test`, `npm run sim`, `npm run netsim` all pass.
2. The new log events and anomaly checks are in, and `logs/` show no warnings in a real game run.
3. The older scenarios (`brawl`, `basic`, `lag`, `cheat`...) still pass, so nothing old broke.
4. `ragdoll architecture.md` is updated.
5. Your play check (listed per phase) feels right.

---

### S1: Arena framework + camera ✅ (done 2026-10-07)
Placeholder arenas: **Backyard** (today's level, converted) and **Test Lab** (multi-tier test arena: platforms, cover, a pit; later phases add every hazard here).

| Build | Test it with |
|---|---|
| Arena data format + loader; the fixed `ARENA` constant removed everywhere (arrow bounds, canvas, level). | Vitest `s1-arena.test.ts`: loads every arena file; arrow bounds follow arena size. |
| **Arena validator:** spawns inside walls, on a floor, not over a pit, clear of each other; pickup/apple spots inside the arena. | Vitest runs the validator on **every** arena file (new arenas get checked for free). |
| Arena width by player count (outer zones on/off at match start). | Vitest: 3 players → narrow, 6 → full; spawns stay valid in both. |
| Pits: falling in = death, kill to the last hitter within 3 s, callout `RING OUT!`. | Sim `pit`: a pushed player falls in; death + credit logged. |
| Snapshot positions changed from 2 mm to 4 mm steps (16-bit signed only reaches ±65 m; a 64 m arena + margins needs more). | Vitest: encode/decode round trip at the far corners of the biggest arena. |
| Follow camera (~30 m view), zoom out while aiming, edge markers for off-screen enemies. | Play check (client only). Log `camera_mode` changes. |

- **Sim:** `arena_spawns` spawns 8 players in every arena (both widths), and they stand for 5 s with no anomalies.
- **Netsim:** `arena` runs bots in Test Lab and checks that every client gets the same arena and positions decode correctly near the edges.
- **Logs:** `arena_loaded {id, width, players}`, `ring_out`. Anomalies: player outside arena bounds, spawn blocked.
- **Your play check:** walk around Test Lab, aim far, and see the edge markers.

### S2: Matches + bots ✅ (done 2026-10-07)
Comes early because **bots become the test opponents for every later phase**.

| Build | Test it with |
|---|---|
| Match loop: `playing` → `results` (10 s, scores) → next arena; ends at 3 min or 15 kills. | Vitest `s2-match.test.ts`: ends by kills, ends by time, rotation order. |
| World rebuilt between matches; mid-match join; scores reset. | Vitest: no leftover bodies/arrows after rebuild. |
| Bot brain on the server (walk, aim, jump, fire through the same checked controls as players). | Vitest: bot inputs pass the same input checks; a bot never fires above the power cap. |
| Filler bots up to 4 players; a bot leaves when a human joins. | Netsim `fill`: 1 human → 3 bots; 2nd human joins → a bot leaves. |

- **Sim:** `bots` runs 4 bots for 2 min, checking that kills happen, no bot gets stuck, and there are no anomalies. `match` plays a fast-forwarded full match to the results screen.
- **Netsim:** `match_cycle` plays bots through match end → results → next arena, and every client sees the same states at the same ticks.
- **Logs:** `match_start`, `match_end {reason, scores}`, `bot_join`, `bot_leave`, `bot_stuck` (anomaly).
- **Your play check:** a full match alone with bots, then a friend joins.

### S3: Effect system + arrow effects + callouts ✅ (done 2026-10-07)

| Build | Test it with |
|---|---|
| Shared status-effect system (type, part, start/end tick), sent as snapshot flags. | Vitest `s3-effects.test.ts`: timer, refresh on second hit, cleared on death. |
| Head pendulum, arm flail, leg limp; arrow wobbles then drops after 5 s. | Sims `head_sway`, `arm_flail`, `leg_limp`: report sway angle, drift, and that the legs keep equal standing targets. |
| Arm hit aim wobble, **shown in the preview**. | Vitest: preview vs real arrow error = 0 while wobbling. Netsim `lag`: client preview vs server shot under 120 ms lag. |
| Stumble reaction; jump misfire (`ANKLE BREAKER!`). | Sims `stumble`, `jump_misfire`: report steps taken, faceplant rate, get-up time. |
| Server callouts: `CRACKED!`, `ANKLE BREAKER!`, `AIRBALL!`, `SNIPED!`, `POINT BLANK!`; client banners sized by impact speed. | Vitest: callout chosen per hit case. Netsim: same callout on every client. |

- **Logs:** `effect_start`, `effect_end`, `arrow_dropped`, `stumble`, `jump_misfire`, `callout`. Anomalies: effect longer than its max, effect on a dead player.
- **Your play check:** fight bots and see whether each hit type is funny, readable and short.

### S4: Body + movement (the look's physics side) + skin system ✅ (done 2026-10-07)
Comes before pickups, because pushes are tuned against the final body weights.

| Build | Test it with |
|---|---|
| Body numbers: head hitbox ×1.15, heavy boots, thin limbs; re-tune balance and motors. | **Sim `body_report`**: one table with get-up time after a trip, 30 s standing drift, walk speed, skid distance, head sway, jump height. This report is what the final character look is tuned with. |
| Spaghetti arms (motors off when not aiming). | Vitest: launch point and preview unchanged with limp arms. |
| Dash: deeper lean, longer skid, stumble on hard stops. | Sim `dash_stop`: skid length and tilt within limits. |
| **Skin module** in `client/`: placeholder skin (drawn head ×1.6, boots, 8 player colors, leg blur, impact sparks). Debug wireframe on F2. | Play check. The skin only reads snapshot data (no game logic). |
| Body scale hooks for Big Head Mode (hitbox ×2, head multiplier ×2), used in S7. | Vitest: hitbox and damage change and restore exactly. |

- **Logs:** `body_report` numbers in `sim-latest.jsonl`. Anomalies: get-up slower than limit, joint over limit (already exists).
- **Your play check:** run, stop, jump, get tripped. Does it feel floppy-funny and still controllable?

### S5: Pickups + wall pins ✅ (done 2026-10-07)

| Build | Test it with |
|---|---|
| Power-up bubbles (shoot to collect), held special arrow, lost on death. | Vitest `s5-pickups.test.ts`. Netsim `cheat`: a client firing a special arrow it doesn't own is refused. |
| Boxing Glove + `SPLAT!` wall impacts + `OUTTA HERE!`. | Sim `glove`: flight distance, wall impact speed, no joint breaks. |
| Helium Balloon (lift by body weight share, poppable). | Sims `balloon_torso`, `balloon_leg`, `balloon_pop`. |
| Oil puddle (Min-friction feet, split, slide, `SLIP 'N SLIDE!`). | Sims `oil_stand` (split happens), `oil_walk` (slide happens). |
| Wall pins + mash to escape + `PINNED!`. | Sim `pin`: arm and leg pins hold, release on time, mashing shortens them. |
| Plunger, Sticky Bomb, Banana, Swap, Feather. | One sim scenario + Vitest case each. |

- **Netsim:** `pickups` checks that puddles, balloons, pins and held arrows look the same on every client and that a late joiner sees existing puddles.
- **Logs:** `pickup_spawn`, `pickup_taken`, `special_fire`, `wall_splat {speed}`, `balloon_pop`, `oil_spawn`, `pin_start/end`. Anomalies: body flung faster than the cap, pin on a moving surface.
- **Your play check:** fight with each arrow.

### S6: Hazards + floor types ✅ (done 2026-10-07)
All hazards are placed in Test Lab. Floor types make later arenas (Ice Rink, Bouncy Castle) pure data.

| Build | Test it with |
|---|---|
| Trampoline, seesaw, wrecking ball / swinging log (shoot to swing). | Sims `trampoline`, `seesaw`, `wrecking_ball`. |
| Fan / wind, which also bends arrows, **shown in the preview**. | Vitest: preview vs real = 0 in wind. |
| Conveyor belt. | Sim `conveyor`: carried speed matches the setting. |
| Floor types: normal, ice (slippery), bouncy. | Sims `ice_floor`, `bouncy_floor`: skid/bounce numbers. |

- **Netsim:** `hazards` checks that moving hazard positions match on every client and that a bot doesn't get stuck on them.
- **Logs:** `hazard_hit {type, player, speed}`. Anomalies: hazard push above the cap, a player stuck inside a hazard.
- **Your play check:** play a match in Test Lab with bots.

### S7: Match spice ✅ (done 2026-10-07)

| Build | Test it with |
|---|---|
| Bounty crown (3+ players, +2, passes on kill). | Vitest `s7-spice.test.ts`: crown rules. |
| Chaos modifiers: Moon Gravity, Big Head Mode, Boxing Glove Only, Oil Floor, Everyone Has Balloons; announced 3 s ahead. | Vitest: every value restored exactly after each modifier; preview correct in Moon Gravity. Netsim `chaos`: same start tick everywhere; a late joiner gets the active modifier. |
| Instant replay on death + best-moment replay on results. | Play check (client only). Log `replay_shown`. |
| Results awards (Most Splats, Biggest Self-Own, Longest Shot, Crown Holder, Most Pinned). | Vitest: award maths from a recorded match. |
| Remaining callouts: `REVENGE!`, `DOUBLE KILL`, `SELF-OWN!`, `HUMBLED!`; taunt button. | Vitest cases. |
| Hat system with placeholder hats (unlocks saved on the device, hats fly off on headshots). | Vitest: unlock rules. |

- **Logs:** `crown_change`, `modifier_start/end`, `award`. Anomalies: modifier left active after its end tick.
- **Your play check:** a full 3-minute match with friends and bots.
- **As built:** replays log `replay_start` / `replay_end` / `replay_skipped` (client); awards and the best moment are logged in `match_end`; the stuck-round anomaly is `modifier_stuck`. Details in the architecture doc (S7).

---

## 11. Look & Feel + Body Damage update (L0–L6), decided 2026-10-08

Why: playing S1–S7 showed the game is funny, but (1) light scenery hides the light projectiles and preview, (2) the small
face/boot details add clutter, not laughs, (3) walking and jumping feel slow next to Stick Fight, (4) callouts cover the
players, (5) dragging for every shot tires the hand in a fast, chaotic game. On top of that, the tone moves to
**stylized gritty**: lasting body damage that's funny to fight on with. Arenas wait until all this is done, because run
speed, jump height, the camera and body damage decide how big arenas and their gaps must be.

Same rules as S1–S7: each phase ships with log events, anomaly checks, Vitest tests and sim/netsim scenarios, and ends
with something you can play. Done = typecheck, test, sim, netsim pass + a browser check with clean logs + docs updated.

### The gun (what replaces the bow)
| Thing | Bow (old) | Gun (new) |
|---|---|---|
| Aim | Drag back and release | The gun points at the mouse pointer. Distance from the character doesn't matter. |
| Fire | Release the drag | Click. Holding the button fires again each time it's reloaded. |
| Shot speed | Set by how far you dragged (8–32 m/s) | **Always the same** *(start 32 m/s)*, then drops with gravity. Short shots = aim lower; long shots = high lobs. |
| Between shots | Draw time (0.5 s for full power) | **Pump/bolt reload** *(start 0.7 s)*, shown by the pump/bolt moving. |
| Stamina | Drained while drawing | **Each shot costs stamina** *(start 12 of 100: about 8 shots in a row)*, then arms down until it recovers, as now. |
| Preview | Whole arc | **First part only** *(start 0.5 s of flight)*, exact; you judge the drop after that. |
| Server check | Power capped by draw time | Refuses a shot before the reload is done (by server tick), without stamina, or while dead/arms down. Simpler and harder to cheat. |
| Arm-hit wobble | Swing timed by the draw | Swing over time while the effect lasts; the fire message carries the swing point the client showed, accepted within a small window. **[removed in L7: the gun never wobbles, no hand loss]** |
| After a hit | The arrow stays stuck in the body or wall (pushed along with crates), wobbles, then drops out | **The bullet vanishes.** Wall: bullet hole + dust. Player: spark + chips + a bullet hole that stays until respawn. No stuck-projectile list, no limit of 60 stuck arrows. |
| Specials | Special arrows | The same specials as special rounds (glove, balloon, oil, plunger, bomb, banana, swap, feather). |
| Mobile (Phase 5) | Drag on the right half | An aim stick (direction only) + a fire button. |

Physics stays the same: bullets are not physics bodies, they move with the same shared step and ray test, and the preview
uses the same code (preview = reality). The arenas' wind, updraft and Moon Gravity work unchanged.

### L0: Spike: can bodies lose parts? ✅ (done 2026-10-08): **GO**
Today every ragdoll always has all 10 parts, and balance, walking, aiming, snapshots and drawing all assume it. Before
building on it, prove the risky part in the sim with numbers:
- Shoot a leg down to a **thigh stump** during play: shorten the upper-leg shape, remove the knee and shin from the body, drop the shin as a separate loose piece.
- **One-leg hop:** can the body stay up and move at walking speed on one leg, with the same jump height?
- **Two stumps:** tiny steps and tiny jumps; does it stay upright?
- **Hand off:** remove the back hand/forearm; the gun stays in the gun hand.
- Loose pieces sent in snapshots and drawn the same on every client.
- **Output:** a short report (upright %, speed, jump height, joint warnings) and a go / change-the-rules decision before L4.

**Result: GO, no rule changes needed.** Sim `limb_loss` (same tests on each body, at today's 3 m/s walk; a probe also ran L2's planned 5.5 m/s):

| Body | Upright | Speed | Jump | Notes |
|---|---|---|---|---|
| Whole | 100% | 2.96 m/s | 1.35 m | head 2.03 m |
| One leg (hops) | 100% | 1.0× (5.47 m/s at 5.5) | 0.97× | 9 hops in 3 s; stump held up and forward; knee slightly bent |
| Two stumps | 100% | 0.6× | 0.47× (0.64 m) | head 0.8 m lower |
| Back forearm gone | 100% | 1.0× | 1.0× | gun arm aims within 0.01 rad |
| Leg lost mid-walk | 100% | 1.0× | 0.97× | no joint warnings, no blow-ups |

What the spike had to solve (all in the code now, numbers in `LIMB`):
- The **stump held up and forward** (hip −0.7 rad) while one leg is left: left hanging, once the body sank a little it propped itself on the stump like a third leg and stayed stuck, leaning.
- The **good leg points straight down in the world** (not along the torso), so the foot is always under the weight: one leg can't take a catch-step like two legs do.
- The **slight crouch on one leg** (knee 0.5 rad) works; the **full crouch key on one leg does not** (collapses, 37% upright): for L4 to decide (ignore crouch on one leg, or a deeper version of the slight crouch).
- Lost pieces get normal grip (a shin lost mid-step kept the slippery walking grip and slid 14 m) and a small kick so they tumble (a shin cut while standing stood up on its own).

Left for L4 (not done in the spike): drawing stumps and pieces (the skin still draws whole legs); sending lost parts in snapshots (protocol change); hazards and specials still treat lost pieces as part of the player in a few places (wind/trampoline/glove push all of `parts`, balloon lift counts their mass); the damage ladders themselves (only the physics exists: `stumpLeg`, `loseForearm`).

### L1: Look (client drawing + arena palettes) ✅ (done 2026-10-08)
| Build | Test it with |
|---|---|
| Arena **palette** in the arena data (sky gradient, parallax silhouette layers, terrain + accent edge, glow, dust colour); palettes for Backyard and Test Lab. | Vitest: every arena has a palette; **contrast check**: the 8 player colours and the tracer colour stand out against sky and terrain. |
| New skin: flat bright stick figures (no outline, no face, head drawn at hitbox size, thick round limbs, darker back limbs, dark-and-fade on death); boots and leg blur removed; hats and crown resized. | Play check + screenshot compare (client only; the skin only reads snapshot data). |
| Parallax backdrop drawn from the palette (code-drawn silhouettes from a seed, no image files). | Play check; log `backdrop_built {layers, shapes}`; warn if drawing takes too long per frame (`slow_backdrop`). |
| Two-size callouts (small head tags, big top banners); smaller damage numbers. | Vitest: each callout kind is assigned a size; play check that nothing covers a body. |
| Hit feedback: white spark + chips in the part's colour, 2-frame hit flash, small screen shake on your big hits; dark HUD panels; preview dots in your colour. (Holes and stumps come in L4.) | Play check. Particle cap with a `fx_capped` warning. |

- **Your play check:** a match with bots. Can you always see every shot, the preview and every player?
- **As built:** palettes for Backyard (night suburb, crimson grass) and Test Lab (night foundry, chains, amber edges); the contrast check needs a ratio of 3 and passes at 3.1-5.5. Two player colours were brightened for the dark arenas (purple, red). Protocol 10 (palette in the arena info). Banners show "who on whom" under the text. Details and numbers in `ragdoll architecture.md` (L1).

### L2: Movement feel + dust ✅ (done 2026-10-08)
| Build | Test it with |
|---|---|
| New movement numbers *(start)*: run 5.5 m/s, top speed in ~0.15 s, stop in ~0.1 s, air control 65%, no slowdown while aiming (crouch still slows). | **Sim `feel_report`**: time to top speed, stop distance, jump height (tap vs hold), time to apex, air turn-around time, get-up time. Each has a target range; the report says pass/fail. Re-run `body_report`. |
| Coyote time (jump up to 0.1 s after leaving an edge), jump buffer (a jump pressed up to 0.1 s before landing still happens), tap-or-hold jump height (letting go early cuts the rise). | Vitest cases for each; logs `jump {coyote, buffered, cut}`. Netsim: bots and lag still jump correctly. |
| Dust puffs (client, cosmetic): take-off, landing (bigger for harder landings), every ~1.2 m while running fast, quick turns. Driven by the `grounded` flag already in snapshots: **no network change**. | Play check; shares the L1 particle cap. |

- **Anomalies:** a jump that leaves the ground twice in one press, run speed above the cap, a get-up slower than the limit.
- **Your play check:** run, stop, jump off ledges, hop between platforms. Does it feel as quick as Stick Fight and still floppy-funny?

**Result:** every `feel_report` line passes: 0.15 s to top speed (5.48 m/s), stop in 0.15 s, turn round 0.3 s on the ground / 0.23 s in the air, held jump 1.34 m (apex 0.37 s), tapped hop 0.53 m, coyote and buffer work at 4 ticks and not at 10-12, get-up 0.97 s, no falls or joint warnings. What it took besides the new numbers:
- **Running lean halved** (0.12 → 0.06, brake lean 0.25 → 0.1): at 5.5 m/s the old lean ran away to 0.46 rad and the stop inherited it.
- **Full-size steps from 3 m/s** (`fullStrideSpeed`): steps were sized against the top speed, so slower runs took steps the body outran.
- **A head arrow caps running at 0.6×** (`headRunFactor`): a heavy floppy head pulled runners over at 4+ m/s (9-12 falls in 16); now 0, and every stop still stumbles.
- **Feet are slippery in the air**: holding a direction into a step's side let the body cling there by friction, hanging forever (it also threw a bot 29 m up in the chaos match).
- **Walking barely pulls while pinned** (`pinnedWalk`): the stronger walk bent a pinned knee backward.
- **Jumps cancel the fall speed first** (buffered jumps fire on the landing tick).
- **Bots hold jump** (`jumpHoldTicks`) so their jumps stay full.
- Found and fixed on the way (an S5/S7 bug, not L2): a point-blank shot into a balloon stuck in it instead of popping it, and ending the Balloons round then crashed the physics engine. Now one `resolveHit` for flight and point-blank shots, plus an `arrow_on_removed_body` anomaly guard.
- Dust: `client/src/dust.ts` (take-off within 0.12 s of lifting, landing after 0.25 s in the air sized by fall speed, a run puff every 1.2 m above 3 m/s, a skid puff on fast turns), drawn as soft puffs in the arena's dust colour through L1's capped particles.

### L3: The gun ✅ (done 2026-10-08)
| Build | Test it with |
|---|---|
| Input: aim = pointer direction only; click to fire, hold to keep firing; arms always aim. | Vitest: aim refuses NaN/Infinity as now; the preview launch point is unchanged. |
| Shared rules: fixed bullet speed, pump/bolt reload, stamina per shot; the server refuses early shots (`fire_too_soon`), and the client's stand-in bullet waits for the reload too. Protocol version bump (the fire message loses power/draw time). | Vitest `l3-gun.test.ts`: reload timing, stamina drain/arms down, refusal reasons. Netsim `cheat`: early and spammed shots refused; `lag`: shots under 120 ms lag land where the preview said. |
| Arm-hit wobble over time + its network check (swing point within a window). **[removed in L7: the gun never wobbles, no hand loss]** | Vitest: preview = real bullet while wobbling. Netsim `lag`: preview vs server error stays 0 within the window. |
| **Bullets vanish on impact** in the shared code: no stuck projectiles in bodies/walls/crates, no loose-wobble/drop-out; head/arm effects and pins keep working from the hit itself; snapshots stop sending stuck projectiles. | Vitest: a hit leaves nothing behind, the effect still starts and ends on time, a pin still holds and releases. Netsim: snapshots shrink. |
| Short preview (first 0.5 s), tracer look, gun look with the moving pump/bolt + reload ring; wall bullet holes. | Play check. |
| Camera: fixed ~36 m view that leans toward the pointer. | Play check; log `camera_setup`. |
| Bots switched to the gun (aim, fire on reload, rest when stamina is low). | Sim `bots`: kills happen, no stuck bots, hit rate reported. |
| All specials and chaos rounds (Boxing Gloves Only, Moon Gravity...) re-checked with the gun. | The existing S5/S7 tests and sims, updated. |

- **Logs:** `fire` (aim, swing point, reload left, stamina), `fire_too_soon`, `reload_done`. Anomalies: two shots closer than the reload, stamina below 0, a projectile still in the world after its hit.
- **Your play check:** a full match. Is it fast and fun without tiring your hand? Is 0.7 s the right reload?
- **As built:** every row above is in, with the start values (32 m/s, 0.7 s, 12 per shot, 0.5 s preview, ~36 m view leaning
  a third toward the pointer). Decisions made on the way: a shot that reaches the server up to 6 ticks before its reload is
  done is held and fired on the reload tick (`fire_queued`), so network jitter never refuses a fair click; holding fire never
  refills stamina (the rest starts after the reload), so "about 8 shots" really is 9; the swing window is one-sided (15 ticks
  behind the server, 3 ahead). With the gun always held out, the run lean ran away at 5.5 m/s, so the upright balance went
  260 → 400 and a head hit keeps 40% of it (was 30%). Found and fixed: Big Head Mode left ray tests blind for a tick (S7).
  Measured: netsim `lag` swinging shots land within 0.24 cm of the preview; fire spam gives 1 bullet + 9 `fire_too_soon`;
  bots hit 44%. For L6: lobs fly out over the Backyard's walls, and the Test Lab seesaw now throws people 3.6 m.
  Details: `ragdoll architecture.md` (L3).

### L4: Body damage (the damage ladders) ✅ (done 2026-10-08)
Hits add up over **one life**. A **health apple** puts the body back together (legs, hand, dents; holes stay); respawning resets everything.

**Leg ladder** (one shared ladder: a hit to *either* leg moves it one step; damage goes to one leg first, then the other):
1. **1st leg hit:** a trip (the character falls over, as today).
2. **2nd:** **dragging limp**: the character walks on the good leg while the hurt one hangs and is pulled along. Jumps stay normal (no misfire: decided 2026-10-08).
3. **3rd:** that leg is shot down to a **thigh stump** (no knee, no shin; the shin falls to the ground). The character **hops on the good leg at the same speed** as walking (long strides to keep up) and **jumps just as high**.
4. **4th–5th:** the other leg is shot down too: **two thigh stumps**. The character waddles on **tiny legs with tiny jumps**. *(start: slower walk and lower jumps; tuned in the sim so it's funny but still playable.)*
- In the limp and one-leg stages the character walks and runs **slightly crouched**, so the good leg visibly carries all the weight and the hanging/missing leg stays easy to see (crouching is a real body pose, so it also helps balance).

**Upper-body ladder:** **[removed in L7: the gun never wobbles, no hand loss]** after enough arm/torso hits *(start 3)* the **back hand** (the one working the pump/bolt) is shot off and falls to the ground. One-handed: the **reload takes longer** *(start ×1.5)*, and after every shot the gun **wobbles wildly** for a moment (shown exactly in the preview, like the arm-hit wobble).

**Lasting marks:** bullet holes in the hit part (until respawn); a **boxing glove** does a little damage and leaves the part **dented in the shape of a fist** (until an apple or respawn).

| Build | Test it with |
|---|---|
| Damage ladders in shared rules (`rules.ts`), the body changes in the ragdoll (from the L0 spike), lost pieces as loose bodies in snapshots. | Vitest `l4-damage.test.ts`: each ladder step at the right hit count, either leg moves the shared ladder, an apple repairs, respawn resets, holes stay through an apple. |
| Movement modes: dragging limp + crouch, one-leg hop, two-stump waddle. | **Sim `damage_report`**: speed, jump height, upright %, get-up time for each stage vs targets. |
| One-handed gun: longer reload, post-shot wobble in the preview. **[removed in L7: the gun never wobbles, no hand loss]** | Vitest: preview = real bullet during the wobble. Netsim `lag`: same under lag. |
| Drawing: holes, stumps with flat cuts, dents, lost pieces on the ground (one per piece, gone on respawn). | Play check. Netsim: every client sees the same pieces and stage; a late joiner sees current stumps. |

- **Logs:** `damage_stage {who, area, stage}`, `part_lost {who, part}`, `body_repaired {who, by: apple|respawn}`. Anomalies: a stage skipped or going backwards without an apple, a lost piece still there after respawn, a body that can't stay upright for 5 s in a stage.
- **Your play check:** get shot down step by step. Is each stage funny and still playable?
- **As built:** "4th–5th" read as: the 4th leg hit trips the other leg, the 5th makes two stumps. The dragging limp hops
  on the good leg at 0.75× speed (one stump: full speed, as planned); the crouch key does nothing on one leg (L0 found a
  full crouch on one leg collapses). One-handed: reload ×1.5 and a post-shot wobble that settles over 1.6 s (longer than
  the reload: rushing is wild, patience steadies it). The glove does 25% damage (5 on the torso). A red apple rebuilds the
  body standing on the floor under it. Bullet holes reach clients in the damage events, and a late joiner gets everyone's current holes in its welcome.
  Decided after the build (2026-10-08): no jump misfires with the dragging limp (jumps are normal). Late joiners: the
  welcome now carries everything that lasts but was only sent as events (player bullet holes, wall bullet holes, hats
  knocked off); rule written into CLAUDE.md. Two stumps on a trampoline: launched 8.1 m (sim `stump_trampoline`). Found and fixed on the way: a shot-off shin lying
  on a trampoline kept launching its owner (everything now reads the real soles), and a wall pin on a body lying down bent
  its knee backward as it got up (pins only on bodies that are up). Measured stages and details: `ragdoll architecture.md` (L4).

### L5: Critical hits + melee ✅ (done 2026-10-08)
- **Critical hit:** a rare, special hit knocks your gun out of your hands (it falls and lies on the ground; nobody can pick it up). Start triggers: **shot while in the air**, **punched into a wall by a glove**; more to invent, kept rare enough to feel special.
- From then on you fight with a **melee weapon** (baseball bat, gada/mace...) **until you die**. Click swings it toward the pointer. **[L7 changes this:** no pointer, one click = one swing toward where you face, two swing motions: see L7.**]**
- **Melee breaks bodies:** each melee hit breaks a limb (it hangs loose and the player takes more damage); after **2–3 melee hits the body breaks into pieces** (that's a death). The pieces stay on screen until that player respawns.
- Decided at the start of L5 (2026-10-08): crits = a bullet hitting you **in the air** (25%, seeded) or a glove punch into a wall (**SPLAT**, always); weapons **bat + mace**, the same but for the look (random pick); melee players reach gun players by **running 25% faster** and taking **30% less bullet damage** (no lunge); each melee hit **breaks the limb it hits** (it hangs loose, that player takes +25% damage), and the **3rd melee hit on the same player shatters the body** into pieces (a death).

| Build | Test it with |
|---|---|
| Crit rules + gun drop (server-decided, logged with the trigger). | Vitest: each trigger causes a crit; nothing else does; a dropped gun can't be used. |
| Melee: swing, reach, hit test (server-decided), limb breaking, breaking into pieces. | Vitest `l5-melee.test.ts`; **sim `melee`**: hit rate, time to break a body, no physics blow-ups. Netsim: same swings and pieces on every client. |
| Bots that can fight with melee. | Sim `bots` with crits on. |

- **Logs:** `crit {who, by, trigger}`, `melee_swing`, `melee_hit {part, broke}`, `body_broken`. Anomalies: a swing hitting beyond its reach, a player with both a gun and melee.
- **Your play check:** lose your gun and fight on. Is it hilarious, and can you still win sometimes?
- **As built:** a swing is the same click / `fire` message as a shot (36-tick cooldown, 8 stamina); the server sweeps the arm
  through its arc and checks the hit once, at its 7th tick: the nearest enemy part within 1.8 m of the shoulder and 1 rad of
  the aim, with no wall in between. 35 damage (head 45) and a push along the swing. A broken **back** arm hangs; a broken
  **front** arm still swings and shoots (you can always fight back). A broken leg drags like the L4 limp. A red apple mends
  broken limbs and resets the shatter count, but the weapon stays until death. The knocked-away gun is a real loose
  object drawn where it lies; it **never touches players and bullets pass through it** (the bots sim had one land on a
  lying player in a corner and keep them down). Callouts `DISARMED!` and `SHATTERED!` (banners). Bots with a melee weapon
  chase the nearest enemy and swing in reach. Measured: sim `melee` 100% hits on a standing target, ~2.3 s to break a
  body, melee run 6.84 m/s vs gun 5.46 (×1.25); sim `bots` (2 min): 6-8 crits, the disarmed bots land most swings.
  Found and fixed on the way (an L4 gap): a wall pin on a body that falls bent its knee backward; the pin now **tears
  out** when it forces a joint next to the pinned part past its limit (`PIN.tearOver`), and normal pins still last 2 s.

### L6: Re-check, then arenas ✅ (done 2026-10-08)
- Re-run `feel_report`, `body_report`, `damage_report` and all sims with the final numbers.
- Re-measure the **Windy Rooftop** draft with the new jump height, run speed, camera and body damage (gaps, hut/deck heights, wind effect on fixed-speed bullets) and update it.
- From L2: at full run speed the momentum carries you a long way. A runner launched by Test Lab's trampoline went under the perch beside it (the sim now "holds back, then steers over"); give trampolines room from what's above them, and re-check every jump gap with `feel_report`'s numbers (held jump 1.34 m, tapped 0.53 m).
- From L3: every bullet is 32 m/s, so lobs fly out over the Backyard's 18 m walls (fine, but it's a long-range limit to design for); the Test Lab seesaw can only be hit from above by a quick shot from the steps, and it now throws the player 3.6 m (the bow's slow lob: 1 m): re-tune `HAZARD.seesaw.shotImpulse`. Re-check the camera's 36 m view against the final arena sizes. From L4: two-stump players jump 0.64 m but a trampoline still throws them 8 m: put trampolines where stumps can reach them (Test Lab's sit on a 1 m step).
- From L5: two old physics edge cases showed up once in sim `bots` while L5 changed how fights play out (gone again in
  the final runs, but still there): a front arm hooked over a ledge (`perch_r`) with the body hanging from it bends the
  elbow ~1 rad backward for a tick (the old arm snag), and an idle body leaning 0.5 rad with its hands on a step edge
  never counts as up (`stage_cant_stand`). Also: the kill-feed text can overlap the long help line at the top right.
  - **Done (2026-10-08).** Running the `bots` room over 48 bot seeds (`tools/bot-seeds.ts`, new room option `botSeed`)
    showed both were common, not rare: `stage_cant_stand` in 21 of 48 fights, plus `joint_over_limit` / `joint_stretched`
    in 13. Found and fixed:
    - **Can't stand up:** the idle person spawns in the narrow Test Lab's 2 m pocket (arena wall, then the 1 m step).
      Tripped there, the 2.2 m body lay wedged across it, head on the step, feet in the corner. The straight legs and the
      unlimited hip motors made it a strut that pressed both walls with ~1500 N, and friction held it down (17/36 trips
      stayed down). The hands on the step were not the cause. **Fix: while down, the legs tuck in** (crouch targets), so
      the body is short enough to rise: 36/36 get up in ~1.1 s, and normal get-ups are unchanged (feel_report 0.68 s).
    - **Elbow bent backward on a ledge:** a hooked arm carrying the hanging body stays within 0.06 rad of its limit, so
      the weight was not the cause. Every big bend comes from a hard impact: Test Lab's trampoline under perch_r's edge
      throws people into the perch at 15-25 m/s. The other session's pit-wall crush and the wrecking-ball crush are the
      same kind. **Decision: excused**, because Rapier's JS API can't make joint limits stiffer (revolute limits can't go
      on the multibody joint, and more solver passes barely help). Such a moment is now logged as `joint_spike` (info) if
      the joint is back inside within 0.5 s and the limb touched something or the body was hit. Anything that lasts, or
      that the body does to itself, is still a warning (`LIMIT_CHECK.spikeTicks` / `impactSpeed`).
    - **A real bug found on the way:** when a part is shot off, Rapier rebuilds the joint tree and resets its root's
      rotation and speed. A body lying down snapped upright in one tick (joints pulled 0.5-0.9 m apart), and a flying one
      stopped dead. **Fix:** the tree's root is an invisible anchor that never turns, and the lost speed is given back.
    - Second round (after the bot step rule changed to jumping from standing, 48 seeds again): a body thrown up by a
      trampoline plus a jump (26-28 m/s) sank its head and forearm into the thin (0.4 m) perch and hung there for good.
      **Fix: soft CCD on body parts** (`RAGDOLL.softCcd` 0.3 m: Rapier looks ahead for contacts of fast parts; plain CCD
      does nothing for ragdoll parts). It also softens crushes: the arm launched into the perch at 28 m/s now bends
      0.38 rad instead of 1.03. And `stage_cant_stand` fired on a body kept down by six glove stuns in a row: it now
      counts only time down with full balance.
    - Then sim `arena_fights` (Construction Site): a bot pinned to the pit's side wall hung on there after the pin let
      go, because walking into the wall pressed its torso against it and friction held the body up. **Fix: in the air,
      no walk push while the torso presses against a wall that way** (`air_push_wall` / `air_push_free` logged). Only
      the torso: blocking it for any part (shins brushing a step's face while jumping up it) cut the running climb from
      2.0 to 1.7 m and broke the trampoline-to-perch route.
    - Sims `pocket`, `crush`, `cut_moving`; tests `shared/test/l6-ragdoll-edges.test.ts`.
- Then design the arenas (section 12).
- **Decided at the start (2026-10-08):** build **Windy Rooftop** and **Construction Site** now; keep Backyard and Test Lab
  in the rotation too.
- **As built:** all reports re-run (same numbers as L4/L5). Seesaw re-tuned to the bow's 2.36 m lift. Instead of
  eyeballing gaps, a new sim `jump_reach` measures what a body really reaches, and an automatic **arena reach check**
  proves every place in an arena leads to every other (it runs in Vitest on every arena, on the arena map and in
  `tools/reach-report.ts`). It found a dead-end pocket on each side of Test Lab's pit (fixed), Backyard's unreachable
  crate shelf (now marked scenery), and the Windy draft's too-tall huts and one-way lower roofs (fixed). Windy Rooftop
  and Construction Site are in the game; rotation: Windy Rooftop → Construction Site → Test Lab → Backyard. A new sim
  `arena_fights` gives every rotation arena a 1 min bot fight, and the `arena` netsim now covers every arena. Fixed on
  the way: side walls now reach the sky (a Moon Gravity trampoline threw a player over one), bots cross planks and
  bridges over pits, no wall pin on a body flying past, the kill feed no longer overlaps the help line. The L5 physics
  edge cases (arm snag, leaning on a step) went to a separate session. Numbers: `ragdoll architecture.md` (L6).
- **Still open:** two stumps can't cross between the halves of any arena but Backyard (accepted: the last stage before
  death).
- **Your play check:** play a match on each new arena. Is the alley plank on Windy Rooftop the right risk? Is the crane
  deck worth climbing to?

---

### L7: Feel pass (decided 2026-10-08, after playing L0-L6)

What playing showed, with the numbers from that session's logs (`logs/server-latest.jsonl`, ~7 min, you + 3 bots):
you died 20 times, **median life 11.8 s** (some 2.0 s, dead 0.6 s after the first hit); headshots did 45-100 damage
(×5: a full-speed headshot is an instant kill); bots hit you with 36% of their shots (17-33% each other; they don't gang
up: 33% of their shots went at you, the fair share); **crits happened 20 times in 7 min** (25% of any hit while
airborne, and L2 made everyone jump a lot), each swapping the gun for a bat in one tick; a shot-off part was followed by
death a median **3.3 s** later, so most players never reached a stump. Goal of L7: **chaotic but never confusing**:
clean visuals, everything easy to tell apart, hits you can feel, deaths you can understand.

Each step below says what changes, why it's better than now, and how it's checked. Order = the order to build.

**1. A game-speed dial (an experiment first).** ✅ built (2026-10-08); waiting for your pick (1 / 0.85 / 0.75).
- *What:* one setting (`GAME.speed`, default 1) that slows everything that moves evenly: running, jumps, bullets,
  falling bodies, hazards. Timers stay in real seconds (reload, respawn, chaos rounds). The server reads it at start
  (env `GAME_SPEED`), sends it in the welcome, and the client uses the same value, so the aim preview stays exact.
  Offline: `?speed=0.85`.
- *Why it can work:* the physics step size (`DT`) is read fresh at all ~30 places it's used, so one value scales them all
  together; nothing has to be retuned by hand.
- *Check:* Vitest: preview = real bullet at 0.85; a jump's height is the same and its time is longer by 1/0.85.
  `feel_report` at 0.85 (times longer, distances the same). **You try 0.85 and 0.75 (two launch configs) and pick**, or
  stay at 1. Only after that does the chosen value become the default (and the sims are re-baselined).

**After-play round (2026-10-10)** ✅: jumps are free (stamina only for weapons); melee in a corner fixed (walls no
longer cancel a swing; the stroke starts where the weapon has room); balloon floating stays on screen (hovers 2.5 m
under the top, 1.5 m in from the sides) and you swim (W up, S down, A/D sideways) with a running/paddling animation; a
body hung on a ledge's corner can jump off; every special round shows a big detailed picture at the muzzle (and flies
as that picture); Frozen Lake (the aurora arena) is the 5th locked arena. Melee hits on the body or head make the victim
stagger back 2-3 steps leaning back (facing kept, no fall); a mace hit on the legs still trips. The "equal bullet time"
idea was dropped by the user. The limp (dragging leg) is clearer: the leg is wrapped in a white bandage, the foot
scrapes the ground with dust and scuff marks, and the good knee dips deeper on each hop (speed and jump unchanged).

**1b. The gun never wobbles; no hand loss** ✅ (asked for while building step 1). An arm hit no longer swings the
gun's aim (the back arm still windmills while walking, as a look), and arm/torso hits no longer shoot the back hand
off (no slower one-handed reload, no wobble after each shot). Leg loss stays. *Why:* the wobble was annoying and losing
a hand wasn't funny. Also simpler underneath: a shot is just an angle again (no swing tick in the fire message, no
swing window on the server, protocol 15). *Check:* Vitest (an arm hit fires exactly the aim; an old client's swing
tick is ignored; arm/torso hits never cut a hand); netsim `lag` now checks that a still shooter's bullets land where
its preview said.

**2. Clean visuals and easy aiming.** **[To be re-planned together as a GLOBAL LOOK (asked 2026-10-09)]:** one
colour scheme for every arena and game mode, in the spirit of *Shadow Fight 2* and *Stick Fight* (consistent, clean,
every detail readable): **dark backgrounds, bright neon characters, glowing neon bullets**, an aim projection that's
subtle and never clutters the screen, and a cleaner screen: only **"YOU"** is labelled on the playing user; everyone else
appears in a **legend at the side** (their colour + name). The items below are the starting point for that plan.
- *What:*
  - **The gun reads at a glance:** bigger, light-grey body, a stripe in your colour, a bright muzzle tip, so its
    direction (left, up, into a corner) is obvious; your own gun follows the pointer instantly and smoothly (it does
    already on your screen; it just has to be visible).
  - **One aim line:** the first 0.5 s of the path as a clean solid line in your colour from the muzzle, fading out.
  - **No cursor at all** ✅ (the user's call, 2026-10-09; replaces "one simple cursor"): no crosshair, no ring. The aim
    preview shows where you aim; the gun shows the reload.
  - **Character-relative aim + a faint dot** ✅ **LOCKED** (2026-10-09, the user: "feels perfect"; don't change it without asking): the mouse moves an aim point attached to your character
    (max 5 m away), not a spot on the screen, so moving never changes your aim; move the mouse past your body to turn
    around. A click locks the mouse to the game (Esc frees it). A faint dot in your colour marks the aim point.
  - **A steadier camera:** follow lag 0.12 → 0.05 s and lean 1/3 → 1/5 *(start)*. Today the camera trails a 5.5 m/s
    runner by ~0.66 m, which turns your aim while the mouse stays still (part of "aiming felt weird while moving").
  - **Backgrounds stay behind** ✅ (2026-10-09, after the user found the buildings chaotic): no silhouettes at all
    (buildings, chains, trees, hills) in any arena; the sky gradient and soft glows set the mood. Rule for every future
    arena (`LOOK_RULES`): at most one far layer, and it must be barely visible against the sky (contrast ≤ 1.3).
  - **Quiet wind** ✅: no tinted box, no streak lines (they looked like bullets); a few tiny faint specks drift with
    the wind. The aim preview's bend shows its effect.
  - **Clean screen** ✅: only you are labelled ("YOU ▼" in your colour, above your bars); everyone else is in the
    **players panel** top left (colour dot, name, score; you in bold; dead players dimmed; ♛ the crown). The match
    clock is one small line at the top centre; room, ping and the controls help are one quiet line at the bottom (the
    help only for the first 15 s). The kill feed sits under the clock. Still to come with the colour references: the
    neon colours, the gun's look, bullets.
  - **After a respawn, find yourself at once:** the camera snaps to you, your shield bubble (step 3), a bright "YOU"
    ring/arrow for 2 s, and the gun points straight ahead until you move the mouse.
  - **A small arrow in your colour above your head**, always, so you never lose yourself in a crowd.
- *Why it's better:* you said the cursor visual was confusing and you lost your character after respawning; nothing
  in this step changes how the game plays, only how clearly it reads.
- *Check:* a client measurement logged in the browser check: aim drift with a still mouse while running (target under
  2°/s; measured before and after); screenshots compared before/after; the contrast test.

**3. Fewer one-shot deaths, fairer bots, a visible spawn shield.** ✅ built 2026-10-09: headshot 50 (two kill);
2 s shield bubble in your colour (blinks its last 0.5 s, bullets spark off it, ends when you shoot or swing; logs
`shield_end {why: time|shot}`, impact `on: 'shield'`, protocol 16); bots aim error 0.07 → 0.3 rad and reaction
0.4-0.8 s: they hit 24% of shots at moving bots (4 seeds), the `bots` sim checks the rate and prints the median life.
Also fixed: a bot whose target stood across a gap dithered at the pit edge (it now remembers the pit like a wall).
Found, not yet fixed: bots standing over a pit flip direction every tick and fall in (a separate task).
- *What:* headshot ×5 → ×2.5 (50 damage; torso 20, limbs 12 stay); spawn protection 1 s → **2 s, drawn as a shield
  bubble** around the whole character (flickers in its last 0.5 s; bullets spark off it; it ends early if you shoot, so
  it can't be abused); bots hit about **25%** of their shots at a moving player (aim error up, reaction 0.4-0.8 s
  instead of 0.2-0.5 s).
- *Why it's better:* the headshot one-shot was the main way you died fast (two lives ended "torso 20, head 80/88");
  two of your lives lasted 2 s.
- *Check:* sim `bots`: bot hit rate on moving bots 20-30%; a new sim `survival` (you = an idle-but-strafing bot vs 3
  bots, 3 min): median life **25-30 s** (was 11.8 s); Vitest: damage table, shield duration and early end.

**4. Disarms: rarer and clearly shown.** ✅ built 2026-10-09: 8%, only after 0.25 s in the air (`critMinAirTicks`);
the gun tumbles away in a bigger arc (kick 6, spin); `DISARMED!` banner for everyone (already); 0.6 s of empty hands
(swings refused: `drawing_weapon`; logs `disarm_draw` when the weapon is out, with a flash at the hand); HUD "GUN LOST!
drawing your bat..." then "GUN LOST: bat until you respawn - click to swing". Measured: about 2 disarms a minute in a
4-bot fight (bots jump a lot). Also fixed two netsim checks that failed now and then: `game_speed` counted a dodged
shot (preview said "a player", the player stepped away) as a preview error; `lag` fired at a new angle without aiming
first (the arm swinging nudges the body after the client's snapshot).
- *What:* crit chance 25% → **8%**, and only after at least 0.25 s in the air (not the tiny hops while running). When it
  happens: the gun spins away in a big arc; `DISARMED!` at the top for everyone; the victim has ~0.6 s with empty hands
  (can't swing), then draws the bat/mace with a flourish; HUD: "Gun lost: melee until you respawn". (No shaking-gun
  warning: decided against, it would confuse more.)
- *Why it's better:* 20 crits in 7 min, each a one-tick swap: you couldn't tell when it happened.
- *Check:* sim `bots`: crits per minute (target ~1 in a 4-player room); Vitest: no crit from a short hop, the empty-hand
  window refuses swings; netsim: every client sees the disarm on the same tick.

**5. Hits you can feel.** ✅ built 2026-10-10: every bullet hit knocks the whole body along the bullet (torso 2.5,
head 2.1, arms 1.75, legs 0.5 m/s) with a 0.3 s flinch (walk and air control at 25%); a head hit also snaps the head
and pitches the torso back; a leg hit sweeps the legs so the body pitches forward. Measured by the new sim
`hit_reaction`: a runner set back 0.42 m, head hit 0.22 rad back, leg hit 0.15 rad forward, a jump lands 0.48 m
shorter, standing torso hits never fall, no joint warnings. (The plan's start values set a runner back only 0.1 m.)
Logs `hit_knock {zone, dv, dir, air, vxBefore}`. Also: the netsim `lag` check's first shot was 4-9 cm off because the shooter raised its arm from rest just
before it (the body hadn't settled); it now aims before the stillness wait, every shot lands within 0.3 cm, and the check
is tightened to 2 cm.
- *What:* every bullet hit gives the **whole body** a small knock along the bullet *(start 1.2 m/s torso, 1.0 head,
  0.8 limbs)*, plus a part-specific kick: **head** hit: the head snaps back and the torso pitches back; **torso**: the
  body is set back; **leg**: the legs are swept back along the bullet, so the body pitches forward; **in the air**: the
  knock cuts the horizontal speed, so the jump goes less far. For a short **flinch** *(start 0.2 s)* the walk and air
  control push at 25%, so the knock shows.
- *Why it's better (checked in the code):* today a bullet pushes only the part it hits, 3.2 N·s: about 0.3 m/s for the
  whole body, and the run push (37 m/s²) wipes that out within a hundredth of a second. So hits really aren't felt now.
- *Check:* new sim `hit_reaction`: a runner hit head-on is set back 0.3-0.6 m; head-hit neck angle and torso pitch;
  leg-hit forward pitch; a jump hit mid-air lands measurably shorter; a standing body hit in the torso doesn't fall; no
  joint warnings. `feel_report` and `damage_report` still pass.

**6. Melee, redesigned.** ✅ built 2026-10-10: one click = one swing (holding doesn't repeat), toward where you
face (no aim dot, no reach fan with a melee weapon). Each swing: a 0.13 s wind-up (the arm goes to the start, can't
hit), the stroke, then the arm is let go (damped) so the weapon swings on and settles. Bat: the upswing, from low
behind, up and over the top, down in front. Mace (now a long gada, 0.95 m: a shorter one couldn't be low and reach
the legs at once): a low sweep that skims the floor and rises in front; its hits trip. The hit test follows the drawn
weapon (hand to tip, `weaponLine`, the same hand the client draws from) between its last and current place on every
active tick: what you see is what hits; a wall or crate stops it, the floor under you doesn't. Swings drive the
shoulders harder (the arm lagged 2.5 rad behind before). Measured (sim `melee_motions`): the bat hits head/arms up to
1.6 m, the mace legs/thigh up to 1.6 m (tripping), both miss at 2.2 m, a hit about 0.35 s after the click. Logs
`melee_swing {weapon, motion}`, `melee_hit {weapon, tick}`, `melee_blocked`, `melee_miss`.
- *What:* **no pointer**: a click swings toward where you face; **one click = one swing** (holding doesn't repeat: you
  time each click). Two motions, one per weapon *(start; easy to switch to alternating)*:
  - **Bat: the upswing**: a half circle from low behind, up and over the front, with follow-through: at the end the arm
    goes loose so the bat keeps swinging on its momentum and settles.
  - **Mace: the full-body sweep**: the body twists and leans, the mace held a little above the ground, swept from behind
    to the front low (hits legs: a trip).
  - **What you see is what hits:** the hit is tested along the weapon's real path over every active tick of the swing
    (the weapon's line from hand to tip, between its last and current position), not at one instant; the client draws
    the swing from the same shared function.
  - The aim fan is replaced by nothing (no pointer for melee); the cursor shows only the swing cooldown.
- *Why it's better:* today the swing is aimed around the pointer and the hit is checked at a single tick (7 of 14) in a
  1 rad arc: what's drawn and what hits can differ, and the pointer adds a second thing to aim. Timed clicks + two
  readable motions are simpler and more skilful.
- *Check:* sim `melee` per motion: hit rate on a standing target in reach, misses out of reach, no hits through walls,
  the upswing's settle time, the sweep's trip rate; Vitest: one swing per click, the hit point lies on the weapon path;
  netsim: the same swing and hit on every client.

**7. A lost limb you notice** ✅ built 2026-10-10: `LEG OFF!` banner for everyone (sub: who on whom); the shin flies
along the bullet, up and spinning (4.5 / 6 m/s, 16 rad/s), and lands with a thud (dust); the stump end gets a bright
cap; the off-screen edge marker flashes a small leg sign; awards *Flesh Wound* (longest alive on a stump) and *Most
Limbs Lost*. A piece that flies off the arena is switched off there. Measured (new sim `stump_survival`, bots that lose
a leg a second after spawning): they live a median 12 s after the loss (quartiles 4.7 / 22 s; your play log: 3.3 s).
Netsim `damage` checks the banner reaches every client. Protocol 17 (the `thud` event). (Plan text, as agreed:) `"Noodle lost a leg!"` at the top for everyone; the piece flies
in a big spinning arc and lands with a thud and dust; stump ends get a bright cut colour so a hopping player stands out
across the arena; the off-screen edge marker flashes with a small leg/hand icon; results awards *Flesh Wound* (longest
alive on stumps) and *Most Limbs Lost*. Steps 3 and 5 also give players more time between losing a part and dying.
*Check:* sim: time from a lost part to death (was a median 3.3 s; target over 6 s); the banner on every client (netsim).

**8. Springy, squishy legs** ✅ built 2026-10-10 (two whole legs; hopping, dragging, crouching, a heavy head and
lying down keep their own legs): running, the knees bend much more on the forward swing (knee lift 0.5 → 1.0, hip
swing 0.4 → 0.55) and the lifting leg is held at 60% so it lags; in the air the legs dangle loose for a moment after
the top of a jump and reach down under the body as it falls; landing, the knees sink by the landing speed and spring
back; legs are drawn as one smooth curve hip → knee → foot, and the body is drawn a little squashed for a moment after
landing. Measured (new sim `leg_report`): running knees bend 0.9 rad (was 0.61), landing knees bend 0.66 rad (was
0.06). Kept from going wrong (each found by a sim and fixed at its cause): legs changed on the way UP cut the standing
climb 1.4 → 1.3 m (the arenas' reach check needs 1.4), so rising legs are left alone; landing on loose dangling legs
took ~1 s to straighten (they now reach down when falling); a body stuck against a step's face dangled forever
(dangling only lasts 18 ticks after the top); a loose swing leg while braking kept the body rocking (only while
running); a heavy head on loose legs fell over (heavy head: firm legs). Jumps, climbs and gaps measure as before
(1.9 m running / 1.4 m standing climb). (Plan text, as agreed:) Softer leg motors while running so legs lag and overshoot, a
much bigger knee bend on the forward swing, loose dangling legs in the air after a short tuck, knees that sink on
landing by the fall speed and spring back; legs drawn as smooth curves (hip → knee → foot), a tiny squash of the body on
landing. *Why it can work:* running is a push on the whole body, not the legs' doing, so loosening them shouldn't cost
balance. *Check:* new sim `leg_report` (knee range while running, leg lag, landing sink and rebound), `feel_report` and
`body_report` still pass with 0 falls.

- **Logs (new):** `game_speed`, `hit_knock {zone, dv}`, `flinch`, `shield_end {why}`, `disarm_draw`,
  `melee_swing {motion}`, `melee_hit {motion, part, at}`, `limb_banner`; client `aim_drift` (in the perf report).
  Anomalies: a knock above a cap, a swing hit off the weapon's path, a shield still on after its time.
- **Your play checks:** step 1 (pick a speed), after step 3 (does dying feel fair?), after step 6 (does melee feel
  good?), at the end (clean, chaotic, never confusing?).

---

## 12. After the Look & Feel + Body Damage update: what's left

1. **Final arenas.** Each is drafted in `tools/arena-drafts/` and shown as a labeled map (`npx tsx tools/arena-map.ts tools/arena-drafts/<name>.ts`, which also runs the L6 reach check) before it goes into the game. Done in L6: Windy Rooftop, Construction Site. Draft 1: **Windy Rooftop** (duel-first: its small size is a 40 m 1v1). Decide the layouts (Construction Site, Playground, Ice Rink, Castle, Bouncy Castle, Windy Rooftop, Kitchen...). Each one is a data file. The validator, `arena_spawns` and `arena` netsim check it automatically.
2. **Final character looks.** **[L]** Mostly decided now (flat bright stick figures, section 6); what's left is fine-tuning colours and body numbers with `body_report` / `feel_report`.

Then **Phase 5 (polish + ship)** as before: sound, mobile controls, Poki/CrazyGames SDK, download size.

---

## 13. Arena ideas for later (from Stick Fight references, 2026-10-07)

What the references share: a **dark, muted background**, terrain one shade off it with **one strong accent colour** (crimson grass, glowing lava), and bright players. Each arena should carry its own palette as data.

| Idea | What's in it | New pieces needed |
|---|---|---|
| **Lava Foundry** | Platforms hanging on chains over a lava floor (the whole floor is a pit). Hit or land on a platform and it swings. | Swinging platform (a platform on a hinge: same physics as the wrecking ball). Lava glow + sparks (look only). |
| **Broken Bridge** | Two cliffs with trees, joined by a plank bridge. Shoot the planks and they break and fall. | Breakable bridge: a case of the banked **breakable platforms** idea below. |
| **Spike Castle** | Tall pillars with spikes on their inner walls, a floating island with spikes underneath, a spike floor. | Spikes (touching them hurts / knocks you back hard). |

### Banked mechanic ideas (2026-10-08, to finalise later)
- **Breakable platforms.** Some floating platforms are made of small pieces. Each shot chips the piece it hits; after 4–5 hits on the same spot that piece breaks off and leaves a hole, and whoever stands there falls through. To decide when we pick it up:
  - Do broken pieces come back (after N seconds) so an arena can't be emptied out in a long match?
  - Which platforms are breakable (marked in the arena data) and which never are (floors under spawns).
  - Needs: piece state in snapshots, the preview and bots seeing the holes (they read the same shapes, so mostly free), falling-piece visuals, a validator rule that spawns never stand on breakable pieces.
- **Gun types with their own damage.** Different guns with different damage (and maybe reload, bullet speed, how much they chip breakable platforms). To design together with breakable platforms.

### Decided 2026-10-08 (moved into the plan)
The grittier-hits ideas (bullet holes, glove dents, leg ladder with stumps, losing a hand (**removed in L7**), critical hits → melee until
death, bodies breaking into pieces) are **decided** and now live in sections 0, 1, 3 and 11 (L0, L4, L5).

Still to check before L4/L5: **web portal content rules** (Poki, CrazyGames) for stylized damage, so we know which
sites and ages the game can reach. The style (flat colours, clean holes and cuts, no blood) is chosen to keep that easy.
