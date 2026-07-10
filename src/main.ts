import * as THREE from 'three';
import { buildTerrain, terrainH } from './terrain';
import { Walker } from './walker';
import { Combat } from './combat';
import { Effects, dustMat, fireMat, smokeMat } from './effects';
import { Hud } from './hud';
import { Input } from './input';
import { Net } from './net';
import { Lobby, type Loadout } from './lobby';
import { LootSites } from './loot';
import { RaiderMesh } from './raider';
import { CLUSTERS } from './map';

// ---------- scene ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd8a86b);
scene.fog = new THREE.FogExp2(0xd8a86b, 0.0030);

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
scene.add(sun.target); // sun follows the walker so shadows work map-wide
scene.add(new THREE.HemisphereLight(0xf2c98a, 0x6b4a2a, 0.55));

buildTerrain(scene);

// ---------- actors ----------
const hud = new Hud();
const effects = new Effects(scene);
const combat = new Combat(scene, effects, hud);
const input = new Input();
const lobby = new Lobby();
const net = new Net();
const lootSites = new LootSites(scene);
const greenSmoke = new THREE.MeshBasicMaterial({ color: 0x3aa050, transparent: true });

let walker: Walker | null = null;          // own trampler (null until spawned)
const remoteWalkers = new Map<bigint, Walker>();
const raiderMeshes = new Map<string, RaiderMesh>();
let roomNames = new Map<bigint, string>();
// own raider prediction (mirrors the server's on-foot integrator)
const ownRaiderPose = { x: 0, z: 0, yaw: 0, speed: 0, active: false };

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
  w.onBlocked = flashBlocked; // rocks/map edge feedback, own trampler only
  walker = w;
  return w;
}

let offline = false;

const LOOT_RANGE = 18;

function nearestPoi(): { id: bigint; dist: number; remaining: number } | null {
  if (!walker) return null;
  let best: { id: bigint; dist: number; remaining: number } | null = null;
  for (const p of net.pois.values()) {
    const d = Math.hypot(p.x - walker.root.position.x, p.z - walker.root.position.z);
    if (!best || d < best.dist) best = { id: p.id, dist: d, remaining: p.remaining };
  }
  return best;
}

input.onLoot = () => {
  if (!walker || walker.dead || lobby.visible) return;
  if (offline) { hud.flash('NO LINK — NOTHING TO SALVAGE'); return; }
  const poi = nearestPoi();
  if (!poi || poi.dist > LOOT_RANGE) { hud.flash('NO SALVAGE IN RANGE'); return; }
  net.loot(poi.id).catch(e =>
    hud.flash(String(e?.message ?? e).toUpperCase()));
};

input.onExtract = () => {
  if (!walker || walker.dead || lobby.visible) return;
  if (offline) { hud.flash('NO LINK — NO EXTRACTION'); return; }
  net.callExtraction()
    .then(() => hud.flash('BEACON LIT — SURVIVE 60 SECONDS'))
    .catch(e => hud.flash(String(e?.message ?? e).toUpperCase()));
};

input.onRepair = () => {
  if (!walker || walker.dead || lobby.visible || offline) return;
  net.fieldRepair()
    .then(() => hud.flash('HULL PATCHED — -15 SALVAGE'))
    .catch(e => hud.flash(String(e?.message ?? e).toUpperCase()));
};

input.onBoardRepel = () => {
  if (lobby.visible) return;
  if (net.ownRaider) {
    net.board()
      .then(() => hud.flash('ABOARD — HOLD ON'))
      .catch(e => hud.flash(String(e?.message ?? e).toUpperCase()));
  } else if (walker && !walker.dead) {
    net.repel()
      .then(() => hud.flash('DECK SWEPT CLEAR'))
      .catch(() => {});
  }
};

