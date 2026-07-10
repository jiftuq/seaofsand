import * as THREE from 'three';
import { CLUSTERS, MAP_R, OASES, mulberry32 } from './map';

export const TSIZE = 2400;
const TSEG = 480;

// Analytic dune heightfield — the ONLY ground truth. Legs, projectiles and the
// camera sample it directly; there are no raycasts and no physics engine.
// The SpacetimeDB server module implements this exact function (terrain_h).
export function terrainH(x: number, z: number): number {
  let h = Math.sin(x * 0.018) * Math.cos(z * 0.022) * 7
        + Math.sin(x * 0.05 + z * 0.03) * 2.4
        + Math.sin(x * 0.11) * Math.sin(z * 0.13) * 0.8;
  // oasis bowls: smooth 7m depressions
  for (const o of OASES) {
    const dx = x - o.x, dz = z - o.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < o.r * o.r) {
      const d = Math.sqrt(d2) / o.r;
      const s = d * d * (3 - 2 * d);
      h -= 7 * (1 - s);
    }
  }
  return h;
}

export function buildTerrain(scene: THREE.Scene): void {
  const geo = new THREE.PlaneGeometry(TSIZE, TSIZE, TSEG, TSEG);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, terrainH(p.getX(i), p.getZ(i)));
  geo.computeVertexNormals();

  const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0xc9975a, roughness: 1, metalness: 0, flatShading: false,
  }));
  terrain.receiveShadow = true;
  scene.add(terrain);

  buildOases(scene);
  buildFormations(scene);
  buildPebbles(scene);
}

function buildOases(scene: THREE.Scene): void {
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2e6f6a, roughness: 0.15, metalness: 0,
    transparent: true, opacity: 0.88,
  });
  const reedMat = new THREE.MeshStandardMaterial({ color: 0x4a6b35, roughness: 0.9 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b5138, roughness: 0.95 });
  const frondMat = new THREE.MeshStandardMaterial({ color: 0x53753b, roughness: 0.85 });

  for (const [oi, o] of OASES.entries()) {
    const waterY = terrainH(o.x, o.z) + 2.5;
    const water = new THREE.Mesh(new THREE.CircleGeometry(o.r * 0.62, 40), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(o.x, waterY, o.z);
    scene.add(water);

    const rand = mulberry32(0xa0a0 + oi);
    // reeds around the shoreline
    for (let i = 0; i < 18; i++) {
      const ang = rand() * Math.PI * 2;
      const rr = o.r * (0.6 + rand() * 0.18);
      const x = o.x + Math.cos(ang) * rr, z = o.z + Math.sin(ang) * rr;
      const reed = new THREE.Mesh(new THREE.ConeGeometry(0.35, 2.2 + rand() * 2, 5), reedMat);
      reed.position.set(x, terrainH(x, z) + 1, z);
      reed.castShadow = true;
      scene.add(reed);
    }
    // a few palms
    for (let i = 0; i < 4; i++) {
      const ang = rand() * Math.PI * 2;
      const rr = o.r * (0.75 + rand() * 0.2);
      const x = o.x + Math.cos(ang) * rr, z = o.z + Math.sin(ang) * rr;
      const y = terrainH(x, z);
      const h = 7 + rand() * 4;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, h, 6), trunkMat);
      trunk.position.set(x, y + h / 2, z);
      trunk.rotation.z = (rand() - 0.5) * 0.25;
      trunk.castShadow = true;
      scene.add(trunk);
      const cx = x + trunk.rotation.z * -h * 0.5;
      const crown = new THREE.Mesh(new THREE.ConeGeometry(2.1, 2.6, 7), frondMat);
      crown.position.set(cx, y + h + 0.9, z);
      crown.castShadow = true;
      scene.add(crown);
      const skirt = new THREE.Mesh(new THREE.ConeGeometry(2.8, 1.2, 7), frondMat);
      skirt.rotation.x = Math.PI; // drooping lower fronds
      skirt.position.set(cx, y + h - 0.1, z);
      skirt.castShadow = true;
      scene.add(skirt);
    }
  }
}

// Big rock formations you can hide a trampler behind. Cluster centers/radii
// come from the shared deterministic layout (map.ts, mirrored server-side for
// collision); the visual rocks inside each cluster are cosmetic and use a
// per-cluster PRNG.
function buildFormations(scene: THREE.Scene): void {
  const rockGeo = new THREE.DodecahedronGeometry(1, 1);
  const mats = [
    new THREE.MeshStandardMaterial({ color: 0x7d5f42, roughness: 1 }),
    new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 1 }),
    new THREE.MeshStandardMaterial({ color: 0x6e5238, roughness: 1 }),
  ];
  for (const [ci, c] of CLUSTERS.entries()) {
    const rand = mulberry32(0xc0ffee + ci * 7919);
    const n = 3 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const ang = rand() * Math.PI * 2;
      const dist = rand() * c.r * 0.6;
      const x = c.x + Math.cos(ang) * dist;
      const z = c.z + Math.sin(ang) * dist;
      const s = c.r * (0.25 + rand() * 0.45);           // footprint
      const hScale = 0.9 + rand() * 2.2;                // spires up to ~3x
      const rock = new THREE.Mesh(rockGeo, mats[Math.floor(rand() * 3)]);
      rock.position.set(x, terrainH(x, z) + s * hScale * 0.55, z);
      rock.scale.set(s, s * hScale, s * (0.8 + rand() * 0.4));
      rock.rotation.y = rand() * Math.PI;
      rock.castShadow = true;
      rock.receiveShadow = true;
      scene.add(rock);
    }
  }
}

function buildPebbles(scene: THREE.Scene): void {
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 1 });
  const rand = mulberry32(4242);
  for (let i = 0; i < 300; i++) {
    const x = (rand() * 2 - 1) * MAP_R;
    const z = (rand() * 2 - 1) * MAP_R;
    if (x * x + z * z > MAP_R * MAP_R) continue;
    const r = new THREE.Mesh(rockGeo, rockMat);
    r.position.set(x, terrainH(x, z) + 0.2, z);
    const s = 0.5 + rand() * 2.5;
    r.scale.set(s, s * 0.7, s);
    r.rotation.y = rand() * Math.PI;
    r.castShadow = true;
    scene.add(r);
  }
}
