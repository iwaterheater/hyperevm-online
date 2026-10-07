// Constants, data tables and formulas shared by the server and the client.

export const TICK = 1 / 15;
export const ATTACK_WINDUP = 0.4;   // seconds between a monster starting its swing and the hit landing

// hp, pAtk: at level 1. pDef / mDef: multipliers on the level-based defence (warriors shrug off blades, mages shrug off spells).
// eva: bonus to evasion.
export const MOB_TYPES = {
  chaser:  { name: 'Skeleton Minion',  r: 0.7,  hp: 30,   speed: 3.0, pAtk: 14, pDef: 1,   mDef: 1,   eva: 0, xp: 10,  color: 0xff3b8d },
  runner:  { name: 'Skeleton Rogue',   r: 0.45, hp: 15,   speed: 5.2, pAtk: 8,  pDef: 0.7, mDef: 0.9, eva: 6, xp: 8,   color: 0xff9a3b },
  shooter: { name: 'Skeleton Mage',    r: 0.6,  hp: 30,   speed: 2.4, pAtk: 11, pDef: 0.7, mDef: 1.6, eva: 0, xp: 16,  color: 0xffe14d, magic: true },
  tank:    { name: 'Skeleton Warrior', r: 1.3,  hp: 140,  speed: 1.8, pAtk: 28, pDef: 1.6, mDef: 0.8, eva: 0, xp: 45,  color: 0xb04dff },
  boss:    { name: 'Skeleton King',    r: 2.8,  hp: 1600, speed: 2.2, pAtk: 20, pDef: 1.5, mDef: 1.5, eva: 2, xp: 600, color: 0xff2244, magic: true },
};
export const MOB_KEYS = Object.keys(MOB_TYPES);
// How far monsters sense and roam, in world units; the map editor draws its threat rings from the same numbers.
export const AGGRO_R = 13;        // a monster notices a player this close
export const BOSS_AGGRO_R = 20;   // the same for a boss
export const LEASH_R = 30;        // it only picks a target while it is this close to its home
export const WANDER_R = 5;        // an idle monster strolls this far from its home on each axis

// A monster's combat stats at a given level.
export function mobStats(type, level) {
  const d = MOB_TYPES[type];
  return {
    maxHp: Math.ceil(d.hp * (1 + 0.45 * (level - 1))),
    pAtk: Math.round(d.pAtk * (1 + 0.15 * (level - 1))),
    pDef: Math.round((15 + 3 * level) * d.pDef),
    mDef: Math.round((12 + 2.5 * level) * d.mDef),
    acc: level + 10,
    eva: level + 6 + d.eva,
  };
}

// ---------------------------------------------------------------- classes

// Two starting classes; at PROFESSION_LEVEL each branches into professions (`base` names the parent).
// attr: the six base attributes - STR, DEX, CON, INT, WIT, MEN - from which every combat stat is derived (see statsOf).
// armor: base physical defence of what the class wears. reach: auto-attack range.
export const CLASSES = {
  fighter: { name: 'Fighter', base: null, attr: [40, 30, 43, 21, 11, 25], armor: 40, reach: 2.4,
    weapon: 'sword', hoodie: 0x35523f, text: 'Fights up close with a sword. Tough and simple to play.' },
  mystic: { name: 'Mystic', base: null, attr: [22, 21, 27, 41, 20, 39], armor: 22, reach: 2.4,
    weapon: 'staff', hoodie: 0x3b4a8a, text: 'Casts spells from a distance. Fragile, lives on mana.' },
  knight: { name: 'Knight', base: 'fighter', attr: [40, 28, 48, 21, 11, 27], armor: 62, reach: 2.4,
    weapon: 'shield', hoodie: 0x5a6470, text: 'Tank: heavy defence, a shield, and skills that pull monsters onto himself.' },
  rogue: { name: 'Rogue', base: 'fighter', attr: [41, 46, 36, 21, 12, 24], armor: 32, reach: 2.4,
    weapon: 'daggers', hoodie: 0x6a2a2a, text: 'Melee damage: fast twin daggers, frequent critical hits, a quick dash.' },
  archer: { name: 'Archer', base: 'fighter', attr: [39, 44, 34, 21, 13, 26], armor: 30, reach: 18, ranged: true,
    weapon: 'bow', hoodie: 0x6a6a2a, text: 'Ranged damage: shoots a bow from far away, weak when cornered.' },
  wizard: { name: 'Wizard', base: 'mystic', attr: [21, 21, 27, 46, 26, 41], armor: 22, reach: 2.4,
    weapon: 'staff', hoodie: 0x5a2f7a, text: 'Magic damage: fire, wide area spells, and putting monsters to sleep.' },
  cleric: { name: 'Cleric', base: 'mystic', attr: [24, 22, 33, 37, 22, 45], armor: 34, reach: 2.4,
    weapon: 'staff', hoodie: 0xcfc9ae, text: 'Support: heals and blesses everyone nearby, raises the fallen.' },
};
export const ATTR_NAMES = ['STR', 'DEX', 'CON', 'INT', 'WIT', 'MEN'];
// What each kind of weapon contributes: attack values, base attack speed, critical rate (per 1000) and extra defence.
export const WEAPONS = {
  sword:   { pAtk: 18, mAtk: 6,  spd: 300, crit: 20,  pDef: 0 },
  shield:  { pAtk: 17, mAtk: 6,  spd: 290, crit: 20,  pDef: 15 },
  daggers: { pAtk: 16, mAtk: 6,  spd: 400, crit: 120, pDef: 0 },
  bow:     { pAtk: 26, mAtk: 6,  spd: 160, crit: 60,  pDef: 0 },
  staff:   { pAtk: 9,  mAtk: 24, spd: 250, crit: 10,  pDef: 0 },
};
export const CLASS_KEYS = Object.keys(CLASSES);
export const START_CLASSES = CLASS_KEYS.filter((k) => !CLASSES[k].base);
export const PROFESSION_LEVEL = 20;
export const professionsOf = (cls) => CLASS_KEYS.filter((k) => CLASSES[k].base === cls);
export const classLine = (cls) => (CLASSES[cls].base ? [CLASSES[cls].base, cls] : [cls]);

