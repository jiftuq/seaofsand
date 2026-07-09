import * as THREE from 'three';
import { buildTerrain, terrainH } from './terrain';
import { Walker } from './walker';
import { Combat } from './combat';
import { Effects, dustMat, smokeMat } from './effects';
import { Hud } from './hud';
import { Input } from './input';
import { Net } from './net';

// ---------- scene ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd8a86b);
scene.fog = new THREE.FogExp2(0xd8a86b, 0.0038);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 2000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const sun = new THREE.DirectionalLight(0xffe6c0, 1.35);
sun.position.set(120, 180, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
sun.shadow.camera.far = 500;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xf2c98a, 0x6b4a2a, 0.55));

buildTerrain(scene);

// ---------- actors ----------
const hud = new Hud();
const effects = new Effects(scene);
const walker = new Walker(scene);
const combat = new Combat(scene, effects, hud);
const input = new Input();

walker.onFootfall = pos => {
  effects.spawnBurst(pos, 3, dustMat, 2, 1.2);
  effects.thud(45 + Math.random() * 15, 0.18, 0.12);
};
walker.onSmokePuff = pos => effects.spawnBurst(pos, 1, smokeMat.clone(), 0.5, 3);
input.onFire = () => {
  effects.resumeAudio();
  combat.fire(walker);
};

// ---------- networking (M2) ----------
// Own trampler runs the same integrator as the server (prediction) and is
// gently reconciled toward authoritative state; remote tramplers interpolate
// ~120ms behind receive time and derive gait/IK locally from pos/yaw/speed.
const net = new Net();
const remoteWalkers = new Map<bigint, Walker>();

net.onStatus = s => hud.setNet(s);
net.onOwnSpawn = snap => {
  walker.setPose(snap.x, snap.z, snap.yaw, snap.speed);
  walker.snapFeet();
};
net.onRemoteGone = id => {
  remoteWalkers.get(id)?.dispose();
  remoteWalkers.delete(id);
};
// dev builds default to a local spacetime instance, production to Maincloud;
// override either with VITE_STDB_URI / VITE_STDB_DB at build time
net.connect(
  import.meta.env.VITE_STDB_URI
    ?? (import.meta.env.PROD ? 'wss://maincloud.spacetimedb.com' : 'ws://localhost:3000'),
  import.meta.env.VITE_STDB_DB ?? 'seaofsand',
  `raider-${Math.random().toString(36).slice(2, 7)}`,
);

const SNAP_DIST = 8; // metres of divergence before we hard-snap to the server

// ---------- main loop ----------
const clock = new THREE.Clock();

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function animate(): void {
  requestAnimationFrame(animate);
  const rawDt = Math.min(clock.getDelta(), 0.25);
  const dt = Math.min(rawDt, 0.05); // cosmetic dt (gait, particles, camera)
  const now = performance.now();

  // own trampler: predict locally, reconcile toward server.
  // Substep the integrator so slow frames don't dilate simulated time —
  // the server integrates in real time and we must match it.
  for (let rem = rawDt; rem > 0; rem -= 0.05) {
    walker.drive(Math.min(rem, 0.05), input.throttle, input.steer);
  }
  net.sendInput(input.throttle, input.steer, now);
  const own = net.ownState;
  if (own) {
    const ex = own.x - walker.root.position.x;
    const ez = own.z - walker.root.position.z;
    if (Math.hypot(ex, ez) > SNAP_DIST) {
      walker.setPose(own.x, own.z, own.yaw, own.speed);
      walker.snapFeet();
    } else {
      const k = 1 - Math.exp(-rawDt * 3); // ~0.3s correction half-life
      walker.root.position.x += ex * k;
      walker.root.position.z += ez * k;
      walker.yaw = lerpAngle(walker.yaw, own.yaw, k);
      walker.speed += (own.speed - walker.speed) * k;
    }
  }
  walker.animate(dt);
  walker.aimTurret(input.mouseX, input.mouseY);

  // remote tramplers: interpolate + derive gait locally
  for (const [id, remote] of net.remotes) {
    let rw = remoteWalkers.get(id);
    if (!rw) {
      rw = new Walker(scene);
      rw.onSmokePuff = pos => effects.spawnBurst(pos, 1, smokeMat.clone(), 0.5, 3);
      rw.onFootfall = pos => effects.spawnBurst(pos, 3, dustMat, 2, 1.2);
      const snap = remote.buffer[remote.buffer.length - 1];
      rw.setPose(snap.x, snap.z, snap.yaw, snap.speed);
      rw.snapFeet();
      remoteWalkers.set(id, rw);
    }
    const pose = net.samplePose(remote, now);
    if (pose) rw.setPose(pose.x, pose.z, pose.yaw, pose.speed);
    rw.animate(dt);
  }

  combat.update(dt);
  effects.update(dt);

  // third-person chase camera
  const camOff = new THREE.Vector3(0, 9, -20)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), walker.yaw);
  const camTarget = walker.root.position.clone().add(camOff);
  camTarget.y = Math.max(camTarget.y, terrainH(camTarget.x, camTarget.z) + 3);
  camera.position.lerp(camTarget, 0.06);
  camera.lookAt(walker.root.position.clone().add(new THREE.Vector3(0, 3, 0)));

  hud.setSpeed(walker.speed);
  hud.setHeading(walker.yaw);

  renderer.render(scene, camera);
}

hud.flash('SYSTEMS ONLINE — ENGAGE THROTTLE');
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// debug handle for automated smoke tests
declare global {
  interface Window {
    __sos?: { walker: Walker; net: Net; remoteWalkers: Map<bigint, Walker> };
  }
}
window.__sos = { walker, net, remoteWalkers };
