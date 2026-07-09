import * as THREE from 'three';
import { terrainH } from './terrain';
import { Effects, dustMat, fireMat } from './effects';
import { Hud } from './hud';
import { Walker } from './walker';

// Ballistic cannon + destructible derelict. Client-side for M1; in M3 the
// server resolves hits deterministically from the fire event and this module
// becomes presentation only.

const GRAVITY = 22;
const MUZZLE_VEL = 70;
const FIRE_COOLDOWN = 0.9;

export class Combat {
  private projectiles: THREE.Mesh[] = [];
  private projGeo = new THREE.SphereGeometry(0.25, 8, 8);
  private projMat = new THREE.MeshBasicMaterial({ color: 0xffd080 });
  private derelict = new THREE.Group();
  private derelictHP = 100;
  private cooldown = 0;

  constructor(private scene: THREE.Scene, private effects: Effects, private hud: Hud) {
    const dx = 60, dz = -40;
    this.derelict.position.set(dx, terrainH(dx, dz), dz);
    const m = new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: .95, metalness: .4 });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(7, 4, 14), m);
    hull.position.y = 3;
    hull.rotation.z = 0.28;
    hull.castShadow = true;
    this.derelict.add(hull);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(.3, .4, 9, 8), m);
    mast.position.set(1, 7, -2);
    mast.rotation.z = .35;
    mast.castShadow = true;
    this.derelict.add(mast);
    scene.add(this.derelict);
  }

  fire(walker: Walker): void {
    if (this.cooldown > 0) return;
    this.cooldown = FIRE_COOLDOWN;
    const pos = new THREE.Vector3();
    walker.muzzle.getWorldPosition(pos);
    const dir = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(walker.turretPitch.getWorldQuaternion(new THREE.Quaternion()));
    const p = new THREE.Mesh(this.projGeo, this.projMat);
    p.position.copy(pos);
    p.userData.v = dir.multiplyScalar(MUZZLE_VEL);
    this.scene.add(p);
    this.projectiles.push(p);
    this.effects.spawnBurst(pos, 6, fireMat, 3, 2);
    this.effects.thud(70, 0.35, 0.5);
    walker.recoil = 0.25;
  }

  update(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const v = p.userData.v as THREE.Vector3;
      v.y -= GRAVITY * dt;
      p.position.addScaledVector(v, dt);
      let hit = p.position.y <= terrainH(p.position.x, p.position.z);

      // derelict hit (crude sphere test)
      if (!hit && this.derelictHP > 0 && p.position.distanceTo(
          this.derelict.position.clone().add(new THREE.Vector3(0, 4, 0))) < 7) {
        hit = true;
        this.derelictHP = Math.max(0, this.derelictHP - 12);
        this.hud.setIntegrity(this.derelictHP);
        if (this.derelictHP === 0) {
          this.hud.flash('DERELICT DESTROYED — LOOT SECURED');
          this.derelict.children.forEach(c => {
            const mesh = c as THREE.Mesh;
            mesh.material = (mesh.material as THREE.Material).clone();
            (mesh.material as THREE.MeshStandardMaterial).color.set(0x1a1815);
          });
          this.derelict.rotation.z = 0.5;
          this.effects.spawnBurst(
            this.derelict.position.clone().add(new THREE.Vector3(0, 4, 0)), 30, fireMat, 10, 8);
          this.effects.thud(35, 1.2, 0.8);
        }
      }

      if (hit) {
        this.effects.spawnBurst(p.position, 12, fireMat, 6, 4);
        this.effects.spawnBurst(p.position, 8, dustMat, 5, 3);
        this.effects.thud(50, 0.5, 0.4);
        this.scene.remove(p);
        this.projectiles.splice(i, 1);
      } else if (p.position.length() > 1200) {
        this.scene.remove(p);
        this.projectiles.splice(i, 1);
      }
    }
  }
}
