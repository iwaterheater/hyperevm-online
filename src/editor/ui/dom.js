import { toDeg, toRad } from '../../map/format.js';

// The shared widgets of the editor: everything a panel or a tool-options strip is built from.
// They are styled by css/base.css through the .ui-* classes and need no stylesheet of their own.
//
// Three rules hold for every widget here:
// - Text is text. A string that reaches the DOM goes through a text node; nothing in this file parses HTML, and h()
//   refuses innerHTML. Map names, model ids and server messages are untrusted input.
// - No widget listens to the keyboard: keymap.js is the only keyboard listener of the editor. Enter and blur reach a
//   field as the browser's own `change` / `blur` events; the keymap leaves a field on Enter and Escape (leaveField) and
//   sends the arrow keys of a focused number field as the STEP_EVENT below.
// - A widget never keeps the focus after a mouse click (buttons, checkboxes, section headers) or gives it back when the
//   choice is made (selects, sliders, colours): while a field has the focus no hotkey of the editor fires.
//
// A field constructor returns { el, set(value, mixed = false), value, focus(), setDisabled(on) }. `mixed` is the state
// of a multi-selection whose items differ: the field shows a dash and has no value until something is typed.
// Wherever a child or a control is expected, a node, a string, a field object or an array of those is accepted.

export const STEP_EVENT = 'ui-step';       // CustomEvent on a focused number input: detail { dir: 1 | -1, shift, alt }
export const COMMIT_EVENT = 'ui-commit';   // CustomEvent on a field: commit what was typed, now (see leaveField)

const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SCRUB_START = 3;   // px a label is dragged before it scrubs instead of clicks
const SCRUB_PX = 3;      // px of drag per step
const TOAST_MS = 3000;        // how long a toast stays
const TOAST_LONG_MS = 6000;   // ... an error, or one that offers an action: it has to be read and may have to be clicked
const fields = new WeakMap();   // el -> its field object, so row() can wire a label to a field given as a bare element

// Takes the focus out of the field that has it, committing what was typed. -> true when a field had the focus.
// The commit is asked for explicitly before the blur: a document that is not focused itself (a background tab, a page
// driven from the console or by a script) moves document.activeElement on blur() but fires no blur event.
export function leaveField() {
  const a = document.activeElement;
  if (!a || a === document.body || !a.matches?.(FIELD)) return false;
  a.dispatchEvent(new CustomEvent(COMMIT_EVENT));
  a.blur();
  return true;
}
// A click on a button must not move the focus to it (Space would press it again), but the field the user was typing in
// has to commit first: its edit is an open undo group, and the click may run a command of its own.
function keepFocus(ev) {
  ev.preventDefault();
  leaveField();
}

// A field that gets the focus selects its text, so typing replaces the value. After the click that focused it, or the
// click would put the caret back; with a timer, because a hidden tab runs no animation frames.
function selectSoon(input, untouched) {
  setTimeout(() => { if (document.activeElement === input && untouched()) input.select(); }, 0);
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.append(c);
    else if (typeof c === 'object' && c.el instanceof Node) el.append(c.el);   // a field object
    else el.append(document.createTextNode(String(c)));
  }
  return el;
}

// h('div', { class: 'ui-row', title: 'Hint', onclick: fn, dataset: { id: 3 } }, 'text', node, [more])
// class may be an array (falsy entries are dropped); style a string or an object ('--name' keys are custom properties);
// on<event> adds a listener; a key that is a property of the element is assigned, anything else becomes an attribute.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null) continue;
    if (key === 'innerHTML' || key === 'outerHTML') throw new Error('h(): HTML strings are not allowed, pass nodes or text');
    if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') {
      if (typeof value === 'string') el.style.cssText = value;
      else for (const [k, v] of Object.entries(value)) { if (k.startsWith('--')) el.style.setProperty(k, v); else el.style[k] = v; }
    } else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && !key.includes('-')) {
      try { el[key] = value; } catch { el.setAttribute(key, value); }   // a read-only property (list, form) is an attribute
    } else if (value !== false) el.setAttribute(key, value === true ? '' : value);
  }
  return append(el, children);
}

