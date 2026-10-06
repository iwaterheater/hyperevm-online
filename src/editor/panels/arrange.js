import { h, row, section, button, numberField, angleField, rafThrottle } from '../ui/dom.js';
import { LIMITS } from '../../map/format.js';
import { editable, describe } from '../tools/common.js';
import { align, distribute, facePoint, randomize, drop, array } from '../arrange.js';

// The Arrange panel (#arrange): what is done to a selection as a whole - align, distribute, face a point, randomize
// rotation and scale, drop to ground, array.
//
// The maths is in ../arrange.js (pure, unit-tested); this file turns its patches into ONE command per click, so every
// arrangement is one undo step, and keeps the buttons honest about what they can do with the current selection.
// It works on what may be edited right now: selected items on a hidden or locked layer are left alone.
// The section hides itself while nothing is selected (the frame around it is the one thing outside its container a
// panel may touch).

const KINDS = ['object', 'spawn', 'chest', 'npc', 'region'];     // the order copies are added in: map order
const TURNS = ['object', 'chest', 'npc'];                        // the kinds that have a facing
const MAX_COUNT = 200;          // copies of one array, the selection included
const MAX_NEW = 20000;          // items one array may add: beyond that it is a slip of the finger, not a design
const BUSY = 'Finish the current edit first';

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const copiesOf = (n) => `${n.toLocaleString('en-US')} ${n === 1 ? 'copy' : 'copies'}`;

