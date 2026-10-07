// Items (src/shared.js): the item table, what equipment does to the stats, who may wear what, the two paws (one-handed
// and two-handed weapons, shields), the bag, what a save file may hold, the look code other players draw a cat from,
// and loot.
// Run: node --test test/items.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASSES, CLASS_KEYS, WEAPONS, MOB_KEYS, statsOf,
  ITEMS, ITEM_KEYS, TIERS, EQUIP_SLOTS, SLOT_NAMES, BONUS_KEYS, BONUS_NAMES, WEAPON_FAMILIES, heldFamily, fightStyle, MELEE_REACH, BOW_REACH, BAG_SIZE, STACK_MAX, SELL_RATE, SHOP, SHOP_TIER,
  STARTER_KIT, KNIGHT_SHIELD, itemOf, stackMax, sellPrice, weaponFamily, basicFamily, handsOf, equipError, equipBonus, roomFor, addItem, takeItem, cleanBag, cleanEquip,
  pushedOff, comesOff, equipWith, wearError, wearItem,
  lookCode, lookOf, gearChance, tierForLevel, rollLoot, chestLoot, POTION_CHANCE,
  SKILLS, SKILL_KEYS, activeSkills, BAR_SIZE, barSkill, cleanBar, defaultBar, barAdd,
} from '../src/shared.js';

// A stand-in for Math.random that hands out the given numbers in turn, then `rest` for ever.
const dice = (values, rest = 0.999) => { const list = [...values]; return () => (list.length ? list.shift() : rest); };
const IRON = { weapon: 'iron_sword', head: 'iron_head', body: 'iron_body', hands: 'iron_hands', feet: 'iron_feet' };
const ARMOUR_SLOTS = ['head', 'body', 'hands', 'feet'];
const BARE = { weapon: null, offhand: null, head: null, body: null, hands: null, feet: null };

// ---------------------------------------------------------------- the table

test('the item table: four tiers of armour for four slots, of shields, of weapons for every family, and potions', () => {
  const gear = ITEM_KEYS.filter((id) => ITEMS[id].kind !== 'potion');
  assert.equal(TIERS.length, 4);
  assert.equal(gear.filter((id) => ITEMS[id].kind === 'armor').length, 16);
  assert.equal(gear.filter((id) => ITEMS[id].kind === 'shield').length, 4);
  assert.deepEqual(EQUIP_SLOTS, ['weapon', 'offhand', ...ARMOUR_SLOTS]);
  assert.deepEqual(WEAPON_FAMILIES, ['sword', 'daggers', 'bow', 'staff', 'greatsword'], 'the place of a family travels in the look code: new ones go last');
  assert.equal(gear.filter((id) => ITEMS[id].kind === 'weapon').length, 4 * WEAPON_FAMILIES.length);
  for (const id of ITEM_KEYS) {
    const it = ITEMS[id];
    assert.ok(it.name && Number.isInteger(it.price) && it.price > 0, id);
    assert.ok(sellPrice(id) >= 1 && sellPrice(id) < it.price && sellPrice(id) <= it.price * SELL_RATE, `${id} sells for a share of its price`);
    if (it.kind === 'potion') {
      assert.ok((it.hp > 0) !== (it.mp > 0), `${id} restores health or mana`);
      assert.equal(it.slot, undefined);
      assert.equal(stackMax(id), STACK_MAX);
      continue;
    }
    assert.ok(EQUIP_SLOTS.includes(it.slot) && SLOT_NAMES[it.slot], id);
    assert.equal(it.kind === 'weapon', it.slot === 'weapon', id);
    assert.equal(it.kind === 'shield', it.slot === 'offhand', id);
    assert.equal(it.kind === 'armor', ARMOUR_SLOTS.includes(it.slot), id);
    assert.equal(it.hands, it.kind === 'weapon' ? handsOf(it.family) : undefined, `${id}: only a weapon says how many paws it takes`);
    assert.equal(it.lvl, TIERS[it.tier].lvl, `${id} needs the level of its tier`);
    assert.equal(stackMax(id), 1);
    const bonus = Object.entries(it.bonus);
    assert.ok(bonus.length > 0, `${id} adds something`);
    for (const [k, v] of bonus) assert.ok(BONUS_KEYS.includes(k) && BONUS_NAMES[k] && v > 0, `${id}.${k}`);
  }
  // within a slot or a family every tier is better and dearer than the one below
  const line = (pick) => TIERS.map((_, t) => ITEMS[ITEM_KEYS.find((id) => ITEMS[id].tier === t && pick(ITEMS[id]))]);
  for (const slot of EQUIP_SLOTS.slice(1)) {   // armour and shields
    const row = line((it) => it.slot === slot);
    for (let t = 1; t < row.length; t++) assert.ok(row[t].bonus.pDef > row[t - 1].bonus.pDef && row[t].price > row[t - 1].price, slot);
  }
  for (const family of WEAPON_FAMILIES) {
    const row = line((it) => it.family === family), main = family === 'staff' ? 'mAtk' : 'pAtk';
    for (let t = 1; t < row.length; t++) assert.ok(row[t].bonus[main] > row[t - 1].bonus[main] && row[t].price > row[t - 1].price, family);
  }
  // every class starts with a weapon of a family, and a row of basic numbers for it; the greatsword is nobody's basic weapon
  assert.deepEqual([...new Set(CLASS_KEYS.map(weaponFamily))].sort(), WEAPON_FAMILIES.filter((f) => f !== 'greatsword').sort());
  for (const cls of CLASS_KEYS) assert.ok(WEAPONS[weaponFamily(cls)], cls);
  assert.equal(weaponFamily('knight'), 'sword');
  // one-handed: swords. Two-handed: all the rest - and a greatsword is clearly more of a blade than a sword of its tier
  assert.deepEqual(WEAPON_FAMILIES.map(handsOf), [1, 2, 2, 2, 2]);
  for (const tier of TIERS) {
    const sword = ITEMS[`${tier.arms}_sword`], great = ITEMS[`${tier.arms}_greatsword`], shield = ITEMS[`${tier.id}_shield`];
    assert.ok(great.bonus.pAtk >= sword.bonus.pAtk * 1.4, `${great.name}: ${great.bonus.pAtk} against ${sword.bonus.pAtk}`);
    assert.deepEqual(Object.keys(shield.bonus), ['pDef', 'mDef'], shield.name);
    assert.ok(shield.bonus.mDef < shield.bonus.pDef && shield.bonus.pDef < ITEMS[`${tier.id}_body`].bonus.pDef, `${shield.name}: less than the body piece, and little M.Def`);
  }
  assert.equal(ITEMS[KNIGHT_SHIELD].name, 'Wooden Buckler');
});

