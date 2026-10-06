import { CLASSES, CLASS_KEYS, START_CLASSES } from '../shared.js';
import { isBlocked, qPos } from '../map/format.js';
import { h, row, button, numberField, selectField, checkField, leaveField } from './ui/dom.js';
import { hintFor } from './keymap.js';

// Play-testing (#menu-play): Play and Play from camera open the game in a second tab, at /?play=1, with a made-up
// character - any class at any level, optionally invulnerable and twice as fast. The server grants such a character
// only to whoever may save the map and never writes it to players.json.
//
// The editor and the play tab talk through localStorage['hypercat-editor-play']:
//   { id, at, lvl, cls, god, speed }    id = Date.now() of the Play request, at = [x, z] | null (the start point)
// The game reads it when it joins. `id` is how the play tab tells a new Play request (go where the editor asked) from
// its own reload after a plain save (come back to where the tester stood).
//
// The order of a Play is fixed, and each step is where it is for a reason:
//   1. open edits first: a typed field commits; an edit that is still open stops the Play
//   2. window.open('', 'hypercat-play') - SYNCHRONOUSLY in the click or key handler, before anything is awaited:
//      a pop-up that is not opened inside the user's gesture is blocked. An existing play tab is returned as it is.
//   3. the request goes into storage BEFORE the save, so a play tab that the save reloads already finds it
//   4. unsaved changes are saved (the game always plays the server's map); a failed save takes the request back
//   5. the tab goes to /?play=1 - one play tab, used again every time
// The way back is the game's "Edit here": it opens /editor.html#at=x,z into the window named 'hypercat-editor', which
// is this tab (main.js), so the editor comes back with its undo history and the camera on that spot.

const PLAY_KEY = 'hypercat-editor-play';        // localStorage, shared with the game
const TOKEN_KEY = 'hypercat-editor-token';      // sessionStorage, token mode: the play tab joins with the same token
const WINDOW_NAME = 'hypercat-play';
const PLAY_URL = '/?play=1';
const LEVELS = [1, 40];                         // what the server grants a test character
const BUSY = 'Finish the current edit first';
const READ_ONLY = 'Read-only: server is not in editor mode';

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// Storage may be full, disabled or hold old data: every access is guarded, and what is read is checked.
function readRaw() {
  try { return localStorage.getItem(PLAY_KEY); } catch { return null; }
}
// value: the text to store, or null to remove the key. -> whether storage took it
function writeRaw(value) {
  try {
    if (value === null) localStorage.removeItem(PLAY_KEY);
    else localStorage.setItem(PLAY_KEY, value);
    return true;
  } catch { return false; }
}
function readRequest() {
  try {
    const raw = JSON.parse(readRaw());
    return isObj(raw) ? raw : null;
  } catch { return null; }
}

// The test character as it was last chosen - the options are remembered in the request itself.
function readOptions() {
  const opts = { lvl: LEVELS[0], cls: START_CLASSES[0], god: false, speed: 1 }, raw = readRequest();
  if (!raw) return opts;
  if (Number.isFinite(raw.lvl)) opts.lvl = Math.max(LEVELS[0], Math.min(LEVELS[1], Math.round(raw.lvl)));
  if (typeof raw.cls === 'string' && Object.hasOwn(CLASSES, raw.cls)) opts.cls = raw.cls;
  opts.god = raw.god === true;
  opts.speed = raw.speed === 2 ? 2 : 1;
  return opts;
}

