import { FRAMES, HULL_COLORS } from './frames';
import type { RoomInfo } from './net';

// Homepage overlay: callsign, frame + paint selection, expedition (room)
// list. Pure DOM — the game renders behind it as a backdrop.

const OPEN_DESERT = 1n; // room 1 is created at init and never deleted

export interface Loadout {
  name: string;
  frameId: number;
  color: number;
}

export class Lobby {
  private el = document.getElementById('lobby')!;
  private framesEl = document.getElementById('frames')!;
  private swatchesEl = document.getElementById('swatches')!;
  private roomsEl = document.getElementById('rooms')!;
  private statusEl = document.getElementById('lobbyStatus')!;
  private callsignEl = document.getElementById('callsign') as HTMLInputElement;
  private roomNameEl = document.getElementById('roomName') as HTMLInputElement;

  private frameId = 1;
  private color = HULL_COLORS[0];
  private rooms: RoomInfo[] = [];
  private unlocked = [true, true, false, false];
  private banked = 0;

  /** enter the given room (open desert = 1n) with the chosen loadout */
  onEnter?: (roomId: bigint, loadout: Loadout) => void;
  onCreate?: (roomName: string, loadout: Loadout) => void;
  /** crew a free gun station in the given room instead of piloting */
  onEnterGunner?: (roomId: bigint, name: string) => void;
  onEnterRaider?: (roomId: bigint, name: string) => void;
  onBuyFrame?: (frameId: number) => void;

  constructor() {
    this.callsignEl.value = localStorage.getItem('callsign')
      ?? `raider-${Math.random().toString(36).slice(2, 6)}`;
    this.frameId = Number(localStorage.getItem('frameId') ?? 1);
    this.color = Number(localStorage.getItem('hullColor') ?? HULL_COLORS[0]);

    FRAMES.forEach((_f, i) => {
      const d = document.createElement('div');
      d.className = 'frame';
      d.onclick = () => {
        const cost = FRAMES[i].cost ?? 0;
        if (!this.unlocked[i]) {
          if (this.banked >= cost) this.onBuyFrame?.(i);
          else this.setStatus(`${FRAMES[i].name} costs ${cost} banked salvage`);
          return;
        }
        this.frameId = i;
        this.refreshSelection();
      };
      this.framesEl.appendChild(d);
    });
    this.renderFrames();
    HULL_COLORS.forEach(c => {
      const s = document.createElement('div');
      s.className = 'swatch';
      s.style.background = `#${c.toString(16).padStart(6, '0')}`;
      s.onclick = () => { this.color = c; this.refreshSelection(); };
      this.swatchesEl.appendChild(s);
    });
    this.refreshSelection();

    document.getElementById('enterDesert')!.onclick =
      () => this.onEnter?.(OPEN_DESERT, this.loadout());
    document.getElementById('desertGunner')!.onclick =
      () => this.onEnterGunner?.(OPEN_DESERT, this.loadout().name);
    document.getElementById('desertRaider')!.onclick =
      () => this.onEnterRaider?.(OPEN_DESERT, this.loadout().name);
    document.getElementById('createRoom')!.onclick = () => {
      const name = this.roomNameEl.value.trim();
      if (!name) { this.setStatus('name your expedition first'); return; }
      this.onCreate?.(name, this.loadout());
    };
    addEventListener('keydown', e => {
      if (e.code === 'Escape' && this.el.classList.contains('hidden')) this.show();
    });
  }

  private renderFrames(): void {
    FRAMES.forEach((f, i) => {
      const d = this.framesEl.children[i] as HTMLElement;
      const locked = !this.unlocked[i];
      const cost = f.cost ?? 0;
      const lockLine = locked
        ? `<br><span style="color:#fff">LOCKED — ${cost} SALVAGE${this.banked >= cost ? ' · CLICK TO BUY' : ''}</span>`
        : '';
      d.innerHTML = `<div class="fname">${locked ? '🔒 ' : ''}${f.name}</div>
        <div class="fdesc">${f.desc}<br>spd ${f.maxSpd} · hp ${f.hp}${lockLine}</div>`;
      d.style.opacity = locked ? '0.75' : '1';
    });
    if (!this.unlocked[this.frameId]) this.frameId = 1;
    this.refreshSelection();
  }

  setVault(banked: number, fortressUnlocked: boolean, thopterUnlocked: boolean): void {
    this.banked = banked;
    this.unlocked = [true, true, fortressUnlocked, thopterUnlocked];
    this.setBanked(banked);
    this.renderFrames();
  }

  private loadout(): Loadout {
    const name = this.callsignEl.value.trim() || 'raider';
    localStorage.setItem('callsign', name);
    localStorage.setItem('frameId', String(this.frameId));
    localStorage.setItem('hullColor', String(this.color));
    return { name, frameId: this.frameId, color: this.color };
  }

  private refreshSelection(): void {
    Array.from(this.framesEl.children).forEach((c, i) =>
      c.classList.toggle('sel', i === this.frameId));
    Array.from(this.swatchesEl.children).forEach((c, i) =>
      c.classList.toggle('sel', HULL_COLORS[i] === this.color));
  }

  setRooms(rooms: RoomInfo[]): void {
    this.rooms = rooms;
    this.roomsEl.innerHTML = '';
    for (const r of rooms) {
      if (r.id === OPEN_DESERT) continue; // has its own big button
      const d = document.createElement('div');
      const full = r.players >= r.maxPlayers;
      d.className = full ? 'room full' : 'room';
      d.innerHTML = `<span class="rname">${escapeHtml(r.name)}</span>
        <span><span class="gunchip">CREW GUN</span> <span class="rcount">${r.players}/${r.maxPlayers}</span></span>`;
      if (!full) {
        d.querySelector('.rname')!.addEventListener('click',
          () => this.onEnter?.(r.id, this.loadout()));
        d.querySelector('.gunchip')!.addEventListener('click', e => {
          e.stopPropagation();
          this.onEnterGunner?.(r.id, this.loadout().name);
        });
      }
      this.roomsEl.appendChild(d);
    }
    const desert = rooms.find(r => r.id === OPEN_DESERT);
    const btn = document.getElementById('enterDesert')!;
    btn.textContent = desert
      ? `ENTER OPEN DESERT — ${desert.players}/${desert.maxPlayers} RAIDERS`
      : 'ENTER OPEN DESERT';
    if (this.roomsEl.children.length === 0) {
      this.roomsEl.innerHTML =
        '<div class="room"><span class="rname" style="opacity:.5">no expeditions — found one below</span></div>';
    }
  }

  setStatus(text: string): void { this.statusEl.textContent = text; }

  setBanked(salvage: number): void {
    document.getElementById('banked')!.textContent = String(salvage);
  }
  show(): void { this.el.classList.remove('hidden'); this.setRooms(this.rooms); }
  hide(): void { this.el.classList.add('hidden'); }
  get visible(): boolean { return !this.el.classList.contains('hidden'); }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}
