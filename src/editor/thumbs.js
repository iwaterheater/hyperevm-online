import * as THREE from 'three';

// Thumbnails of the palette: every model drawn once, small, from the same angle.
//
// They need a renderer of their own. A render target of the main renderer gets no tone mapping and linear output, and
// reading its pixels back blocks the main context; so there is ONE dedicated WebGLRenderer here, 144 x 144 px at pixel
// ratio 1 with ACES tone mapping, that lives only while there is something to draw: 10 s after the queue ran empty
// it is disposed and its context given back, and it is made again on demand.
//
// The scene holds one mesh that shows a model of view.loadModel - through STAND-INS this module owns: a geometry that
// shares the model's attributes, a clone of each material, a clone of each texture (it shares the image). A renderer
// hangs a 'dispose' listener on every geometry, material and texture it draws and never takes it off again, so
// drawing the view's own objects would leave one listener - holding a dead renderer - on each of them every time
// this renderer is given back and made anew. The stand-ins are disposed with the renderer, which is what removes the
// listeners and frees what was uploaded for them; the view's objects are never touched, never disposed here.
// The camera is orthographic, centred on the centre of the model's bounds, half as wide as the diagonal of those
// bounds (x 1.05) and looks along (1, 0.8, 1). It is NOT fitted to Model.radius: that is the footprint radius, and most
// models are far taller than wide (a pillar is 1.0 x 4.4 x 1.0).
//
// A thumbnail is: render, copy the canvas into a 2D canvas in the same task, toBlob, object URL - shown as an <img>
// and cached for the session. At most 2 of them per animation frame, none while a button is down in the viewport.
// The viewport is never invalidated from here.
//
//   thumbs.get(id)       -> Promise<string>: the object URL (it rejects when WebGL is not to be had)
//   thumbs.whenIdle()    -> Promise<void>: every thumbnail asked for so far is there
//   thumbs.pump()        advance the queue; the palette also calls it from the viewport's tick
// and beyond the contract, for the palette's large hover preview, which uses the same renderer, scene and camera fit:
//   thumbs.spin(id, canvas) -> stop(): draws the model, slowly turning, into the given 2D canvas until stopped

const SIZE = 144;              // px of a thumbnail
const PER_FRAME = 2;           // thumbnails drawn per animation frame
const IDLE_MS = 10000;         // the renderer is given back this long after the last job
const FALLBACK_MS = 120;       // a hidden tab runs no animation frames: a timer keeps the queue moving
const SAME_FRAME_MS = 4;       // two pumps closer than this are the same frame (the tick and our own loop)
const SPIN = 0.7;              // radians per second of the hover preview
const FIT = 1.05;              // air around the model
const DIR = new THREE.Vector3(1, 0.8, 1).normalize();
const CENTRE = new THREE.Vector3();
const EMPTY = new THREE.BufferGeometry(), BLANK = new THREE.MeshBasicMaterial();   // what the mesh holds between two renderers: never drawn

