//! SEA OF SAND — SpacetimeDB module.
//!
//! Authoritative trampler kinematics on a 20Hz tick. The server integrates
//! throttle/steer inputs into pos/yaw/speed; clients derive gait and leg IK
//! locally (never networked).
//!
//! Rooms: every player is always in a room. Room 0 is the "open desert",
//! created at init and never deleted; player-founded rooms are cleaned up
//! once empty. Tramplers belong to a room and clients subscribe to
//! `trampler WHERE room_id = ...` so rooms never see each other's traffic.

use spacetimedb::{reducer, table, Identity, ReducerContext, ScheduleAt, Table, Timestamp,
                  TimeDuration};

const TICK_MS: i64 = 50; // 20Hz
const ACCEL: f32 = 6.0;
const TURN: f32 = 0.7;
const OPEN_DESERT: u64 = 1; // first auto_inc id — init inserts it before anything else
const MAX_PLAYERS_PER_ROOM: u32 = 24;
const EMPTY_ROOM_TTL_MICROS: i64 = 60_000_000; // empty player-rooms live 60s

/// Frame presets (index = frame_id). MUST match FRAMES in src/frames.ts —
/// max speed drives both server integration and client prediction, and
/// scale drives muzzle offsets and hit radii.
///                                 max_spd hull engine scale
const FRAME_STATS: [(f32, u16, u16, f32); 4] = [
    (12.0, 60, 60, 0.75),   // 0 scout    "DUNE SKIMMER"
    (9.0, 100, 100, 1.0),   // 1 mid      "TRAMPLER MK.I"
    (6.0, 180, 160, 1.35),  // 2 fortress "FORTRESS"
    (16.0, 30, 30, 0.6),    // 3 flyer    "ORNITHOPTER"
];
const FRAME_FLYING: [bool; 4] = [false, false, false, true];
const HOVER_HEIGHT: f32 = 12.0; // ornithopter altitude over the dunes

fn frame_stats(frame_id: u32) -> (f32, u16, u16, f32) {
    FRAME_STATS[(frame_id as usize).min(FRAME_STATS.len() - 1)]
}

// ballistics — MUST match combat constants in src/combat.ts
const MUZZLE_VEL: f32 = 70.0;
const GRAVITY: f32 = 22.0;
const PROJECTILE_DMG: u16 = 25;
const PROJECTILE_TTL_MICROS: i64 = 6_000_000;
const FIRE_COOLDOWN_MICROS: i64 = 850_000; // client shows 0.9s; small grace
const WRECK_TTL_MICROS: i64 = 30_000_000;  // dead tramplers linger 30s

// loot + extraction
const POIS_PER_ROOM: u64 = 5;
const LOOT_RANGE: f32 = 20.0;
const LOOT_PER_GRAB: u16 = 5;
const LOOT_COOLDOWN_MICROS: i64 = 700_000;
const EXTRACTION_MICROS: i64 = 60_000_000; // survive 60s under the green smoke

// salvage tiers — MUST match ITEMS in src/frames.ts
// item_type:                 0 scrap  1 alloy  2 relic
const ITEM_VALUES: [u32; 3] = [1, 3, 8];
const POI_AMOUNTS: [u16; 3] = [25, 15, 8]; // site stock per tier
const POI_TYPE_PATTERN: [u16; 5] = [0, 0, 1, 0, 2]; // per-room site mix

// progression + protection
const SPAWN_SHIELD_MICROS: i64 = 8_000_000;
const FORTRESS_COST: u32 = 100;
const THOPTER_COST: u32 = 60;
const REPAIR_COST: u32 = 15;

// sand raiders (on foot)
const RAIDER_SPD: f32 = 4.5;
const RAIDER_ACCEL: f32 = 10.0;
const RAIDER_TURN: f32 = 2.5;
const BOARD_RANGE: f32 = 8.0;
const DISARM_AT_SECS: f32 = 3.0;   // boarding time to sabotage the guns
const HIJACK_AT_SECS: f32 = 8.0;   // boarding time to take the helm
const SABOTAGE_MICROS: i64 = 45_000_000;
const TRAMPLE_FACTOR: f32 = 3.5;   // kill radius = factor * frame scale
const TRAMPLE_MIN_SPEED: f32 = 2.0;

// mounted guns (crew stations) — slots per frame_id
const GUN_SLOTS: [u8; 4] = [0, 1, 2, 0];
const MOUNTED_DMG: u16 = 12;
const MOUNTED_COOLDOWN_MICROS: i64 = 600_000;

/// deck offset of a mounted gun slot at frame scale 1 — MUST match
/// GUN_SLOT_OFFSETS in src/frames.ts
fn gun_slot_offset(slot: u8) -> (f32, f32, f32) {
    match slot {
        0 => (-2.2, 2.6, -0.5),
        _ => (2.2, 2.6, 0.5),
    }
}

/// Analytic dune heightfield. MUST match `terrainH` in src/terrain.ts exactly —
/// this function is the physics on both sides of the wire.
fn terrain_h(x: f32, z: f32) -> f32 {
    (x * 0.018).sin() * (z * 0.022).cos() * 7.0
        + (x * 0.05 + z * 0.03).sin() * 2.4
        + (x * 0.11).sin() * (z * 0.13).sin() * 0.8
}

#[table(accessor = room, public)]
pub struct Room {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub name: String,
    pub host: Identity,
    pub created_at: Timestamp,
    pub max_players: u32,
}

#[table(accessor = trampler, public)]
#[derive(Clone)]
pub struct Trampler {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub owner: Identity,
    #[index(btree)]
    pub room_id: u64,
    pub pos_x: f32,
    pub pos_y: f32,
    pub pos_z: f32,
    pub yaw: f32,
    pub speed: f32,
    pub throttle: f32, // last input, integrated server-side
    pub steer: f32,
    pub frame_id: u32, // preset frames only in v1 (see FRAME_STATS)
    pub color: u32,    // hull tint, 0xRRGGBB
    pub hp_hull: u16,
    pub hp_engine: u16, // 0 = dead: kinematics freeze, wreck reaped later
    pub gun_yaw: f32,   // turret aim relative to hull (remote turret display)
    pub gun_pitch: f32,
    pub last_fire: Timestamp,
    pub last_loot: Timestamp,
    pub died_at: Option<Timestamp>,
    pub protected_until: Timestamp, // spawn shield; firing forfeits it early
    pub guns_disabled_until: Timestamp, // boarding sabotage
}

