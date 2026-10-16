"""
Skin-modifier sitting frog — rebuilt from skin_frog_cot CoT skill.
Skeleton → Skin → close holes → remesh → eyes → procedural skin → bake → GLB.
"""
from __future__ import annotations

import math
import os
from pathlib import Path

import bpy
from mathutils import Vector

WORK = Path("/Users/shinjiyu/Documents/amadues/experiments/exec-agent-blender-frog/grok-cot-test/work")
REPORTS = WORK / "reports"
TEXTURES = WORK / "textures"
HDR_PATH = TEXTURES / "forest.hdr"
GLB_PATH = WORK / "frog.glb"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures):
        for b in list(block):
            block.remove(b)


def _ensure_dirs():
    REPORTS.mkdir(parents=True, exist_ok=True)
    TEXTURES.mkdir(parents=True, exist_ok=True)


def _link_active(obj):
    if obj.name not in bpy.context.scene.collection.objects:
        bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)


def _deselect_all():
    for o in bpy.context.view_layer.objects:
        o.select_set(False)


# ---------------------------------------------------------------------------
# step_mesh — polyline skeleton + Skin + close + remesh + warts
# ---------------------------------------------------------------------------

def step_mesh():
    """Build connected organic body via Skin skeleton (sitting pose)."""
    _ensure_dirs()
    _clear_scene()

    # Joints: (name, co, radius_xy, parent_index_or_None)
    # +Y forward, Z up, sit on z≈0. Midsection widest.
    # Indices: we build edges by parent index.
    joints = [
        # 0 spine root (rump) — Skin root
        ("rump",      (0.0,  -0.05, 0.18), (0.16, 0.14), None),
        # 1 hips
        ("hips",      (0.0,   0.08, 0.22), (0.18, 0.15), 0),
        # 2 mid (widest)
        ("mid",       (0.0,   0.28, 0.28), (0.20, 0.17), 1),
        # 3 chest
        ("chest",     (0.0,   0.48, 0.32), (0.17, 0.15), 2),
        # 4 neck
        ("neck",      (0.0,   0.62, 0.38), (0.13, 0.12), 3),
        # 5 head
        ("head",      (0.0,   0.74, 0.46), (0.15, 0.13), 4),
        # 6 snout
        ("snout",     (0.0,   0.90, 0.40), (0.09, 0.08), 5),
        # eye turrets off head (x≈±0.25–0.28, high z)
        ("eye_L",     (-0.26, 0.72, 0.58), (0.07, 0.07), 5),
        ("eye_R",     ( 0.26, 0.72, 0.58), (0.07, 0.07), 5),
        # --- LEFT hind leg (folded sit): hip out → knee forward-out → ankle back → heel → 4 toes
        ("L_hip",     (-0.22, 0.05, 0.20), (0.09, 0.08), 1),
        ("L_knee",    (-0.38, 0.28, 0.12), (0.08, 0.07), 9),
        ("L_ankle",   (-0.32,-0.08, 0.06), (0.07, 0.06), 10),
        ("L_heel",    (-0.30,-0.22, 0.02), (0.08, 0.06), 11),
        ("L_toe0",    (-0.42,-0.34, 0.01), (0.035, 0.03), 12),
        ("L_toe1",    (-0.34,-0.38, 0.01), (0.035, 0.03), 12),
        ("L_toe2",    (-0.26,-0.36, 0.01), (0.035, 0.03), 12),
        ("L_toe3",    (-0.20,-0.30, 0.01), (0.030, 0.028), 12),
        # --- RIGHT hind leg
        ("R_hip",     ( 0.22, 0.05, 0.20), (0.09, 0.08), 1),
        ("R_knee",    ( 0.38, 0.28, 0.12), (0.08, 0.07), 17),
        ("R_ankle",   ( 0.32,-0.08, 0.06), (0.07, 0.06), 18),
        ("R_heel",    ( 0.30,-0.22, 0.02), (0.08, 0.06), 19),
        ("R_toe0",    ( 0.42,-0.34, 0.01), (0.035, 0.03), 20),
        ("R_toe1",    ( 0.34,-0.38, 0.01), (0.035, 0.03), 20),
        ("R_toe2",    ( 0.26,-0.36, 0.01), (0.035, 0.03), 20),
        ("R_toe3",    ( 0.20,-0.30, 0.01), (0.030, 0.028), 20),
        # --- LEFT foreleg: shoulder → elbow → wrist → 4 fingers
        ("L_sh",      (-0.18, 0.48, 0.28), (0.06, 0.055), 3),
        ("L_elb",     (-0.28, 0.58, 0.14), (0.05, 0.045), 25),
        ("L_wri",     (-0.26, 0.68, 0.03), (0.05, 0.04), 26),
        ("L_f0",      (-0.36, 0.78, 0.01), (0.025, 0.022), 27),
        ("L_f1",      (-0.30, 0.82, 0.01), (0.025, 0.022), 27),
        ("L_f2",      (-0.24, 0.80, 0.01), (0.025, 0.022), 27),
        ("L_f3",      (-0.20, 0.74, 0.01), (0.022, 0.02), 27),
        # --- RIGHT foreleg
        ("R_sh",      ( 0.18, 0.48, 0.28), (0.06, 0.055), 3),
        ("R_elb",     ( 0.28, 0.58, 0.14), (0.05, 0.045), 32),
        ("R_wri",     ( 0.26, 0.68, 0.03), (0.05, 0.04), 33),
        ("R_f0",      ( 0.36, 0.78, 0.01), (0.025, 0.022), 34),
        ("R_f1",      ( 0.30, 0.82, 0.01), (0.025, 0.022), 34),
        ("R_f2",      ( 0.24, 0.80, 0.01), (0.025, 0.022), 34),
        ("R_f3",      ( 0.20, 0.74, 0.01), (0.022, 0.02), 34),
    ]

    mesh = bpy.data.meshes.new("FrogSkel")
    verts = [j[1] for j in joints]
    edges = []
    for i, j in enumerate(joints):
        parent = j[3]
        if parent is not None:
            edges.append((parent, i))
    mesh.from_pydata(verts, edges, [])
    mesh.update()

    obj = bpy.data.objects.new("Frog", mesh)
    _link_active(obj)

    # Skin modifier
    skin = obj.modifiers.new("Skin", "SKIN")
    skin.use_smooth_shade = True
    skin.branch_smoothing = 0.4

    # Assign radii + root at rump
    sk_data = mesh.skin_vertices[0].data
    for i, j in enumerate(joints):
        sk_data[i].radius = j[2]
        sk_data[i].use_root = (i == 0)

    # Subsurf for smoother organic volume
    sub = obj.modifiers.new("Subsurf", "SUBSURF")
    sub.levels = 2
    sub.render_levels = 2

    bpy.ops.object.modifier_apply(modifier="Skin")
    bpy.ops.object.modifier_apply(modifier="Subsurf")

    # Hard lesson: close non-manifold holes BEFORE remesh or torso vanishes
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.delete_loose()
    bpy.ops.mesh.remove_doubles(threshold=0.001)
    bpy.ops.mesh.fill_holes(sides=0)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")

    # Voxel remesh to fuse branch flaps
    rem = obj.modifiers.new("Remesh", "REMESH")
    rem.mode = "VOXEL"
    rem.voxel_size = 0.013
    rem.adaptivity = 0.0
    bpy.ops.object.modifier_apply(modifier="Remesh")

    # Smooth
    sm = obj.modifiers.new("Smooth", "SMOOTH")
    sm.factor = 0.5
    sm.iterations = 8
    bpy.ops.object.modifier_apply(modifier="Smooth")

    bpy.ops.object.shade_smooth()

    # Dorsal wart vertex group (weight ∝ height × normal.z)
    vg = obj.vertex_groups.new(name="dorsal_warts")
    mesh = obj.data
    # Blender 5.x: vertex normals available without calc_normals_split
    for vi, v in enumerate(mesh.vertices):
        n = v.normal
        w = max(0.0, float(n.z)) * max(0.0, (v.co.z - 0.08) / 0.5)
        w = min(1.0, w * 1.4)
        if w > 0.05:
            vg.add([vi], w, "REPLACE")

    # Voronoi wart displace (negative strength pops wart centers)
    tex = bpy.data.textures.new("WartVoronoi", type="VORONOI")
    tex.noise_scale = 0.55
    try:
        tex.distance_metric = "DISTANCE"
    except Exception:
        pass
    disp = obj.modifiers.new("Warts", "DISPLACE")
    disp.texture = tex
    disp.mid_level = 0.5
    disp.strength = -0.018
    disp.vertex_group = "dorsal_warts"
    bpy.ops.object.modifier_apply(modifier="Warts")

    bpy.ops.object.shade_smooth()

    n_verts = len(obj.data.vertices)
    n_faces = len(obj.data.polygons)
    result = {"verts": n_verts, "faces": n_faces, "name": obj.name}
    print("step_mesh:", result)
    return result


