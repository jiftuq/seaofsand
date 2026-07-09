import * as THREE from 'three';
import { terrainH } from './terrain';
import type { PoiInfo } from './net';

// Salvage site visuals: a half-buried cargo scatter plus a tall amber light
// beam so sites read from across the dunes. Driven by net POI events.

const beamMat = new THREE.MeshBasicMaterial({
  color: 0xe8b04a, transparent: true, opacity: 0.16, depthWrite: false,
});
const crateMat = new THREE.MeshStandardMaterial({ color: 0x6b5a38, roughness: .9, metalness: .3 });
const scrapMat = new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: .95, metalness: .4 });

export class LootSites {
  private sites = new Map<bigint, THREE.Group>();

  constructor(private scene: THREE.Scene) {}

  upsert(p: PoiInfo): void {
    let g = this.sites.get(p.id);
    if (!g) {
      g = new THREE.Group();
      const y = terrainH(p.x, p.z);
      g.position.set(p.x, y, p.z);

      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 2.0, 34, 10, 1, true), beamMat);
      beam.position.y = 17;
      beam.name = 'beam';
      g.add(beam);

      for (let i = 0; i < 3; i++) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 2.8), i ? crateMat : scrapMat);
        const a = i * 2.3, r = 2 + i * 1.4;
        c.position.set(Math.sin(a) * r, 0.4 - i * 0.15, Math.cos(a) * r);
        c.rotation.set(0.1 * i, a, 0.15);
        c.castShadow = true;
        g.add(c);
      }
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(.15, .2, 5, 6), scrapMat);
      mast.position.set(0, 2.2, 0);
      mast.rotation.z = 0.2;
      mast.castShadow = true;
      g.add(mast);

      this.scene.add(g);
      this.sites.set(p.id, g);
    }
    // beam thins as the site is stripped
    const beam = g.getObjectByName('beam') as THREE.Mesh;
    const k = Math.max(0.15, p.remaining / 25);
    beam.scale.set(k, 1, k);
  }

  remove(id: bigint): void {
    const g = this.sites.get(id);
    if (g) {
      this.scene.remove(g);
      this.sites.delete(id);
    }
  }
}