/// A player on foot. Slow, unarmed, tramplable — but can bury in the sand
/// to hide, and board enemy tramplers to sabotage or steal them.
#[table(accessor = raider, public)]
pub struct Raider {
    #[primary_key]
    pub identity: Identity,
    #[index(btree)]
    pub room_id: u64,
    pub pos_x: f32,
    pub pos_z: f32,
    pub yaw: f32,
    pub speed: f32,
    pub throttle: f32,
    pub steer: f32,
    pub buried: bool,          // hidden and immobile
    pub boarding: Option<u64>, // trampler being boarded (rides its deck)
    pub board_progress: f32,   // seconds aboard
    pub disarm_done: bool,
}

#[table(accessor = loot_poi, public)]
pub struct LootPoi {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub room_id: u64,
    pub pos_x: f32,
    pub pos_z: f32,
    pub item_type: u16, // see ITEM_VALUES
    pub remaining: u16,
}

/// Crew stations. A player mans at most one gun; manning replaces piloting.
#[table(accessor = mounted_gun, public)]
pub struct MountedGun {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub room_id: u64,
    #[index(btree)]
    pub trampler_id: u64,
    pub slot: u8,
    pub yaw: f32,   // aim relative to hull
    pub pitch: f32,
    pub manned_by: Option<Identity>,
    pub last_fire: Timestamp,
}

#[table(accessor = cargo_item, public)]
pub struct CargoItem {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub trampler_id: u64,
    pub item_type: u16, // v1: 0 = salvage
    pub qty: u16,
}

#[table(accessor = extraction_beacon, public)]
pub struct ExtractionBeacon {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub room_id: u64,
    pub trampler_id: u64, // green smoke follows this trampler; survive to extract
    pub ends_at: Timestamp,
}

#[table(accessor = projectile, public)]
pub struct Projectile {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub room_id: u64,
    pub shooter: u64, // trampler id, immune to its own shells
    pub pos_x: f32,
    pub pos_y: f32,
    pub pos_z: f32,
    pub vel_x: f32,
    pub vel_y: f32,
    pub vel_z: f32,
    pub dmg: u16,
    pub spawned: Timestamp,
}

#[table(accessor = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub room_id: u64,
    pub trampler_id: Option<u64>,
    pub online: bool,
    // trampler-frame position when aboard (crew/deck movement, M4+)
    pub local_x: f32,
    pub local_y: f32,
    pub local_z: f32,
}

/// Extracted salvage banks here per Identity and persists between runs.
/// Dying never touches the vault — cargo aboard a wreck is simply lost.
#[table(accessor = vault, public)]
pub struct Vault {
    #[primary_key]
    pub identity: Identity,
    pub salvage: u32, // value units (see ITEM_VALUES), spendable
    pub fortress_unlocked: bool,
    pub thopter_unlocked: bool,
}

fn credit_vault(ctx: &ReducerContext, identity: Identity, amount: u32) {
    if let Some(mut v) = ctx.db.vault().identity().find(identity) {
        v.salvage += amount;
        ctx.db.vault().identity().update(v);
    } else {
        ctx.db.vault().insert(Vault {
            identity, salvage: amount,
            fortress_unlocked: false, thopter_unlocked: false,
        });
    }
}

#[table(accessor = tick_schedule, scheduled(tick))]
pub struct TickSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

#[reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.tick_schedule().insert(TickSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Interval(TimeDuration::from_micros(TICK_MS * 1000)),
    });
    // auto_inc assigns ids from 1; init runs before any other reducer, so
    // this insert always becomes room 1 = OPEN_DESERT
    ctx.db.room().insert(Room {
        id: 0, // auto_inc
        name: "OPEN DESERT".into(),
        host: ctx.database_identity(),
        created_at: ctx.timestamp,
        max_players: MAX_PLAYERS_PER_ROOM,
    });
    seed_pois(ctx, OPEN_DESERT);
}

fn online_count(ctx: &ReducerContext, room_id: u64) -> u32 {
    ctx.db.player().iter().filter(|p| p.online && p.room_id == room_id).count() as u32
}

/// Scatter POIS_PER_ROOM salvage sites deterministically from the room id.
fn seed_pois(ctx: &ReducerContext, room_id: u64) {
    for i in 0..POIS_PER_ROOM {
        let seed = (room_id * 7919 + i * 104_729) as f32;
        let hx = ((seed * 12.9898).sin() * 43_758.547).rem_euclid(1.0);
        let hz = ((seed * 78.233).sin() * 43_758.547).rem_euclid(1.0);
        let item_type = POI_TYPE_PATTERN[(i as usize) % POI_TYPE_PATTERN.len()];
        ctx.db.loot_poi().insert(LootPoi {
            id: 0,
            room_id,
            pos_x: hx * 280.0 - 140.0,
            pos_z: hz * 280.0 - 140.0,
            item_type,
            remaining: POI_AMOUNTS[item_type as usize],
        });
    }
}

/// Total cargo VALUE (qty × tier value) aboard a trampler.
fn cargo_value(ctx: &ReducerContext, trampler_id: u64) -> u32 {
    ctx.db.cargo_item().trampler_id().filter(&trampler_id)
        .map(|c| c.qty as u32 * ITEM_VALUES[(c.item_type as usize).min(ITEM_VALUES.len() - 1)])
        .sum()
}

fn drop_trampler_side_tables(ctx: &ReducerContext, trampler_id: u64) {
    for c in ctx.db.cargo_item().trampler_id().filter(&trampler_id).collect::<Vec<_>>() {
        ctx.db.cargo_item().id().delete(&c.id);
    }
    for b in ctx.db.extraction_beacon().iter().filter(|b| b.trampler_id == trampler_id)
        .collect::<Vec<_>>() {
        ctx.db.extraction_beacon().id().delete(&b.id);
    }
    for g in ctx.db.mounted_gun().trampler_id().filter(&trampler_id).collect::<Vec<_>>() {
        ctx.db.mounted_gun().id().delete(&g.id);
    }
}