export default function mount(el, ctx) {
  const { store, ui, cmd } = ctx;
  // the collapsible frame main.js wrapped the section in; without one (a page that has no frames) the section itself
  const frame = el.parentElement?.classList.contains('ui-frame') ? el.parentElement : el;

  // What the fields hold. Not part of the map and not undoable: the panel remembers them while the page lives.
  const opts = { scale: [0.8, 1.2], count: 3, dx: 2, dz: 0, dry: 0 };
  let picking = false;          // "Face a point" waits for a click in the viewport

  // ---------------------------------------------------------------- what is selected

  // -> the selected items that may be edited, in map order, with their kinds
  const current = () => {
    const items = store.map ? editable(ctx, store.selected()) : [];
    return { items, entries: items.map((item) => ({ kind: store.kindOf(item), item })) };
  };
  const ofKinds = (entries, kinds) => entries.filter((e) => kinds.includes(e.kind));

  // An arrangement must not land inside somebody else's open edit (a grab, a drag): its step would be swallowed.
  const ready = () => {
    if (!store.map) return false;
    if (store.grouping) { ui.toast(BUSY, 'warn'); return false; }
    return true;
  };

  // Runs patches (index-aligned with `entries`) as one undo step called `label`. -> whether anything changed
  function patch(label, entries, patches) {
    store.begin(label);
    try {
      store.exec(cmd.setEach(entries.map((e) => e.item), patches));
    } catch (err) {
      store.cancel();
      throw err;
    }
    return store.commit();
  }

  // One button press: `pick` chooses the entries the arrangement applies to, `build` makes their patches.
  function arrange(verb, pick, build, nothing) {
    if (!ready()) return;
    const entries = pick(current().entries);
    if (!entries.length) return;
    const label = verb(describe(ctx, entries.map((e) => e.item)));
    if (patch(label, entries, build(entries))) ui.setStatus(label);
    else ui.toast(nothing);
  }
  const all = (entries) => entries;

  // ---------------------------------------------------------------- the arrangements

  const doAlign = (axis, mode) => arrange((what) => `Align ${what}`, all, (es) => align(es, axis, mode),
    `Already aligned on ${axis.toUpperCase()}`);
  const doDistribute = (axis) => arrange((what) => `Distribute ${what}`, all, (es) => distribute(es, axis),
    `Already evenly spaced along ${axis.toUpperCase()}`);
  const doRotation = () => arrange((what) => `Randomize the rotation of ${what}`, (es) => ofKinds(es, TURNS),
    (es) => randomize(es, { rotation: true }), 'Nothing changed');
  const doScale = () => arrange((what) => `Randomize the scale of ${what}`, (es) => ofKinds(es, ['object']),
    (es) => randomize(es, { scale: opts.scale }), 'Nothing changed');
  const doDrop = () => arrange((what) => `Drop ${what} to the ground`, (es) => ofKinds(es, ['object']), drop,
    'Already on the ground');

  // Face a point: the next click on the ground is the point. The selection is read again after the click - the
  // keyboard still works while the viewport waits (undo, delete, another selection).
  async function doFace() {
    if (picking) { ctx.viewport.cancelModal?.(); return; }     // the button is a toggle: a second press gives up
    if (!ready() || !ofKinds(current().entries, TURNS).length) return;
    picking = true;
    refresh();
    let point = null;
    try {
      point = await ui.pickPoint('Face a point: click the point the selection should turn to (Esc cancels)');
    } finally {
      picking = false;
      refresh();
    }
    if (!point) return;
    arrange((what) => `Turn ${what} to a point`, (es) => ofKinds(es, TURNS), (es) => facePoint(es, point.x, point.z),
      'Already facing that point');
  }

  // Array: count - 1 copies of the selection, each a step further. The copies and the selection become the new
  // selection, so the whole row can be moved, turned or grouped next.
  function doArray() {
    if (!ready()) return;
    const { items, entries } = current(), source = ofKinds(entries, KINDS);
    if (!source.length) return;
    const count = opts.count, added = (count - 1) * source.length;
    if (added > MAX_NEW) {
      ui.toast(`That array would add ${added.toLocaleString('en-US')} items: lower the count or select less`, 'warn');
      return;
    }
    // group ids come from the store, once for all copies (two calls before the items are added return the same ids)
    const copies = array(source, { count, dx: opts.dx, dz: opts.dz, dry: opts.dry }, (n) => store.newGroupIds(n));
    if (!copies.length) return;
    const label = `Array ${describe(ctx, source.map((e) => e.item))} \u00d7 ${count}`;
    store.begin(label);
    try {
      for (const kind of KINDS) {
        const list = copies.filter((c) => c.kind === kind).map((c) => c.item);
        if (list.length) store.exec(cmd.add(kind, list));
      }
      store.select([...items, ...copies.map((c) => c.item)]);
    } catch (err) {
      store.cancel();
      throw err;
    }
    store.commit();
    ui.setStatus(label);
    ui.toast(`Array: added ${plural(copies.length, 'item')}`);
  }

  // ---------------------------------------------------------------- the panel

  const summary = h('div', { class: 'summary ui-hint' });
  const push = (label, onClick, title) => {
    const node = button(label, onClick, { title });
    node.dataset.title = title ?? '';       // the hint of the enabled button; a disabled one says why it is disabled
    return node;
  };
  const group = (...nodes) => h('span', { class: 'ui-group' }, nodes);

  const alignButtons = { x: {}, z: {} };
  const compass = { x: { min: 'west', max: 'east' }, z: { min: 'north', max: 'south' } };
  const alignRow = (axis) => {
    const X = axis.toUpperCase();
    const make = (mode, label, title) => (alignButtons[axis][mode] = push(label, () => doAlign(axis, mode), title));
    return row(`Align ${X}`, group(
      make('min', 'Min', `Give every item the smallest ${X} of the selection (line them up on the ${compass[axis].min} side)`),
      make('centre', 'Centre', `Give every item the middle ${X} of the selection`),
      make('max', 'Max', `Give every item the largest ${X} of the selection (line them up on the ${compass[axis].max} side)`),
    ));
  };
  const distributeX = push('Along X', () => doDistribute('x'), 'Space the items evenly from west to east; the two outermost stay');
  const distributeZ = push('Along Z', () => doDistribute('z'), 'Space the items evenly from north to south; the two outermost stay');
  const face = push('Pick a point\u2026', () => { doFace().catch((err) => console.error('[editor] face a point failed', err)); },
    'Click a point in the viewport: every selected object, chest and NPC turns to face it');
  face.classList.add('wide');
  const rotation = push('Rotation', doRotation, 'Give every selected object, chest and NPC a random rotation');
  rotation.classList.add('wide');
  const scaleMin = numberField({
    value: opts.scale[0], min: LIMITS.scale[0], max: LIMITS.scale[1], step: 0.05, digits: 3,
    onCommit: (v) => { if (Number.isFinite(v)) setScale(v, Math.max(v, opts.scale[1])); },
  });
  const scaleMax = numberField({
    value: opts.scale[1], min: LIMITS.scale[0], max: LIMITS.scale[1], step: 0.05, digits: 3,
    onCommit: (v) => { if (Number.isFinite(v)) setScale(Math.min(v, opts.scale[0]), v); },
  });
  // the pair stays ordered: an end typed past the other takes it along
  function setScale(lo, hi) {
    opts.scale = [lo, hi];
    scaleMin.set(lo);
    scaleMax.set(hi);
  }
  scaleMin.input.title = 'Smallest scale';
  scaleMax.input.title = 'Largest scale';
  const scale = push('Randomize', doScale, 'Give every selected object a random scale in this range');
  const dropButton = push('Drop to ground', doDrop, 'Set the height offset (Y) of every selected object to 0');
  dropButton.classList.add('wide');

  const count = numberField({
    value: opts.count, min: 2, max: MAX_COUNT, step: 1,
    onCommit: (v) => { if (Number.isFinite(v)) { opts.count = v; refresh(); } },
  });
  const stepX = numberField({
    value: opts.dx, min: -1000, max: 1000, step: 0.5, digits: 2,
    onCommit: (v) => { if (Number.isFinite(v)) opts.dx = v; },
  });
  const stepZ = numberField({
    value: opts.dz, min: -1000, max: 1000, step: 0.5, digits: 2,
    onCommit: (v) => { if (Number.isFinite(v)) opts.dz = v; },
  });
  const turn = angleField({
    value: opts.dry, min: -Math.PI, max: Math.PI,
    onCommit: (v) => { if (Number.isFinite(v)) opts.dry = v; },
  });
  count.input.title = `How many in all, the selection included (2\u2013${MAX_COUNT})`;
  stepX.input.title = 'Each copy is this far east (+) or west (\u2212) of the one before';
  stepZ.input.title = 'Each copy is this far south (+) or north (\u2212) of the one before';
  turn.input.title = 'Each copy is turned by this angle against the one before, as one piece about the centre of the selection';
  const create = push('Create array', doArray, 'Add the copies as one undo step; every group in the selection becomes a new group per copy');
  create.classList.add('wide');
  const arrayNote = h('div', { class: 'note ui-hint' });

  el.replaceChildren(
    summary,
    alignRow('x'),
    alignRow('z'),
    row('Distribute', group(distributeX, distributeZ)),
    row('Face', face),
    row('Randomize', rotation),
    row('Scale', scaleMin, h('span', { class: 'ui-dash' }, '\u2013'), scaleMax, scale),
    row('Height', dropButton),
    section('Array',
      row('Count', count),
      row('Step X', stepX),
      row('Step Z', stepZ),
      row('Turn', turn),
      h('div', { class: 'actions' }, create),
      arrayNote),
  );

  // ---------------------------------------------------------------- state of the buttons

  // on = the button can act; why = what to say on it when it cannot
  const enable = (node, on, why) => {
    node.disabled = !on;
    node.title = on ? node.dataset.title : why;
  };

  function refresh() {
    const selected = store.map ? store.selection.size : 0;
    frame.hidden = selected === 0;
    if (!selected) {
      if (picking) ctx.viewport.cancelModal?.();     // nothing is left to turn
      return;
    }
    const { items, entries } = current(), n = items.length, left = selected - n;
    const turns = ofKinds(entries, TURNS).length, objects = ofKinds(entries, ['object']).length;
    const copyable = ofKinds(entries, KINDS).length;
    const locked = 'The selection is on a hidden or locked layer';

    summary.textContent = n
      ? `${describe(ctx, items)} selected${left ? ` \u00b7 ${left.toLocaleString('en-US')} more on a hidden or locked layer stay as they are` : ''}`
      : `${locked}: nothing here can be arranged`;
    summary.classList.toggle('warn', n === 0);

    const two = n ? 'Select 2 or more items to align them' : locked;
    for (const axis of ['x', 'z']) for (const mode of ['min', 'centre', 'max']) enable(alignButtons[axis][mode], n >= 2, two);
    const three = n ? 'Select 3 or more items to space them evenly' : locked;
    enable(distributeX, n >= 3, three);
    enable(distributeZ, n >= 3, three);
    const facing = n ? 'Only objects, chests and NPCs have a facing' : locked;
    enable(face, turns > 0, facing);
    face.classList.toggle('active', picking);
    face.textContent = picking ? 'Click a point\u2026 (Esc)' : 'Pick a point\u2026';
    enable(rotation, turns > 0, facing);
    const sized = n ? 'Only objects have a scale' : locked;
    enable(scale, objects > 0, sized);
    enable(dropButton, objects > 0, n ? 'Only objects have a height offset' : locked);
    enable(create, copyable > 0, n ? 'The start point cannot be copied' : locked);

    const added = (opts.count - 1) * copyable;
    arrayNote.textContent = copyable
      ? `Adds ${copiesOf(opts.count - 1)} of the selection: ${plural(added, 'new item')}`
      : '';
  }

  const later = rafThrottle(refresh);
  store.on('selection', later);
  store.on('load', later);
  store.on('history', later);          // undo, redo: what is selected may be something else now
  ui.on('layers', later);              // a lock or an eye changes what may be edited
  ui.on('hiddenModels', later);
  ui.on('itemflags', later);
  refresh();
  return {};
}
