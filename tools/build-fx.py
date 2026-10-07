# Builds the skill-effect models of art/fx.blend and exports them to assets/fx/fx.glb, which src/fx.js animates.
# Run it inside Blender with art/fx.blend open (Scripting tab > Open > Run Script); it replaces every object it makes,
# so a shape is changed here, not by hand in the file.
#
# Conventions (Blender axes; the glTF export turns -Y into three.js +Z and +Z into +Y):
#   - projectiles fly towards -Y, their tails trail towards +Y
#   - ground circles lie in the XY plane with radius 1; upright glyphs stand in the XZ plane and face -Y
#   - every mesh carries the colour attribute "Col": rgb is its colour with the facet shading baked in
#     (the game draws effects unlit), alpha is its fade. White meshes are tinted by the game.
#   - material fx_solid: opaque parts; fx_glow: see-through parts that fade by the alpha of "Col"
import bpy, bmesh, math, random
from math import sin, cos, pi, radians
from mathutils import Vector, Matrix

random.seed(11)
LIGHT = Vector((0.35, -0.5, 0.8)).normalized()
FWD = Matrix.Rotation(pi / 2, 4, 'X')        # turns a shape built along +Z to point at -Y
SOLID, GLOW = 0, 1


def lin(c):
    return ((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92


def col(h):
    return Vector((lin((h >> 16 & 255) / 255), lin((h >> 8 & 255) / 255), lin((h & 255) / 255)))


WHITE = Vector((1, 1, 1))
clamp = lambda t: max(0.0, min(1.0, t))


def ramp(axis, a, b, va, vb):
    """A value that changes from va at coordinate a to vb at coordinate b along an axis (0, 1, 2)."""
    return lambda co: va + (vb - va) * clamp((co[axis] - a) / (b - a))


def radial(a, b, va, vb):
    return lambda co: va + (vb - va) * clamp((math.hypot(co.x, co.y) - a) / (b - a))


class Build:
    def __init__(self):
        self.bm = bmesh.new()
        self.jobs = []

    def paint(self, faces, rgb=WHITE, alpha=1.0, lo=0.5, mat=SOLID):
        """rgb / alpha: a value or a function of the vertex position. lo: the darkest facet (None: no shading)."""
        self.jobs.append((list(faces), rgb, alpha, lo, mat))
        return faces

    def glow(self, faces, rgb=WHITE, alpha=1.0):
        return self.paint(faces, rgb, alpha, None, GLOW)

    # ---- shapes; each returns its faces
    def lathe(self, prof, segs, M=Matrix(), wob=None, twist=0.0, phase=0.0):
        """A surface of revolution about +Z. prof: (radius, z) pairs; radius 0 is a tip."""
        bm, rings = self.bm, []
        for i, (r, z) in enumerate(prof):
            if r < 1e-6:
                rings.append([bm.verts.new(M @ Vector((0, 0, z)))])
                continue
            ring = []
            for j in range(segs):
                a = phase + twist * i + 2 * pi * j / segs
                k = wob(i, j) if wob else 1.0
                ring.append(bm.verts.new(M @ Vector((r * k * cos(a), r * k * sin(a), z))))
            rings.append(ring)
        faces = []
        for A, B in zip(rings, rings[1:]):
            for j in range(segs):
                j2 = (j + 1) % segs
                if len(A) == 1 and len(B) == 1:
                    continue
                if len(A) == 1:
                    faces.append(bm.faces.new((A[0], B[j], B[j2])))
                elif len(B) == 1:
                    faces.append(bm.faces.new((A[j], B[0], A[j2])))
                else:
                    faces.append(bm.faces.new((A[j], B[j], B[j2], A[j2])))
        return faces

    def box(self, center, size, M=Matrix()):
        m = M @ Matrix.Translation(center) @ Matrix.Diagonal((*size, 1))
        verts = bmesh.ops.create_cube(self.bm, size=1, matrix=m)['verts']
        return list({f for v in verts for f in v.link_faces})

    def ico(self, radius, sub=1, M=Matrix(), rough=0.0):
        verts = bmesh.ops.create_icosphere(self.bm, subdivisions=sub, radius=radius, matrix=M)['verts']
        if rough:
            c = M.translation
            for v in verts:
                v.co = c + (v.co - c) * (1 + random.uniform(-rough, rough))
        return list({f for v in verts for f in v.link_faces})

    def prism(self, pts, y0, y1):
        """An outline in the XZ plane, pulled along Y."""
        bm = self.bm
        a = [bm.verts.new((x, y0, z)) for x, z in pts]
        b = [bm.verts.new((x, y1, z)) for x, z in pts]
        faces = [bm.faces.new(a), bm.faces.new(b[::-1])]
        n = len(pts)
        for i in range(n):
            faces.append(bm.faces.new((a[i], b[i], b[(i + 1) % n], a[(i + 1) % n])))
        return faces

    def star(self, R, r, depth, n=5):
        """A faceted star standing in the XZ plane."""
        bm = self.bm
        rim = []
        for i in range(2 * n):
            a, rad = pi * i / n, (R if i % 2 == 0 else r)
            rim.append(bm.verts.new((rad * sin(a), 0, rad * cos(a))))
        cf, cb = bm.verts.new((0, -depth, 0)), bm.verts.new((0, depth, 0))
        faces = []
        for i in range(2 * n):
            p, q = rim[i], rim[(i + 1) % (2 * n)]
            faces += [bm.faces.new((cf, p, q)), bm.faces.new((cb, q, p))]
        return faces

    # flat shapes in the XY plane
    def ring(self, r0, r1, segs=64, a0=0.0, a1=2 * pi):
        bm, faces, full = self.bm, [], abs(a1 - a0 - 2 * pi) < 1e-6
        n = segs if full else segs + 1
        inner = [bm.verts.new((r0 * cos(a0 + (a1 - a0) * i / segs), r0 * sin(a0 + (a1 - a0) * i / segs), 0)) for i in range(n)]
        outer = [bm.verts.new((r1 * cos(a0 + (a1 - a0) * i / segs), r1 * sin(a0 + (a1 - a0) * i / segs), 0)) for i in range(n)]
        for i in range(segs):
            j = (i + 1) % n
            faces.append(bm.faces.new((inner[i], outer[i], outer[j], inner[j])))
        return faces

    def poly(self, pts):
        return [self.bm.faces.new([self.bm.verts.new((x, y, 0)) for x, y in pts])]

    def line(self, p, q, w):
        p, q = Vector(p), Vector(q)
        d = (q - p).normalized()
        n = Vector((-d.y, d.x)) * w / 2
        return self.poly([p - n, q - n, q + n, p + n])

    def dot(self, c, r, n=6, phase=0.0):
        return self.poly([(c[0] + r * cos(phase + 2 * pi * i / n), c[1] + r * sin(phase + 2 * pi * i / n)) for i in range(n)])

    # ---- the finished object
    def finish(self, name, location):
        bm = self.bm
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        layer = bm.loops.layers.float_color.new('Col')
        for faces, rgb, alpha, lo, mat in self.jobs:
            for f in faces:
                if not f.is_valid:
                    continue
                s = 1.0 if lo is None else lo + (1 - lo) * (0.5 + 0.5 * f.normal.dot(LIGHT))
                f.material_index = mat
                f.smooth = False
                for l in f.loops:
                    c = rgb(l.vert.co) if callable(rgb) else rgb
                    a = alpha(l.vert.co) if callable(alpha) else alpha
                    l[layer] = (c[0] * s, c[1] * s, c[2] * s, a)
        old = bpy.data.objects.get(name)
        if old:
            data = old.data
            bpy.data.objects.remove(old)
            bpy.data.meshes.remove(data)
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        mesh.color_attributes.active_color = mesh.color_attributes['Col']
        mesh.color_attributes.render_color_index = 0
        mesh.materials.append(MAT_SOLID)
        mesh.materials.append(MAT_GLOW)
        ob = bpy.data.objects.new(name, mesh)
        ob.location = location
        COLL.objects.link(ob)
        return ob


def material(name, see_through):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 1.6 if see_through else 1.0
    nt.links.new(attr.outputs['Color'], em.inputs['Color'])
    if see_through:
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mix = nt.nodes.new('ShaderNodeMixShader')
        nt.links.new(attr.outputs['Alpha'], mix.inputs[0])
        nt.links.new(tr.outputs[0], mix.inputs[1])
        nt.links.new(em.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs['Surface'])
        m.surface_render_method = 'BLENDED'
    else:
        nt.links.new(em.outputs[0], out.inputs['Surface'])
    m.use_backface_culling = False
    return m


COLL = bpy.data.collections.get('FX')
if not COLL:
    COLL = bpy.data.collections.new('FX')
    bpy.context.scene.collection.children.link(COLL)
MAT_SOLID = material('fx_solid', False)
MAT_GLOW = material('fx_glow', True)

STEP = 3.0
cell = lambda cx, row: (cx * STEP, 0, -row * STEP)       # upright things: a wall of shelves
floor = lambda cx, row: (cx * STEP, -4 - row * STEP, -9)  # flat things: on the floor in front of it

# ------------------------------------------------------------------ projectiles

TEAL, TEAL_DEEP, MINT = col(0x7fe8d6), col(0x35b8a4), col(0xdcfff7)
ICE, ICE_DEEP, SNOW = col(0xa9d8ff), col(0x4f9fe8), col(0xf2fbff)
YOLK, ORANGE, RED = col(0xfff0a8), col(0xff8a1e), col(0xd9301a)

# Arcane Bolt: a crystal with three splinters circling it and a fading wake
b = Build()
b.paint(b.lathe([(0, 0.56), (0.17, 0.14), (0.12, -0.24), (0, -0.42)], 6, FWD), ramp(1, -0.56, 0.42, MINT, TEAL_DEEP), lo=0.45)
for i in range(3):
    a = 2 * pi * i / 3 + 0.4
    m = FWD @ Matrix.Translation((0.29 * cos(a), 0.29 * sin(a), -0.12)) @ Matrix.Rotation(0.5, 4, 'Z')
    b.paint(b.lathe([(0, 0.2), (0.055, 0.02), (0, -0.14)], 4, m), MINT, lo=0.6)
b.glow(b.lathe([(0.12, -0.2), (0.09, -0.75), (0, -1.7)], 6, FWD), TEAL, ramp(1, 0.2, 1.7, 0.55, 0.0))
b.finish('Arcane', cell(0, 0))

# Frost Bolt: a shard of ice with barbs swept back
b = Build()
b.paint(b.lathe([(0, 0.7), (0.12, 0.28), (0.15, -0.18), (0.07, -0.44), (0, -0.5)], 6, FWD), ramp(1, -0.7, 0.5, SNOW, ICE_DEEP), lo=0.4)
for i in range(3):
    a = 2 * pi * i / 3
    m = FWD @ Matrix.Rotation(a, 4, 'Z') @ Matrix.Translation((0.15, 0, -0.12)) @ Matrix.Rotation(radians(152), 4, 'Y')
    b.paint(b.lathe([(0, 0.36), (0.065, 0.06), (0, -0.1)], 5, m), ramp(1, -0.2, 0.5, SNOW, ICE), lo=0.45)
b.glow(b.lathe([(0.1, -0.3), (0.07, -0.8), (0, -1.6)], 6, FWD), ICE, ramp(1, 0.3, 1.6, 0.5, 0.0))
b.finish('Frost', cell(1, 0))

# Fireball: a white-hot core in a twisting flame
b = Build()
b.paint(b.ico(0.23, 1, Matrix.Translation((0, -0.14, 0)), rough=0.06), YOLK, lo=0.8)
n = 7
tongue = lambda i, j: 1 + (0.26 if j % 2 else -0.2) * i / (n - 1)
b.glow(b.lathe([(0.24, 0.12), (0.34, -0.04), (0.33, -0.3), (0.25, -0.62), (0.15, -0.95), (0.07, -1.25), (0, -1.6)], 8, FWD, tongue, twist=0.22),
       ramp(1, -0.1, 1.3, ORANGE, RED), ramp(1, 0.0, 1.6, 0.95, 0.0))
b.glow(b.lathe([(0.2, 0.0), (0.22, -0.2), (0.13, -0.6), (0, -1.0)], 6, FWD, twist=-0.3), YOLK, ramp(1, 0.0, 1.0, 0.9, 0.0))
b.finish('Fire', cell(2, 0))

# Arrow: shaft, head, three feathers and a streak of light behind it
WOOD, STEEL, FEATHER, STREAK = col(0xc79a62), col(0xf1f5fa), col(0x7fe8d6), col(0xffe9a6)
b = Build()
b.paint(b.lathe([(0, 0.46), (0.022, 0.45), (0.022, -0.5), (0, -0.51)], 5, FWD), WOOD, lo=0.6)
b.paint(b.lathe([(0, 0.76), (0.075, 0.46), (0, 0.42)], 4, FWD), STEEL, lo=0.5)
for i in range(3):
    a = 2 * pi * i / 3 + pi / 2
    u = Vector((cos(a), 0, sin(a)))
    pts = [u * 0.022 + Vector((0, 0.26, 0)), u * 0.1 + Vector((0, 0.36, 0)), u * 0.1 + Vector((0, 0.5, 0)), u * 0.022 + Vector((0, 0.5, 0))]
    b.paint([b.bm.faces.new([b.bm.verts.new(p) for p in pts])], FEATHER, lo=None)
for a in (0, pi / 2):
    u = Vector((cos(a), 0, sin(a))) * 0.045
    pts = [(-u + Vector((0, 0.5, 0))), (u + Vector((0, 0.5, 0))), Vector((0, 2.1, 0))]
    b.glow([b.bm.faces.new([b.bm.verts.new(p) for p in pts])], STREAK, ramp(1, 0.5, 2.1, 0.6, 0.0))
b.finish('Arrow', cell(3, 0))

# Meteor (Inferno): a cracked rock with embers showing through and a tail of fire
ROCK, EMBER = col(0x4a332c), col(0xffa030) * 1.6
b = Build()
rock = b.ico(0.55, 2, rough=0.14)
hot = set(random.sample(rock, len(rock) // 4))
b.paint([f for f in rock if f not in hot], ROCK, lo=0.35)
b.paint(hot, EMBER, lo=0.85)
n = 6
b.glow(b.lathe([(0.52, 0.1), (0.62, -0.25), (0.5, -0.9), (0.3, -1.7), (0.12, -2.4), (0, -3.0)], 8, FWD, lambda i, j: 1 + (0.22 if j % 2 else -0.16) * i / (n - 1), twist=0.25),
       ramp(1, 0.0, 2.6, ORANGE, RED), ramp(1, 0.0, 3.0, 0.85, 0.0))
b.glow(b.lathe([(0.4, -0.2), (0.34, -0.8), (0.14, -1.5), (0, -2.0)], 6, FWD, twist=-0.3), YOLK, ramp(1, 0.2, 2.0, 0.75, 0.0))
b.finish('Meteor', cell(4, 0))

# Trail: a wake for anything that falls or flies; one unit long, one unit across at its head
b = Build()
b.glow(b.lathe([(0.5, 0.0), (0.36, -0.3), (0.16, -0.7), (0, -1.0)], 8, FWD), WHITE, ramp(1, 0.0, 1.0, 0.7, 0.0))
b.finish('Trail', cell(5, 0))

# ------------------------------------------------------------------ strikes

# Slash: the smear a blade leaves, sweeping from left to right across the front; radius 1
b = Build()
N, TM = 28, radians(80)
peak = max((i / N) ** 1.3 * (1 - i / N) ** 0.4 for i in range(N + 1))
rim = []
for i in range(N + 1):
    u = i / N
    th = -TM + 2 * TM * u
    w = max(0.003, 0.34 * u ** 1.3 * (1 - u) ** 0.4 / peak)
    d = Vector((sin(th), -cos(th), 0))
    rim.append((b.bm.verts.new(d * (1 - w)), b.bm.verts.new(d), u))
layer_alpha = {}
faces = []
for (i0, o0, u0), (i1, o1, u1) in zip(rim, rim[1:]):
    faces.append(b.bm.faces.new((i0, o0, o1, i1)))
    for v, a in ((i0, 0.12 * u0), (o0, u0 ** 1.2), (i1, 0.12 * u1), (o1, u1 ** 1.2)):
        layer_alpha[v] = a
by_pos = {tuple(round(c, 5) for c in v.co): a for v, a in layer_alpha.items()}
b.glow(faces, WHITE, lambda co: by_pos[tuple(round(c, 5) for c in co)])
b.finish('Slash', floor(0, 0))

# Impact: the spiked flash of a blow that lands; radius 1
b = Build()
base = b.ico(0.3, 1)
tips = bmesh.ops.poke(b.bm, faces=base)
for i, v in enumerate(tips['verts']):
    v.co = v.co.normalized() * (1.0 if i % 2 == 0 else 0.62)
b.paint(tips['faces'], WHITE, lo=0.55)
b.finish('Impact', cell(0, 1))

# Ice spikes: what a Frost Bolt leaves on the ground under its target
b = Build()
b.paint(b.lathe([(0.17, 0.0), (0.13, 0.5), (0, 1.0)], 6), ramp(2, 0.0, 1.0, ICE_DEEP, SNOW), lo=0.4)
for i in range(5):
    a = 2 * pi * i / 5 + 0.3
    h = random.uniform(0.45, 0.8)
    m = Matrix.Rotation(a, 4, 'Z') @ Matrix.Translation((0.2, 0, 0)) @ Matrix.Rotation(radians(random.uniform(28, 42)), 4, 'Y')
    b.paint(b.lathe([(0.12, -0.1), (0.09, h * 0.5), (0, h)], 5, m), ramp(2, 0.0, 0.7, ICE_DEEP, SNOW), lo=0.4)
b.finish('IceSpikes', cell(1, 1))

# Flame: a standing fire; one unit tall
b = Build()
n = 6
b.glow(b.lathe([(0, 0.0), (0.26, 0.1), (0.34, 0.28), (0.27, 0.5), (0.15, 0.74), (0, 1.0)], 8, Matrix(), lambda i, j: 1 + (0.28 if j % 2 else -0.22) * i / (n - 1), twist=0.3),
       ramp(2, 0.1, 0.9, ORANGE, RED), ramp(2, 0.3, 1.0, 0.95, 0.15))
b.glow(b.lathe([(0, 0.02), (0.17, 0.12), (0.19, 0.28), (0.1, 0.5), (0, 0.7)], 6, Matrix(), twist=-0.35), YOLK, ramp(2, 0.2, 0.7, 0.95, 0.3))
b.finish('Flame', cell(2, 1))

# ------------------------------------------------------------------ glyphs (white: tinted by the game)

b = Build()
b.paint(b.star(0.5, 0.21, 0.13), WHITE, lo=0.5)
b.finish('Star', cell(3, 1))

b = Build()
b.paint(b.box((0, 0, 0), (0.36, 0.11, 0.11)) + b.box((0, 0, 0), (0.11, 0.11, 0.36)), WHITE, lo=0.6)
b.finish('Plus', cell(4, 1))

b = Build()
b.paint(b.prism([(-0.18, 0.22), (0.18, 0.22), (0.18, 0.13), (-0.04, -0.12), (0.18, -0.12), (0.18, -0.22), (-0.18, -0.22), (-0.18, -0.13), (0.04, 0.12), (-0.18, 0.12)], -0.04, 0.04), WHITE, lo=0.6)
b.finish('Zee', cell(5, 1))

# Shield: a heater shield with a raised field and a cross on it; one unit tall
b = Build()
outline = [(-0.4, 0.5), (0.4, 0.5), (0.4, 0.02), (0.29, -0.26), (0, -0.5), (-0.29, -0.26), (-0.4, 0.02)]
b.paint(b.prism(outline, -0.03, 0.05), WHITE, lo=0.5)
inner = [(x * 0.8, (z - 0.04) * 0.8 + 0.04) for x, z in outline]
rim_v = [b.bm.verts.new((x, -0.03, z)) for x, z in [(x * 0.92, (z - 0.04) * 0.92 + 0.04) for x, z in outline]]
top_v = [b.bm.verts.new((x, -0.085, z)) for x, z in inner]
field = [b.bm.faces.new(top_v)]
for i in range(len(outline)):
    j = (i + 1) % len(outline)
    field.append(b.bm.faces.new((rim_v[i], top_v[i], top_v[j], rim_v[j])))
b.paint(field, WHITE * 0.82, lo=0.5)
b.paint(b.box((0, -0.1, 0.06), (0.1, 0.04, 0.5)) + b.box((0, -0.1, 0.14), (0.36, 0.04, 0.1)), WHITE, lo=0.75)
b.finish('Shield', cell(0, 2))

# Sword: point up; one unit tall
b = Build()
flat = Matrix.Diagonal((1, 0.32, 1, 1))
b.paint(b.lathe([(0, 0.5), (0.085, 0.36), (0.085, -0.13), (0, -0.13)], 4, flat, phase=0), WHITE, lo=0.45)
b.paint(b.box((0, 0, -0.16), (0.36, 0.07, 0.06)), WHITE * 0.8, lo=0.55)
b.paint(b.box((0, 0, -0.29), (0.06, 0.05, 0.2)), WHITE * 0.62, lo=0.6)
b.paint(b.lathe([(0, 0.07), (0.07, 0), (0, -0.07)], 4, Matrix.Translation((0, 0, -0.43)) @ flat), WHITE * 0.8, lo=0.5)
b.finish('Sword', cell(1, 2))

# ------------------------------------------------------------------ volumes of light

# Pillar: a column of light, radius 1 and one unit tall, fading upwards
b = Build()
b.glow(b.lathe([(1.0, 0.0), (0.97, 0.35), (0.9, 1.0)], 20), WHITE, ramp(2, 0.0, 1.0, 0.8, 0.0))
b.glow(b.lathe([(0.62, 0.0), (0.58, 0.7)], 12, phase=0.2), WHITE, ramp(2, 0.0, 0.7, 0.55, 0.0))
b.finish('Pillar', cell(2, 2))

# Aura: blades of light standing in a ring of radius 1, with motes above them
b = Build()
for i in range(12):
    a = 2 * pi * i / 12
    h = 1.0 if i % 2 == 0 else 0.62
    c, t = Vector((cos(a), sin(a), 0)), Vector((-sin(a), cos(a), 0))
    pts = [c - t * 0.1, c + t * 0.1, c * 0.97 + t * 0.03 + Vector((0, 0, h * 0.55)), c * 0.94 + Vector((0, 0, h)), c * 0.97 - t * 0.03 + Vector((0, 0, h * 0.55))]
    b.glow([b.bm.faces.new([b.bm.verts.new(p) for p in pts])], WHITE, ramp(2, 0.0, h, 0.9, 0.0))
    if i % 3 == 0:
        m = Matrix.Translation(c * 0.8 + Vector((0, 0, 0.5 + 0.3 * (i % 2)))) @ Matrix.Rotation(a, 4, 'Z')
        b.glow(b.lathe([(0, 0.07), (0.045, 0), (0, -0.07)], 4, m), WHITE, 0.9)
b.finish('Aura', cell(3, 2))

# Dome: a shell of panels, radius 1 (Iron Wall, Blessing of Ward)
b = Build()
steps = [radians(a) for a in (0, 22, 44, 66, 90)]
shell = b.lathe([(cos(a), sin(a)) for a in steps], 12)
for f in shell:
    z = f.calc_center_median().z
    b.glow([f], WHITE * random.uniform(0.75, 1.0), random.uniform(0.2, 0.42) * (1 - 0.45 * z))
edge = b.lathe([(1.0, 0.0), (1.0, 0.045)], 12)
b.glow(edge, WHITE, 0.9)
b.finish('Dome', cell(4, 2))

# ------------------------------------------------------------------ circles on the ground (radius 1, white)

def hexagram(b, r, w):
    for k in (0, 1):
        pts = [(r * cos(pi / 2 + k * pi + 2 * pi * i / 3), r * sin(pi / 2 + k * pi + 2 * pi * i / 3)) for i in range(3)]
        for i in range(3):
            b.glow(b.line(pts[i], pts[(i + 1) % 3], w))

# Arcane (Starfall): two rings, a six-pointed star, runes between the rings
b = Build()
b.glow(b.ring(0.94, 1.0))
b.glow(b.ring(0.79, 0.815))
hexagram(b, 0.79, 0.028)
b.glow(b.ring(0.33, 0.365, 32))
for i in range(12):
    a = 2 * pi * i / 12
    b.glow(b.dot((0.878 * cos(a), 0.878 * sin(a)), 0.04, 4, a))
for i in range(6):
    a = 2 * pi * i / 6
    b.glow(b.dot((0.6 * cos(a), 0.6 * sin(a)), 0.045, 6))
b.finish('CircleArcane', floor(1, 0))

# Heal (Mend, Healing Circle, Resurrection): petals around a cross
b = Build()
b.glow(b.ring(0.94, 1.0))
b.glow(b.ring(0.76, 0.785))
for i in range(8):
    a = 2 * pi * i / 8 + pi / 8
    c, t = Vector((cos(a), sin(a))), Vector((-sin(a), cos(a)))
    b.glow(b.poly([c * 0.36, c * 0.56 + t * 0.085, c * 0.74, c * 0.56 - t * 0.085]))
b.glow(b.poly([(-0.045, -0.2), (0.045, -0.2), (0.045, 0.2), (-0.045, 0.2)]))
b.glow(b.poly([(-0.2, -0.045), (0.2, -0.045), (0.2, 0.045), (-0.2, 0.045)]))
for i in range(4):
    a = pi / 2 * i
    c, t = Vector((cos(a), sin(a))) * 0.865, Vector((-sin(a), cos(a)))
    u = c.normalized()
    b.glow(b.line(c - u * 0.055, c + u * 0.055, 0.03))
    b.glow(b.line(c - t * 0.055, c + t * 0.055, 0.03))
b.finish('CircleHeal', floor(2, 0))

# Fire (Inferno): a wheel of flames turning round a triangle
b = Build()
b.glow(b.ring(0.95, 1.0))
for i in range(18):
    a = 2 * pi * i / 18
    p = lambda r, da: (r * cos(a + da), r * sin(a + da))
    b.glow(b.poly([p(0.93, -0.11), p(0.93, 0.11), p(0.7, 0.24)]))
b.glow(b.ring(0.5, 0.53, 48))
pts = [(0.5 * cos(pi / 2 + 2 * pi * i / 3), 0.5 * sin(pi / 2 + 2 * pi * i / 3)) for i in range(3)]
for i in range(3):
    b.glow(b.line(pts[i], pts[(i + 1) % 3], 0.03))
b.glow(b.ring(0.11, 0.15, 24))
b.finish('CircleFire', floor(3, 0))

# War (War Cry, Provoke): a shockwave with teeth
b = Build()
b.glow(b.ring(0.88, 1.0))
for i in range(12):
    a = 2 * pi * i / 12
    p = lambda r, da: (r * cos(a + da), r * sin(a + da))
    b.glow(b.poly([p(0.99, -0.09), p(0.99, 0.09), p(1.2, 0)]))
b.glow(b.ring(0.62, 0.65))
for i in range(8):
    a = 2 * pi * i / 8 + pi / 8
    p = lambda r, da: (r * cos(a + da), r * sin(a + da))
    b.glow(b.poly([p(0.6, -0.07), p(0.6, 0.07), p(0.3, 0)]))
b.finish('CircleWar', floor(4, 0))

# Aim (Volley): a reticle
b = Build()
b.glow(b.ring(0.95, 1.0))
b.glow(b.ring(0.5, 0.52, 48))
for i in range(4):
    a = pi / 2 * i
    b.glow(b.line((0.66 * cos(a), 0.66 * sin(a)), (0.96 * cos(a), 0.96 * sin(a)), 0.045))
    a += pi / 4
    p = lambda r, da: (r * cos(a + da), r * sin(a + da))
    b.glow(b.poly([p(0.9, -0.05), p(0.9, 0.05), p(0.76, 0)]))
b.glow(b.dot((0, 0), 0.07, 12))
b.finish('CircleAim', floor(5, 0))

# ------------------------------------------------------------------ export

for o in bpy.data.objects:
    o.select_set(o.name in COLL.objects)
out = bpy.path.abspath('//../assets/fx/fx.glb')
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_vertex_color='ACTIVE',
                          export_all_vertex_colors=False, export_active_vertex_color_when_no_material=True,
                          export_normals=False, export_texcoords=False, export_cameras=False, export_lights=False,
                          export_animations=False, export_yup=True)
for o in bpy.data.objects:
    o.select_set(False)
bpy.ops.wm.save_mainfile()
result = {'objects': sorted(o.name for o in COLL.objects), 'file': out}
