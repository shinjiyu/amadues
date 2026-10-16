"""
滑稽丸 — comedy anime chibi (NOT a frog).
One-shot bpy authoring: giant head, tiny body, huge eyes, silly grin, ahoge.
Run via bridge: load module, then call step_* separately (each < ~120s).
"""
from __future__ import annotations

import math
import os
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector, Matrix, Euler

# ---------------------------------------------------------------------------
WORK = Path(__file__).resolve().parent
REPORTS = WORK / "reports"
TEX = WORK / "textures"
GLB_PATH = WORK / "chibi.glb"

# Proportions (+Y forward, Z up)
HEAD_CENTER = Vector((0.0, 0.12, 0.58))
HEAD_R = 0.30
BODY_TOP_Z = 0.32
BODY_BOT_Z = 0.05
BODY_R_MAX = 0.13


def _clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.meshes):
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        if block.users == 0:
            bpy.data.materials.remove(block)
    for block in list(bpy.data.images):
        if block.users == 0 and block.name.startswith("Chibi"):
            bpy.data.images.remove(block)


def _shade_smooth(obj: bpy.types.Object):
    mesh = obj.data
    for p in mesh.polygons:
        p.use_smooth = True
    if hasattr(mesh, "use_auto_smooth"):
        mesh.use_auto_smooth = True


def _ensure_dirs():
    REPORTS.mkdir(parents=True, exist_ok=True)
    TEX.mkdir(parents=True, exist_ok=True)


def _new_mesh_obj(name: str, bm: bmesh.types.BMesh) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def _uv_sphere(name: str, center: Vector, radius: float, segments=32, rings=16) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=radius)
    bmesh.ops.translate(bm, verts=bm.verts, vec=center)
    obj = _new_mesh_obj(name, bm)
    _shade_smooth(obj)
    return obj


def _ico_sphere(name: str, center: Vector, radius: float, subdiv=2) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=radius)
    bmesh.ops.translate(bm, verts=bm.verts, vec=center)
    obj = _new_mesh_obj(name, bm)
    _shade_smooth(obj)
    return obj


def _cylinder(name: str, loc: Vector, radius: float, depth: float, axis="Z", verts=16) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=verts,
        radius1=radius,
        radius2=radius,
        depth=depth,
    )
    if axis == "X":
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, "Y"))
    elif axis == "Y":
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, "X"))
    bmesh.ops.translate(bm, verts=bm.verts, vec=loc)
    obj = _new_mesh_obj(name, bm)
    _shade_smooth(obj)
    return obj


def _disc(name: str, loc: Vector, radius: float, thickness=0.04, verts=24) -> bpy.types.Object:
    return _cylinder(name, loc, radius, thickness, axis="Z", verts=verts)


