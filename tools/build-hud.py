# Cuts the pictures of the HUD out of the two painted sheets in art/: the player's frame, its portrait and the ring
# around it from art/hud-atlas.png; the ring of the radar, its zoom buttons and the landmark icons from
# art/minimap-atlas.png. The sheets are paintings, not grids: every sprite is listed below by its box, in pixels of
# its sheet. The pieces go to assets/ui/hud/ at the size they have on the sheet, about twice what the page shows them
# at; index.html places them (the numbers it needs are in the notes beside each sprite).
#
# Run it from anywhere, after a sheet or a box has changed (it needs Pillow and numpy):
#   python3 tools/build-hud.py
import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'ui', 'hud')

# name: (sheet, (left, top, right, bottom))
SPRITES = {
    # the player's frame, empty: the gold line of its body runs from y = 9 to y = 246, the body ends at x = 635 at
    # the top and x = 716 at the bottom, and the leaves reach to the right edge
    'frame': ('hud', (991, 57, 1758, 323)),
    # the ring of the portrait with its laurel: the dark disc inside is centred on (163, 122) and 97 px in radius
    'portrait-ring': ('hud', (24, 368, 349, 645)),
    'portrait': ('hud', (552, 374, 745, 569)),          # the kitten, on a disc of its own
    'shield': ('hud', (1493, 646, 1558, 723)),          # the mark before the level
    # the ring of the radar with its "N": see radar_ring() for the hole the live radar shows through
    'radar-ring': ('minimap', (471, 19, 851, 445)),
    'zoom-in': ('minimap', (1514, 128, 1616, 231)),
    'zoom-out': ('minimap', (1514, 231, 1616, 334)),
    'zoom-in-lit': ('minimap', (1640, 122, 1735, 217)),     # the same two under the cursor
    'zoom-out-lit': ('minimap', (1640, 221, 1735, 318)),
    'skull': ('minimap', (1379, 529, 1430, 586)),       # landmarks of the radar and the world map: a boss lair,
    'chest': ('minimap', (1445, 538, 1496, 583)),       # a chest,
    'house': ('minimap', (1515, 534, 1572, 585)),       # the town
}

# The radar ring on its sheet is a whole radar, map and all. The live radar is drawn under it, so the disc inside the
# gold ring is cut out - all but the "N" plate, which lies over the top of it.
# In the sprite's own pixels: the centre of the ring, the radius of the hole (the gold begins at 175), and the plate as
# an ellipse (centre x, centre y, radius x, radius y) around its gold edge.
RADAR = {'cx': 188.5, 'cy': 224, 'hole': 174, 'plate': (191, 56, 52, 33)}


def radar_ring(im):
    px = np.array(im).astype(np.float32)
    h, w = px.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx - RADAR['cx'], yy - RADAR['cy'])
    inside = np.clip(RADAR['hole'] + 0.5 - r, 0, 1)   # 1 inside the hole, with a soft pixel at its edge
    px0, py0, rx, ry = RADAR['plate']
    plate = ((xx - px0) / rx) ** 2 + ((yy - py0) / ry) ** 2 <= 1
    px[..., 3] *= np.where(plate, 1, 1 - inside)
    return Image.fromarray(px.astype(np.uint8), 'RGBA')


def main():
    os.makedirs(OUT, exist_ok=True)
    sheets = {}
    for name, (sheet, box) in SPRITES.items():
        if sheet not in sheets: sheets[sheet] = Image.open(os.path.join(ROOT, 'art', f'{sheet}-atlas.png')).convert('RGBA')
        im = sheets[sheet].crop(box)
        if name == 'radar-ring': im = radar_ring(im)
        path = os.path.join(OUT, f'{name}.png')
        im.save(path, optimize=True)
        print(f'{name}.png  {im.width} x {im.height}  {os.path.getsize(path) // 1024} KB')


if __name__ == '__main__':
    main()
