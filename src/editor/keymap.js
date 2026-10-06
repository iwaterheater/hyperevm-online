import { reportOnce } from './actions.js';
import { STEP_EVENT, leaveField } from './ui/dom.js';

// The keyboard of the editor. This module is the ONLY one that listens to keydown / keyup, and BINDINGS below is the
// ONLY table of keys: the toolbar hints and the Help sheet are generated from it.
//
// - Keys are matched on KeyboardEvent.code, never on .key, so they sit in the same place on every layout
//   (with a Russian layout the key of V types a Cyrillic letter, and it is still KeyV).
// - `Mod` is the command key on macOS and Ctrl everywhere else; the other one of the two must be up.
//   A chord matches only with exactly its modifiers.
// - Order on a key press: the focus rule (nothing fires while the user types in a field) -> the context of the active
//   tool (tool.key(action, ev), only when the tool says it used the key) -> the `global` table (actions.run) -> the
//   `camera` table. preventDefault is called for every chord that matched.
// - The viewport pans with held keys. It reads them from `held` (a Set of codes) every frame.

const MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.userAgentData?.platform || navigator.platform || '');

const row = (ctx, chord, action, label, held = false) => ({ ctx, chord, action, label, held });
const digits = (n) => Array.from({ length: n }, (_, i) => i + 1);

