import * as THREE from 'three';
import { terrainH } from './terrain';
import { FRAMES, GUN_SLOT_OFFSETS, HOVER_HEIGHT } from './frames';

// N-leg walker: two-bone IK (law of cosines), tripod gait, feet planted in
// world space. Purely cosmetic — the server only ever syncs pos/yaw/speed;
// everything below derives locally from those three values plus dt.
// Frame presets (leg count, size, speed) come from frames.ts.

const BASE_L1 = 5.2, BASE_L2 = 5.8;  // leg segment lengths at scale 1
const BASE_CLEARANCE = 6.2;          // hull height above average foot
const STEP_DUR = 0.32;               // seconds per step
const ACCEL = 6, TURN = 0.7;

const UP = new THREE.Vector3(0, 1, 0);

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  footMesh: THREE.Mesh;
  restLocal: THREE.Vector3;   // ideal foot position in walker space
  poleLocal: THREE.Vector3;   // knee aim direction in walker space (outward+up)
  grp: number;                // tripod group 0|1
  footW: THREE.Vector3;       // current foot position (world)
  fromW: THREE.Vector3;       // step start (world)
  toW: THREE.Vector3;         // step end (world)
  stepT: number;              // 0..1, 1 = planted
}

const mats = {
  hull:  new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: .85, metalness: .35 }),
  dark:  new THREE.MeshStandardMaterial({ color: 0x2e2a26, roughness: .9,  metalness: .3 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xb08840, roughness: .5,  metalness: .7 }),
  leg:   new THREE.MeshStandardMaterial({ color: 0x3d3833, roughness: .8,  metalness: .4 }),
};

function box(w: number, h: number, d: number, m: THREE.Material,
             x: number, y: number, z: number, parent: THREE.Object3D): THREE.Mesh {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  b.position.set(x, y, z);
  b.castShadow = true;
  parent.add(b);
  return b;
}

// scratch objects for solveLeg
const _hipW = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _hinge = new THREE.Vector3();
const _upper = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _worldQ = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _ideal = new THREE.Vector3();
const _vel = new THREE.Vector3();

export class Walker {
  readonly root = new THREE.Group();     // world transform (yaw + position)
  readonly bodyRig = new THREE.Group();  // pitch/roll/bob relative to root
  readonly turretYaw = new THREE.Group();
  readonly turretPitch = new THREE.Group();
  readonly muzzle = new THREE.Object3D();

  speed = 0;
  yaw = 0;
  recoil = 0;
  gaitPhase = 0;
  dead = false; // collapse: gait stops, hull settles onto the sand

  onFootfall?: (pos: THREE.Vector3) => void;
  onSmokePuff?: (pos: THREE.Vector3) => void;

  readonly maxSpd: number;
  private readonly l1: number;
  private readonly l2: number;
  private readonly clearance: number;
  private readonly stepTrigger: number;

  private legs: Leg[] = [];
  private stackTip: THREE.Mesh;
  private smokeT = 0;
  private steerAbs = 0;
  private frameScale: number;
  readonly flying: boolean;
  private wings: THREE.Mesh[] = [];
  private gunMounts = new Map<number, { yaw: THREE.Group; pitch: THREE.Group; muzzle: THREE.Object3D }>();