// One line of a form: the label on the left, the control on the right. A click on the label goes to the control;
// the label of a number field is also its scrub handle (drag it sideways).
export function row(label, ...controls) {
  const lab = h('label', { class: 'ui-label' }, label);
  const el = h('div', { class: 'ui-row' }, lab, h('div', { class: 'ui-control' }, controls));
  const first = controls.flat(Infinity).find((c) => c != null && typeof c === 'object');
  const field = first && (fields.get(first) ?? fields.get(first.el));
  if (!field) return el;
  if (typeof label === 'string' && field.input && !field.input.getAttribute('aria-label')) field.input.setAttribute('aria-label', label);
  if (field.scrub) field.scrub(lab);
  lab.addEventListener('click', () => { if (!field.scrubbed?.()) field.press(); });
  return el;
}

function fold(cls, title, children, open) {
  const summary = h('summary', null, title);
  summary.addEventListener('mousedown', keepFocus);   // the toggle still happens: it is the click that toggles
  return h('details', { class: cls, open }, summary, children);
}

// A collapsible block inside a panel.
export function section(title, ...children) {
  return fold('ui-section', title, h('div', { class: 'ui-section-body' }, children), true);
}

// The collapsible frame around a side-column panel: <details class="ui-frame"><summary>Title</summary>content</details>.
// main.js wraps each panel container in one and stores `open` from onToggle.
export function frame(title, content, { open = true, onToggle = null } = {}) {
  const el = fold('ui-frame', title, content, open);
  if (onToggle) el.addEventListener('toggle', () => onToggle(el.open));
  return el;
}

// ---------------------------------------------------------------- numbers

const trimmed = (v, digits) => String(Number(v.toFixed(digits)));   // 12.50 -> '12.5', -0.00 -> '0'
const decimals = (step) => { const s = String(step), dot = s.indexOf('.'); return dot < 0 ? 0 : s.length - dot - 1; };

// What a typed text means: { abs } a number, { rel: { op, n } } a change of the value the field had, or null.
// '+5' adds, '*1.2' multiplies, '/2' divides (reported as a multiplication), '-=5' subtracts and so does a bare '-5' -
// but only in a field that cannot be negative. In a field that can, '-5' has to be the number minus five: half of a map
// has negative coordinates, and editing one of them in place must not move the item. There a decrease is '-=5' or '+-5'.
// '=-5' is always the number itself. A decimal comma is accepted.
function parseNumber(text, negative) {
  const t = text.trim().replace(/\u2212/g, '-').replace(',', '.');
  const num = '(\\d+\\.?\\d*|\\.\\d+)';
  let m;
  if ((m = new RegExp(`^=\\s*(-?)${num}$`).exec(t))) return { abs: Number(m[1] + m[2]) };
  if ((m = new RegExp(`^(-?)${num}$`).exec(t))) {
    if (m[1] && !negative) return { rel: { op: '-', n: Number(m[2]) } };
    return { abs: Number(m[1] + m[2]) };
  }
  if ((m = new RegExp(`^([+*/-])=?\\s*(-?)${num}$`).exec(t))) {
    const n = Number(m[2] + m[3]);
    if (m[1] === '/') return n === 0 ? null : { rel: { op: '*', n: 1 / n } };
    return { rel: { op: m[1], n } };
  }
  return null;
}
const applyRel = (v, { op, n }) => (op === '+' ? v + n : op === '-' ? v - n : v * n);

