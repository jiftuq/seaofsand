import * as THREE from 'three';
import { buildTerrain, terrainH } from './terrain';
import { Walker } from './walker';
import { Combat } from './combat';
import { Effects, dustMat, smokeMat } from './effects';
import { Hud } from './hud';
import { Input } from './input';
import { Net } from './net';
import { Lobby, type Loadout } from './lobby';

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
const combat = new Combat(scene, effects, hud);
const input = new Input();
const lobby = new Lobby();
const net = new Net();

let walker: Walker | null = null;          // own trampler (null until spawned)
const remoteWalkers = new Map<bigint, Walker>();
let roomNames = new Map<bigint, string>();

function hookWalkerEffects(w: Walker): void {
  w.onFootfall = pos => {
    effects.spawnBurst(pos, 3, dustMat, 2, 1.2);
    if (w === walker) effects.thud(45 + Math.random() * 15, 0.18, 0.12);
  };
  w.onSmokePuff = pos => effects.spawnBurst(pos, 1, smokeMat.clone(), 0.5, 3);
}

function buildOwnWalker(frameId: number, color: number): Walker {
  walker?.dispose();
  const w = new Walker(scene, frameId, color);
  hookWalkerEffects(w);
  walker = w;
  return w;
}

let offline = false;

input.onFire = () => {
  if (!walker || walker.dead || lobby.visible || !combat.canFire) return;
  effects.resumeAudio();
  combat.muzzleFlash(walker);
  if (offline) {
    combat.fireLocal(walker);
  } else {
    net.fire(walker.turretYaw.rotation.y, walker.turretPitch.rotation.x);
  }
};

// ---------- networking ----------
// Own trampler runs the same integrator as the server (prediction) and is
// gently reconciled toward authoritative state; remote tramplers interpolate
// ~120ms behind receive time and derive gait/IK locally from pos/yaw/speed.
net.onStatus = s => hud.setNet(s);
net.onRoomsChanged = rooms => {
  roomNames = new Map(rooms.map(r => [r.id, r.name]));
  lobby.setRooms(rooms);
};
net.onOwnSpawn = (snap, frameId, color) => {
  const w = buildOwnWalker(frameId, color);
  w.setPose(snap.x, snap.z, snap.yaw, snap.speed);
  w.snapFeet();
  hud.setRoom(roomNames.get(net.roomId) ?? 'open desert');
  lobby.hide();
  hud.flash('SYSTEMS ONLINE — ENGAGE THROTTLE');
};
net.onOwnDespawn = () => {
  walker?.dispose();
  walker = null;
};
net.onOwnHp = (hull, engine) => hud.setHp(hull, engine);
net.onOwnDead = () => {
  if (walker) walker.dead = true;
  hud.flash('ENGINE DESTROYED — TRAMPLER LOST');
  effects.thud(30, 1.5, 0.9);
  window.setTimeout(() => {
    lobby.show();
    lobby.setStatus('trampler lost — refit and redeploy');
  }, 3500);
};
net.onRemoteGone = id => {
  remoteWalkers.get(id)?.dispose();
  remoteWalkers.delete(id);
};
net.onRoomChanged = () => {
  hud.setRoom(roomNames.get(net.roomId) ?? '…');
  combat.clearShells();
};
net.onProjectileSpawn = p => combat.onSpawn(p);
net.onProjectileGone = id => combat.onGone(id);

// dev builds default to a local spacetime instance, production to Maincloud;
// override either with VITE_STDB_URI / VITE_STDB_DB at build time
net.connect(
  import.meta.env.VITE_STDB_URI
    ?? (import.meta.env.PROD ? 'wss://maincloud.spacetimedb.com' : 'ws://localhost:3000'),
  import.meta.env.VITE_STDB_DB ?? 'seaofsand',
  localStorage.getItem('callsign') ?? 'raider',
);

// ---------- lobby flow ----------
function enterOffline(loadout: Loadout): void {
  offline = true;
  const w = buildOwnWalker(loadout.frameId, loadout.color);
  w.setPose(0, 0, 0, 0);
  w.snapFeet();
  combat.enableOfflineRange();
  hud.setRoom('open desert (offline)');
  lobby.hide();
  hud.flash('NO LINK — RUNNING DARK');
}

