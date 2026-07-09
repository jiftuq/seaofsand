# SEA OF SAND

Browser clone of *SAND: Raiders of Sophie*'s core loop: drivable walking mechs
("tramplers"), trampler-vs-trampler cannon combat, loot POIs, extraction
beacon. Three.js client + SpacetimeDB server authority.

See [docs/HANDOFF.md](docs/HANDOFF.md) for the full design, schema, and
milestone plan. The original single-file prototype is preserved in
[prototype/](prototype/).

## Run

```sh
npm install
npm run dev      # dev server
npm run build    # typecheck + production build
```

W/S throttle · A/D steer · mouse aims the turret · click fires.

Without a SpacetimeDB server running the game still works single-player
(the HUD link line shows `offline`).

## Multiplayer (M2)

```sh
# one-time: install the SpacetimeDB CLI + wasm target
curl -sSf https://install.spacetimedb.com | sh
rustup target add wasm32-unknown-unknown

spacetime start                # local server on :3000
npm run server:publish         # build + publish server/ as database "seaofsand"
npm run dev                    # open in two browsers → two tramplers
```

`VITE_STDB_URI` and `VITE_STDB_DB` (default `seaofsand`) point the client
elsewhere; without an explicit URI, dev builds use `ws://localhost:3000`
and production builds use `wss://maincloud.spacetimedb.com`. After changing
the schema in `server/src/lib.rs`, re-run `npm run server:publish` and
`npm run server:generate` (regenerates `src/module_bindings/`).

## Deploy

- **Server → Maincloud**: `spacetime login`, then
  `cd server && spacetime publish -s maincloud seaofsand`.
- **Client → Vercel**: standard Vite static site — framework preset “Vite”,
  build `npm run build`, output `dist/`. No env vars needed (production
  defaults to Maincloud); set `VITE_STDB_URI`/`VITE_STDB_DB` to override.

How it syncs, per the handoff contract:

- The server integrates throttle/steer into `pos/yaw/speed` on a 20Hz
  scheduled `tick`; that is ALL it syncs — gait and leg IK are derived
  client-side and never networked.
- Your own trampler is client-predicted with the exact same integrator the
  server runs, then reconciled: position/yaw/speed ease toward the
  authoritative row (~0.3s half-life), with a hard snap past 8m divergence.
  The integrator is substepped so slow frames can't dilate simulated time.
- Remote tramplers interpolate 120ms behind receive time through a snapshot
  buffer; their walkers re-derive gait locally from the interpolated pose.
- Parked tramplers settle to speed 0 server-side and stop emitting row
  updates entirely.

## Status

- [x] **M1 — Extract & fix**: prototype → Vite/TS modules; knee-flip and
      reverse-gait bugs fixed; movement integrator cleaned up
- [x] **M2 — Networked driving**: SpacetimeDB Rust module (`server/`),
      client prediction + reconciliation, 120ms remote interpolation
- [x] **M2.5 — Lobby, rooms & frames**: homepage overlay with callsign,
      frame + hull-paint customization, expedition (room) create/join with
      player counts and a 24-player cap; room 1 is the always-on open
      desert, player-founded rooms are reaped 60s after emptying. Three
      frames: DUNE SKIMMER (4 legs, spd 12, hp 60), TRAMPLER MK.I (6 legs,
      spd 9, hp 100), FORTRESS (8 legs, spd 6, hp 180). Tramplers subscribe
      per-room (`WHERE room_id = …`) so rooms never see each other's traffic.
      Multi-crew tramplers (up to ~6 aboard: driver, gunners, deck) arrive
      with the M4-era crew work — today each player drives their own.
- [x] **M3 — Combat**: server-authoritative projectiles — the `fire`
      reducer spawns a shell row from the turret muzzle (cooldown enforced
      server-side), the 20Hz tick integrates the ballistic arc and resolves
      terrain/trampler hits per room. 25 damage per hit: hull soaks first,
      spill hits the engine, engine 0 = dead. Dead tramplers collapse (gait
      stops, hull settles onto the sand), inputs are rejected, the wreck
      lingers 30s, and the owner is sent back to the lobby to refit and
      redeploy. Turret aim (gun yaw/pitch) syncs with the input stream so
      remote turrets track. Clients render shells by integrating the same
      arc locally from the spawn snapshot and explode where the row deletes.
