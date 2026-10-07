# Renders the key art of the loading screen, assets/ui/loading.jpg (1920 x 1080), from the game's own models:
# the cat of art/hypercat.blend in its armour, a staff in its paw, in a cave of glowing crystals.
#
#   /Applications/Blender.app/Contents/MacOS/Blender --background art/hypercat.blend --python tools/build-keyart.py
#   ... --python tools/build-keyart.py -- --preview        a quarter of the pixels and of the samples, to try a change
#   ... --python tools/build-keyart.py -- --out /tmp/x.jpg  somewhere else
#
# Everything is built in memory and the file is never saved: art/hypercat.blend stays as it is. The cave, the crystals,
# the light and the camera are made here, so the picture is changed in this script, not by hand.
#
# What the picture has to leave alone (src/loading.js draws over it): the top centre, where the logo stands, and the
# bottom centre, where the bar, the counter and the tip are. The cat therefore stands in the left third and the
# brightest crystals in the right one; both middles stay dark and quiet.
import bpy, bmesh, math, os, random, sys
from math import sin, cos, pi, radians
from mathutils import Vector, Euler, Matrix, noise

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PREVIEW = '--preview' in argv
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(argv[argv.index('--out') + 1]) if '--out' in argv else os.path.join(HERE, '..', 'assets', 'ui', 'loading.jpg')

random.seed(7)
MINT = (0.22, 1.0, 0.60)
VIOLET = (0.55, 0.22, 1.0)
CAT_AT = Vector((-1.5, -1.1, 0.0))
CAT_TURN = radians(38)           # about Z: from facing the camera to facing the big crystals on the right

scene = bpy.data.scenes['HyperCat']
bpy.context.window.scene = scene
keyart = bpy.data.collections.new('KeyArt')
scene.collection.children.link(keyart)


# ---------------------------------------------------------------- materials

def node(tree, kind):
    """The node of a type. Not by its name: a Blender set to another language names new nodes in that language."""
    return next(n for n in tree.nodes if n.type == kind)