/// Release any gun station this identity is manning.
fn release_guns(ctx: &ReducerContext, identity: Identity) {
    for mut g in ctx.db.mounted_gun().iter()
        .filter(|g| g.manned_by == Some(identity)).collect::<Vec<_>>() {
        g.manned_by = None;
        ctx.db.mounted_gun().id().update(g);
    }
}

fn despawn_trampler(ctx: &ReducerContext, p: &mut Player) {
    if let Some(id) = p.trampler_id.take() {
        drop_trampler_side_tables(ctx, id);
        ctx.db.trampler().id().delete(&id);
    }
}

/// Despawn every trampler this identity owns — including hulls left parked
/// in the field after a dismount (trampler_id = None but owner = identity).
fn despawn_owned(ctx: &ReducerContext, identity: Identity) {
    for t in ctx.db.trampler().iter().filter(|t| t.owner == identity).collect::<Vec<_>>() {
        drop_trampler_side_tables(ctx, t.id);
        ctx.db.trampler().id().delete(&t.id);
    }
    if let Some(mut p) = ctx.db.player().identity().find(identity) {
        if p.trampler_id.is_some() {
            p.trampler_id = None;
            ctx.db.player().identity().update(p);
        }
    }
}

fn insert_raider_at(ctx: &ReducerContext, identity: Identity, room_id: u64,
                    x: f32, z: f32, yaw: f32) {
    ctx.db.raider().identity().delete(&identity);
    ctx.db.raider().insert(Raider {
        identity, room_id,
        pos_x: x, pos_z: z, yaw,
        speed: 0.0, throttle: 0.0, steer: 0.0,
        buried: false, boarding: None, board_progress: 0.0, disarm_done: false,
    });
}

#[reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender()) {
        p.online = true;
        ctx.db.player().identity().update(p);
    }
}

#[reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender()) {
        p.online = false;
        release_guns(ctx, ctx.sender());
        ctx.db.raider().identity().delete(&ctx.sender());
        p.trampler_id = None;
        p.room_id = OPEN_DESERT;
        ctx.db.player().identity().update(p);
        despawn_owned(ctx, ctx.sender());
    }
}

#[reducer]
pub fn join(ctx: &ReducerContext, name: String) {
    let name = name.chars().take(24).collect::<String>();
    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender()) {
        p.name = name;
        p.online = true;
        ctx.db.player().identity().update(p);
    } else {
        ctx.db.player().insert(Player {
            identity: ctx.sender(),
            name,
            room_id: OPEN_DESERT,
            trampler_id: None,
            online: true,
            local_x: 0.0,
            local_y: 0.0,
            local_z: 0.0,
        });
    }
}

#[reducer]
pub fn create_room(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let mut p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    let name = name.trim().chars().take(32).collect::<String>();
    if name.is_empty() {
        return Err("room needs a name".into());
    }
    let room = ctx.db.room().insert(Room {
        id: 0, // auto_inc
        name,
        host: ctx.sender(),
        created_at: ctx.timestamp,
        max_players: MAX_PLAYERS_PER_ROOM,
    });
    seed_pois(ctx, room.id);
    release_guns(ctx, ctx.sender());
    ctx.db.raider().identity().delete(&ctx.sender());
    p.trampler_id = None;
    despawn_owned(ctx, ctx.sender());
    let mut p = ctx.db.player().identity().find(ctx.sender()).unwrap();
    p.room_id = room.id;
    ctx.db.player().identity().update(p);
    Ok(())
}

#[reducer]
pub fn join_room(ctx: &ReducerContext, room_id: u64) -> Result<(), String> {
    let mut p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    let room = ctx.db.room().id().find(room_id).ok_or("no such room")?;
    if p.room_id == room_id {
        return Ok(());
    }
    if online_count(ctx, room_id) >= room.max_players {
        return Err("room is full".into());
    }
    release_guns(ctx, ctx.sender());
    ctx.db.raider().identity().delete(&ctx.sender());
    p.trampler_id = None;
    despawn_owned(ctx, ctx.sender());
    let mut p = ctx.db.player().identity().find(ctx.sender()).unwrap();
    p.room_id = room_id;
    ctx.db.player().identity().update(p);
    Ok(())
}

#[reducer]
pub fn spawn_trampler(ctx: &ReducerContext, frame_id: u32, color: u32) -> Result<(), String> {
    let mut p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    if frame_id as usize >= FRAME_STATS.len() {
        return Err("unknown frame".into());
    }
    if frame_id >= 2 {
        let v = ctx.db.vault().identity().find(ctx.sender());
        let unlocked = match frame_id {
            2 => v.map(|v| v.fortress_unlocked).unwrap_or(false),
            _ => v.map(|v| v.thopter_unlocked).unwrap_or(false),
        };
        if !unlocked {
            return Err("frame locked — buy it in the lobby".into());
        }
    }
    release_guns(ctx, ctx.sender());
    ctx.db.raider().identity().delete(&ctx.sender());
    p.trampler_id = None;
    despawn_owned(ctx, ctx.sender()); // respawn = replace, parked hulls included
    let mut p = ctx.db.player().identity().find(ctx.sender()).unwrap();
    let (_, hull, engine, _) = frame_stats(frame_id);
    // deterministic-ish scatter so spawns in a room don't overlap
    let n = ctx.db.trampler().count() as f32 + p.room_id as f32;
    let x = (n * 37.0) % 120.0 - 60.0;
    let z = (n * 53.0) % 120.0 - 60.0;
    let t = ctx.db.trampler().insert(Trampler {
        id: 0,
        owner: ctx.sender(),
        room_id: p.room_id,
        pos_x: x,
        pos_y: terrain_h(x, z) + 6.2,
        pos_z: z,
        yaw: 0.0,
        speed: 0.0,
        throttle: 0.0,
        steer: 0.0,
        frame_id,
        color: color & 0xff_ff_ff,
        hp_hull: hull,
        hp_engine: engine,
        gun_yaw: 0.0,
        gun_pitch: 0.0,
        last_fire: Timestamp::UNIX_EPOCH,
        last_loot: Timestamp::UNIX_EPOCH,
        died_at: None,
        protected_until: ctx.timestamp + TimeDuration::from_micros(SPAWN_SHIELD_MICROS),
        guns_disabled_until: Timestamp::UNIX_EPOCH,
    });
    for slot in 0..GUN_SLOTS[frame_id as usize] {
        ctx.db.mounted_gun().insert(MountedGun {
            id: 0,
            room_id: p.room_id,
            trampler_id: t.id,
            slot,
            yaw: 0.0,
            pitch: 0.0,
            manned_by: None,
            last_fire: Timestamp::UNIX_EPOCH,
        });
    }
    p.trampler_id = Some(t.id);
    ctx.db.player().identity().update(p);
    Ok(())
}

