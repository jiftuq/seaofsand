import * as THREE from 'three';
import { terrainH } from './terrain';
import type { Walker } from './walker';

// On-foot sand raider visuals: a small robed figure, a barely-visible sand
// mound when buried, or a rider crouched on an enemy deck while boarding.

const robeMat = new THREE.MeshStandardMaterial({ color: 0x3a332c, roughness: .95, metalness: .05 });
const headMat = new THREE.MeshStandardMaterial({ color: 0x2a251f, roughness: .9, metalness: .05 });
const moundMat = new THREE.MeshStandardMaterial({ color: 0xc39257, roughness: 1, metalness: 0 });

export class RaiderMesh {
  private group = new THREE.Group();
  private figure = new THREE.Group();
  private mound: THREE.Mesh;
  private walkPhase = 0;

  constructor(private scene: THREE.Scene) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.45, 1.3, 8), robeMat);
    body.position.y = 0.75;
    body.castShadow = true;
    this.figure.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 8), headMat);
    head.position.y = 1.6;
    head.castShadow = true;
    this.figure.add(head);
    this.group.add(this.figure);

    this.mound = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 6), moundMat);
    this.mound.scale.set(1.3, 0.28, 1.3);
    this.mound.visible = false;
    this.group.add(this.mound);

    scene.add(this.group);
  }

  /** Pose on open sand (or hidden as a mound). */
  setGround(x: number, z: number, yaw: number, speed: number, buried: boolean, dt: number): void {
    this.group.position.set(x, terrainH(x, z), z);
    this.group.rotation.y = yaw;
    this.figure.visible = !buried;
    this.mound.visible = buried;
    if (!buried) {
      this.walkPhase += dt * Math.abs(speed) * 3;
      this.figure.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.12;
    }
  }

  /** Crouched on a host trampler's deck while boarding. */
  setAboard(host: Walker): void {
    const deck = new THREE.Vector3(0, 2.2, -1.2).applyMatrix4(host.bodyRig.matrixWorld);
    this.group.position.copy(deck);
    this.group.rotation.y = host.yaw;
    this.figure.visible = true;
    this.figure.position.y = -0.4; // crouch
    this.mound.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.group);
  }
}
