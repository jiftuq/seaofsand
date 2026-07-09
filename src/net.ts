// SpacetimeDB client glue.
//
// Contract (see docs/HANDOFF.md):
// - Server is authoritative over trampler kinematics; it syncs pos/yaw/speed
//   only. Leg IK and gait are NEVER networked — clients derive them locally.
// - Remote trampler poses are interpolated over a ~120ms buffer.
// - Rooms: room + player tables are subscribed globally (they're tiny);
//   tramplers are subscribed per-room so rooms never see each other's traffic.

import { Identity } from 'spacetimedb';
import { DbConnection, type SubscriptionHandle } from './module_bindings';

export interface PoseSnapshot {
  t: number; // local receive time, ms (performance.now())
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
}

export interface RemoteTrampler {
  id: bigint;
  frameId: number;
  color: number;
  gunYaw: number;
  gunPitch: number;
  hpHull: number;
  hpEngine: number;
  buffer: PoseSnapshot[];
}

export interface ProjectileSpawn {
  id: bigint;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
}

export interface PoiInfo {
  id: bigint;
  x: number;
  z: number;
  remaining: number;
}

export interface BeaconInfo {
  id: bigint;
  tramplerId: bigint;
  endsAtMs: number; // unix millis (server clock)
}

export interface RoomInfo {
  id: bigint;
  name: string;
  maxPlayers: number;
  players: number; // online players currently in the room
}