// { ctx, chord, action, label, held }
// ctx:    'global' | 'camera' - always on; 'select' | 'ghost' | 'brush' | 'path' - on while the active tool reports that
//         context (tool.context). A context row is offered to the tool and shadows the tables below it only when
//         tool.key(action, ev) returns true.
// chord:  modifiers in the order Mod, Alt, Shift, then the code - what chordOf(ev) returns.
// action: global and camera rows: an id for actions.run; context rows: the name passed to tool.key.
// held:   a key the viewport reads from `held` while it is down instead of an action (it also works with Shift).
// No chord appears twice in one context.
export const BINDINGS = [
  // ---- global
  row('global', 'KeyV', 'tool.select', 'Select tool'),
  row('global', 'KeyP', 'tool.place', 'Place tool'),
  row('global', 'KeyB', 'tool.scatter', 'Scatter brush'),
  row('global', 'KeyT', 'tool.paint', 'Terrain paint'),
  row('global', 'KeyY', 'tool.sculpt', 'Sculpt tool: hills and valleys (Y is up)'),
  row('global', 'KeyM', 'tool.spawn', 'Spawn tool'),
  row('global', 'KeyC', 'tool.chest', 'Chest tool'),
  row('global', 'KeyU', 'tool.npc', 'NPC tool'),
  row('global', 'KeyZ', 'tool.region', 'Region tool'),
  row('global', 'KeyL', 'tool.measure', 'Measure tool'),
  row('global', 'KeyG', 'snap.toggle', 'Toggle snapping'),
  row('global', 'Mod+KeyZ', 'edit.undo', 'Undo'),
  row('global', 'Mod+Shift+KeyZ', 'edit.redo', 'Redo'),
  row('global', 'Mod+KeyY', 'edit.redo', 'Redo'),
  row('global', 'Mod+KeyX', 'edit.cut', 'Cut'),
  row('global', 'Mod+KeyC', 'edit.copy', 'Copy'),
  row('global', 'Mod+KeyV', 'edit.paste', 'Paste'),
  row('global', 'Mod+KeyD', 'edit.duplicate', 'Duplicate and move the copies'),
  row('global', 'Mod+KeyA', 'edit.selectAll', 'Select all'),
  row('global', 'Delete', 'edit.delete', 'Delete the selection'),
  row('global', 'Backspace', 'edit.delete', 'Delete the selection'),
  row('global', 'Mod+KeyG', 'edit.group', 'Group the selection'),
  row('global', 'Mod+Shift+KeyG', 'edit.ungroup', 'Ungroup the selection'),
  row('global', 'Mod+KeyS', 'file.save', 'Save (also while typing)'),
  row('global', 'Mod+Enter', 'play.start', 'Play from the start point'),
  row('global', 'Escape', 'edit.cancel', 'Cancel, then back to Select, then clear the selection'),
  row('global', 'Shift+Slash', 'help.toggle', 'Show or hide this sheet'),
  row('global', 'F1', 'help.toggle', 'Show or hide this sheet'),

  // ---- camera
  row('camera', 'KeyW', 'pan.forward', 'Pan forward (Shift: 3 times faster)', true),
  row('camera', 'KeyA', 'pan.left', 'Pan left', true),
  row('camera', 'KeyS', 'pan.back', 'Pan back', true),
  row('camera', 'KeyD', 'pan.right', 'Pan right', true),
  row('camera', 'ArrowUp', 'pan.forward', 'Pan forward', true),
  row('camera', 'ArrowLeft', 'pan.left', 'Pan left', true),
  row('camera', 'ArrowDown', 'pan.back', 'Pan back', true),
  row('camera', 'ArrowRight', 'pan.right', 'Pan right', true),
  row('camera', 'Space', 'pan.drag', 'Hold and drag with the left button to pan', true),
  row('camera', 'Comma', 'view.rotateLeft', 'Rotate the view left by 15 degrees'),
  row('camera', 'Period', 'view.rotateRight', 'Rotate the view right by 15 degrees'),
  row('camera', 'Shift+Comma', 'view.tiltUp', 'Tilt the view up by 10 degrees'),
  row('camera', 'Shift+Period', 'view.tiltDown', 'Tilt the view down by 10 degrees'),
  row('camera', 'KeyF', 'view.frame', 'Frame the selection (the whole island when nothing is selected)'),
  row('camera', 'KeyH', 'view.home', 'Go to the start point'),
  row('camera', 'Home', 'view.home', 'Go to the start point'),
  row('camera', 'KeyO', 'view.overhead', 'Toggle the overhead view'),
  ...digits(4).map((n) => row('camera', `Alt+Digit${n}`, `view.bookmark.${n}`, `Go to camera bookmark ${n}`)),
  ...digits(4).map((n) => row('camera', `Alt+Shift+Digit${n}`, `view.bookmark.store.${n}`, `Store camera bookmark ${n}`)),

  // ---- select: the Select tool; the Spawn, Chest, NPC, Start and Region tools while idle
  row('select', 'KeyQ', 'rotate.ccw', 'Rotate the selection by +15 degrees'),
  row('select', 'Shift+KeyQ', 'rotate.ccw', 'Rotate the selection by +90 degrees'),
  row('select', 'Alt+KeyQ', 'rotate.ccw', 'Rotate the selection by +1 degree'),
  row('select', 'KeyE', 'rotate.cw', 'Rotate the selection by -15 degrees'),
  row('select', 'Shift+KeyE', 'rotate.cw', 'Rotate the selection by -90 degrees'),
  row('select', 'Alt+KeyE', 'rotate.cw', 'Rotate the selection by -1 degree'),
  row('select', 'BracketLeft', 'scale.down', 'Scale the selection by 0.9'),
  row('select', 'BracketRight', 'scale.up', 'Scale the selection by 1.1'),
  row('select', 'ArrowLeft', 'nudge.left', 'Nudge the selection west (-X) by the snap step'),
  row('select', 'ArrowRight', 'nudge.right', 'Nudge the selection east (+X) by the snap step'),
  row('select', 'ArrowUp', 'nudge.up', 'Nudge the selection north (-Z) by the snap step'),
  row('select', 'ArrowDown', 'nudge.down', 'Nudge the selection south (+Z) by the snap step'),
  row('select', 'Shift+ArrowLeft', 'nudge.left', 'Nudge west by 10 snap steps'),
  row('select', 'Shift+ArrowRight', 'nudge.right', 'Nudge east by 10 snap steps'),
  row('select', 'Shift+ArrowUp', 'nudge.up', 'Nudge north by 10 snap steps'),
  row('select', 'Shift+ArrowDown', 'nudge.down', 'Nudge south by 10 snap steps'),
  row('select', 'KeyX', 'axes.toggle', 'Toggle local / world gizmo axes'),
  row('select', 'Delete', 'selection.delete', 'Delete the active part of the tool (a region vertex), else the selection'),
  row('select', 'Backspace', 'selection.delete', 'Delete the active part of the tool (a region vertex), else the selection'),

  // ---- ghost: Place (in Line mode only before the first point), Paste
  row('ghost', 'KeyQ', 'rotate.ccw', 'Rotate the ghost by +15 degrees'),
  row('ghost', 'Shift+KeyQ', 'rotate.ccw', 'Rotate the ghost by +90 degrees'),
  row('ghost', 'Alt+KeyQ', 'rotate.ccw', 'Rotate the ghost by +1 degree'),
  row('ghost', 'KeyE', 'rotate.cw', 'Rotate the ghost by -15 degrees'),
  row('ghost', 'Shift+KeyE', 'rotate.cw', 'Rotate the ghost by -90 degrees'),
  row('ghost', 'Alt+KeyE', 'rotate.cw', 'Rotate the ghost by -1 degree'),
  row('ghost', 'BracketLeft', 'scale.down', 'Scale the ghost down'),
  row('ghost', 'BracketRight', 'scale.up', 'Scale the ghost up'),
  row('ghost', 'KeyR', 'ghost.reroll', 'Re-roll the random rotation and scale (Place)'),
  // a Line of the Place tool before its first point: one Backspace too many must not delete the selection
  row('ghost', 'Backspace', 'path.back', 'Place, Line: nothing left to take back (the selection is not deleted)'),
  row('ghost', 'Delete', 'path.back', 'Place, Line: nothing left to take back (the selection is not deleted)'),

  // ---- brush: Terrain brush and fill, Sculpt, Scatter
  row('brush', 'BracketLeft', 'brush.smaller', 'Smaller brush'),
  row('brush', 'BracketRight', 'brush.larger', 'Larger brush'),
  row('brush', 'Shift+BracketLeft', 'brush.optDown', 'Scatter: lower density. Terrain: soft edge. Sculpt: less strength'),
  row('brush', 'Shift+BracketRight', 'brush.optUp', 'Scatter: higher density. Terrain: hard edge. Sculpt: more strength'),
  ...digits(9).map((n) => row('brush', `Digit${n}`, `brush.type.${n}`, `Terrain: ground type ${n}. Sculpt: mode ${n}`)),
  // a Road of the Terrain tool before its first point: as for a Line above
  row('brush', 'Backspace', 'path.back', 'Terrain, Road: nothing left to take back (the selection is not deleted)'),
  row('brush', 'Delete', 'path.back', 'Terrain, Road: nothing left to take back (the selection is not deleted)'),

  // ---- path: a polygon, a road, a Place line with at least one point, a measurement in progress
  row('path', 'Backspace', 'path.back', 'Remove the last point'),
  row('path', 'Delete', 'path.back', 'Remove the last point'),
  row('path', 'Enter', 'path.commit', 'Finish the path'),
  // a road keeps the keys of its brush while its points are being clicked (the other paths do not use them)
  row('path', 'BracketLeft', 'brush.smaller', 'Road: narrower'),
  row('path', 'BracketRight', 'brush.larger', 'Road: wider'),
  ...digits(9).map((n) => row('path', `Digit${n}`, `brush.type.${n}`, `Road: ground type ${n}`)),
];

