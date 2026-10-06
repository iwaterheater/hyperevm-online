// The action registry: how the keymap, the menu bar, toolbar buttons and toasts reach features of other modules.
// A module registers what it can do under an id ('file.save', 'edit.undo', 'tool.place'); everybody else only knows
// the id. So a key works whoever owns the feature, and a feature whose module is still a stub degrades to a toast.
// Pure: no DOM. `ui` is only asked to toast.

// The one reporter of a failed call into a tool, a panel or an overlay: ONE console line per module and method, whoever
// made the call. main.js, the viewport and the keymap all call into the same modules (a tool's key() is reached from
// the keyboard and from a right-click), so the memory of what was reported cannot be theirs - it is the page's.
//   name    the module as every caller names it: 'tool place', 'panel Inspector', 'overlay regiontint'
//   method  'create', 'mount', 'key', 'update', ...
// -> true when this call wrote the line, false when the failure was in the console already
const reportedCalls = new Set();
export function reportOnce(name, method, err) {
  const key = `${name}.${method}`;
  if (reportedCalls.has(key)) return false;
  reportedCalls.add(key);
  console.error(`[editor] ${name} ${method}() failed`, err);
  return true;
}

export function createActions(ui) {
  const table = new Map();          // id -> { fn, enabled }
  const reported = new Set();       // ids whose failure is already in the console: once per action

  const report = (id, e) => {
    if (reported.has(id)) return;
    reported.add(id);
    console.error(`[editor] action '${id}' failed`, e);
  };

  const actions = {
    // fn(...args) does the thing; enabled() tells whether it can right now (a button asks it too).
    // Registering an id twice throws: two modules claiming one action is a bug in one of them.
    register(id, fn, { enabled = () => true } = {}) {
      if (typeof id !== 'string' || !id) throw new TypeError('actions.register: the id must be a non-empty string');
      if (typeof fn !== 'function') throw new TypeError(`actions.register('${id}'): the handler must be a function`);
      if (typeof enabled !== 'function') throw new TypeError(`actions.register('${id}'): enabled must be a function`);
      if (table.has(id)) throw new Error(`actions.register('${id}'): already registered`);
      table.set(id, { fn, enabled });
    },

    // -> true when the handler ran. Unregistered: a toast and false. Disabled: false. A handler that throws: false, and
    // the page lives on - handlers belong to six different owners.
    run(id, ...args) {
      const action = table.get(id);
      if (!action) {
        ui.toast('Not available yet');
        return false;
      }
      if (!actions.enabled(id)) return false;
      try {
        const result = action.fn(...args);
        // an async handler fails after we have returned: at least say whose promise it was
        if (result && typeof result.then === 'function') result.then(null, (e) => report(id, e));
        return true;
      } catch (e) {
        report(id, e);
        return false;
      }
    },

    has(id) {
      return table.has(id);
    },

    // -> false for an unregistered id, and when its enabled() says no or throws
    enabled(id) {
      const action = table.get(id);
      if (!action) return false;
      try { return !!action.enabled(); } catch (e) {
        report(id, e);
        return false;
      }
    },
  };
  return actions;
}
