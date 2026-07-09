// Trampler frame presets. Order and stats MUST match FRAME_STATS in
// server/src/lib.rs — maxSpd drives both server integration and client
// prediction, so a mismatch causes rubber-banding.

export interface FrameDef {
  name: string;
  desc: string;
  legPairs: number;   // legs = legPairs * 2
  maxSpd: number;
  hp: number;
  scale: number;      // hull size multiplier
}

export const FRAMES: FrameDef[] = [
  { name: 'DUNE SKIMMER', desc: 'fast · fragile · 4 legs', legPairs: 2, maxSpd: 12, hp: 60, scale: 0.75 },
  { name: 'TRAMPLER MK.I', desc: 'balanced · 6 legs', legPairs: 3, maxSpd: 9, hp: 100, scale: 1.0 },
  { name: 'FORTRESS', desc: 'slow · armoured · 8 legs', legPairs: 4, maxSpd: 6, hp: 180, scale: 1.35 },
];

// dieselpunk hull tints
export const HULL_COLORS = [0x5a4a3a, 0x6e3a2a, 0x3a4a5a, 0x4a5a3a, 0x5a3a5a, 0x2e2a26];
