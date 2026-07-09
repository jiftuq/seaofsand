// Trampler frame presets. Order and stats MUST match FRAME_STATS in
// server/src/lib.rs — maxSpd drives both server integration and client
// prediction, so a mismatch causes rubber-banding.

export interface FrameDef {
  name: string;
  desc: string;
  legPairs: number;   // legs = legPairs * 2 (0 = flying)
  maxSpd: number;
  hp: number;
  scale: number;      // hull size multiplier
  gunSlots: number;   // crew stations (mounted guns)
  flying?: boolean;
  cost?: number;      // banked salvage to unlock
}

export const FRAMES: FrameDef[] = [
  { name: 'DUNE SKIMMER', desc: 'fast · fragile · 4 legs', legPairs: 2, maxSpd: 12, hp: 60, scale: 0.75, gunSlots: 0 },
  { name: 'TRAMPLER MK.I', desc: 'balanced · 6 legs · 1 gun seat', legPairs: 3, maxSpd: 9, hp: 100, scale: 1.0, gunSlots: 1 },
  { name: 'FORTRESS', desc: 'slow · armoured · 8 legs · 2 gun seats', legPairs: 4, maxSpd: 6, hp: 180, scale: 1.35, gunSlots: 2, cost: 100 },
  { name: 'ORNITHOPTER', desc: 'flies · very fragile · no boarding', legPairs: 0, maxSpd: 16, hp: 30, scale: 0.6, gunSlots: 0, flying: true, cost: 60 },
];

export const HOVER_HEIGHT = 12; // must match server
export const FORTRESS_COST = 100; // banked salvage; must match server
export const THOPTER_COST = 60;
export const REPAIR_COST = 15;

// salvage tiers — order/values must match ITEM_VALUES in server/src/lib.rs
export const ITEMS = [
  { name: 'scrap', value: 1, beam: 0xe8b04a },
  { name: 'alloy', value: 3, beam: 0x4ab0e8 },
  { name: 'relic', value: 8, beam: 0xb04ae8 },
];

// deck offsets of mounted-gun slots at scale 1 — must match gun_slot_offset
export const GUN_SLOT_OFFSETS: [number, number, number][] = [
  [-2.2, 2.6, -0.5],
  [2.2, 2.6, 0.5],
];

// dieselpunk hull tints
export const HULL_COLORS = [0x5a4a3a, 0x6e3a2a, 0x3a4a5a, 0x4a5a3a, 0x5a3a5a, 0x2e2a26];