- [x] **M4 — Loot + extraction**: 5 salvage sites per room (deterministic
      scatter, marked by amber light beams that thin as they're stripped);
      E loots 5 salvage per grab within 20m; cargo rides the trampler and
      shows in the HUD. X lights an extraction beacon: a green smoke column
      follows the trampler for 60s, visible to everyone in the room —
      survive the window and the trampler lifts off with its cargo. Dying
      drops your cargo as a fresh salvage site at the wreck for whoever
      killed you. This completes the core loop.
- [x] **M5 — Stakes**: extracted salvage banks to a per-Identity `Vault`
      row and persists between runs (shown in the lobby header); dying
      loses everything aboard — the vault is only ever credited by a
      successful extraction.
- [x] **Post-M5 — Depth pass**:
  - *Spawn protection*: 8s shield after every spawn (HUD countdown);
    shells bounce off, and opening fire forfeits it early.
  - *Salvage tiers*: scrap ×1 / alloy ×3 / relic ×8 value; sites carry a
    tier (beam colored amber/blue/violet) and stock 25/15/8; vault credit
    and kill-drops are value-weighted.
  - *Spending*: the FORTRESS frame is locked until bought for 100 banked
    salvage (click its lobby card); R field-repairs the hull to full for
    15 banked salvage.
  - *Crew stations*: TRAMPLER MK.I carries 1 mounted gun, FORTRESS 2.
    "CREW GUN" in the lobby mounts a free station instead of piloting:
    the camera rides the host, mouse aims your gun (visible to everyone),
    click fires lighter shells (12 dmg, 0.6s). Host death or despawn
    returns the gunner to the lobby. Deck-walking (`move_local`) remains
    future work.
- [x] **Raiders & ornithopters**:
  - *Ornithopter* (frame 3, 60 salvage to unlock): flies at 12m over the
    dunes on flapping wings, 16 m/s, 30/30 HP, no gun seats, immune to
    boarding — a scout and getaway craft.
  - *Sand raiders*: "RAID ON FOOT" enters the desert as an unarmed figure
    (4.5 m/s). C buries you into a near-invisible sand mound (immobile);
    F within 8m of an enemy walker boards it. 3 seconds aboard cuts all
    its weapons for 45s; 8 seconds seizes the helm — the trampler (and
    its cargo) changes owner and the old pilot is dumped onto the sand as
    a raider. Pilots get a BOARDERS ON DECK alarm and F sweeps the deck,
    throwing boarders off the stern. Moving tramplers crush raiders in
    their path — buried or not — so mind where you hide.
- [ ] **M3 — Combat** (server-authoritative projectiles, hull/engine HP)
- [ ] **M4 — Loot + extraction**
- [ ] **M5 — Stakes** (persistent loot per Identity)

## Layout

| module | responsibility |
| --- | --- |
| `src/terrain.ts` | analytic dune heightfield `terrainH(x,z)` + mesh. This function IS the physics; the server must implement it identically. |
| `src/walker.ts` | trampler build, drive integrator, tripod gait, two-bone leg IK. Cosmetic only — never networked; clients derive gait from pos/yaw/speed. |
| `src/combat.ts` | shell rendering for server projectiles; offline practice range |
| `src/net.ts` | SpacetimeDB connection, snapshot buffers, room subscriptions, input send |
| `src/lobby.ts` | homepage overlay: callsign, frame/paint pick, room list |
| `src/loot.ts` | salvage-site meshes: crate scatter + amber beam |
| `src/frames.ts` | frame presets — stats must match `FRAME_STATS` in the server |
| `src/module_bindings/` | generated by `npm run server:generate` — do not edit |
| `server/` | SpacetimeDB Rust module: tables, reducers, 20Hz tick |
| `src/effects.ts` | dust/fire/smoke particles, WebAudio thuds |
| `src/hud.ts` | dieselpunk HUD (amber on near-black) |
| `src/input.ts` | keyboard/mouse state |

## M1 bug fixes (vs. prototype)

- **Knee flip on steep slopes**: the IK bend plane was derived from
  `cross(legDir, worldUp)`, which reverses sign as the leg direction tips past
  vertical. Now each leg carries a stable pole vector (outward+up in walker
  space); the hip orientation is built as an explicit orthonormal basis whose
  X axis is the knee hinge, so the bend plane can never flip.
- **Reverse gait led feet the wrong way**: foot targets are now led by the
  actual world-space velocity vector (and step landings predict where the
  ideal spot will be at touchdown), so feet lead into the direction of travel
  in both forward and reverse.
- **Movement integrator**: the prototype's double-negated position update is
  replaced with a single clean `pos += forward * speed * dt` (forward = +Z at
  yaw 0, matching the turret).