// ---------------------------------------------------------------- skills

// Skills are bought from the Sage with SP. `sp` lists the cost of each rank (a cost of 0 is granted for free with the class);
// values given as arrays hold one entry per rank.
// kind: strike (melee hit on the target) | shot (physical projectile) | bolt (magic projectile) | ground (area at the cursor)
//     | heal | buff | taunt | sleep | dash | revive | passive
export const SKILLS = {
  // Fighter
  power_strike: { name: 'Power Strike', cls: 'fighter', lvl: 1, kind: 'strike', power: [3.5, 4.5, 5.5], mp: 6, cd: 5, sp: [0, 60, 220],
    text: 'A heavy blow at your target.' },
  weapon_mastery: { name: 'Weapon Mastery', cls: 'fighter', lvl: 3, kind: 'passive', stat: 'patk', add: [0.08, 0.16, 0.24], sp: [40, 150, 400],
    text: 'Permanently raises physical attack.' },
  stun_strike: { name: 'Stun Strike', cls: 'fighter', lvl: 5, kind: 'strike', power: [2, 2.6], stun: [2, 3], mp: 10, cd: 12, sp: [120, 350],
    text: 'Hits the target and stuns it for a few seconds.' },
  war_cry: { name: 'War Cry', cls: 'fighter', lvl: 8, kind: 'buff', stat: 'patk', mult: [1.2, 1.3], dur: 20, mp: 12, cd: 30, sp: [300, 700],
    text: 'Raises your physical attack for 20 seconds.' },
  armor_mastery: { name: 'Armor Mastery', cls: 'fighter', lvl: 12, kind: 'passive', stat: 'pdef', add: [0.1, 0.2, 0.3], sp: [700, 1400, 2500],
    text: 'Permanently raises defence.' },

  // Mystic
  bolt: { name: 'Arcane Bolt', cls: 'mystic', lvl: 1, kind: 'bolt', fx: 'arcane', power: [3, 3.8, 4.6], mp: 8, cast: 0.65, cd: 0, range: 22, sp: [0, 60, 220],
    text: 'A homing bolt of magic at your target.' },
  mend: { name: 'Mend', cls: 'mystic', lvl: 3, kind: 'heal', power: [40, 60, 85], mp: 14, cast: 1, cd: 6, sp: [40, 150, 400],
    text: 'Restores your health.' },
  frost_bolt: { name: 'Frost Bolt', cls: 'mystic', lvl: 5, kind: 'bolt', fx: 'frost', power: [2.4, 3.2], slow: [0.5, 0.4], slowDur: 4, mp: 10, cast: 0.8, cd: 6, range: 22, sp: [120, 350],
    text: 'Damages the target and slows it for 4 seconds.' },
  starfall: { name: 'Starfall', cls: 'mystic', lvl: 8, kind: 'ground', power: [10, 13], radius: 4.5, range: 16, delay: 0.45, mp: 22, cast: 0.9, cd: 6, sp: [300, 700],
    text: 'A falling star blasts the area under the cursor.' },
  mana_mastery: { name: 'Mana Mastery', cls: 'mystic', lvl: 12, kind: 'passive', stat: 'mp', add: [0.12, 0.24, 0.36], sp: [700, 1400, 2500],
    text: 'Permanently raises maximum mana.' },

  // Knight
  provoke: { name: 'Provoke', cls: 'knight', lvl: 20, kind: 'taunt', radius: 10, mp: 8, cd: 10, sp: [0, 900],
    text: 'Forces every monster nearby to attack you instead of your allies.' },
  shield_bash: { name: 'Shield Bash', cls: 'knight', lvl: 22, kind: 'strike', power: [1.5, 2], stun: [3, 4], mp: 12, cd: 12, sp: [800, 1600],
    text: 'Slams the target with the shield, stunning it for longer.' },
  iron_wall: { name: 'Iron Wall', cls: 'knight', lvl: 25, kind: 'buff', stat: 'pdef', mult: [2, 2.5], dur: 10, mp: 15, cd: 40, sp: [1200, 2400],
    text: 'Doubles your defence for 10 seconds.' },
  shield_mastery: { name: 'Shield Mastery', cls: 'knight', lvl: 28, kind: 'passive', stat: 'pdef', add: [0.15, 0.3], sp: [1800, 3200],
    text: 'Permanently raises defence further.' },

  // Rogue
  backstab: { name: 'Backstab', cls: 'rogue', lvl: 20, kind: 'strike', power: [5, 6.5], mp: 10, cd: 6, sp: [0, 900],
    text: 'A vicious stab for very high damage.' },
  shadow_step: { name: 'Shadow Step', cls: 'rogue', lvl: 22, kind: 'dash', mp: 6, cd: 6, sp: [800],
    text: 'Dash forward; you cannot be hit while dashing.' },
  rend: { name: 'Rend', cls: 'rogue', lvl: 25, kind: 'strike', power: [1.5, 2], dot: [1.2, 1.8], dotDur: 5, mp: 10, cd: 10, sp: [1200, 2400],
    text: 'Opens a wound that bleeds for 5 seconds.' },
  crit_mastery: { name: 'Critical Mastery', cls: 'rogue', lvl: 28, kind: 'passive', stat: 'crit', add: [0.08, 0.16], sp: [1800, 3200],
    text: 'Permanently raises the chance of a critical hit.' },

  // Archer
  power_shot: { name: 'Power Shot', cls: 'archer', lvl: 20, kind: 'shot', fx: 'arrow', power: [4, 5.2], mp: 8, cast: 0.5, cd: 4, range: 22, sp: [0, 900],
    text: 'A carefully aimed, powerful arrow.' },
  volley: { name: 'Volley', cls: 'archer', lvl: 22, kind: 'ground', phys: true, power: [6, 8], radius: 4, range: 18, delay: 0.35, mp: 16, cast: 0.7, cd: 8, sp: [800, 1600],
    text: 'Rains arrows on the area under the cursor.' },
  pinning_shot: { name: 'Pinning Shot', cls: 'archer', lvl: 25, kind: 'shot', fx: 'arrow', power: [2, 2.6], stun: [2.5, 3.5], mp: 12, cast: 0.5, cd: 12, range: 22, sp: [1200, 2400],
    text: 'Pins the target in place for a few seconds.' },
  eagle_eye: { name: 'Eagle Eye', cls: 'archer', lvl: 28, kind: 'passive', stat: 'crit', add: [0.08, 0.16], sp: [1800, 3200],
    text: 'Permanently raises the chance of a critical hit.' },

  // Wizard
  fireball: { name: 'Fireball', cls: 'wizard', lvl: 20, kind: 'bolt', fx: 'fire', power: [6, 7.5], mp: 14, cast: 0.9, cd: 0, range: 24, sp: [0, 900],
    text: 'A ball of fire for heavy damage.' },
  inferno: { name: 'Inferno', cls: 'wizard', lvl: 22, kind: 'ground', power: [16, 20], radius: 6, range: 18, delay: 0.5, mp: 34, cast: 1.2, cd: 10, sp: [800, 1600],
    text: 'Sets a wide area under the cursor ablaze.' },
  slumber: { name: 'Slumber', cls: 'wizard', lvl: 25, kind: 'sleep', dur: [6, 9], mp: 14, cast: 0.8, cd: 15, range: 22, sp: [1200, 2400],
    text: 'Puts the target to sleep until it is damaged.' },
  spell_mastery: { name: 'Spell Mastery', cls: 'wizard', lvl: 28, kind: 'passive', stat: 'matk', add: [0.1, 0.2], sp: [1800, 3200],
    text: 'Permanently raises magic attack.' },

  // Cleric
  healing_circle: { name: 'Healing Circle', cls: 'cleric', lvl: 20, kind: 'heal', power: [70, 100], radius: 9, mp: 22, cast: 1, cd: 6, sp: [0, 900],
    text: 'Heals you and every player nearby.' },
  blessing_might: { name: 'Blessing of Might', cls: 'cleric', lvl: 22, kind: 'buff', stat: 'atk', mult: [1.15, 1.25], dur: 60, radius: 9, mp: 20, cd: 20, sp: [800, 1600],
    text: 'Raises the damage of everyone nearby for a minute.' },
  blessing_ward: { name: 'Blessing of Ward', cls: 'cleric', lvl: 25, kind: 'buff', stat: 'pdef', mult: [1.25, 1.4], dur: 60, radius: 9, mp: 20, cd: 20, sp: [1200, 2400],
    text: 'Raises the defence of everyone nearby for a minute.' },
  resurrection: { name: 'Resurrection', cls: 'cleric', lvl: 28, kind: 'revive', radius: 8, mp: 40, cast: 2, cd: 60, sp: [1800],
    text: 'Raises fallen players nearby on the spot.' },
};
export const SKILL_KEYS = Object.keys(SKILLS);

