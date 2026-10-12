# Brings the models of Quaternius' Stylized Nature MegaKit (CC0, https://quaternius.com) into assets/nature/ - the
# 'nature' pack of src/map/catalog.js. The pack is made for engines with its own leaf and wind shaders; this makes its
# glTF files plain ones the game can draw as they are:
#   - the vertex colours go: they are the weights of the pack's wind shader (0 at the root, 1 at the tip), and a
#     renderer that takes them for colours paints every stem black;
#   - the normal maps go, and with them their textures: the game's light is flat, and they are 15 MB;
#   - leaves get new normals. They are flat cards that the pack's own shader lights as one soft body; lit by their
#     own normals every card is bright or dark as it happens to be turned. A crown gets the normals of a ball around
#     its middle, a plant on the ground normals that point up, and their material is marked ("extras": foliage) so
#     that src/map/view.js does not turn those normals round on the back of a card;
#   - every picture is scaled down (TEXTURES below) and shared by all the files, opaque ones as JPEG;
#   - each .bin is written anew with only what is left in use;
#   - a file CommonTree_1.gltf becomes common_tree_1.gltf, as the other packs are named.
#
# Run it with the folder that holds the pack's glTF files (it needs Pillow and numpy):
#   python3 tools/import-nature.py "<...>/Stylized Nature MegaKit[Standard]/glTF"
# A model that is new to the pack still needs its line in src/map/catalog.js (test/catalog.test.mjs says which).
import json, os, re, struct, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'nature')

# the pack's picture -> (ours, its longest side in pixels). Leaf and bark pictures are flat shapes and need few
# pixels; the two atlases every plant and every rock share keep more.
TEXTURES = {
    'Bark_NormalTree.png': ('bark_common', 512), 'Bark_DeadTree.png': ('bark_dead', 512), 'Bark_TwistedTree.png': ('bark_twisted', 512),
    'Leaves_NormalTree_C.png': ('leaves_common', 512), 'Leaf_Pine_C.png': ('leaves_pine', 512), 'Leaves_TwistedTree_C.png': ('leaves_twisted', 512),
    'Leaves.png': ('leaves', 1024), 'Flowers.png': ('flowers', 512), 'Grass.png': ('grass', 256),
    'Mushrooms.png': ('mushrooms', 512), 'PathRocks_Diffuse.png': ('path_rocks', 512), 'Rocks_Diffuse.png': ('rocks', 1024),
}
KEEP = ('POSITION', 'NORMAL', 'TEXCOORD_0')   # what a plain material reads
# materials that are leaves: 'crown' - the cards of a tree or a bush; 'ground' - a plant, a flower, a tuft of grass
FOLIAGE = {'Leaves_NormalTree': 'crown', 'Leaves_Pine': 'crown', 'Leaves_TwistedTree': 'crown', 'Leaves': 'ground', 'Flowers': 'ground', 'Grass': 'ground'}
SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
COUNT = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
ARRAY, ELEMENTS = 34962, 34963

snake = lambda name: re.sub(r'(?<=[a-z0-9])(?=[A-Z])', '_', name).lower()


def picture(src, name):
    """Writes the scaled picture once; -> (file name, whether it has holes)."""
    ours, side = TEXTURES[name]
    im = Image.open(os.path.join(src, name)).convert('RGBA')
    holes = np.array(im)[..., 3].min() < 250
    path = os.path.join(OUT, f'{ours}.{"png" if holes else "jpg"}')
    if not os.path.exists(path):
        k = side / max(im.size)
        if k < 1:   # scaled with the colour weighed by the alpha, so no edge takes the colour of what is cut away
            im = im.convert('RGBa').resize((round(im.width * k), round(im.height * k)), Image.LANCZOS).convert('RGBA')
        if holes: im.save(path, optimize=True)
        else: im.convert('RGB').save(path, quality=88, optimize=True)
    return os.path.basename(path), holes