# ---------------------------------------------------------------------------
# step_eyes — bulging spheres, bronze iris, horizontal slit pupils
# ---------------------------------------------------------------------------

def step_eyes():
    frog = bpy.data.objects.get("Frog")
    if frog is None:
        raise RuntimeError("Frog missing — run step_mesh first")

    # Scan body verts near head top-sides for max z around x=±0.25
    mesh = frog.data
    left_peak = None
    right_peak = None
    left_z, right_z = -1e9, -1e9
    for v in mesh.vertices:
        co = frog.matrix_world @ v.co
        if co.y < 0.55 or co.y > 0.95:
            continue
        if -0.35 < co.x < -0.15 and co.z > left_z:
            left_z = co.z
            left_peak = co.copy()
        if 0.15 < co.x < 0.35 and co.z > right_z:
            right_z = co.z
            right_peak = co.copy()

    # Fallback if scan failed
    if left_peak is None:
        left_peak = Vector((-0.24, 0.72, 0.56))
    if right_peak is None:
        right_peak = Vector((0.24, 0.72, 0.56))

    # Nestle slightly inward/down from peak
    placements = [
        ("Eye_L", Vector((left_peak.x + 0.02, left_peak.y + 0.02, left_peak.z - 0.02)), -1),
        ("Eye_R", Vector((right_peak.x - 0.02, right_peak.y + 0.02, right_peak.z - 0.02)), 1),
    ]

    created = []
    for name, center, side in placements:
        # Remove old
        old = bpy.data.objects.get(name)
        if old:
            bpy.data.objects.remove(old, do_unlink=True)
        old_iris = bpy.data.objects.get(name + "_Iris")
        if old_iris:
            bpy.data.objects.remove(old_iris, do_unlink=True)
        old_pup = bpy.data.objects.get(name + "_Pupil")
        if old_pup:
            bpy.data.objects.remove(old_pup, do_unlink=True)

        # Eyeball (sclera / wet white-green)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.055, location=center, segments=32, ring_count=16)
        eyeball = bpy.context.active_object
        eyeball.name = name
        bpy.ops.object.shade_smooth()

        mat_ball = bpy.data.materials.new(name + "_Sclera")
        mat_ball.use_nodes = True
        nt = mat_ball.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        princ = nt.nodes.new("ShaderNodeBsdfPrincipled")
        princ.inputs["Base Color"].default_value = (0.75, 0.82, 0.55, 1)
        princ.inputs["Roughness"].default_value = 0.15
        if "Coat Weight" in princ.inputs:
            princ.inputs["Coat Weight"].default_value = 0.8
        nt.links.new(princ.outputs["BSDF"], out.inputs["Surface"])
        eyeball.data.materials.append(mat_ball)

        # Iris bronze/gold — slightly outward
        iris_c = center + Vector((side * 0.038, 0.012, 0.005))
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.032, location=iris_c, segments=24, ring_count=12)
        iris = bpy.context.active_object
        iris.name = name + "_Iris"
        iris.scale = (0.95, 0.85, 0.95)
        bpy.ops.object.transform_apply(scale=True)
        bpy.ops.object.shade_smooth()

        mat_iris = bpy.data.materials.new(name + "_IrisMat")
        mat_iris.use_nodes = True
        nt = mat_iris.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        princ = nt.nodes.new("ShaderNodeBsdfPrincipled")
        princ.inputs["Base Color"].default_value = (0.55, 0.38, 0.08, 1)  # bronze
        princ.inputs["Roughness"].default_value = 0.12
        if "Metallic" in princ.inputs:
            princ.inputs["Metallic"].default_value = 0.35
        if "Coat Weight" in princ.inputs:
            princ.inputs["Coat Weight"].default_value = 1.0
        nt.links.new(princ.outputs["BSDF"], out.inputs["Surface"])
        iris.data.materials.append(mat_iris)

        # Pupil: flattened black ellipsoid — horizontal slit (wide × thin)
        pup_c = iris_c + Vector((side * 0.028, 0.008, 0.0))
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.018, location=pup_c, segments=16, ring_count=8)
        pupil = bpy.context.active_object
        pupil.name = name + "_Pupil"
        pupil.scale = (1.35, 0.35, 0.55)  # wide × thin slit
        # Track outward: rotate around Z a bit
        pupil.rotation_euler = (0.0, 0.0, side * 0.25)
        bpy.ops.object.transform_apply(scale=True, rotation=True)
        bpy.ops.object.shade_smooth()

        mat_pup = bpy.data.materials.new(name + "_PupilMat")
        mat_pup.use_nodes = True
        nt = mat_pup.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        princ = nt.nodes.new("ShaderNodeBsdfPrincipled")
        princ.inputs["Base Color"].default_value = (0.01, 0.01, 0.01, 1)
        princ.inputs["Roughness"].default_value = 0.4
        nt.links.new(princ.outputs["BSDF"], out.inputs["Surface"])
        pupil.data.materials.append(mat_pup)

        created.append({"eye": name, "center": list(center), "iris": list(iris_c)})

    result = {"eyes": created}
    print("step_eyes:", result)
    return result


