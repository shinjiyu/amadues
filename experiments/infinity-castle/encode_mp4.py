"""Encode renders/fall/f_####.png into an H.264 MP4 using Blender's sequencer.

    Blender -b --factory-startup --python encode_mp4.py [-- <frames_dir> <out.mp4>]
"""
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SRC = os.path.join(HERE, 'renders', ARGS[0] if ARGS else 'fall')
DST = os.path.join(HERE, 'renders', ARGS[1] if len(ARGS) > 1 else 'fall_into_infinity_castle.mp4')

frames = sorted(f for f in os.listdir(SRC) if f.startswith('f_') and f.endswith('.png'))
sc = bpy.context.scene
se = sc.sequence_editor_create()
strip = se.strips.new_image('fall', os.path.join(SRC, frames[0]), channel=1, frame_start=1)
for f in frames[1:]:
    strip.elements.append(f)
BGM = os.path.join(HERE, 'renders', 'bgm.wav')
if os.path.exists(BGM):
    se.strips.new_sound('bgm', BGM, channel=2, frame_start=1)
sc.frame_start, sc.frame_end = 1, len(frames)
sc.render.fps = 24
sc.render.resolution_x, sc.render.resolution_y = 1280, 720
sc.render.resolution_percentage = 100
sc.view_settings.view_transform = 'Standard'
sc.render.image_settings.media_type = 'VIDEO'
sc.render.image_settings.file_format = 'FFMPEG'
sc.render.ffmpeg.format = 'MPEG4'
sc.render.ffmpeg.codec = 'H264'
sc.render.ffmpeg.constant_rate_factor = 'HIGH'
sc.render.ffmpeg.audio_codec = 'AAC' if os.path.exists(BGM) else 'NONE'
sc.render.ffmpeg.audio_bitrate = 256
sc.render.ffmpeg.audio_channels = 'STEREO'
sc.render.ffmpeg.audio_mixrate = 48000
sc.render.filepath = DST
bpy.ops.render.render(animation=True)
print('ENCODED', DST, len(frames))
