# TRAMPLER — Claude Code Handoff

## What this is
Browser clone of SAND: Raiders of Sophie's core loop: drivable walking mech ("trampler"),
trampler-vs-trampler cannon combat, loot POIs, extraction beacon. Three.js client +
SpacetimeDB server authority.

## Current state
`trampler-prototype.html` is a working single-file, offline prototype:
- 6-leg walker, two-bone IK (law of cosines), tripod gait, feet planted in world space,
  step triggered when foot error > 2.2m, 0.32s lift arc
- Analytic dune heightfield `terrainH(x,z)` (sum of sines) — legs sample it directly,
  no raycasts. Client and server MUST share this exact function.
- Body height/pitch/roll derived from foot Y-positions + gait bob/sway
- W/S throttle, A/D steer, mouse turret, ballistic projectile, destructible derelict,
  dust/smoke particles, WebAudio thuds
- Known bugs: knee bend axis can flip on steep slopes; reverse gait leads feet in the
  wrong direction. Fix both early.

## Target architecture
- **Server**: SpacetimeDB module (Rust). Authoritative trampler kinematics on tick.
- **Client**: Vite + TypeScript + Three.js. Extract the prototype into modules:
  `terrain.ts`, `walker.ts` (IK + gait, cosmetic only), `net.ts`, `combat.ts`, `hud.ts`.
- Leg IK is NEVER networked. Server syncs `pos, yaw, speed` only; clients derive gait.
- Players on a trampler sync in **trampler-local coordinates** (`local_pos`), not world
  space. This is non-negotiable — it eliminates moving-platform jitter entirely.

## Schema (starting point)
```rust
#[table] struct Trampler {
    #[primary_key] id: u64,
    owner: Identity,
    pos_x: f32, pos_y: f32, pos_z: f32,
    yaw: f32, speed: f32,
    throttle: f32, steer: f32,        // last input, integrated server-side
    frame_id: u32,                    // preset frames only in v1, no editor
    hp_hull: u16, hp_engine: u16,     // engine destroyed = trampler dead, no respawn
}

#[table] struct Player {
    #[primary_key] identity: Identity,
    name: String,
    trampler_id: Option<u64>,
    local_x: f32, local_y: f32, local_z: f32,   // trampler-frame when aboard
}

#[table] struct MountedGun {
    #[primary_key] id: u64,
    trampler_id: u64, slot: u8,
    gun_type: u8, ammo: u16,
    yaw: f32, pitch: f32,
    manned_by: Option<Identity>,
}

#[table] struct CargoItem {
    #[primary_key] id: u64,
    trampler_id: u64, item_type: u16, qty: u16,
}

#[table] struct LootPoi {
    #[primary_key] id: u64,
    pos_x: f32, pos_z: f32,
    remaining: u16,
}

#[table] struct ExtractionBeacon {
    #[primary_key] id: u64,
    trampler_id: u64,
    ends_at: Timestamp,               // 60s survival window, green smoke visible to all
}
```

Reducers: `join`, `spawn_trampler(frame_id)`, `set_input(throttle, steer)`,
`mount_gun(gun_id)`, `aim_gun(gun_id, yaw, pitch)`, `fire(gun_id)`,
`move_local(x,y,z)`, `loot(poi_id)`, `call_extraction`.
Scheduled reducer `tick` at 20Hz: integrate trampler kinematics, resolve projectile
hits server-side (deterministic ballistic arc from fire event), tick extraction timers.

## Milestones (in order, ship each before starting the next)
1. **M1 — Extract & fix**: prototype → Vite/TS modules, fix knee-flip + reverse-gait bugs.
2. **M2 — Networked driving**: SpacetimeDB module, two browsers see each other's
   tramplers walking. Interpolate remote poses over ~120ms buffer.
3. **M3 — Combat**: server-authoritative projectiles, hull/engine HP, kill = trampler
   collapses (legs go limp — just stop running the gait and lerp body down).
4. **M4 — Loot + extraction**: 4-5 LootPois on the map, cargo table, extraction beacon
   with 60s timer + visible smoke column. This completes the core loop.
5. **M5 — Stakes**: loot persists between runs per Identity; dying loses cargo.

## Constraints
- No trampler editor in v1. 2-3 hardcoded frames (scout / mid / fortress) differing in
  leg count, speed, gun slots, HP.
- No on-foot world combat in v1. Players exist only aboard tramplers (deck movement OK).
- One handcrafted map, the existing `terrainH`. Procedural terrain later.
- Keep total client bundle lean; no physics engine — the analytic heightfield IS the physics.

## Style
Dieselpunk HUD: monospace, amber #e8b04a on near-black, minimal chrome.