# ---------------------------------------------------------------------------
# step_material — procedural frog skin with FINAL_COLOR / FINAL_ROUGH hooks
# ---------------------------------------------------------------------------

def step_material():
    frog = bpy.data.objects.get("Frog")
    if frog is None:
        raise RuntimeError("Frog missing")

    # Clear mats
    frog.data.materials.clear()

    mat = bpy.data.materials.new("FrogSkin")
    mat.use_nodes = True
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (1200, 0)

    princ = nodes.new("ShaderNodeBsdfPrincipled")
    princ.name = "Principled"
    princ.location = (900, 0)
    if "Subsurface Weight" in princ.inputs:
        princ.inputs["Subsurface Weight"].default_value = 0.25
    elif "Subsurface" in princ.inputs:
        princ.inputs["Subsurface"].default_value = 0.25
    if "Subsurface Radius" in princ.inputs:
        princ.inputs["Subsurface Radius"].default_value = (0.4, 0.7, 0.3)
    if "Coat Weight" in princ.inputs:
        princ.inputs["Coat Weight"].default_value = 0.45
    princ.inputs["Roughness"].default_value = 0.45

    # Object coords
    texcoord = nodes.new("ShaderNodeTexCoord")
    texcoord.location = (-1200, 0)

    # Base olive ↔ leaf green Noise
    noise_base = nodes.new("ShaderNodeTexNoise")
    noise_base.location = (-900, 200)
    noise_base.inputs["Scale"].default_value = 4.5
    noise_base.inputs["Detail"].default_value = 8.0
    links.new(texcoord.outputs["Object"], noise_base.inputs["Vector"])

    ramp_base = nodes.new("ShaderNodeValToRGB")
    ramp_base.location = (-700, 200)
    ramp_base.color_ramp.elements[0].position = 0.35
    ramp_base.color_ramp.elements[0].color = (0.18, 0.32, 0.10, 1)  # olive
    ramp_base.color_ramp.elements[1].position = 0.7
    ramp_base.color_ramp.elements[1].color = (0.28, 0.48, 0.14, 1)  # leaf
    links.new(noise_base.outputs["Fac"], ramp_base.inputs["Fac"])

    # Brown mottling
    noise_mottle = nodes.new("ShaderNodeTexNoise")
    noise_mottle.location = (-900, 0)
    noise_mottle.inputs["Scale"].default_value = 7.0
    noise_mottle.inputs["Detail"].default_value = 4.0
    links.new(texcoord.outputs["Object"], noise_mottle.inputs["Vector"])

    mix_mottle = nodes.new("ShaderNodeMixRGB")
    mix_mottle.location = (-450, 150)
    mix_mottle.blend_type = "MIX"
    mix_mottle.inputs["Fac"].default_value = 0.35
    mix_mottle.inputs["Color2"].default_value = (0.25, 0.16, 0.08, 1)
    links.new(noise_mottle.outputs["Fac"], mix_mottle.inputs["Fac"])
    links.new(ramp_base.outputs["Color"], mix_mottle.inputs["Color1"])

    # Voronoi spots — widen Map Range so spots cover meaningful dorsum
    voronoi = nodes.new("ShaderNodeTexVoronoi")
    voronoi.location = (-900, -250)
    voronoi.feature = "F1"
    voronoi.inputs["Scale"].default_value = 5.5
    links.new(texcoord.outputs["Object"], voronoi.inputs["Vector"])

    # Warp with noise for organic spots
    noise_warp = nodes.new("ShaderNodeTexNoise")
    noise_warp.location = (-1100, -250)
    noise_warp.inputs["Scale"].default_value = 3.0
    links.new(texcoord.outputs["Object"], noise_warp.inputs["Vector"])

    map_range = nodes.new("ShaderNodeMapRange")
    map_range.location = (-650, -250)
    # Widen thresholds — tight ones look like "no spots" (skill: widen Map Range)
    map_range.inputs["From Min"].default_value = 0.0
    map_range.inputs["From Max"].default_value = 0.62
    map_range.inputs["To Min"].default_value = 1.0
    map_range.inputs["To Max"].default_value = 0.0
    links.new(voronoi.outputs["Distance"], map_range.inputs["Value"])

    # Geometry for dorsal mask (upper normals)
    geom = nodes.new("ShaderNodeNewGeometry")
    geom.location = (-900, -500)

    sep = nodes.new("ShaderNodeSeparateXYZ")
    sep.location = (-700, -500)
    links.new(geom.outputs["Normal"], sep.inputs["Vector"])

    dorsal_mask = nodes.new("ShaderNodeMapRange")
    dorsal_mask.location = (-500, -500)
    dorsal_mask.inputs["From Min"].default_value = 0.05
    dorsal_mask.inputs["From Max"].default_value = 0.55
    dorsal_mask.inputs["To Min"].default_value = 0.0
    dorsal_mask.inputs["To Max"].default_value = 1.0
    links.new(sep.outputs["Z"], dorsal_mask.inputs["Value"])

    spot_strength = nodes.new("ShaderNodeMath")
    spot_strength.operation = "MULTIPLY"
    spot_strength.location = (-350, -300)
    links.new(map_range.outputs["Result"], spot_strength.inputs[0])
    links.new(dorsal_mask.outputs["Result"], spot_strength.inputs[1])

    # Boost spot fac so dorsum reads spotted (not faint mottling)
    spot_boost = nodes.new("ShaderNodeMath")
    spot_boost.operation = "MULTIPLY"
    spot_boost.location = (-250, -300)
    spot_boost.inputs[1].default_value = 1.35
    links.new(spot_strength.outputs["Value"], spot_boost.inputs[0])
    spot_clamp = nodes.new("ShaderNodeClamp")
    spot_clamp.location = (-180, -300)
    links.new(spot_boost.outputs["Value"], spot_clamp.inputs["Value"])

    mix_spots = nodes.new("ShaderNodeMixRGB")
    mix_spots.location = (-200, 100)
    mix_spots.blend_type = "MIX"
    mix_spots.inputs["Color2"].default_value = (0.08, 0.05, 0.02, 1)  # dark brown/green spots
    links.new(spot_clamp.outputs["Result"], mix_spots.inputs["Fac"])
    links.new(mix_mottle.outputs["Color"], mix_spots.inputs["Color1"])

    # Belly cream by normal.z (and low Z)
    belly_mask = nodes.new("ShaderNodeMapRange")
    belly_mask.location = (-500, -700)
    belly_mask.inputs["From Min"].default_value = 0.1
    belly_mask.inputs["From Max"].default_value = -0.4
    belly_mask.inputs["To Min"].default_value = 0.0
    belly_mask.inputs["To Max"].default_value = 1.0
    links.new(sep.outputs["Z"], belly_mask.inputs["Value"])

    mix_belly = nodes.new("ShaderNodeMixRGB")
    mix_belly.location = (0, 50)
    mix_belly.blend_type = "MIX"
    mix_belly.inputs["Color2"].default_value = (0.85, 0.78, 0.45, 1)  # cream/yellow
    links.new(belly_mask.outputs["Result"], mix_belly.inputs["Fac"])
    links.new(mix_spots.outputs["Color"], mix_belly.inputs["Color1"])

    # Leg bands: Wave × |X| far from center
    wave = nodes.new("ShaderNodeTexWave")
    wave.location = (-900, -850)
    wave.bands_direction = "Y"
    wave.inputs["Scale"].default_value = 8.0
    wave.inputs["Distortion"].default_value = 2.0
    links.new(texcoord.outputs["Object"], wave.inputs["Vector"])

    sep_pos = nodes.new("ShaderNodeSeparateXYZ")
    sep_pos.location = (-900, -1050)
    links.new(texcoord.outputs["Object"], sep_pos.inputs["Vector"])

    abs_x = nodes.new("ShaderNodeMath")
    abs_x.operation = "ABSOLUTE"
    abs_x.location = (-700, -1050)
    links.new(sep_pos.outputs["X"], abs_x.inputs[0])

    band_mask = nodes.new("ShaderNodeMapRange")
    band_mask.location = (-500, -1050)
    band_mask.inputs["From Min"].default_value = 0.15
    band_mask.inputs["From Max"].default_value = 0.35
    band_mask.inputs["To Min"].default_value = 0.0
    band_mask.inputs["To Max"].default_value = 0.55
    links.new(abs_x.outputs["Value"], band_mask.inputs["Value"])

    band_fac = nodes.new("ShaderNodeMath")
    band_fac.operation = "MULTIPLY"
    band_fac.location = (-300, -900)
    links.new(wave.outputs["Fac"], band_fac.inputs[0])
    links.new(band_mask.outputs["Result"], band_fac.inputs[1])

    mix_bands = nodes.new("ShaderNodeMixRGB")
    mix_bands.location = (200, 0)
    mix_bands.blend_type = "MIX"
    mix_bands.inputs["Color2"].default_value = (0.15, 0.22, 0.08, 1)
    links.new(band_fac.outputs["Value"], mix_bands.inputs["Fac"])
    links.new(mix_belly.outputs["Color"], mix_bands.inputs["Color1"])

    # Mouth dark crease near jaw (shader mask on Z/Y)
    jaw_y = nodes.new("ShaderNodeMapRange")
    jaw_y.location = (-500, 400)
    jaw_y.inputs["From Min"].default_value = 0.78
    jaw_y.inputs["From Max"].default_value = 0.92
    jaw_y.inputs["To Min"].default_value = 0.0
    jaw_y.inputs["To Max"].default_value = 1.0
    links.new(sep_pos.outputs["Y"], jaw_y.inputs["Value"])

    jaw_z = nodes.new("ShaderNodeMapRange")
    jaw_z.location = (-500, 550)
    jaw_z.inputs["From Min"].default_value = 0.42
    jaw_z.inputs["From Max"].default_value = 0.32
    jaw_z.inputs["To Min"].default_value = 0.0
    jaw_z.inputs["To Max"].default_value = 1.0
    links.new(sep_pos.outputs["Z"], jaw_z.inputs["Value"])

    mouth_fac = nodes.new("ShaderNodeMath")
    mouth_fac.operation = "MULTIPLY"
    mouth_fac.location = (-280, 450)
    links.new(jaw_y.outputs["Result"], mouth_fac.inputs[0])
    links.new(jaw_z.outputs["Result"], mouth_fac.inputs[1])

    mix_mouth = nodes.new("ShaderNodeMixRGB")
    mix_mouth.location = (400, 0)
    mix_mouth.blend_type = "MIX"
    mix_mouth.inputs["Color2"].default_value = (0.05, 0.04, 0.03, 1)
    links.new(mouth_fac.outputs["Value"], mix_mouth.inputs["Fac"])
    links.new(mix_bands.outputs["Color"], mix_mouth.inputs["Color1"])

    # Tympanum: distance-to-point brown disc behind each eye
    # Approximate points (±0.28, 0.68, 0.48)
    def _tympanum(side_x, y_off, z_off, loc_y):
        # Vector to tympanum center
        combine = nodes.new("ShaderNodeCombineXYZ")
        combine.location = (-700, loc_y)
        combine.inputs["X"].default_value = side_x
        combine.inputs["Y"].default_value = y_off
        combine.inputs["Z"].default_value = z_off

        sub = nodes.new("ShaderNodeVectorMath")
        sub.operation = "SUBTRACT"
        sub.location = (-500, loc_y)
        links.new(texcoord.outputs["Object"], sub.inputs[0])
        links.new(combine.outputs["Vector"], sub.inputs[1])

        length = nodes.new("ShaderNodeVectorMath")
        length.operation = "LENGTH"
        length.location = (-300, loc_y)
        links.new(sub.outputs["Vector"], length.inputs[0])

        disc = nodes.new("ShaderNodeMapRange")
        disc.location = (-100, loc_y)
        disc.inputs["From Min"].default_value = 0.0
        disc.inputs["From Max"].default_value = 0.06
        disc.inputs["To Min"].default_value = 1.0
        disc.inputs["To Max"].default_value = 0.0
        links.new(length.outputs["Value"], disc.inputs["Value"])
        return disc

    tym_l = _tympanum(-0.28, 0.68, 0.48, 700)
    tym_r = _tympanum(0.28, 0.68, 0.48, 900)

    tym_add = nodes.new("ShaderNodeMath")
    tym_add.operation = "ADD"
    tym_add.location = (100, 800)
    links.new(tym_l.outputs["Result"], tym_add.inputs[0])
    links.new(tym_r.outputs["Result"], tym_add.inputs[1])

    tym_clamp = nodes.new("ShaderNodeClamp")
    tym_clamp.location = (250, 800)
    links.new(tym_add.outputs["Value"], tym_clamp.inputs["Value"])

    mix_tym = nodes.new("ShaderNodeMixRGB")
    mix_tym.location = (580, 0)
    mix_tym.blend_type = "MIX"
    mix_tym.inputs["Color2"].default_value = (0.22, 0.12, 0.06, 1)
    links.new(tym_clamp.outputs["Result"], mix_tym.inputs["Fac"])
    links.new(mix_mouth.outputs["Color"], mix_tym.inputs["Color1"])

    # FINAL_COLOR bake hook
    final_color = nodes.new("ShaderNodeEmission")
    final_color.name = "FINAL_COLOR"
    final_color.label = "FINAL_COLOR"
    final_color.location = (750, 200)
    links.new(mix_tym.outputs["Color"], final_color.inputs["Color"])

    links.new(mix_tym.outputs["Color"], princ.inputs["Base Color"])

    # Roughness Noise (wetter dorsally)
    noise_rough = nodes.new("ShaderNodeTexNoise")
    noise_rough.location = (-900, 600)
    noise_rough.inputs["Scale"].default_value = 12.0
    links.new(texcoord.outputs["Object"], noise_rough.inputs["Vector"])

    rough_map = nodes.new("ShaderNodeMapRange")
    rough_map.location = (-650, 600)
    rough_map.inputs["From Min"].default_value = 0.0
    rough_map.inputs["From Max"].default_value = 1.0
    rough_map.inputs["To Min"].default_value = 0.25
    rough_map.inputs["To Max"].default_value = 0.55
    links.new(noise_rough.outputs["Fac"], rough_map.inputs["Value"])

    # Wetter (lower rough) dorsally
    wet_mix = nodes.new("ShaderNodeMath")
    wet_mix.operation = "MULTIPLY"
    wet_mix.location = (-400, 550)
    wet_mix.inputs[1].default_value = 0.7
    links.new(dorsal_mask.outputs["Result"], wet_mix.inputs[0])

    rough_final = nodes.new("ShaderNodeMath")
    rough_final.operation = "SUBTRACT"
    rough_final.location = (-200, 600)
    links.new(rough_map.outputs["Result"], rough_final.inputs[0])
    links.new(wet_mix.outputs["Value"], rough_final.inputs[1])

    final_rough_em = nodes.new("ShaderNodeEmission")
    final_rough_em.name = "FINAL_ROUGH"
    final_rough_em.label = "FINAL_ROUGH"
    final_rough_em.location = (750, -200)
    # grayscale via combine
    rough_rgb = nodes.new("ShaderNodeCombineColor")
    rough_rgb.location = (550, -200)
    try:
        links.new(rough_final.outputs["Value"], rough_rgb.inputs["Red"])
        links.new(rough_final.outputs["Value"], rough_rgb.inputs["Green"])
        links.new(rough_final.outputs["Value"], rough_rgb.inputs["Blue"])
    except Exception:
        # older API
        pass
    links.new(rough_rgb.outputs["Color"], final_rough_em.inputs["Color"])
    links.new(rough_final.outputs["Value"], princ.inputs["Roughness"])

    # Bump: fine Noise + Voronoi
    bump_noise = nodes.new("ShaderNodeTexNoise")
    bump_noise.location = (-400, -200)
    bump_noise.inputs["Scale"].default_value = 40.0
    links.new(texcoord.outputs["Object"], bump_noise.inputs["Vector"])

    bump = nodes.new("ShaderNodeBump")
    bump.location = (600, -350)
    bump.inputs["Strength"].default_value = 0.35
    bump.inputs["Distance"].default_value = 0.02
    links.new(bump_noise.outputs["Fac"], bump.inputs["Height"])
    links.new(voronoi.outputs["Distance"], bump.inputs["Height"])
    # Prefer voronoi for wart-scale; mix via math
    bump_mix = nodes.new("ShaderNodeMath")
    bump_mix.operation = "ADD"
    bump_mix.location = (400, -300)
    links.new(bump_noise.outputs["Fac"], bump_mix.inputs[0])
    vor_scaled = nodes.new("ShaderNodeMath")
    vor_scaled.operation = "MULTIPLY"
    vor_scaled.location = (200, -350)
    vor_scaled.inputs[1].default_value = 0.4
    links.new(voronoi.outputs["Distance"], vor_scaled.inputs[0])
    links.new(vor_scaled.outputs["Value"], bump_mix.inputs[1])
    links.new(bump_mix.outputs["Value"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], princ.inputs["Normal"])

    links.new(princ.outputs["BSDF"], out.inputs["Surface"])

    frog.data.materials.append(mat)

    # UV unwrap for bake
    _deselect_all()
    _link_active(frog)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")

    result = {"material": mat.name, "nodes": len(nodes)}
    print("step_material:", result)
    return result