input.onAux = () => {
  if (lobby.visible) return;
  if (net.ownRaider) {
    // man a free gun station within reach
    net.mountGun()
      .then(() => hud.flash('GUN STATION MANNED — MOUSE AIM, CLICK FIRE'))
      .catch(e => hud.flash(String(e?.message ?? e).toUpperCase()));
  } else if (net.ownGun) {
    net.dismount()
      .then(() => hud.flash('STEPPED OFF — ON FOOT'))
      .catch(() => {});
  } else if (walker && !walker.dead && net.ownState) {
    net.dismount()
      .then(() => hud.flash('GONE OVERBOARD — HULL PARKED HERE'))
      .catch(e => hud.flash(String(e?.message ?? e).toUpperCase()));
  }
};

input.onBury = () => {
  if (lobby.visible || !net.ownRaider) return;
  net.toggleBury().catch(e => hud.flash(String(e?.message ?? e).toUpperCase()));
};

let gunnerCooldown = 0;

let blockedFlashT = 0;
function flashBlocked(): void {
  const t = performance.now();
  if (t - blockedFlashT > 4000) {
    blockedFlashT = t;
    hud.flash('HULL SCRAPING — REVERSE COURSE');
  }
}


input.onFire = () => {
  if (lobby.visible) return;
  effects.resumeAudio();
  // gunner mode: fire the manned station on the host trampler
  if (net.ownGun) {
    if (gunnerCooldown > 0) return;
    gunnerCooldown = 0.65;
    const host = remoteWalkers.get(net.ownGun.tramplerId);
    net.fireGun(gunnerAimYaw, gunnerAimPitch);
    if (host) {
      const m = host.gunMuzzleWorld(net.ownGun.slot);
      if (m) { effects.spawnBurst(m, 5, fireMat, 2.5, 2); }
      host.recoil = 0.12;
    }
    effects.thud(85, 0.25, 0.4);
    return;
  }
  if (!walker || walker.dead || !combat.canFire) return;
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
net.onPoiChanged = p => lootSites.upsert(p);
net.onPoiGone = id => lootSites.remove(id);
net.onCargo = (qty, value) => hud.setCargo(qty, value);
net.onVault = (salvage, fortress, thopter) => lobby.setVault(salvage, fortress, thopter);
net.onOwnRaiderSpawn = r => {
  ownRaiderPose.x = r.x;
  ownRaiderPose.z = r.z;
  ownRaiderPose.yaw = r.yaw;
  ownRaiderPose.speed = 0;
  ownRaiderPose.active = true;
  hud.setRoom(roomNames.get(net.roomId) ?? 'open desert');
  hud.setHp(1, 1);
  lobby.hide();
  hud.flash('ON FOOT — C BURY · F BOARD · STAY OFF THEIR PATH');
};
net.onOwnRaiderGone = () => {
  ownRaiderPose.active = false;
  if (lobby.visible) return;
  // give a hijack-in-progress a moment to hand us the helm
  window.setTimeout(() => {
    if (!net.ownState && !net.ownRaider && !net.ownGun && !lobby.visible) {
      hud.flash('TRAMPLED INTO THE SAND');
      effects.thud(28, 1.2, 0.9);
      window.setTimeout(() => {
        lobby.show();
        lobby.setStatus('trampled — the desert keeps what it takes');
      }, 2000);
    }
  }, 900);
};
net.onOwnHijacked = () => {
  walker?.dispose();
  walker = null;
  hud.flash('HELM SEIZED — YOUR TRAMPLER IS THEIRS');
  effects.thud(25, 1.5, 0.9);
};
net.onRaiderGone = key => {
  raiderMeshes.get(key)?.dispose();
  raiderMeshes.delete(key);
};
net.onGunnerEnd = () => {
  if (lobby.visible) return; // we initiated it from the lobby
  hud.flash('HOST TRAMPLER LOST');
  window.setTimeout(() => {
    lobby.show();
    lobby.setStatus('host trampler lost — find another ride');
  }, 2000);
};
net.onOwnExtracted = () => {
  walker?.dispose();
  walker = null;
  hud.flash('EXTRACTION COMPLETE — SALVAGE SECURED');
  effects.thud(90, 1.2, 0.6);
  window.setTimeout(() => {
    lobby.show();
    lobby.setStatus('extraction complete — salvage secured');
  }, 3000);
};

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
lobby.onBuyFrame = frameId => {
  const buy = frameId === 3 ? net.buyThopter() : net.buyFortress();
  buy.then(() => lobby.setStatus('frame unlocked'))
    .catch(e => lobby.setStatus(String(e?.message ?? e)));
};
lobby.onEnterRaider = (roomId, _name) => {
  if (!net.connected) { lobby.setStatus('offline — no raids on foot'); return; }
  lobby.setStatus('slipping into the sand…');
  net.joinRoom(roomId)
    .then(() => net.spawnRaider())
    .catch(e => lobby.setStatus(String(e?.message ?? e)));
};
lobby.onEnterGunner = (roomId, _name) => {
  if (!net.connected) { lobby.setStatus('offline — no crews to join'); return; }
  lobby.setStatus('finding a gun station…');
  net.joinRoom(roomId)
    .then(() => net.mountGun())
    .then(() => {
      lobby.hide();
      hud.setRoom(roomNames.get(net.roomId) ?? '…');
      hud.flash('GUN STATION MANNED — MOUSE AIM, CLICK FIRE');
    })
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
let beaconSmokeT = 0;
let boardAlarmT = 0;
let gunnerAimYaw = 0;
let gunnerAimPitch = 0;

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

  const piloting = !!walker && !net.ownRaider && !net.ownGun;

  if (walker) {
    // own trampler: predict locally, reconcile toward server.
    // Substep the integrator so slow frames don't dilate simulated time —
    // the server integrates in real time and we must match it.
    // (While dismounted the hull is parked: reconcile only, no driving.)
    if (!walker.dead && piloting) {
      for (let rem = rawDt; rem > 0; rem -= 0.05) {
        walker.drive(Math.min(rem, 0.05), throttle, steer);
      }
    }
    if (piloting) {
      net.sendInput(throttle, steer,
        walker.turretYaw.rotation.y, walker.turretPitch.rotation.x, now);
    }
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
    if (!walker.dead && piloting) walker.aimTurret(input.mouseX, input.mouseY);
  }

  gunnerCooldown = Math.max(0, gunnerCooldown - dt);

  // gunner mode: aim our manned station with the mouse
  if (net.ownGun && !lobby.visible) {
    gunnerAimYaw = -input.mouseX * 2.6;
    gunnerAimPitch = THREE.MathUtils.clamp(input.mouseY * 0.7 - 0.08, -0.5, 0.35);
    net.sendGunAim(gunnerAimYaw, gunnerAimPitch, now);
  }

  // own raider: predict on-foot movement, reconcile toward server
  if (net.ownRaider && ownRaiderPose.active) {
    const r = net.ownRaider;
    if (!r.buried && r.boarding === null) {
      ownRaiderPose.speed += (throttle * 4.5 - ownRaiderPose.speed)
        * Math.min(1, 10 * rawDt / Math.max(1, Math.abs(ownRaiderPose.speed)));
      if (!throttle) ownRaiderPose.speed *= Math.pow(0.2, rawDt);
      ownRaiderPose.yaw += steer * 2.5 * rawDt;
      ownRaiderPose.x += Math.sin(ownRaiderPose.yaw) * ownRaiderPose.speed * rawDt;
      ownRaiderPose.z += Math.cos(ownRaiderPose.yaw) * ownRaiderPose.speed * rawDt;
      const k = 1 - Math.exp(-rawDt * 3);
      ownRaiderPose.x += (r.x - ownRaiderPose.x) * k;
      ownRaiderPose.z += (r.z - ownRaiderPose.z) * k;
    } else {
      ownRaiderPose.x = r.x;
      ownRaiderPose.z = r.z;
      ownRaiderPose.speed = 0;
    }
    net.sendInput(throttle, steer, 0, 0, now);
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

  // raiders on foot (and on decks)
  for (const [key, r] of net.raiders) {
    let m = raiderMeshes.get(key);
    if (!m) {
      m = new RaiderMesh(scene);
      raiderMeshes.set(key, m);
    }
    if (r.boarding !== null) {
      const host = net.ownState && r.boarding === net.ownState.id
        ? walker
        : remoteWalkers.get(r.boarding);
      if (host) m.setAboard(host);
    } else if (r.mine && ownRaiderPose.active) {
      m.setGround(ownRaiderPose.x, ownRaiderPose.z, ownRaiderPose.yaw,
        ownRaiderPose.speed, r.buried, dt);
    } else {
      m.setGround(r.x, r.z, r.yaw, r.speed, r.buried, dt);
    }
  }

  // boarding alarm for pilots
  if (walker && !walker.dead && net.ownState && !lobby.visible) {
    const boarded = [...net.raiders.values()].some(r => r.boarding === net.ownState!.id);
    if (boarded) {
      boardAlarmT -= dt;
      if (boardAlarmT <= 0) {
        boardAlarmT = 1.6;
        hud.flash('BOARDERS ON DECK — [F] REPEL');
        effects.thud(120, 0.15, 0.3);
      }
    } else {
      boardAlarmT = 0;
    }
  }

  // crew gun stations on every hull; our own manned gun is posed locally
  for (const g of net.guns.values()) {
    const host = net.ownState && g.tramplerId === net.ownState.id
      ? walker
      : remoteWalkers.get(g.tramplerId);
    if (!host) continue;
    if (g.mine) host.setGunAim(g.slot, gunnerAimYaw, gunnerAimPitch, 0.4);
    else host.setGunAim(g.slot, g.yaw, g.pitch);
  }

  // extraction beacons: a green smoke column marks each burning trampler
  beaconSmokeT -= dt;
  if (beaconSmokeT <= 0 && net.beacons.size > 0) {
    beaconSmokeT = 0.13;
    for (const b of net.beacons.values()) {
      let pos: THREE.Vector3 | null = null;
      if (net.ownState && b.tramplerId === net.ownState.id && walker) {
        pos = walker.root.position;
      } else {
        const rw = remoteWalkers.get(b.tramplerId);
        if (rw) pos = rw.root.position;
      }
      if (pos) {
        effects.spawnBurst(pos.clone().add(new THREE.Vector3(0, 5, 0)), 2, greenSmoke, 1.2, 8);
      }
    }
  }

  if (net.ownGun && !lobby.visible) hud.setContext('GUN STATION — CLICK FIRE · ESC LOBBY');
  // raider context: boarding progress, bury state, board prompts
  if (net.ownRaider && !lobby.visible) {
    const r = net.ownRaider;
    if (r.boarding !== null) {
      const p = r.boardProgress;
      hud.setContext(p < 3
        ? `SABOTAGING… ${Math.max(0, 3 - p).toFixed(1)}s TO DISARM`
        : `GUNS CUT — ${Math.max(0, 8 - p).toFixed(1)}s TO SEIZE THE HELM`);
    } else if (r.buried) {
      hud.setContext('BURIED — [C] SURFACE');
    } else {
      const ownHull = net.ownState
        ? Math.hypot(net.ownState.x - ownRaiderPose.x, net.ownState.z - ownRaiderPose.z)
        : Infinity;
      let nearEnemy = Infinity;
      let nearEnemyId: bigint | null = null;
      for (const t of net.remotes.values()) {
        const s = t.buffer[t.buffer.length - 1];
        if (s && t.hpEngine > 0) {
          const d = Math.hypot(s.x - ownRaiderPose.x, s.z - ownRaiderPose.z);
          if (d < nearEnemy) { nearEnemy = d; nearEnemyId = t.id; }
        }
      }
      const freeSeat = nearEnemyId !== null && nearEnemy <= 8
        && [...net.guns.values()].some(g => g.tramplerId === nearEnemyId && !g.manned);
      if (ownHull <= 8) hud.setContext('[F] REMOUNT YOUR TRAMPLER');
      else if (nearEnemy <= 8) {
        hud.setContext(freeSeat ? '[F] BOARD · [G] MAN THEIR GUN' : '[F] BOARD THE TRAMPLER');
      } else {
        hud.setContext('[C] BURY · SNEAK CLOSE TO BOARD');
      }
    }
  }
  // HUD context line: extraction countdown wins, else nearby-salvage hint
  if (walker && !lobby.visible) {
    const ownBeacon = net.ownState
      ? [...net.beacons.values()].find(b => b.tramplerId === net.ownState!.id)
      : undefined;
    const shieldMs = net.ownState ? net.ownState.protectedUntilMs - Date.now() : 0;
    const sabotageMs = net.ownState ? net.ownState.gunsDisabledUntilMs - Date.now() : 0;
    if (sabotageMs > 0) {
      hud.setContext(`WEAPONS SABOTAGED ${Math.ceil(sabotageMs / 1000)}s`);
    } else if (ownBeacon) {
      const s = Math.max(0, Math.ceil((ownBeacon.endsAtMs - Date.now()) / 1000));
      hud.setContext(`EXTRACTION T-${s}s — HOLD OUT`);
    } else if (shieldMs > 0) {
      hud.setContext(`SPAWN SHIELD ${Math.ceil(shieldMs / 1000)}s`);
    } else {
      const poi = nearestPoi();
      hud.setContext(poi && poi.dist <= LOOT_RANGE ? `[E] SALVAGE HERE (${poi.remaining})` : '');
    }
  }

  combat.update(dt);
  effects.update(dt);

  // camera: chase own trampler, ride the host as gunner, or drift as backdrop
  const gunnerHost = net.ownGun ? remoteWalkers.get(net.ownGun.tramplerId) : undefined;
  if (gunnerHost) {
    const camOff = new THREE.Vector3(0, 10, -18)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), gunnerHost.yaw + gunnerAimYaw * 0.4);
    const camTarget = gunnerHost.root.position.clone().add(camOff);
    camTarget.y = Math.max(camTarget.y, terrainH(camTarget.x, camTarget.z) + 3);
    camera.position.lerp(camTarget, 0.08);
    camera.lookAt(gunnerHost.root.position.clone().add(new THREE.Vector3(0, 3, 0)));
    hud.setSpeed(gunnerHost.speed);
    hud.setHeading(gunnerHost.yaw);
    const hostRec = net.remotes.get(net.ownGun!.tramplerId);
    if (hostRec) hud.setHp(hostRec.hpHull, hostRec.hpEngine);
  } else if (net.ownRaider && ownRaiderPose.active) {
    const r = net.ownRaider;
    if (r.boarding !== null) {
      const host = remoteWalkers.get(r.boarding);
      if (host) {
        const camOff = new THREE.Vector3(0, 13, -24)
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), host.yaw);
        const camTarget = host.root.position.clone().add(camOff);
        camTarget.y = Math.max(camTarget.y, terrainH(camTarget.x, camTarget.z) + 4);
        camera.position.lerp(camTarget, 0.15);
        camera.lookAt(host.root.position.clone().add(new THREE.Vector3(0, 4, 0)));
      }
    } else {
      const gy = terrainH(ownRaiderPose.x, ownRaiderPose.z);
      const camOff = new THREE.Vector3(0, 3.6, -8)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), ownRaiderPose.yaw);
      const camTarget = new THREE.Vector3(ownRaiderPose.x, gy, ownRaiderPose.z).add(camOff);
      camTarget.y = Math.max(camTarget.y, terrainH(camTarget.x, camTarget.z) + 1.6);
      camera.position.lerp(camTarget, 0.1);
      camera.lookAt(ownRaiderPose.x, gy + 1.4, ownRaiderPose.z);
    }
    hud.setSpeed(ownRaiderPose.speed);
    hud.setHeading(ownRaiderPose.yaw);
  } else if (walker) {
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

  // sun + shadow frustum track whatever the camera is following
  sun.position.copy(camera.position).add(new THREE.Vector3(120, 171, 60));
  sun.target.position.copy(camera.position);

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
      clusters: typeof CLUSTERS;
    };
  }
}
window.__sos = {
  getWalker: () => walker, net, lobby, combat, remoteWalkers, clusters: CLUSTERS,
};
