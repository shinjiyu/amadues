# Bake procedural materials for glTF

Use whenever Blender materials use Noise / Voronoi / Mix / Bump graphs and the deliverable is **GLB / three.js**.

glTF exporters keep **image textures + Principled factors**, not node trees. Skipping bake → white or plastic-flat mesh in H5 (even if Blender viewport looks correct).

## Emit bake (color + roughness)

1. Active object = body; material uses nodes; UVs already done.
2. Cycles, CPU or GPU, samples=1 for EMIT is enough.
3. For each target map:
   - Create Image Texture node (selected / active), new image (1024–2048).
   - Color → sRGB; Roughness / masks → Non-Color.
   - Temporarily connect the procedural **color** (or roughness as grayscale) into an **Emission** shader → Material Output.
   - `bpy.ops.object.bake(type="EMIT")`.
   - Restore Principled → Output.
4. Save PNGs under `work/textures/` and `image.pack()` before export.

## Normal bake

1. New Non-Color image + Image Texture active.
2. `scene.render.bake.normal_space = "TANGENT"`.
3. `bpy.ops.object.bake(type="NORMAL")` (mesh must carry the bump/displace you care about, or bake from a high-poly source).

## Rewire for export

Disconnect procedural links on Principled Base Color / Roughness / Normal. Connect:

- Color image → Base Color
- Roughness image → Roughness (Color output is fine for grayscale Non-Color)
- Normal image → Normal Map node → Normal

Keep Coat / SSS factors as scalars if needed; they survive better than graphs.

## Verify

Re-render Eevee after rewire. Spots and wart lighting must still read. Only then `export_scene.gltf`.

## Debug invisible patterns

If lookdev spots are missing: Emission-connect Voronoi `Distance` (or the mask) and render a top still. Adjust Map Range From Min/Max until the mask covers ~20–40% of the dorsum, then restore the full graph and re-bake.