# ---------------------------------------------------------------------------
# step_stage — ground, lights, optional HDR
# ---------------------------------------------------------------------------

def step_stage():
    # Ground plane
    if "Ground" in bpy.data.objects:
        bpy.data.objects.remove(bpy.data.objects["Ground"], do_unlink=True)
    bpy.ops.mesh.primitive_plane_add(size=4.0, location=(0, 0.3, 0))
    ground = bpy.context.active_object
    ground.name = "Ground"
    gmat = bpy.data.materials.new("GroundMat")
    gmat.use_nodes = True
    nt = gmat.node_tree
    p = nt.nodes.get("Principled BSDF")
    if p:
        p.inputs["Base Color"].default_value = (0.15, 0.18, 0.12, 1)
        p.inputs["Roughness"].default_value = 0.85
    ground.data.materials.append(gmat)

    # Lights
    for name in ("Key", "Fill", "Rim"):
        if name in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[name], do_unlink=True)

    bpy.ops.object.light_add(type="AREA", location=(1.5, -1.0, 2.0))
    key = bpy.context.active_object
    key.name = "Key"
    key.data.energy = 80
    key.data.size = 1.2
    key.rotation_euler = (math.radians(50), 0, math.radians(40))

    bpy.ops.object.light_add(type="AREA", location=(-1.2, 1.5, 1.2))
    fill = bpy.context.active_object
    fill.name = "Fill"
    fill.data.energy = 30
    fill.data.size = 1.5

    bpy.ops.object.light_add(type="AREA", location=(0, 1.5, 0.8))
    rim = bpy.context.active_object
    rim.name = "Rim"
    rim.data.energy = 40
    rim.data.size = 0.8

    # World / HDR
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    wnt = world.node_tree
    wnt.nodes.clear()
    wout = wnt.nodes.new("ShaderNodeOutputWorld")
    bg = wnt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 0.6

    if HDR_PATH.is_file():
        env = wnt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(str(HDR_PATH))
        wnt.links.new(env.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = 0.85
    else:
        bg.inputs["Color"].default_value = (0.35, 0.42, 0.48, 1)

    wnt.links.new(bg.outputs["Background"], wout.inputs["Surface"])

    # Camera front¾
    if "CamFront34" in bpy.data.objects:
        bpy.data.objects.remove(bpy.data.objects["CamFront34"], do_unlink=True)
    bpy.ops.object.camera_add(location=(1.6, -1.4, 0.85))
    cam = bpy.context.active_object
    cam.name = "CamFront34"
    cam.rotation_euler = (math.radians(68), 0, math.radians(48))
    bpy.context.scene.camera = cam

    result = {"hdr": HDR_PATH.is_file(), "lights": 3}
    print("step_stage:", result)
    return result


# ---------------------------------------------------------------------------
# step_bake — Cycles EMIT color/rough + TANGENT NORMAL
# ---------------------------------------------------------------------------

def step_bake(res=1024):
    frog = bpy.data.objects.get("Frog")
    if frog is None:
        raise RuntimeError("Frog missing")
    mat = frog.data.materials[0]
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links

    princ = nodes.get("Principled")
    out = None
    for n in nodes:
        if n.type == "OUTPUT_MATERIAL":
            out = n
            break
    final_color = nodes.get("FINAL_COLOR")
    final_rough = nodes.get("FINAL_ROUGH")
    if not (princ and out and final_color and final_rough):
        raise RuntimeError("Missing bake hooks FINAL_COLOR / FINAL_ROUGH")

    # Create images
    def _img(name):
        if name in bpy.data.images:
            bpy.data.images.remove(bpy.data.images[name])
        img = bpy.data.images.new(name, width=res, height=res, alpha=False)
        img.filepath_raw = str(TEXTURES / f"{name}.png")
        img.file_format = "PNG"
        return img

    img_color = _img("FrogSkin_Color")
    img_rough = _img("FrogSkin_Rough")
    img_normal = _img("FrogSkin_Normal")

    # Image texture nodes for bake targets
    def _tex_node(name, img, loc):
        if name in nodes:
            nodes.remove(nodes[name])
        n = nodes.new("ShaderNodeTexImage")
        n.name = name
        n.image = img
        n.location = loc
        return n

    tex_c = _tex_node("BakeColor", img_color, (750, 400))
    tex_r = _tex_node("BakeRough", img_rough, (750, -400))
    tex_n = _tex_node("BakeNormal", img_normal, (750, -600))

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 32
    scene.cycles.bake_type = "EMIT"
    try:
        scene.cycles.device = "CPU"
    except Exception:
        pass

    _deselect_all()
    _link_active(frog)

    # --- Bake COLOR via FINAL_COLOR emission ---
    # Temporarily route FINAL_COLOR → Output
    for l in list(links):
        if l.to_node == out and l.to_socket.name == "Surface":
            links.remove(l)
    links.new(final_color.outputs["Emission"], out.inputs["Surface"])
    nodes.active = tex_c
    tex_c.select = True
    bpy.ops.object.bake(type="EMIT", margin=4)
    img_color.save()

    # --- Bake ROUGHNESS ---
    for l in list(links):
        if l.to_node == out and l.to_socket.name == "Surface":
            links.remove(l)
    links.new(final_rough.outputs["Emission"], out.inputs["Surface"])
    nodes.active = tex_r
    tex_r.select = True
    bpy.ops.object.bake(type="EMIT", margin=4)
    img_rough.save()

    # --- Bake NORMAL (restore Principled first for geometry normals + bump) ---
    for l in list(links):
        if l.to_node == out and l.to_socket.name == "Surface":
            links.remove(l)
    links.new(princ.outputs["BSDF"], out.inputs["Surface"])
    nodes.active = tex_n
    tex_n.select = True
    scene.cycles.bake_type = "NORMAL"
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", margin=4)
    img_normal.save()

    # Rewire Principled to baked images (glTF-safe)
    # Disconnect procedural Base Color / Roughness / Normal
    for sock_name in ("Base Color", "Roughness", "Normal"):
        sock = princ.inputs[sock_name]
        for l in list(sock.links):
            links.remove(l)

    links.new(tex_c.outputs["Color"], princ.inputs["Base Color"])

    # Roughness: use color → separate
    sep_r = nodes.new("ShaderNodeSeparateColor")
    sep_r.location = (900, -400)
    links.new(tex_r.outputs["Color"], sep_r.inputs["Color"])
    try:
        links.new(sep_r.outputs["Red"], princ.inputs["Roughness"])
    except Exception:
        links.new(tex_r.outputs["Color"], princ.inputs["Roughness"])

    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.location = (900, -600)
    links.new(tex_n.outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], princ.inputs["Normal"])

    # Pack images
    for img in (img_color, img_rough, img_normal):
        img.pack()

    result = {
        "color": img_color.filepath_raw,
        "rough": img_rough.filepath_raw,
        "normal": img_normal.filepath_raw,
        "res": res,
    }
    print("step_bake:", result)
    return result


