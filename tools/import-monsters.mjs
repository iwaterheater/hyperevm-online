// Brings monsters by Quaternius (CC0, quaternius.com) into assets/monsters/: the packs "Ultimate Monsters" and
// "Cute Animated Monsters", and a few of his animals as the open-source game World of ClaudeCraft ships them.
//
//   node tools/import-monsters.mjs ultimate=<folder with Big/, Blob/ and Flying/> cute=<folder with the pack's glTF files>
//                                  animals=<folder with wolf.glb, fox.glb ...>
//
// Any of the three may be left out; only the monsters of the sources named are written.
//
// The animals are public/models/creatures/<name>.glb of github.com/levy-street/world-of-claudecraft, which lists them
// as Quaternius's, CC0, in its CREDITS.md. They are packed there with meshopt and quantized, which this script does
// not read: unpack them first (glTF-Transform: read, dequantize(), drop both extensions, write).
//
// Ultimate Monsters comes in three sets - Big (two-legged), Blob and Flying - and Cute Animated Monsters as one folder
// of walkers and flyers; every monster is a .gltf file with everything embedded and up to fourteen animations. The game
// needs five: standing, moving, striking, flinching and dying. This script takes the monsters listed below, drops the
// other animations with their data, and writes each as one binary .glb named after the monster's kind in MOB_TYPES
// (src/shared.js); src/monster.js loads them by that name.
// To add a monster: put a line here, a kind in MOB_TYPES and a look in src/monster.js, then run this again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// the animations kept from each set, by what the game calls them
export const CLIPS = {
  big:    { idle: 'Idle', walk: 'Walk', attack: 'Punch', hit: 'HitReact', death: 'Death' },
  blob:   { idle: 'Idle', walk: 'Walk', attack: 'Bite_Front', hit: 'HitRecieve', death: 'Death' },   // (the pack spells it so)
  flying: { idle: 'Flying_Idle', walk: 'Fast_Flying', attack: 'Headbutt', hit: 'HitReact', death: 'Death' },
  cute:   { idle: 'Idle', walk: 'Walk', attack: 'Bite_Front', hit: 'HitRecieve', death: 'Death' },
  wing:   { idle: 'Flying', walk: 'Flying', attack: 'Bite_Front', hit: 'HitRecieve', death: 'Death' },   // one animation to hang and to fly
  hunter: { idle: 'Idle', walk: 'Gallop', attack: 'Attack', hit: 'Idle_HitReact_Left', death: 'Death' },
  grazer: { idle: 'Idle', walk: 'Walk', attack: 'Attack_Headbutt', hit: 'Idle_HitReact_Left', death: 'Death' },
  spider: { idle: 'Spider_Idle', walk: 'Spider_Walk', attack: 'Spider_Attack', hit: null, death: 'Spider_Death' },   // these two do not flinch
  raptor: { idle: 'Velociraptor_Idle', walk: 'Velociraptor_Run', attack: 'Velociraptor_Attack', hit: null, death: 'Velociraptor_Death' },
};
// where a set lies: the pack it belongs to and its folder inside the pack
export const SETS = {
  big: ['ultimate', 'Big'], blob: ['ultimate', 'Blob'], flying: ['ultimate', 'Flying'],
  cute: ['cute', ''], wing: ['cute', ''],
  hunter: ['animals', ''], grazer: ['animals', ''], spider: ['animals', ''], raptor: ['animals', ''],
};
// kind -> [set, file]
export const MONSTERS = {
  slime: ['blob', 'GreenBlob'], pinkslime: ['blob', 'PinkBlob'], mushnub: ['blob', 'Mushnub'], spikeslime: ['blob', 'GreenSpikyBlob'],
  frog: ['big', 'Frog'], cactoro: ['big', 'Cactoro'], orc: ['big', 'Orc'], orcbrute: ['big', 'Orc_Skull'], shaman: ['big', 'Tribal'],
  yeti: ['big', 'Yeti'], demon: ['big', 'Demon'], bluedemon: ['big', 'BlueDemon'], alien: ['big', 'Alien'],
  bee: ['flying', 'Armabee'], ghost: ['flying', 'Ghost'], wraith: ['flying', 'Ghost_Skull'], dragon: ['flying', 'Dragon'],
  birb: ['big', 'Birb'], bunny: ['big', 'Bunny'], dino: ['big', 'Dino'], fishman: ['big', 'Fish'], monkroose: ['big', 'Monkroose'],
  mushroomking: ['big', 'MushroomKing'], ninja: ['big', 'Ninja'],
  alienblob: ['blob', 'Alien'], puffbirb: ['blob', 'Birb'], cactoblob: ['blob', 'Cactoro'], tabby: ['blob', 'Cat'], chicken: ['blob', 'Chicken'],
  pup: ['blob', 'Dog'], snapper: ['blob', 'Fish'], eldermushnub: ['blob', 'Mushnub_Evolved'], ninjablob: ['blob', 'Ninja'],
  orcwhelp: ['blob', 'Orc'], pigeon: ['blob', 'Pigeon'], hexblob: ['blob', 'Wizard'], snowball: ['blob', 'Yeti'],
  alpaking: ['flying', 'Alpaking'], alpakinglord: ['flying', 'Alpaking_Evolved'], queenbee: ['flying', 'Armabee_Evolved'],
  drake: ['flying', 'Dragon_Evolved'], glub: ['flying', 'Glub'], glublord: ['flying', 'Glub_Evolved'], goleling: ['flying', 'Goleling'],
  golelingelder: ['flying', 'Goleling_Evolved'], hywirl: ['flying', 'Hywirl'], skypigeon: ['flying', 'Pigeon'], squidle: ['flying', 'Squidle'],
  tribalmask: ['flying', 'Tribal'],
  // the fiftieth, the flying Demon, comes with a single animation and is left out

  // Cute Animated Monsters. The Tree has no Death: the game topples it over itself.
  stalker: ['cute', 'Alien'], lanky: ['cute', 'Alien_Tall'], prickle: ['cute', 'Cactus'], hen: ['cute', 'Chicken'], crab: ['cute', 'Crab'],
  cyclops: ['cute', 'Cyclops'], deer: ['cute', 'Deer'], fiend: ['cute', 'Demon'], spook: ['cute', 'Ghost'], gremlin: ['cute', 'GreenDemon'],
  shroom: ['cute', 'Mushroom'], panda: ['cute', 'Panda'], penguin: ['cute', 'Penguin'], pig: ['cute', 'Pig'], skull: ['cute', 'Skull'],
  treant: ['cute', 'Tree'], frostling: ['cute', 'Yeti'],
  bat: ['wing', 'Bat'], hornet: ['wing', 'Bee'], cthulhu: ['wing', 'Cthulhu'], wyrmling: ['wing', 'YellowDragon'],

  // the animals
  wolf: ['hunter', 'wolf'], fox: ['hunter', 'fox'], bull: ['grazer', 'bull'], stag: ['grazer', 'stag'], alpaca: ['grazer', 'alpaca'],
  spider: ['spider', 'spider'], raptor: ['raptor', 'velociraptor'],
};
// the animations a monster's file may lack; src/monster.js makes up for them
const OPTIONAL = { treant: ['Death'] };