test('the Trader sells potions and gear up to his tier; an id from outside is an item only when it is one', () => {
  for (const id of ITEM_KEYS) assert.equal(SHOP.includes(id), ITEMS[id].kind === 'potion' || ITEMS[id].tier <= SHOP_TIER, id);
  assert.ok(SHOP.includes('iron_sword') && !SHOP.includes('steel_sword'));
  for (const id of ['leather_shield', 'iron_shield', 'bronze_greatsword', 'iron_greatsword']) assert.ok(SHOP.includes(id), id);
  for (const id of ['steel_shield', 'hypurr_shield', 'steel_greatsword', 'hypurr_greatsword']) assert.ok(!SHOP.includes(id), id);
  for (const id of ['constructor', '__proto__', 'toString', '', 7, null, undefined, ['hp_small'], {}]) assert.equal(itemOf(id), undefined);
  assert.equal(itemOf('hp_small'), ITEMS.hp_small);
  for (const [id, n] of STARTER_KIT) assert.ok(itemOf(id) && n > 0);
});

// ---------------------------------------------------------------- stats

test('statsOf: no equipment changes nothing; armour and weapons add where the class has its base values', () => {
  for (const cls of CLASS_KEYS) {
    for (const level of [1, 7, 20]) {
      const bare = statsOf(cls, level);
      for (const none of [null, undefined, {}, { weapon: null, head: null }, 'junk', 7]) assert.deepEqual(statsOf(cls, level, {}, 1, {}, none), bare);
    }
  }
  // fighter, level 5: base P.Def 40, level factor 1.2; the iron set adds 5 + 11 + 4 + 5
  const bare = statsOf('fighter', 5), worn = statsOf('fighter', 5, {}, 1, {}, IRON);
  assert.equal(bare.pDef, Math.round(40 * 1.2));
  assert.equal(worn.pDef, Math.round((40 + 25) * 1.2));
  assert.equal(worn.mDef, Math.round((20 + 6) * 1.2 * (1 + (25 - 20) * 0.04)));
  assert.equal(worn.pAtk, Math.round((WEAPONS.sword.pAtk + 8) * 1.4));
  assert.equal(worn.acc, bare.acc + 2);
  assert.equal(worn.speed, bare.speed + 4);
  assert.ok(worn.move > bare.move);
  // what equipment does not touch
  for (const k of ['maxHp', 'maxMp', 'eva', 'mCrit', 'atkSpd', 'castSpd', 'STR']) assert.equal(worn[k], bare[k], k);
  // a staff raises M.Atk, daggers raise the critical rate
  assert.ok(statsOf('mystic', 5, {}, 1, {}, { weapon: 'iron_staff' }).mAtk > statsOf('mystic', 5).mAtk);
  assert.equal(statsOf('rogue', 20, {}, 1, {}, { weapon: 'iron_daggers' }).crit, statsOf('rogue', 20).crit + 20);
  // a shield: P.Def and a little M.Def, for any class, beside the rest
  const shielded = statsOf('fighter', 5, {}, 1, {}, { ...IRON, offhand: 'iron_shield' });
  assert.equal(shielded.pDef, Math.round((40 + 25 + 8) * 1.2));
  assert.equal(shielded.mDef, Math.round((20 + 6 + 2) * 1.2 * (1 + (25 - 20) * 0.04)));
  assert.equal(shielded.pAtk, worn.pAtk);
  for (const cls of CLASS_KEYS) assert.ok(statsOf(cls, 20, {}, 1, {}, { offhand: 'hypurr_shield' }).pDef > statsOf(cls, 20).pDef, cls);
});

test('statsOf: the Knight is no weaker for his shield having become an item', () => {
  // before, his class weapon was "shield": a sword's numbers less 1 P.Atk and 10 Atk.Spd, and 15 P.Def on his armour of 62
  for (const level of [20, 25, 40]) {
    const now = statsOf('knight', level), defLevel = 1 + 0.05 * (level - 1), atkLevel = 1 + 0.1 * (level - 1);
    assert.equal(now.pDef, Math.round((62 + 15) * defLevel), `level ${level}: the same defence with a bare paw`);
    assert.ok(now.pAtk >= Math.round(17 * atkLevel) && now.atkSpd >= Math.round(290 * (1 + (28 - 30) * 0.012)));
    assert.equal(statsOf('knight', level, {}, 1, {}, { offhand: KNIGHT_SHIELD }).pDef, Math.round((62 + 15 + 4) * defLevel), 'and more with the buckler he is handed');
  }
});

