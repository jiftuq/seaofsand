import * as THREE from 'three';
import { buildTerrain, terrainH } from './terrain';
import { Walker } from './walker';
import { Combat } from './combat';
import { Effects, dustMat, smokeMat } from './effects';
import { Hud } from './hud';
import { Input } from './input';

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

// ---------- main loop ----------
const clock = new THREE.Clock();

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  walker.update(dt, input.throttle, input.steer);
  walker.aimTurret(input.mouseX, input.mouseY);
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
declare global { interface Window { __sos?: { walker: Walker } } }
window.__sos = { walker };
