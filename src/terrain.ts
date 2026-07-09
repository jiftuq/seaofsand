import * as THREE from 'three';

export const TSIZE = 900;
const TSEG = 180;

// Analytic dune heightfield — the ONLY ground truth. Legs, projectiles and the
// camera sample it directly; there are no raycasts and no physics engine.
// The SpacetimeDB server module must implement this exact function.
export function terrainH(x: number, z: number): number {
  return Math.sin(x * 0.018) * Math.cos(z * 0.022) * 7
       + Math.sin(x * 0.05 + z * 0.03) * 2.4
       + Math.sin(x * 0.11) * Math.sin(z * 0.13) * 0.8;
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

  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 1 });
  for (let i = 0; i < 120; i++) {
    const r = new THREE.Mesh(rockGeo, rockMat);
    const x = (Math.random() - 0.5) * TSIZE * 0.9;
    const z = (Math.random() - 0.5) * TSIZE * 0.9;
    r.position.set(x, terrainH(x, z) + 0.2, z);
    const s = 0.5 + Math.random() * 2.5;
    r.scale.set(s, s * 0.7, s);
    r.rotation.y = Math.random() * Math.PI;
    r.castShadow = true;
    scene.add(r);
  }
}
