// Items (src/shared.js): the item table, what equipment does to the stats, who may wear what, the bag, what a save file
// may hold, the look code other players draw a cat from, and loot.
// Run: node --test test/items.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASSES, CLASS_KEYS, WEAPONS, MOB_KEYS, statsOf,
  ITEMS, ITEM_KEYS, TIERS, EQUIP_SLOTS, SLOT_NAMES, BONUS_KEYS, BONUS_NAMES, WEAPON_FAMILIES, heldFamily, fightStyle, MELEE_REACH, BOW_REACH, BAG_SIZE, STACK_MAX, SELL_RATE, SHOP, SHOP_TIER,
  STARTER_KIT, itemOf, stackMax, sellPrice, weaponFamily, equipError, equipBonus, roomFor, addItem, takeItem, cleanBag, cleanEquip,
  lookCode, lookOf, gearChance, tierForLevel, rollLoot, chestLoot, POTION_CHANCE,
} from '../src/shared.js';

// A stand-in for Math.random that hands out the given numbers in turn, then `rest` for ever.
const dice = (values, rest = 0.999) => { const list = [...values]; return () => (list.length ? list.shift() : rest); };
const IRON = { weapon: 'iron_sword', head: 'iron_head', body: 'iron_body', hands: 'iron_hands', feet: 'iron_feet' };

// ---------------------------------------------------------------- the table

test('the item table: four tiers of armour for four slots, of weapons for every family, and potions', () => {
  const gear = ITEM_KEYS.filter((id) => ITEMS[id].kind !== 'potion');
  assert.equal(TIERS.length, 4);
  assert.equal(gear.filter((id) => ITEMS[id].kind === 'armor').length, 16);
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
    assert.equal(it.lvl, TIERS[it.tier].lvl, `${id} needs the level of its tier`);
    assert.equal(stackMax(id), 1);
    const bonus = Object.entries(it.bonus);
    assert.ok(bonus.length > 0, `${id} adds something`);
    for (const [k, v] of bonus) assert.ok(BONUS_KEYS.includes(k) && BONUS_NAMES[k] && v > 0, `${id}.${k}`);
  }
  // within a slot or a family every tier is better and dearer than the one below
  const line = (pick) => TIERS.map((_, t) => ITEMS[ITEM_KEYS.find((id) => ITEMS[id].tier === t && pick(ITEMS[id]))]);
  for (const slot of EQUIP_SLOTS.slice(1)) {
    const row = line((it) => it.slot === slot);
    for (let t = 1; t < row.length; t++) assert.ok(row[t].bonus.pDef > row[t - 1].bonus.pDef && row[t].price > row[t - 1].price, slot);
  }
  for (const family of WEAPON_FAMILIES) {
    const row = line((it) => it.family === family), main = family === 'staff' ? 'mAtk' : 'pAtk';
    for (let t = 1; t < row.length; t++) assert.ok(row[t].bonus[main] > row[t - 1].bonus[main] && row[t].price > row[t - 1].price, family);
  }
  // every class has a family, and every family is some class's
  assert.deepEqual([...new Set(CLASS_KEYS.map(weaponFamily))].sort(), [...WEAPON_FAMILIES].sort());
  assert.equal(weaponFamily('knight'), 'sword');
});

test('the Trader sells potions and gear up to his tier; an id from outside is an item only when it is one', () => {
  for (const id of ITEM_KEYS) assert.equal(SHOP.includes(id), ITEMS[id].kind === 'potion' || ITEMS[id].tier <= SHOP_TIER, id);
  assert.ok(SHOP.includes('iron_sword') && !SHOP.includes('steel_sword'));
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
    for (const slot of EQUIP_SLOTS.slice(1)) assert.equal(equipError(cls, 15, `hypurr_${slot}`), '', `${cls} wears ${slot}`);
    assert.equal(ITEM_KEYS.filter((id) => ITEMS[id].kind === 'weapon' && !equipError(cls, 99, id)).length, TIERS.length * WEAPON_FAMILIES.length, `${cls} can hold every weapon`);
  }
  for (const id of ['hp_small', 'nothing', 'constructor', undefined, 5]) assert.match(equipError('fighter', 99, id), /cannot be equipped/);
  assert.ok(CLASSES.knight.weapon === 'shield');   // the reason weaponFamily exists
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
    assert.deepEqual(cleanEquip(raw), { weapon: null, head: null, body: null, hands: null, feet: null });
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
    { weapon: 'iron_staff', head: null, body: 'steel_body', hands: null, feet: null });
});

// ---------------------------------------------------------------- the look

test('the look code: which pieces, which tiers and the kind of weapon in the paw, and nothing else', () => {
  assert.equal(lookCode(null, 'fighter'), 0);
  assert.equal(lookCode({}, 'fighter'), 0);
  const none = { weapon: -1, head: -1, body: -1, hands: -1, feet: -1, family: null };
  assert.deepEqual(lookOf(0), none);
  for (const junk of [undefined, null, -5, 1.5, NaN, 'x', {}]) assert.deepEqual(lookOf(junk), none);
  assert.deepEqual(lookOf(lookCode(IRON)), { weapon: 1, head: 1, body: 1, hands: 1, feet: 1, family: 'sword' });
  const mixed = { weapon: 'hypurr_bow', head: 'leather_head', body: null, hands: 'steel_hands', feet: 'hypurr_feet' };
  assert.deepEqual(lookOf(lookCode(mixed)), { weapon: 3, head: 0, body: -1, hands: 2, feet: 3, family: 'bow' });
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
  assert.deepEqual(rollLoot('chaser', 2, dice([0, 0.999, 0.9])), [['bronze_staff', 1]], 'the lowest tier has none below: no draw is spent on it');
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
  assert.equal(pieces.size, 4 + WEAPON_FAMILIES.length);
  assert.equal(rollLoot('boss', 18, dice([], 0.999999))[0][0], 'hypurr_staff', 'the last piece of the pool, not past it');
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
