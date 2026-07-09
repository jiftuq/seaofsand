import * as THREE from 'three';

// Dust bursts, muzzle fire, smokestack puffs + WebAudio thuds.

interface ParticleData { v: THREE.Vector3; life: number; t: number }

const dustGeo = new THREE.SphereGeometry(0.3, 6, 6);
export const dustMat = new THREE.MeshBasicMaterial({ color: 0xd8b078, transparent: true });
export const fireMat = new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true });
export const smokeMat = new THREE.MeshBasicMaterial({ color: 0x555049, transparent: true });

export class Effects {
  private particles: THREE.Mesh[] = [];
  private ac = window.AudioContext ? new AudioContext() : null;

  constructor(private scene: THREE.Scene) {}

  resumeAudio(): void {
    if (this.ac && this.ac.state === 'suspended') void this.ac.resume();
  }

  spawnBurst(pos: THREE.Vector3, n: number, mat: THREE.MeshBasicMaterial,
             spread: number, up: number): void {
    for (let i = 0; i < n; i++) {
      const p = new THREE.Mesh(dustGeo, mat.clone());
      p.position.copy(pos);
      const d: ParticleData = {
        v: new THREE.Vector3(
          (Math.random() - 0.5) * spread, Math.random() * up, (Math.random() - 0.5) * spread),
        life: 0.6 + Math.random() * 0.6,
        t: 0,
      };
      p.userData = d;
      const s = 0.5 + Math.random();
      p.scale.set(s, s, s);
      this.scene.add(p);
      this.particles.push(p);
    }
  }

  thud(freq: number, dur: number, gain: number): void {
    if (!this.ac) return;
    const o = this.ac.createOscillator(), g = this.ac.createGain();
    o.frequency.value = freq;
    o.type = 'triangle';
    g.gain.setValueAtTime(gain, this.ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ac.currentTime + dur);
    o.connect(g).connect(this.ac.destination);
    o.start();
    o.stop(this.ac.currentTime + dur);
  }

  update(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const d = p.userData as ParticleData;
      d.t += dt;
      d.v.y -= 3 * dt;
      p.position.addScaledVector(d.v, dt);
      const k = d.t / d.life;
      (p.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - k);
      p.scale.multiplyScalar(1 + dt * 1.5);
      if (k >= 1) { this.scene.remove(p); this.particles.splice(i, 1); }
    }
  }
}