// every skill a character of this class can ever learn, starting class first
export const skillsFor = (cls) => SKILL_KEYS.filter((id) => classLine(cls).includes(SKILLS[id].cls));
// the active skills a character has learned and can use, in the order of the skill table
export const activeSkills = (cls, learned) => skillsFor(cls).filter((id) => SKILLS[id].kind !== 'passive' && learned[id] > 0);

// ---------------------------------------------------------------- items

// What a cat can wear, and in what order the slots travel in a look code.
export const EQUIP_SLOTS = ['weapon', 'head', 'body', 'hands', 'feet'];
export const SLOT_NAMES = { weapon: 'Weapon', head: 'Head', body: 'Body', hands: 'Hands', feet: 'Feet' };
// Gear comes in tiers. id / arms: the prefix of the item ids of armour / of weapons. lvl: the level needed to wear it.
// price: of a helmet; other pieces cost a multiple of it. color: the tint of the piece on the cat and of its icon.
export const TIERS = [
  { id: 'leather', arms: 'bronze', name: 'Leather', lvl: 1,  price: 30,   color: 0xa9713c },
  { id: 'iron',    arms: 'iron',   name: 'Iron',    lvl: 5,  price: 120,  color: 0x9aa5b4 },
  { id: 'steel',   arms: 'steel',  name: 'Steel',   lvl: 10, price: 400,  color: 0xd3e2f4 },
  { id: 'hypurr',  arms: 'hypurr', name: 'Hypurr',  lvl: 15, price: 1200, color: 0x3fd9b0 },
];
// Armour by slot, one value per tier. Any class wears any of it. Bonuses are added where the class's own base values
// are (see statsOf), so P.Def and M.Def grow with the level like the rest of the defence.
const ARMOR = {
  head:  { cost: 1,   names: ['Leather Cap', 'Iron Helmet', 'Steel Helm', 'Hypurr Crown'],            pDef: [2, 5, 8, 12],   mDef: [3, 6, 10, 15] },
  body:  { cost: 1.5, names: ['Leather Tunic', 'Iron Breastplate', 'Steel Cuirass', 'Hypurr Plate'],  pDef: [5, 11, 18, 27] },
  hands: { cost: 0.8, names: ['Leather Gloves', 'Iron Gauntlets', 'Steel Gauntlets', 'Hypurr Claws'], pDef: [2, 4, 7, 10],   acc: [1, 2, 3, 4] },
  feet:  { cost: 0.9, names: ['Leather Boots', 'Iron Greaves', 'Steel Sabatons', 'Hypurr Striders'],  pDef: [2, 5, 8, 12],   speed: [2, 4, 6, 8] },
};
// Weapons by family. Any class may wield any of them; what is in the paw decides how the cat fights (see fightStyle).
const ARMS = {
  sword:   { names: ['Bronze Sword', 'Iron Sword', 'Steel Sword', 'Hypurr Blade'],        pAtk: [4, 8, 14, 20] },
  daggers: { names: ['Bronze Daggers', 'Iron Daggers', 'Steel Daggers', 'Hypurr Fangs'],  pAtk: [3, 7, 12, 18], crit: [10, 20, 30, 40] },
  bow:     { names: ['Short Bow', 'Hunting Bow', 'Composite Bow', 'Hypurr Longbow'],      pAtk: [5, 12, 20, 29] },
  staff:   { names: ['Apprentice Staff', 'Adept Staff', 'Mage Staff', 'Hypurr Staff'],    mAtk: [5, 11, 18, 26], pAtk: [1, 3, 5, 7] },
};
const WEAPON_COST = 2;
export const WEAPON_FAMILIES = Object.keys(ARMS);
export const BONUS_KEYS = ['pAtk', 'mAtk', 'pDef', 'mDef', 'acc', 'crit', 'speed'];
export const BONUS_NAMES = { pAtk: 'P. Atk', mAtk: 'M. Atk', pDef: 'P. Def', mDef: 'M. Def', acc: 'Accuracy', crit: 'Critical', speed: 'Speed' };