def principled(name, color, rough=0.85, metallic=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = node(m.node_tree, 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metallic
    return m


def crystal_mat(name, color, lo, hi):
    """Light that the facets give off by themselves, each a little differently by where it faces - so a crystal keeps
    its low-poly cut instead of turning into a flat glowing shape."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    dot = nt.nodes.new('ShaderNodeVectorMath')
    dot.operation = 'DOT_PRODUCT'
    dot.inputs[1].default_value = Vector((-0.8, -0.38, 0.46)).normalized()
    ramp = nt.nodes.new('ShaderNodeMapRange')
    ramp.inputs['From Min'].default_value = -0.7
    ramp.inputs['From Max'].default_value = 1.0
    ramp.inputs['To Min'].default_value = lo
    ramp.inputs['To Max'].default_value = hi
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*color, 1)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(geo.outputs['Normal'], dot.inputs[0])
    nt.links.new(dot.outputs['Value'], ramp.inputs['Value'])
    nt.links.new(ramp.outputs['Result'], em.inputs['Strength'])
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    return m


ROCK = principled('ka_rock', (0.030, 0.062, 0.080), 0.9)
ROCK_FAR = principled('ka_rock_far', (0.020, 0.045, 0.065), 0.95)
GROUND = principled('ka_ground', (0.026, 0.060, 0.070), 0.92)
CRYSTAL = {
    'mint': crystal_mat('ka_mint', MINT, 0.2, 1.85),
    'violet': crystal_mat('ka_violet', VIOLET, 0.3, 2.2),
}


# ---------------------------------------------------------------- shapes

def add(name, bm, mat, at=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    ob.location, ob.rotation_euler, ob.scale = at, rot, scale
    keyart.objects.link(ob)
    return ob


def rock(at, size, mat=ROCK, rough=0.22, squash=None):
    """A boulder: an icosphere whose corners are pushed in and out, flat-shaded."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1)
    for v in bm.verts:
        v.co *= 1 + random.uniform(-rough, rough)
    sx, sy, sz = squash or (random.uniform(0.8, 1.3), random.uniform(0.8, 1.3), random.uniform(0.7, 1.2))
    return add('ka_rock', bm, mat, at, (random.uniform(-0.4, 0.4), random.uniform(-0.4, 0.4), random.uniform(0, 6.3)),
               (size * sx, size * sy, size * sz))


def spike(bm, base, tip, radius, sides=6):
    """One crystal (or a stalactite): a prism with a slanted, pointed end, from `base` towards `tip`."""
    axis = (tip - base)
    length = axis.length
    M = Matrix.Translation(base) @ axis.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    turn = random.uniform(0, pi)
    ring = lambda z, r: [bm.verts.new(M @ Vector((cos(turn + i * 2 * pi / sides) * r, sin(turn + i * 2 * pi / sides) * r, z))) for i in range(sides)]
    a, b = ring(0, radius), ring(length * random.uniform(0.62, 0.8), radius * random.uniform(0.82, 1.0))
    top = bm.verts.new(M @ Vector((radius * random.uniform(-0.35, 0.35), radius * random.uniform(-0.35, 0.35), length)))
    for i in range(sides):
        j = (i + 1) % sides
        bm.faces.new((a[i], a[j], b[j], b[i]))
        bm.faces.new((b[i], b[j], top))


def cluster(at, height, n, kind, spread=0.5, lean=0.55):
    """A clump of crystals growing out of one spot: a tall one in the middle, shorter ones leaning away around it."""
    bm = bmesh.new()
    for i in range(n):
        k = i / max(1, n - 1)                       # 0 for the tallest
        ang = random.uniform(0, 2 * pi)
        out = Vector((cos(ang), sin(ang), 0))
        h = height * (1 - 0.72 * k) * random.uniform(0.85, 1.1)
        tilt = lean * (0.15 + k) * random.uniform(0.6, 1.2)
        base = out * spread * height * 0.25 * k
        spike(bm, base, base + (Vector((0, 0, 1)) * cos(tilt) + out * sin(tilt)) * h, h * random.uniform(0.085, 0.13))
    return add(f'ka_crystal_{kind}', bm, CRYSTAL[kind], at)


def ground():
    """The cave floor: a triangulated sheet of gentle bumps that stays level where the cat stands."""
    N, half = 72, 34
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=N, y_segments=N, size=half)
    for v in bm.verts:
        v.co.x += random.uniform(-0.18, 0.18)
        v.co.y += random.uniform(-0.18, 0.18)
        p = Vector((v.co.x * 0.16, v.co.y * 0.16, 0.3))
        h = noise.fractal(p, 1.0, 2.0, 3) * 1.1 + noise.noise(p * 4.5) * 0.16
        d = (v.co.xy - CAT_AT.xy).length
        # level around the cat and in front of it (the lower edge of the picture), rougher with the distance
        calm = min(1.0, max(0.0, (d - 1.2) / 5.0))
        front = min(1.0, max(0.0, (v.co.y + 7.0) / 6.0))
        v.co.z = h * (0.12 + 0.88 * calm) * (0.25 + 0.75 * front) - 0.03
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 8, 0))
    bmesh.ops.triangulate(bm, faces=bm.faces)
    return add('ka_ground', bm, GROUND)


ground()

# The cave: walls left and right, boulders that hide where they meet the floor, a far wall the fog swallows.
for at, size, mat in [
    ((-8.6, 2.5, 1.6), 3.6, ROCK), ((-7.4, -2.6, 0.6), 2.1, ROCK), ((-10.5, 8.0, 3.2), 5.5, ROCK), ((-5.2, 5.6, 0.2), 1.3, ROCK),
    ((9.4, 4.5, 1.8), 3.9, ROCK), ((8.2, -2.0, 0.2), 1.7, ROCK), ((11.5, 10.5, 3.5), 5.8, ROCK), ((6.3, 6.6, 0.1), 1.2, ROCK),
    ((-6.5, 17.0, 3.0), 6.0, ROCK_FAR), ((2.0, 24.0, 2.0), 7.5, ROCK_FAR), ((9.0, 19.0, 3.0), 6.0, ROCK_FAR), ((-14.0, 20.0, 5.0), 8.0, ROCK_FAR),
    ((16.0, 22.0, 5.0), 8.5, ROCK_FAR), ((-1.2, 12.5, -0.2), 1.6, ROCK), ((3.0, 9.5, -0.3), 1.1, ROCK),
    ((-3.3, 1.5, -0.25), 0.62, ROCK), ((0.2, 2.8, -0.2), 0.5, ROCK), ((5.6, 0.2, -0.3), 0.8, ROCK),
]:
    rock(at, size, mat)