export default function mount(el, ctx) {
  const { store, ui, net, actions } = ctx;
  const opts = readOptions();
  let running = false;      // a Play is on its way: its save may still be in flight
  let lastId = 0;

  const nextId = () => (lastId = Math.max(Date.now(), lastId + 1));     // two requests never share an id

  // A changed option is stored at once, inside the request the play tab last joined with: its id and place stay, so
  // the tab's next reload (a save) keeps the tester where it stands and only the character changes.
  const remember = () => {
    const prev = readRequest();
    const at = Array.isArray(prev?.at) && prev.at.length === 2 && prev.at.every(Number.isFinite) ? [prev.at[0], prev.at[1]] : null;
    writeRaw(JSON.stringify({ id: Number.isFinite(prev?.id) ? prev.id : 0, at, lvl: opts.lvl, cls: opts.cls, god: opts.god, speed: opts.speed }));
  };

  // ---------------------------------------------------------------- play

  // Steps 4 and 5: everything after the tab is open and the request is stored.
  async function finish(w, fresh, previous, request) {
    // A Play that does not happen leaves no trace: the old request is back, and a tab opened for it is closed.
    const abort = (text) => {
      writeRaw(previous);
      if (fresh) { try { w.close(); } catch { /* it is gone already */ } }
      ui.toast(text, 'warn');
    };

    if (store.dirty && !(await net.save())) {      // net.save has said why
      abort('Not playing: the map was not saved');
      return false;
    }
    if (net.info?.tokenRequired) {
      // the play tab must join with the editor token, or the server treats it as an ordinary player
      const token = await net.token();
      if (!token) {
        abort('Not playing: the editor token is needed');
        return false;
      }
      try { w.sessionStorage.setItem(TOKEN_KEY, token); } catch { /* the game asks for it itself */ }
    }

    const url = new URL(PLAY_URL, location.href).href;
    try {
      if (w.closed) throw new Error('the play tab was closed');
      w.location.href = url;
      w.focus();
    } catch {
      // closed, or showing another site by now: open it again (which the browser may refuse this long after the click)
      let again = null;
      try { again = window.open(url, WINDOW_NAME); } catch { again = null; }
      if (!again) {
        abort('The play tab was closed: press Play again');
        return false;
      }
      again.focus();
    }
    ui.setNote(request.at ? `Playing from the camera (${request.at[0]}, ${request.at[1]})` : 'Playing from the start point');
    return true;
  }

  // Steps 1 to 3 - synchronous, so that window.open() still belongs to the click or the key that asked for it.
  function start(fromCamera) {
    if (!leaveField()) document.activeElement?.blur?.();
    if (!store.map) return false;
    if (store.grouping) { ui.toast(BUSY, 'warn'); return false; }
    if (ui.readOnly) { ui.toast(READ_ONLY, 'warn'); return false; }
    if (running) return false;
    closeOptions();

    let w = null;
    try { w = window.open('', WINDOW_NAME); } catch { w = null; }
    if (!w) {
      ui.toast('Allow pop-ups for this site to play-test', 'warn');
      return false;
    }
    let fresh = false;
    try { fresh = w.location.href === 'about:blank'; } catch { /* the tab shows another site: it is not a new one */ }
    if (fresh) {
      // the new tab is in front while the map is saved: say what it is waiting for
      try {
        w.document.title = 'HyperCat play-test';
        w.document.body.textContent = 'Starting the play-test\u2026 If this takes long, look at the editor tab: the map is being saved, or it is asking a question.';
      } catch { /* a blank tab is fine too */ }
    }

    const previous = readRaw(), target = ctx.viewport.target;
    const at = fromCamera ? [qPos(target.x), qPos(target.z)] : null;
    const request = { id: nextId(), at, lvl: opts.lvl, cls: opts.cls, god: opts.god, speed: opts.speed };
    if (!writeRaw(JSON.stringify(request))) {
      if (fresh) { try { w.close(); } catch { /* gone */ } }
      ui.toast('Play-testing needs the browser\'s storage, and it is full or switched off', 'error');
      return false;
    }
    if (at) {
      // the server moves a tester it cannot put there; better to hear it here than to wonder in the game
      if (Math.hypot(at[0], at[1]) > store.map.radius - 1) ui.toast('The camera looks beyond the island: the tester starts at its edge');
      else if (isBlocked(store.map, at[0], at[1])) ui.toast('The camera looks at blocked ground: the tester starts at the start point instead');
    }

    running = true;
    sync();
    finish(w, fresh, previous, request)
      .catch((err) => {
        console.error('[editor] play failed', err);
        writeRaw(previous);
        ui.toast(`Play failed: ${String(err?.message ?? err).slice(0, 240)}`, 'error');
      })
      .finally(() => { running = false; sync(); });
    return true;
  }

  // ---------------------------------------------------------------- the menu

  const key = hintFor('play.start');
  const playButton = button(['\u25b6 Play', key && h('kbd', { class: 'ui-kbd' }, key)], () => actions.run('play.start'));
  playButton.classList.add('primary');
  const cameraButton = button('From camera', () => actions.run('play.fromCamera'));
  const summary = h('span');
  const optionsButton = button([summary, ' \u25be'], null, { title: 'The test character: level, class, invulnerable, speed' });
  optionsButton.setAttribute('aria-haspopup', 'true');

  const level = numberField({
    value: opts.lvl, min: LEVELS[0], max: LEVELS[1], step: 1,
    onCommit: (v) => { if (Number.isFinite(v)) { opts.lvl = v; changed(); } },
  });
  // the two starting classes first, then the professions with the class they grow from
  const classLabel = (id) => (CLASSES[id].base ? `${CLASSES[id].name} (${CLASSES[CLASSES[id].base]?.name ?? CLASSES[id].base})` : CLASSES[id].name);
  const cls = selectField({
    value: opts.cls,
    options: [...START_CLASSES, ...CLASS_KEYS.filter((id) => !START_CLASSES.includes(id))].map((id) => ({ value: id, label: classLabel(id) })),
    onCommit: (v) => { opts.cls = v; changed(); },
  });
  const god = checkField({ value: opts.god, onCommit: (on) => { opts.god = !!on; changed(); } });
  const fast = checkField({ value: opts.speed === 2, onCommit: (on) => { opts.speed = on ? 2 : 1; changed(); } });
  level.input.title = `The level of the test character (${LEVELS[0]}\u2013${LEVELS[1]}); it knows every skill of that level`;
  god.el.title = 'Monsters cannot hurt the tester';
  fast.el.title = 'The tester moves twice as fast';

  const popover = h('div', { class: 'ui-popover' },
    row('Level', level),
    row('Class', cls),
    row('Invulnerable', god),
    row('Speed \u00d7 2', fast),
    h('div', { class: 'ui-hint' }, 'A test character: it is never saved. A change applies the next time the play tab joins - on Play, or when a save reloads it.'));
  popover.style.width = '250px';
  popover.style.whiteSpace = 'normal';

  // The popover API puts the box above everything (the menu bar clips its children) and closes it on a click
  // elsewhere and on Escape; the button is its invoker, so a click on the button closes an open box instead of
  // reopening it. Without that API the box is toggled by hand.
  const native = typeof popover.showPopover === 'function';
  const place = () => {
    const r = optionsButton.getBoundingClientRect();
    popover.style.inset = 'auto';
    popover.style.top = `${Math.round(r.bottom + 4)}px`;
    popover.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  };
  if (native) {
    popover.popover = 'auto';
    optionsButton.popoverTargetElement = popover;
    popover.addEventListener('beforetoggle', (ev) => { if (ev.newState === 'open') place(); });
    popover.addEventListener('toggle', (ev) => optionsButton.classList.toggle('active', ev.newState === 'open'));
  } else {
    popover.hidden = true;
    popover.style.position = 'fixed';
    optionsButton.addEventListener('click', () => {
      popover.hidden = !popover.hidden;
      if (!popover.hidden) place();
      optionsButton.classList.toggle('active', !popover.hidden);
    });
  }
  function closeOptions() {
    if (!native) { popover.hidden = true; optionsButton.classList.remove('active'); return; }
    try { if (popover.matches(':popover-open')) popover.hidePopover(); } catch { /* not open */ }
  }

  el.replaceChildren(optionsButton, h('span', { class: 'ui-group' }, cameraButton, playButton), popover);

  function sync() {
    const off = !store.map || !!ui.readOnly || running;
    playButton.disabled = cameraButton.disabled = off;
    playButton.title = ui.readOnly ? READ_ONLY
      : running ? 'Starting the play-test\u2026'
        : 'Save unsaved changes and play from the start point, in the play tab';
    cameraButton.title = ui.readOnly ? READ_ONLY
      : running ? 'Starting the play-test\u2026'
        : 'Save unsaved changes and play from the point the camera looks at';
    summary.textContent = `Lv ${opts.lvl} ${CLASSES[opts.cls]?.name ?? opts.cls}${opts.god ? ' \u00b7 God' : ''}${opts.speed === 2 ? ' \u00b7 \u00d72' : ''}`;
  }
  function changed() {
    remember();
    sync();
  }

  // Always "enabled", like file.save: in read-only mode the key answers with the reason instead of doing nothing.
  const offer = (id, fn) => { if (!actions.has(id)) actions.register(id, fn); };
  offer('play.start', () => start(false));
  offer('play.fromCamera', () => start(true));

  store.on('load', sync);
  ui.on('readOnly', sync);
  sync();
  return {};
}
