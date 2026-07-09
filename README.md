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

## Status

- [x] **M1 — Extract & fix**: prototype → Vite/TS modules; knee-flip and
      reverse-gait bugs fixed; movement integrator cleaned up
- [ ] **M2 — Networked driving** (SpacetimeDB module, `src/net.ts`)
- [ ] **M3 — Combat** (server-authoritative projectiles, hull/engine HP)
- [ ] **M4 — Loot + extraction**
- [ ] **M5 — Stakes** (persistent loot per Identity)

## Layout

| module | responsibility |
| --- | --- |
| `src/terrain.ts` | analytic dune heightfield `terrainH(x,z)` + mesh. This function IS the physics; the server must implement it identically. |
| `src/walker.ts` | trampler build, drive integrator, tripod gait, two-bone leg IK. Cosmetic only — never networked; clients derive gait from pos/yaw/speed. |
| `src/combat.ts` | turret fire, ballistic projectiles, destructible derelict (client-side until M3) |
| `src/net.ts` | SpacetimeDB glue (stub until M2) |
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