#[reducer]
pub fn set_input(ctx: &ReducerContext, throttle: f32, steer: f32,
                 gun_yaw: f32, gun_pitch: f32) -> Result<(), String> {
    let p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    let Some(id) = p.trampler_id else {
        // on foot: same input stream drives the raider
        let mut r = ctx.db.raider().identity().find(ctx.sender()).ok_or("no trampler")?;
        r.throttle = throttle.clamp(-0.5, 1.0);
        r.steer = steer.clamp(-1.0, 1.0);
        ctx.db.raider().identity().update(r);
        return Ok(());
    };
    let mut t = ctx.db.trampler().id().find(id).ok_or("trampler gone")?;
    if t.hp_engine == 0 {
        return Err("trampler is dead".into());
    }
    t.throttle = throttle.clamp(-0.5, 1.0);
    t.steer = steer.clamp(-1.0, 1.0);
    t.gun_yaw = gun_yaw.clamp(-2.0, 2.0);
    t.gun_pitch = gun_pitch.clamp(-0.6, 0.4);
    ctx.db.trampler().id().update(t);
    Ok(())
}

#[reducer]
pub fn fire(ctx: &ReducerContext, gun_yaw: f32, gun_pitch: f32) -> Result<(), String> {
    let p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    let id = p.trampler_id.ok_or("no trampler")?;
    let mut t = ctx.db.trampler().id().find(id).ok_or("trampler gone")?;
    if t.hp_engine == 0 {
        return Err("trampler is dead".into());
    }
    if ctx.timestamp < t.guns_disabled_until {
        return Err("weapons sabotaged".into());
    }
    let elapsed = ctx.timestamp.duration_since(t.last_fire)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(i64::MAX);
    if elapsed < FIRE_COOLDOWN_MICROS {
        return Err("cooldown".into());
    }
    let gy = gun_yaw.clamp(-2.0, 2.0);
    let gp = gun_pitch.clamp(-0.6, 0.4);
    let (_, _, _, s) = frame_stats(t.frame_id);

    // muzzle position + barrel direction; mirrors the client turret hierarchy:
    // turret base local (0, 2.2s, 2.8s) on the hull, pitch pivot +0.5s up,
    // barrel reach 4.4s. positive pitch points down (three.js rotation.x).
    let wy = t.yaw + gy; // barrel yaw in world
    let (dir_x, dir_y, dir_z) = (wy.sin() * gp.cos(), -gp.sin(), wy.cos() * gp.cos());
    let bx = t.pos_x + t.yaw.sin() * 2.8 * s;
    let by = t.pos_y + 2.7 * s;
    let bz = t.pos_z + t.yaw.cos() * 2.8 * s;

    ctx.db.projectile().insert(Projectile {
        id: 0,
        room_id: t.room_id,
        shooter: t.id,
        pos_x: bx + dir_x * 4.4 * s,
        pos_y: by + dir_y * 4.4 * s,
        pos_z: bz + dir_z * 4.4 * s,
        vel_x: dir_x * MUZZLE_VEL,
        vel_y: dir_y * MUZZLE_VEL,
        vel_z: dir_z * MUZZLE_VEL,
        dmg: PROJECTILE_DMG,
        spawned: ctx.timestamp,
    });
    t.gun_yaw = gy;
    t.gun_pitch = gp;
    t.last_fire = ctx.timestamp;
    t.protected_until = ctx.timestamp; // opening fire forfeits the spawn shield
    ctx.db.trampler().id().update(t);
    Ok(())
}

#[reducer]
pub fn loot(ctx: &ReducerContext, poi_id: u64) -> Result<(), String> {
    let p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    let id = p.trampler_id.ok_or("no trampler")?;
    let mut t = ctx.db.trampler().id().find(id).ok_or("trampler gone")?;
    if t.hp_engine == 0 {
        return Err("trampler is dead".into());
    }
    let elapsed = ctx.timestamp.duration_since(t.last_loot)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(i64::MAX);
    if elapsed < LOOT_COOLDOWN_MICROS {
        return Err("cooldown".into());
    }
    let mut poi = ctx.db.loot_poi().id().find(poi_id).ok_or("no such site")?;
    if poi.room_id != t.room_id {
        return Err("wrong room".into());
    }
    let dx = poi.pos_x - t.pos_x;
    let dz = poi.pos_z - t.pos_z;
    if dx * dx + dz * dz > LOOT_RANGE * LOOT_RANGE {
        return Err("out of range".into());
    }
    let take = LOOT_PER_GRAB.min(poi.remaining);
    if take == 0 {
        return Err("stripped clean".into());
    }

    // one stack per salvage tier per trampler
    if let Some(mut stack) = ctx.db.cargo_item().trampler_id().filter(&id)
        .find(|c| c.item_type == poi.item_type) {
        stack.qty += take;
        ctx.db.cargo_item().id().update(stack);
    } else {
        ctx.db.cargo_item().insert(CargoItem {
            id: 0, trampler_id: id, item_type: poi.item_type, qty: take,
        });
    }

    poi.remaining -= take;
    if poi.remaining == 0 {
        ctx.db.loot_poi().id().delete(&poi.id);
    } else {
        ctx.db.loot_poi().id().update(poi);
    }
    t.last_loot = ctx.timestamp;
    ctx.db.trampler().id().update(t);
    Ok(())
}

