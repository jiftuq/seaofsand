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
  buffer: PoseSnapshot[];
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
  ownState: (PoseSnapshot & { id: bigint; frameId: number; color: number }) | null = null;
  /** Everyone else's tramplers in this room, keyed by id. */
  remotes = new Map<bigint, RemoteTrampler>();

  onStatus?: (text: string) => void;
  /** Fired when the server assigns us a (new) trampler. */
  onOwnSpawn?: (snap: PoseSnapshot, frameId: number, color: number) => void;
  onOwnDespawn?: () => void;
  onRemoteGone?: (id: bigint) => void;
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

  private subscribeRoomTramplers(): void {
    if (!this.conn) return;
    this.tramplerSub?.unsubscribe();
    // drop everything from the previous room
    for (const id of [...this.remotes.keys()]) {
      this.remotes.delete(id);
      this.onRemoteGone?.(id);
    }
    if (this.ownState) {
      this.ownState = null;
      this.onOwnDespawn?.();
    }
    this.tramplerSub = this.conn.subscriptionBuilder()
      .onApplied(() => {
        for (const row of this.conn!.db.trampler.iter()) this.ingest(row);
      })
      .subscribe(`SELECT * FROM trampler WHERE room_id = ${this.roomId}`);
  }

  private registerTableCallbacks(conn: DbConnection): void {
    conn.db.trampler.onInsert((_ctx, row) => this.ingest(row));
    conn.db.trampler.onUpdate((_ctx, _old, row) => this.ingest(row));
    conn.db.trampler.onDelete((_ctx, row) => {
      if (this.ownState && row.id === this.ownState.id) {
        this.ownState = null;
        this.onOwnDespawn?.();
        return;
      }
      if (this.remotes.delete(row.id)) this.onRemoteGone?.(row.id);
    });

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
  }): void {
    const snap: PoseSnapshot = {
      t: performance.now(),
      x: row.posX, y: row.posY, z: row.posZ,
      yaw: row.yaw, speed: row.speed,
    };
    if (this.identity && row.owner.isEqual(this.identity)) {
      const isNew = this.ownState === null || this.ownState.id !== row.id;
      this.ownState = { ...snap, id: row.id, frameId: row.frameId, color: row.color };
      if (isNew) this.onOwnSpawn?.(snap, row.frameId, row.color);
      return;
    }
    let r = this.remotes.get(row.id);
    if (!r) {
      r = { id: row.id, frameId: row.frameId, color: row.color, buffer: [] };
      this.remotes.set(row.id, r);
    }
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

  /** Rate-limited, change-deduplicated input send. */
  sendInput(throttle: number, steer: number, now: number): void {
    if (!this.conn || !this.connected || !this.ownState) return;
    const changed = throttle !== this.lastThrottle || steer !== this.lastSteer;
    const due = now - this.lastInputSent > 1000 / INPUT_SEND_HZ;
    if (!changed && !due) return;
    if (!changed && this.lastThrottle === 0 && this.lastSteer === 0) return;
    this.lastThrottle = throttle;
    this.lastSteer = steer;
    this.lastInputSent = now;
    this.conn.reducers.setInput({ throttle, steer }).catch(() => {});
  }

  spawn(frameId: number, color: number): Promise<void> {
    if (!this.conn) return Promise.reject(new Error('offline'));
    return this.conn.reducers.spawnTrampler({ frameId, color });
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