// The engine of numberField, angleField and intRangeField. `digits` is the precision of the value, `show` the number
// of decimals it is displayed with (an angle is kept on the 0.01 degree grid and shown with one decimal).
function numberCore({ value = 0, min = -Infinity, max = Infinity, step, digits, show, unit = null, onInput = null, onCommit = null }) {
  min ??= -Infinity;
  max ??= Infinity;
  digits ??= step == null ? 2 : Number.isInteger(step) ? 0 : Math.max(2, decimals(step));
  step ??= digits === 0 ? 1 : 0.1;
  show ??= digits;
  const pow = 10 ** digits;
  const round = (v) => { const q = Math.round(v * pow) / pow; return q === 0 ? 0 : q; };
  const fit = (v) => round(Math.min(max, Math.max(min, v)));

  const input = h('input', { type: 'text', class: 'ui-input ui-number', inputMode: 'decimal', autocomplete: 'off', spellcheck: false });
  const el = h('span', { class: ['ui-field', unit && 'ui-unit'], dataset: unit ? { unit } : null }, input);
  let base = null;      // the value the field stands for; null while mixed
  let live = null;      // the last value handed to onInput
  let fired = false;    // onInput ran since the last commit: the owner has an edit open and must get an onCommit
  let editing = false;  // the text was changed by hand since the last commit
  let scrubbed = false; // the last pointer gesture on the label was a scrub, so its click must not focus the field

  const render = (v = base, d = show) => {
    input.value = v == null ? '' : trimmed(v, d);
    input.placeholder = v == null ? '\u2014' : '';
    el.classList.toggle('ui-mixed', v == null);
  };
  const flash = () => {
    input.classList.remove('ui-flash');
    void input.offsetWidth;   // restarts the animation when two bad commits follow each other
    input.classList.add('ui-flash');
  };
  const feed = (v) => {
    if (v === live) return;
    live = v;
    fired = true;
    onInput?.(v);
  };
  // Ends an edit. The value is `live` - every way to change it has gone through feed() - or, with known = false,
  // unknown: a relative change of a mixed field, which only the owner can apply.
  const finish = (relative = null, known = true) => {
    const changed = known ? fired : !!relative;
    fired = false;
    editing = false;
    if (known) base = live;
    else live = base;
    render();
    if (changed) onCommit?.(known ? base : NaN, { relative });
  };
  const commit = () => {
    if (!editing) return;
    const r = parseNumber(input.value, min < 0);
    if (r?.rel && base == null) { finish(r.rel, false); return; }
    if (r?.rel) feed(fit(applyRel(base, r.rel)));   // relative to the value before this edit, not to what was typed on the way
    else if (r) feed(fit(r.abs));
    else flash();                                   // a text that is no number: the last good value stands
    finish(r?.rel ?? null);
  };

  input.addEventListener('focus', () => {
    live = base;
    selectSoon(input, () => !editing);
  });
  input.addEventListener('input', () => {
    editing = true;
    const r = parseNumber(input.value, min < 0);
    if (r && 'abs' in r) feed(fit(r.abs));
  });
  input.addEventListener('change', commit);   // Enter, or blur after a change
  input.addEventListener('blur', commit);     // a text typed and then put back fires no change, yet the edit is open
  input.addEventListener(COMMIT_EVENT, commit);
  input.addEventListener(STEP_EVENT, (ev) => {
    const typed = editing ? parseNumber(input.value, min < 0) : null;
    const from = typed && 'abs' in typed ? fit(typed.abs) : live ?? base;
    if (from == null || input.disabled) return;
    ev.preventDefault();   // tells the keymap that the arrow key was used
    const v = fit(from + ev.detail.dir * step * (ev.detail.shift ? 10 : ev.detail.alt ? 0.1 : 1));
    editing = true;
    render(v, digits);
    feed(v);
  });

  const field = {
    el, input,
    get value() { return base; },
    // Shows a value given by the owner. While the user is typing in the field it is left alone: the owner refreshes
    // on every store change, including the changes this very field makes.
    set(v, mixed = false) {
      if (editing && document.activeElement === input) return;
      base = mixed || v == null || Number.isNaN(v) ? null : v;
      live = base;
      render();
    },
    focus() { input.focus(); },
    press() { input.focus(); },
    setDisabled(on) { input.disabled = !!on; },
    scrubbed: () => scrubbed,
    // Makes `handle` (the label of the row) a scrub handle: dragging it sideways changes the value by `step` per
    // SCRUB_PX pixels (Shift x 10, Alt x 0.1). onInput while dragging, onCommit on release. A mixed field has no value
    // to drag from: its drag is reported on release as a relative change.
    scrub(handle) {
      handle.classList.add('ui-scrub');
      let drag = null;   // { id, x, from, active, delta }
      handle.addEventListener('pointerdown', (ev) => {
        scrubbed = false;
        if (ev.button !== 0 || input.disabled) return;
        drag = { id: ev.pointerId, x: ev.clientX, from: base, active: false, delta: 0 };
      });
      handle.addEventListener('pointermove', (ev) => {
        if (!drag || ev.pointerId !== drag.id) return;
        const dx = ev.clientX - drag.x;
        if (!drag.active) {
          if (Math.abs(dx) < SCRUB_START) return;
          leaveField();   // what was being typed anywhere is committed first; this may change `base`
          drag.from = base;
          drag.active = true;
          live = base;
          handle.setPointerCapture(drag.id);
          document.documentElement.classList.add('ui-scrubbing');
        }
        drag.delta = Math.round(dx / SCRUB_PX) * step * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
        if (drag.from == null) return;
        const v = fit(drag.from + drag.delta);
        render(v, digits);
        feed(v);
      });
      const end = (ev) => {
        if (!drag || ev.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        if (!d.active) return;
        scrubbed = true;
        document.documentElement.classList.remove('ui-scrubbing');
        if (d.from != null) finish();
        else if (round(d.delta) !== 0) finish({ op: '+', n: round(d.delta) }, false);
      };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    },
  };
  fields.set(el, field);
  field.set(value);
  return field;
}

// A number. onInput(value) while typing, stepping with the arrow keys or scrubbing; onCommit(value, { relative }) once,
// on Enter, blur or release. Typed values are clamped to min / max and rounded to `digits` decimals (default: 0 for an
// integer step, else at least 2).
// The two callbacks always pair up: onCommit is called exactly when onInput was called since the last commit, and with
// the value of the last onInput - so "onInput: begin + exec, onCommit: commit" is a complete undoable field.
// A relative text ('+5', '*1.2', see parseNumber) arrives the same way, with the result as the value, and onCommit also
// gets { relative: { op: '+' | '-' | '*', n } } (null otherwise). The one exception is a MIXED field: its value is
// unknown, so a relative change (typed, or scrubbed on the label) calls no onInput and onCommit(NaN, { relative }) -
// the owner applies { op, n } to every item.
export function numberField({ value, min, max, step, digits, onInput, onCommit } = {}) {
  return numberCore({ value, min, max, step, digits, onInput, onCommit });
}

// An angle: the value, min, max and step are RADIANS, the field shows degrees with one decimal and accepts two.
// The n of a relative '+' or '-' is radians as well.
export function angleField({ value, min, max, step, onInput, onCommit } = {}) {
  const deg = (rad) => (rad == null ? rad : rad * 180 / Math.PI);
  const rel = (r) => (r && r.op !== '*' ? { op: r.op, n: toRad(r.n) } : r);
  const core = numberCore({
    value: value == null ? null : toDeg(value), min: deg(min), max: deg(max), step: step == null ? 1 : deg(step), digits: 2, show: 1, unit: '\u00b0',
    onInput: onInput && ((d) => onInput(toRad(d))),
    onCommit: onCommit && ((d, { relative }) => onCommit(toRad(d), { relative: rel(relative) })),
  });
  const field = {
    el: core.el, input: core.input,
    get value() { return core.value == null ? null : toRad(core.value); },
    set(rad, mixed = false) { core.set(rad == null || Number.isNaN(rad) ? null : toDeg(rad), mixed); },
    focus: core.focus, press: core.press, setDisabled: core.setDisabled, scrub: core.scrub, scrubbed: core.scrubbed,
  };
  fields.set(field.el, field);
  return field;
}

// Two whole numbers, low and high: value [min, max]. The pair stays ordered - an end typed past the other takes it along.
// `mixed` may be one flag for both ends or [low, high]. An end that is mixed takes the value typed into the other.
export function intRangeField({ value, min, max, onCommit } = {}) {
  const commit = (i) => (v) => {
    if (Number.isNaN(v)) return;   // a relative change of a mixed end: there is nothing to apply it to
    const pair = [lo.value ?? v, hi.value ?? v];
    pair[i] = v;
    if (pair[0] > pair[1]) pair[1 - i] = v;
    lo.set(pair[0]);
    hi.set(pair[1]);
    onCommit?.(pair);
  };
  const lo = numberCore({ value: value?.[0], min, max, step: 1, digits: 0, onCommit: commit(0) });
  const hi = numberCore({ value: value?.[1], min, max, step: 1, digits: 0, onCommit: commit(1) });
  const field = {
    el: h('span', { class: 'ui-field ui-pair' }, lo.el, h('span', { class: 'ui-dash' }, '\u2013'), hi.el),
    input: lo.input,
    get value() { return lo.value == null || hi.value == null ? null : [lo.value, hi.value]; },
    set(v, mixed = false) {
      const m = Array.isArray(mixed) ? mixed : [mixed, mixed];
      lo.set(v?.[0], m[0]);
      hi.set(v?.[1], m[1]);
    },
    focus() { lo.focus(); },
    press() { lo.focus(); },
    setDisabled(on) { lo.setDisabled(on); hi.setDisabled(on); },
  };
  fields.set(field.el, field);
  return field;
}

// ---------------------------------------------------------------- choices

// A drop-down. Option values may be anything (null, numbers, objects): they are compared with Object.is.
// An option may also be given as a bare value, which is then its own label.
export function selectField({ value, options = [], onCommit } = {}) {
  const el = h('select', { class: 'ui-select' });
  let list = [], current = value, isMixed = false, byPointer = false;
  const render = () => {
    el.replaceChildren();
    if (isMixed) el.append(h('option', { value: '', disabled: true, selected: true }, '\u2014'));
    list.forEach((o, i) => el.append(h('option', { value: String(i), selected: !isMixed && Object.is(o.value, current) }, o.label)));
    if (!isMixed && !list.some((o) => Object.is(o.value, current))) el.selectedIndex = -1;
    el.classList.toggle('ui-mixed', isMixed);
  };
  el.addEventListener('pointerdown', () => { byPointer = true; });
  el.addEventListener('blur', () => { byPointer = false; });
  el.addEventListener('change', () => {
    const o = list[Number(el.value)];
    if (byPointer) el.blur();   // picked with the mouse: hand the keyboard back to the editor
    if (!o) return;
    current = o.value;
    if (isMixed) { isMixed = false; render(); }
    onCommit?.(current);
  });
  const field = {
    el, input: el,
    get value() { return isMixed ? null : current; },
    set(v, mixed = false) { current = v; isMixed = !!mixed; render(); },
    setOptions(next) {
      list = next.map((o) => (o !== null && typeof o === 'object' ? { value: o.value, label: String(o.label ?? o.value) } : { value: o, label: o == null ? '\u2014' : String(o) }));
      render();
    },
    focus() { el.focus(); },
    press() {   // a click on the label opens the menu where the browser allows a script to
      if (el.disabled) return;
      byPointer = true;
      try { el.showPicker(); } catch { el.focus(); }
    },
    setDisabled(on) { el.disabled = !!on; },
  };
  fields.set(el, field);
  field.setOptions(options);
  return field;
}

// A checkbox. Mixed shows the indeterminate state; a click then turns it on for every item.
export function checkField({ value, onCommit } = {}) {
  const el = h('input', { type: 'checkbox', class: 'ui-check' });
  el.addEventListener('mousedown', keepFocus);   // toggles on the click, never takes the focus from the mouse
  el.addEventListener('change', () => onCommit?.(el.checked));
  const field = {
    el, input: el,
    get value() { return el.indeterminate ? null : el.checked; },
    set(v, mixed = false) { el.checked = !mixed && !!v; el.indeterminate = !!mixed; },
    focus() { el.focus(); },
    press() { if (!el.disabled) el.click(); },   // click() toggles without focusing
    setDisabled(on) { el.disabled = !!on; },
  };
  fields.set(el, field);
  field.set(value);
  return field;
}

// A slider with its value beside it. onInput(value) while it moves; onCommit(value), if given, when it is released.
export function rangeField({ value = 0, min = 0, max = 1, step = 0.01, onInput, onCommit } = {}) {
  const digits = decimals(step);
  const input = h('input', { type: 'range', class: 'ui-range', min, max, step });
  const out = h('output', { class: 'ui-value' });
  const el = h('span', { class: 'ui-field ui-slider' }, input, out);
  let byPointer = false;
  const show = () => { out.textContent = trimmed(Number(input.value), digits); };
  input.addEventListener('pointerdown', () => { byPointer = true; leaveField(); });
  input.addEventListener('input', () => { show(); onInput?.(Number(input.value)); });
  input.addEventListener('change', () => {
    if (byPointer) input.blur();
    byPointer = false;
    onCommit?.(Number(input.value));
  });
  const field = {
    el, input,
    get value() { return Number(input.value); },
    set(v, mixed = false) {
      if (v != null && !Number.isNaN(v)) input.value = String(v);
      show();
      if (mixed) out.textContent = '\u2014';
      el.classList.toggle('ui-mixed', !!mixed);
    },
    focus() { input.focus(); },
    press() { input.focus(); },
    setDisabled(on) { input.disabled = !!on; },
  };
  fields.set(el, field);
  field.set(value);
  return field;
}

// One line of text. It commits value.trim() on Enter or blur, and only when the text changed. A text shorter than
// minLength, longer than maxLength, with a control character or failing `pattern` is not committed: the previous value
// comes back and the field flashes. An empty text is fine when minLength is 0, and `pattern` is not applied to it.
export function textField({ value = '', minLength = 0, maxLength = Infinity, pattern = null, onCommit } = {}) {
  const el = h('input', { type: 'text', class: 'ui-input ui-text', autocomplete: 'off', spellcheck: false });
  let base = '', isMixed = false, editing = false;
  const render = () => {
    el.value = isMixed ? '' : base;
    el.placeholder = isMixed ? '\u2014' : '';
    el.classList.toggle('ui-mixed', isMixed);
  };
  const valid = (t) => t.length >= minLength && t.length <= maxLength && !CONTROL.test(t) && (t === '' || !pattern || pattern.test(t));
  const commit = () => {
    if (!editing) return;
    editing = false;
    const t = el.value.trim();
    if (!valid(t)) {
      el.classList.remove('ui-flash');
      void el.offsetWidth;
      el.classList.add('ui-flash');
      render();
      return;
    }
    const changed = isMixed ? t !== '' : t !== base;
    if (changed) { base = t; isMixed = false; }
    render();
    if (changed) onCommit?.(t);
  };
  el.addEventListener('focus', () => selectSoon(el, () => !editing));
  el.addEventListener('input', () => { editing = true; });
  el.addEventListener('change', commit);
  el.addEventListener('blur', commit);
  el.addEventListener(COMMIT_EVENT, commit);
  const field = {
    el, input: el,
    get value() { return isMixed ? null : base; },
    set(v, mixed = false) {
      if (editing && document.activeElement === el) return;   // do not fight the typing
      base = v == null ? '' : String(v);
      isMixed = !!mixed;
      render();
    },
    focus() { el.focus(); },
    press() { el.focus(); },
    setDisabled(on) { el.disabled = !!on; },
  };
  fields.set(el, field);
  field.set(value);
  return field;
}

// A colour: '#rrggbb' (lower case) or null for "none" - the small button clears it. Pass nullable: false to leave
// the button out.
export function colorField({ value = null, nullable = true, onCommit } = {}) {
  const input = h('input', { type: 'color', class: 'ui-color-input' });
  const none = h('button', { type: 'button', class: 'ui-button ui-clear', title: 'No colour' }, '\u00d7');
  const el = h('span', { class: 'ui-field ui-color' }, input, nullable ? none : null);
  let current = null, isMixed = false;
  const render = () => {
    input.value = current ?? '#808080';
    el.classList.toggle('ui-none', current == null && !isMixed);
    el.classList.toggle('ui-mixed', isMixed);
    none.disabled = input.disabled || (current == null && !isMixed);
  };
  input.addEventListener('change', () => {
    current = input.value.toLowerCase();
    isMixed = false;
    render();
    input.blur();
    onCommit?.(current);
  });
  none.addEventListener('mousedown', keepFocus);
  none.addEventListener('click', () => {
    current = null;
    isMixed = false;
    render();
    onCommit?.(null);
  });
  const field = {
    el, input,
    get value() { return isMixed ? null : current; },
    set(v, mixed = false) {
      current = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
      isMixed = !!mixed;
      render();
    },
    focus() { input.focus(); },
    press() { if (!input.disabled) input.click(); },
    setDisabled(on) { input.disabled = !!on; render(); },
  };
  fields.set(el, field);
  field.set(value);
  return field;
}

// A push button. It never takes the focus from a mouse click, so Space / Enter cannot press it a second time; with
// the Tab key it is reached and pressed as usual. Returns the <button> (set .disabled, toggle the class 'active').
export function button(label, onClick, { title, danger = false, disabled = false } = {}) {
  const el = h('button', { type: 'button', class: ['ui-button', danger && 'danger'], title, disabled: !!disabled }, label);
  el.addEventListener('mousedown', keepFocus);
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

// A function that runs fn at most once per animation frame, with the arguments of the latest call.
// In a hidden tab frames do not run at all, so a timer stands in: a panel still refreshes when a script drives the editor.
export function rafThrottle(fn) {
  let frame = 0, timer = 0, args = null;
  const run = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = timer = 0;
    const a = args;
    args = null;
    if (a) fn(...a);
  };
  const throttled = (...a) => {
    const idle = !args;
    args = a;
    if (!idle) return;
    if (document.hidden) timer = setTimeout(run, 30);
    else frame = requestAnimationFrame(run);
  };
  throttled.flush = run;
  throttled.cancel = () => { args = null; run(); };
  return throttled;
}

// ---------------------------------------------------------------- toasts and dialogs

// The renderer of ui.toast for the #toasts container: toast(text, level = 'info'), level 'info' | 'warn' | 'error'.
// text is a string or { text, action: { label, run } } - the action is a link at the end of the line.
// Every toast stays 3 s, whatever its level, and waits while the pointer is on it - that is how an error or a link
// gets the time it takes to read and to reach. A message that is already the newest toast is not stacked a second
// time: its 3 s start again.
export function createToasts(container, { max = 5 } = {}) {
  container.setAttribute('role', 'status');
  container.setAttribute('aria-live', 'polite');
  let newest = null;   // { el, key, restart }
  return function toast(text, level = 'info') {
    const msg = text !== null && typeof text === 'object' ? text : { text };
    const kind = level === 'warn' || level === 'error' ? level : 'info';
    const body = String(msg.text ?? '');
    const key = msg.action ? null : `${kind}\n${body}`;
    if (key && newest?.key === key && newest.el.isConnected) { newest.restart(kind === 'error' ? TOAST_LONG_MS : TOAST_MS); return; }
    const el = h('div', { class: `ui-toast ${kind}` }, h('span', { class: 'ui-toast-text' }, body));
    let timer = 0;
    const close = () => {
      clearTimeout(timer);
      el.classList.add('out');
      setTimeout(() => el.remove(), 180);
    };
    const restart = (wait = TOAST_MS) => { clearTimeout(timer); timer = setTimeout(close, wait); };
    if (msg.action) {
      const link = h('button', { type: 'button', class: 'ui-toast-action' }, String(msg.action.label ?? 'Open'));
      link.addEventListener('mousedown', keepFocus);
      link.addEventListener('click', () => {
        close();
        try { msg.action.run?.(); } catch (e) { console.error('[editor] toast action failed', e); }
      });
      el.append(link);
    }
    el.addEventListener('pointerenter', () => clearTimeout(timer));
    el.addEventListener('pointerleave', () => restart(1500));
    container.append(el);
    while (container.children.length > max) container.firstElementChild.remove();
    newest = { el, key, restart };
    restart(kind === 'error' || msg.action ? TOAST_LONG_MS : TOAST_MS);
  };
}

// The renderer of ui.confirm / ui.choose / ui.prompt for the #modal container. One dialog at a time; a second call
// waits for the first to close. The container is shown by removing its `hidden` attribute and the rest of the page is
// made inert, so Tab stays inside the dialog. A dialog is cancelled by its Cancel button, a click beside it, or the
// event 'cancel' dispatched on the container - which is how the keymap's Escape closes it without knowing this module.
//   confirm(text, { ok = 'OK', cancel = 'Cancel', danger = false })  -> Promise<boolean>
//   choose(text, [{ id, label, danger? }])                           -> Promise<string | null>   (null = cancelled)
//   prompt(text, value = '', { ok = 'OK', cancel = 'Cancel' })       -> Promise<string | null>
// text is a string (line breaks are kept) or a node.
export function createModal(container) {
  let queue = Promise.resolve(), cancelOpen = null;

  const show = (text, build) => {
    const run = () => new Promise((resolve) => {
      leaveField();
      const inert = [...document.body.children].filter((c) => c !== container && c.id !== 'toasts' && !c.inert);
      const finish = (result) => {
        if (!cancelOpen) return;
        cancelOpen = null;
        for (const c of inert) c.inert = false;
        container.hidden = true;
        container.replaceChildren();
        resolve(result);
      };
      const form = h('form', { class: 'ui-dialog', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'ui-dialog-text' }, text));
      const { cancelValue, submit, focus } = build(form, finish);
      form.addEventListener('submit', (ev) => { ev.preventDefault(); submit?.(); });
      cancelOpen = () => finish(cancelValue);
      for (const c of inert) c.inert = true;
      container.replaceChildren(form);
      container.hidden = false;
      focus?.focus();
    });
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  };
  const buttons = (form, ...list) => form.append(h('div', { class: 'ui-dialog-buttons' }, list));
  const push = (label, cls, onClick, type = 'button') => {
    const el = h('button', { type, class: ['ui-button', cls] }, String(label));
    if (onClick) el.addEventListener('click', onClick);
    return el;
  };

  container.addEventListener('cancel', () => cancelOpen?.());
  container.addEventListener('mousedown', (ev) => { if (ev.target === container) cancelOpen?.(); });

  return {
    get open() { return !!cancelOpen; },
    close() { cancelOpen?.(); },
    confirm(text, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
      return show(text, (form, finish) => {
        const yes = push(ok, danger ? 'danger' : 'primary', null, 'submit');
        const no = push(cancel, null, () => finish(false));
        buttons(form, no, yes);
        return { cancelValue: false, submit: () => finish(true), focus: danger ? no : yes };
      });
    },
    choose(text, options = []) {
      return show(text, (form, finish) => {
        const list = options.map((o) => push(o.label ?? o.id, o.danger ? 'danger' : null, () => finish(o.id)));
        buttons(form, list);
        // Enter must never pick a destructive answer by itself: the focus starts on the last harmless one
        const safe = options.map((o, i) => (o.danger ? null : list[i])).filter(Boolean);
        return { cancelValue: null, focus: safe[safe.length - 1] ?? list[list.length - 1] };
      });
    },
    prompt(text, value = '', { ok = 'OK', cancel = 'Cancel' } = {}) {
      return show(text, (form, finish) => {
        const input = h('input', { type: 'text', class: 'ui-input ui-text', autocomplete: 'off', spellcheck: false, value: String(value ?? '') });
        form.append(input);
        buttons(form, push(cancel, null, () => finish(null)), push(ok, 'primary', null, 'submit'));
        queueMicrotask(() => input.select());
        return { cancelValue: null, submit: () => finish(input.value), focus: input };
      });
    },
  };
}