#[reducer]
pub fn spawn_raider(ctx: &ReducerContext) -> Result<(), String> {
    let p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    let _ = p;
    release_guns(ctx, ctx.sender());
    despawn_owned(ctx, ctx.sender());
    let p = ctx.db.player().identity().find(ctx.sender()).unwrap();
    ctx.db.raider().identity().delete(&ctx.sender());
    let n = ctx.db.raider().count() as f32 + p.room_id as f32 * 3.0;
    let x = (n * 41.0) % 100.0 - 50.0;
    let z = (n * 59.0) % 100.0 - 50.0;
    ctx.db.raider().insert(Raider {
        identity: ctx.sender(),
        room_id: p.room_id,
        pos_x: x,
        pos_z: z,
        yaw: 0.0,
        speed: 0.0,
        throttle: 0.0,
        steer: 0.0,
        buried: false,
        boarding: None,
        board_progress: 0.0,
        disarm_done: false,
    });
    Ok(())
}

#[reducer]
pub fn toggle_bury(ctx: &ReducerContext) -> Result<(), String> {
    let mut r = ctx.db.raider().identity().find(ctx.sender()).ok_or("not on foot")?;
    if r.boarding.is_some() {
        return Err("you're on a deck".into());
    }
    r.buried = !r.buried;
    r.speed = 0.0;
    r.throttle = 0.0;
    ctx.db.raider().identity().update(r);
    Ok(())
}

#[reducer]
pub fn board(ctx: &ReducerContext) -> Result<(), String> {
    let mut r = ctx.db.raider().identity().find(ctx.sender()).ok_or("not on foot")?;
    if r.boarding.is_some() {
        return Err("already aboard".into());
    }
    // our own parked hull within reach? climb back to the helm
    let own = ctx.db.trampler().room_id().filter(&r.room_id)
        .filter(|t| t.owner == ctx.sender() && t.hp_engine > 0)
        .find(|t| {
            (t.pos_x - r.pos_x).powi(2) + (t.pos_z - r.pos_z).powi(2)
                <= BOARD_RANGE * BOARD_RANGE
        });
    if let Some(t) = own {
        ctx.db.raider().identity().delete(&ctx.sender());
        let mut p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
        p.trampler_id = Some(t.id);
        ctx.db.player().identity().update(p);
        return Ok(());
    }
    let target = ctx.db.trampler().room_id().filter(&r.room_id)
        .filter(|t| t.hp_engine > 0
            && t.owner != ctx.sender()
            && !FRAME_FLYING[(t.frame_id as usize).min(FRAME_FLYING.len() - 1)])
        .map(|t| {
            let d2 = (t.pos_x - r.pos_x).powi(2) + (t.pos_z - r.pos_z).powi(2);
            (t.id, d2)
        })
        .filter(|(_, d2)| *d2 <= BOARD_RANGE * BOARD_RANGE)
        .min_by(|a, b| a.1.total_cmp(&b.1));
    let (tid, _) = target.ok_or("no trampler in reach")?;
    r.boarding = Some(tid);
    r.board_progress = 0.0;
    r.disarm_done = false;
    r.buried = false;
    r.speed = 0.0;
    ctx.db.raider().identity().update(r);
    Ok(())
}

#[reducer]
pub fn repel(ctx: &ReducerContext) -> Result<(), String> {
    let p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    let id = p.trampler_id.ok_or("no trampler")?;
    let t = ctx.db.trampler().id().find(id).ok_or("trampler gone")?;
    let mut thrown = 0;
    for mut r in ctx.db.raider().room_id().filter(&t.room_id)
        .filter(|r| r.boarding == Some(id)).collect::<Vec<_>>() {
        r.boarding = None;
        r.board_progress = 0.0;
        // dumped off the stern
        r.pos_x = t.pos_x - t.yaw.sin() * 10.0;
        r.pos_z = t.pos_z - t.yaw.cos() * 10.0;
        ctx.db.raider().identity().update(r);
        thrown += 1;
    }
    if thrown == 0 {
        return Err("deck is clear".into());
    }
    Ok(())
}

#[reducer]
pub fn buy_thopter(ctx: &ReducerContext) -> Result<(), String> {
    let mut v = ctx.db.vault().identity().find(ctx.sender())
        .ok_or("nothing banked yet")?;
    if v.thopter_unlocked {
        return Err("already unlocked".into());
    }
    if v.salvage < THOPTER_COST {
        return Err("not enough banked salvage".into());
    }
    v.salvage -= THOPTER_COST;
    v.thopter_unlocked = true;
    ctx.db.vault().identity().update(v);
    Ok(())
}

#[reducer]
pub fn buy_fortress(ctx: &ReducerContext) -> Result<(), String> {
    let mut v = ctx.db.vault().identity().find(ctx.sender())
        .ok_or("nothing banked yet")?;
    if v.fortress_unlocked {
        return Err("already unlocked".into());
    }
    if v.salvage < FORTRESS_COST {
        return Err("not enough banked salvage".into());
    }
    v.salvage -= FORTRESS_COST;
    v.fortress_unlocked = true;
    ctx.db.vault().identity().update(v);
    Ok(())
}

#[reducer]
pub fn field_repair(ctx: &ReducerContext) -> Result<(), String> {
    let p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    let id = p.trampler_id.ok_or("no trampler")?;
    let mut t = ctx.db.trampler().id().find(id).ok_or("trampler gone")?;
    if t.hp_engine == 0 {
        return Err("trampler is dead".into());
    }
    let (_, hull_max, _, _) = frame_stats(t.frame_id);
    if t.hp_hull >= hull_max {
        return Err("hull already sound".into());
    }
    let mut v = ctx.db.vault().identity().find(ctx.sender())
        .ok_or("nothing banked yet")?;
    if v.salvage < REPAIR_COST {
        return Err("not enough banked salvage".into());
    }
    v.salvage -= REPAIR_COST;
    ctx.db.vault().identity().update(v);
    t.hp_hull = hull_max;
    ctx.db.trampler().id().update(t);
    Ok(())
}