const TABLE = new Map();   // 'ctx chord' -> binding
for (const b of BINDINGS) {
  const key = `${b.ctx} ${b.chord}`;
  if (TABLE.has(key)) console.error(`[editor] keymap: ${b.chord} is bound twice in '${b.ctx}'`);
  TABLE.set(key, b);
}

// Holding a key down repeats these; every other action fires once per press (a held Mod+S must not save ten times).
const REPEAT = new Set(['edit.undo', 'edit.redo', 'view.rotateLeft', 'view.rotateRight', 'view.tiltUp', 'view.tiltDown',
  'rotate.ccw', 'rotate.cw', 'scale.down', 'scale.up', 'nudge.left', 'nudge.right', 'nudge.up', 'nudge.down',
  'brush.smaller', 'brush.larger', 'brush.optDown', 'brush.optUp', 'path.back']);

const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const LINE_INPUT = /^(text|search|number|url|email|tel|password)$/;   // inputs in which Enter means "done"
const PRESSABLE = 'button, summary, a[href], [role="button"]';        // what Enter and Space press when it has the focus
const COMMAND = new Set(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'ControlLeft', 'ControlRight']);
const MODIFIER = new Set(['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight']);

// -> true when the platform's command modifier is down and the other one is not
export function mod(ev) {
  return MAC ? !!ev.metaKey && !ev.ctrlKey : !!ev.ctrlKey && !ev.metaKey;
}

// -> e.g. 'Mod+Shift+KeyZ' (order: Mod, Alt, Shift, code). The "other" command key (Ctrl on macOS, the Windows key
// elsewhere) shows up as 'Ctrl' / 'Meta', which no binding uses: a chord with it down matches nothing.
export function chordOf(ev) {
  const parts = [];
  if (mod(ev)) parts.push('Mod');
  else {
    if (ev.ctrlKey) parts.push('Ctrl');
    if (ev.metaKey) parts.push('Meta');
  }
  if (ev.altKey) parts.push('Alt');
  if (ev.shiftKey) parts.push('Shift');
  parts.push(ev.code === 'NumpadEnter' ? 'Enter' : ev.code);
  return parts.join('+');
}