test('statsOf: the Blacksmith\'s upgrade, passive skills and buffs multiply the weapon item too', () => {
  const eq = { weapon: 'steel_sword' };
  const plain = statsOf('fighter', 10, {}, 1, {}, eq), forged = statsOf('fighter', 10, {}, 3, {}, eq);
  assert.equal(plain.pAtk, Math.round((18 + 14) * 1.9));
  assert.equal(forged.pAtk, Math.round((18 + 14) * 1.8 * 1.9));
  assert.equal(statsOf('fighter', 10, { weapon_mastery: 1 }, 1, { patk: 1.2 }, eq).pAtk, Math.round((18 + 14) * 1.9 * 1.08 * 1.2));
  assert.equal(statsOf('fighter', 10, {}, 1, { pdef: 2 }, IRON).pDef, Math.round((40 + 25) * 1.45 * 2));
});

test('equipBonus: only an item that belongs in its slot counts; a weapon counts for whoever holds it', () => {
  const zero = Object.fromEntries(BONUS_KEYS.map((k) => [k, 0]));
  assert.deepEqual(equipBonus(null, 'fighter'), zero);
  assert.deepEqual(equipBonus({ head: 'iron_body', body: 'iron_sword', weapon: 'iron_head', feet: 'hp_small', hands: 'constructor' }, 'fighter'), zero);
  assert.equal(equipBonus({ weapon: 'iron_staff' }, 'fighter').mAtk, 11);                             // any class, any weapon
  assert.equal(equipBonus({ weapon: 'iron_staff' }, 'cleric').mAtk, 11);
  assert.equal(equipBonus({ weapon: 'iron_sword' }, 'knight').pAtk, 8);
  assert.ok(statsOf('archer', 20, {}, 1, {}, { weapon: 'hypurr_sword' }).pAtk > statsOf('archer', 20).pAtk);   // an archer may hold a sword
  assert.deepEqual(equipBonus(IRON, 'fighter'), { ...zero, pAtk: 8, pDef: 25, mDef: 6, acc: 2, speed: 4 });
});

test('equipError: the level decides the tier; any class wields any weapon and wears any armour', () => {
  assert.equal(equipError('fighter', 5, 'iron_sword'), '');
  assert.equal(equipError('knight', 5, 'iron_sword'), '');
  assert.equal(equipError('fighter', 5, 'iron_staff'), '');
  assert.equal(equipError('rogue', 20, 'iron_sword'), '');
  assert.equal(equipError('rogue', 20, 'iron_daggers'), '');
  assert.equal(equipError('archer', 20, 'steel_bow'), '');
  assert.match(equipError('fighter', 4, 'iron_head'), /requires level 5/);
  assert.match(equipError('fighter', 14, 'hypurr_sword'), /requires level 15/);
  for (const cls of CLASS_KEYS) {
    for (const slot of ARMOUR_SLOTS) assert.equal(equipError(cls, 15, `hypurr_${slot}`), '', `${cls} wears ${slot}`);
    assert.equal(equipError(cls, 15, 'hypurr_shield'), '', `${cls} carries a shield`);
    assert.match(equipError(cls, 9, 'steel_shield'), /Steel Shield requires level 10/);
    assert.equal(ITEM_KEYS.filter((id) => ITEMS[id].kind === 'weapon' && !equipError(cls, 99, id)).length, TIERS.length * WEAPON_FAMILIES.length, `${cls} can hold every weapon`);
  }
  for (const id of ['hp_small', 'nothing', 'constructor', undefined, 5]) assert.match(equipError('fighter', 99, id), /cannot be equipped/);
  assert.ok(CLASS_KEYS.every((cls) => WEAPON_FAMILIES.includes(CLASSES[cls].weapon)), 'a shield is an item, not the weapon of a class');
});

// ---------------------------------------------------------------- two paws

test('two paws: a two-handed weapon and a shield push each other off; a sword and a shield go together', () => {
  const sword = { ...BARE, weapon: 'iron_sword' }, both = { ...sword, offhand: 'iron_shield' }, great = { ...BARE, weapon: 'iron_greatsword' };
  for (const family of WEAPON_FAMILIES) {
    const id = `iron_${family}`, two = family !== 'sword';
    assert.deepEqual(pushedOff(both, id), two ? ['offhand'] : [], family);
    assert.deepEqual(pushedOff(sword, id), [], `${family}: nothing in the off hand, nothing to push`);
    assert.deepEqual(pushedOff({ ...BARE, weapon: id }, 'steel_shield'), two ? ['weapon'] : [], `a shield against ${family}`);
    assert.deepEqual(comesOff(both, id), two ? ['iron_sword', 'iron_shield'] : ['iron_sword'], family);
    assert.deepEqual(equipWith(both, id), { ...both, weapon: id, offhand: two ? null : 'iron_shield' }, family);
  }
  assert.deepEqual(pushedOff(both, 'steel_shield'), [], 'a shield for a shield is a plain swap');
  assert.deepEqual(comesOff(both, 'steel_shield'), ['iron_shield']);
  assert.deepEqual(comesOff(great, 'steel_shield'), ['iron_greatsword']);
  assert.deepEqual(equipWith(great, 'steel_shield'), { ...BARE, offhand: 'steel_shield' });
  for (const id of ['iron_head', 'hp_small', 'nothing', undefined]) assert.deepEqual(pushedOff(both, id), [], String(id));
  assert.deepEqual(comesOff(BARE, 'iron_greatsword'), []);
  assert.notEqual(equipWith(both, 'iron_bow'), both, 'a copy');
  assert.equal(both.offhand, 'iron_shield', 'and what it was made from stays as it was');
  // the numbers the tooltip shows: a greatsword instead of a sword and a shield costs the shield's defence
  const before = statsOf('fighter', 10, {}, 1, {}, both), after = statsOf('fighter', 10, {}, 1, {}, equipWith(both, 'iron_greatsword'));
  assert.ok(after.pAtk > before.pAtk && after.pDef < before.pDef && after.mDef < before.mDef);
  assert.equal(after.pDef, statsOf('fighter', 10).pDef);
});

