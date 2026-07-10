// Shared map definition: playable bounds, oases, rock-formation colliders.
//
// CONTRACT: everything here that affects movement (MAP_R, OASES, cluster
// generation, collision resolve) is mirrored in server/src/lib.rs and MUST
// stay bit-compatible. Cluster placement uses a mulberry32 PRNG over u32
// arithmetic and f64 math with no sqrt so both languages produce the exact
// same layout. Rendering-only detail (rock shapes) may use anything.

export const MAP_R = 1100;          // hard edge of the charted wastes
export const HULL_R = 4.5;          // trampler collision radius

export interface Oasis { x: number; z: number; r: number }
export const OASES: Oasis[] = [
  { x: 250, z: -180, r: 45 },
  { x: -380, z: 320, r: 55 },
  { x: 620, z: 480, r: 40 },
  { x: -520, z: -610, r: 50 },
];

export interface RockCluster { x: number; z: number; r: number }

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Phase-1 generation: cluster centers + collision radii only (mirrored in
// Rust). Rejection sampling — every attempt consumes exactly 3 randoms, and
// all accept/reject math is f64 with squared distances so both sides take
// identical branches.
export function genClusters(): RockCluster[] {
  const rand = mulberry32(1337);
  const out: RockCluster[] = [];
  let attempts = 0;
  while (out.length < 42 && attempts < 500) {
    attempts++;
    const x = (rand() * 2 - 1) * 1000;
    const z = (rand() * 2 - 1) * 1000;
    const r = 10 + rand() * 18;
    if (x * x + z * z > 1000 * 1000) continue;
    if (x * x + z * z < 120 * 120) continue; // keep the spawn field open
    let bad = false;
    for (const o of OASES) {
      const dx = x - o.x, dz = z - o.z, m = o.r + r + 25;
      if (dx * dx + dz * dz < m * m) { bad = true; break; }
    }
    if (bad) continue;
    for (const c of out) {
      const dx = x - c.x, dz = z - c.z, m = c.r + r + 15;
      if (dx * dx + dz * dz < m * m) { bad = true; break; }
    }
    if (bad) continue;
    out.push({ x, z, r });
  }
  return out;
}

export const CLUSTERS = genClusters();

// Push a point out of rock colliders and back inside the map edge.
// Mirrored in the server tick — the server is authoritative, this is
// client prediction of the same rule.
export function resolveCollision(p: { x: number; z: number }, radius = HULL_R): boolean {
  let touched = false;
  for (const c of CLUSTERS) {
    const dx = p.x - c.x, dz = p.z - c.z;
    const rr = c.r + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 < rr * rr && d2 > 1e-9) {
      const d = Math.sqrt(d2);
      p.x = c.x + (dx / d) * rr;
      p.z = c.z + (dz / d) * rr;
      touched = true;
    }
  }
  return clampMapEdge(p) || touched;
}

// Flying frames skip rock colliders but still respect the map edge.
export function clampMapEdge(p: { x: number; z: number }): boolean {
  const d2 = p.x * p.x + p.z * p.z;
  if (d2 > MAP_R * MAP_R) {
    const d = Math.sqrt(d2);
    p.x = (p.x / d) * MAP_R;
    p.z = (p.z / d) * MAP_R;
    return true;
  }
  return false;
}
