export class Hud {
  private spd = document.getElementById('spd')!;
  private hdg = document.getElementById('hdg')!;
  private tgt = document.getElementById('target')!;
  private msg = document.getElementById('msg') as HTMLElement;
  private net = document.getElementById('net')!;
  private room = document.getElementById('hudRoom')!;
  private msgTimer = 0;

  setNet(text: string): void { this.net.textContent = text; }

  setRoom(text: string): void { this.room.textContent = text.toLowerCase(); }

  setSpeed(v: number): void { this.spd.textContent = Math.abs(v).toFixed(1); }

  setHeading(yaw: number): void {
    this.hdg.textContent = String((yaw * 180 / Math.PI) % 360 | 0);
  }

  setIntegrity(hp: number): void {
    this.tgt.textContent = `derelict integrity: ${hp}%`;
  }

  setHp(hull: number, engine: number): void {
    this.tgt.textContent = `hull ${hull} · engine ${engine}`;
  }

  flash(text: string): void {
    this.msg.textContent = text;
    this.msg.style.opacity = '1';
    clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => { this.msg.style.opacity = '0'; }, 2200);
  }
}