# ---------------------------------------------------------------------------
# step_export — GLB with frog + eyes
# ---------------------------------------------------------------------------

def step_export():
    _deselect_all()
    names = ["Frog", "Eye_L", "Eye_R", "Eye_L_Iris", "Eye_R_Iris", "Eye_L_Pupil", "Eye_R_Pupil"]
    selected = []
    for n in names:
        o = bpy.data.objects.get(n)
        if o:
            o.select_set(True)
            selected.append(n)
    frog = bpy.data.objects.get("Frog")
    if frog:
        bpy.context.view_layer.objects.active = frog

    if GLB_PATH.exists():
        GLB_PATH.unlink()

    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        use_selection=True,
        export_format="GLB",
        export_apply=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_texcoords=True,
        export_normals=True,
    )

    size = GLB_PATH.stat().st_size if GLB_PATH.exists() else 0
    verts = len(frog.data.vertices) if frog else 0
    faces = len(frog.data.polygons) if frog else 0
    result = {"glb": str(GLB_PATH), "bytes": size, "selected": selected, "verts": verts, "faces": faces}
    print("step_export:", result)
    return result


# ---------------------------------------------------------------------------
# step_render — multi-angle stills (Eevee)
# ---------------------------------------------------------------------------

def step_render():
    _ensure_dirs()
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in dir(bpy.types) or hasattr(bpy.types, "EEVEE") else "BLENDER_EEVEE"
    # Try eevee next, fall back
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        scene.render.engine = "BLENDER_EEVEE"

    scene.render.resolution_x = 1280
    scene.render.resolution_y = 960
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False

    # Framing target: frog bbox center
    frog = bpy.data.objects.get("Frog")
    if frog is None:
        raise RuntimeError("Frog missing")

    bbox = [frog.matrix_world @ Vector(c) for c in frog.bound_box]
    center = sum(bbox, Vector()) / 8.0
    # Slight bias toward head
    target = Vector((center.x, center.y + 0.1, center.z + 0.05))

    # Front¾ looks toward snout (+Y); side from +X; top down
    views = {
        "front34": (Vector((1.15, 2.05, 0.85)), "front34.png"),
        "side": (Vector((2.35, 0.45, 0.65)), "side.png"),
        "top": (Vector((0.05, 0.4, 2.55)), "top.png"),
    }

    # Ensure camera
    cam = bpy.data.objects.get("CamFront34")
    if cam is None:
        bpy.ops.object.camera_add()
        cam = bpy.context.active_object
        cam.name = "CamFront34"
    scene.camera = cam

    paths = {}
    for key, (loc, fname) in views.items():
        cam.location = loc
        direction = target - cam.location
        cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        out_path = REPORTS / fname
        scene.render.filepath = str(out_path)
        bpy.ops.render.render(write_still=True)
        paths[key] = str(out_path)
        print(f"rendered {key} -> {out_path}")

    result = {"paths": paths, "target": list(target)}
    print("step_render:", result)
    return result


def step_stats():
    frog = bpy.data.objects.get("Frog")
    glb_bytes = GLB_PATH.stat().st_size if GLB_PATH.exists() else 0
    return {
        "verts": len(frog.data.vertices) if frog else 0,
        "faces": len(frog.data.polygons) if frog else 0,
        "glb_bytes": glb_bytes,
        "objects": [o.name for o in bpy.data.objects],
    }
