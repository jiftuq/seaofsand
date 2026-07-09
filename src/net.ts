// M2: SpacetimeDB client glue lands here.
//
// Contract (see TRAMPLER handoff):
// - Server is authoritative over trampler kinematics; it syncs pos/yaw/speed
//   only. Leg IK and gait are NEVER networked — clients derive them locally.
// - Remote trampler poses are interpolated over a ~120ms buffer.
// - Players aboard a trampler sync in trampler-local coordinates (local_pos),
//   never world space, to eliminate moving-platform jitter.

export interface TramplerState {
  id: bigint;
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;
  speed: number;
}

export class Net {
  connect(_uri: string): Promise<void> {
    return Promise.reject(new Error('net: not implemented until M2'));
  }
}
