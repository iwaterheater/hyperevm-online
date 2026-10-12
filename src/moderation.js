// What players type before others see it: names and chat lines. Pure - no imports - so the server and the tests share it.
//
// The word list here is short on purpose: the worst of two languages, enough to keep the chat of a small world decent.
// A server adds its own in data/banned-words.txt, a word a line (see server.js).

export const NAME_MAX = 16, NAME_MIN = 2, CHAT_MAX = 140;
export const DEFAULT_NAME = 'Cat';
// names that would speak with a voice they do not have
const RESERVED = ['system', 'server', 'admin', 'administrator', 'moderator', 'gm', 'gamemaster', 'support', 'hyperevm', 'hyperliquid'];
export const BANNED_WORDS = ['fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'retard', 'whore', 'slut',
  'хуй', 'хуе', 'хуё', 'хуи', 'пизд', 'ебат', 'ебан', 'ебал', 'ёбан', 'бляд', 'блят', 'сука', 'суки', 'мудак', 'пидор', 'пидар', 'гандон', 'залуп', 'шлюх'];

// Look-alikes folded together, so that "sh1t" and "ѕhіt" are what they look like. Only for comparing: nobody's text is rewritten.
const FOLD = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i', ё: 'е' };
const fold = (text) => text.toLowerCase().normalize('NFKC').replace(/[0134579@$!ё]/g, (ch) => FOLD[ch] ?? ch);
// invisible and control characters: they hide words from a filter and break a chat line
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g;

// what a client sent as text: a string, or a number; anything else is nothing
const textOf = (raw) => (typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '');

// -> the banned word a text contains, or ''. `words` are lower-case; a word is found inside longer ones too, letters
// only: "a s s" is not looked for, "class" is not a hit for a word that is not on the list.
export function bannedIn(text, words = BANNED_WORDS) {
  const flat = fold(textOf(text));
  return words.find((word) => word && flat.includes(word)) ?? '';
}

// A name as the world will show it: letters and digits of any script, single spaces, and _ - . between them; no
// longer than NAME_MAX. What is too short, reserved or indecent becomes DEFAULT_NAME.
export function cleanName(raw, words = BANNED_WORDS) {
  const name = textOf(raw).normalize('NFKC').replace(INVISIBLE, '').replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  if ([...name].length < NAME_MIN || !/[\p{L}\p{N}]/u.test(name)) return DEFAULT_NAME;
  if (RESERVED.includes(fold(name).replace(/[^a-zа-я]/g, '')) || bannedIn(name, words)) return DEFAULT_NAME;
  return name;
}

// The name a newcomer gets when `taken` (the names in the world, any case) already has it: "Mochi", "Mochi 2", ...
// Nobody can speak in the chat under another player's name.
export function uniqueName(name, taken) {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const next = `${name.slice(0, NAME_MAX - String(n).length - 1).trim()} ${n}`;
    if (!used.has(next.toLowerCase())) return next;
  }
}

// A chat line as the others will read it: one line, no invisible characters, no longer than CHAT_MAX, and every word
// that holds a banned one starred out. '' for nothing worth sending.
export function cleanChat(raw, words = BANNED_WORDS) {
  const text = textOf(raw).normalize('NFKC').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX).trim();
  return text.split(' ').map((word) => (bannedIn(word, words) ? '*'.repeat([...word].length) : word)).join(' ');
}