const INTERP_DELAY_MS = 120;
const BUFFER_KEEP_MS = 1000;
const INPUT_SEND_HZ = 15;

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class Net {
  private conn: DbConnection | null = null;
  private identity: Identity | null = null;
  private tramplerSub: SubscriptionHandle | null = null;
  private lastInputSent = 0;
  private lastThrottle = NaN;
  private lastSteer = NaN;

  connected = false;
  roomId = 1n; // room 1 = open desert, where every player starts
  /** Own trampler's latest server state (reconciliation target). */
  ownState: (PoseSnapshot & {
    id: bigint; frameId: number; color: number;
    hpHull: number; hpEngine: number;
  }) | null = null;
  /** Everyone else's tramplers in this room, keyed by id. */
  remotes = new Map<bigint, RemoteTrampler>();
  /** Salvage sites in this room. */
  pois = new Map<bigint, PoiInfo>();
  /** Burning extraction beacons in this room. */
  beacons = new Map<bigint, BeaconInfo>();
  /** Own trampler's salvage total. */
  ownCargo = 0;
  /** Salvage banked to our Identity — survives between runs (M5). */
  ownBanked = 0;

  onStatus?: (text: string) => void;
  /** Fired when the server assigns us a (new) trampler. */
  onOwnSpawn?: (snap: PoseSnapshot, frameId: number, color: number) => void;
  onOwnDespawn?: () => void;
  /** Fired once when our engine hits 0 — the trampler is lost. */
  onOwnDead?: () => void;
  onOwnHp?: (hull: number, engine: number) => void;
  onRemoteGone?: (id: bigint) => void;
  onProjectileSpawn?: (p: ProjectileSpawn) => void;
  onProjectileGone?: (id: bigint) => void;
  onPoiChanged?: (p: PoiInfo) => void;
  onPoiGone?: (id: bigint) => void;
  onCargo?: (qty: number) => void;
  onBanked?: (salvage: number) => void;
  /** Fired when our beacon survives its full window: trampler lifts off. */
  onOwnExtracted?: () => void;
  /** Fired whenever the room list or player counts change. */
  onRoomsChanged?: (rooms: RoomInfo[]) => void;
  /** Fired after our player row lands in a different room. */
  onRoomChanged?: (roomId: bigint) => void;

  connect(uri: string, dbName: string, playerName: string): void {
    try {
      this.connectInner(uri, dbName, playerName);
    } catch (e) {
      this.connected = false;
      this.onStatus?.(`offline (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  private connectInner(uri: string, dbName: string, playerName: string): void {
    const tokenKey = `stdb-token-${dbName}`;
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(dbName)
      .withToken(localStorage.getItem(tokenKey) ?? undefined)
      .onConnect((conn, identity, token) => {
        localStorage.setItem(tokenKey, token);
        this.conn = conn;
        this.identity = identity;
        this.connected = true;
        this.onStatus?.('link up');
        this.registerTableCallbacks(conn);
        conn.subscriptionBuilder()
          .onApplied(() => {
            this.onStatus?.('synced');
            void conn.reducers.join({ name: playerName });
            this.emitRooms();
          })
          .subscribe('SELECT * FROM room');
        conn.subscriptionBuilder().subscribe('SELECT * FROM player');
        conn.subscriptionBuilder().subscribe('SELECT * FROM cargo_item');
        conn.subscriptionBuilder().subscribe('SELECT * FROM vault');
        this.subscribeRoomTramplers();
      })
      .onConnectError((_ctx, err) => {
        this.connected = false;
        this.onStatus?.(`offline (${err.message})`);
      })
      .onDisconnect(() => {
        this.connected = false;
        this.onStatus?.('link lost');
      })
      .build();
  }

  private projectileSub: SubscriptionHandle | null = null;
  private poiSub: SubscriptionHandle | null = null;
  private beaconSub: SubscriptionHandle | null = null;

  private subscribeRoomTramplers(): void {
    if (!this.conn) return;
    this.tramplerSub?.unsubscribe();
    this.projectileSub?.unsubscribe();
    this.poiSub?.unsubscribe();
    this.beaconSub?.unsubscribe();
    // drop everything from the previous room
    for (const id of [...this.remotes.keys()]) {
      this.remotes.delete(id);
      this.onRemoteGone?.(id);
    }
    for (const id of [...this.pois.keys()]) {
      this.pois.delete(id);
      this.onPoiGone?.(id);
    }
    this.beacons.clear();
    this.ownCargo = 0;
    this.onCargo?.(0);
    if (this.ownState) {
      this.ownState = null;
      this.onOwnDespawn?.();
    }
    this.tramplerSub = this.conn.subscriptionBuilder()
      .onApplied(() => {
        for (const row of this.conn!.db.trampler.iter()) this.ingest(row);
      })
      .subscribe(`SELECT * FROM trampler WHERE room_id = ${this.roomId}`);
    this.projectileSub = this.conn.subscriptionBuilder()
      .subscribe(`SELECT * FROM projectile WHERE room_id = ${this.roomId}`);
    this.poiSub = this.conn.subscriptionBuilder()
      .onApplied(() => {
        for (const row of this.conn!.db.loot_poi.iter()) this.ingestPoi(row);
      })
      .subscribe(`SELECT * FROM loot_poi WHERE room_id = ${this.roomId}`);
    this.beaconSub = this.conn.subscriptionBuilder()
      .subscribe(`SELECT * FROM extraction_beacon WHERE room_id = ${this.roomId}`);
  }

  private ingestPoi(row: { id: bigint; posX: number; posZ: number; remaining: number }): void {
    const p: PoiInfo = { id: row.id, x: row.posX, z: row.posZ, remaining: row.remaining };
    this.pois.set(row.id, p);
    this.onPoiChanged?.(p);
  }

  private registerTableCallbacks(conn: DbConnection): void {
    conn.db.trampler.onInsert((_ctx, row) => this.ingest(row));
    conn.db.trampler.onUpdate((_ctx, _old, row) => this.ingest(row));
    conn.db.trampler.onDelete((_ctx, row) => {
      if (this.ownState && row.id === this.ownState.id) {
        // deleted while alive with our beacon at/past its end = we extracted;
        // any other alive deletion is a room switch or respawn replacement
        const extracted = this.ownState.hpEngine > 0
          && [...this.beacons.values()].some(b => b.tramplerId === row.id
            && Date.now() >= b.endsAtMs - 1500);
        this.ownState = null;
        if (extracted) this.onOwnExtracted?.();
        else this.onOwnDespawn?.();
        return;
      }
      if (this.remotes.delete(row.id)) this.onRemoteGone?.(row.id);
    });

    conn.db.projectile.onInsert((_ctx, row) => this.onProjectileSpawn?.({
      id: row.id,
      pos: { x: row.posX, y: row.posY, z: row.posZ },
      vel: { x: row.velX, y: row.velY, z: row.velZ },
    }));
    conn.db.projectile.onDelete((_ctx, row) => this.onProjectileGone?.(row.id));

    conn.db.loot_poi.onInsert((_ctx, row) => this.ingestPoi(row));
    conn.db.loot_poi.onUpdate((_ctx, _old, row) => this.ingestPoi(row));
    conn.db.loot_poi.onDelete((_ctx, row) => {
      if (this.pois.delete(row.id)) this.onPoiGone?.(row.id);
    });

    const beacon = (row: { id: bigint; tramplerId: bigint; endsAt: { toMillis(): bigint } }) =>
      this.beacons.set(row.id, {
        id: row.id,
        tramplerId: row.tramplerId,
        endsAtMs: Number(row.endsAt.toMillis()),
      });
    conn.db.extraction_beacon.onInsert((_ctx, row) => beacon(row));
    conn.db.extraction_beacon.onUpdate((_ctx, _old, row) => beacon(row));
    conn.db.extraction_beacon.onDelete((_ctx, row) => this.beacons.delete(row.id));

    const recount = () => {
      if (!this.conn || !this.ownState) return;
      let total = 0;
      for (const c of this.conn.db.cargo_item.iter()) {
        if (c.tramplerId === this.ownState.id) total += c.qty;
      }
      if (total !== this.ownCargo) {
        this.ownCargo = total;
        this.onCargo?.(total);
      }
    };
    conn.db.cargo_item.onInsert(recount);
    conn.db.cargo_item.onUpdate(recount);
    conn.db.cargo_item.onDelete(recount);

    const vault = (row: { identity: Identity; salvage: number }) => {
      if (this.identity && row.identity.isEqual(this.identity)) {
        this.ownBanked = row.salvage;
        this.onBanked?.(row.salvage);
      }
    };
    conn.db.vault.onInsert((_ctx, row) => vault(row));
    conn.db.vault.onUpdate((_ctx, _old, row) => vault(row));

    const roomsChanged = () => this.emitRooms();
    conn.db.room.onInsert(roomsChanged);
    conn.db.room.onDelete(roomsChanged);
    conn.db.player.onDelete(roomsChanged);
    const onOwnRow = (row: { identity: Identity; roomId: bigint }) => {
      if (this.identity && row.identity.isEqual(this.identity)
          && row.roomId !== this.roomId) {
        this.roomId = row.roomId;
        this.subscribeRoomTramplers();
        this.onRoomChanged?.(row.roomId);
      }
      this.emitRooms();
    };
    conn.db.player.onInsert((_ctx, row) => onOwnRow(row));
    conn.db.player.onUpdate((_ctx, _old, row) => onOwnRow(row));
  }

  private emitRooms(): void {
    if (!this.conn || !this.onRoomsChanged) return;
    const counts = new Map<bigint, number>();
    for (const p of this.conn.db.player.iter()) {
      if (p.online) counts.set(p.roomId, (counts.get(p.roomId) ?? 0) + 1);
    }
    const rooms: RoomInfo[] = [...this.conn.db.room.iter()]
      .map(r => ({
        id: r.id,
        name: r.name,
        maxPlayers: r.maxPlayers,
        players: counts.get(r.id) ?? 0,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    this.onRoomsChanged(rooms);
  }

  private ingest(row: {
    id: bigint; owner: Identity; frameId: number; color: number;
    posX: number; posY: number; posZ: number; yaw: number; speed: number;
    gunYaw: number; gunPitch: number; hpHull: number; hpEngine: number;
  }): void {
    const snap: PoseSnapshot = {
      t: performance.now(),
      x: row.posX, y: row.posY, z: row.posZ,
      yaw: row.yaw, speed: row.speed,
    };
    if (this.identity && row.owner.isEqual(this.identity)) {
      const isNew = this.ownState === null || this.ownState.id !== row.id;
      const wasAlive = isNew || this.ownState!.hpEngine > 0;
      this.ownState = {
        ...snap, id: row.id, frameId: row.frameId, color: row.color,
        hpHull: row.hpHull, hpEngine: row.hpEngine,
      };
      if (isNew) {
        this.ownCargo = 0;
        this.onCargo?.(0);
        this.onOwnSpawn?.(snap, row.frameId, row.color);
      }
      this.onOwnHp?.(row.hpHull, row.hpEngine);
      if (wasAlive && row.hpEngine === 0 && !isNew) this.onOwnDead?.();
      return;
    }
    let r = this.remotes.get(row.id);
    if (!r) {
      r = {
        id: row.id, frameId: row.frameId, color: row.color,
        gunYaw: row.gunYaw, gunPitch: row.gunPitch,
        hpHull: row.hpHull, hpEngine: row.hpEngine, buffer: [],
      };
      this.remotes.set(row.id, r);
    }
    r.gunYaw = row.gunYaw;
    r.gunPitch = row.gunPitch;
    r.hpHull = row.hpHull;
    r.hpEngine = row.hpEngine;
    r.buffer.push(snap);
    const cutoff = snap.t - BUFFER_KEEP_MS;
    while (r.buffer.length > 2 && r.buffer[0].t < cutoff) r.buffer.shift();
  }

  /** Interpolated pose for a remote trampler, ~120ms in the past. */
  samplePose(r: RemoteTrampler, now: number): PoseSnapshot | null {
    const buf = r.buffer;
    if (buf.length === 0) return null;
    const t = now - INTERP_DELAY_MS;
    if (t <= buf[0].t || buf.length === 1) return buf[0];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= t) {
        const a = buf[i], b = buf[i + 1];
        if (!b) return a; // buffer starved: hold last known pose
        const k = (t - a.t) / (b.t - a.t);
        return {
          t,
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          z: a.z + (b.z - a.z) * k,
          yaw: lerpAngle(a.yaw, b.yaw, k),
          speed: a.speed + (b.speed - a.speed) * k,
        };
      }
    }
    return buf[buf.length - 1];
  }

  private lastGunYaw = NaN;
  private lastGunPitch = NaN;

  /** Rate-limited, change-deduplicated input + turret aim send. */
  sendInput(throttle: number, steer: number,
            gunYaw: number, gunPitch: number, now: number): void {
    if (!this.conn || !this.connected || !this.ownState) return;
    if (this.ownState.hpEngine === 0) return; // dead — server rejects anyway
    // drive changes send immediately (responsiveness); aim drift is capped at
    // the send rate; a parked, still turret sends nothing at all
    const driveChanged = throttle !== this.lastThrottle || steer !== this.lastSteer;
    const aimChanged = Math.abs(gunYaw - this.lastGunYaw) > 0.02
      || Math.abs(gunPitch - this.lastGunPitch) > 0.02;
    const due = now - this.lastInputSent > 1000 / INPUT_SEND_HZ;
    if (!driveChanged && !(aimChanged && due)) return;
    this.lastThrottle = throttle;
    this.lastSteer = steer;
    this.lastGunYaw = gunYaw;
    this.lastGunPitch = gunPitch;
    this.lastInputSent = now;
    this.conn.reducers.setInput({ throttle, steer, gunYaw, gunPitch }).catch(() => {});
  }

  fire(gunYaw: number, gunPitch: number): void {
    if (!this.conn || !this.connected) return;
    this.conn.reducers.fire({ gunYaw, gunPitch }).catch(() => {});
  }

  spawn(frameId: number, color: number): Promise<void> {
    if (!this.conn) return Promise.reject(new Error('offline'));
    return this.conn.reducers.spawnTrampler({ frameId, color });
  }

  loot(poiId: bigint): Promise<void> {
    if (!this.conn) return Promise.reject(new Error('offline'));
    return this.conn.reducers.loot({ poiId });
  }

  callExtraction(): Promise<void> {
    if (!this.conn) return Promise.reject(new Error('offline'));
    return this.conn.reducers.callExtraction({});
  }

  createRoom(name: string): Promise<void> {
    if (!this.conn) return Promise.reject(new Error('offline'));
    return this.conn.reducers.createRoom({ name });
  }

  joinRoom(roomId: bigint): Promise<void> {
    if (!this.conn) return Promise.reject(new Error('offline'));
    return this.conn.reducers.joinRoom({ roomId });
  }
}