#[reducer]
pub fn mount_gun(ctx: &ReducerContext) -> Result<(), String> {
    let mut p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    // from on foot only stations within arm's reach count; from the lobby,
    // any free station in the room
    let near = ctx.db.raider().identity().find(ctx.sender())
        .map(|r| (r.pos_x, r.pos_z));
    let gun = ctx.db.mounted_gun().room_id().filter(&p.room_id)
        .filter(|g| g.manned_by.is_none())
        .find(|g| {
            ctx.db.trampler().id().find(g.trampler_id)
                .map(|t| t.hp_engine > 0 && t.owner != ctx.sender()
                    && near.map(|(rx, rz)| {
                        (t.pos_x - rx).powi(2) + (t.pos_z - rz).powi(2)
                            <= BOARD_RANGE * BOARD_RANGE
                    }).unwrap_or(true))
                .unwrap_or(false)
        });
    let mut gun = gun.ok_or("no free gun stations in this room")?;
    release_guns(ctx, ctx.sender());
    ctx.db.raider().identity().delete(&ctx.sender());
    despawn_trampler(ctx, &mut p); // crewing replaces piloting
    ctx.db.player().identity().update(p);
    gun.manned_by = Some(ctx.sender());
    ctx.db.mounted_gun().id().update(gun);
    Ok(())
}

#[reducer]
pub fn dismount(ctx: &ReducerContext) -> Result<(), String> {
    let mut p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    // gunner: step off the host trampler
    if let Some(g) = ctx.db.mounted_gun().iter()
        .find(|g| g.manned_by == Some(ctx.sender())) {
        let host = ctx.db.trampler().id().find(g.trampler_id).ok_or("host gone")?;
        release_guns(ctx, ctx.sender());
        insert_raider_at(ctx, ctx.sender(), host.room_id,
            host.pos_x - host.yaw.sin() * 8.0,
            host.pos_z - host.yaw.cos() * 8.0,
            host.yaw);
        return Ok(());
    }
    // pilot: park the hull where it stands and hop off
    let id = p.trampler_id.ok_or("nothing to dismount")?;
    let mut t = ctx.db.trampler().id().find(id).ok_or("trampler gone")?;
    if t.hp_engine == 0 {
        return Err("trampler is dead".into());
    }
    t.throttle = 0.0;
    t.steer = 0.0;
    let (x, z, yaw, room) = (t.pos_x, t.pos_z, t.yaw, t.room_id);
    ctx.db.trampler().id().update(t);
    p.trampler_id = None;
    ctx.db.player().identity().update(p);
    insert_raider_at(ctx, ctx.sender(), room,
        x - yaw.sin() * 8.0, z - yaw.cos() * 8.0, yaw);
    Ok(())
}

#[reducer]
pub fn aim_gun(ctx: &ReducerContext, yaw: f32, pitch: f32) -> Result<(), String> {
    let mut g = ctx.db.mounted_gun().iter()
        .find(|g| g.manned_by == Some(ctx.sender()))
        .ok_or("not manning a gun")?;
    g.yaw = yaw.clamp(-3.2, 3.2);
    g.pitch = pitch.clamp(-0.6, 0.4);
    ctx.db.mounted_gun().id().update(g);
    Ok(())
}

#[reducer]
pub fn fire_gun(ctx: &ReducerContext, yaw: f32, pitch: f32) -> Result<(), String> {
    let mut g = ctx.db.mounted_gun().iter()
        .find(|g| g.manned_by == Some(ctx.sender()))
        .ok_or("not manning a gun")?;
    let mut t = ctx.db.trampler().id().find(g.trampler_id).ok_or("host gone")?;
    if t.hp_engine == 0 {
        return Err("host trampler is dead".into());
    }
    if ctx.timestamp < t.guns_disabled_until {
        return Err("weapons sabotaged".into());
    }
    let elapsed = ctx.timestamp.duration_since(g.last_fire)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(i64::MAX);
    if elapsed < MOUNTED_COOLDOWN_MICROS {
        return Err("cooldown".into());
    }
    let gy = yaw.clamp(-3.2, 3.2);
    let gp = pitch.clamp(-0.6, 0.4);
    let (_, _, _, s) = frame_stats(t.frame_id);
    let (ox, oy, oz) = gun_slot_offset(g.slot);

    let wy = t.yaw + gy;
    let (dir_x, dir_y, dir_z) = (wy.sin() * gp.cos(), -gp.sin(), wy.cos() * gp.cos());
    // station base: hull center + yaw-rotated deck offset; barrel reach 3.0s
    let bx = t.pos_x + (t.yaw.sin() * oz + t.yaw.cos() * ox) * s;
    let by = t.pos_y + (oy + 0.4) * s;
    let bz = t.pos_z + (t.yaw.cos() * oz - t.yaw.sin() * ox) * s;

    ctx.db.projectile().insert(Projectile {
        id: 0,
        room_id: t.room_id,
        shooter: t.id,
        pos_x: bx + dir_x * 3.0 * s,
        pos_y: by + dir_y * 3.0 * s,
        pos_z: bz + dir_z * 3.0 * s,
        vel_x: dir_x * MUZZLE_VEL,
        vel_y: dir_y * MUZZLE_VEL,
        vel_z: dir_z * MUZZLE_VEL,
        dmg: MOUNTED_DMG,
        spawned: ctx.timestamp,
    });
    g.yaw = gy;
    g.pitch = gp;
    g.last_fire = ctx.timestamp;
    ctx.db.mounted_gun().id().update(g);
    // crew fire also forfeits the host's spawn shield
    t.protected_until = ctx.timestamp;
    ctx.db.trampler().id().update(t);
    Ok(())
}