test('two paws: wearItem swaps in the bag, and refuses - changing nothing - when what comes off has no place', () => {
  const inv = [['hp_small', 2], ['iron_greatsword', 1], ['iron_shield', 1], ['iron_bow', 1], ['steel_shield', 1]], equip = { ...BARE, weapon: 'iron_sword' };
  assert.equal(wearItem(inv, equip, 2), '');                         // a shield beside the sword: it just leaves the bag
  assert.deepEqual([equip.weapon, equip.offhand], ['iron_sword', 'iron_shield']);
  assert.deepEqual(inv, [['hp_small', 2], ['iron_greatsword', 1], ['iron_bow', 1], ['steel_shield', 1]]);
  assert.equal(wearItem(inv, equip, 3), '');                         // another shield: swapped in place
  assert.deepEqual(inv[3], ['iron_shield', 1]);
  assert.equal(equip.offhand, 'steel_shield');
  assert.equal(wearItem(inv, equip, 1), '');                         // the greatsword: the sword takes its place, the shield goes to the end
  assert.deepEqual([equip.weapon, equip.offhand], ['iron_greatsword', null]);
  assert.deepEqual(inv, [['hp_small', 2], ['iron_sword', 1], ['iron_bow', 1], ['iron_shield', 1], ['steel_shield', 1]]);
  assert.equal(wearItem(inv, equip, 3), '');                         // a shield: the greatsword comes off into its place
  assert.deepEqual([equip.weapon, equip.offhand], [null, 'iron_shield']);
  assert.deepEqual(inv[3], ['iron_greatsword', 1]);
  assert.equal(wearItem(inv, equip, 2), '');                         // the bow, with no weapon to swap: the shield takes the bow's place
  assert.deepEqual([equip.weapon, equip.offhand], ['iron_bow', null]);
  assert.deepEqual(inv, [['hp_small', 2], ['iron_sword', 1], ['iron_shield', 1], ['iron_greatsword', 1], ['steel_shield', 1]]);
  assert.equal(inv.length + Object.values(equip).filter(Boolean).length, 6, 'nothing was lost and nothing doubled');

  // a full bag: one thing off for one thing on always fits; two things off need a free place
  const full = [...Array.from({ length: BAG_SIZE - 3 }, () => ['leather_head', 1]), ['iron_greatsword', 1], ['iron_bow', 1], ['steel_shield', 1]];
  const worn = { ...BARE, weapon: 'iron_sword', offhand: 'iron_shield' }, bagBefore = JSON.stringify(full);
  for (const id of ['iron_greatsword', 'iron_bow']) {
    assert.match(wearError(full, worn, id), /^Your bag is full: no room to take off Iron Shield$/);
    assert.match(wearItem(full, worn, full.findIndex((s) => s[0] === id)), /bag is full/);
  }
  assert.equal(JSON.stringify(full), bagBefore);
  assert.deepEqual(worn, { ...BARE, weapon: 'iron_sword', offhand: 'iron_shield' });
  assert.equal(wearError(full, worn, 'steel_shield'), '');
  assert.equal(wearItem(full, worn, BAG_SIZE - 1), '');
  assert.deepEqual(full[BAG_SIZE - 1], ['iron_shield', 1]);
  // with the sword off first there is one thing to come off, and it fits
  const light = { ...BARE, offhand: 'steel_shield' };
  assert.equal(wearItem(full, light, BAG_SIZE - 3), '');
  assert.deepEqual([light.weapon, light.offhand, full.length, full[BAG_SIZE - 3][0]], ['iron_greatsword', null, BAG_SIZE, 'steel_shield']);
  full.pop();                                                        // and with one free place both come off
  const again = { ...BARE, weapon: 'iron_sword', offhand: 'iron_shield' };
  full[0] = ['steel_greatsword', 1];
  assert.equal(wearItem(full, again, 0), '');
  assert.deepEqual([full[0][0], full.at(-1)[0], full.length], ['iron_sword', 'iron_shield', BAG_SIZE]);
});

test('two paws: with a shield and no weapon equipped, a class whose own weapon takes both paws fights with a plain sword', () => {
  const shield = { offhand: 'leather_shield' };
  for (const cls of CLASS_KEYS) {
    const own = weaponFamily(cls);
    assert.equal(basicFamily(cls), own, cls);
    assert.equal(basicFamily(cls, true), handsOf(own) === 2 ? 'sword' : own, cls);
    assert.equal(heldFamily(cls, shield), handsOf(own) === 2 ? 'sword' : own, cls);
    assert.equal(handsOf(heldFamily(cls, shield)), 1, `${cls}: the paw with the shield is never asked for`);
    assert.equal(heldFamily(cls, { ...shield, weapon: 'iron_sword' }), 'sword');
    assert.equal(heldFamily(cls, { offhand: 'iron_sword' }), own, 'only a shield in the off hand counts');
  }
  assert.deepEqual(fightStyle('archer', heldFamily('archer', shield)), { ranged: false, reach: MELEE_REACH }, 'an archer behind a shield strikes');
  assert.deepEqual(fightStyle('archer', heldFamily('archer', {})), { ranged: true, reach: BOW_REACH });
});

