import { h, button, textField } from '../ui/dom.js';
import { hintFor } from '../keymap.js';
import { LIMITS } from '../../map/format.js';

// The file part of the menu bar (#menu-file): the map name, the unsaved dot, Save, Undo, Redo.
// Import / Export and Play sit beside it in #menu-io and #menu-play and belong to io.js and play.js.
// Everything here goes through actions, so a click and its key do exactly the same.

export default function mount(el, ctx) {
  const { store, ui, actions, cmd } = ctx;

  // The name is edited in place: one undo step, like the same field in the inspector.
  const name = textField({
    value: '', minLength: LIMITS.name[0], maxLength: LIMITS.name[1],
    onCommit: (text) => {
      if (!store.map || text === store.map.name) return;
      if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); name.set(store.map.name); return; }
      store.exec(cmd.setProps({ name: text }));
    },
  });
  name.input.title = 'Map name';
  name.input.setAttribute('aria-label', 'Map name');

  const key = (action) => { const hint = hintFor(action); return hint && h('kbd', { class: 'ui-kbd' }, hint); };
  const dot = h('span', { class: 'ui-dot', title: 'Unsaved changes' });
  const save = button(['Save', key('file.save')], () => actions.run('file.save'));
  save.classList.add('save');
  // Undo and Redo fall back to the store while nobody has registered the actions: a dead button helps no one
  const undo = button(['Undo', key('edit.undo')], () => (actions.has('edit.undo') ? actions.run('edit.undo') : store.undo()));
  const redo = button(['Redo', key('edit.redo')], () => (actions.has('edit.redo') ? actions.run('edit.redo') : store.redo()));
  const readOnly = h('span', { class: 'ui-badge warn', hidden: true, title: 'The server is not in editor mode: the map cannot be saved. Export still works.' }, 'Read-only');

  el.replaceChildren(
    h('span', { class: 'brand' }, 'Map editor'),
    h('span', { class: 'name' }, name),
    dot, save, undo, redo, readOnly,
  );

  const sync = () => {
    const errors = ui.issues?.errors ?? 0;
    dot.classList.toggle('on', !!store.dirty);
    // disabled = the server would not take it; Mod+S still answers with the reason as a toast
    save.disabled = !store.map || !!ui.readOnly || errors > 0;
    save.title = ui.readOnly ? 'Read-only: server is not in editor mode'
      : errors > 0 ? `${errors} error${errors === 1 ? '' : 's'} in the map: see Issues`
        : store.dirty ? 'Save the map to the server' : 'No unsaved changes';
    undo.disabled = !store.canUndo;
    redo.disabled = !store.canRedo;
    undo.title = 'Undo the last edit';
    redo.title = 'Redo the edit that was undone';
    readOnly.hidden = !ui.readOnly;
  };
  const syncName = () => name.set(store.map?.name ?? '');

  store.on('history', sync);
  store.on('load', () => { syncName(); sync(); });
  store.on('change', (change) => { if (change?.props?.includes('name')) syncName(); });
  ui.on('issues', sync);
  ui.on('readOnly', sync);
  syncName();
  sync();
  return {};
}