const KEY_NAMES_MAC = { Enter: '\u21a9', Backspace: '\u232b', Delete: '\u2326' };   // return, delete, forward delete
const KEY_NAMES = {
  Comma: ',', Period: '.', Slash: '/', BracketLeft: '[', BracketRight: ']', Escape: 'Esc', Space: 'Space', Home: 'Home',
  ArrowLeft: '\u2190', ArrowUp: '\u2191', ArrowRight: '\u2192', ArrowDown: '\u2193',
  Enter: MAC ? KEY_NAMES_MAC.Enter : 'Enter', Backspace: MAC ? KEY_NAMES_MAC.Backspace : 'Backspace', Delete: MAC ? KEY_NAMES_MAC.Delete : 'Del',
};
const MAC_SIGNS = { Alt: '\u2325', Shift: '\u21e7', Mod: '\u2318' };   // option, shift, command - in the order macOS writes them

// The Mod key as the user reads it in a hint about the mouse ("Mod-click"): the command sign on macOS, 'Ctrl' elsewhere.
export const MOD_LABEL = MAC ? MAC_SIGNS.Mod : 'Ctrl';

// A chord as the user reads it: 'Mod+Shift+KeyZ' -> shift-command-Z signs on macOS, 'Ctrl+Shift+Z' elsewhere.
export function chordLabel(chord) {
  const parts = chord.split('+'), code = parts.pop();
  const key = KEY_NAMES[code] ?? (/^(Key|Digit)/.test(code) ? code.replace(/^(Key|Digit)/, '') : code);
  if (MAC) return Object.keys(MAC_SIGNS).filter((m) => parts.includes(m)).map((m) => MAC_SIGNS[m]).join('') + key;
  return [...parts.map((m) => (m === 'Mod' ? 'Ctrl' : m)), key].join('+');
}

// A hint that names keys in the editor's own words - 'Alt+click', 'Alt+Shift+1', 'Shift + wheel', 'Mod+drag', 'Enter',
// 'Backspace' - as they are written on THIS keyboard, in the same signs chordLabel uses: on macOS the option, shift
// and command signs and the return and delete arrows ('Alt+click' reads as the option sign and '-click', 'Alt+Shift+1'
// as the two signs and '1'); elsewhere the words stay and Mod is 'Ctrl'. Every title, strip hint and status line that
// names a key goes through this, so one key has one name on the whole screen.
// Only for the editor's own sentences: a word of a name from the map ("Shift Valley") would be rewritten too.
export function keyTextFor(text, mac) {
  if (!mac) return String(text).replace(/\bMod\b/g, 'Ctrl');
  const sign = (name) => MAC_SIGNS[name === 'Option' ? 'Alt' : name];
  const order = Object.keys(MAC_SIGNS);
  return String(text)
    // modifiers and what they are held with: a key ('Alt+Shift+1', 'Shift+]'), a gesture ('Alt+click'), or nothing more
    .replace(/\b((?:(?:Alt|Option|Shift|Mod)\s?\+\s?)+)(Alt|Option|Shift|Mod|[A-Za-z]+|\d|[\[\]])/g, (all, mods, what) => {
      const names = mods.split('+').map((m) => m.trim()).filter(Boolean).map((m) => (m === 'Option' ? 'Alt' : m));
      const last = what === 'Option' ? 'Alt' : what;
      if (Object.hasOwn(MAC_SIGNS, last)) names.push(last);
      const signs = order.filter((m) => names.includes(m)).map((m) => MAC_SIGNS[m]).join('');
      if (Object.hasOwn(MAC_SIGNS, last)) return signs;
      if (Object.hasOwn(KEY_NAMES_MAC, what)) return signs + KEY_NAMES_MAC[what];      // 'Mod+Enter'
      return what.length === 1 ? signs + what : `${signs}-${what}`;
    })
    .replace(/\b(Alt|Option|Shift|Mod)\b/g, (all, name) => sign(name))
    .replace(/\bEnter\b/g, KEY_NAMES_MAC.Enter)
    .replace(/\bBackspace\b/g, KEY_NAMES_MAC.Backspace);
}
export const keyText = (text) => keyTextFor(text, MAC);

// -> the key of an action as a hint for a button or a menu: the command sign and S on macOS, 'Ctrl+S' elsewhere;
// '' when nothing is bound to it. An action with several chords shows the first row of the table.
export function hintFor(action) {
  const b = BINDINGS.find((x) => x.action === action);
  return b ? chordLabel(b.chord) : '';
}

