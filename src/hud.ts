export class Hud {
  private spd = document.getElementById('spd')!;
  private hdg = document.getElementById('hdg')!;
  private tgt = document.getElementById('target')!;
  private msg = document.getElementById('msg') as HTMLElement;
  private msgTimer = 0;

  setSpeed(v: number): void { this.spd.textContent = Math.abs(v).toFixed(1); }

  setHeading(yaw: number): void {
    this.hdg.textContent = String((yaw * 180 / Math.PI) % 360 | 0);
  }

  setIntegrity(hp: number): void {
    this.tgt.textContent = `derelict integrity: ${hp}%`;
  }

  flash(text: string): void {
    this.msg.textContent = text;
    this.msg.style.opacity = '1';
    clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => { this.msg.style.opacity = '0'; }, 2200);
  }
}