# the roof: stalactites along both sides, none over the middle, where the logo stands
bm = bmesh.new()
for x, y, z, length in [
    (-6.6, 2.0, 6.6, 2.6), (-5.3, 4.5, 7.0, 1.7), (-8.2, 5.0, 7.2, 3.6), (-4.4, 8.0, 7.8, 2.2), (-7.4, 10.0, 8.4, 3.4),
    (7.0, 2.5, 6.6, 2.4), (5.6, 5.0, 7.0, 1.6), (8.6, 6.0, 7.3, 3.8), (4.8, 9.0, 7.9, 2.0), (7.8, 11.0, 8.5, 3.2),
    (-9.6, 0.5, 6.4, 3.3), (9.8, 1.0, 6.4, 3.1), (-2.6, 13.0, 9.0, 1.6), (2.9, 14.0, 9.2, 1.4),
]:
    spike(bm, Vector((x, y, z)), Vector((x + random.uniform(-0.25, 0.25), y, z - length)), length * 0.17, sides=5)
add('ka_stalactites', bm, ROCK)
rock((0.0, 9.0, 10.6), 9.0, ROCK, squash=(2.4, 2.0, 0.42))           # the ceiling itself

# ---------------------------------------------------------------- crystals and their light

def lamp(name, at, color, watts, radius=0.6, shadow=True):
    data = bpy.data.lights.new(name, 'POINT')
    data.color, data.energy, data.shadow_soft_size, data.use_shadow = color, watts, radius, shadow
    ob = bpy.data.objects.new(name, data)
    ob.location = at
    keyart.objects.link(ob)
    return ob


# (where, height, crystals, kind, watts of the light it sheds)
for at, height, n, kind, watts in [
    ((3.7, 1.6, -0.1), 3.1, 9, 'mint', 900),        # the big one the cat looks at
    ((5.5, 3.4, -0.1), 1.7, 6, 'mint', 220),
    ((2.2, 3.9, -0.1), 1.0, 5, 'mint', 90),
    ((-6.0, 6.2, -0.1), 3.5, 8, 'violet', 1500),    # behind the cat: its rim light
    ((2.3, 11.5, -0.1), 2.0, 6, 'violet', 420),
    ((-3.2, 4.2, -0.1), 1.1, 5, 'violet', 140),
    ((7.6, 10.5, -0.1), 3.0, 7, 'violet', 900),
    ((0.6, 14.0, -0.1), 2.2, 6, 'mint', 500),
    ((-9.5, 14.5, 0.2), 2.6, 6, 'mint', 500),
    ((-4.3, -0.6, -0.05), 0.55, 4, 'mint', 25),
    ((6.9, -1.2, -0.05), 0.7, 4, 'violet', 40),
]:
    cluster(at, height, n, kind)
    lamp(f'ka_light_{kind}', (at[0], at[1] - height * 0.15, max(0.5, height * 0.55)), MINT if kind == 'mint' else VIOLET, watts,
         radius=height * 0.22)

# dust that catches the light: a few sparks in the air, thinner towards the middle of the picture
for kind in ('mint', 'violet'):
    bm = bmesh.new()
    for _ in range(46):
        at = Vector((random.uniform(-9, 9), random.uniform(-3, 12), random.uniform(0.3, 5.0)))
        if abs(at.x - 0.8) < 2.2 and random.random() < 0.7:
            continue
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=random.uniform(0.012, 0.035), matrix=Matrix.Translation(at))
    add(f'ka_motes_{kind}', bm, CRYSTAL[kind])

