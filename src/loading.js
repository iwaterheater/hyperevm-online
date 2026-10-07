// The loading screen: the picture, the logo, the bar and the tips that cover the page from its first paint until the
// world can be drawn without anything popping in. The markup and the styles are static, in index.html, so they show
// before a line of script has run; this module moves the bar, turns the tips and takes the screen away.
//
// The page loads this file twice over: by a script tag of its own, ahead of the game, so the tips turn and the watchdog
// runs while three.js is still on its way from the CDN - and by src/main.js, which gets the same instance and reports
// to it. It therefore imports nothing, and node can load it for the test of the counter.
//
// What the bar counts are real things, each announced before it is asked for:
//   engine      1   three.js and the game's modules: counted when src/main.js starts to run
//   map         1   the map request
//   scenery     n   one per model file the map uses (known when the map has arrived)
//   townsfolk   n   one per character model of the map's townsfolk
//   cat, effects, monsters (8 files), treasure (2 chests and the coin)
//   ground      1   the foliage of every terrain tile has grown
//   shaders     1   every material in the scene is compiled
//   frames      1   a few frames are drawn behind the screen
// A file that does not load is counted like one that does - the game draws the world without it - and is logged.
//
// Debugging: /?loading=hold keeps the screen up when everything is done, /?loading=hold:40 freezes its bar and counter
// the moment they pass 40 %. The game goes on behind it. window.__loading is this module's screen.

const STALL_AFTER = 20000;     // ms without anything new arriving until the screen says so and offers Retry
const TIP_EVERY = 6000;        // ms a tip stays
const FADE = 500;              // ms the screen takes to go; index.html has the same number in its transition
const OPEN_SHARE = 0.05;       // how far the bar may go while the list of things to load is not complete
const GROW_BUDGET = 8000;      // ms the foliage gets to finish before the screen stops waiting for it
const FRAMES = 3;              // drawn behind the screen before it goes: the first of them with nothing culled

// Facts from README.md; a tip must never promise what the game does not have.
export const TIPS = [
  'Move with W A S D or the arrow keys. Hold the right mouse button to turn the camera; the wheel zooms.',
  'Click a monster to target it, then press F: the cat runs up to it and keeps attacking by itself.',
  'Tab selects the next nearest monster. Esc clears the target.',
  'Press X to sit down and rest: health and mana come back much faster. Moving stands the cat up.',
  'At level 20 the Sage in town offers a profession: Knight, Rogue or Archer to a Fighter, Wizard or Cleric to a Mystic.',
  'Every kill gives skill points. Spend them on skills at the Sage, and press K to see what your class can learn.',
  'Drag a potion from the inventory (I) onto the action bar and drink it with its key. All potions share one cooldown.',
  'The Trader in town sells potions and Leather and Iron gear, and buys anything from your bag. Press T next to him.',
  'Steel and Hypurr gear is never for sale: it drops from the monsters far from town.',
  'The Blacksmith upgrades your weapon for gold: stand next to him and press B.',
  'The cat fights the way its weapon does: a bow shoots from afar in the paws of any class.',
  'Space jumps, and jumps once more in the air.',
  'Mana comes back slowly in the field, quickly while sitting, and fastest in town.',
  'Dying costs a little experience and never an item. You wake up in town.',
  'The radar always points to the town and to the lair of the Skeleton King.',
  'The whole world is one file. Start the server with "npm run dev" and open /editor.html to build a map of your own.',
];

// ---------------------------------------------------------------- the counter

// Counts things in named groups: so many expected, so many through. Pure - no page, no timers.
//   expect(name, n)          n more things will come under this name
//   settle(name, ok, n)      n of them are through (ok = false: they failed, which counts all the same)
//   reach(name, done, total) a loader's own onProgress(done, total): the group is at least that far
//   seal()                   the list is complete: until then the bar keeps to its first twentieth
//   done, total, failed      the numbers; done never falls and never passes total
//   fraction                 0..1 for the bar; it never falls either, even when a late group makes the total grow
//   left(names)              how many things of these groups (default: all) are still out
export function createProgress() {
  const groups = new Map();   // name -> { total, done, failed }
  let sealed = false, shown = 0;
  const group = (name) => {
    if (!groups.has(name)) groups.set(name, { total: 0, done: 0, failed: 0 });
    return groups.get(name);
  };
  const whole = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  const sum = (key) => { let s = 0; for (const g of groups.values()) s += g[key]; return s; };
  const self = {
    expect(name, n = 1) { group(name).total += whole(n); return self; },
    settle(name, ok = true, n = 1) {
      const g = group(name);
      n = whole(n);
      g.done += n;
      if (!ok) g.failed += n;
      if (g.done > g.total) g.total = g.done;   // something nobody announced: it is counted, not dropped
      return self;
    },
    reach(name, done, total = 0) {
      const g = group(name);
      g.total = Math.max(g.total, whole(total));
      g.done = Math.max(g.done, whole(done));
      if (g.done > g.total) g.total = g.done;
      return self;
    },
    seal() { sealed = true; return self; },
    left(names = null) {
      let n = 0;
      for (const [name, g] of groups) if (!names || names.includes(name)) n += g.total - g.done;
      return n;
    },
    get sealed() { return sealed; },
    get done() { return sum('done'); },
    get total() { return sum('total'); },
    get failed() { return sum('failed'); },
    get fraction() {
      const total = sum('total');
      const now = total ? sum('done') / total : 0;
      shown = Math.max(shown, sealed ? now : Math.min(now, OPEN_SHARE));
      return shown;
    },
    groups() { return Object.fromEntries([...groups].map(([name, g]) => [name, { ...g }])); },
  };
  return self;
}

