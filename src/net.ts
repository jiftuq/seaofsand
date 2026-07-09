// SpacetimeDB client glue (M2).
//
// Contract (see docs/HANDOFF.md):
// - Server is authoritative over trampler kinematics; it syncs pos/yaw/speed
//   only. Leg IK and gait are NEVER networked — clients derive them locally.
// - Remote trampler poses are interpolated over a ~120ms buffer.
// - Players aboard a trampler sync in trampler-local coordinates (local_pos),
//   never world space (schema field exists; used from M4 deck movement on).

import { Identity } from 'spacetimedb';
import { DbConnection } from './module_bindings';

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
  buffer: PoseSnapshot[];
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
  private lastInputSent = 0;
  private lastThrottle = NaN;
  private lastSteer = NaN;

  connected = false;
  /** Own trampler's latest server state (reconciliation target). */
  ownState: PoseSnapshot & { id: bigint } | null = null;
  /** Everyone else's tramplers, keyed by id, with interpolation buffers. */
  remotes = new Map<bigint, RemoteTrampler>();

  onStatus?: (text: string) => void;
  /** Fired once when the server first assigns us a trampler (spawn point). */
  onOwnSpawn?: (snap: PoseSnapshot) => void;
  onRemoteGone?: (id: bigint) => void;

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
            conn.reducers.spawnTrampler({ frameId: 0 }).catch(() => {
              /* already own one — fine, we'll pick it up from the table */
            });
            // pick up rows that were already in the cache before callbacks ran
            for (const row of conn.db.trampler.iter()) this.ingest(row);
          })
          .subscribe('SELECT * FROM trampler');
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

  private registerTableCallbacks(conn: DbConnection): void {
    conn.db.trampler.onInsert((_ctx, row) => this.ingest(row));
    conn.db.trampler.onUpdate((_ctx, _old, row) => this.ingest(row));
    conn.db.trampler.onDelete((_ctx, row) => {
      this.remotes.delete(row.id);
      this.onRemoteGone?.(row.id);
    });
  }

  private ingest(row: {
    id: bigint; owner: Identity;
    posX: number; posY: number; posZ: number; yaw: number; speed: number;
  }): void {
    const snap: PoseSnapshot = {
      t: performance.now(),
      x: row.posX, y: row.posY, z: row.posZ,
      yaw: row.yaw, speed: row.speed,
    };
    if (this.identity && row.owner.isEqual(this.identity)) {
      const first = this.ownState === null;
      this.ownState = { ...snap, id: row.id };
      if (first) this.onOwnSpawn?.(snap);
      return;
    }
    let r = this.remotes.get(row.id);
    if (!r) {
      r = { id: row.id, buffer: [] };
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
    if (!this.conn || !this.connected) return;
    const changed = throttle !== this.lastThrottle || steer !== this.lastSteer;
    const due = now - this.lastInputSent > 1000 / INPUT_SEND_HZ;
    if (!changed && !due) return;
    if (!changed && this.lastThrottle === 0 && this.lastSteer === 0) return;
    this.lastThrottle = throttle;
    this.lastSteer = steer;
    this.lastInputSent = now;
    this.conn.reducers.setInput({ throttle, steer }).catch(() => {});
  }
}