const pad4 = (n) => (n + 3) & ~3;
const dataOf = (uri) => Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');

// A .gltf with embedded data, or the JSON of a .glb with its binary chunk -> the bytes of a .glb that keeps only the
// animations named in `keep`.
export function slim(gltf, keep, bin = null) {
  const j = structuredClone(gltf);
  const buffers = j.buffers.map((b) => (b.uri ? dataOf(b.uri) : bin));
  j.animations = (j.animations ?? []).filter((a) => keep.includes(a.name));
  // an image that is a data URI moves into the binary chunk
  const extra = [];
  for (const image of j.images ?? []) {
    if (!image.uri) continue;
    const bytes = dataOf(image.uri);
    image.mimeType ??= image.uri.slice(5, image.uri.indexOf(';'));
    delete image.uri;
    image.bufferView = j.bufferViews.length + extra.length;
    extra.push(bytes);
  }
  // which accessors are still used, and through them which buffer views
  const used = new Set();
  for (const mesh of j.meshes ?? []) {
    for (const p of mesh.primitives) {
      for (const a of Object.values(p.attributes)) used.add(a);
      if (p.indices !== undefined) used.add(p.indices);
      for (const target of p.targets ?? []) for (const a of Object.values(target)) used.add(a);
    }
  }
  for (const skin of j.skins ?? []) if (skin.inverseBindMatrices !== undefined) used.add(skin.inverseBindMatrices);
  for (const anim of j.animations) for (const s of anim.samplers) { used.add(s.input); used.add(s.output); }
  const accessorAt = new Map([...used].sort((a, b) => a - b).map((old, i) => [old, i]));
  const accessors = [...accessorAt.keys()].map((old) => j.accessors[old]);

  const views = [];   // { bytes, view }
  const viewAt = new Map();
  const take = (old) => {
    if (!viewAt.has(old)) {
      const v = j.bufferViews[old], start = v.byteOffset ?? 0;
      viewAt.set(old, views.length);
      views.push({ bytes: buffers[v.buffer].subarray(start, start + v.byteLength), view: { ...v } });
    }
    return viewAt.get(old);
  };
  for (const a of accessors) if (a.bufferView !== undefined) a.bufferView = take(a.bufferView);
  for (const image of j.images ?? []) {
    if (image.bufferView === undefined) continue;
    const own = image.bufferView - j.bufferViews.length;
    if (own >= 0) { image.bufferView = views.length; views.push({ bytes: extra[own], view: { byteLength: extra[own].length } }); }
    else image.bufferView = take(image.bufferView);
  }
  let size = 0;
  for (const v of views) { v.view.buffer = 0; v.view.byteOffset = size; size = pad4(size + v.bytes.length); }
  const packed = Buffer.alloc(size);
  for (const v of views) v.bytes.copy(packed, v.view.byteOffset);

  const at = (old) => accessorAt.get(old);
  for (const mesh of j.meshes ?? []) {
    for (const p of mesh.primitives) {
      for (const k of Object.keys(p.attributes)) p.attributes[k] = at(p.attributes[k]);
      if (p.indices !== undefined) p.indices = at(p.indices);
      for (const target of p.targets ?? []) for (const k of Object.keys(target)) target[k] = at(target[k]);
    }
  }
  for (const skin of j.skins ?? []) if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = at(skin.inverseBindMatrices);
  for (const anim of j.animations) for (const s of anim.samplers) { s.input = at(s.input); s.output = at(s.output); }
  j.accessors = accessors;
  j.bufferViews = views.map((v) => v.view);
  j.buffers = [{ byteLength: size }];

  const json = Buffer.from(JSON.stringify(j)), jsonLength = pad4(json.length);
  const out = Buffer.alloc(12 + 8 + jsonLength + 8 + size, 0x20);   // the JSON chunk is padded with spaces
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonLength, 12); out.writeUInt32LE(0x4e4f534a, 16); json.copy(out, 20);
  out.writeUInt32LE(size, 20 + jsonLength); out.writeUInt32LE(0x004e4942, 24 + jsonLength); packed.copy(out, 28 + jsonLength);
  return out;
}

