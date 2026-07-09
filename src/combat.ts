import * as THREE from 'three';
import { terrainH } from './terrain';
import { Effects, dustMat, fireMat } from './effects';
import { Hud } from './hud';
import { Walker } from './walker';
import type { ProjectileSpawn } from './net';

// Ballistics. Online, projectiles are server rows (spawned by the fire
// reducer, resolved in tick): we render them by integrating the same arc
// locally from the spawn snapshot and explode where the row is deleted.
// Offline keeps the old fully-local simulation plus the practice derelict.
// Constants MUST match server/src/lib.rs.

const GRAVITY = 22;
const MUZZLE_VEL = 70;
const FIRE_COOLDOWN = 0.9;

interface Shell { mesh: THREE.Mesh; vel: THREE.Vector3 }

export class Combat {
  private projGeo = new THREE.SphereGeometry(0.25, 8, 8);
  private projMat = new THREE.MeshBasicMaterial({ color: 0xffd080 });
  private cooldown = 0;

  // online: server-owned shells keyed by row id
  private shells = new Map<bigint, Shell>();

  // offline practice range
  private offline = false;
  private localShells: Shell[] = [];
  private derelict: THREE.Group | null = null;
  private derelictHP = 100;

  constructor(private scene: THREE.Scene, private effects: Effects, private hud: Hud) {}

  get canFire(): boolean { return this.cooldown <= 0; }

  /** Local muzzle effects; call alongside net.fire() or fireLocal(). */
  muzzleFlash(walker: Walker): void {
    this.cooldown = FIRE_COOLDOWN;
    const pos = new THREE.Vector3();
    walker.muzzle.getWorldPosition(pos);
    this.effects.spawnBurst(pos, 6, fireMat, 3, 2);
    this.effects.thud(70, 0.35, 0.5);
    walker.recoil = 0.25;
  }

  // ---- online: server projectile rows ----

  onSpawn(p: ProjectileSpawn): void {
    const mesh = new THREE.Mesh(this.projGeo, this.projMat);
    mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
    this.scene.add(mesh);
    this.shells.set(p.id, { mesh, vel: new THREE.Vector3(p.vel.x, p.vel.y, p.vel.z) });
  }

  onGone(id: bigint): void {
    const s = this.shells.get(id);
    if (!s) return;
    this.shells.delete(id);
    this.explode(s.mesh.position);
    this.scene.remove(s.mesh);
  }

  clearShells(): void {
    for (const s of this.shells.values()) this.scene.remove(s.mesh);
    this.shells.clear();
  }

  // ---- offline practice range ----

  enableOfflineRange(): void {
    if (this.derelict) return;
    this.offline = true;
    const dx = 60, dz = -40;
    const g = new THREE.Group();
    g.position.set(dx, terrainH(dx, dz), dz);
    const m = new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: .95, metalness: .4 });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(7, 4, 14), m);
    hull.position.y = 3;
    hull.rotation.z = 0.28;
    hull.castShadow = true;
    g.add(hull);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(.3, .4, 9, 8), m);
    mast.position.set(1, 7, -2);
    mast.rotation.z = .35;
    mast.castShadow = true;
    g.add(mast);
    this.scene.add(g);
    this.derelict = g;
    this.hud.setIntegrity(this.derelictHP);
  }

  fireLocal(walker: Walker): void {
    const pos = new THREE.Vector3();
    walker.muzzle.getWorldPosition(pos);
    const dir = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(walker.turretPitch.getWorldQuaternion(new THREE.Quaternion()));
    const mesh = new THREE.Mesh(this.projGeo, this.projMat);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.localShells.push({ mesh, vel: dir.multiplyScalar(MUZZLE_VEL) });
  }

  // ---- shared ----

  private explode(pos: THREE.Vector3): void {
    this.effects.spawnBurst(pos, 12, fireMat, 6, 4);
    this.effects.spawnBurst(pos, 8, dustMat, 5, 3);
    this.effects.thud(50, 0.5, 0.4);
  }

  update(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);

    // online shells: integrate the same arc as the server between row events
    for (const s of this.shells.values()) {
      s.vel.y -= GRAVITY * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
    }

    // offline shells resolve locally
    for (let i = this.localShells.length - 1; i >= 0; i--) {
      const s = this.localShells[i];
      s.vel.y -= GRAVITY * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      const p = s.mesh.position;
      let hit = p.y <= terrainH(p.x, p.z);

      if (!hit && this.offline && this.derelict && this.derelictHP > 0
          && p.distanceTo(this.derelict.position.clone().add(new THREE.Vector3(0, 4, 0))) < 7) {
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
        this.explode(p);
        this.scene.remove(s.mesh);
        this.localShells.splice(i, 1);
      } else if (p.length() > 1200) {
        this.scene.remove(s.mesh);
        this.localShells.splice(i, 1);
      }
    }
  }
}
