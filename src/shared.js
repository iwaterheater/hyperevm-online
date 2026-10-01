// Constants and formulas shared by the server and the client.

export const WORLD_R = 260;
export const TOWN_R = 16;
export const TICK = 1 / 15;

export const MOB_TYPES = {
  chaser:  { r: 0.7,  hp: 3,   speed: 4.2, dmg: 10, xp: 10,  color: 0xff3b8d },
  runner:  { r: 0.45, hp: 1.5, speed: 7.2, dmg: 6,  xp: 8,   color: 0xff9a3b },
  shooter: { r: 0.6,  hp: 3,   speed: 3.2, dmg: 8,  xp: 16,  color: 0xffe14d },
  tank:    { r: 1.3,  hp: 14,  speed: 2.4, dmg: 20, xp: 45,  color: 0xb04dff },
  boss:    { r: 2.8,  hp: 160, speed: 3.0, dmg: 14, xp: 600, color: 0xff2244 },
};
export const MOB_KEYS = Object.keys(MOB_TYPES);

export const xpNext = (level) => Math.round(50 * Math.pow(level, 1.5));
export const maxHpFor = (level) => 100 + 20 * (level - 1);
export const dmgMult = (level, weapon) => (1 + 0.4 * (weapon - 1)) * (1 + 0.08 * (level - 1));
export const upgradeCost = (weapon) => 40 * weapon;

// One seamless world: concentric zones around the town, harder the further out you go.
export const ZONES = [
  { r: TOWN_R, name: 'Hypercat Town' },
  { r: 95, name: 'Green Meadows · Lv 1–4', lvl: [1, 4], mobs: 110, types: ['chaser', 'chaser', 'chaser', 'runner', 'runner'] },
  { r: 175, name: 'Graveyard Wastes · Lv 5–9', lvl: [5, 9], mobs: 130, types: ['chaser', 'runner', 'shooter', 'shooter'] },
  { r: WORLD_R, name: 'Cursed Lands · Lv 10–15', lvl: [10, 15], mobs: 150, types: ['chaser', 'runner', 'shooter', 'tank', 'tank'] },
];
export const zoneAt = (dist) => ZONES.find((z) => dist <= z.r) || ZONES[ZONES.length - 1];

export const BOSS = { x: 0, z: -228, lvl: 18 };