  constructor(private scene: THREE.Scene, frameId = 1, color?: number) {
    const frame = FRAMES[Math.min(frameId, FRAMES.length - 1)];
    const s = frame.scale;
    const legScale = Math.sqrt(s);
    this.maxSpd = frame.maxSpd;
    this.frameScale = s;
    this.flying = !!frame.flying;
    this.l1 = BASE_L1 * legScale;
    this.l2 = BASE_L2 * legScale;
    this.clearance = BASE_CLEARANCE * legScale;
    this.stepTrigger = 2.2 * legScale;

    this.root.add(this.bodyRig);
    scene.add(this.root);

    const hullMat = color !== undefined
      ? new THREE.MeshStandardMaterial({ color, roughness: .85, metalness: .35 })
      : mats.hull;

    // hull
    box(6 * s, 3.2 * s, 11 * s, hullMat, 0, 0, 0, this.bodyRig);                  // main hull
    box(6.6 * s, 0.4 * s, 11.6 * s, mats.dark, 0, 1.8 * s, 0, this.bodyRig);      // deck rim
    box(3.4 * s, 2.2 * s, 3.6 * s, mats.dark, 0, 2.9 * s, -3.2 * s, this.bodyRig); // wheelhouse aft
    box(0.7 * s, 3.5 * s, 0.7 * s, mats.brass, 2.2 * s, 3.6 * s, -4.6 * s, this.bodyRig); // smokestack
    this.stackTip = box(0.9 * s, 0.3 * s, 0.9 * s, mats.dark, 2.2 * s, 5.4 * s, -4.6 * s, this.bodyRig);

    // turret (yaw ring + pitching barrel)
    this.turretYaw.position.set(0, 2.2 * s, 2.8 * s);
    this.bodyRig.add(this.turretYaw);
    box(1.8 * s, 0.9 * s, 1.8 * s, mats.brass, 0, 0, 0, this.turretYaw);
    this.turretPitch.position.set(0, 0.5 * s, 0);
    this.turretYaw.add(this.turretPitch);
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22 * s, 0.28 * s, 4.4 * s, 10), mats.dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 2.2 * s;
    barrel.castShadow = true;
    this.turretPitch.add(barrel);
    this.muzzle.position.set(0, 0, 4.4 * s);
    this.turretPitch.add(this.muzzle);

