export class Input {
  private keys: Record<string, boolean> = {};
  mouseX = 0; // NDC, -1..1
  mouseY = 0;
  onFire?: () => void;
  onLoot?: () => void;
  onExtract?: () => void;

  constructor() {
    addEventListener('keydown', e => {
      if (e.repeat) return;
      if (e.code === 'KeyE') this.onLoot?.();
      if (e.code === 'KeyX') this.onExtract?.();
    });
    addEventListener('keydown', e => { this.keys[e.code] = true; });
    addEventListener('keyup', e => { this.keys[e.code] = false; });
    addEventListener('mousemove', e => {
      this.mouseX = (e.clientX / innerWidth) * 2 - 1;
      this.mouseY = (e.clientY / innerHeight) * 2 - 1;
    });
    addEventListener('mousedown', () => this.onFire?.());
  }

  get throttle(): number {
    return (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 0.5 : 0);
  }

  get steer(): number {
    return (this.keys['KeyA'] ? 1 : 0) - (this.keys['KeyD'] ? 1 : 0);
  }
}