// ---------------------------------------------------------------- the bag

test('the bag: potions stack to 99, gear does not, and thirty stacks is all it holds', () => {
  const inv = [];
  assert.equal(addItem(inv, 'hp_small', 5), 5);
  assert.equal(addItem(inv, 'hp_small', 90), 90);
  assert.deepEqual(inv, [['hp_small', 95]]);
  assert.equal(addItem(inv, 'hp_small', 10), 10);
  assert.deepEqual(inv, [['hp_small', 99], ['hp_small', 6]]);
  assert.equal(addItem(inv, 'mp_small', 1), 1);
  assert.equal(addItem(inv, 'iron_sword'), 1);
  assert.equal(addItem(inv, 'iron_sword'), 1);
  assert.deepEqual(inv.slice(2), [['mp_small', 1], ['iron_sword', 1], ['iron_sword', 1]]);
  // fill it up: 25 more stacks fit, and then only the open potion stacks take anything
  for (let i = inv.length; i < BAG_SIZE; i++) assert.equal(addItem(inv, 'iron_head'), 1);
  assert.equal(inv.length, BAG_SIZE);
  assert.equal(roomFor(inv, 'iron_head'), 0);
  assert.equal(addItem(inv, 'iron_head'), 0);
  assert.equal(roomFor(inv, 'hp_large', 3), 0);
  assert.equal(roomFor(inv, 'hp_small', 500), 93);
  assert.equal(roomFor(inv, 'mp_small', 5), 5);
  assert.equal(addItem(inv, 'hp_small', 500), 93, 'what fits goes in, the rest is reported');
  assert.equal(inv.length, BAG_SIZE);
  assert.equal(roomFor([], 'hp_small', 1e6), BAG_SIZE * STACK_MAX);
  assert.equal(roomFor([], 'iron_head', 1e6), BAG_SIZE);
});

test('the bag: taking from a stack, and a stack that runs out leaves no hole', () => {
  const inv = [['hp_small', 3], ['iron_sword', 1], ['mp_small', 2]];
  assert.equal(takeItem(inv, 0, 2), true);
  assert.deepEqual(inv[0], ['hp_small', 1]);
  for (const [i, n] of [[0, 2], [5, 1], [-1, 1], [0, 0], [0, -1], [0, 0.5], [0, NaN], [1.5, 1]]) assert.equal(takeItem(inv, i, n), false, `${i}, ${n}`);
  assert.equal(takeItem(inv, 1), true);
  assert.deepEqual(inv, [['hp_small', 1], ['mp_small', 2]]);
  assert.equal(takeItem(inv, 0), true);
  assert.deepEqual(inv, [['mp_small', 2]]);
});

test('a save file: an old one without items, a broken one and one with unknown items all load', () => {
  for (const raw of [undefined, null, 'x', 7, {}, []]) {
    assert.deepEqual(cleanBag(raw), []);
    assert.deepEqual(cleanEquip(raw), BARE);
  }
  assert.deepEqual(cleanBag([['hp_small', 3], ['gone_item', 1], ['iron_sword', 1], 'x', null, ['hp_small'], ['hp_small', 0], ['hp_small', -4],
    ['hp_small', 1.5], ['constructor', 1], [['hp_small'], 1], ['mp_small', 200], ['hp_small', 2]]),
  [['hp_small', 5], ['iron_sword', 1], ['mp_small', 99], ['mp_small', 99], ['mp_small', 2]]);
  assert.equal(cleanBag(Array.from({ length: 100 }, () => ['iron_head', 1])).length, BAG_SIZE);
  assert.equal(cleanBag([['hp_small', 1e9]]).length, BAG_SIZE);
  const kit = cleanBag(STARTER_KIT);
  kit[0][1] = 0;
  assert.ok(STARTER_KIT[0][1] > 0, 'a bag never shares its stacks with what it was made from');
  assert.deepEqual(cleanEquip({ weapon: 'iron_staff', head: 'iron_body', body: 'steel_body', hands: 'nothing', feet: 7, tail: 'iron_feet' }),
    { ...BARE, weapon: 'iron_staff', body: 'steel_body' });
  // a save from before the off hand loads as it was; only a shield goes into the off hand, and never beside a weapon for both paws
  assert.deepEqual(cleanEquip(IRON), { ...IRON, offhand: null });
  assert.deepEqual(cleanEquip({ weapon: 'iron_sword', offhand: 'iron_shield' }), { ...BARE, weapon: 'iron_sword', offhand: 'iron_shield' });
  for (const junk of ['iron_sword', 'iron_head', 'hp_small', 'shield', 7]) assert.equal(cleanEquip({ offhand: junk }).offhand, null, String(junk));
  for (const family of WEAPON_FAMILIES.filter((f) => f !== 'sword')) {
    assert.deepEqual(cleanEquip({ weapon: `iron_${family}`, offhand: 'iron_shield' }), { ...BARE, weapon: `iron_${family}` }, family);
  }
});

// ---------------------------------------------------------------- the action bar

