//! SEA OF SAND — SpacetimeDB module.
//!
//! Authoritative trampler kinematics on a 20Hz tick. The server integrates
//! throttle/steer inputs into pos/yaw/speed; clients derive gait and leg IK
//! locally (never networked).

use spacetimedb::{reducer, table, Identity, ReducerContext, ScheduleAt, Table, TimeDuration};

const TICK_MS: i64 = 50; // 20Hz
const MAXSPD: f32 = 9.0;
const ACCEL: f32 = 6.0;
const TURN: f32 = 0.7;

/// Analytic dune heightfield. MUST match `terrainH` in src/terrain.ts exactly —
/// this function is the physics on both sides of the wire.
fn terrain_h(x: f32, z: f32) -> f32 {
    (x * 0.018).sin() * (z * 0.022).cos() * 7.0
        + (x * 0.05 + z * 0.03).sin() * 2.4
        + (x * 0.11).sin() * (z * 0.13).sin() * 0.8
}

#[table(accessor = trampler, public)]
pub struct Trampler {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub owner: Identity,
    pub pos_x: f32,
    pub pos_y: f32,
    pub pos_z: f32,
    pub yaw: f32,
    pub speed: f32,
    pub throttle: f32, // last input, integrated server-side
    pub steer: f32,
    pub frame_id: u32, // preset frames only in v1
    pub hp_hull: u16,
    pub hp_engine: u16,
}

#[table(accessor = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    pub name: String,
    pub trampler_id: Option<u64>,
    pub online: bool,
    // trampler-frame position when aboard (M2: unused by the client yet)
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
        ctx.db.player().identity().update(p);
    }
}

#[reducer]
pub fn join(ctx: &ReducerContext, name: String) {
    if let Some(mut p) = ctx.db.player().identity().find(ctx.sender()) {
        p.name = name;
        p.online = true;
        ctx.db.player().identity().update(p);
    } else {
        ctx.db.player().insert(Player {
            identity: ctx.sender(),
            name,
            trampler_id: None,
            online: true,
            local_x: 0.0,
            local_y: 0.0,
            local_z: 0.0,
        });
    }
}

#[reducer]
pub fn spawn_trampler(ctx: &ReducerContext, frame_id: u32) -> Result<(), String> {
    let mut p = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender())
        .ok_or("join first")?;
    if p.trampler_id.is_some() {
        return Err("already own a trampler".into());
    }
    // deterministic-ish scatter so two spawns don't overlap
    let n = ctx.db.trampler().count() as f32;
    let x = (n * 37.0) % 120.0 - 60.0;
    let z = (n * 53.0) % 120.0 - 60.0;
    let t = ctx.db.trampler().insert(Trampler {
        id: 0,
        owner: ctx.sender(),
        pos_x: x,
        pos_y: terrain_h(x, z) + 6.2,
        pos_z: z,
        yaw: 0.0,
        speed: 0.0,
        throttle: 0.0,
        steer: 0.0,
        frame_id,
        hp_hull: 100,
        hp_engine: 100,
    });
    p.trampler_id = Some(t.id);
    ctx.db.player().identity().update(p);
    Ok(())
}

#[reducer]
pub fn set_input(ctx: &ReducerContext, throttle: f32, steer: f32) -> Result<(), String> {
    let p = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender())
        .ok_or("join first")?;
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
        // same integrator as Walker.drive in src/walker.ts
        t.speed += (t.throttle * MAXSPD - t.speed)
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
    Ok(())
}