def _skin_chain(name: str, points: list[Vector], radii: list[float]) -> bpy.types.Object:
    """Build a Skin-modifier limb from a polyline of vertices."""
    mesh = bpy.data.meshes.new(name)
    edges = [(i, i + 1) for i in range(len(points) - 1)]
    mesh.from_pydata([tuple(p) for p in points], edges, [])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    skin = obj.modifiers.new("Skin", "SKIN")
    skin.use_smooth_shade = True
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.object.skin_root_mark()
    bpy.ops.object.mode_set(mode="OBJECT")

    # Skin radius lives on skin_vertices, not vertex groups
    skin_verts = obj.data.skin_vertices[0].data
    for i, sv in enumerate(skin_verts):
        r = radii[min(i, len(radii) - 1)]
        sv.radius = (r, r)

    # Apply skin + remesh lightly for solid volume
    bpy.ops.object.modifier_apply(modifier="Skin")
    remesh = obj.modifiers.new("Remesh", "REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = 0.012
    bpy.ops.object.modifier_apply(modifier="Remesh")
    # Light smooth
    smooth = obj.modifiers.new("Smooth", "SMOOTH")
    smooth.factor = 0.5
    smooth.iterations = 8
    bpy.ops.object.modifier_apply(modifier="Smooth")
    _shade_smooth(obj)
    obj.select_set(False)
    return obj


def _join_objects(objs: list[bpy.types.Object], name: str) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    objs[0].name = name
    return objs[0]


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------

def _principled(mat: bpy.types.Material):
    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (400, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (0, 0)
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return bsdf, nodes, links


def _make_skin_mat() -> bpy.types.Material:
    mat = bpy.data.materials.new("ChibiSkin")
    mat.use_nodes = True
    bsdf, nodes, links = _principled(mat)
    bsdf.inputs["Base Color"].default_value = (1.0, 0.72, 0.58, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.42
    if "Subsurface Weight" in bsdf.inputs:
        bsdf.inputs["Subsurface Weight"].default_value = 0.15
        bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.35, 0.2)
    # Hook FINAL_COLOR / FINAL_ROUGH for bake
    rgb = nodes.new("ShaderNodeRGB")
    rgb.name = "FINAL_COLOR"
    rgb.label = "FINAL_COLOR"
    rgb.outputs[0].default_value = (1.0, 0.72, 0.58, 1.0)
    rgb.location = (-300, 100)
    links.new(rgb.outputs[0], bsdf.inputs["Base Color"])
    val = nodes.new("ShaderNodeValue")
    val.name = "FINAL_ROUGH"
    val.label = "FINAL_ROUGH"
    val.outputs[0].default_value = 0.45
    val.location = (-300, -80)
    links.new(val.outputs[0], bsdf.inputs["Roughness"])
    return mat


def _make_solid_mat(name: str, color: tuple, rough=0.4) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf, nodes, links = _principled(mat)
    rgb = nodes.new("ShaderNodeRGB")
    rgb.name = "FINAL_COLOR"
    rgb.label = "FINAL_COLOR"
    rgb.outputs[0].default_value = (*color[:3], 1.0)
    rgb.location = (-300, 100)
    links.new(rgb.outputs[0], bsdf.inputs["Base Color"])
    val = nodes.new("ShaderNodeValue")
    val.name = "FINAL_ROUGH"
    val.label = "FINAL_ROUGH"
    val.outputs[0].default_value = rough
    val.location = (-300, -80)
    links.new(val.outputs[0], bsdf.inputs["Roughness"])
    bsdf.inputs["Roughness"].default_value = rough
    return mat


def _make_eye_white() -> bpy.types.Material:
    return _make_solid_mat("ChibiEyeWhite", (0.98, 0.98, 1.0), 0.25)


def _make_iris() -> bpy.types.Material:
    mat = _make_solid_mat("ChibiIris", (0.25, 0.55, 0.95), 0.2)
    # slight specular pop via low roughness already
    return mat


def _make_pupil() -> bpy.types.Material:
    return _make_solid_mat("ChibiPupil", (0.05, 0.05, 0.08), 0.35)


def _make_highlight() -> bpy.types.Material:
    mat = bpy.data.materials.new("ChibiHighlight")
    mat.use_nodes = True
    bsdf, nodes, links = _principled(mat)
    rgb = nodes.new("ShaderNodeRGB")
    rgb.name = "FINAL_COLOR"
    rgb.label = "FINAL_COLOR"
    rgb.outputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
    rgb.location = (-300, 100)
    links.new(rgb.outputs[0], bsdf.inputs["Base Color"])
    if "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = (1.0, 1.0, 1.0, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 0.8
    val = nodes.new("ShaderNodeValue")
    val.name = "FINAL_ROUGH"
    val.label = "FINAL_ROUGH"
    val.outputs[0].default_value = 0.1
    val.location = (-300, -80)
    links.new(val.outputs[0], bsdf.inputs["Roughness"])
    return mat


def _make_mouth() -> bpy.types.Material:
    return _make_solid_mat("ChibiMouth", (0.35, 0.08, 0.12), 0.55)


def _make_blush() -> bpy.types.Material:
    mat = bpy.data.materials.new("ChibiBlush")
    mat.use_nodes = True
    bsdf, nodes, links = _principled(mat)
    rgb = nodes.new("ShaderNodeRGB")
    rgb.name = "FINAL_COLOR"
    rgb.label = "FINAL_COLOR"
    rgb.outputs[0].default_value = (1.0, 0.45, 0.55, 1.0)
    rgb.location = (-300, 100)
    links.new(rgb.outputs[0], bsdf.inputs["Base Color"])
    if "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = (1.0, 0.4, 0.5, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 0.15
    if "Alpha" in bsdf.inputs:
        bsdf.inputs["Alpha"].default_value = 0.85
    mat.blend_method = "BLEND" if hasattr(mat, "blend_method") else mat.blend_method
    val = nodes.new("ShaderNodeValue")
    val.name = "FINAL_ROUGH"
    val.label = "FINAL_ROUGH"
    val.outputs[0].default_value = 0.5
    val.location = (-300, -80)
    links.new(val.outputs[0], bsdf.inputs["Roughness"])
    return mat


def _make_hair() -> bpy.types.Material:
    return _make_solid_mat("ChibiHair", (0.15, 0.35, 0.85), 0.35)


def _make_vest() -> bpy.types.Material:
    return _make_solid_mat("ChibiVest", (0.92, 0.28, 0.22), 0.4)


def _assign(obj: bpy.types.Object, mat: bpy.types.Material):
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)


# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

def step_mesh():
    """Giant head + tiny pear body + stubby limbs + ahoge."""
    _ensure_dirs()
    _clear_scene()

    # --- HEAD (dominant volume) ---
    head = _uv_sphere("Head", HEAD_CENTER, HEAD_R, segments=40, rings=20)

    # --- BODY (short pear via Skin) ---
    body_pts = [
        Vector((0.0, 0.08, 0.34)),
        Vector((0.0, 0.10, 0.22)),
        Vector((0.0, 0.10, 0.10)),
        Vector((0.0, 0.08, 0.04)),
    ]
    body_r = [0.11, 0.13, 0.12, 0.09]
    body = _skin_chain("Body", body_pts, body_r)

    # --- ARMS (stubby mitten) ---
    arm_L = _skin_chain(
        "Arm_L",
        [
            Vector((-0.12, 0.08, 0.30)),
            Vector((-0.22, 0.10, 0.24)),
            Vector((-0.28, 0.12, 0.18)),
        ],
        [0.045, 0.042, 0.055],
    )
    arm_R = _skin_chain(
        "Arm_R",
        [
            Vector((0.12, 0.08, 0.30)),
            Vector((0.22, 0.10, 0.24)),
            Vector((0.28, 0.12, 0.18)),
        ],
        [0.045, 0.042, 0.055],
    )

    # --- LEGS + fat feet ---
    leg_L = _skin_chain(
        "Leg_L",
        [
            Vector((-0.06, 0.08, 0.08)),
            Vector((-0.07, 0.10, 0.03)),
            Vector((-0.07, 0.12, 0.01)),
        ],
        [0.04, 0.038, 0.045],
    )
    leg_R = _skin_chain(
        "Leg_R",
        [
            Vector((0.06, 0.08, 0.08)),
            Vector((0.07, 0.10, 0.03)),
            Vector((0.07, 0.12, 0.01)),
        ],
        [0.04, 0.038, 0.045],
    )
    foot_L = _disc("Foot_L", Vector((-0.07, 0.14, 0.015)), 0.07, 0.035)
    foot_R = _disc("Foot_R", Vector((0.07, 0.14, 0.015)), 0.07, 0.035)

    # --- AHOGE (spring hair from crown) ---
    ahoge = _skin_chain(
        "Ahoge",
        [
            Vector((0.0, 0.05, HEAD_CENTER.z + HEAD_R * 0.85)),
            Vector((0.04, -0.02, HEAD_CENTER.z + HEAD_R * 1.15)),
            Vector((-0.02, -0.06, HEAD_CENTER.z + HEAD_R * 1.35)),
            Vector((0.06, -0.02, HEAD_CENTER.z + HEAD_R * 1.50)),
        ],
        [0.022, 0.018, 0.015, 0.012],
    )

    # Tag for later material assignment
    for o in (head, body, arm_L, arm_R, leg_L, leg_R, foot_L, foot_R):
        o["chibi_part"] = "skin"
    body["chibi_part"] = "vest"
    ahoge["chibi_part"] = "hair"
    head["chibi_part"] = "skin"

    # Count verts
    total = sum(len(o.data.vertices) for o in bpy.data.objects if o.type == "MESH")
    parts = {o.name: len(o.data.vertices) for o in bpy.data.objects if o.type == "MESH"}
    result = {"ok": True, "total_verts": total, "parts": parts}
    return result


def _flat_disc(name: str, center: Vector, radius: float, thickness=0.02, verts=28) -> bpy.types.Object:
    """Disc whose flat face points toward -Y (camera)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        cap_tris=False,
        segments=verts,
        radius1=radius,
        radius2=radius,
        depth=thickness,
    )
    bmesh.ops.rotate(
        bm,
        verts=bm.verts,
        cent=(0, 0, 0),
        matrix=Matrix.Rotation(math.pi / 2, 3, "X"),
    )
    bmesh.ops.translate(bm, verts=bm.verts, vec=center)
    obj = _new_mesh_obj(name, bm)
    _shade_smooth(obj)
    return obj


def step_face():
    """Huge shiny anime eyes (flat discs) + silly open grin + blush.

    Face sits on the -Y hemisphere so cameras at -Y (front¾) see expression.
    Flat discs avoid iris/pupil getting buried inside spherical sclera.
    """
    face_y = HEAD_CENTER.y - HEAD_R * 0.92
    eye_z = HEAD_CENTER.z + 0.06
    eye_x = 0.115

    for side, x in (("L", -eye_x), ("R", eye_x)):
        scl = _flat_disc(f"EyeWhite_{side}", Vector((x, face_y, eye_z)), 0.112, 0.028)
        scl["chibi_part"] = "eye_white"
        iris = _flat_disc(f"Iris_{side}", Vector((x, face_y - 0.022, eye_z - 0.008)), 0.07, 0.022)
        iris["chibi_part"] = "iris"
        pupil = _flat_disc(f"Pupil_{side}", Vector((x, face_y - 0.038, eye_z - 0.008)), 0.036, 0.02)
        pupil["chibi_part"] = "pupil"
        hl1 = _ico_sphere(f"HL1_{side}", Vector((x - 0.03, face_y - 0.055, eye_z + 0.038)), 0.024, 1)
        hl1["chibi_part"] = "highlight"
        hl2 = _ico_sphere(f"HL2_{side}", Vector((x + 0.024, face_y - 0.052, eye_z - 0.032)), 0.013, 1)
        hl2["chibi_part"] = "highlight"

    mouth = _uv_sphere("Mouth", Vector((0.0, face_y + 0.02, HEAD_CENTER.z - 0.13)), 0.085, 20, 10)
    mouth.scale = Vector((1.5, 0.55, 0.95))
    mouth["chibi_part"] = "mouth"
    bpy.context.view_layer.update()

    tongue = _uv_sphere(
        "Tongue",
        Vector((0.0, face_y - 0.012, HEAD_CENTER.z - 0.145)),
        0.035,
        12,
        6,
    )
    tongue.scale = Vector((1.35, 0.5, 0.55))
    tongue["chibi_part"] = "tongue"

    for side, x in (("L", -0.20), ("R", 0.20)):
        blush = _uv_sphere(f"Blush_{side}", Vector((x, face_y + 0.08, HEAD_CENTER.z - 0.03)), 0.042, 12, 8)
        blush.scale = Vector((1.35, 0.4, 0.9))
        blush["chibi_part"] = "blush"

    for side, x, rz in (("L", -eye_x, 18), ("R", eye_x, -18)):
        brow = _cylinder(f"Brow_{side}", Vector((x, face_y - 0.01, eye_z + 0.13)), 0.014, 0.10, axis="X", verts=10)
        brow.rotation_euler = Euler((0, 0, math.radians(rz)), "XYZ")
        brow.scale = Vector((1.0, 0.45, 0.45))
        brow["chibi_part"] = "hair"

    total = sum(len(o.data.vertices) for o in bpy.data.objects if o.type == "MESH")
    return {"ok": True, "total_verts": total, "face_parts": 16}


def step_material():
    """Assign flat-ish toon PBR materials."""
    mats = {
        "skin": _make_skin_mat(),
        "vest": _make_vest(),
        "hair": _make_hair(),
        "eye_white": _make_eye_white(),
        "iris": _make_iris(),
        "pupil": _make_pupil(),
        "highlight": _make_highlight(),
        "mouth": _make_mouth(),
        "tongue": _make_solid_mat("ChibiTongue", (1.0, 0.45, 0.5), 0.4),
        "blush": _make_blush(),
    }
    assigned = {}
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        part = obj.get("chibi_part", "skin")
        mat = mats.get(part, mats["skin"])
        _assign(obj, mat)
        assigned[obj.name] = part
    return {"ok": True, "assigned": assigned}


def step_stage():
    """Simple three-point light + camera framing for front¾."""
    # Remove old cameras/lights/ground
    for o in list(bpy.data.objects):
        if o.type in {"CAMERA", "LIGHT"} or o.name == "Ground":
            bpy.data.objects.remove(o, do_unlink=True)

    # Flat world — no leftover HDR / forest from prior files
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs[0].default_value = (0.62, 0.70, 0.80, 1.0)
    bg.inputs[1].default_value = 0.85
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(bg.outputs[0], out.inputs[0])

    # Key / fill / rim — light the -Y face
    key = bpy.data.objects.new("KeyLight", bpy.data.lights.new("KeyLight", "AREA"))
    key.data.energy = 280
    key.data.size = 1.5
    key.location = (1.0, -1.6, 1.5)
    key.rotation_euler = Euler((math.radians(55), 0, math.radians(25)), "XYZ")
    bpy.context.collection.objects.link(key)

    fill = bpy.data.objects.new("FillLight", bpy.data.lights.new("FillLight", "AREA"))
    fill.data.energy = 100
    fill.data.size = 2.0
    fill.location = (-1.3, -1.0, 1.0)
    fill.rotation_euler = Euler((math.radians(55), 0, math.radians(-35)), "XYZ")
    bpy.context.collection.objects.link(fill)

    rim = bpy.data.objects.new("RimLight", bpy.data.lights.new("RimLight", "AREA"))
    rim.data.energy = 140
    rim.data.size = 1.0
    rim.location = (0.2, 1.6, 1.3)
    rim.rotation_euler = Euler((math.radians(-25), 0, math.radians(180)), "XYZ")
    bpy.context.collection.objects.link(rim)

    # Camera front¾ — from -Y so face (eyes on -Y) reads clearly
    look = HEAD_CENTER + Vector((0, -0.05, -0.05))
    cam_data = bpy.data.cameras.new("CamFront34")
    cam_data.lens = 55
    cam = bpy.data.objects.new("CamFront34", cam_data)
    cam.location = (0.75, -1.45, 0.58)
    cam.rotation_euler = (look - cam.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    cam_s = bpy.data.objects.new("CamSide", bpy.data.cameras.new("CamSide"))
    cam_s.data.lens = 55
    cam_s.location = (-1.75, -0.35, 0.55)
    cam_s.rotation_euler = (look - cam_s.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.collection.objects.link(cam_s)

    cam_t = bpy.data.objects.new("CamTop", bpy.data.cameras.new("CamTop"))
    cam_t.data.lens = 50
    cam_t.location = (0.0, -0.25, 2.15)
    cam_t.rotation_euler = (look - cam_t.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.collection.objects.link(cam_t)

    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=4, y_segments=4, size=1.5)
    ground = _new_mesh_obj("Ground", bm)
    ground.location = (0, 0, 0)
    gmat = _make_solid_mat("ChibiGround", (0.82, 0.84, 0.88), 0.75)
    _assign(ground, gmat)

    # Prefer EEVEE for fast stills
    engines = {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items}
    if "BLENDER_EEVEE_NEXT" in engines:
        bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    elif "BLENDER_EEVEE" in engines:
        bpy.context.scene.render.engine = "BLENDER_EEVEE"
    else:
        bpy.context.scene.render.engine = "CYCLES"
        bpy.context.scene.cycles.samples = 32
    bpy.context.scene.render.resolution_x = 960
    bpy.context.scene.render.resolution_y = 960
    bpy.context.scene.render.film_transparent = False

    return {"ok": True, "camera": cam.name, "cam_loc": list(cam.location)}


def step_render():
    """Render front34 / side / top PNGs into reports/."""
    _ensure_dirs()
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "PNG"
    cams = [
        ("CamFront34", REPORTS / "front34.png"),
        ("CamSide", REPORTS / "side.png"),
        ("CamTop", REPORTS / "top.png"),
    ]
    out = {}
    for cam_name, path in cams:
        cam = bpy.data.objects.get(cam_name)
        if not cam:
            out[cam_name] = "missing"
            continue
        scene.camera = cam
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        out[str(path.name)] = {"bytes": path.stat().st_size if path.exists() else 0}
    # restore front cam
    if bpy.data.objects.get("CamFront34"):
        scene.camera = bpy.data.objects["CamFront34"]
    return {"ok": True, "renders": out}


def _smart_uv(obj: bpy.types.Object):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")


def step_bake():
    """Bake FINAL_COLOR to images so GLB keeps look (flat toon → solid maps)."""
    _ensure_dirs()
    baked = []
    for obj in list(bpy.data.objects):
        if obj.type != "MESH" or obj.name == "Ground":
            continue
        if not obj.data.materials:
            continue
        mat = obj.data.materials[0]
        if not mat or not mat.use_nodes:
            continue
        nt = mat.node_tree
        final = nt.nodes.get("FINAL_COLOR")
        if not final:
            continue

        _smart_uv(obj)

        size = 512 if obj.name == "Head" else 256
        img_name = f"ChibiBake_{obj.name}"
        img = bpy.data.images.get(img_name)
        if img is None:
            img = bpy.data.images.new(img_name, size, size, alpha=True)
        elif img.size[0] != size:
            bpy.data.images.remove(img)
            img = bpy.data.images.new(img_name, size, size, alpha=True)

        col = list(final.outputs[0].default_value)
        img.pixels = [col[0], col[1], col[2], 1.0] * (size * size)

        tex = nt.nodes.get("BAKE_TARGET") or nt.nodes.new("ShaderNodeTexImage")
        tex.name = "BAKE_TARGET"
        tex.image = img
        tex.location = (-600, 200)
        for n in nt.nodes:
            n.select = False
        tex.select = True
        nt.nodes.active = tex

        bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf:
            for link in list(bsdf.inputs["Base Color"].links):
                nt.links.remove(link)
            nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

        img_path = TEX / f"{obj.name}_Color.png"
        img.filepath_raw = str(img_path)
        img.file_format = "PNG"
        img.save()
        baked.append({"obj": obj.name, "ok": True, "size": size, "color": col[:3]})

    return {"ok": True, "baked": baked, "mode": "solid_FINAL_COLOR"}


def step_export():
    """Export baked meshes to chibi.glb (no ground)."""
    _ensure_dirs()
    bpy.ops.object.select_all(action="DESELECT")
    count = 0
    verts = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        if obj.name == "Ground":
            continue
        obj.select_set(True)
        count += 1
        verts += len(obj.data.vertices)
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="EXPORT",
        export_texcoords=True,
        export_normals=True,
        export_image_format="AUTO",
    )
    size = GLB_PATH.stat().st_size if GLB_PATH.exists() else 0
    return {
        "ok": True,
        "path": str(GLB_PATH),
        "bytes": size,
        "objects": count,
        "verts": verts,
    }


def step_all():
    r = {}
    r["mesh"] = step_mesh()
    r["face"] = step_face()
    r["material"] = step_material()
    r["stage"] = step_stage()
    return r


if __name__ == "__main__":
    print(step_all())