test('the action bar: ten slots, and an id says by itself whether it is a skill or an item', () => {
  assert.equal(BAR_SIZE, 10);
  for (const id of SKILL_KEYS) assert.equal(itemOf(id), undefined, `${id} is a skill and an item`);
  for (const id of SKILL_KEYS) assert.equal(!!barSkill(id), SKILLS[id].kind !== 'passive', id);
  for (const id of ['constructor', '__proto__', 'hp_small', '', 7, null, undefined, ['bolt'], {}]) assert.equal(barSkill(id), undefined);
  // no class line has more active skills than the bar has room for beside the two potions
  for (const cls of CLASS_KEYS) {
    const all = Object.fromEntries(SKILL_KEYS.map((id) => [id, 1]));
    assert.ok(activeSkills(cls, all).length <= BAR_SIZE - 2, cls);
  }
});

test('cleanBar: always ten slots; whatever is not an active skill or an item is an empty slot', () => {
  const EMPTY = Array(BAR_SIZE).fill(null);
  for (const junk of [undefined, null, 'bolt', 7, {}, { 0: 'bolt', length: 1 }, []]) assert.deepEqual(cleanBar(junk), EMPTY);
  assert.deepEqual(
    cleanBar(['bolt', 'hp_small', null, 'mana_mastery', 'no_such_thing', 'constructor', 7, ['bolt'], { id: 'bolt' }, 'iron_sword', 'fireball', 'mp_large']),
    ['bolt', 'hp_small', null, null, null, null, null, null, null, 'iron_sword'],
    'a passive skill, an unknown id, a number, a list and an object are dropped, and so is an eleventh slot',
  );
  assert.deepEqual(cleanBar(['bolt']), ['bolt', ...EMPTY.slice(1)], 'a short list is filled up');
  assert.deepEqual(cleanBar(['mend', 'mend', 'hp_small', 'hp_small']).slice(0, 4), ['mend', 'mend', 'hp_small', 'hp_small'], 'the same thing may stand in two slots');
  // a skill of another class and an item the character does not own stay: the slot says so, the bar keeps its shape
  assert.deepEqual(cleanBar(['backstab', 'hypurr_bow']).slice(0, 2), ['backstab', 'hypurr_bow']);
  const sparse = []; sparse[9] = 'mp_small';
  assert.deepEqual(cleanBar(sparse), [...EMPTY.slice(1), 'mp_small']);
  const bar = cleanBar(['bolt']);
  assert.deepEqual(cleanBar(bar), bar, 'a clean bar stays as it is');
  assert.notEqual(cleanBar(bar), bar, 'and is a list of its own');
});

test('defaultBar: the learned skills from the first slot on, a health and a mana potion on the last two', () => {
  assert.deepEqual(defaultBar('fighter', { power_strike: 1 }), ['power_strike', null, null, null, null, null, null, null, 'hp_small', 'mp_small']);
  // passive skills and skills not learned yet take no slot; the order is that of the skill table
  assert.deepEqual(
    defaultBar('wizard', { fireball: 1, bolt: 3, mana_mastery: 2, mend: 1, inferno: 0 }).slice(0, 4),
    ['bolt', 'mend', 'fireball', null],
  );
  // the potions are the kind the character carries: the first of each in its bag, else the lesser one
  assert.deepEqual(defaultBar('mystic', { bolt: 1 }, [['iron_sword', 1], ['mp_large', 2], ['hp_large', 1], ['hp_small', 9]]).slice(8), ['hp_large', 'mp_large']);
  assert.deepEqual(defaultBar('mystic', {}, [['mp_small', 2]]), [null, null, null, null, null, null, null, null, 'hp_small', 'mp_small']);
  // the class with the most skills fills the bar exactly
  const all = Object.fromEntries(SKILL_KEYS.map((id) => [id, 1])), cleric = defaultBar('cleric', all);
  assert.deepEqual(cleric.slice(0, 8), activeSkills('cleric', all));
  assert.equal(cleric.length, BAR_SIZE);
  for (const cls of CLASS_KEYS) assert.deepEqual(cleanBar(defaultBar(cls, all)), defaultBar(cls, all), cls);
});

test('barAdd: a newly learned skill takes the first empty slot, once', () => {
  const bar = cleanBar(['bolt', null, 'hp_small', null]);
  assert.equal(barAdd(bar, 'mend'), true);
  assert.deepEqual(bar.slice(0, 4), ['bolt', 'mend', 'hp_small', null]);
  assert.equal(barAdd(bar, 'mend'), false, 'it is on the bar already');
  assert.equal(barAdd(bar, 'mana_mastery'), false, 'a passive skill has nothing to press');
  assert.equal(barAdd(bar, 'no_such_skill'), false);
  assert.equal(barAdd(bar, 'hp_large'), false, 'only skills are slotted for the player');
  assert.deepEqual(bar.slice(0, 4), ['bolt', 'mend', 'hp_small', null]);
  const full = cleanBar(Array(BAR_SIZE).fill('hp_small'));
  assert.equal(barAdd(full, 'bolt'), false, 'a full bar stays as the player arranged it');
  assert.ok(!full.includes('bolt'));
});

// ---------------------------------------------------------------- the look

