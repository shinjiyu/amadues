"""Headless: open the fall scene, add the clay->final reveal, save, optionally render previews.

    Blender -b infinity_castle_fall.blend --python reveal_headless.py -- [preview]
"""
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(bpy.data.filepath))
exec(open(os.path.join(HERE, 'build_infinity_castle.py')).read(), globals())

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
sc = bpy.context.scene
print('REVEAL', step_reveal())
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'infinity_castle_reveal.blend'))
print('SAVED reveal blend')
if 'preview' in args:
    sc.render.use_motion_blur = False
    sc.render.resolution_x, sc.render.resolution_y = 640, 360
    sc.eevee.taa_render_samples = 12
    for f in (1, 40, 75, 105, 135, 175):
        sc.frame_set(f)
        sc.render.filepath = os.path.join(HERE, 'renders', f'rv_{f:03d}.png')
        bpy.ops.render.render(write_still=True)
        print('PREVIEW', f)