# ---------------------------------------------------------------- the hero

for name in ('Sword', 'Bow', 'Arrow'):
    bpy.data.objects[name].hide_render = True
for name in ('CatSun', 'CatFill'):                      # the studio light of the model sheet
    bpy.data.objects[name].hide_render = True

# The file keeps the hoodie nearly black (the game colours it by class); in a cave that would be a hole in the picture.
# In memory only: the green of the game's default hoodie, and plates of the best tier.
tint = lambda name, rgb: node(bpy.data.materials[name].node_tree, 'BSDF_PRINCIPLED').inputs['Base Color'].default_value.__setitem__(slice(0, 3), rgb)
tint('cat_hoodie', (0.036, 0.085, 0.050))
tint('cat_hoodie_trim', (0.016, 0.040, 0.026))
tint('a_steel', (0.30, 0.52, 0.56))
for name in ('a_steel', 'w_steel'):
    b = node(bpy.data.materials[name].node_tree, 'BSDF_PRINCIPLED')
    b.inputs['Metallic'].default_value = 0.55
    b.inputs['Roughness'].default_value = 0.42
gem = node(bpy.data.materials['w_glow'].node_tree, 'BSDF_PRINCIPLED')
gem.inputs['Emission Color'].default_value = (*MINT, 1)
gem.inputs['Emission Strength'].default_value = 3.0

cat = bpy.data.objects['HyperCat']
cat.location = CAT_AT + Vector((0, 0, -0.03))
cat.rotation_euler = Euler((0, 0, CAT_TURN))
# The pose: the paw on the far side holds the staff out in front, the near arm hangs a little back, the head is
# lifted towards the crystals, one foot stands half a step ahead.
bpy.data.objects['P.Arm.R'].rotation_euler = Euler((radians(-58), radians(-6), radians(10)))
bpy.data.objects['P.Arm.L'].rotation_euler = Euler((radians(14), radians(8), 0))
bpy.data.objects['P.Head'].rotation_euler = Euler((radians(-9), 0, radians(7)))
bpy.data.objects['P.Leg.R'].rotation_euler = Euler((radians(-12), 0, 0))
bpy.data.objects['P.Leg.L'].rotation_euler = Euler((radians(9), 0, 0))
bpy.data.objects['P.Tail'].rotation_euler = Euler((radians(-8), 0, radians(-14)))
bpy.context.view_layer.update()

staff = bpy.data.objects['Staff']
paw = bpy.data.objects['Paw.R'].matrix_world.translation.copy()
staff.location = paw
staff.rotation_euler = Euler((radians(7), radians(-5), CAT_TURN))
bpy.context.view_layer.update()
gem_at = staff.matrix_world @ Vector((0, 0, 1.0))
# the gem of the staff lights the face from close by
lamp('ka_light_staff', gem_at + Vector((0.05, -0.35, 0.05)), MINT, 14, radius=0.12)

# ---------------------------------------------------------------- light, air, camera

# A wide, weak, cool light from above the camera: what the eye would still make out in a cave. It only lifts the blacks.
fill = bpy.data.lights.new('ka_fill', 'AREA')
fill.color, fill.energy, fill.size = (0.35, 0.6, 1.0), 32, 9
fill_ob = bpy.data.objects.new('ka_fill', fill)
fill_ob.location = (-1.0, -8.0, 6.5)
fill_ob.rotation_euler = Euler((radians(52), 0, radians(-6)))
keyart.objects.link(fill_ob)
# and the key light on the cat: the glow of the big crystals, gathered into one soft lamp so the face reads
key = bpy.data.lights.new('ka_key', 'AREA')
key.color, key.energy, key.size = (0.78, 1.0, 0.93), 150, 2.4
key_ob = bpy.data.objects.new('ka_key', key)
key_ob.location = CAT_AT + Vector((2.9, -2.2, 2.2))
key_ob.rotation_euler = (Vector((2.9, -2.2, 1.2))).to_track_quat('Z', 'Y').to_euler()
keyart.objects.link(key_ob)
# the violet crystals behind the cat draw its outline: a spot from their side, so the hero stands off the dark
rim = bpy.data.lights.new('ka_rim', 'SPOT')
rim.color, rim.energy, rim.spot_size, rim.spot_blend, rim.shadow_soft_size = VIOLET, 3000, radians(24), 0.7, 0.5
rim.volume_factor = 0                                   # its beam must not show in the fog: only the crystals may glow
rim_ob = bpy.data.objects.new('ka_rim', rim)
rim_ob.location = CAT_AT + Vector((-3.2, 5.0, 3.4))
rim_ob.rotation_euler = (Vector((-3.2, 5.0, 2.5))).to_track_quat('Z', 'Y').to_euler()
keyart.objects.link(rim_ob)