// Every item of the game, by id.
//   kind: weapon | armor | potion      slot: where it is worn (gear only)       family: the weapon family (weapons only)
//   tier: index into TIERS (gear)      lvl: level needed to wear it             price: what the Trader asks for it
//   bonus: what it adds while worn     hp / mp: what a potion restores
export const ITEMS = {
  hp_small: { name: 'Lesser Health Potion', kind: 'potion', hp: 80,  price: 12 },
  hp_large: { name: 'Health Potion',        kind: 'potion', hp: 250, price: 40 },
  mp_small: { name: 'Lesser Mana Potion',   kind: 'potion', mp: 50,  price: 12 },
  mp_large: { name: 'Mana Potion',          kind: 'potion', mp: 160, price: 40 },
};
TIERS.forEach((tier, t) => {
  const bonusOf = (row) => Object.fromEntries(BONUS_KEYS.filter((k) => row[k]).map((k) => [k, row[k][t]]));
  for (const [slot, row] of Object.entries(ARMOR)) {
    ITEMS[`${tier.id}_${slot}`] = { name: row.names[t], kind: 'armor', slot, tier: t, lvl: tier.lvl, price: Math.round(tier.price * row.cost), bonus: bonusOf(row) };
  }
  for (const [family, row] of Object.entries(ARMS)) {
    ITEMS[`${tier.arms}_${family}`] = { name: row.names[t], kind: 'weapon', slot: 'weapon', family, tier: t, lvl: tier.lvl, price: tier.price * WEAPON_COST, bonus: bonusOf(row) };
  }
});
export const ITEM_KEYS = Object.keys(ITEMS);
// The item of an id that came from outside (a client, a save file): "constructor" is not an item, and neither is 7.
export const itemOf = (id) => (typeof id === 'string' && Object.hasOwn(ITEMS, id) ? ITEMS[id] : undefined);

