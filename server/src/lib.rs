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
/// max speed drives both server integration and client prediction.
///                            max_spd hull engine
const FRAME_STATS: [(f32, u16, u16); 3] = [
    (12.0, 60, 60),   // 0 scout    "DUNE SKIMMER"
    (9.0, 100, 100),  // 1 mid      "TRAMPLER MK.I"
    (6.0, 180, 160),  // 2 fortress "FORTRESS"
];

fn frame_stats(frame_id: u32) -> (f32, u16, u16) {
    FRAME_STATS[(frame_id as usize).min(FRAME_STATS.len() - 1)]
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
    pub hp_engine: u16,
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
}

fn online_count(ctx: &ReducerContext, room_id: u64) -> u32 {
    ctx.db.player().iter().filter(|p| p.online && p.room_id == room_id).count() as u32
}

fn despawn_trampler(ctx: &ReducerContext, p: &mut Player) {
    if let Some(id) = p.trampler_id.take() {
        ctx.db.trampler().id().delete(&id);
    }
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
        despawn_trampler(ctx, &mut p);
        p.room_id = OPEN_DESERT;
        ctx.db.player().identity().update(p);
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
    despawn_trampler(ctx, &mut p);
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
    despawn_trampler(ctx, &mut p);
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
    despawn_trampler(ctx, &mut p); // respawn = replace
    let (_, hull, engine) = frame_stats(frame_id);
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
    });
    p.trampler_id = Some(t.id);
    ctx.db.player().identity().update(p);
    Ok(())
}

#[reducer]
pub fn set_input(ctx: &ReducerContext, throttle: f32, steer: f32) -> Result<(), String> {
    let p = ctx.db.player().identity().find(ctx.sender()).ok_or("join first")?;
    let id = p.trampler_id.ok_or("no trampler")?;
    let mut t = ctx.db.trampler().id().find(id).ok_or("trampler gone")?;
    t.throttle = throttle.clamp(-0.5, 1.0);
    t.steer = steer.clamp(-1.0, 1.0);
    ctx.db.trampler().id().update(t);
    Ok(())
}

#[reducer]
pub fn tick(ctx: &ReducerContext, _schedule: TickSchedule) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("tick may only be invoked by the scheduler".into());
    }
    let dt = TICK_MS as f32 / 1000.0;
    for mut t in ctx.db.trampler().iter() {
        // parked tramplers settle to exactly zero and stop generating updates
        if t.throttle == 0.0 && t.steer == 0.0 && t.speed.abs() < 0.005 {
            if t.speed != 0.0 {
                t.speed = 0.0;
                ctx.db.trampler().id().update(t);
            }
            continue;
        }
        let (max_spd, _, _) = frame_stats(t.frame_id);
        // same integrator as Walker.drive in src/walker.ts
        t.speed += (t.throttle * max_spd - t.speed)
            * (ACCEL * dt / t.speed.abs().max(1.0)).min(1.0);
        if t.throttle == 0.0 {
            t.speed *= 0.4f32.powf(dt);
        }
        t.yaw += t.steer * TURN * dt * (0.4 + 0.6 * (t.speed.abs() / 3.0).min(1.0));
        t.pos_x += t.yaw.sin() * t.speed * dt;
        t.pos_z += t.yaw.cos() * t.speed * dt;
        // hull rides CLEARANCE above the terrain at its center; the client
        // refines height/pitch/roll cosmetically from foot positions
        t.pos_y = terrain_h(t.pos_x, t.pos_z) + 6.2;
        ctx.db.trampler().id().update(t);
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
            ctx.db.trampler().id().delete(&t.id);
        }
        ctx.db.room().id().delete(&id);
    }
    Ok(())
}
