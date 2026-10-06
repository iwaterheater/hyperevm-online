// Where the pieces of a row go: the Line and Ring modes of the Place tool - how walls, fences and colonnades are built.
// PURE: no DOM, no three, no imports. It knows no models and no map; the tool gives it one number about the model
// (the length of a piece) and turns the result into objects.
//
// A result is [{ x, z, ry, s }]: the CENTRE of every piece on the ground, its rotation and its scale.
//
// opts (every key optional except `length`):
//   length     world length of one piece at s = 1, measured along the path
//   s          scale of the pieces (default 1)
//   spacing    distance between the centres of two pieces; null = length * s, the pieces touch end to end
//   orient     'along'   local +X along the path: ry = atan2(-dz, dx); local +Z then points to the RIGHT of travel
//              'perp'    local +X across the path, pointing to the left of travel
//              'centre'  local +Z faces the centre of the ring. A ring is walked clockwise as seen from above (north
//                        up), so its centre is on the right: there 'centre' and 'along' are the same rotation. A line
//                        has no centre and treats 'centre' as 'along'
//              'random'  any rotation (rnd)
//   turn       added to the rotation of every piece (default 0): 180 degrees make a ring face outwards
//   offset     lateral shift of every piece, to the left of travel (on a ring: outwards)
//   alternate  the offset changes sides from piece to piece
//   fit        the row ends exactly on the end of its segment, or closes the ring: the pieces are counted as usual,
//              n = max(1, round(L / spacing)), and then spread over the whole length L. Pieces that touch (spacing null)
//              are scaled to keep touching: s = L / (n * length). With a typed spacing the scale stays and the spacing gives
//   jitter     every centre is moved by a random vector of at most this length (a tree row that is not a ruler line)
//   startAngle ring only: the angle of the first piece, atan2(z - centre.z, x - centre.x)
//   max        at most this many pieces (default 2000): a typed spacing of 0.01 must not freeze the page
//   rnd        the random source, () -> [0, 1) (default Math.random)

const TAU = Math.PI * 2;
const MAX_PIECES = 2000;
const MIN_STEP = 1e-3;

const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// The options with their defaults filled in and every number made safe to divide by.
function read(opts = {}) {
  const length = Math.max(MIN_STEP, finite(opts.length, 1)), s = Math.max(MIN_STEP, finite(opts.s, 1));
  const typed = opts.spacing !== null && opts.spacing !== undefined && Number.isFinite(opts.spacing) && opts.spacing > 0;
  return {
    length, s, typed,
    step: Math.max(MIN_STEP, typed ? opts.spacing : length * s),
    orient: opts.orient === 'perp' || opts.orient === 'centre' || opts.orient === 'random' ? opts.orient : 'along',
    turn: finite(opts.turn, 0),
    offset: finite(opts.offset, 0),
    alternate: opts.alternate === true,
    fit: opts.fit === true,
    jitter: Math.max(0, finite(opts.jitter, 0)),
    max: Math.max(1, Math.floor(finite(opts.max, MAX_PIECES))),
    rnd: typeof opts.rnd === 'function' ? opts.rnd : Math.random,
  };
}

// How many pieces a stretch of length L takes, how far apart their centres are and how large they are.
function measure(o, L, room) {
  const n = Math.min(room, Math.max(1, Math.round(L / o.step)));
  if (!o.fit) return { n, pitch: o.step, s: o.s };
  // the count stands; the pieces are spread over the whole stretch, and scaled when they are meant to touch
  return { n, pitch: L / n, s: o.typed ? o.s : L / (n * o.length) };
}

// One piece: the centre moved sideways and jittered, the rotation by the rule of `orient`.
// (tx, tz) is the unit direction of travel; its left is (tz, -tx).
function piece(o, x, z, tx, tz, s, index) {
  const side = o.offset * (o.alternate && index % 2 === 1 ? -1 : 1);
  x += tz * side;
  z -= tx * side;
  if (o.jitter > 0) {
    const a = o.rnd() * TAU, d = o.jitter * Math.sqrt(o.rnd());   // uniform over the disc
    x += Math.cos(a) * d;
    z += Math.sin(a) * d;
  }
  let ry;
  if (o.orient === 'random') ry = o.rnd() * TAU;
  else ry = Math.atan2(-tz, tx) + (o.orient === 'perp' ? Math.PI / 2 : 0);
  return { x, z, ry: ry + o.turn, s };
}

// A row along a polyline. points: [[x, z], ...], at least two. Every segment is laid out by itself, from its first
// point: a corner of a wall is a clicked point, never the middle of a piece. A segment shorter than half a piece still
// gets one piece; a segment of no length gets none.
// -> [{ x, z, ry, s }]
export function layoutLine(points, opts) {
  const o = read(opts), out = [];
  if (!Array.isArray(points)) return out;
  for (let i = 1; i < points.length && out.length < o.max; i++) {
    const ax = points[i - 1][0], az = points[i - 1][1], dx = points[i][0] - ax, dz = points[i][1] - az;
    const L = Math.hypot(dx, dz);
    if (!(L > 1e-9)) continue;
    const tx = dx / L, tz = dz / L, m = measure(o, L, o.max - out.length);
    for (let k = 0; k < m.n; k++) {
      const t = (k + 0.5) * m.pitch;
      out.push(piece(o, ax + tx * t, az + tz * t, tx, tz, m.s, out.length));
    }
  }
  return out;
}

// A ring: piece centres ON the circle of `radius` around centre { x, z }, evenly spread, the first one at startAngle.
// The pieces are counted along the circumference; with `fit` and touching pieces they are scaled so that the ring
// closes: s = 2 * PI * radius / (n * length).
// -> [{ x, z, ry, s }]
export function layoutRing(centre, radius, opts) {
  const o = read(opts), out = [], r = finite(radius, 0);
  if (!(r > 1e-9) || !centre) return out;
  const L = TAU * r, m = measure(o, L, o.max), a0 = finite(opts?.startAngle, 0);
  for (let k = 0; k < m.n; k++) {
    const a = a0 + k * TAU / m.n, cos = Math.cos(a), sin = Math.sin(a);
    // travelling with the angle: the tangent is (-sin, cos), its left is the way out of the ring
    out.push(piece(o, centre.x + cos * r, centre.z + sin * r, -sin, cos, m.s, k));
  }
  return out;
}

// The length of a polyline [[x, z], ...] - what the readout of the Place tool shows.
export function pathLength(points) {
  let L = 0;
  for (let i = 1; i < (points?.length ?? 0); i++) L += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return L;
}