lobby.onEnter = (roomId, loadout) => {
  if (!net.connected) { enterOffline(loadout); return; }
  lobby.setStatus('boarding…');
  // reducers execute in submission order on our connection: move room, spawn
  net.joinRoom(roomId)
    .then(() => net.spawn(loadout.frameId, loadout.color))
    .catch(e => lobby.setStatus(String(e?.message ?? e)));
};
lobby.onCreate = (roomName, loadout) => {
  if (!net.connected) { enterOffline(loadout); return; }
  lobby.setStatus('founding expedition…');
  net.createRoom(roomName)
    .then(() => net.spawn(loadout.frameId, loadout.color))
    .catch(e => lobby.setStatus(String(e?.message ?? e)));
};

// ---------- main loop ----------
const clock = new THREE.Clock();
const SNAP_DIST = 8; // metres of divergence before we hard-snap to the server

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

  const throttle = lobby.visible || walker?.dead ? 0 : input.throttle;
  const steer = lobby.visible || walker?.dead ? 0 : input.steer;

  if (walker) {
    // own trampler: predict locally, reconcile toward server.
    // Substep the integrator so slow frames don't dilate simulated time —
    // the server integrates in real time and we must match it.
    if (!walker.dead) {
      for (let rem = rawDt; rem > 0; rem -= 0.05) {
        walker.drive(Math.min(rem, 0.05), throttle, steer);
      }
    }
    net.sendInput(throttle, steer,
      walker.turretYaw.rotation.y, walker.turretPitch.rotation.x, now);
    const own = net.ownState;
    if (own && !walker.dead) {
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
    if (!walker.dead) walker.aimTurret(input.mouseX, input.mouseY);
  }

  // remote tramplers: interpolate + derive gait locally
  for (const [id, remote] of net.remotes) {
    let rw = remoteWalkers.get(id);
    if (!rw) {
      if (remote.buffer.length === 0) continue;
      rw = new Walker(scene, remote.frameId, remote.color);
      hookWalkerEffects(rw);
      const snap = remote.buffer[remote.buffer.length - 1];
      rw.setPose(snap.x, snap.z, snap.yaw, snap.speed);
      rw.snapFeet();
      remoteWalkers.set(id, rw);
    }
    const pose = net.samplePose(remote, now);
    if (pose && !rw.dead) rw.setPose(pose.x, pose.z, pose.yaw, pose.speed);
    if (remote.hpEngine === 0 && !rw.dead) rw.dead = true;
    rw.turretYaw.rotation.y = THREE.MathUtils.lerp(
      rw.turretYaw.rotation.y, remote.gunYaw, 0.15);
    rw.turretPitch.rotation.x = THREE.MathUtils.lerp(
      rw.turretPitch.rotation.x, remote.gunPitch, 0.15);
    rw.animate(dt);
  }

  combat.update(dt);
  effects.update(dt);

  // camera: chase own trampler, or drift over the dunes as a lobby backdrop
  if (walker) {
    const camOff = new THREE.Vector3(0, 9, -20)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), walker.yaw);
    const camTarget = walker.root.position.clone().add(camOff);
    camTarget.y = Math.max(camTarget.y, terrainH(camTarget.x, camTarget.z) + 3);
    camera.position.lerp(camTarget, 0.06);
    camera.lookAt(walker.root.position.clone().add(new THREE.Vector3(0, 3, 0)));
    hud.setSpeed(walker.speed);
    hud.setHeading(walker.yaw);
  } else {
    const t = now * 0.00004;
    const cx = Math.sin(t) * 90, cz = Math.cos(t) * 90;
    camera.position.set(cx, terrainH(cx, cz) + 26, cz);
    camera.lookAt(Math.sin(t + 0.6) * 40, 4, Math.cos(t + 0.6) * 40);
  }

  renderer.render(scene, camera);
}

animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// debug handle for automated smoke tests
declare global {
  interface Window {
    __sos?: {
      getWalker: () => Walker | null;
      net: Net;
      lobby: Lobby;
      combat: Combat;
      remoteWalkers: Map<bigint, Walker>;
    };
  }
}
window.__sos = { getWalker: () => walker, net, lobby, combat, remoteWalkers };
