# Builds the icon set of the action bar and of the inventory: assets/icons/skills/<skill id>.png for every skill of
# src/shared.js and assets/icons/items/<key>.png for every kind of item (one picture per weapon family, armour slot and
# potion, plus "attack"; the HUD adds the colour of the tier itself). The icons are rendered from the game's own models
# - the weapons, the armour and the cat's head of art/hypercat.blend and the effect shapes of art/fx.blend - plus a few
# props modelled below in the same style (a shield, flasks, an eye, a drop of mana, the arc of a slash, the gold ring
# of the passive skills; the dagger and the greatsword are the Sword reshaped).
#
# Run it from anywhere. It needs no open file, changes and saves neither .blend, and takes about half a minute
# (several minutes when the machine is busy: EEVEE waits for the GPU):
#   /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/build-icons.py
# Options go after a "--":
#   --only power_strike,sword     build only these icons (ids, or "skills/..." / "items/..." paths)
#   --out DIR                     write the set to DIR instead of assets/icons
#   --sheet FILE                  also paste every icon found in the output into one contact sheet (128 px and 48 px)
#
# How an icon is made: its parts are laid out in "tile space" - the picture is the XZ plane seen from -Y, X to the
# right, Z up, the tile reaching from -1 to 1 - and rendered by EEVEE with an orthographic camera on a transparent film
# (every icon is one frame of a single animation, so the renderer starts once). numpy then puts each render on a painted
# ground (a dark field with a glow in the colour of the skill's school), adds a drop shadow, a halo and a little bloom,
# and scales the picture down to 128 px.
#   - model(name, M)        a lit model: sword, greatsword, dagger, bow, arrow, staff, helmet, chest, glove, boot, cathead,
#                           shield, flask_hp_small ..., eye, drop, knob, crescent, ring. Every model is centred on its
#                           bounding box and its largest side is 1. mat=light(colour) makes it a thing of light.
#   - fx(name, M, tint)     an unlit effect shape of art/fx.blend, drawn from its vertex colours "Col" as the game draws
#                           it (rgb times the tint, alpha as the fade). Projectiles point up (+Z) with their tails down,
#                           circles and the slash face the viewer with a diameter of 1 (FLAT lays them on the ground),
#                           the rest stands upright; all are centred like the models.
#   - M is built from T(x, z, y) (y > 0 is further away), R(axis, degrees), S(scale), tilt(degrees) (a turn in the
#     picture plane, clockwise) and thick(k) (fattens a thin thing); GROUND(...) is a floor seen from above.
#
# To add an icon: add one `icon('skills/<id>' or 'items/<key>', style, tint, [parts...])` line below (style: 'skill',
# 'passive' or 'item'), run the script with `--only <id> --sheet <a file outside the repository>`, LOOK at the picture,
# and repeat until it reads at 48 px. A skill of src/shared.js is listed by src/icons.js by itself; a new kind of item
# is added to ITEM_ICONS there (test/icons.test.mjs checks that the list and assets/icons agree).
import bpy, bmesh, sys, os, math, tempfile, shutil, time
import numpy as np
from math import sin, cos, pi, radians
from mathutils import Vector, Matrix

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def option(name, default=None):
    return ARGV[ARGV.index(name) + 1] if name in ARGV else default


OUT = os.path.abspath(option('--out', os.path.join(ROOT, 'assets', 'icons')))
ONLY = [s for s in (option('--only') or '').split(',') if s]
SHEET = option('--sheet')
SIZE = 128          # the side of an icon
SS = 2              # it is rendered this many times larger and scaled down
TMP = tempfile.mkdtemp(prefix='icons-')

# ---------------------------------------------------------------- colours (sRGB hex, as in the game)

MINT, TEAL, GOLD = 0x7fe9c9, 0x35b8a4, 0xf2c14e
C_MELEE, C_RAGE = 0xff8a3c, 0xff4a3a      # physical melee: orange, red
C_ARCHER, C_LEAF = 0xffc85a, 0x9be36a     # archery: amber, green
C_ARCANE = 0x7fe8d6
C_FROST = 0x5cb6ff
C_FIRE = 0xff7a2a
C_HOLY, C_HEAL = 0xffe08a, 0x8ee68e
C_SHADOW = 0xb48cff
C_STEEL = 0x8fb8ff                        # defence
C_BLOOD = 0xff4a4a
C_MANA = 0x5aa8ff
WHITE = 0xffffff