export const BAG_SIZE = 30;       // stacks a bag holds
export const STACK_MAX = 99;      // potions in one stack; gear does not stack
export const POTION_CD = 6;       // seconds before the next potion of any kind
export const SELL_RATE = 0.3;     // the share of its price the Trader pays for an item
export const SHOP_TIER = 1;       // the best tier the Trader sells; better gear is only found
export const STARTER_KIT = [['hp_small', 5]];   // what a new character has in its bag
export const stackMax = (id) => (ITEMS[id].kind === 'potion' ? STACK_MAX : 1);
export const sellPrice = (id) => Math.max(1, Math.floor(ITEMS[id].price * SELL_RATE));
// What the Trader sells, in the order of his list.
export const SHOP = ITEM_KEYS.filter((id) => ITEMS[id].kind === 'potion' || ITEMS[id].tier <= SHOP_TIER);

// The weapon a class starts with and holds while its weapon slot is empty. The knight fights with a sword too; his
// shield is part of his look, not an item.
export const weaponFamily = (cls) => (CLASSES[cls].weapon === 'shield' ? 'sword' : CLASSES[cls].weapon);
// The kind of weapon in the paw: that of the equipped weapon, else the class's own.
export const heldFamily = (cls, equip) => itemOf(equip?.weapon)?.family ?? weaponFamily(cls);
// How a cat fights follows what it holds, not its class: a bow shoots from afar, everything else strikes up close.
export const MELEE_REACH = 2.4, BOW_REACH = 18;
export function fightStyle(cls, family = weaponFamily(cls)) {
  const ranged = family === 'bow';
  return { ranged, reach: ranged ? BOW_REACH : MELEE_REACH };
}
// Why this character cannot wear an item, as a line for the player; '' when it can.
export function equipError(cls, level, id) {
  const it = itemOf(id);
  if (!it || !it.slot) return 'That cannot be equipped';
  if (level < it.lvl) return `${it.name} requires level ${it.lvl}`;
  return '';
}
// An item in a slot counts when it belongs there.
const worn = (equip, slot) => {
  const it = itemOf(equip?.[slot]);
  return it && it.slot === slot ? it : null;
};
// The sum of what the equipment adds, by bonus key. `equip` maps a slot to an item id (or null).
export function equipBonus(equip, cls) {
  const sum = Object.fromEntries(BONUS_KEYS.map((k) => [k, 0]));
  for (const slot of EQUIP_SLOTS) {
    const it = worn(equip, slot);
    if (it) for (const [k, v] of Object.entries(it.bonus)) sum[k] += v;
  }
  return sum;
}

