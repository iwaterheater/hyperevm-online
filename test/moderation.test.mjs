// Names and chat lines before others see them (src/moderation.js).
// Run: node --test test/moderation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { NAME_MAX, CHAT_MAX, DEFAULT_NAME, BANNED_WORDS, bannedIn, cleanName, uniqueName, cleanChat } from '../src/moderation.js';

const ZERO_WIDTH = String.fromCharCode(0x200b), BELL = String.fromCharCode(7), SOFT_HYPHEN = String.fromCharCode(0xad);

test('cleanName: letters and digits of any script, single spaces, no markup, no invisible characters, sixteen at most', () => {
  assert.equal(cleanName('  PerpMe  '), 'PerpMe');
  assert.equal(cleanName('Кот   Вася'), 'Кот Вася');
  assert.equal(cleanName('猫の王'), '猫の王');
  assert.equal(cleanName('Sir_Pounce-2.0'), 'Sir_Pounce-2.0');
  assert.equal(cleanName('<b>Mochi</b> & co'), 'bMochib co');
  assert.equal(cleanName(`Mo${ZERO_WIDTH}chi${BELL}${SOFT_HYPHEN}`), 'Mochi');
  assert.equal(cleanName('x'.repeat(40)), 'x'.repeat(NAME_MAX));
  assert.equal(cleanName('abcdefghijklmno  pq'), 'abcdefghijklmno', 'no space left at the cut');
  for (const junk of ['', ' ', 'a', '!!', '__', undefined, null, 7, {}, [], ['Mochi'], true, '💩💩💩']) assert.equal(cleanName(junk), DEFAULT_NAME, String(junk));
  assert.equal(cleanName(42), '42');
});

test('cleanName: nobody speaks as the game itself, and an indecent name is no name', () => {
  for (const name of ['System', 'ADMIN', 'a d m i n', 'GM', 'Mod_erator', 'Server', 'Hyperliquid', 'Admin 2', 'G.M.']) assert.equal(cleanName(name), DEFAULT_NAME, name);
  for (const name of ['GMan', 'Systematic', 'Serverus']) assert.equal(cleanName(name), name, `${name} is only near one`);
  for (const word of BANNED_WORDS) assert.equal(cleanName(`x${word}x`), DEFAULT_NAME, word);
  assert.equal(cleanName('Sh1tLord'), DEFAULT_NAME, 'digits for letters are read as the letters');
  assert.equal(cleanName('F@ggot'.replace('@', '4')), DEFAULT_NAME);
  assert.equal(cleanName('Glass Cannon'), 'Glass Cannon');
  // a server's own list is used instead of the built-in one
  assert.equal(cleanName('Noobmaster', ['noob']), DEFAULT_NAME);
  assert.equal(cleanName('Shitake', []), 'Shitake');
});

test('uniqueName: a name that is in the world already gets a number, whatever its case', () => {
  assert.equal(uniqueName('Mochi', []), 'Mochi');
  assert.equal(uniqueName('Mochi', ['Luna', 'Nyx']), 'Mochi');
  assert.equal(uniqueName('Mochi', ['mochi']), 'Mochi 2');
  assert.equal(uniqueName('mochi', ['MOCHI', 'Mochi 2', 'Mochi 3']), 'mochi 4');
  const long = 'Abcdefghijklmnop';
  assert.equal(uniqueName(long, [long]), 'Abcdefghijklmn 2');
  assert.ok(uniqueName(long, [long]).length <= NAME_MAX);
  assert.equal(uniqueName('Cat', new Set(['Cat', 'Cat 2'])), 'Cat 3', 'any list of names will do');
});

test('cleanChat: one line of sane length, and a word that holds a banned one is starred out', () => {
  assert.equal(cleanChat('  hello   there\nfriend  '), 'hello there friend');
  assert.equal(cleanChat(`a${ZERO_WIDTH}b${BELL}c`), 'a b c');
  assert.equal(cleanChat('x'.repeat(500)).length, CHAT_MAX);
  for (const empty of ['', '   ', ZERO_WIDTH, undefined, null, {}, ['hi']]) assert.equal(cleanChat(empty), '');
  assert.equal(cleanChat('you fucking noob'), 'you ******* noob');
  assert.equal(cleanChat('SHIT! that hurt'), '***** that hurt');
  assert.equal(cleanChat('class assassin grass bass'), 'class assassin grass bass', 'what is not on the list is left alone');
  assert.equal(cleanChat('gg wp, see you at the King'), 'gg wp, see you at the King');
  assert.equal(cleanChat('привет, как дела?'), 'привет, как дела?');
  assert.equal(cleanChat('ты noob', ['noob']), 'ты ****');
  assert.equal(bannedIn('all good here'), '');
  assert.notEqual(bannedIn('Sh1T'), '');
});