test('the look code: which pieces, which tiers and the kind of weapon in the paw, and nothing else', () => {
  assert.equal(lookCode(null, 'fighter'), 0);
  assert.equal(lookCode({}, 'fighter'), 0);
  const none = { weapon: -1, offhand: -1, head: -1, body: -1, hands: -1, feet: -1, family: null };
  assert.deepEqual(lookOf(0), none);
  for (const junk of [undefined, null, -5, 1.5, NaN, 'x', {}]) assert.deepEqual(lookOf(junk), none);
  assert.deepEqual(lookOf(lookCode(IRON)), { weapon: 1, offhand: -1, head: 1, body: 1, hands: 1, feet: 1, family: 'sword' });
  const mixed = { weapon: 'hypurr_bow', head: 'leather_head', body: null, hands: 'steel_hands', feet: 'hypurr_feet' };
  assert.deepEqual(lookOf(lookCode(mixed)), { weapon: 3, offhand: -1, head: 0, body: -1, hands: 2, feet: 3, family: 'bow' });
  for (const family of WEAPON_FAMILIES) assert.equal(lookOf(lookCode({ weapon: `iron_${family}` })).family, family);
  // every combination comes back as it went in
  const seen = new Set();
  for (let head = -1; head < 4; head++) {
    for (let feet = -1; feet < 4; feet++) {
      const eq = { head: head < 0 ? null : `${TIERS[head].id}_head`, feet: feet < 0 ? null : `${TIERS[feet].id}_feet` };
      const code = lookCode(eq, 'mystic');
      assert.ok(Number.isInteger(code) && code >= 0 && code < 5 ** 6);
      assert.deepEqual(lookOf(code), { ...none, head, feet });
      seen.add(code);
    }
  }
  assert.equal(seen.size, 25);
  const big = lookOf(5 ** 6 * 3 + 5 ** 5 * 3 + 4);
  assert.ok(EQUIP_SLOTS.every((slot) => big[slot] >= -1 && big[slot] < TIERS.length), 'a code too large still names real tiers');
  assert.equal(big.family, WEAPON_FAMILIES[2]);
});

test('the look code: the off hand and the fifth family ride above the old digits, and every old code reads as before', () => {
  // the code as it was made and read before the off hand: five slots and the family, six digits of base 5
  const OLD_SLOTS = ['weapon', 'head', 'body', 'hands', 'feet'], OLD_FAMILIES = ['sword', 'daggers', 'bow', 'staff'];
  const oldCode = (equip) => OLD_SLOTS.reduce((code, slot, i) => code + (equip[slot] ? ITEMS[equip[slot]].tier + 1 : 0) * 5 ** i, 0)
    + (equip.weapon ? OLD_FAMILIES.indexOf(ITEMS[equip.weapon].family) + 1 : 0) * 5 ** 5;
  const oldLook = (code) => {
    const digit = (i) => Math.floor(code / 5 ** i) % 5, look = Object.fromEntries(OLD_SLOTS.map((slot, i) => [slot, digit(i) - 1]));
    return { ...look, family: OLD_FAMILIES[digit(5) - 1] ?? null };
  };
  for (let code = 0; code < 5 ** 6; code++) assert.deepEqual(lookOf(code), { ...oldLook(code), offhand: -1 }, `code ${code}`);
  // and what wore nothing new gets the very number it used to get
  for (const family of OLD_FAMILIES) {
    for (let t = 0; t < TIERS.length; t++) {
      const eq = { weapon: `${TIERS[t].arms}_${family}`, head: `${TIERS[(t + 1) % 4].id}_head`, body: t % 2 ? 'steel_body' : null, hands: 'leather_hands', feet: `${TIERS[3 - t].id}_feet` };
      assert.equal(lookCode(eq), oldCode(eq), `${family}, tier ${t}`);
    }
  }
  // the off hand: every tier of shield beside every tier of sword, each a number of its own
  const seen = new Set();
  for (let shield = -1; shield < 4; shield++) {
    for (let sword = -1; sword < 4; sword++) {
      const eq = { weapon: sword < 0 ? null : `${TIERS[sword].arms}_sword`, offhand: shield < 0 ? null : `${TIERS[shield].id}_shield`, body: 'iron_body' };
      const code = lookCode(eq), look = lookOf(code);
      assert.ok(Number.isSafeInteger(code) && code >= 0 && code < 5 ** 8);
      assert.deepEqual([look.weapon, look.offhand, look.body, look.family, look.head], [sword, shield, 1, sword < 0 ? null : 'sword', -1]);
      seen.add(code);
    }
  }
  assert.equal(seen.size, 25);
  assert.ok(lookCode({ offhand: 'leather_shield' }) >= 5 ** 6, 'above everything an old client knew');
  // the fifth family does not fit into the old family digit: it is told apart from no weapon and from the other four
  for (let t = 0; t < TIERS.length; t++) {
    const look = lookOf(lookCode({ weapon: `${TIERS[t].arms}_greatsword`, feet: 'iron_feet' }));
    assert.deepEqual([look.family, look.weapon, look.feet, look.offhand], ['greatsword', t, 1, -1]);
  }
  assert.equal(new Set(WEAPON_FAMILIES.map((family) => lookCode({ weapon: `iron_${family}` }))).size, WEAPON_FAMILIES.length);
  // only what belongs in a slot shows: a sword in the off hand is not a shield
  assert.equal(lookCode({ offhand: 'iron_sword' }), 0);
  assert.equal(lookCode({ weapon: 'iron_shield' }), 0);
  for (const junk of [5 ** 8 * 3, 5 ** 7 * 4, Number.MAX_SAFE_INTEGER]) {
    const look = lookOf(junk);
    assert.ok(EQUIP_SLOTS.every((slot) => look[slot] >= -1 && look[slot] < TIERS.length) && (look.family === null || WEAPON_FAMILIES.includes(look.family)), String(junk));
  }
});

// ---------------------------------------------------------------- loot