// A bag is a list of stacks, [id, count], at most BAG_SIZE of them, without holes.
// How many of `n` more of an item would fit.
export function roomFor(inv, id, n = 1) {
  const max = stackMax(id);
  let room = (BAG_SIZE - inv.length) * max;
  for (const s of inv) if (s[0] === id) room += max - s[1];
  return Math.min(n, room);
}
// Puts up to `n` of an item into the bag - onto the stacks of its kind first - and returns how many went in.
export function addItem(inv, id, n = 1) {
  const max = stackMax(id);
  let left = n;
  for (const s of inv) {
    if (left <= 0) break;
    if (s[0] !== id || s[1] >= max) continue;
    const put = Math.min(left, max - s[1]);
    s[1] += put; left -= put;
  }
  while (left > 0 && inv.length < BAG_SIZE) {
    const put = Math.min(left, max);
    inv.push([id, put]); left -= put;
  }
  return n - left;
}
// Takes `n` off the stack at index i; a stack that runs out leaves the bag. False when the stack does not hold that many.
export function takeItem(inv, i, n = 1) {
  const s = inv[i];
  if (!s || !Number.isInteger(n) || n < 1 || s[1] < n) return false;
  s[1] -= n;
  if (!s[1]) inv.splice(i, 1);
  return true;
}
// A bag and an equipment as a save file holds them, made safe: whatever is not a known item in a sane amount is left
// out, so an old save, a hand-edited one or one from a version with other items always loads.
export function cleanBag(raw) {
  const inv = [];
  if (!Array.isArray(raw)) return inv;
  for (const s of raw) {
    if (!Array.isArray(s) || !itemOf(s[0]) || !Number.isInteger(s[1]) || s[1] < 1) continue;
    addItem(inv, s[0], Math.min(s[1], STACK_MAX * BAG_SIZE));
  }
  return inv;
}
export function cleanEquip(raw) {
  const equip = {};
  for (const slot of EQUIP_SLOTS) equip[slot] = raw && typeof raw === 'object' && worn(raw, slot) ? raw[slot] : null;
  return equip;
}

// What other players need to DRAW a cat: per slot 0 (nothing) or the tier + 1, and after the slots the kind of weapon
// in the paw (0 = none equipped, else the family's place in WEAPON_FAMILIES + 1), as the digits of one number.
const LOOK_BASE = Math.max(TIERS.length, WEAPON_FAMILIES.length) + 1;
export function lookCode(equip) {
  let code = 0;
  EQUIP_SLOTS.forEach((slot, i) => {
    const it = worn(equip, slot);
    if (it) code += (it.tier + 1) * LOOK_BASE ** i;
  });
  const held = worn(equip, 'weapon');
  if (held) code += (WEAPON_FAMILIES.indexOf(held.family) + 1) * LOOK_BASE ** EQUIP_SLOTS.length;
  return code;
}
// -> { weapon, head, body, hands, feet, family }: the tier worn in each slot (-1 for nothing) and the family of the
// equipped weapon (null when the slot is empty)
export function lookOf(code) {
  const n = Number.isInteger(code) && code > 0 ? code : 0, digit = (i) => Math.floor(n / LOOK_BASE ** i) % LOOK_BASE;
  const look = Object.fromEntries(EQUIP_SLOTS.map((slot, i) => [slot, Math.min(TIERS.length, digit(i)) - 1]));
  look.family = WEAPON_FAMILIES[digit(EQUIP_SLOTS.length) - 1] ?? null;
  return look;
}