def convert(src, file):
    g = json.load(open(os.path.join(src, file)))
    data = open(os.path.join(src, g['buffers'][0]['uri']), 'rb').read()
    name = snake(file[:-5])
    blob, views, accessors, moved = bytearray(), [], [], {}

    def take(index, target):   # an accessor of the source -> its index in the new file
        if index in moved: return moved[index]
        a = g['accessors'][index]; view = g['bufferViews'][a['bufferView']]
        size = SIZE[a['componentType']] * COUNT[a['type']]
        assert view.get('byteStride', size) == size and 'sparse' not in a, f'{file}: an interleaved or sparse accessor'
        start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
        while len(blob) % 4: blob.append(0)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': a['count'] * size, 'target': target})
        blob.extend(data[start:start + a['count'] * size])
        accessors.append({k: v for k, v in a.items() if k not in ('bufferView', 'byteOffset', 'name')} | {'bufferView': len(views) - 1})
        moved[index] = len(accessors) - 1
        return moved[index]

    def soft(position, kind):   # the normals of a part that is foliage, as a new accessor
        a = g['accessors'][position]; view = g['bufferViews'][a['bufferView']]
        start = view.get('byteOffset', 0) + a.get('byteOffset', 0)
        at = np.frombuffer(data, np.float32, a['count'] * 3, start).reshape(-1, 3)
        if kind == 'crown':   # away from a point a third of the way under the middle of the crown: lit above, shaded below
            lo, hi = at.min(0), at.max(0)
            n = at - ((lo + hi) / 2 - [0, (hi[1] - lo[1]) / 3, 0])
            n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-6)
        else: n = np.tile(np.float32([0, 1, 0]), (len(at), 1))
        while len(blob) % 4: blob.append(0)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(at) * 12, 'target': ARRAY})
        blob.extend(n.astype(np.float32).tobytes())
        accessors.append({'bufferView': len(views) - 1, 'componentType': 5126, 'count': len(at), 'type': 'VEC3'})
        return len(accessors) - 1

    images, materials, used = [], [], {}
    for m in g.get('materials', []):
        base = m['pbrMetallicRoughness']
        uri = g['images'][g['textures'][base['baseColorTexture']['index']]['source']]['uri']
        ours, holes = picture(src, uri)
        if ours not in used: used[ours] = len(images); images.append({'uri': ours})
        out = {'name': m['name'], 'doubleSided': m.get('doubleSided', False),
               'pbrMetallicRoughness': {'baseColorTexture': {'index': used[ours]}, 'metallicFactor': 0, 'roughnessFactor': 1}}
        if holes: out |= {'alphaMode': 'MASK', 'alphaCutoff': round(m.get('alphaCutoff', 0.5), 3)}
        if m['name'] in FOLIAGE: out['extras'] = {'foliage': True}
        materials.append(out)

    meshes = []
    for mesh in g['meshes']:
        prims = []
        for p in mesh['primitives']:
            assert all(k in p['attributes'] for k in KEEP), f'{file}: a part without {KEEP}'
            kind = FOLIAGE.get(g['materials'][p['material']]['name'])
            prim = {'attributes': {k: soft(p['attributes']['POSITION'], kind) if kind and k == 'NORMAL' else take(p['attributes'][k], ARRAY) for k in KEEP},
                    'material': p['material']}
            if 'indices' in p: prim['indices'] = take(p['indices'], ELEMENTS)
            prims.append(prim)
        meshes.append({'name': snake(mesh.get('name', name)), 'primitives': prims})

    nodes = [{k: v for k, v in n.items() if k in ('mesh', 'children', 'translation', 'rotation', 'scale', 'matrix')} | {'name': snake(n.get('name', name))}
             for n in g['nodes']]
    doc = {
        'asset': {'version': '2.0', 'generator': 'tools/import-nature.py', 'copyright': 'Quaternius, CC0 1.0'},
        'scene': g.get('scene', 0), 'scenes': [{'nodes': s['nodes']} for s in g['scenes']], 'nodes': nodes, 'meshes': meshes,
        'materials': materials, 'textures': [{'source': i, 'sampler': 0} for i in range(len(images))], 'images': images,
        'samplers': [{'magFilter': 9729, 'minFilter': 9987}],
        'accessors': accessors, 'bufferViews': views, 'buffers': [{'uri': f'{name}.bin', 'byteLength': len(blob)}],
    }
    open(os.path.join(OUT, f'{name}.bin'), 'wb').write(blob)
    json.dump(doc, open(os.path.join(OUT, f'{name}.gltf'), 'w'), separators=(',', ':'))
    return name, sum(accessors[p['indices']]['count'] for m in meshes for p in m['primitives'] if 'indices' in p) // 3


def main():
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]): sys.exit(__doc__ or 'usage: python3 tools/import-nature.py <folder of the pack\'s glTF files>')
    src = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    for old in os.listdir(OUT):   # the pictures are made anew, so a changed size in TEXTURES takes
        if old.endswith(('.png', '.jpg')): os.remove(os.path.join(OUT, old))
    done = [convert(src, f) for f in sorted(os.listdir(src)) if f.endswith('.gltf')]
    open(os.path.join(OUT, 'LICENSE.txt'), 'w').write(
        'Stylized Nature MegaKit by Quaternius (https://quaternius.com) - the free Standard part.\n'
        'CC0 1.0 Universal, Public Domain Dedication: https://creativecommons.org/publicdomain/zero/1.0/\n'
        'The files here are the pack\'s glTF models as tools/import-nature.py rewrites them for this game.\n')
    size = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f'{len(done)} models, {sum(t for _, t in done)} triangles, {size / 1048576:.1f} MB in assets/nature')
    print(' '.join(n for n, _ in done))


if __name__ == '__main__':
    main()