world = bpy.data.worlds.new('ka_world')
world.use_nodes = True
wn = world.node_tree
sky = node(wn, 'BACKGROUND')
sky.inputs['Color'].default_value = (0.003, 0.009, 0.018, 1)
sky.inputs['Strength'].default_value = 1.0
fog = wn.nodes.new('ShaderNodeVolumeScatter')
fog.inputs['Color'].default_value = (0.55, 0.85, 1.0, 1)
fog.inputs['Density'].default_value = 0.005
fog.inputs['Anisotropy'].default_value = 0.35
wn.links.new(fog.outputs['Volume'], node(wn, 'OUTPUT_WORLD').inputs['Volume'])
scene.world = world

cam_data = bpy.data.cameras.new('ka_cam')
cam_data.lens, cam_data.sensor_width = 33, 36
cam_data.clip_start, cam_data.clip_end = 0.1, 200
cam = bpy.data.objects.new('ka_cam', cam_data)
cam.location = (0.75, -9.2, 1.25)
cam.rotation_euler = (Vector(cam.location) - Vector((0.95, 0.0, 1.72))).to_track_quat('Z', 'Y').to_euler()
keyart.objects.link(cam)
scene.camera = cam

# ---------------------------------------------------------------- render

ee = scene.eevee
ee.taa_render_samples = 24 if PREVIEW else 64
ee.volumetric_start, ee.volumetric_end = 0.5, 70
ee.volumetric_tile_size = '4' if PREVIEW else '2'
ee.volumetric_samples = 96
ee.use_volumetric_shadows = True
ee.use_shadows = True
ee.use_raytracing = False
ee.use_fast_gi = False if not hasattr(ee, 'use_fast_gi') else ee.use_fast_gi

scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
scene.render.film_transparent = False
scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
scene.render.resolution_percentage = 50 if PREVIEW else 100
scene.render.dither_intensity = 1.5                    # dark gradients band in a JPEG without it
scene.render.image_settings.file_format = 'JPEG'
scene.render.image_settings.quality = 85
scene.render.image_settings.color_mode = 'RGB'
scene.render.filepath = OUT
scene.render.use_file_extension = False

# The bloom of the crystals: Blender's compositor does what the game's own bloom pass does.
tree = bpy.data.node_groups.new('ka_comp', 'CompositorNodeTree')
tree.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
layers = tree.nodes.new('CompositorNodeRLayers')
layers.scene = scene
glare = tree.nodes.new('CompositorNodeGlare')
glare.inputs['Type'].default_value = 'Bloom'
glare.inputs['Quality'].default_value = 'High'
glare.inputs['Threshold'].default_value = 0.5
glare.inputs['Smoothness'].default_value = 0.4
glare.inputs['Strength'].default_value = 1.15
glare.inputs['Saturation'].default_value = 1.1
glare.inputs['Size'].default_value = 0.7
done = tree.nodes.new('NodeGroupOutput')
tree.links.new(layers.outputs['Image'], glare.inputs['Image'])
tree.links.new(glare.outputs['Image'], done.inputs[0])
scene.compositing_node_group = tree
scene.render.use_compositing = True

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.render.render(write_still=True)
print(f'[keyart] wrote {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)')