// ---- the action bar: BAR_SIZE slots on the keys 1 - 9 and 0. A slot is empty (null) or holds the id of an active skill
// or of an item; the two tables share no id (a test keeps it that way), so the id alone says which of the two it is.

export const BAR_SIZE = 10;
// The skill of an id that came from outside, when it is one a slot can hold: a passive skill has nothing to press.
export const barSkill = (id) => (typeof id === 'string' && Object.hasOwn(SKILLS, id) && SKILLS[id].kind !== 'passive' ? SKILLS[id] : undefined);
// A bar as a client or a save file gives it, made safe: always BAR_SIZE slots, and whatever is not an active skill or an
// item is an empty slot. Whether the character has learned the skill or owns the item is not asked: a slot keeps its
// potion when the last one is drunk, and says "not learned" for a skill the character does not have.
export function cleanBar(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: BAR_SIZE }, (_, i) => (barSkill(list[i]) || itemOf(list[i]) ? list[i] : null));
}
// The bar of a character that has never arranged one: its learned skills from the first slot on, and a health and a
// mana potion on the last two - the kind it carries, else the lesser one, which is what every new cat starts with.
export function defaultBar(cls, learned, inv = []) {
  const bar = cleanBar(activeSkills(cls, learned).slice(0, BAR_SIZE - 2));
  ['hp', 'mp'].forEach((kind, i) => {
    const carried = inv.find((s) => itemOf(s[0])?.[kind]);
    bar[BAR_SIZE - 2 + i] = carried ? carried[0] : `${kind}_small`;
  });
  return bar;
}
// Puts a newly learned skill into the first empty slot. False when it is on the bar already, or when the bar is full:
// then it waits in the skill book to be dragged.
export function barAdd(bar, id) {
  const i = barSkill(id) && !bar.includes(id) ? bar.indexOf(null) : -1;
  if (i < 0) return false;
  bar[i] = id;
  return true;
}

// ---- loot. `rnd` is Math.random or a test's stand-in; every function draws from it in a fixed order.

// The chance that a monster leaves a piece of gear, at level 1; it grows by 4 % of itself with each level.
const GEAR_CHANCE = { chaser: 0.06, runner: 0.05, shooter: 0.08, tank: 0.2, boss: 1 };
export const POTION_CHANCE = 0.12;
export const gearChance = (type, lvl) => Math.min(1, GEAR_CHANCE[type] * (1 + 0.04 * (lvl - 1)));
// The best tier a character - or the loot of a monster - of this level can be.
export const tierForLevel = (lvl) => TIERS.reduce((best, tier, t) => (lvl >= tier.lvl ? t : best), 0);
// One piece of gear of a tier: armour twice as often as a weapon, every family and slot alike.
function pickGear(t, r) {
  const pool = [];
  for (const slot of Object.keys(ARMOR)) pool.push(`${TIERS[t].id}_${slot}`, `${TIERS[t].id}_${slot}`);
  for (const family of WEAPON_FAMILIES) pool.push(`${TIERS[t].arms}_${family}`);
  return pool[Math.min(pool.length - 1, Math.floor(r * pool.length))];
}
const pickPotion = (strong, r) => `${r < 0.6 ? 'hp' : 'mp'}_${strong ? 'large' : 'small'}`;
// What a killed monster leaves in the bag of a player: a list of [id, count], often empty. Gear matches the monster's
// level (one time in four it is a tier below); the boss always leaves a piece of the top tier, and potions.
export function rollLoot(type, lvl, rnd = Math.random) {
  const out = [], boss = type === 'boss';
  if (rnd() < gearChance(type, lvl)) {
    let t = boss ? TIERS.length - 1 : tierForLevel(lvl);
    if (!boss && t > 0 && rnd() < 0.25) t--;
    out.push([pickGear(t, rnd()), 1]);
  }
  if (boss || rnd() < POTION_CHANCE) out.push([pickPotion(lvl >= 8, rnd()), boss ? 3 : 1]);
  return out;
}
// What a treasure chest holds besides its gold: the richer the chest, the better. `big` is the King's hoard.
export function chestLoot(gold, big, rnd = Math.random) {
  const out = [], t = big ? TIERS.length - 1 : gold >= 80 ? 2 : gold >= 30 ? 1 : 0;
  if (rnd() < 0.4) out.push([pickPotion(t > 0, rnd()), rnd() < 0.3 ? 2 : 1]);
  if (rnd() < (big ? 0.5 : 0.1)) out.push([pickGear(t, rnd()), 1]);
  return out;
}

// ---------------------------------------------------------------- stats