// Adds the listeners and registers 'edit.cancel' (the Escape ladder). Returns ctx.keymap:
//   held                the codes of the keys that are down for the camera: W A S D, the arrows, Space - and the Shift
//                       and Alt keys, so the viewport can tell a fast pan. A key gets in only without Mod, never while
//                       a field has the focus, and not when the tool or an action used the press.
//   press(code, mods)   one key press through the same dispatch as a real one (mods: { mod, shift, alt });
//                       -> true when something used it. For __editor.key and tests.
// ctx.tools is read on every key, so install() may run before the tools exist.
export function install(ctx) {
  const held = new Set();
  let current = null;   // the event being dispatched; the Escape ladder hands it to tool.key

  // A call into a tool module: it may be somebody's half-written file, and a throw must not take the keyboard down.
  // Reported once per tool and method by the page's one reporter - under the name the viewport uses for the same
  // tool, because a right-click reaches tool.key('cancel') through the viewport.
  const guard = (tool, method, fn, fallback) => {
    try { return fn(); } catch (e) {
      reportOnce(`tool ${tool?.id ?? ctx.ui.tool}`, method, e);
      return fallback;
    }
  };
  const activeTool = () => ctx.tools?.[ctx.ui.tool] ?? null;
  const typing = () => {
    const a = document.activeElement;
    return a && a !== document.body && a.matches?.(FIELD) ? a : null;
  };
  const dialog = () => {
    const el = document.getElementById('modal');
    return el && !el.hidden ? el : null;
  };

  // The modal move of the viewport (viewport.grab, ui.pickPoint). The viewport says that one is open with
  // `viewport.modal` (anything truthy) and ends it with `viewport.cancelModal()`.
  const viewportModal = () => !!ctx.viewport?.modal;
  const cancelViewportModal = () => {
    const vp = ctx.viewport;
    if (typeof vp.cancelModal === 'function') vp.cancelModal();
    else if (typeof vp.modal?.cancel === 'function') vp.modal.cancel();
  };

  // Whatever floats above the page, topmost first: a dialog, a popover, the hotkey sheet. -> true when one was closed.
  const closeFloating = () => {
    const modal = dialog();
    if (modal) {
      modal.dispatchEvent(new Event('cancel'));   // the dialog renderer (ui/dom.js createModal) resolves and hides it
      return true;
    }
    let pop = null;
    try { pop = document.querySelector(':popover-open'); } catch { /* a browser without the popover API */ }
    if (pop) { pop.hidePopover(); return true; }
    const menu = document.querySelector('details.ui-popover[open]');
    if (menu) { menu.open = false; return true; }
    const help = document.getElementById('help');
    if (help && !help.hidden) { help.hidden = true; return true; }   // open exactly while not hidden: no second flag
    return false;
  };

  // The open popover `el` sits in (the editor card of the Spawns table, the Play options), or null.
  const popoverOf = (el) => {
    try { return el?.closest?.(':popover-open') ?? null; } catch { return null; }   // a browser without the popover API
  };

  // edit.cancel - Escape. In order, stopping at the first step that applies.
  const cancel = () => {
    const ev = current ?? new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' });
    if (dialog()) { closeFloating(); return; }           // a dialog first, also when its own text field has the focus
    // (1) a focused field: it commits and gives the keys back. A field inside a popover takes the popover along -
    // the box was opened to be typed into, and its close button says "Esc": one press, not two.
    const box = popoverOf(document.activeElement);
    if (leaveField()) {
      if (box) { try { box.hidePopover(); } catch { /* closed by the commit already */ } }
      return;
    }
    if (closeFloating()) return;                         // (2) the help sheet, a popover ...
    if (viewportModal()) { cancelViewportModal(); return; }   // ... or the grab / pick-a-point of the viewport
    const tool = activeTool();
    if (tool && guard(tool, 'key', () => tool.key('cancel', ev), false) === true) return;   // (3) a drag, a stroke, a path, a ghost
    if (ctx.ui.tool !== 'select') { ctx.ui.set('tool', 'select'); return; }                 // (4)
    ctx.store.clearSelection();                                                             // (5)
  };
  if (!ctx.actions.has('edit.cancel')) ctx.actions.register('edit.cancel', cancel);

  // A tool key that is refused says why - the toolbar says the same on its disabled button. Every other disabled
  // action stays silent, like its greyed-out button.
  const refused = (action) => {
    if (!action.startsWith('tool.') || !ctx.actions.has(action)) return;   // an unregistered action has toasted itself
    const layer = ctx.tools?.[action.slice(5)]?.layer ?? null, state = layer ? ctx.ui.layers?.[layer] : null;
    if (state && (!state.visible || state.locked)) ctx.ui.toast(`Layer ${state.visible ? 'locked' : 'hidden'}: ${layer}`, 'warn');
  };

  const run = (binding, ev) => {
    if (ev.repeat && !REPEAT.has(binding.action)) return;
    current = ev;
    try {
      if (!ctx.actions.run(binding.action)) refused(binding.action);
    } finally { current = null; }
  };

  // -> true when the press was used
  const down = (ev) => {
    if (ev.isComposing || ev.keyCode === 229 || !ev.code) return false;   // an input method is composing a character
    const code = ev.code;
    // macOS sends no keyup for a letter released while the command key is down: forget every held key around it
    if (COMMAND.has(code)) { held.clear(); return false; }
    const chord = chordOf(ev);

    // ---- (a) the focus rule
    if (dialog()) {
      // a dialog owns the keyboard: Tab, Enter and Space work its buttons, Escape cancels it, nothing reaches the editor
      if (chord === 'Escape') { ev.preventDefault(); closeFloating(); return true; }
      if (chord === 'Mod+KeyS') ev.preventDefault();   // never the browser's "save page" dialog
      return false;
    }
    const field = typing();
    if (field) {
      if (chord === 'Mod+KeyS') leaveField();   // commits what was typed, so the save includes it
      else if (chord !== 'Escape') {
        if (chord === 'Enter' && field.tagName === 'INPUT' && LINE_INPUT.test(field.type) && !field.form) {
          leaveField();   // Enter means "done": the field commits and the hotkeys are back
          ev.preventDefault();
          return true;
        }
        if ((code === 'ArrowUp' || code === 'ArrowDown') && !ev.ctrlKey && !ev.metaKey && field.tagName === 'INPUT') {
          // a number field steps on the arrows (Shift x 10, Alt x 0.1); it cancels the event when it did
          const step = new CustomEvent(STEP_EVENT, { cancelable: true, detail: { dir: code === 'ArrowUp' ? 1 : -1, shift: ev.shiftKey, alt: ev.altKey } });
          if (!field.dispatchEvent(step)) { ev.preventDefault(); return true; }
        }
        return false;
      }
    } else if ((chord === 'Enter' || chord === 'Space') && document.activeElement?.matches?.(PRESSABLE)) {
      return false;   // a button reached with Tab: the key presses it
    }

    // ---- (b) the context of the active tool; skipped while the viewport has a modal move open
    if (!viewportModal()) {
      const tool = activeTool();
      const binding = tool && TABLE.get(`${guard(tool, 'context', () => tool.context, 'none')} ${chord}`);
      if (binding) {
        if (ev.repeat && !REPEAT.has(binding.action)) { ev.preventDefault(); return true; }
        if (guard(tool, 'key', () => tool.key(binding.action, ev), false) === true) { ev.preventDefault(); return true; }
      }
    }

    // ---- (c) global
    const global = TABLE.get(`global ${chord}`);
    if (global) {
      ev.preventDefault();
      run(global, ev);
      return true;
    }

    // ---- (d) camera. A held key also counts with Shift down (a fast pan).
    const camera = TABLE.get(`camera ${chord}`) ?? (chord === `Shift+${code}` && TABLE.get(`camera ${code}`)?.held ? TABLE.get(`camera ${code}`) : null);
    if (camera) {
      ev.preventDefault();
      if (camera.held) held.add(code);
      else run(camera, ev);
      return true;
    }
    if (MODIFIER.has(code) && !ev.ctrlKey && !ev.metaKey) held.add(code);
    return false;
  };

  const up = (ev) => {
    if (COMMAND.has(ev.code)) held.clear();
    else held.delete(ev.code);
  };
  const release = () => held.clear();

  // capture: the keymap sees a key before anything in the page can stop it
  window.addEventListener('keydown', down, true);
  window.addEventListener('keyup', up, true);
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', release);

  return {
    held,
    press(code, mods = {}) {
      const init = {
        code, key: '', bubbles: true, cancelable: true,
        shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: MAC && !!mods.mod, ctrlKey: !MAC && !!mods.mod,
      };
      const used = down(new KeyboardEvent('keydown', init));
      up(new KeyboardEvent('keyup', init));
      return used;
    },
  };
}
