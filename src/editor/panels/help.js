import { h, button } from '../ui/dom.js';
import { BINDINGS, chordLabel, hintFor, keyText } from '../keymap.js';

// The hotkey sheet (#help): every row of the keymap table, the pointer gestures and the rules of the number fields.
// It is generated from BINDINGS, so a key that is rebound there is rebound here.
//
// The sheet is open exactly while #help is not `hidden`: the action 'help.toggle' flips that attribute, the keymap's
// Escape sets it - nobody keeps a second flag. The content never changes, so it is built once.

// The contexts of the keymap in the order a mapper meets them, with what to call them.
const CONTEXTS = [
  ['global', 'Everywhere', null],
  ['camera', 'Camera', 'Always active. Right-drag orbits, the wheel zooms to the cursor.'],
  ['select', 'Selection', 'Select tool - and the Spawn, Chest, NPC, Start point and Region tools while nothing is being drawn.'],
  ['ghost', 'Placing', 'Place (in Line mode only before the first point) and Paste: the keys act on the ghost.'],
  ['brush', 'Brushes', 'Terrain brush and fill, Scatter.'],
  ['path', 'Paths', 'A polygon, a road, a line of objects or a measurement in progress.'],
];

// [input, effect] - the pointer has no table in the keymap: the viewport and the tools read it directly.
const POINTER = [
  ['Left click / drag', 'The active tool'],
  ['Right-drag', 'Orbit the camera'],
  ['Right-click', 'Cancel what the tool is doing, then go back to Select'],
  ['Middle-drag, Space + left-drag', 'Pan'],
  ['Wheel / pinch', 'Zoom to the cursor'],
  ['Shift + wheel', 'Turn the view'],
  ['Shift + click / drag', 'Add to the selection (Select) · lock the axis or turn in 15° steps (gizmo) · straight stroke (Terrain) · paste and keep the ghost (Paste)'],
  ['Alt + click / drag', 'Subtract in a box select · drag a copy of the selection · pick what is under the cursor (Place, Terrain) · erase (Scatter)'],
  ['Double-click', 'Select one member of a group alone'],
  ['Click again in place', 'Select the next item under the cursor'],
  ['Mod held while dragging', 'Invert the snap toggle'],
];

// [what is typed, what it does] - the rule every number field of the editor follows (ui/dom.js).
const NUMBERS = [
  ['12.5', 'Sets the value - on every selected item.'],
  ['+5   *1.2   /2', 'Relative: adds, multiplies, divides - each selected item from its own value.'],
  ['-=5   +-5', 'Subtracts 5, in every field.'],
  ['-5', 'Subtracts 5 in a field that cannot be negative (scale, radius, count, gold). In a field that can (x, y, z, angles) it is the number −5.'],
  ['=-5', 'Always the number −5.'],
  ['↑  ↓', 'Step the focused field (Shift × 10, Alt × 0.1).'],
  ['Drag the label', 'Scrub the value (Shift × 10, Alt × 0.1); releasing is one undo step.'],
  ['Enter', 'Commit and leave the field. Esc leaves it as well; a click anywhere else commits too.'],
  ['—', 'A dash: the selected items have different values. A typed number sets them all.'],
];

// The rows of one context. Bindings that do the same thing (Delete and Backspace, Mod+Shift+Z and Mod+Y) share a row,
// and so does a numbered family (bookmark 1 to 4, ground type 1 to 9): every key is still there, the sheet is shorter.
function rowsOf(ctxId) {
  const rows = [];
  for (const b of BINDINGS) {
    if (b.ctx !== ctxId) continue;
    const n = /^(.*\D)(\d+)$/.exec(b.action);
    const numbered = n !== null && b.label.endsWith(` ${n[2]}`);
    const family = numbered ? `${n[1]}#` : b.action, label = numbered ? b.label.slice(0, -n[2].length) : b.label;
    const row = rows.find((r) => r.family === family && r.label === label);
    if (row) {
      row.chords.push(b.chord);
      if (numbered) row.last = n[2];
    } else rows.push({ family, label, held: !!b.held, chords: [b.chord], first: numbered ? n[2] : null, last: numbered ? n[2] : null });
  }
  return rows.map((r) => ({ ...r, label: r.first === null ? r.label : r.first === r.last ? `${r.label}${r.first}` : `${r.label}${r.first}–${r.last}` }));
}

const key = (chord, ctxId) => h('kbd', { class: 'ui-kbd', dataset: { chord, ctx: ctxId } }, chordLabel(chord));

function table(rows) {
  return h('div', { class: 'keys' }, rows.map(([keys, text]) => [h('div', { class: 'chords' }, keys), h('div', { class: 'what' }, text)]));
}

export default function mount(el, ctx) {
  const { actions } = ctx;

  const close = button('×', () => { el.hidden = true; }, { title: 'Close (Esc)' });
  close.classList.add('flat', 'icon', 'close');
  const toggle = hintFor('help.toggle');

  const sections = CONTEXTS.map(([id, title, note]) => {
    const rows = rowsOf(id);
    if (!rows.length) return null;
    return h('section', { class: 'group', dataset: { ctx: id } },
      h('h3', { class: 'title' }, title),
      note && h('p', { class: 'note ui-hint' }, note),
      table(rows.map((r) => [r.chords.map((chord) => key(chord, id)), keyText(r.held ? `${r.label} (hold)` : r.label)])));
  });

  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Keyboard shortcuts');
  el.replaceChildren(
    h('header', { class: 'head' },
      h('h2', { class: 'heading' }, 'Keyboard and mouse'),
      h('span', { class: 'ui-hint' }, toggle ? `${toggle} or F1 shows and hides this sheet. Keys do not fire while a field has the focus.` : 'Keys do not fire while a field has the focus.'),
      close),
    h('div', { class: 'sheet' },
      sections,
      h('section', { class: 'group', dataset: { ctx: 'pointer' } },
        h('h3', { class: 'title' }, 'Mouse'),
        table(POINTER.map(([input, effect]) => [h('span', { class: 'input' }, keyText(input)), keyText(effect)]))),      // the keys as the caps above write them
      h('section', { class: 'group', dataset: { ctx: 'numbers' } },
        h('h3', { class: 'title' }, 'Number fields'),
        h('p', { class: 'note ui-hint' }, 'Inspector, tool options and panels: every number field reads what is typed the same way.'),
        table(NUMBERS.map(([typed, effect]) => [h('span', { class: 'typed ui-mono' }, keyText(typed)), keyText(effect)])))),
  );

  // Registered once; a second mount (there is none) would find it taken.
  if (!actions.has('help.toggle')) {
    actions.register('help.toggle', () => {
      el.hidden = !el.hidden;
      if (el.hidden) return;
      el.scrollTop = 0;
      // The sheet covers the page, and a popover - the editor card of the Spawns table, the Play options - floats above
      // everything, the sheet included: it would stay open on top of it and take the first Escape.
      try { for (const pop of document.querySelectorAll(':popover-open')) pop.hidePopover(); } catch { /* no popover API: nothing floats */ }
    });
  }
  return {};
}