    if (this.flying) {
      // ornithopter: hinged flapping wings instead of legs
      for (const side of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.BoxGeometry(9 * s, 0.22 * s, 3.4 * s), mats.dark);
        wing.geometry.translate(side * 4.5 * s, 0, 0); // hinge at the hull
        wing.position.set(side * 3.0 * s, 1.2 * s, 0.6 * s);
        wing.castShadow = true;
        this.bodyRig.add(wing);
        this.wings.push(wing);
      }
      this.root.updateMatrixWorld(true);
      return;
    }

    // legs: legPairs rows of two, hips spread evenly along the hull
    const rows = frame.legPairs;
    const zMax = 4.2 * s;
    for (let row = 0; row < rows; row++) {
      const hz = rows === 1 ? 0 : zMax - (2 * zMax * row) / (rows - 1);
      for (const side of [-1, 1]) {
        const hip = new THREE.Group();
        hip.position.set(3.2 * s * side, -0.8 * s, hz);
        this.bodyRig.add(hip);
        const upper = this.makeSeg(this.l1, 0.42 * legScale, 0.3 * legScale);
        hip.add(upper);
        const knee = new THREE.Group();
        knee.position.y = this.l1;
        upper.add(knee);
        knee.add(this.makeSeg(this.l2, 0.3 * legScale, 0.16 * legScale));
        const foot = new THREE.Mesh(
          new THREE.CylinderGeometry(0.55 * legScale, 0.75 * legScale, 0.5 * legScale, 8),
          mats.dark);
        foot.castShadow = true;
        scene.add(foot); // foot rendered in world space

        this.legs.push({
          hip, knee, footMesh: foot,
          restLocal: new THREE.Vector3(6.4 * legScale * side, 0, hz * 1.33),
          poleLocal: new THREE.Vector3(side, 0.6, 0).normalize(),
          grp: (row + (side + 1) / 2) % 2,
          footW: new THREE.Vector3(),
          fromW: new THREE.Vector3(),
          toW: new THREE.Vector3(),
          stepT: 1,
        });
      }
    }

    this.snapFeet();
  }

  private makeSeg(len: number, r0: number, r1: number): THREE.Mesh {
    const g = new THREE.CylinderGeometry(r1, r0, len, 8);
    g.translate(0, len / 2, 0); // pivot at base
    const m = new THREE.Mesh(g, mats.leg);
    m.castShadow = true;
    return m;
  }

  get speedAbs(): number { return Math.abs(this.speed); }

  dispose(): void {
    this.scene.remove(this.root);
    for (const leg of this.legs) this.scene.remove(leg.footMesh);
  }

  update(dt: number, throttle: number, steer: number): void {
    this.drive(dt, throttle, steer);
    this.animate(dt);
  }

  // Local drive integrator. The server runs this exact same math on tick
  // (server/src/lib.rs::tick); keeping them identical makes client prediction
  // drift-free apart from input latency.
  drive(dt: number, throttle: number, steer: number): void {
    this.speed += (throttle * this.maxSpd - this.speed)
      * Math.min(1, ACCEL * dt / Math.max(1, Math.abs(this.speed)));
    if (!throttle) this.speed *= Math.pow(0.4, dt);
    this.yaw += steer * TURN * dt * (0.4 + 0.6 * Math.min(1, Math.abs(this.speed) / 3));
    // forward is +Z at yaw=0 (matches turret facing); clean single integrator
    this.root.position.x += Math.sin(this.yaw) * this.speed * dt;
    this.root.position.z += Math.cos(this.yaw) * this.speed * dt;
    this.steerAbs = Math.abs(steer);
  }

  // Pose a remote (or reconciled) walker from networked pos/yaw/speed; gait
  // and IK derive from these in animate() — leg state is never networked.
  setPose(x: number, z: number, yaw: number, speed: number): void {
    this.root.position.x = x;
    this.root.position.z = z;
    this.yaw = yaw;
    this.speed = speed;
    this.steerAbs = 0;
  }

  // Re-plant every foot at its rest position. Call after teleporting (spawn,
  // large server correction) so legs don't drag across the map.
  snapFeet(): void {
    this.root.rotation.y = this.yaw;
    this.root.updateMatrixWorld(true);
    if (this.flying) return;
    for (const leg of this.legs) {
      const w = leg.restLocal.clone().applyMatrix4(this.root.matrixWorld);
      w.y = terrainH(w.x, w.z);
      leg.footW.copy(w);
      leg.stepT = 1;
    }
  }

  // Everything cosmetic: gait, stepping, body attitude, IK, smoke.
  animate(dt: number): void {
    this.recoil = Math.max(0, this.recoil - dt * 1.2);
    this.root.rotation.y = this.yaw;
    this.root.updateMatrixWorld();

    if (this.flying) {
      this.gaitPhase += dt * (6 + this.speedAbs * 0.8);
      const flap = Math.sin(this.gaitPhase * 2.4) * (0.35 + 0.1 * Math.min(1, this.speedAbs / 8));
      if (this.wings[0]) this.wings[0].rotation.z = -flap;
      if (this.wings[1]) this.wings[1].rotation.z = flap;
      const groundY = terrainH(this.root.position.x, this.root.position.z);
      const bob = Math.sin(this.gaitPhase * 0.5) * 0.5;
      const targetY = this.dead ? groundY + 1.2 : groundY + HOVER_HEIGHT + bob;
      this.root.position.y = THREE.MathUtils.lerp(
        this.root.position.y || targetY, targetY, this.dead ? 0.03 : 0.08);
      this.bodyRig.rotation.x = THREE.MathUtils.lerp(
        this.bodyRig.rotation.x, -this.speed * 0.02 - this.recoil * 0.15, 0.08);
      this.bodyRig.rotation.z = THREE.MathUtils.lerp(
        this.bodyRig.rotation.z, this.steerAbs * 0.1 * Math.sign(-this.speed || 1), 0.05);
      this.root.updateMatrixWorld();
      this.smokeT -= dt;
      if (this.smokeT < 0 && this.speedAbs > 0.5 && !this.dead) {
        this.smokeT = 0.25;
        const sp = new THREE.Vector3();
        this.stackTip.getWorldPosition(sp);
        this.onSmokePuff?.(sp);
      }
      return;
    }

    if (this.dead) {
      // legs go limp: no gait, hull sinks to the sand and lists to one side
      let avgY = 0;
      for (const leg of this.legs) avgY += leg.footW.y;
      avgY /= this.legs.length;
      this.root.position.y = THREE.MathUtils.lerp(
        this.root.position.y, avgY + this.clearance * 0.28, 1 - Math.exp(-dt * 2));
      this.bodyRig.rotation.x = THREE.MathUtils.lerp(this.bodyRig.rotation.x, 0.12, 0.03);
      this.bodyRig.rotation.z = THREE.MathUtils.lerp(this.bodyRig.rotation.z, 0.22, 0.03);
      this.root.updateMatrixWorld();
      for (const leg of this.legs) this.solveLeg(leg);
      return;
    }

    // world-space velocity, used to lead the feet in the direction of travel —
    // works identically in reverse
    _vel.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(this.speed);

    // --- gait ---
    const activity = Math.abs(this.speed) + this.steerAbs * 2;
    this.gaitPhase += dt * (0.5 + activity * 0.35);

    for (const leg of this.legs) {
      // desired foot position: rest pose pushed toward where the hull is going
      _ideal.copy(leg.restLocal).applyMatrix4(this.root.matrixWorld);
      _ideal.addScaledVector(_vel, 0.28);
      _ideal.y = terrainH(_ideal.x, _ideal.z);

      if (leg.stepT >= 1) {
        // planted — step when drifted too far, one tripod group at a time
        const err = leg.footW.distanceTo(_ideal);
        const groupTurn = (Math.floor(this.gaitPhase) % 2) === leg.grp;
        if (err > this.stepTrigger && groupTurn) {
          leg.fromW.copy(leg.footW);
          // land where the ideal spot will be at touchdown, not where it is now
          leg.toW.copy(_ideal).addScaledVector(_vel, STEP_DUR * 0.6);
          leg.toW.y = terrainH(leg.toW.x, leg.toW.z);
          leg.stepT = 0;
        }
      } else {
        leg.stepT = Math.min(1, leg.stepT + dt / STEP_DUR);
        const t = leg.stepT, ease = t * t * (3 - 2 * t);
        leg.footW.lerpVectors(leg.fromW, leg.toW, ease);
        leg.footW.y = THREE.MathUtils.lerp(leg.fromW.y, leg.toW.y, ease)
                    + Math.sin(t * Math.PI) * 1.6; // lift arc
        if (leg.stepT >= 1) {
          leg.footW.y = terrainH(leg.footW.x, leg.footW.z);
          this.onFootfall?.(leg.footW);
        }
      }
    }

    // --- body height / pitch / roll from feet ---
    let avgY = 0, foreY = 0, aftY = 0, leftY = 0, rightY = 0, nf = 0, na = 0, nl = 0, nr = 0;
    for (const leg of this.legs) {
      avgY += leg.footW.y;
      if (leg.restLocal.z > 0.5) { foreY += leg.footW.y; nf++; }
      if (leg.restLocal.z < -0.5) { aftY += leg.footW.y; na++; }
      if (leg.restLocal.x < 0) { leftY += leg.footW.y; nl++; }
      else { rightY += leg.footW.y; nr++; }
    }
    avgY /= this.legs.length;
    const pitch = nf && na ? Math.atan2(foreY / nf - aftY / na, 9) * 0.7 : 0;
    const roll = nl && nr ? Math.atan2(rightY / nr - leftY / nl, 7) * 0.7 : 0;

    const bobY = Math.sin(this.gaitPhase * Math.PI * 2) * 0.12 * Math.min(1, activity / 4);
    const swayR = Math.sin(this.gaitPhase * Math.PI) * 0.015 * Math.min(1, activity / 4);
    this.root.position.y = avgY + this.clearance + bobY;
    this.bodyRig.rotation.x = THREE.MathUtils.lerp(
      this.bodyRig.rotation.x, pitch - this.recoil * 0.15, 0.1);
    this.bodyRig.rotation.z = THREE.MathUtils.lerp(
      this.bodyRig.rotation.z, roll + swayR, 0.1);

    // solve IK after body settled
    this.root.updateMatrixWorld();
    for (const leg of this.legs) this.solveLeg(leg);

    // --- smokestack puffs ---
    this.smokeT -= dt;
    if (this.smokeT < 0 && activity > 0.5) {
      this.smokeT = 0.25;
      const sp = new THREE.Vector3();
      this.stackTip.getWorldPosition(sp);
      this.onSmokePuff?.(sp);
    }
  }

  /** Pose a crew gun station, creating its mesh on first use. */
  setGunAim(slot: number, yaw: number, pitch: number, lerp = 0.15): void {
    let g = this.gunMounts.get(slot);
    if (!g) {
      const s = this.frameScale;
      const [ox, oy, oz] = GUN_SLOT_OFFSETS[Math.min(slot, GUN_SLOT_OFFSETS.length - 1)];
      const yawG = new THREE.Group();
      yawG.position.set(ox * s, oy * s, oz * s);
      this.bodyRig.add(yawG);
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.1 * s, 0.6 * s, 1.1 * s), mats.dark);
      base.castShadow = true;
      yawG.add(base);
      const pitchG = new THREE.Group();
      pitchG.position.y = 0.4 * s;
      yawG.add(pitchG);
      const barrel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12 * s, 0.16 * s, 3.0 * s, 8), mats.brass);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.z = 1.5 * s;
      barrel.castShadow = true;
      pitchG.add(barrel);
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0, 3.0 * s);
      pitchG.add(muzzle);
      g = { yaw: yawG, pitch: pitchG, muzzle };
      this.gunMounts.set(slot, g);
    }
    g.yaw.rotation.y = THREE.MathUtils.lerp(g.yaw.rotation.y, yaw, lerp);
    g.pitch.rotation.x = THREE.MathUtils.lerp(g.pitch.rotation.x, pitch, lerp);
  }

  gunMuzzleWorld(slot: number): THREE.Vector3 | null {
    const g = this.gunMounts.get(slot);
    if (!g) return null;
    return g.muzzle.getWorldPosition(new THREE.Vector3());
  }

  aimTurret(mouseX: number, mouseY: number): void {
    this.turretYaw.rotation.y = THREE.MathUtils.lerp(
      this.turretYaw.rotation.y, -mouseX * 1.6, 0.12);
    this.turretPitch.rotation.x = THREE.MathUtils.lerp(
      this.turretPitch.rotation.x,
      THREE.MathUtils.clamp(mouseY * 0.7 - 0.08, -0.5, 0.35), 0.12);
  }

  private solveLeg(leg: Leg): void {
    leg.hip.getWorldPosition(_hipW);
    _dir.copy(leg.footW).sub(_hipW);
    const dist = Math.min(_dir.length(), this.l1 + this.l2 - 0.05);
    _dir.normalize();

    // law of cosines: hip lift angle + interior knee angle
    const a = Math.acos(THREE.MathUtils.clamp(
      (this.l1 * this.l1 + dist * dist - this.l2 * this.l2) / (2 * this.l1 * dist), -1, 1));
    const kneeAng = Math.acos(THREE.MathUtils.clamp(
      (this.l1 * this.l1 + this.l2 * this.l2 - dist * dist) / (2 * this.l1 * this.l2), -1, 1));

    // Knee-flip fix: the bend plane is defined by a stable per-leg pole vector
    // (outward+up in walker space) instead of cross(dir, worldUp), which
    // reversed sign when the leg direction tipped past vertical on steep dunes.
    _pole.copy(leg.poleLocal).transformDirection(this.root.matrixWorld);
    _hinge.crossVectors(_dir, _pole);
    if (_hinge.lengthSq() < 1e-6) _hinge.crossVectors(_dir, UP);
    if (_hinge.lengthSq() < 1e-6) _hinge.set(1, 0, 0);
    _hinge.normalize();

    // upper segment: leg direction tilted toward the pole by the lift angle
    _upper.copy(_dir).applyAxisAngle(_hinge, a);
    // hip basis: X = hinge axis, Y = upper segment, Z completes right-handed
    _zAxis.crossVectors(_hinge, _upper);
    _basis.makeBasis(_hinge, _upper, _zAxis);
    _worldQ.setFromRotationMatrix(_basis);
    leg.hip.parent!.getWorldQuaternion(_parentQ);
    leg.hip.quaternion.copy(_parentQ.invert().multiply(_worldQ));

    // knee folds back toward the foot, i.e. away from the pole: negative about X
    leg.knee.rotation.x = -(Math.PI - kneeAng);

    leg.footMesh.position.copy(leg.footW);
    leg.footMesh.position.y += 0.25;
  }
}