// A model file -> [its JSON, its binary chunk or null]: a .glb carries both, a .gltf here has its data embedded.
function read(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.readUInt32LE(0) !== 0x46546c67) return [JSON.parse(bytes.toString('utf8')), null];
  const jsonLength = bytes.readUInt32LE(12), at = 20 + jsonLength;
  return [JSON.parse(bytes.subarray(20, at).toString('utf8')), at < bytes.length ? bytes.subarray(at + 8, at + 8 + bytes.readUInt32LE(at)) : null];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const from = Object.fromEntries(process.argv.slice(2).map((arg) => arg.split(/=(.*)/s).slice(0, 2)));
  if (!from.ultimate && !from.cute && !from.animals) { console.error('usage: node tools/import-monsters.mjs ultimate=<folder> cute=<folder> animals=<folder>'); process.exit(1); }
  const to = fileURLToPath(new URL('../assets/monsters/', import.meta.url));
  fs.mkdirSync(to, { recursive: true });
  for (const [kind, [set, file]] of Object.entries(MONSTERS)) {
    const [pack, folder] = SETS[set];
    if (!from[pack]) continue;
    const dir = path.join(from[pack], folder);
    const source = [path.join(dir, 'glTF', `${file}.gltf`), path.join(dir, `${file}.gltf`), path.join(dir, `${file}.glb`)].find((p) => fs.existsSync(p));
    if (!source) { console.error(`missing: ${file}.gltf or .glb in ${dir}`); process.exitCode = 1; continue; }
    const [gltf, bin] = read(source), keep = [...new Set(Object.values(CLIPS[set]))].filter(Boolean);
    if (gltf.extensionsRequired?.length) { console.error(`${file}: packed with ${gltf.extensionsRequired.join(', ')} - unpack it first`); process.exitCode = 1; continue; }
    const missing = keep.filter((name) => !gltf.animations?.some((a) => a.name === name) && !OPTIONAL[kind]?.includes(name));
    if (missing.length) { console.error(`${file}: no animation ${missing.join(', ')}`); process.exitCode = 1; continue; }
    const glb = slim(gltf, keep, bin);
    fs.writeFileSync(path.join(to, `${kind}.glb`), glb);
    console.log(`${kind.padEnd(13)} ${file.padEnd(16)} ${(glb.length / 1024).toFixed(0).padStart(5)} KB`);
  }
}