test('loot: the chance grows with the level, the tier follows it, and most kills leave nothing', () => {
  for (const type of MOB_KEYS) {
    assert.ok(gearChance(type, 1) > 0 && gearChance(type, 1) <= 1, type);
    assert.ok(gearChance(type, 15) >= gearChance(type, 1), type);
  }
  assert.ok(gearChance('chaser', 1) <= 0.1 && gearChance('tank', 15) < 0.5, 'modest');
  assert.equal(gearChance('boss', 18), 1);
  assert.deepEqual([1, 4, 5, 9, 10, 14, 15, 40].map(tierForLevel), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.deepEqual(rollLoot('chaser', 6, dice([])), []);                       // every draw fails
  // draws: gear? - a tier below? - which piece - a potion? - which potion
  assert.deepEqual(rollLoot('chaser', 6, dice([0, 0.9, 0, 0.9])), [['iron_head', 1]]);
  assert.deepEqual(rollLoot('chaser', 6, dice([0, 0.1, 0, 0.9])), [['leather_head', 1]]);
  assert.deepEqual(rollLoot('chaser', 2, dice([0, 0.999, 0.9])), [['bronze_greatsword', 1]], 'the lowest tier has none below: no draw is spent on it');
  // of fifteen lots, ten are armour - two of them the shield - and five the weapons, one each
  const lots = Array.from({ length: 15 }, (_, i) => rollLoot('chaser', 6, dice([0, 0.9, (i + 0.5) / 15, 0.9]))[0][0]);
  assert.deepEqual(lots, ['iron_head', 'iron_head', 'iron_body', 'iron_body', 'iron_hands', 'iron_hands', 'iron_feet', 'iron_feet', 'iron_shield', 'iron_shield',
    'iron_sword', 'iron_daggers', 'iron_bow', 'iron_staff', 'iron_greatsword']);
  assert.deepEqual(rollLoot('tank', 12, dice([0.99, 0, 0])), [['hp_large', 1]]);
  assert.deepEqual(rollLoot('runner', 3, dice([0.99, POTION_CHANCE - 0.001, 0.7])), [['mp_small', 1]]);
  assert.deepEqual(rollLoot('runner', 3, dice([0.99, POTION_CHANCE, 0.7])), []);
  // with real dice: gear of the right tiers only, at about the promised rate
  let gear = 0;
  for (let i = 0; i < 4000; i++) {
    for (const [id, n] of rollLoot('shooter', 12)) {
      assert.ok(itemOf(id) && n === 1);
      if (ITEMS[id].kind === 'potion') continue;
      gear++;
      assert.ok([1, 2].includes(ITEMS[id].tier), `a level 12 monster dropped ${id}`);
    }
  }
  const expected = 4000 * gearChance('shooter', 12);
  assert.ok(gear > expected * 0.7 && gear < expected * 1.3, `${gear} pieces in 4000 kills, about ${Math.round(expected)} expected`);
});

test('loot: the King always leaves a piece of the top tier and potions; every piece of a tier can drop', () => {
  const pieces = new Set();
  for (let i = 0; i < 600; i++) {
    const loot = rollLoot('boss', 18);
    assert.equal(loot.length, 2);
    assert.equal(ITEMS[loot[0][0]].tier, TIERS.length - 1);
    assert.equal(ITEMS[loot[1][0]].kind, 'potion');
    assert.equal(loot[1][1], 3);
    pieces.add(loot[0][0]);
  }
  assert.equal(pieces.size, 4 + 1 + WEAPON_FAMILIES.length);
  assert.ok(pieces.has('hypurr_shield') && pieces.has('hypurr_greatsword'));
  assert.equal(rollLoot('boss', 18, dice([], 0.999999))[0][0], 'hypurr_greatsword', 'the last piece of the pool, not past it');
});

test('chests: sometimes a potion, seldom gear, and the richer the chest the better', () => {
  assert.deepEqual(chestLoot(12, false, dice([])), []);
  // draws: a potion? - which - two of them? - gear? - which piece
  assert.deepEqual(chestLoot(12, false, dice([0, 0, 0.9, 0, 0])), [['hp_small', 1], ['leather_head', 1]]);
  assert.deepEqual(chestLoot(40, false, dice([0, 0.9, 0, 0, 0])), [['mp_large', 2], ['iron_head', 1]]);
  assert.deepEqual(chestLoot(90, false, dice([0.9, 0, 0])), [['steel_head', 1]]);
  assert.deepEqual(chestLoot(400, true, dice([0.9, 0.49, 0])), [['hypurr_head', 1]]);
  assert.deepEqual(chestLoot(400, true, dice([0.9, 0.5, 0])), []);
  for (let i = 0; i < 500; i++) for (const [id, n] of chestLoot(90, false)) assert.ok(itemOf(id) && n >= 1 && n <= 2);
});

test('how a cat fights follows what it holds, not its class', () => {
  assert.equal(heldFamily('fighter', null), 'sword');
  assert.equal(heldFamily('knight', {}), 'sword');
  assert.equal(heldFamily('wizard', { weapon: 'iron_bow' }), 'bow');
  assert.deepEqual(fightStyle('archer'), { ranged: true, reach: BOW_REACH });
  assert.deepEqual(fightStyle('fighter'), { ranged: false, reach: MELEE_REACH });
  assert.deepEqual(fightStyle('fighter', 'bow'), { ranged: true, reach: BOW_REACH });      // a fighter with a bow shoots
  assert.deepEqual(fightStyle('archer', 'sword'), { ranged: false, reach: MELEE_REACH });  // an archer with a sword strikes
  for (const cls of CLASS_KEYS) assert.equal(fightStyle(cls).reach, CLASSES[cls].reach, `${cls} fights as before with its own weapon`);
});