export function createThumbs(ctx) {
  const urls = new Map();        // id -> object URL, for the session
  const jobs = new Map();        // id -> { id, promise, resolve, reject, model } until its URL is there
  const queue = [];              // the jobs that are not drawn yet, in the order they were asked for
  let renderer = null, size = 0;
  let frame = 0, timer = 0, idle = 0, lastDraw = -1e9;
  let spinning = null;           // { id, canvas, g, model, angle, at }
  let waiting = [];              // resolvers of whenIdle()

  // ---- the scene: plain objects, kept while the renderer comes and goes
  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(0.5, 1, 0.35);   // the lights of the viewport's neutral mode: a thumbnail looks like the model in the map
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8c8c8c, 1.1), sun);
  const mesh = new THREE.Mesh();
  mesh.frustumCulled = false;
  const pivot = new THREE.Group();   // turns the model about the vertical axis through the centre of its bounds
  pivot.add(mesh);
  scene.add(pivot);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);

  // ---- the stand-ins of the current renderer: the view's object -> ours
  let own = { geometries: new Map(), materials: new Map(), textures: new Map() };
  function ownGeometry(source) {
    let g = own.geometries.get(source);
    if (!g) {
      g = new THREE.BufferGeometry();
      g.setIndex(source.index);
      for (const name of Object.keys(source.attributes)) g.setAttribute(name, source.attributes[name]);   // shared, not copied
      for (const group of source.groups) g.addGroup(group.start, group.count, group.materialIndex);
      g.setDrawRange(source.drawRange.start, source.drawRange.count);
      own.geometries.set(source, g);
    }
    return g;
  }
  function ownTexture(source) {
    let t = own.textures.get(source);
    if (!t) {
      t = source.clone();          // the same image, another texture object
      t.needsUpdate = true;        // a clone starts at version 0, which is "nothing to upload"
      own.textures.set(source, t);
    }
    return t;
  }
  function ownMaterial(source) {
    if (Array.isArray(source)) return source.map(ownMaterial);
    let m = own.materials.get(source);
    if (!m) {
      m = source.clone();
      for (const key of Object.keys(m)) if (m[key]?.isTexture) m[key] = ownTexture(m[key]);
      own.materials.set(source, m);
    }
    return m;
  }
  // Disposing them while their renderer still lives runs its listeners: they free what was uploaded and take
  // themselves off.
  function releaseOwn() {
    const old = own;
    own = { geometries: new Map(), materials: new Map(), textures: new Map() };
    mesh.geometry = EMPTY;
    mesh.material = BLANK;
    for (const list of [old.geometries, old.materials, old.textures]) {
      for (const item of list.values()) { try { item.dispose(); } catch { /* the context is gone already */ } }
    }
  }

  function drop() {
    const r = renderer;
    renderer = null;
    size = 0;
    if (!r) return;
    releaseOwn();                 // first: the renderer must still be there to clean up after them
    try { r.dispose(); r.forceContextLoss(); } catch { /* the context is gone already */ }
  }

  // -> the renderer at `px` x `px`, or null when the browser gives no WebGL context
  function ready(px) {
    if (!renderer) {
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch (err) {
        console.warn('[editor] thumbnails: no WebGL context', err?.message ?? err);
        return null;
      }
      renderer.setPixelRatio(1);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.setClearColor(0x000000, 0);
      // a context the browser took away (too many of them, a GPU reset): forget the renderer and what was made for
      // it, the next job makes both anew
      const mine = renderer;
      mine.domElement.addEventListener('webglcontextlost', () => { if (renderer === mine) { renderer = null; size = 0; releaseOwn(); } });
    }
    if (size !== px) {
      renderer.setSize(px, px, false);
      size = px;
    }
    return renderer;
  }

  // Puts `model` into the scene and the camera around it.
  function aim(model, angle) {
    const c = model.bounds.getCenter(CENTRE), half = Math.max(model.size.length() / 2 * FIT, 1e-3);
    mesh.geometry = ownGeometry(model.geometry);
    mesh.material = ownMaterial(model.material);
    mesh.position.set(-c.x, -c.y, -c.z);
    pivot.rotation.y = angle;
    camera.left = camera.bottom = -half;
    camera.right = camera.top = half;
    camera.near = half * 0.5;      // the model sits in a sphere of radius `half`, two of them away
    camera.far = half * 3.5;
    camera.position.copy(DIR).multiplyScalar(half * 2);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }

  // -> the renderer's canvas showing the model, or null
  function draw(model, angle, px) {
    const r = ready(px);
    if (!r) return null;
    aim(model, angle);
    r.render(scene, camera);
    return r.domElement;
  }

  function finish(job, url, err) {
    jobs.delete(job.id);
    if (url) {
      urls.set(job.id, url);
      job.resolve(url);
    } else job.reject(err ?? new Error(`no thumbnail for ${job.id}`));
    settle();
  }

  function render(job) {
    const source = draw(job.model, 0, SIZE);
    if (!source) { finish(job, null, new Error('WebGL is not available')); return; }
    // a canvas per thumbnail: toBlob is asynchronous, and the next thumbnail is drawn before it has read this one
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    canvas.getContext('2d').drawImage(source, 0, 0);   // in the same task as the render: the drawing buffer is still there
    canvas.toBlob((blob) => finish(job, blob ? URL.createObjectURL(blob) : null), 'image/png');
  }

  function turn(now) {
    const s = spinning;
    if (!s?.model) return;
    s.angle += Math.min(0.1, Math.max(0, (now - s.at) / 1000)) * SPIN;
    s.at = now;
    const px = Math.max(1, Math.min(s.canvas.width, s.canvas.height));
    const source = draw(s.model, s.angle, px);
    if (!source) return;
    s.g.clearRect(0, 0, s.canvas.width, s.canvas.height);
    s.g.drawImage(source, 0, 0);
  }

  const drawable = () => queue.some((job) => job.model);

  // Nothing left to do: tell who waits for that, and start the clock that gives the renderer back.
  function settle() {
    if (jobs.size === 0 && waiting.length) {
      const list = waiting;
      waiting = [];
      for (const ok of list) ok();
    }
    clearTimeout(idle);
    idle = 0;
    if (renderer && jobs.size === 0 && !spinning) idle = setTimeout(() => { if (jobs.size === 0 && !spinning) drop(); }, IDLE_MS);
  }

  // One step: up to PER_FRAME thumbnails and one frame of the hover preview.
  function pump() {
    const now = performance.now();
    if (now - lastDraw < SAME_FRAME_MS) return;      // the tick and our own loop met in one frame
    if (ctx.viewport?.pointerDown) return;           // a drag in the viewport gets every millisecond
    let done = 0;
    for (let i = 0; i < queue.length && done < PER_FRAME;) {
      const job = queue[i];
      if (!job.model) { i++; continue; }             // its file is still on the way: the ones behind it go first
      queue.splice(i, 1);
      render(job);
      done++;
    }
    if (spinning?.model) { turn(now); done++; }
    if (done) lastDraw = now;
  }

  // Our own loop, alive only while there is something to draw. An animation frame when the page has them, a timer
  // when it does not (a hidden tab): whichever comes first.
  function kick() {
    if (frame || timer) return;
    const run = () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = timer = 0;
      pump();
      if (drawable() || spinning?.model) kick();
    };
    frame = requestAnimationFrame(run);
    timer = setTimeout(run, FALLBACK_MS);
  }

  function get(id) {
    if (urls.has(id)) return Promise.resolve(urls.get(id));
    let job = jobs.get(id);
    if (!job) {
      job = { id, promise: null, resolve: null, reject: null, model: null };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      jobs.set(id, job);
      queue.push(job);
      clearTimeout(idle);
      idle = 0;
      // never rejects: a model that cannot be loaded arrives as the magenta stand-in, and that is its thumbnail
      Promise.resolve(ctx.view.loadModel(id)).then((model) => {
        job.model = model;
        kick();
      }, (err) => {
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        finish(job, null, err);
      });
    }
    return job.promise;
  }

  function whenIdle() {
    if (jobs.size === 0) return Promise.resolve();
    return new Promise((resolve) => { waiting.push(resolve); });
  }

  // The large preview: `canvas` (a square 2D canvas, sized by its owner) shows the model turning until stop() is
  // called or another spin starts. Nothing is drawn before the model is loaded.
  function spin(id, canvas) {
    const g = canvas.getContext('2d'), s = spinning = { id, canvas, g, model: null, angle: 0, at: performance.now() };
    g.clearRect(0, 0, canvas.width, canvas.height);
    clearTimeout(idle);
    idle = 0;
    Promise.resolve(ctx.view.loadModel(id)).then((model) => {
      if (spinning !== s) return;
      s.model = model;
      s.at = performance.now();
      turn(s.at);   // the first picture now; the loop turns it
      kick();
    }, () => {});
    return () => {
      if (spinning !== s) return;
      spinning = null;
      settle();
    };
  }

  return { get, whenIdle, pump, spin, has: (id) => urls.has(id), url: (id) => urls.get(id) ?? null };
}