def rgb(h):
    return np.array([(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255], np.float32)


def lin(c):
    return ((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92


def lin_rgb(h):
    return tuple(lin(float(c)) for c in rgb(h))


# ---------------------------------------------------------------- matrices of tile space

def T(x=0.0, z=0.0, y=0.0):
    return Matrix.Translation((x, y, z))


def R(axis, deg):
    return Matrix.Rotation(radians(deg), 4, axis)


def S(*s):
    return Matrix.Diagonal((*(s * 3 if len(s) == 1 else s), 1))


def tilt(deg):
    """A turn in the picture plane: what points up leans to the right by `deg`."""
    return R('Y', deg)


FLAT = R('X', -90)      # lays a circle that faces the viewer on the ground


def GROUND(x=0.0, z=0.0, pitch=28, y=0.0):
    """A floor seen from above: build on it with Z up; FLAT puts a circle on it."""
    return T(x, z, y) @ R('X', pitch)


# ---------------------------------------------------------------- the scene

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = scene.render.resolution_y = SIZE * SS
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '8'
scene.view_settings.view_transform = 'Standard'     # AgX and Filmic grey the colours
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
scene.eevee.taa_render_samples = 16



def node_tree(block):
    """The node tree of a material or a world (Blender 5 always has one; older versions want use_nodes set)."""
    if block.node_tree is None:
        block.use_nodes = True
    return block.node_tree


def principled(mat):
    nt = node_tree(mat)
    p = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if p is None:
        nt.nodes.clear()
        p = nt.nodes.new('ShaderNodeBsdfPrincipled')
        nt.links.new(p.outputs[0], nt.nodes.new('ShaderNodeOutputMaterial').inputs['Surface'])
    return p


cam_data = bpy.data.cameras.new('IconCam')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 2.0
cam_data.clip_start, cam_data.clip_end = 0.1, 60
cam = bpy.data.objects.new('IconCam', cam_data)
cam.location = (0, -20, 0)
cam.rotation_euler = (radians(90), 0, 0)
scene.collection.objects.link(cam)
scene.camera = cam


def sun(name, travel, energy, color=(1, 1, 1), angle=12, shadow=True):
    """A sun whose light travels along `travel`."""
    data = bpy.data.lights.new(name, 'SUN')
    data.energy, data.color, data.angle = energy, color, radians(angle)
    data.use_shadow = shadow
    ob = bpy.data.objects.new(name, data)
    ob.rotation_euler = Vector(travel).normalized().to_track_quat('-Z', 'Y').to_euler()
    scene.collection.objects.link(ob)
    return ob


KEY = sun('Key', (0.55, 0.75, -0.6), 2.6, (1.0, 0.97, 0.9))            # from the upper left, in front
FILL = sun('Fill', (-0.7, 0.6, 0.25), 0.9, (0.6, 0.75, 1.0), shadow=False)   # from the lower right
RIM = sun('Rim', (-0.5, -0.8, -0.45), 2.2, shadow=False)               # from behind: takes the colour of the icon

# the sky the metal mirrors: bright above and to the left, dark below
world = bpy.data.worlds.new('IconWorld')
nt = node_tree(world)
nt.nodes.clear()
w_out = nt.nodes.new('ShaderNodeOutputWorld')
w_bg = nt.nodes.new('ShaderNodeBackground')
w_co = nt.nodes.new('ShaderNodeTexCoord')
w_dot = nt.nodes.new('ShaderNodeVectorMath')
w_dot.operation = 'DOT_PRODUCT'
w_dot.inputs[1].default_value = Vector((-0.6, 0.1, 0.8)).normalized()
w_ramp = nt.nodes.new('ShaderNodeValToRGB')
w_ramp.color_ramp.elements[0].position, w_ramp.color_ramp.elements[0].color = 0.3, (0.03, 0.04, 0.06, 1)
w_ramp.color_ramp.elements[1].position, w_ramp.color_ramp.elements[1].color = 1.0, (0.6, 0.66, 0.78, 1)
w_map = nt.nodes.new('ShaderNodeMapRange')
w_map.inputs['From Min'].default_value, w_map.inputs['From Max'].default_value = -1, 1
nt.links.new(w_co.outputs['Generated'], w_dot.inputs[0])
nt.links.new(w_dot.outputs['Value'], w_map.inputs['Value'])
nt.links.new(w_map.outputs['Result'], w_ramp.inputs['Fac'])
nt.links.new(w_ramp.outputs['Color'], w_bg.inputs['Color'])
w_bg.inputs['Strength'].default_value = 1.0
nt.links.new(w_bg.outputs[0], w_out.inputs['Surface'])
scene.world = world

STAGE = bpy.data.collections.new('Icon')
scene.collection.children.link(STAGE)

# ---------------------------------------------------------------- the game's models


def append(path, names):
    with bpy.data.libraries.load(os.path.join(ROOT, path), link=False) as (src, dst):
        missing = [n for n in names if n not in src.objects]
        if missing:
            raise SystemExit(f'{path} has no object {missing}')
        dst.objects = list(names)
    return dict(zip(names, dst.objects))


HEAD = ['Head', 'Ear.L', 'Ear.R', 'EarInner.L', 'EarInner.R', 'Eye.L', 'Eye.R', 'EyeShine.L', 'EyeShine.R'] + [f'Whisker.{s}.{i}' for s in 'LR' for i in range(3)]
CAT = append('art/hypercat.blend', ['Sword', 'Bow', 'Arrow', 'Staff', 'Armor.Helmet', 'Armor.Chest', 'Armor.Glove.L', 'Armor.Boot.L'] + HEAD)
FX = append('art/fx.blend', ['Arcane', 'Arrow', 'Aura', 'CircleAim', 'CircleArcane', 'CircleFire', 'CircleHeal', 'CircleWar', 'Dome', 'Fire', 'Flame',
                             'Frost', 'IceSpikes', 'Impact', 'Meteor', 'Pillar', 'Plus', 'Shield', 'Slash', 'Star', 'Sword', 'Trail', 'Zee'])

MODELS, SHAPES = {}, {}


def normalised(mesh, name, pre=Matrix(), unit=True):
    """A copy of a mesh turned by `pre`, centred on its bounding box and (unit) scaled so that its largest side is 1."""
    me = mesh.copy()
    me.name = name
    me.transform(pre)
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    lo, hi = co.min(0), co.max(0)
    s = 1.0 / float((hi - lo).max()) if unit else 1.0
    me.transform(Matrix.Diagonal((s, s, s, 1)) @ Matrix.Translation(Vector((lo + hi) / 2) * -1))
    me.update()
    return me


def reshaped(mesh, name, move):
    """A copy of a mesh with every vertex moved by `move(co, names of its materials)`."""
    me = mesh.copy()
    me.name = name
    mats = [set() for _ in me.vertices]
    for p in me.polygons:
        for vi in p.vertices:
            mats[vi].add(me.materials[p.material_index].name)
    for v in me.vertices:
        v.co = move(v.co.copy(), mats[v.index])
    me.update()
    return me


def world_of(ob):
    """Where an appended object stands: it is in no scene, so nothing has worked its matrix_world out."""
    return world_of(ob.parent) @ ob.matrix_parent_inverse @ ob.matrix_basis if ob.parent else ob.matrix_basis.copy()


def joined(name, pieces):
    """One mesh of several: pieces are (mesh, matrix) pairs."""
    bm, mats = bmesh.new(), []
    for mesh, M in pieces:
        tmp = mesh.copy()
        tmp.transform(M)
        remap = []
        for m in tmp.materials:
            if m not in mats:
                mats.append(m)
            remap.append(mats.index(m))
        before = len(bm.faces)
        bm.from_mesh(tmp)
        bm.faces.ensure_lookup_table()
        for f in bm.faces[before:]:
            f.material_index = remap[f.material_index]
        bpy.data.meshes.remove(tmp)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    return me


for key, src in (('sword', 'Sword'), ('bow', 'Bow'), ('arrow', 'Arrow'), ('staff', 'Staff'),
                 ('helmet', 'Armor.Helmet'), ('chest', 'Armor.Chest'), ('glove', 'Armor.Glove.L'), ('boot', 'Armor.Boot.L')):
    MODELS[key] = normalised(CAT[src].data, key)

# The sword's blade starts at z = 0.15, its grip reaches from -0.1 to 0.1 and its pommel hangs below.
BLADE = 0.15


def dagger_move(co, mats):
    if co.z > BLADE:
        co.z = BLADE + (co.z - BLADE) * 0.52
        co.x *= 0.92
    return co


def greatsword_move(co, mats):
    if co.z > BLADE and mats & {'w_steel', 'w_edge', 'w_glow'}:       # a broader, longer blade
        co.z = BLADE + (co.z - BLADE) * 1.12
        co.x *= 2.5
        co.y *= 1.5
    elif co.z > 0.1:                                                  # a wider guard
        co.x *= 1.3
    elif co.z < -0.1:                                                 # a grip for two paws
        co.z -= 0.2
    else:
        co.z = 0.1 + (co.z - 0.1) * 2.0
    return co


MODELS['dagger'] = normalised(reshaped(CAT['Sword'].data, 'dagger.raw', dagger_move), 'dagger')
MODELS['greatsword'] = normalised(reshaped(CAT['Sword'].data, 'greatsword.raw', greatsword_move), 'greatsword')

UP = R('X', -90)        # a projectile flies towards -Y in fx.blend: this points it up
FACE = R('X', 90)       # a ground circle lies in the XY plane: this makes it face the viewer
for key in ('Arcane', 'Frost', 'Fire', 'Arrow', 'Meteor', 'Trail'):
    SHAPES[key] = normalised(FX[key].data, 'fx.' + key, UP)
for key in ('CircleAim', 'CircleArcane', 'CircleFire', 'CircleHeal', 'CircleWar', 'Slash'):
    SHAPES[key] = normalised(FX[key].data, 'fx.' + key, FACE, unit=key == 'Slash')
    if key != 'Slash':      # a circle has radius 1 in the file (the teeth of CircleWar reach further): its diameter is 1 here
        SHAPES[key].transform(Matrix.Diagonal((0.5, 0.5, 0.5, 1)))
for key in ('Aura', 'Dome', 'Flame', 'IceSpikes', 'Pillar', 'Impact', 'Plus', 'Shield', 'Star', 'Sword', 'Zee'):
    SHAPES[key] = normalised(FX[key].data, 'fx.' + key)

# ---------------------------------------------------------------- materials


def pbr(name, base, metal=0.0, rough=0.5, emit=0.0, emit_color=None, alpha=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    p = principled(m)
    if alpha < 1:
        p.inputs['Alpha'].default_value = alpha
        m.surface_render_method = 'BLENDED'
    p.inputs['Base Color'].default_value = (*base, 1)
    p.inputs['Metallic'].default_value = metal
    p.inputs['Roughness'].default_value = rough
    p.inputs['Emission Color'].default_value = (*(emit_color or base), 1)
    p.inputs['Emission Strength'].default_value = emit
    return m


def tune(name, **values):
    """The game's materials are made for its toon shader; a few need help to read on a dark tile."""
    p = principled(bpy.data.materials[name])
    for k, v in values.items():
        p.inputs[k].default_value = v


tune('w_leather', **{'Base Color': (0.11, 0.06, 0.04, 1), 'Roughness': 0.65})
tune('w_wood_dark', **{'Base Color': (0.16, 0.07, 0.03, 1)})
tune('w_glow', **{'Emission Strength': 0.9})
tune('w_steel', **{'Base Color': (0.25, 0.3, 0.38, 1), 'Metallic': 0.35, 'Roughness': 0.4})
tune('w_edge', **{'Base Color': (0.36, 0.4, 0.46, 1), 'Metallic': 0.35, 'Roughness': 0.3})
tune('cat_white', **{'Base Color': (0.4, 0.4, 0.42, 1)})        # the key light is strong: white fur would burn out
head = principled(bpy.data.materials['cat_head'])
for link in list(head.inputs['Base Color'].links):               # the head is painted: its texture is dimmed the same way
    nt = bpy.data.materials['cat_head'].node_tree
    dim = nt.nodes.new('ShaderNodeVectorMath')
    dim.operation = 'SCALE'
    dim.inputs['Scale'].default_value = 0.4
    nt.links.new(link.from_socket, dim.inputs[0])
    nt.links.new(dim.outputs['Vector'], head.inputs['Base Color'])
tune('a_steel', **{'Base Color': (0.36, 0.44, 0.56, 1), 'Roughness': 0.4})

pbr('i_red', lin_rgb(0xe8323c), rough=0.25, emit=0.55)
pbr('i_red_pale', lin_rgb(0xff9a8a), rough=0.2, emit=0.35)
pbr('i_blue', lin_rgb(0x2f7df0), rough=0.25, emit=0.6)
pbr('i_blue_pale', lin_rgb(0x9fd2ff), rough=0.2, emit=0.35)
pbr('i_glass', lin_rgb(0xcfeaf0), rough=0.15, emit=0.12)
pbr('i_white', lin_rgb(0xfff6e6), rough=0.4, emit=0.25)
pbr('i_black', (0.004, 0.004, 0.006), rough=0.3)
pbr('i_amber', lin_rgb(0xffb020), rough=0.3, emit=0.5)
pbr('i_amber_dark', lin_rgb(0xb8540c), rough=0.4, emit=0.3)
pbr('i_shine', (1, 1, 1), rough=0.3, emit=1.0)
pbr('i_ghost', lin_rgb(0x9a7cf0), rough=0.5, emit=0.6, alpha=0.42)
pbr('i_ghost_far', lin_rgb(0x9a7cf0), rough=0.5, emit=0.6, alpha=0.2)
pbr('i_mouth', lin_rgb(0x7a1420), rough=0.6, emit=0.2)



def light(tint, k=1.0):
    """The name of a material that only shines, for a prop made of light."""
    name = f'i_light_{tint:06x}_{int(k * 100)}'
    if name not in bpy.data.materials:
        m = bpy.data.materials.new(name)
        nt = node_tree(m)
        nt.nodes.clear()
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (*lin_rgb(tint), 1)
        em.inputs['Strength'].default_value = k
        nt.links.new(em.outputs[0], nt.nodes.new('ShaderNodeOutputMaterial').inputs['Surface'])
    return name


_fx_mats = {}


def fx_mats(tint, k, kg, fade, sharp):
    """The two materials of an effect shape, as src/fx.js makes them: `Col` times the tint, unlit; the second fades by the alpha of `Col`."""
    key = (tint, round(k, 3), round(kg, 3), round(fade, 3), round(sharp, 3))
    if key in _fx_mats:
        return _fx_mats[key]
    pair = []
    for glow in (False, True):
        m = bpy.data.materials.new(f'fx_{tint:06x}_{len(_fx_mats)}_{int(glow)}')
        nt = node_tree(m)
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        attr = nt.nodes.new('ShaderNodeVertexColor')
        attr.layer_name = 'Col'
        mul = nt.nodes.new('ShaderNodeVectorMath')
        mul.operation = 'MULTIPLY'
        c = lin_rgb(tint)
        s = kg if glow else k
        mul.inputs[1].default_value = (c[0] * s, c[1] * s, c[2] * s)
        em = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(attr.outputs['Color'], mul.inputs[0])
        nt.links.new(mul.outputs['Vector'], em.inputs['Color'])
        if glow:
            tr = nt.nodes.new('ShaderNodeBsdfTransparent')
            mix = nt.nodes.new('ShaderNodeMixShader')
            pw = nt.nodes.new('ShaderNodeMath')
            pw.operation = 'POWER'
            pw.inputs[1].default_value = sharp
            a = nt.nodes.new('ShaderNodeMath')
            a.operation = 'MULTIPLY'
            a.use_clamp = True
            a.inputs[1].default_value = fade
            nt.links.new(attr.outputs['Alpha'], pw.inputs[0])
            nt.links.new(pw.outputs[0], a.inputs[0])
            nt.links.new(a.outputs[0], mix.inputs[0])
            nt.links.new(tr.outputs[0], mix.inputs[1])
            nt.links.new(em.outputs[0], mix.inputs[2])
            nt.links.new(mix.outputs[0], out.inputs['Surface'])
            m.surface_render_method = 'BLENDED'
        else:
            nt.links.new(em.outputs[0], out.inputs['Surface'])
        m.use_backface_culling = False
        pair.append(m)
    _fx_mats[key] = pair
    return pair


# ---------------------------------------------------------------- props modelled here

class Prop:
    """A small low-poly model: faces in the game's materials, flat shaded."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def use(self, faces, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        for f in faces:
            f.material_index = self.mats.index(mat)
        return faces

    def lathe(self, prof, segs, mat, M=Matrix(), phase=0.0):
        """A surface of revolution about +Z. prof: (radius, z) pairs; radius 0 is a tip."""
        bm, rings = self.bm, []
        for r, z in prof:
            if r < 1e-6:
                rings.append([bm.verts.new(M @ Vector((0, 0, z)))])
            else:
                rings.append([bm.verts.new(M @ Vector((r * cos(phase + 2 * pi * j / segs), r * sin(phase + 2 * pi * j / segs), z))) for j in range(segs)])
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
        return self.use(faces, mat)

    def prism(self, pts, y0, y1, mat):
        """An outline in the XZ plane, pulled along Y."""
        bm = self.bm
        a = [bm.verts.new((x, y0, z)) for x, z in pts]
        b = [bm.verts.new((x, y1, z)) for x, z in pts]
        faces = [bm.faces.new(a), bm.faces.new(b[::-1])]
        n = len(pts)
        for i in range(n):
            faces.append(bm.faces.new((a[i], b[i], b[(i + 1) % n], a[(i + 1) % n])))
        return self.use(faces, mat)

    def fan(self, pts, y, apex, mat):
        """An outline in the XZ plane at depth y, closed by triangles to an apex (x, y, z): a faceted bulge."""
        bm = self.bm
        rim = [bm.verts.new((x, y, z)) for x, z in pts]
        top = bm.verts.new(apex)
        return self.use([bm.faces.new((rim[i], rim[(i + 1) % len(rim)], top)) for i in range(len(rim))], mat)

    def finish(self, name, unit=True):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name + '.raw')
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(bpy.data.materials[m])
        MODELS[name] = normalised(me, name, unit=unit)


FRONT = R('X', 90)      # turns a lathe built about +Z to bulge towards the viewer

# A heater shield: a gold rim, a steel field that rises to a ridge, a gold boss with a mint stone.
p = Prop()
outline = [(-0.42, 0.5), (-0.14, 0.455), (0.14, 0.455), (0.42, 0.5), (0.43, 0.06), (0.33, -0.24), (0.17, -0.42), (0, -0.54), (-0.17, -0.42), (-0.33, -0.24), (-0.43, 0.06)]
p.prism(outline, 0.05, -0.05, 'w_gold')
inner = [(x * 0.84, (z - 0.02) * 0.84 + 0.02) for x, z in outline]
p.fan(inner, -0.05, (0, -0.2, 0.06), 'a_steel')
p.prism([(-0.035, 0.37), (0.035, 0.37), (0.035, -0.36), (0, -0.42), (-0.035, -0.36)], -0.03, -0.17, 'w_gold')      # a gold pale down the ridge
p.lathe([(0.17, 0.0), (0.15, 0.07), (0.08, 0.12), (0, 0.13)], 8, 'w_gold', T(0, 0.06, -0.14) @ FRONT, phase=pi / 8)
p.lathe([(0.065, 0.0), (0, 0.06)], 6, 'w_glow', T(0, 0.06, -0.255) @ FRONT)
for sx, sz in ((-0.27, 0.34), (0.27, 0.34), (-0.26, -0.08), (0.26, -0.08)):
    p.lathe([(0.035, 0.0), (0, 0.03)], 6, 'w_gold', T(sx, sz, -0.1) @ FRONT)
p.finish('shield')


def flask(body, neck_r, liquid, pale, collar, level, shine):
    """A flask: the body is a profile of (radius, z); it is full of liquid up to `level`."""
    p = Prop()
    below = [q for q in body if q[1] <= level]
    above = [q for q in body if q[1] > level]
    p.lathe(below, 10, liquid)
    p.lathe([below[-1]] + above, 10, pale)
    top = body[-1][1]
    p.lathe([(neck_r, top), (neck_r, top + 0.16)], 10, 'i_glass')
    p.lathe([(neck_r + 0.045, top - 0.02), (neck_r + 0.055, top + 0.02), (neck_r + 0.045, top + 0.06), (neck_r, top + 0.06)], 10, collar)
    p.lathe([(neck_r + 0.04, top + 0.14), (neck_r + 0.04, top + 0.19), (neck_r, top + 0.19)], 10, 'i_glass')
    p.lathe([(neck_r * 0.8, top + 0.16), (neck_r * 0.95, top + 0.3), (0, top + 0.31)], 8, 'w_wood')
    p.lathe([(0.05, 0.0), (0, 0.004)], 6, 'i_shine', T(*shine, -0.45) @ FRONT @ S(1, 2.0, 1))      # the glint of the glass
    return p


ROUND = [(0, -0.5), (0.2, -0.46), (0.34, -0.34), (0.4, -0.16), (0.38, 0.0), (0.3, 0.14), (0.18, 0.22), (0.12, 0.25)]
CONE = [(0, -0.4), (0.26, -0.38), (0.31, -0.3), (0.26, -0.14), (0.16, 0.08), (0.1, 0.2)]
for name, liquid, pale in (('hp', 'i_red', 'i_red_pale'), ('mp', 'i_blue', 'i_blue_pale')):
    flask(ROUND, 0.12, liquid, pale, 'w_gold', 0.0, (-0.2, -0.02)).finish(f'flask_{name}_large')
    flask(CONE, 0.1, liquid, pale, 'w_leather', -0.14, (-0.13, -0.24)).finish(f'flask_{name}_small')

# An eye (Eagle Eye): gold lids, an amber iris, a round pupil.
p = Prop()
N = 10
lid = [(-0.5 + i / N, 0.27 * (1 - (2 * i / N - 1) ** 2) ** 0.85) for i in range(N + 1)] + [(0.5 - i / N, -0.21 * (1 - (2 * i / N - 1) ** 2) ** 0.85) for i in range(1, N)]
p.prism([(x * 1.16, z * 1.28 + 0.008) for x, z in lid], 0.03, -0.02, 'w_gold')
p.fan(lid, -0.02, (0, -0.1, 0.03), 'i_white')
p.lathe([(0.2, 0.0), (0.165, 0.03), (0, 0.045)], 12, 'i_amber', T(0, 0.03, -0.085) @ FRONT)
p.lathe([(0.205, 0.0), (0.2, 0.012), (0.165, 0.032)], 12, 'i_amber_dark', T(0, 0.03, -0.086) @ FRONT)
p.lathe([(0.085, 0.0), (0, 0.01)], 10, 'i_black', T(0, 0.03, -0.135) @ FRONT)
p.lathe([(0.04, 0.0), (0, 0.005)], 6, 'i_shine', T(-0.07, 0.1, -0.15) @ FRONT)
p.finish('eye')

# A drop of mana (Mana Mastery).
p = Prop()
p.lathe([(0, 0.52), (0.09, 0.3), (0.24, 0.02), (0.33, -0.2), (0.3, -0.37), (0.17, -0.48), (0, -0.52)], 8, 'i_blue', phase=pi / 8)
p.lathe([(0.05, 0.0), (0, 0.01)], 5, 'i_shine', T(-0.13, -0.12, -0.31) @ FRONT @ S(1, 1.9, 1))
p.finish('drop')

# A knob of leather: the thumb the icon gives the mitten, which is a ball on a cuff in the game.
p = Prop()
p.lathe([(0, 0.5), (0.3, 0.38), (0.48, 0.12), (0.48, -0.12), (0.3, -0.38), (0, -0.5)], 10, 'w_leather')
for f in p.bm.faces:
    f.smooth = True
p.finish('knob')

# The arc a blade leaves (Power Strike, Rend): a lune that faces the viewer, bulging upwards, heavier towards its right
# end - where the cut lands. The game's own Slash is a soft smear; an icon wants a stroke.
p = Prop()
N, HALF = 24, radians(80)
rim = []
for i in range(N + 1):
    t = 2 * i / N - 1
    w = 0.3 * (1 - t * t) ** 0.85 * (0.6 + 0.4 * (t + 1) / 2)
    d = Vector((sin(t * HALF), 0, cos(t * HALF)))
    rim.append((p.bm.verts.new(d * (1 - w)), p.bm.verts.new(d)))
p.use([p.bm.faces.new((a0, b0, b1, a1)) for (a0, b0), (a1, b1) in zip(rim, rim[1:])], 'i_shine')
p.finish('crescent')

# The cat's own head, roaring (War Cry): the head of art/hypercat.blend with an open mouth and a frown.
p = Prop()
oval = lambda cx, cz, rx, rz, n=12: [(cx + rx * cos(2 * pi * i / n), cz + rz * sin(2 * pi * i / n)) for i in range(n)]
p.prism(oval(0, 0.89, 0.12, 0.085), -0.36, -0.455, 'i_mouth')
p.prism(oval(0, 0.845, 0.075, 0.035), -0.36, -0.462, 'cat_pink')
for sx in (-1, 1):
    p.prism([(sx * 0.085, 0.965), (sx * 0.035, 0.965), (sx * 0.06, 0.9)], -0.36, -0.468, 'i_white')                      # fangs
    p.prism([(sx * 0.3, 1.215), (sx * 0.31, 1.175), (sx * 0.1, 1.125), (sx * 0.09, 1.165)], -0.3, -0.47, 'cat_line')    # brows
mouth = bpy.data.meshes.new('roar.raw')
bmesh.ops.recalc_face_normals(p.bm, faces=p.bm.faces)
p.bm.to_mesh(mouth)
p.bm.free()
for m in p.mats:
    mouth.materials.append(bpy.data.materials[m])
MODELS['cathead'] = normalised(joined('cathead.raw', [(CAT[n].data, world_of(CAT[n])) for n in HEAD] + [(mouth, Matrix())]), 'cathead')

# The ring of a passive skill: a bevelled gold band that faces the viewer, radius 1.
p = Prop()
p.lathe([(0.86, 0.0), (0.885, 0.05), (0.96, 0.05), (1.0, 0.0), (0.86, 0.0)], 48, 'w_gold', FRONT)
p.finish('ring', unit=False)

# ---------------------------------------------------------------- the parts of an icon


def model(name, M=Matrix(), mat=None):
    """A lit model. mat: one material for all of it (a thing made of light, a shadow)."""
    return ('model', name, M, {'mat': mat})


def fx(name, M=Matrix(), tint=WHITE, k=1.0, kg=1.15, fade=1.0, sharp=1.0):
    """An effect shape. k / kg: the brightness of its solid / of its see-through parts. The opacity of the latter is
    fade * alpha ** sharp: a sharp above 1 turns a soft smear into a crisp stroke."""
    return ('fx', name, M, {'tint': tint, 'k': k, 'kg': kg, 'fade': fade, 'sharp': sharp})


def stage(parts, frame):
    """Puts the parts of an icon on the stage for one frame of the animation that renders the set."""
    for i, (kind, name, M, o) in enumerate(parts):
        ob = bpy.data.objects.new(f'f{frame}.{i}', MODELS[name] if kind == 'model' else SHAPES[name])
        ob.matrix_world = M
        STAGE.objects.link(ob)
        mats = fx_mats(o['tint'], o['k'], o['kg'], o['fade'], o['sharp']) if kind == 'fx' else None
        for slot in ob.material_slots:
            if kind == 'fx':
                glow = slot.material.name.startswith('fx_glow')
                slot.link = 'OBJECT'
                slot.material = mats[1 if glow else 0]
            elif o['mat']:
                slot.link = 'OBJECT'
                slot.material = bpy.data.materials[o['mat']]
        for f, hidden in ((frame - 1, True), (frame, False), (frame + 1, True)):
            ob.hide_render = hidden
            ob.keyframe_insert('hide_render', frame=f)


# ---------------------------------------------------------------- painting (numpy, sRGB values, row 0 at the top)


def blur(a, sigma):
    """A Gaussian blur. A wide one is done on a smaller copy of the picture: it has no detail to lose."""
    if sigma <= 0:
        return a
    k = 1
    while sigma / k > 3 and k < 8 and a.shape[0] % (k * 2) == 0:
        k *= 2
    if k > 1:
        small = blur(shrink(a, k), sigma / k)
        return blur(np.repeat(np.repeat(small, k, axis=0), k, axis=1), k * 0.6)
    r = int(sigma * 3) + 1
    w = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2).astype(np.float32)
    w /= w.sum()
    n = a.shape[0]
    p = np.pad(a, ((r, r), (0, 0), (0, 0)), mode='edge')
    a = sum(w[i] * p[i:i + n] for i in range(2 * r + 1))
    n = a.shape[1]
    p = np.pad(a, ((0, 0), (r, r), (0, 0)), mode='edge')
    return sum(w[i] * p[:, i:i + n] for i in range(2 * r + 1))


def smooth(lo, hi, x):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


N = SIZE * SS
_y, _x = np.mgrid[0:N, 0:N].astype(np.float32)
PX = (_x + 0.5) / N * 2 - 1        # tile space: -1 left .. 1 right
PZ = 1 - (_y + 0.5) / N * 2        # 1 top .. -1 bottom


def ground(style, tint, glow=(0.0, 0.0), spread=1.0):
    """The painted ground of a tile."""
    t = rgb(tint)
    r = np.hypot(PX - glow[0], PZ - glow[1])[..., None]
    rc = np.hypot(PX, PZ)[..., None]
    sheen = ((PZ - PX) * 0.5)[..., None]                  # 1 in the upper left corner, -1 in the lower right
    if style == 'skill':
        dark = t * 0.11 + np.array([0.02, 0.025, 0.035], np.float32)
        g = np.exp(-(r / (0.8 * spread)) ** 2)
        out = dark + (t * 0.5 - dark) * g + t * 0.05 * sheen
        out *= 1 - 0.5 * smooth(0.75, 1.5, rc)
    elif style == 'passive':
        slate = np.array([0.055, 0.065, 0.085], np.float32)
        inside = 1 - smooth(0.84, 0.9, rc)
        disc = slate + t * 0.26 * np.exp(-(r / 0.7) ** 2) + t * 0.03
        outside = slate * 0.7 + rgb(GOLD) * 0.035 * (1 + sheen)
        out = outside + (disc - outside) * inside
    else:   # item: neutral dark teal, so that the colour of the tier reads
        dark = np.array([0.045, 0.105, 0.115], np.float32)
        g = np.exp(-(r / 0.95) ** 2)
        out = dark + (np.array([0.13, 0.27, 0.27], np.float32) - dark) * g + rgb(MINT) * 0.025 * sheen
        out *= 1 - 0.42 * smooth(0.8, 1.5, rc)
    return np.clip(out, 0, 1).astype(np.float32)


def read_png(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[::-1].copy()


def write_png(path, px):
    """px: rows from the top, RGB or RGBA floats in sRGB."""
    h, w = px.shape[:2]
    if px.shape[2] == 3:
        px = np.concatenate([px, np.ones((h, w, 1), np.float32)], axis=2)
    img = bpy.data.images.new('out', w, h, alpha=True)
    img.pixels.foreach_set(np.clip(px[::-1], 0, 1).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def shrink(px, k):
    h, w, c = px.shape
    return px.reshape(h // k, k, w // k, k, c).mean(axis=(1, 3))


def compose(render, style, tint, o):
    a = render[..., 3:]
    col = render[..., :3]
    out = ground(style, tint, o.get('glow', (0.0, 0.0)), o.get('spread', 1.0))
    t = rgb(tint)
    px = N / 128.0
    # a halo in the colour of the icon, then the shadow the subject drops to the lower right
    out = out + t * blur(a, 9 * px) * o.get('halo', 0.22)
    solid = smooth(0.55, 0.95, a)                      # light does not drop a shadow: only what is opaque does
    shadow = blur(np.roll(solid, (int(3 * px), int(2 * px)), axis=(0, 1)), 2.5 * px)
    out = out * (1 - o.get('shadow', 0.55) * shadow)
    out = out * (1 - a) + col * a
    # bloom: what is bright spills a little light
    luma = (col * np.array([0.3, 0.55, 0.15], np.float32)).sum(axis=2, keepdims=True)
    bright = col * a * smooth(0.55, 0.95, luma)
    out = out + blur(bright, 3 * px) * o.get('bloom', 0.35) + blur(bright, 10 * px) * o.get('bloom', 0.35) * 0.6
    # the tile itself: darker towards its edge
    edge = np.maximum(np.abs(PX), np.abs(PZ))[..., None]
    out = out * (1 - 0.3 * smooth(0.86, 1.0, edge))
    return shrink(np.clip(out, 0, 1), SS)


# ---------------------------------------------------------------- the icons

ICONS = {}
GROUP = ['']


def group(name):
    """The icons that follow belong together: the contact sheet gives each group a row."""
    GROUP[0] = name



def icon(path, style, tint, parts, **o):
    """style: 'skill' (a scene on a glowing ground), 'passive' (an emblem in a gold ring) or 'item' (the thing on dark teal).
    Options: glow=(x, z) centre of the ground's glow, spread, halo, shadow, bloom, rim (colour of the back light)."""
    if style == 'passive':
        parts = [model('ring', T(0, 0, 1.2) @ S(0.93))] + list(parts)
    ICONS[path] = (style, tint, list(parts), o, GROUP[0])


def thick(k):
    """Fattens a thin shape (an arrow) so that it reads on a small tile; its length stays."""
    return S(k, k, 1)


# ---- items: the thing itself, three-quarter view

group('items')

Q = R('Z', -28)     # a quarter turn towards the light
icon('items/sword', 'item', MINT, [model('sword', tilt(45) @ Q @ S(2.35))])
icon('items/greatsword', 'item', MINT, [model('greatsword', T(0.02, -0.02) @ tilt(-32) @ R('Z', 20) @ S(2.25))])
icon('items/daggers', 'item', MINT, [
    model('dagger', T(0.0, 0.0, 0.1) @ tilt(40) @ Q @ S(1.9)),
    model('dagger', T(0.0, 0.0, -0.1) @ tilt(-40) @ R('Z', 28) @ S(1.9)),
])
BOW = tilt(-45)      # the bow is drawn towards the lower left, the arrow points to the upper right
icon('items/bow', 'item', MINT, [
    model('bow', T(0.1, -0.1) @ BOW @ R('Z', -90) @ S(2.5, 2.5, 2.1)),
    model('arrow', T(-0.06, 0.06, -0.3) @ BOW @ tilt(90) @ thick(2.2) @ S(1.95)),
])
icon('items/staff', 'item', MINT, [model('staff', T(-0.9, -1.3) @ tilt(35) @ Q @ S(4.3))])
icon('items/shield', 'item', MINT, [model('shield', R('X', 8) @ R('Z', -28) @ S(1.66))])
icon('items/head', 'item', MINT, [model('helmet', R('X', 20) @ R('Z', -30) @ S(1.8))])
icon('items/body', 'item', MINT, [model('chest', R('X', 8) @ R('Z', -25) @ S(1.7))])
icon('items/hands', 'item', MINT, [
    model('glove', T(0.1, 0.0) @ tilt(-160) @ R('Z', 110) @ S(1.55)),
    model('knob', T(-0.5, 0.2, 0.1) @ tilt(-40) @ S(0.4, 0.4, 0.62)),
])
icon('items/feet', 'item', MINT, [model('boot', T(0, -0.04) @ R('X', 12) @ R('Z', 60) @ S(1.6))])
icon('items/hp_small', 'item', MINT, [model('flask_hp_small', tilt(12) @ S(1.35))], rim=C_BLOOD)
icon('items/hp_large', 'item', MINT, [model('flask_hp_large', tilt(12) @ S(1.7))], rim=C_BLOOD)
icon('items/mp_small', 'item', MINT, [model('flask_mp_small', tilt(12) @ S(1.35))], rim=C_MANA)
icon('items/mp_large', 'item', MINT, [model('flask_mp_large', tilt(12) @ S(1.7))], rim=C_MANA)
icon('items/attack', 'skill', C_MELEE, [
    model('sword', T(0, 0, 0.1) @ tilt(42) @ Q @ S(2.2)),
    model('sword', T(0, 0, -0.1) @ tilt(-42) @ R('Z', 28) @ S(2.2)),
])

# ---- skills. Actives are scenes on a ground that glows in the colour of their school; passives are emblems in a gold ring.

# Fighter: warm steel, orange and red
group('fighter')
icon('skills/power_strike', 'skill', C_MELEE, [
    model('crescent', T(0.2, -0.2, 0.2) @ tilt(135) @ S(1.95), mat=light(0xffb24a)),
    model('crescent', T(0.23, -0.23, 0.1) @ tilt(135) @ S(1.8), mat=light(0xffedb8)),
    model('sword', T(-0.1, 0.08) @ tilt(45) @ Q @ S(2.1)),
])
icon('skills/weapon_mastery', 'passive', C_MELEE, [model('sword', tilt(45) @ Q @ S(1.95))])
icon('skills/stun_strike', 'skill', C_MELEE, [
    model('sword', T(-0.16, 0.16) @ tilt(135) @ Q @ S(1.8)),
    fx('Impact', T(0.38, -0.42, -0.3) @ S(1.0), 0xfff2c0, k=1.05),
    fx('Star', T(-0.62, -0.5, -0.3) @ tilt(-20) @ S(0.5), GOLD, k=1.15),
    fx('Star', T(0.62, 0.5, -0.3) @ tilt(15) @ S(0.62), GOLD, k=1.15),
    fx('Star', T(0.1, 0.72, -0.3) @ tilt(-10) @ S(0.4), GOLD, k=1.15),
])
icon('skills/war_cry', 'skill', C_RAGE, [
    fx('CircleWar', T(0, -0.1, 1.0) @ S(2.5), C_RAGE, kg=0.9, fade=0.5),
    fx('CircleWar', T(0, -0.1, 0.8) @ S(1.65), C_MELEE, kg=1.3),
    model('cathead', T(0, -0.06) @ R('X', 4) @ R('Z', -12) @ S(1.5)),
])
icon('skills/armor_mastery', 'passive', C_STEEL, [model('chest', R('X', 10) @ R('Z', -25) @ S(1.3))])

# Mystic: mint for the arcane, ice blue, green and gold for healing
group('mystic')
icon('skills/bolt', 'skill', C_ARCANE, [fx('Arcane', T(-0.38, -0.38) @ tilt(45) @ thick(2.0) @ S(2.3), WHITE, k=1.15, kg=1.5)])
icon('skills/mend', 'skill', C_HEAL, [
    fx('CircleHeal', T(0, 0, 0.6) @ S(1.8), C_HEAL, kg=0.9, fade=0.7),
    fx('Plus', T(0, 0, -0.2) @ S(1.1), 0xc4ffbc, k=0.95),
])
icon('skills/frost_bolt', 'skill', C_FROST, [
    fx('Frost', T(0.25, 0.25) @ tilt(-135) @ thick(1.9) @ S(2.3), WHITE, k=1.3, kg=1.5),
    fx('Star', T(0.5, -0.48, -0.3) @ tilt(10) @ S(0.3), 0xe4f4ff, k=1.1),
    fx('Star', T(-0.62, 0.5, -0.3) @ tilt(-15) @ S(0.24), 0xe4f4ff, k=1.1),
])
icon('skills/starfall', 'skill', C_HOLY, [
    fx('CircleArcane', GROUND(0, -0.62, 24) @ FLAT @ S(1.8), GOLD, kg=1.1),
    fx('Trail', T(-0.22, 0.42, 0.2) @ tilt(135) @ S(0.55, 0.55, 1.5), C_HOLY, kg=1.0),
    fx('Star', T(0.12, 0.08, -0.2) @ tilt(15) @ S(0.95), C_HOLY, k=1.15),
    fx('Trail', T(0.55, 0.7, 0.3) @ tilt(135) @ S(0.25, 0.25, 0.8), C_HOLY, kg=0.9),
    fx('Star', T(0.7, 0.52, -0.1) @ S(0.4), C_HOLY, k=1.1),
    fx('Trail', T(-0.72, 0.1, 0.3) @ tilt(135) @ S(0.22, 0.22, 0.7), C_HOLY, kg=0.9),
    fx('Star', T(-0.58, -0.06, -0.1) @ S(0.34), C_HOLY, k=1.1),
])
icon('skills/mana_mastery', 'passive', C_MANA, [model('drop', T(0, 0.02) @ S(1.25))])

# Knight: steel blue for defence, red for the taunt
group('knight')
icon('skills/provoke', 'skill', C_RAGE, [
    fx('CircleWar', T(0, 0, 0.5) @ S(1.55), C_RAGE, kg=1.3),
    fx('Impact', T(0, 0, -0.2) @ S(1.0), 0xffd0b0, k=1.05),
])
icon('skills/shield_bash', 'skill', C_STEEL, [
    model('shield', T(-0.2, -0.02) @ tilt(-12) @ R('Z', 35) @ S(1.42)),
    fx('Impact', T(0.52, 0.12, -0.5) @ S(1.0), 0xd8e8ff, k=0.98),
    fx('Star', T(0.62, -0.62, -0.5) @ tilt(20) @ S(0.36), GOLD, k=1.15),
])
WALL = R('Z', -16)
icon('skills/iron_wall', 'skill', C_STEEL, [
    fx('Dome', GROUND(0, -0.9, 10, 1.0) @ S(2.1, 2.1, 3.7), C_STEEL, kg=1.5, fade=0.8),
    model('shield', T(-0.5, 0.0, 0.3) @ WALL @ S(1.05)),
    model('shield', T(0.52, 0.0, 0.3) @ WALL @ S(1.05)),
    model('shield', T(0.0, -0.1, -0.3) @ WALL @ S(1.3)),
])
icon('skills/shield_mastery', 'passive', C_STEEL, [model('shield', T(0, 0.0) @ R('Z', -20) @ S(1.28))])

# Rogue: violet shadow, red blood
group('rogue')
icon('skills/backstab', 'skill', C_SHADOW, [
    fx('Trail', T(0.3, 0.3, 0.3) @ tilt(-135) @ S(0.6, 0.6, 1.9), C_SHADOW, kg=1.1),
    model('dagger', T(-0.1, -0.1) @ tilt(-135) @ Q @ S(1.9)),
    fx('Impact', T(-0.66, -0.66, -0.4) @ S(0.55), 0xe6d8ff, k=1.05),
])
STEP = tilt(18) @ R('Z', 90)
icon('skills/shadow_step', 'skill', C_SHADOW, [
    fx('Trail', T(-0.3, 0.52, 0.5) @ tilt(90) @ S(0.14, 0.14, 1.3), 0xd6c2ff, kg=1.3),
    fx('Trail', T(-0.42, -0.62, 0.5) @ tilt(90) @ S(0.14, 0.14, 1.1), 0xd6c2ff, kg=1.3),
    model('boot', T(-0.52, -0.05, 0.4) @ STEP @ S(0.85), mat='i_ghost_far'),
    model('boot', T(-0.12, -0.03, 0.2) @ STEP @ S(0.98), mat='i_ghost'),
    model('boot', T(0.36, 0.0, -0.2) @ STEP @ S(1.12)),
])
CLAW = tilt(132)


def claw(x, z, size):
    """One mark of Rend: a red stroke with a hot core."""
    return [model('crescent', T(x, z, 0.1) @ CLAW @ S(size, 1, size * 0.8), mat=light(0xe8242c)),
            model('crescent', T(x + 0.025, z - 0.025, 0.0) @ CLAW @ S(size * 0.88, 1, size * 0.62), mat=light(0xffa08a))]


icon('skills/rend', 'skill', C_BLOOD, claw(-0.34, 0.34, 1.7) + claw(0.02, -0.02, 2.0) + claw(0.38, -0.38, 1.7))
icon('skills/crit_mastery', 'passive', C_SHADOW, [
    model('dagger', T(0, -0.05, 0.1) @ tilt(40) @ Q @ S(1.3)),
    model('dagger', T(0, -0.05, -0.1) @ tilt(-40) @ R('Z', 28) @ S(1.3)),
    fx('Impact', T(0, 0.42, -0.4) @ S(0.5), 0xfff2c0, k=1.05),
])

# Archer: amber and green
group('archer')
icon('skills/power_shot', 'skill', C_ARCHER, [
    fx('Trail', T(-0.3, -0.3, 0.3) @ tilt(45) @ S(0.5, 0.5, 1.6), C_ARCHER, kg=1.0),
    fx('Arrow', T(-0.1, -0.1) @ tilt(45) @ thick(2.6) @ S(2.6), WHITE, k=1.05, kg=1.3),
    fx('Impact', T(0.54, 0.54, 0.2) @ S(0.6), 0xfff2c0, k=1.0),
])
icon('skills/volley', 'skill', C_ARCHER, [
    fx('CircleAim', GROUND(0, -0.66, 24) @ FLAT @ S(1.8), C_ARCHER, kg=1.1),
    fx('Arrow', T(-0.5, 0.25) @ tilt(160) @ thick(2.6) @ S(1.6), WHITE, k=1.05, kg=1.2),
    fx('Arrow', T(0.02, 0.1, -0.2) @ tilt(160) @ thick(2.6) @ S(1.9), WHITE, k=1.05, kg=1.2),
    fx('Arrow', T(0.52, 0.3, 0.1) @ tilt(160) @ thick(2.6) @ S(1.6), WHITE, k=1.05, kg=1.2),
])
icon('skills/pinning_shot', 'skill', C_LEAF, [
    fx('IceSpikes', T(0.0, -0.5, 0.0) @ R('X', 15) @ S(1.25), WHITE, k=1.05),
    model('arrow', T(0.08, 0.1, 0.1) @ tilt(165) @ thick(2.3) @ S(1.4)),
])
icon('skills/eagle_eye', 'passive', C_ARCHER, [
    fx('CircleAim', T(0, 0, 0.6) @ S(1.5), C_ARCHER, kg=0.8, fade=0.6),
    model('eye', T(0, 0, 0) @ S(1.3)),
])

# Wizard: fire, and violet for sleep
group('wizard')
icon('skills/fireball', 'skill', C_FIRE, [fx('Fire', T(0.14, 0.14) @ tilt(-135) @ S(2.5), WHITE, k=1.0, kg=1.15)])
icon('skills/inferno', 'skill', C_FIRE, [
    fx('CircleFire', GROUND(0, -0.62, 26) @ FLAT @ S(1.85), C_FIRE, kg=1.2),
    fx('Flame', T(-0.5, -0.5, 0.1) @ S(0.85), WHITE, kg=1.1),
    fx('Flame', T(0.52, -0.42, 0.1) @ S(0.95), WHITE, kg=1.1),
    fx('Flame', T(0, -0.02, -0.2) @ S(1.55), WHITE, kg=1.1),
])
icon('skills/slumber', 'skill', C_SHADOW, [
    fx('CircleArcane', T(0, 0, 0.6) @ S(1.8), C_SHADOW, kg=0.8, fade=0.55),
    fx('Zee', T(-0.42, -0.42, 0) @ tilt(-12) @ S(0.62), 0xe2d2ff, k=1.05),
    fx('Zee', T(0.05, 0.02, 0) @ tilt(-12) @ S(0.8), 0xe2d2ff, k=1.05),
    fx('Zee', T(0.5, 0.52, 0) @ tilt(-12) @ S(0.56), 0xe2d2ff, k=1.05),
])
icon('skills/spell_mastery', 'passive', C_FIRE, [model('staff', T(-0.82, -1.19) @ tilt(35) @ Q @ S(4.0))])

# Cleric: gold and green
group('cleric')
icon('skills/healing_circle', 'skill', C_HEAL, [
    fx('CircleHeal', GROUND(0, -0.5, 30) @ FLAT @ S(1.85), C_HEAL, kg=1.15),
    fx('Aura', GROUND(0, -0.5, 30) @ S(0.9, 0.9, 1.8), C_HEAL, kg=0.9, fade=0.7),
    fx('Plus', T(-0.5, 0.3, -0.3) @ S(0.5), 0xd8ffd0, k=1.05),
    fx('Plus', T(0.05, 0.55, -0.3) @ S(0.62), 0xd8ffd0, k=1.05),
    fx('Plus', T(0.55, 0.15, -0.3) @ S(0.42), 0xd8ffd0, k=1.05),
])
icon('skills/blessing_might', 'skill', C_HOLY, [
    fx('CircleArcane', GROUND(0, -0.72, 22) @ FLAT @ S(1.7), GOLD, kg=1.1),
    fx('Pillar', GROUND(0, -0.72, 8, 0.4) @ S(1.05, 1.05, 4.4), 0xffd060, kg=1.0, fade=0.6),
    model('sword', T(0, 0.08, -0.2) @ Q @ S(1.85)),
])
icon('skills/blessing_ward', 'skill', C_HOLY, [
    fx('CircleArcane', GROUND(0, -0.72, 22) @ FLAT @ S(1.7), C_STEEL, kg=1.1),
    fx('Pillar', GROUND(0, -0.72, 8, 0.4) @ S(1.25, 1.25, 4.4), 0xffd060, kg=1.0, fade=0.6),
    model('shield', T(0, 0.0, -0.2) @ R('Z', -20) @ S(1.28)),
])
icon('skills/resurrection', 'skill', C_HOLY, [
    fx('CircleHeal', GROUND(0, -0.72, 22) @ FLAT @ S(1.7), 0xfff6d8, kg=1.1),
    fx('Pillar', GROUND(0, -0.72, 8, 0.4) @ S(0.9, 0.9, 4.6), 0xfff6d8, kg=1.0),
    fx('Aura', GROUND(0, -0.72, 22) @ S(1.3, 1.3, 2.4), C_HOLY, kg=1.0),
    fx('Plus', T(0, 0.3, -0.5) @ S(0.9), 0xfff3c8, k=1.0),
])

# ---------------------------------------------------------------- render


def wanted(path):
    return not ONLY or path in ONLY or path.split('/')[1] in ONLY


def build():
    """Renders the set as one animation, a frame per icon - EEVEE then starts once, not once per picture."""
    started = time.time()
    todo = [p for p in ICONS if wanted(p)]
    for frame, path in enumerate(todo, 1):
        style, tint, parts, o, _ = ICONS[path]
        stage(parts, frame)
        RIM.data.color = tuple(float(c) for c in rgb(o.get('rim', tint)))
        RIM.data.keyframe_insert('color', frame=frame)
    scene.frame_start, scene.frame_end = 1, len(todo)
    scene.render.filepath = os.path.join(TMP, 'frame')
    bpy.ops.render.render(animation=True)
    for frame, path in enumerate(todo, 1):
        style, tint, parts, o, _ = ICONS[path]
        file = os.path.join(OUT, path + '.png')
        os.makedirs(os.path.dirname(file), exist_ok=True)
        write_png(file, compose(read_png(os.path.join(TMP, f'frame{frame:04d}.png')), style, tint, o))
    print(f'[icons] {len(todo)} icons in {time.time() - started:.1f} s -> {OUT}')


def sheet(file):
    """Every icon of the set at 128 px and again at 48 px - the size of a slot of the action bar. A class has a row of
    its own, with the small ones beside it; the items follow, with the small ones under them."""
    small, gap, cols = 48, 8, 8
    groups = {}
    for p, rec in ICONS.items():
        if os.path.exists(os.path.join(OUT, p + '.png')):
            groups.setdefault(rec[4], []).append(p)
    rows = []       # (y, size, x of the first tile, paths)
    y = gap
    for name in sorted(groups, key=lambda g: g == 'items'):     # the skills first
        paths = groups[name]
        for i in range(0, len(paths), cols):
            chunk = paths[i:i + cols]
            rows.append((y, SIZE, gap, chunk))
            if len(chunk) <= 5:
                rows.append((y + (SIZE - small) // 2, small, gap + 5 * (SIZE + gap) + 3 * gap, chunk))
                y += SIZE + gap
            else:
                rows.append((y + SIZE + gap, small, gap, chunk))
                y += SIZE + small + 2 * gap
    img = np.zeros((y, gap + cols * (SIZE + gap), 3), np.float32) + np.array([0.06, 0.09, 0.1], np.float32)
    for y, size, x, paths in rows:
        for c, p in enumerate(paths):
            px = read_png(os.path.join(OUT, p + '.png'))[..., :3]
            if size != SIZE:
                px = shrink(np.repeat(np.repeat(px, 3, axis=0), 3, axis=1), 8)
            img[y:y + size, x + c * (size + gap):x + c * (size + gap) + size] = px
    write_png(os.path.abspath(file), img)
    print(f'[icons] contact sheet of {sum(len(v) for v in groups.values())} icons -> {file}')


try:
    build()
    if SHEET:
        sheet(SHEET)
finally:
    shutil.rmtree(TMP, ignore_errors=True)