// Every combat stat of a character, derived from its class attributes, level, weapon upgrade level, passive skills,
// active buffs (`buffs` maps a stat name to a multiplier) and what it wears (`equip` maps a slot to an item id).
// A weapon item adds to what the class's basic weapon gives, so the Blacksmith's upgrades multiply both.
//   STR -> P.Atk      DEX -> Atk.Spd, Accuracy, Evasion, Critical, Speed      CON -> HP
//   INT -> M.Atk      WIT -> Casting Spd, M.Critical                         MEN -> M.Def, MP
export function statsOf(cls, level, learned = {}, weapon = 1, buffs = {}, equip = null) {
  const c = CLASSES[cls], w = WEAPONS[c.weapon], gear = equipBonus(equip, cls);
  const [STR, DEX, CON, INT, WIT, MEN] = c.attr;
  const passive = (stat) => {
    let v = 0;
    for (const id of skillsFor(cls)) {
      const s = SKILLS[id], rank = learned[id] | 0;
      if (s.kind === 'passive' && s.stat === stat && rank > 0) v += s.add[Math.min(rank, s.add.length) - 1];
    }
    return v;
  };
  const buff = (stat) => buffs[stat] || 1;
  const grade = 1 + 0.4 * (weapon - 1);          // the Blacksmith's upgrades
  const atkLevel = 1 + 0.1 * (level - 1), defLevel = 1 + 0.05 * (level - 1);
  const atkSpd = Math.round(w.spd * (1 + (DEX - 30) * 0.012));
  const castSpd = Math.round(333 * (1 + (WIT - 20) * 0.02));
  const speed = Math.round(100 + DEX * 0.6) + gear.speed;
  return {
    STR, DEX, CON, INT, WIT, MEN,
    maxHp: Math.round((80 + 20 * (level - 1)) * (1 + (CON - 30) * 0.03)),
    maxMp: Math.round((40 + 9 * (level - 1)) * (1 + (MEN - 20) * 0.05) * (1 + passive('mp'))),
    pAtk: Math.round((w.pAtk + gear.pAtk) * grade * atkLevel * (1 + (STR - 40) * 0.025) * (1 + passive('patk')) * buff('patk') * buff('atk')),
    mAtk: Math.round((w.mAtk + gear.mAtk) * grade * atkLevel * (1 + (INT - 41) * 0.03) * (1 + passive('matk')) * buff('atk')),
    pDef: Math.round((c.armor + w.pDef + gear.pDef) * defLevel * (1 + passive('pdef')) * buff('pdef')),
    mDef: Math.round((20 + gear.mDef) * defLevel * (1 + (MEN - 20) * 0.04)),
    acc: Math.round(level + DEX * 0.3 + 5) + gear.acc,
    eva: Math.round(level + DEX * 0.3),
    crit: Math.round(DEX * 2 + w.crit + passive('crit') * 1000) + gear.crit,   // per 1000, as the status window shows it
    mCrit: Math.round(WIT * 2),
    atkSpd, castSpd, speed,
    atkCd: 150 / atkSpd,          // seconds between auto-attacks
    castMult: 333 / castSpd,      // multiplier on the cast time of spells
    move: speed * 0.075,          // world units per second
  };
}

// Spells are sped up by Casting Spd; physical skills keep their own timing.
export const isSpell = (s) => ['bolt', 'heal', 'sleep', 'buff', 'revive'].includes(s.kind) || (s.kind === 'ground' && !s.phys);
export const castTime = (s, st) => (s.cast || 0) * (isSpell(s) ? st.castMult : 1);

// Damage after the target's defence, and the chance of a physical attack landing.
export const mitigate = (attack, defence) => attack * 100 / (100 + defence);
export const hitChance = (acc, eva) => Math.max(0.4, Math.min(0.98, 0.9 + (acc - eva) * 0.015));

// ---------------------------------------------------------------- progression

export const xpNext = (level) => 100 * level * level;
export const spFor = (xp) => Math.ceil(xp / 8);                  // skill points earned along with experience
export const DEATH_XP_LOSS = 0.04;                               // share of the current level's experience lost on death
export const upgradeCost = (weapon) => 40 * weapon;

// ---------------------------------------------------------------- world

// The world itself - regions, monster camps, chests, townsfolk, the start point - is data: map/world.json, read through
// src/map/format.js. Only how far a player can reach is a rule of the game.
export const SHOP_RANGE = 5.5;    // how close to the Blacksmith, the Sage or the Trader a player has to stand to deal with them
export const CHEST_REACH = 1.9;   // how close to a chest a player has to come to open it