// ---------------------------------------------------------------- the screen

// Lets the browser do something else. Not a timer and not an animation frame: a tab in the background gets one of
// those a second, and the world must finish loading there too.
const breathe = () => new Promise((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
  channel.port2.postMessage(0);
});
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// `doc` is the page; `search` its query string. -> the screen, or one that only counts when the page has no #loading.
export function createLoadingScreen(doc, { search = '', now = () => performance.now() } = {}) {
  const $ = (id) => doc.getElementById(id);
  const root = $('loading'), bar = $('loadBar'), fill = $('loadFill'), text = $('loadText'), tip = $('loadTip');
  const trouble = $('loadTrouble'), troubleText = $('loadTroubleText'), retry = $('loadRetry');
  const progress = createProgress();
  // the screen's own things, known before the game's code has arrived
  for (const name of ['engine', 'ground', 'shaders', 'frames']) progress.expect(name);

  const hold = /^hold(?::(\d+))?$/.exec(new URLSearchParams(search).get('loading') ?? '');
  const freezeAt = hold?.[1] ? Math.min(100, Number(hold[1])) / 100 : null;
  const startedAt = now();
  let state = 'loading';        // 'loading' | 'failed' (for good: only Retry helps) | 'done'
  let frozen = false, waiters = [], seen = -1, stallTimer = null, stalled = false;
  const took = [];              // [what, seconds]: how long each part of the load took, for the line in the console
  let lapAt = startedAt;
  const lap = (what) => { took.push(`${what} ${((now() - lapAt) / 1000).toFixed(1)}`); lapAt = now(); };
  let ready;
  const whenReady = new Promise((resolve) => { ready = resolve; });

  function draw() {
    for (const wake of waiters.splice(0)) wake();
    if (progress.done !== seen) {   // something arrived: the watchdog starts over, and takes back what it said
      seen = progress.done;
      watch();
    }
    if (!root || frozen) return;
    const f = progress.fraction, pct = Math.round(f * 100);
    fill.style.width = `${(f * 100).toFixed(1)}%`;
    bar.setAttribute('aria-valuenow', String(pct));
    // the total is shown when it is final: it would only jump about before
    const counted = progress.sealed ? `${progress.done} / ${progress.total}` : '';
    text.textContent = counted ? `Loading the world… ${counted}` : 'Loading the world…';
    bar.setAttribute('aria-valuetext', counted ? `${progress.done} of ${progress.total}` : 'Starting');
    if (freezeAt !== null && f >= freezeAt) frozen = true;
  }

  // ---- tips
  let tipAt = Math.floor(Math.random() * TIPS.length), tipTimer = null;
  function showTip() {
    if (!tip) return;
    tip.classList.add('out');   // fades out, changes, fades in; without motion the class changes nothing
    setTimeout(() => {
      tip.textContent = `Tip: ${TIPS[tipAt % TIPS.length]}`;
      tip.classList.remove('out');
    }, 300);
    tipAt++;
  }

  // ---- trouble: a message and a Retry button. `fatal` stops the screen for good; otherwise loading goes on behind it.
  function say(message, fatal) {
    if (state !== 'loading') return;
    if (fatal) { state = 'failed'; clearTimeout(stallTimer); }
    console.error(`[loading] ${message}`);
    if (!root) return;
    troubleText.textContent = message;
    trouble.hidden = false;
    root.classList.toggle('failed', fatal);
    if (fatal) { clearInterval(tipTimer); retry.focus(); }
  }
  // The watchdog. Not a limit on the whole load - a slow line is not a fault - but on the time nothing at all arrives:
  // a request that hangs, a script that died. Loading goes on behind the message, and the message goes when it does.
  function watch() {
    clearTimeout(stallTimer);
    if (state !== 'loading') return;
    if (stalled) { stalled = false; if (trouble) trouble.hidden = true; }
    stallTimer = setTimeout(() => {
      stalled = true;
      say('Nothing has arrived for a while. Keep waiting, or try again.', false);
    }, STALL_AFTER);
  }

  function leave() {
    state = 'done';
    clearTimeout(stallTimer);
    clearInterval(tipTimer);
    stopListening();
    const seconds = ((now() - startedAt) / 1000).toFixed(1);
    const programs = self.programs();
    console.info(`[loading] ${progress.done} / ${progress.total} in ${seconds} s (${took.join(', ')})`
      + `${progress.failed ? `, ${progress.failed} failed` : ''}${programs === null ? '' : `, ${programs} shader programs`}`);
    if (trouble && !hold) trouble.hidden = true;
    if (!root || hold) { ready(); return; }
    root.classList.add('gone');
    root.setAttribute('aria-busy', 'false');
    // not transitionend: a tab in the background runs no transitions
    setTimeout(() => { root.hidden = true; }, FADE + 100);
    ready();
  }

  // ---- the page's own failures, which nothing else would report while this screen is in the way
  const onError = (e) => { stalled = false; say(`Something went wrong while the game was starting${e?.message ? `: ${e.message}` : '.'}`, false); };
  const game = doc.querySelector?.('script[src$="src/main.js"]');
  const onNoCode = () => say('The game\'s code did not load. Check the connection and try again.', true);
  const view = doc.defaultView;
  view?.addEventListener('error', onError);
  game?.addEventListener('error', onNoCode);
  function stopListening() {
    view?.removeEventListener('error', onError);
    game?.removeEventListener('error', onNoCode);
  }

  if (root) {
    retry.addEventListener('click', () => view.location.reload());
    tipTimer = setInterval(showTip, TIP_EVERY);   // the page comes with its first tip written in
  }
  draw();

  // Resolves when nothing of the named groups is out any more.
  async function settled(names) {
    while (progress.left(names) > 0) await new Promise((resolve) => { waiters.push(resolve); });
  }

  const self = {
    progress,
    ready: whenReady,           // resolves when the screen starts to go
    get state() { return state; },
    programs: () => null,       // how many shader programs the renderer holds, once finish() was told how to ask

    // { name: n, ... } or (name, n): things that will be loaded
    expect(name, n = 1) {
      if (typeof name === 'object') for (const [key, count] of Object.entries(name)) progress.expect(key, count);
      else progress.expect(name, n);
      draw();
    },
    // one thing of a group is through
    step(name, ok = true) { progress.settle(name, ok); draw(); },
    // -> the same promise. The thing is through when the promise settles; a rejection, or `false`, is a failure.
    track(name, promise) {
      promise.then((value) => self.step(name, value !== false), (err) => {
        console.warn(`[loading] ${name} failed to load:`, err?.message ?? err);
        self.step(name, false);
      });
      return promise;
    },
    // -> an onProgress(done, total) for a loader that counts its own files
    counter(name) { return (done, total) => { progress.reach(name, done, total); draw(); }; },
    // the list of things is complete: the counter shows its total from now on
    seal() { progress.seal(); draw(); },
    fail(message) { say(message, true); },

    // Everything that was announced is waited for; then the world is warmed up and the screen goes.
    //   grow()      one step of the foliage; -> true while tiles are still queued
    //   compile()   -> a promise: the shaders of everything in the scene are compiled
    //   frame()     draws one frame of the game
    //   scene       the three.js scene: for one frame nothing in it is culled, so every buffer and texture is sent now
    //   extras()    -> objects that are not in the scene yet but will be (a monster of each kind): compiled and drawn too
    //   programs()  -> how many shader programs the renderer holds: logged at the end, and there to ask again later -
    //               a number that grows after the screen has gone names something that was not warmed up
    async finish({ grow = null, compile = null, frame = null, scene = null, extras = null, programs = null } = {}) {
      const mine = ['ground', 'shaders', 'frames'];
      if (programs) self.programs = programs;
      try {
        await settled(Object.keys(progress.groups()).filter((name) => !mine.includes(name)));
        if (state === 'failed') return;
        lap('files');

        // the foliage regrows a few tiles a step, and only once the colliders of the models that arrived are at rest
        const until = now() + GROW_BUDGET;
        let slice = now();
        while (grow?.() && now() < until) {
          if (now() - slice > 12) { await breathe(); slice = now(); }
        }
        self.step('ground');
        lap('ground');
        await breathe();

        let added = [];
        try { added = extras?.() ?? []; } catch (err) { console.warn('[loading] nothing extra to warm up:', err?.message ?? err); }
        for (const o of added) scene?.add(o);
        await compile?.();
        self.step('shaders');
        lap('shaders');
        await breathe();

        const culled = [];
        scene?.traverse((o) => { if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; } });
        for (let i = 0; i < FRAMES; i++) {
          frame?.();
          if (i === 0) for (const o of culled) o.frustumCulled = true;
          await breathe();
        }
        for (const o of added) scene?.remove(o);
        frame?.();                                  // and one without the extras: the picture the screen opens on
        self.step('frames');
        lap('frames');
      } catch (err) {
        // warming up is a kindness, not a condition: the game is there, so the screen must not stay because of it
        console.error('[loading] the warm-up failed', err);
        for (const name of mine) if (progress.left([name])) progress.settle(name, false);
        draw();
      }
      if (state === 'failed') return;
      if (root && !hold) await sleep(180);          // the eye gets to see the bar full
      leave();
    },
  };
  return self;
}

// The screen of this page; null where there is no page (node).
export const loading = typeof document === 'undefined' ? null : createLoadingScreen(document, { search: location.search });
if (loading) window.__loading = loading;