#[reducer]
pub fn call_extraction(ctx: &ReducerContext) -> Result<(), String> {
    let p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    let id = p.trampler_id.ok_or("no trampler")?;
    let t = ctx.db.trampler().id().find(id).ok_or("trampler gone")?;
    if t.hp_engine == 0 {
        return Err("trampler is dead".into());
    }
    if ctx.db.extraction_beacon().iter().any(|b| b.trampler_id == id) {
        return Err("beacon already burning".into());
    }
    ctx.db.extraction_beacon().insert(ExtractionBeacon {
        id: 0,
        room_id: t.room_id,
        trampler_id: id,
        ends_at: ctx.timestamp + TimeDuration::from_micros(EXTRACTION_MICROS),
    });
    Ok(())
}

#[reducer]
pub fn tick(ctx: &ReducerContext, _schedule: TickSchedule) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("tick may only be invoked by the scheduler".into());
    }
    let dt = TICK_MS as f32 / 1000.0;
    for mut t in ctx.db.trampler().iter() {
        // dead tramplers are frozen wrecks; reap them after a while
        if t.hp_engine == 0 {
            let expired = t.died_at
                .and_then(|d| ctx.timestamp.duration_since(d))
                .map(|d| d.as_micros() as i64 > WRECK_TTL_MICROS)
                .unwrap_or(true);
            if expired {
                if let Some(mut p) = ctx.db.player().identity().find(t.owner) {
                    if p.trampler_id == Some(t.id) {
                        p.trampler_id = None;
                        ctx.db.player().identity().update(p);
                    }
                }
                ctx.db.trampler().id().delete(&t.id);
            }
            continue;
        }
        // parked tramplers settle to exactly zero and stop generating updates
        if t.throttle == 0.0 && t.steer == 0.0 && t.speed.abs() < 0.005 {
            if t.speed != 0.0 {
                t.speed = 0.0;
                ctx.db.trampler().id().update(t);
            }
            continue;
        }
        let (max_spd, _, _, _) = frame_stats(t.frame_id);
        // same integrator as Walker.drive in src/walker.ts
        t.speed += (t.throttle * max_spd - t.speed)
            * (ACCEL * dt / t.speed.abs().max(1.0)).min(1.0);
        if t.throttle == 0.0 {
            t.speed *= 0.4f32.powf(dt);
        }
        t.yaw += t.steer * TURN * dt * (0.4 + 0.6 * (t.speed.abs() / 3.0).min(1.0));
        t.pos_x += t.yaw.sin() * t.speed * dt;
        t.pos_z += t.yaw.cos() * t.speed * dt;
        // hull rides CLEARANCE above the terrain (or hovers, if flying); the
        // client refines height/pitch/roll cosmetically
        let flying = FRAME_FLYING[(t.frame_id as usize).min(FRAME_FLYING.len() - 1)];
        t.pos_y = terrain_h(t.pos_x, t.pos_z) + if flying { HOVER_HEIGHT } else { 6.2 };
        ctx.db.trampler().id().update(t);
    }

    // raiders: on-foot movement, boarding progress, trampling
    for mut r in ctx.db.raider().iter() {
        if let Some(tid) = r.boarding {
            // riding an enemy deck: progress toward sabotage, then the helm
            let Some(mut t) = ctx.db.trampler().id().find(tid) else {
                r.boarding = None;
                r.board_progress = 0.0;
                ctx.db.raider().identity().update(r);
                continue;
            };
            if t.hp_engine == 0 {
                r.boarding = None;
                r.board_progress = 0.0;
                r.pos_x = t.pos_x;
                r.pos_z = t.pos_z;
                ctx.db.raider().identity().update(r);
                continue;
            }
            r.board_progress += dt;
            if !r.disarm_done && r.board_progress >= DISARM_AT_SECS {
                r.disarm_done = true;
                t.guns_disabled_until =
                    ctx.timestamp + TimeDuration::from_micros(SABOTAGE_MICROS);
                ctx.db.trampler().id().update(t.clone());
            }
            if r.board_progress >= HIJACK_AT_SECS {
                // the helm changes hands: boarder pilots, old owner hits the sand
                let old_owner = t.owner;
                let boarder = r.identity;
                ctx.db.raider().identity().delete(&boarder);
                // a boarder can't own two hulls: scuttle any they left parked
                for old in ctx.db.trampler().iter()
                    .filter(|o| o.owner == boarder).collect::<Vec<_>>() {
                    drop_trampler_side_tables(ctx, old.id);
                    ctx.db.trampler().id().delete(&old.id);
                }
                if let Some(mut bp) = ctx.db.player().identity().find(boarder) {
                    bp.trampler_id = Some(t.id);
                    ctx.db.player().identity().update(bp);
                }
                t.owner = boarder;
                t.throttle = 0.0;
                t.steer = 0.0;
                let (tx, tz, tyaw) = (t.pos_x, t.pos_z, t.yaw);
                let room = t.room_id;
                ctx.db.trampler().id().update(t);
                if let Some(mut op) = ctx.db.player().identity().find(old_owner) {
                    op.trampler_id = None;
                    let online = op.online;
                    ctx.db.player().identity().update(op);
                    if online {
                        ctx.db.raider().identity().delete(&old_owner);
                        ctx.db.raider().insert(Raider {
                            identity: old_owner,
                            room_id: room,
                            pos_x: tx - tyaw.sin() * 8.0,
                            pos_z: tz - tyaw.cos() * 8.0,
                            yaw: tyaw,
                            speed: 0.0,
                            throttle: 0.0,
                            steer: 0.0,
                            buried: false,
                            boarding: None,
                            board_progress: 0.0,
                            disarm_done: false,
                        });
                    }
                }
                continue;
            }
            ctx.db.raider().identity().update(r);
            continue;
        }
        if r.buried {
            continue;
        }
        // same shape of integrator as tramplers, on foot
        if r.throttle == 0.0 && r.steer == 0.0 && r.speed.abs() < 0.005 {
            if r.speed != 0.0 {
                r.speed = 0.0;
                ctx.db.raider().identity().update(r);
            }
            continue;
        }
        r.speed += (r.throttle * RAIDER_SPD - r.speed)
            * (RAIDER_ACCEL * dt / r.speed.abs().max(1.0)).min(1.0);
        if r.throttle == 0.0 {
            r.speed *= 0.2f32.powf(dt);
        }
        r.yaw += r.steer * RAIDER_TURN * dt;
        r.pos_x += r.yaw.sin() * r.speed * dt;
        r.pos_z += r.yaw.cos() * r.speed * dt;
        ctx.db.raider().identity().update(r);
    }

    // trampling: a moving trampler crushes raiders underfoot (buried or not)
    for t in ctx.db.trampler().iter() {
        if t.hp_engine == 0 || t.speed.abs() < TRAMPLE_MIN_SPEED
            || FRAME_FLYING[(t.frame_id as usize).min(FRAME_FLYING.len() - 1)] {
            continue;
        }
        let (_, _, _, s) = frame_stats(t.frame_id);
        let r2 = (TRAMPLE_FACTOR * s) * (TRAMPLE_FACTOR * s);
        for r in ctx.db.raider().room_id().filter(&t.room_id)
            .filter(|r| r.boarding.is_none()).collect::<Vec<_>>() {
            let d2 = (r.pos_x - t.pos_x).powi(2) + (r.pos_z - t.pos_z).powi(2);
            if d2 < r2 {
                ctx.db.raider().identity().delete(&r.identity);
            }
        }
    }

    // integrate projectiles: ballistic arc, terrain + trampler hits, TTL
    for mut pr in ctx.db.projectile().iter() {
        pr.vel_y -= GRAVITY * dt;
        pr.pos_x += pr.vel_x * dt;
        pr.pos_y += pr.vel_y * dt;
        pr.pos_z += pr.vel_z * dt;

        let expired = ctx.timestamp.duration_since(pr.spawned)
            .map(|d| d.as_micros() as i64 > PROJECTILE_TTL_MICROS)
            .unwrap_or(true);
        let mut hit = expired || pr.pos_y <= terrain_h(pr.pos_x, pr.pos_z);

        if !hit {
            for mut t in ctx.db.trampler().room_id().filter(&pr.room_id) {
                if t.id == pr.shooter || t.hp_engine == 0
                    || ctx.timestamp < t.protected_until {
                    continue;
                }
                let (_, _, _, s) = frame_stats(t.frame_id);
                let dx = pr.pos_x - t.pos_x;
                let dy = pr.pos_y - (t.pos_y + 1.0 * s);
                let dz = pr.pos_z - t.pos_z;
                if dx * dx + dy * dy + dz * dz < (4.2 * s) * (4.2 * s) {
                    hit = true;
                    // hull soaks damage first, then the engine; engine 0 = dead
                    let dmg = pr.dmg;
                    if t.hp_hull >= dmg {
                        t.hp_hull -= dmg;
                    } else {
                        let spill = dmg - t.hp_hull;
                        t.hp_hull = 0;
                        t.hp_engine = t.hp_engine.saturating_sub(spill);
                        if t.hp_engine == 0 {
                            t.died_at = Some(ctx.timestamp);
                            t.throttle = 0.0;
                            t.steer = 0.0;
                            t.speed = 0.0;
                            // the kill drops the victim's cargo VALUE as a
                            // scrap site at the wreck; beacon burns out
                            let dropped = cargo_value(ctx, t.id).min(u16::MAX as u32) as u16;
                            drop_trampler_side_tables(ctx, t.id);
                            if dropped > 0 {
                                ctx.db.loot_poi().insert(LootPoi {
                                    id: 0,
                                    room_id: t.room_id,
                                    pos_x: t.pos_x,
                                    pos_z: t.pos_z,
                                    item_type: 0,
                                    remaining: dropped,
                                });
                            }
                        }
                    }
                    ctx.db.trampler().id().update(t);
                    break;
                }
            }
        }

        if hit {
            ctx.db.projectile().id().delete(&pr.id);
        } else {
            ctx.db.projectile().id().update(pr);
        }
    }

    // extraction beacons: orphaned ones burn out; surviving to ends_at wins —
    // the trampler and its cargo lift off (cargo banking lands with M5)
    for b in ctx.db.extraction_beacon().iter().collect::<Vec<_>>() {
        let Some(t) = ctx.db.trampler().id().find(b.trampler_id) else {
            ctx.db.extraction_beacon().id().delete(&b.id);
            continue;
        };
        if t.hp_engine == 0 {
            ctx.db.extraction_beacon().id().delete(&b.id);
            continue;
        }
        if ctx.timestamp >= b.ends_at {
            // bank the cargo value to the owner's vault (persists between runs)
            let loot = cargo_value(ctx, t.id);
            if loot > 0 {
                credit_vault(ctx, t.owner, loot);
            }
            if let Some(mut p) = ctx.db.player().identity().find(t.owner) {
                if p.trampler_id == Some(t.id) {
                    p.trampler_id = None;
                    ctx.db.player().identity().update(p);
                }
            }
            drop_trampler_side_tables(ctx, t.id);
            ctx.db.trampler().id().delete(&t.id);
        }
    }

    // reap player-founded rooms that have been empty for a minute
    let now = ctx.timestamp;
    let doomed: Vec<u64> = ctx.db.room().iter()
        .filter(|r| r.id != OPEN_DESERT
            && online_count(ctx, r.id) == 0
            && now.duration_since(r.created_at)
                .map(|d| d.as_micros() as i64 > EMPTY_ROOM_TTL_MICROS)
                .unwrap_or(false))
        .map(|r| r.id)
        .collect();
    for id in doomed {
        for t in ctx.db.trampler().room_id().filter(&id).collect::<Vec<_>>() {
            drop_trampler_side_tables(ctx, t.id);
            ctx.db.trampler().id().delete(&t.id);
        }
        for pr in ctx.db.projectile().room_id().filter(&id).collect::<Vec<_>>() {
            ctx.db.projectile().id().delete(&pr.id);
        }
        for poi in ctx.db.loot_poi().room_id().filter(&id).collect::<Vec<_>>() {
            ctx.db.loot_poi().id().delete(&poi.id);
        }
        for r in ctx.db.raider().room_id().filter(&id).collect::<Vec<_>>() {
            ctx.db.raider().identity().delete(&r.identity);
        }
        ctx.db.room().id().delete(&id);
    }
    Ok(())
}
