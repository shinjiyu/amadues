"""Fantasy sac-frog from reference image. Run step by step inside Blender:

    exec(open(PATH).read(), globals()); step_reset(); step_body(); ...

Frog faces -Y, Z up, origin under the belly. Units ~ metres (frog ~3.4 wide incl. feet).
"""
import bpy, bmesh, math
from mathutils import Vector, Quaternion, noise
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

OUT = '/Users/shinjiyu/Documents/amadues/experiments/fantasy-frog'
THRESH = 0.6


# ---------------------------------------------------------------- helpers
def _link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def _vis(s):
    return math.sqrt(1.0 - (THRESH / s) ** (1.0 / 3.0))


def _qdir(d):
    return Vector((1, 0, 0)).rotation_difference(Vector(d).normalized())


def _ellip(mb, co, semi, s=2.0, rot=None):
    el = mb.elements.new(type='ELLIPSOID')
    el.co = co
    el.radius = 1.0 / _vis(s)
    el.size_x, el.size_y, el.size_z = semi
    el.stiffness = s
    if rot is not None:
        el.rotation = rot
    return el


def _cap(mb, a, b, r, s=3.0):
    a, b = Vector(a), Vector(b)
    el = mb.elements.new(type='CAPSULE')
    el.co = (a + b) / 2
    el.radius = r / _vis(s)
    el.size_x = max((b - a).length / 2, 1e-4)
    el.rotation = _qdir(b - a)
    el.stiffness = s
    return el


def _ball(mb, co, r, s=4.0):
    el = mb.elements.new(type='BALL')
    el.co = co
    el.radius = r / _vis(s)
    el.stiffness = s
    return el


def _sm(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def _mix(a, b, t):
    return tuple(a[i] * (1 - t) + b[i] * t for i in range(3))


def _digit(mb, root, ang_deg, side, length, r, pad_r, arch=0.06, fwd=(0, -1)):
    """One finger/toe on the ground: two segments, knuckle bump, bulbous pad."""
    a = math.radians(ang_deg)
    f = Vector((fwd[0], fwd[1], 0)).normalized()
    out = Vector((side, 0, 0))
    d = (f * math.cos(a) + out * math.sin(a)).normalized()
    p0 = Vector(root)
    p1 = p0 + d * length * 0.5
    p1.z = p0.z + arch
    p2 = p0 + d * length
    p2.z = pad_r * 0.95
    _cap(mb, p0, p1, r, 6.0)
    _cap(mb, p1, p2, r * 0.8, 6.0)
    _ball(mb, p1, r * 1.25, 6.0)
    _ball(mb, p2 + d * pad_r * 0.35, pad_r, 7.0)


def _mat(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    out.location = (600, 0)
    return m, nt, out


def _set_col(me, fn):
    """fn(index, co, normal) -> rgb; writes POINT color attribute 'Col'."""
    # compute everything before touching the attribute: each write re-tags the mesh
    # and the next v.normal read would recompute normals for the whole mesh
    buf = []
    for v in me.vertices:
        c = fn(v.index, v.co.copy(), v.normal.copy())
        # palettes are authored in sRGB; FLOAT_COLOR is linear
        buf.extend((max(c[0], 0) ** 2.2, max(c[1], 0) ** 2.2, max(c[2], 0) ** 2.2, 1.0))
    if 'Col' in me.color_attributes:
        me.color_attributes.remove(me.color_attributes['Col'])
    ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    ca.data.foreach_set('color', buf)
    me.color_attributes.active_color = ca


def _smooth_shade(me):
    for p in me.polygons:
        p.use_smooth = True


# ---------------------------------------------------------------- steps
def step_reset():
    # read_homefile would reload prefs and drop the MCP bridge addon
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    for coll in (bpy.data.meshes, bpy.data.metaballs, bpy.data.materials, bpy.data.cameras,
                 bpy.data.lights, bpy.data.images, bpy.data.curves):
        for d in list(coll):
            coll.remove(d)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.unit_settings.system = 'METRIC'
    return 'reset'


def step_body():
    mb = bpy.data.metaballs.new('FrogMeta')
    mb.resolution = 0.014
    mb.render_resolution = 0.014
    mb.threshold = THRESH
    ob = _link(bpy.data.objects.new('FrogMeta', mb))

    E = lambda co, semi, s=2.0, rot=None: _ellip(mb, co, semi, s, rot)
    C = lambda a, b, r, s=3.0: _cap(mb, a, b, r, s)

    # torso: squat, wide, rounded; rear bulk
    E((0, 0.18, 0.56), (0.86, 0.8, 0.5))
    E((0, 0.62, 0.5), (0.74, 0.44, 0.4))
    # broad head merging into body, rounded snout, soft throat
    E((0, -0.48, 0.6), (0.72, 0.52, 0.32))
    E((0, -0.84, 0.54), (0.56, 0.3, 0.24))
    E((0, -0.6, 0.34), (0.6, 0.44, 0.22))

    for s in (-1, 1):
        # small eye bulges at the front corners of the head, soft brow
        E((s * 0.33, -0.93, 0.72), (0.1, 0.1, 0.075), 3.0)
        C((s * 0.24, -0.9, 0.78), (s * 0.44, -0.85, 0.76), 0.035, 4.0)
        # shoulder mass
        E((s * 0.62, -0.38, 0.44), (0.24, 0.26, 0.24), 2.5)

        # front leg: chunky upper arm out-forward, forearm down to the hand
        sh = Vector((s * 0.62, -0.42, 0.44))
        el = Vector((s * 0.93, -0.6, 0.38))
        wr = Vector((s * 0.96, -0.86, 0.1))
        C(sh, el, 0.17, 2.5)
        C(el, wr, 0.125, 3.0)
        _ball(mb, el, 0.15, 3.0)
        E((wr.x, wr.y - 0.03, 0.08), (0.14, 0.13, 0.075), 3.5)
        root = Vector((wr.x, wr.y - 0.06, 0.08))
        for ang, ln in ((-34, 0.3), (-4, 0.37), (28, 0.36), (62, 0.3)):
            _digit(mb, root, ang, s, ln, 0.046, 0.07)

        # hind leg: fat thigh folded forward-out, shin tucked back, foot out-forward
        hip = Vector((s * 0.6, 0.66, 0.42))
        kn = Vector((s * 1.1, 0.25, 0.34))
        an = Vector((s * 1.18, 0.68, 0.13))
        C(hip, kn, 0.26, 2.5)
        E((s * 0.95, 0.45, 0.42), (0.38, 0.42, 0.34), 2.5)
        C(kn, an, 0.15, 3.0)
        _ball(mb, kn, 0.19, 3.0)
        mt = Vector((s * 1.36, 0.4, 0.08))
        C(an, mt, 0.1, 3.5)
        for ang, ln in ((15, 0.3), (42, 0.38), (68, 0.42), (94, 0.38), (120, 0.28)):
            _digit(mb, mt, ang, s, ln, 0.042, 0.066)

    bpy.context.view_layer.update()
    return f'meta elements: {len(mb.elements)}'


def step_mesh():
    mo = bpy.data.objects['FrogMeta']
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(mo.evaluated_get(dg))
    me.name = 'FrogBody'
    old = bpy.data.objects.get('FrogBody')
    if old:
        bpy.data.objects.remove(old)
    body = _link(bpy.data.objects.new('FrogBody', me))
    mo.hide_viewport = True
    mo.hide_render = True

    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    bvh = BVHTree.FromBMesh(bm)

    # mouth line: wide, wrapping round the snout, corners rising slightly
    mouth = []
    for i in range(-44, 45):
        phi = math.radians(i * 2.0)
        d = Vector((math.sin(phi), -math.cos(phi), 0))
        z = 0.44 + 0.06 * (abs(i) / 44) ** 2
        o = Vector((0, -0.45, z)) + d * 3.0
        hit = bvh.ray_cast(o, -d)
        if hit[0] is not None:
            mouth.append(hit[0])
    kd = KDTree(len(mouth) * 8)
    k = 0
    for a, b in zip(mouth[:-1], mouth[1:]):
        for t in range(8):
            kd.insert(a.lerp(b, t / 8), k)
            k += 1
    kd.balance()

    # nostrils
    nos = []
    for s in (-1, 1):
        hit = bvh.ray_cast(Vector((s * 0.1, -1.02, 3)), Vector((0, 0, -1)))
        if hit[0] is not None:
            nos.append(hit[0])

    W, D = 0.03, 0.028
    for v in bm.verts:
        if v.co.y > -0.1:
            continue
        co, dist = kd.find(v.co)[0], kd.find(v.co)[2]
        if dist < W:
            f = (1 - (dist / W) ** 2) ** 2
            v.co -= v.normal * D * f
        elif dist < 2.6 * W and v.co.z > co.z:
            # upper lip rolls slightly over the crease
            f = math.sin(math.pi * (dist - W) / (1.6 * W))
            v.co += v.normal * 0.008 * f
        for n in nos:
            dn = (v.co - n).length
            if dn < 0.024:
                v.co -= v.normal * 0.014 * (1 - (dn / 0.024) ** 2)
    bmesh.ops.smooth_vert(bm, verts=[v for v in bm.verts if v.co.y < -0.2],
                          factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    # warty, lumpy toad skin; keep pads and the lip line smooth
    bm.normal_update()
    offs = []
    for v in bm.verts:
        co = v.co
        if co.z < 0.1 or kd.find(co)[2] < 0.05:
            offs.append(0.0)
            continue
        wart = max(0.0, noise.noise(co * 16.0) - 0.15) ** 1.4
        lump = noise.noise(co * 5.0 + Vector((3, 1, 0)))
        fold = abs(noise.noise(Vector((co.x * 3, co.y * 9, co.z * 9)) + Vector((0, 0, 7))))
        offs.append(0.02 * wart + 0.008 * lump - 0.006 * (1 - _sm(0.0, 0.12, fold)))
    for v, o in zip(bm.verts, offs):
        v.co += v.normal * o
    bm.to_mesh(me)
    bm.free()
    _smooth_shade(me)
    body['mouth'] = [tuple(p) for p in mouth]
    return f'body verts {len(me.vertices)} mouth pts {len(mouth)} nostrils {len(nos)}'


def step_eyes():
    body = bpy.data.objects['FrogBody']
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, dg)
    for s in (-1, 1):
        c = Vector((s * 0.33, -0.93, 0.72))
        d = Vector((s * 0.55, -1.0, 0.4)).normalized()
        hit = bvh.ray_cast(c + d * 2.0, -d)
        p, n = hit[0], hit[1]
        r = 0.062
        name = 'Eye_L' if s > 0 else 'Eye_R'
        old = bpy.data.objects.get(name)
        if old:
            bpy.data.objects.remove(old)
        me = bpy.data.meshes.new(name)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=r)
        bm.to_mesh(me)
        bm.free()
        _smooth_shade(me)
        ob = _link(bpy.data.objects.new(name, me))
        ob.location = p - n * 0.028
        gaze = Vector((s * 0.55, -1.0, 0.12)).normalized()
        ob.rotation_mode = 'QUATERNION'
        ob.rotation_quaternion = Vector((0, -1, 0)).rotation_difference(gaze)
        ob['r'] = r
    return 'eyes'


SAC_BIG = [
    (0.0, -0.2, 'b'), (0.24, -0.17, 'b'), (0.39, -0.05, 'b'), (0.48, 0.12, 'u'),
    (0.52, 0.32, 'u'), (0.51, 0.5, 'u'), (0.45, 0.66, 'u'), (0.35, 0.78, 'u'),
    (0.25, 0.85, 'n'), (0.19, 0.89, 'n'), (0.18, 0.93, 'l'), (0.21, 0.965, 'l'),
    (0.235, 1.0, 'l'), (0.23, 1.035, 'l'), (0.2, 1.055, 'l'), (0.165, 1.04, 'i'),
    (0.15, 0.99, 'i'), (0.13, 0.93, 'i'), (0.08, 0.89, 'i'), (0.0, 0.87, 'i'),
]
SAC_MID = [
    (0.0, -0.14, 'b'), (0.15, -0.12, 'b'), (0.25, -0.02, 'b'), (0.31, 0.12, 'u'),
    (0.32, 0.28, 'u'), (0.28, 0.43, 'u'), (0.2, 0.56, 'u'), (0.13, 0.65, 'n'),
    (0.1, 0.71, 'n'), (0.105, 0.76, 'l'), (0.14, 0.8, 'l'), (0.155, 0.83, 'l'),
    (0.145, 0.855, 'l'), (0.115, 0.855, 'i'), (0.09, 0.82, 'i'), (0.085, 0.77, 'i'),
    (0.05, 0.73, 'i'), (0.0, 0.72, 'i'),
]
SAC_SQUAT = [
    (0.0, -0.16, 'b'), (0.24, -0.14, 'b'), (0.36, -0.04, 'b'), (0.42, 0.1, 'u'),
    (0.43, 0.24, 'u'), (0.39, 0.38, 'u'), (0.31, 0.49, 'u'), (0.22, 0.56, 'n'),
    (0.17, 0.6, 'n'), (0.165, 0.64, 'l'), (0.2, 0.675, 'l'), (0.215, 0.71, 'l'),
    (0.2, 0.735, 'l'), (0.165, 0.735, 'i'), (0.14, 0.7, 'i'), (0.13, 0.65, 'i'),
    (0.08, 0.61, 'i'), (0.0, 0.6, 'i'),
]


def _sac(name, prof, loc, rot_deg, scale, wrinkle, wn, seed, palette, segs=72, rib=0.05):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old)
    zs = [p[1] for p in prof]
    z0, z1 = min(zs), max(zs)
    rim_z = min(p[1] for p in prof if p[2] == 'l')
    bm = bmesh.new()
    rings, info = [], []
    for r, z, tag in prof:
        h = (z - z0) / (z1 - z0)
        if r < 1e-6:
            rings.append([bm.verts.new((0, 0, z))])
            info.append([(tag, h, 0.0)])
            continue
        ring, inf = [], []
        for j in range(segs):
            th = 2 * math.pi * j / segs
            cs, sn = math.cos(th), math.sin(th)
            k = 1.0
            fold = 0.0
            if tag in 'ub':
                env = math.sin(math.pi * _sm(0.02, 0.8, h))
                ph = noise.noise(Vector((cs * 1.6, sn * 1.6, z * 2.5 + seed)))
                fold = (0.65 * math.sin(wn * th + 2.4 * ph)
                        + 0.35 * noise.noise(Vector((cs * 4, sn * 4, z * 5 + seed))))
                k *= 1 + wrinkle * env * fold
            k *= 1 + 0.022 * noise.noise(Vector((cs * 1.3, sn * 1.3, z * 1.7 + seed * 3)))
            if z >= rim_z - 1e-6:
                k *= 1 + rib * math.cos(16 * th + seed) + 0.5 * rib * noise.noise(Vector((cs * 3, sn * 3, seed)))
            ring.append(bm.verts.new((r * k * cs, r * k * sn, z)))
            inf.append((tag, h, fold))
        rings.append(ring)
        info.append(inf)
    for a, b in zip(rings[:-1], rings[1:]):
        if len(a) == 1:
            for j in range(segs):
                bm.faces.new((a[0], b[j], b[(j + 1) % segs]))
        elif len(b) == 1:
            for j in range(segs):
                bm.faces.new((a[j], a[(j + 1) % segs], b[0]))
        else:
            for j in range(segs):
                bm.faces.new((a[j], a[(j + 1) % segs], b[(j + 1) % segs], b[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    _smooth_shade(me)

    flat = [x for inf in info for x in inf]
    base, top, lip, inner, joint = palette

    def col(i, co, nrm):
        tag, h, fold = flat[i]
        if tag == 'i':
            return _mix(lip, inner, _sm(0.97, 0.9, h) * 0 + 0.85)
        if tag == 'l':
            return lip
        c = _mix(base, top, _sm(0.3, 0.85, h))
        if tag == 'n':
            c = _mix(top, lip, 0.35)
        c = _mix(c, joint, _sm(0.22, 0.02, h))
        c = tuple(x * (1 + 0.22 * fold) for x in c)
        return c

    _set_col(me, col)
    ob = _link(bpy.data.objects.new(name, me))
    ob.location = loc
    ob.rotation_euler = tuple(math.radians(a) for a in rot_deg)
    ob.scale = (scale, scale, scale)
    sub = ob.modifiers.new('Sub', 'SUBSURF')
    sub.levels = 1
    sub.render_levels = 2
    return ob


def step_sacs():
    joint = (0.5, 0.42, 0.38)
    big = _sac('Sac_Big', SAC_BIG, (-0.42, 0.1, 0.8), (-4, -12, 0), 1.12, 0.0, 9, 1.0,
               ((0.84, 0.64, 0.5), (0.82, 0.58, 0.42), (0.7, 0.4, 0.3), (0.3, 0.1, 0.08), joint), rib=0.035)
    mid = _sac('Sac_Mid', SAC_SQUAT, (0.18, 0.42, 0.88), (10, 6, 0), 1.15, 0.09, 10, 5.0,
               ((0.68, 0.62, 0.48), (0.72, 0.62, 0.47), (0.68, 0.42, 0.32), (0.28, 0.1, 0.08), joint))
    rgt = _sac('Sac_Rear', SAC_SQUAT, (0.84, 0.36, 0.62), (0, 48, -35), 1.1, 0.1, 9, 11.0,
               ((0.68, 0.62, 0.48), (0.7, 0.6, 0.46), (0.68, 0.42, 0.32), (0.28, 0.1, 0.08), joint))
    return 'sacs'


def step_colors():
    body = bpy.data.objects['FrogBody']
    me = body.data
    mouth = [Vector(p) for p in body.get('mouth', [])]
    kd = KDTree(max(len(mouth), 1))
    for i, p in enumerate(mouth):
        kd.insert(p, i)
    kd.balance()
    BASE = (0.44, 0.44, 0.38)
    bases = []
    for sn in ('Sac_Big', 'Sac_Mid', 'Sac_Rear'):
        so = bpy.data.objects.get(sn)
        if so:
            bases.append((so.matrix_world @ Vector((0, 0, 0.05)), 0.48 * so.scale.x))

    def col(i, co, n):
        c = BASE
        m = noise.noise(co * 2.2)
        c = _mix(c, (0.37, 0.39, 0.31), max(0.0, m) * 0.7)
        c = _mix(c, (0.57, 0.54, 0.46), max(0.0, -m) * 0.55)
        c = _mix(c, (0.44, 0.39, 0.32), _sm(0.1, 0.5, noise.noise(co * 5.0 + Vector((9, 2, 0))))* 0.6)
        c = _mix(c, (0.3, 0.32, 0.26), _sm(0.25, 0.6, noise.noise(co * 11.0)) * 0.5)
        c = _mix(c, (0.62, 0.56, 0.48), _sm(-0.1, -0.6, n.z) * 0.8)
        digit = (abs(co.x) > 0.78 or co.y < -0.8)
        if digit:
            c = _mix(c, (0.64, 0.52, 0.46), _sm(0.2, 0.07, co.z) * 0.85)
            c = _mix(c, (0.74, 0.58, 0.52), _sm(0.1, 0.04, co.z) * 0.8)
        if mouth:
            d = kd.find(co)[2]
            c = _mix(c, (0.58, 0.45, 0.4), _sm(0.07, 0.01, d) * 0.55)
        for b, r in bases:
            c = _mix(c, (0.68, 0.53, 0.45), _sm(r * 1.25, r * 0.8, (co - b).length) * 0.75)
        return c

    _set_col(me, col)
    return 'colors'


def step_materials():
    # wet toad skin
    m, nt, out = _mat('FrogSkin')
    N, L = nt.nodes, nt.links
    bsdf = N.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (300, 0)
    ca = N.new('ShaderNodeVertexColor')
    ca.layer_name = 'Col'
    ca.location = (-500, 200)
    tc = N.new('ShaderNodeTexCoord')
    tc.location = (-900, -200)
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 22.0
    nz.inputs['Detail'].default_value = 10.0
    nz.inputs['Roughness'].default_value = 0.62
    nz.location = (-600, -150)
    vo = N.new('ShaderNodeTexVoronoi')
    vo.feature = 'SMOOTH_F1'
    vo.inputs['Scale'].default_value = 55.0
    vo.location = (-600, -400)
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    L.new(tc.outputs['Object'], vo.inputs['Vector'])
    b1 = N.new('ShaderNodeBump')
    b1.inputs['Strength'].default_value = 0.35
    b1.inputs['Distance'].default_value = 0.02
    b1.location = (-300, -250)
    L.new(nz.outputs['Fac'], b1.inputs['Height'])
    b2 = N.new('ShaderNodeBump')
    b2.inputs['Strength'].default_value = 0.2
    b2.inputs['Distance'].default_value = 0.01
    b2.location = (-100, -300)
    L.new(vo.outputs['Distance'], b2.inputs['Height'])
    L.new(b1.outputs['Normal'], b2.inputs['Normal'])
    mulc = N.new('ShaderNodeMix')
    mulc.data_type = 'RGBA'
    mulc.blend_type = 'MULTIPLY'
    mulc.inputs['Factor'].default_value = 0.35
    mulc.location = (0, 200)
    L.new(ca.outputs['Color'], mulc.inputs['A'])
    L.new(nz.outputs['Color'], mulc.inputs['B'])
    ao = N.new('ShaderNodeAmbientOcclusion')
    ao.inputs['Distance'].default_value = 0.12
    ao.location = (-100, 450)
    aom = N.new('ShaderNodeMix')
    aom.data_type = 'RGBA'
    aom.blend_type = 'MULTIPLY'
    aom.inputs['Factor'].default_value = 0.75
    aom.location = (150, 250)
    L.new(mulc.outputs['Result'], aom.inputs['A'])
    L.new(ao.outputs['AO'], aom.inputs['B'])
    L.new(aom.outputs['Result'], bsdf.inputs['Base Color'])
    L.new(b2.outputs['Normal'], bsdf.inputs['Normal'])
    bsdf.inputs['Roughness'].default_value = 0.36
    bsdf.inputs['Coat Weight'].default_value = 0.55
    bsdf.inputs['Coat Roughness'].default_value = 0.08
    bsdf.inputs['Subsurface Weight'].default_value = 0.03
    bsdf.inputs['Subsurface Radius'].default_value = (0.25, 0.12, 0.08)
    bsdf.inputs['Subsurface Scale'].default_value = 0.02
    L.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    body = bpy.data.objects['FrogBody']
    body.data.materials.clear()
    body.data.materials.append(m)

    # sacs: cellular net skin
    m2, nt, out = _mat('SacSkin')
    N, L = nt.nodes, nt.links
    bsdf = N.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (300, 0)
    ca = N.new('ShaderNodeVertexColor')
    ca.layer_name = 'Col'
    ca.location = (-500, 250)
    tc = N.new('ShaderNodeTexCoord')
    tc.location = (-1100, -100)
    mp = N.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (1.0, 1.0, 0.55)
    mp.location = (-900, -100)
    L.new(tc.outputs['Object'], mp.inputs['Vector'])
    vo = N.new('ShaderNodeTexVoronoi')
    vo.feature = 'DISTANCE_TO_EDGE'
    vo.inputs['Scale'].default_value = 19.0
    vo.inputs['Randomness'].default_value = 0.85
    vo.location = (-700, -100)
    L.new(mp.outputs['Vector'], vo.inputs['Vector'])
    cr = N.new('ShaderNodeValToRGB')
    cr.location = (-450, -100)
    cr.color_ramp.elements[0].position = 0.0
    cr.color_ramp.elements[0].color = (0.84, 0.72, 0.66, 1)
    cr.color_ramp.elements[1].position = 0.16
    cr.color_ramp.elements[1].color = (1, 1, 1, 1)
    L.new(vo.outputs['Distance'], cr.inputs['Fac'])
    mulc = N.new('ShaderNodeMix')
    mulc.data_type = 'RGBA'
    mulc.blend_type = 'MULTIPLY'
    mulc.inputs['Factor'].default_value = 1.0
    mulc.location = (0, 200)
    L.new(ca.outputs['Color'], mulc.inputs['A'])
    L.new(cr.outputs['Color'], mulc.inputs['B'])
    L.new(mulc.outputs['Result'], bsdf.inputs['Base Color'])
    bp = N.new('ShaderNodeBump')
    bp.inputs['Strength'].default_value = 0.6
    bp.inputs['Distance'].default_value = 0.02
    bp.location = (-150, -250)
    L.new(cr.outputs['Color'], bp.inputs['Height'])
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 30.0
    nz.inputs['Detail'].default_value = 6.0
    nz.location = (-450, -400)
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    bp2 = N.new('ShaderNodeBump')
    bp2.inputs['Strength'].default_value = 0.15
    bp2.location = (0, -400)
    L.new(nz.outputs['Fac'], bp2.inputs['Height'])
    L.new(bp2.outputs['Normal'], bp.inputs['Normal'])
    L.new(bp.outputs['Normal'], bsdf.inputs['Normal'])
    bsdf.inputs['Roughness'].default_value = 0.42
    bsdf.inputs['Coat Weight'].default_value = 0.4
    bsdf.inputs['Coat Roughness'].default_value = 0.12
    bsdf.inputs['Subsurface Weight'].default_value = 0.1
    bsdf.inputs['Subsurface Radius'].default_value = (0.4, 0.2, 0.12)
    bsdf.inputs['Subsurface Scale'].default_value = 0.03
    L.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    for n in ('Sac_Big', 'Sac_Mid', 'Sac_Rear'):
        ob = bpy.data.objects.get(n)
        if ob:
            ob.data.materials.clear()
            ob.data.materials.append(m2)

    # eyes: golden iris, dark horizontal pupil
    m3, nt, out = _mat('FrogEye')
    N, L = nt.nodes, nt.links
    bsdf = N.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (300, 0)
    tc = N.new('ShaderNodeTexCoord')
    tc.location = (-1200, 0)
    sep = N.new('ShaderNodeSeparateXYZ')
    sep.location = (-1000, 0)
    L.new(tc.outputs['Object'], sep.inputs['Vector'])

    def math_node(op, a, b, loc):
        mn = N.new('ShaderNodeMath')
        mn.operation = op
        mn.location = loc
        for idx, v in enumerate((a, b)):
            if isinstance(v, (int, float)):
                mn.inputs[idx].default_value = v
            else:
                L.new(v, mn.inputs[idx])
        return mn.outputs[0]

    r = 0.062
    x2 = math_node('POWER', math_node('DIVIDE', sep.outputs['X'], r * 0.52, (-800, 100)), 2.0, (-650, 100))
    z2 = math_node('POWER', math_node('DIVIDE', sep.outputs['Z'], r * 0.3, (-800, -50)), 2.0, (-650, -50))
    pm = math_node('MULTIPLY', math_node('LESS_THAN', math_node('ADD', x2, z2, (-500, 50)), 1.0, (-350, 50)),
                   math_node('LESS_THAN', sep.outputs['Y'], 0.0, (-500, -150)), (-200, 0))
    # iris gradient darker toward rim
    rad = math_node('DIVIDE', math_node('SQRT', math_node('ADD', math_node('MULTIPLY', sep.outputs['X'], sep.outputs['X'], (-800, -250)),
                                                                     math_node('MULTIPLY', sep.outputs['Z'], sep.outputs['Z'], (-800, -350)), (-650, -300)), 0, (-500, -300)), r, (-350, -300))
    irr = N.new('ShaderNodeValToRGB')
    irr.location = (-200, -300)
    irr.color_ramp.elements[0].position = 0.3
    irr.color_ramp.elements[0].color = (0.85, 0.62, 0.2, 1)
    irr.color_ramp.elements[1].position = 0.95
    irr.color_ramp.elements[1].color = (0.35, 0.2, 0.06, 1)
    L.new(rad, irr.inputs['Fac'])
    mx = N.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    mx.location = (50, 0)
    L.new(pm, mx.inputs['Factor'])
    L.new(irr.outputs['Color'], mx.inputs['A'])
    mx.inputs['B'].default_value = (0.015, 0.012, 0.01, 1)
    L.new(mx.outputs['Result'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.2
    bsdf.inputs['Coat Weight'].default_value = 1.0
    bsdf.inputs['Coat Roughness'].default_value = 0.0
    L.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    for n in ('Eye_L', 'Eye_R'):
        ob = bpy.data.objects.get(n)
        if ob:
            ob.data.materials.clear()
            ob.data.materials.append(m3)
    return 'materials'


def step_rock():
    old = bpy.data.objects.get('Rock')
    if old:
        bpy.data.objects.remove(old)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=180, y_segments=150, size=1.0)
    for v in bm.verts:
        v.co.x = v.co.x * 3.0 + 0.4
        v.co.y = v.co.y * 2.5 + 0.9
    cols = {}
    for v in bm.verts:
        x, y = v.co.x, v.co.y
        warp = Vector((noise.noise(Vector((x * 0.8, y * 0.8, 2.0))), noise.noise(Vector((x * 0.8, y * 0.8, 5.0))), 0))
        vr = noise.voronoi(Vector((x * 0.75, y * 1.1, 0.3)) + warp * 0.45)
        d1, d2 = vr[0][0], vr[0][1]
        crack = _sm(0.0, 0.05, d2 - d1)
        near = _sm(1.2, 2.2, max(abs(x) / 1.4, abs(y - 0.0) / 1.2) * 1.2)
        z = 0.012 * noise.fractal(Vector((x * 3, y * 3, 0)), 0.6, 2.0, 5)
        z += (0.05 + 0.1 * near) * noise.noise(Vector((x * 0.7, y * 0.7, 1.0)))
        z -= 0.05 * (1 - crack)
        z += near * 0.06 * noise.noise(Vector((x * 1.8 + 3, y * 1.8, 0)))
        # ledge edge falls away (irregular), so no extruded walls are needed
        e = min(x + 2.6, 3.4 - x, y + 1.6, 3.4 - y) + 0.25 * noise.noise(Vector((x * 1.3, y * 1.3, 4.0)))
        z -= 1.4 * (1.0 - _sm(0.0, 0.4, e))
        v.co.z = z - 0.02
        cols[v.index] = crack
    me = bpy.data.meshes.new('Rock')
    bm.to_mesh(me)
    bm.free()
    _smooth_shade(me)

    def col(i, co, n):
        c = (0.42, 0.39, 0.32)
        k = noise.noise(co * 1.5 + Vector((7, 0, 0)))
        c = _mix(c, (0.56, 0.52, 0.42), max(0, k) * 0.6)
        c = _mix(c, (0.24, 0.22, 0.19), max(0, -k) * 0.7)
        c = _mix(c, (0.3, 0.28, 0.24), _sm(0.2, 0.6, noise.noise(co * 6.0)) * 0.5)
        moss = _sm(0.35, 0.7, noise.noise(co * 2.3 + Vector((0, 5, 0)))) * _sm(1.4, 2.6, abs(co.x) + abs(co.y) * 0.6)
        c = _mix(c, (0.22, 0.27, 0.1), moss * 0.8)
        c = _mix(c, (0.12, 0.11, 0.1), (1 - cols[i]) * 0.8)
        return c

    _set_col(me, col)
    ob = _link(bpy.data.objects.new('Rock', me))

    m, nt, out = _mat('RockWet')
    N, L = nt.nodes, nt.links
    bsdf = N.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (300, 0)
    ca = N.new('ShaderNodeVertexColor')
    ca.layer_name = 'Col'
    ca.location = (-300, 200)
    L.new(ca.outputs['Color'], bsdf.inputs['Base Color'])
    tc = N.new('ShaderNodeTexCoord')
    tc.location = (-800, -200)
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 8.0
    nz.inputs['Detail'].default_value = 12.0
    nz.location = (-550, -200)
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    rr = N.new('ShaderNodeMapRange')
    rr.inputs['To Min'].default_value = 0.12
    rr.inputs['To Max'].default_value = 0.75
    rr.location = (-300, -100)
    L.new(nz.outputs['Fac'], rr.inputs['Value'])
    L.new(rr.outputs['Result'], bsdf.inputs['Roughness'])
    bp = N.new('ShaderNodeBump')
    bp.inputs['Strength'].default_value = 0.6
    bp.location = (-100, -300)
    L.new(nz.outputs['Fac'], bp.inputs['Height'])
    L.new(bp.outputs['Normal'], bsdf.inputs['Normal'])
    L.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    me.materials.append(m)
    return 'rock'


def step_steam():
    old = bpy.data.objects.get('Steam')
    if old:
        bpy.data.objects.remove(old)
    big = bpy.data.objects['Sac_Big']
    mw = big.matrix_world
    mouth = mw @ Vector((0, 0, 1.1))
    d = Vector((-0.75, 0.25, 0.62)).normalized()
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
    me = bpy.data.meshes.new('Steam')
    bm.to_mesh(me)
    bm.free()
    ob = _link(bpy.data.objects.new('Steam', me))
    L0 = 1.4
    ob.location = mouth + d * L0
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d)
    ob.scale = (0.55, 0.55, L0 * 1.05)
    m, nt, out = _mat('SteamVol')
    N, L = nt.nodes, nt.links
    vol = N.new('ShaderNodeVolumePrincipled')
    vol.location = (300, 0)
    vol.inputs['Color'].default_value = (0.95, 0.95, 0.95, 1)
    tc = N.new('ShaderNodeTexCoord')
    tc.location = (-1000, 0)
    sep = N.new('ShaderNodeSeparateXYZ')
    sep.location = (-800, -200)
    L.new(tc.outputs['Object'], sep.inputs['Vector'])
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 5.0
    nz.inputs['Detail'].default_value = 10.0
    nz.inputs['Roughness'].default_value = 0.6
    nz.location = (-700, 150)
    L.new(tc.outputs['Object'], nz.inputs['Vector'])
    # cone: radius grows with z (z=-1 at mouth, +1 far end)
    t = N.new('ShaderNodeMapRange')
    t.inputs['From Min'].default_value = -1.0
    t.inputs['From Max'].default_value = 1.0
    t.location = (-600, -200)
    L.new(sep.outputs['Z'], t.inputs['Value'])
    xy = N.new('ShaderNodeVectorMath')
    xy.operation = 'LENGTH'
    xy.location = (-600, -400)
    comb = N.new('ShaderNodeCombineXYZ')
    comb.location = (-750, -400)
    L.new(sep.outputs['X'], comb.inputs['X'])
    L.new(sep.outputs['Y'], comb.inputs['Y'])
    L.new(comb.outputs['Vector'], xy.inputs['Vector'])
    rad = N.new('ShaderNodeMath')
    rad.operation = 'MULTIPLY_ADD'
    rad.inputs[1].default_value = 0.9
    rad.inputs[2].default_value = 0.06
    rad.location = (-400, -200)
    L.new(t.outputs['Result'], rad.inputs[0])
    ratio = N.new('ShaderNodeMath')
    ratio.operation = 'DIVIDE'
    ratio.location = (-250, -300)
    L.new(xy.outputs['Value'], ratio.inputs[0])
    L.new(rad.outputs['Value'], ratio.inputs[1])
    cone = N.new('ShaderNodeMapRange')
    cone.inputs['From Min'].default_value = 1.0
    cone.inputs['From Max'].default_value = 0.2
    cone.location = (-100, -300)
    L.new(ratio.outputs['Value'], cone.inputs['Value'])
    cr = N.new('ShaderNodeValToRGB')
    cr.location = (-400, 150)
    cr.color_ramp.elements[0].position = 0.36
    cr.color_ramp.elements[0].color = (0, 0, 0, 1)
    cr.color_ramp.elements[1].position = 0.62
    cr.color_ramp.elements[1].color = (1, 1, 1, 1)
    L.new(nz.outputs['Fac'], cr.inputs['Fac'])
    m1 = N.new('ShaderNodeMath')
    m1.operation = 'MULTIPLY'
    m1.location = (0, 0)
    L.new(cr.outputs['Color'], m1.inputs[0])
    L.new(cone.outputs['Result'], m1.inputs[1])
    m2 = N.new('ShaderNodeMath')
    m2.operation = 'MULTIPLY'
    m2.inputs[1].default_value = 12.0
    m2.location = (150, 0)
    L.new(m1.outputs['Value'], m2.inputs[0])
    L.new(m2.outputs['Value'], vol.inputs['Density'])
    L.new(vol.outputs['Volume'], out.inputs['Volume'])
    me.materials.append(m)
    return 'steam'


def _cliff_mat():
    m = bpy.data.materials.get('CliffRock')
    if m:
        return m
    m, nt, out = _mat('CliffRock')
    N, L = nt.nodes, nt.links
    bsdf = N.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (300, 0)
    tc = N.new('ShaderNodeTexCoord')
    tc.location = (-900, 0)
    mp = N.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = (1.0, 1.0, 0.25)
    mp.location = (-700, 0)
    L.new(tc.outputs['Object'], mp.inputs['Vector'])
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 1.5
    nz.inputs['Detail'].default_value = 12.0
    nz.location = (-500, 0)
    L.new(mp.outputs['Vector'], nz.inputs['Vector'])
    cr = N.new('ShaderNodeValToRGB')
    cr.location = (-250, 100)
    cr.color_ramp.elements[0].position = 0.35
    cr.color_ramp.elements[0].color = (0.06, 0.06, 0.055, 1)
    cr.color_ramp.elements[1].position = 0.7
    cr.color_ramp.elements[1].color = (0.22, 0.21, 0.18, 1)
    L.new(nz.outputs['Fac'], cr.inputs['Fac'])
    L.new(cr.outputs['Color'], bsdf.inputs['Base Color'])
    bp = N.new('ShaderNodeBump')
    bp.inputs['Strength'].default_value = 0.8
    bp.location = (0, -200)
    L.new(nz.outputs['Fac'], bp.inputs['Height'])
    L.new(bp.outputs['Normal'], bsdf.inputs['Normal'])
    bsdf.inputs['Roughness'].default_value = 0.55
    L.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    return m


def _cliff(name, loc, size, seed):
    """Cluster of weathered rock columns (stepped basalt-like wall)."""
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old)
    sx, sy, sz = size
    cell = 0.7
    nx, ny = max(1, int(2 * sx / cell)), max(1, int(2 * sy / cell))
    bm = bmesh.new()
    for i in range(nx):
        for j in range(ny):
            cx = -sx + (i + 0.5) * 2 * sx / nx
            cy = -sy + (j + 0.5) * 2 * sy / ny
            h = sz * (0.55 + 0.45 * _sm(-0.6, 0.6, noise.noise(Vector((cx * 0.35, cy * 0.35, seed)))))
            h *= 1.0 - 0.35 * max(0.0, -cy / sy)
            w = (2 * sx / nx) * (0.86 + 0.12 * noise.noise(Vector((cx, cy, seed + 9))))
            d = (2 * sy / ny) * 0.95
            geom = bmesh.ops.create_cube(bm, size=1.0)
            for v in geom['verts']:
                v.co.x = cx + v.co.x * w
                v.co.y = cy + v.co.y * d
                v.co.z = (v.co.z + 0.5) * 2 * h - sz
                v.co.z += 0.12 * noise.noise(Vector((v.co.x * 2, v.co.y * 2, seed + 3))) if v.co.z > -sz + 0.01 else 0
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(_cliff_mat())
    ob = _link(bpy.data.objects.new(name, me))
    ob.location = loc
    bv = ob.modifiers.new('Bevel', 'BEVEL')
    bv.width = 0.06
    bv.segments = 2
    return ob


def step_backdrop():
    # stepped cliff walls behind and to the left, like the misty gorge in the reference
    specs = [
        ('Cliff0', (-3.0, 7.5, 1.0), (3.2, 1.6, 4.5), 1.0),
        ('Cliff1', (1.5, 9.5, 1.5), (3.0, 1.6, 5.5), 2.0),
        ('Cliff2', (6.0, 13.0, 1.0), (3.5, 2.0, 6.5), 3.0),
        ('Cliff3', (-6.5, 3.5, -1.2), (2.4, 3.0, 1.6), 4.0),
        ('Cliff4', (-7.5, 10.0, 2.0), (2.5, 2.0, 7.0), 5.0),
        ('Cliff5', (10.0, 17.0, 1.0), (4.0, 3.0, 8.0), 6.0),
    ]
    for name, loc, size, seed in specs:
        _cliff(name, loc, size, seed)

    old = bpy.data.objects.get('Haze')
    if old:
        bpy.data.objects.remove(old)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    me = bpy.data.meshes.new('Haze')
    bm.to_mesh(me)
    bm.free()
    hz = _link(bpy.data.objects.new('Haze', me))
    hz.location = (0, 17.5, 3)
    hz.scale = (40, 27, 14)
    m, nt, out = _mat('HazeVol')
    vol = nt.nodes.new('ShaderNodeVolumePrincipled')
    vol.inputs['Color'].default_value = (0.9, 0.9, 0.88, 1)
    vol.inputs['Density'].default_value = 0.05
    vol.inputs['Anisotropy'].default_value = 0.3
    nt.links.new(vol.outputs['Volume'], out.inputs['Volume'])
    me.materials.append(m)
    sc = bpy.context.scene
    sc.eevee.volumetric_end = 40.0
    sc.eevee.volumetric_tile_size = '4'
    return 'backdrop'


def _look_at(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = d.to_track_quat('-Z', 'Y')


def step_scene():
    sc = bpy.context.scene
    for n in ('Cam', 'Sun', 'Fill', 'Rim'):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o)
    cd = bpy.data.cameras.new('Cam')
    cd.lens = 40
    cam = _link(bpy.data.objects.new('Cam', cd))
    cam.location = (-2.3, -4.3, 1.9)
    _look_at(cam, (0.1, 0.2, 0.72))
    sc.camera = cam

    sd = bpy.data.lights.new('Sun', 'SUN')
    sd.energy = 2.4
    sd.angle = math.radians(12)
    sun = _link(bpy.data.objects.new('Sun', sd))
    sun.rotation_euler = (math.radians(40), 0, math.radians(-35))
    fd = bpy.data.lights.new('Fill', 'AREA')
    fd.energy = 160
    fd.size = 5
    fill = _link(bpy.data.objects.new('Fill', fd))
    fill.location = (-3.5, -3.5, 3.0)
    _look_at(fill, (0, 0, 0.4))
    rd = bpy.data.lights.new('Rim', 'AREA')
    rd.energy = 220
    rd.size = 3
    rim = _link(bpy.data.objects.new('Rim', rd))
    rim.location = (2.5, 3.5, 3.0)
    _look_at(rim, (0, 0, 0.5))

    w = sc.world or bpy.data.worlds.new('World')
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.72, 0.74, 0.74, 1)
    bg.inputs['Strength'].default_value = 0.6

    sc.render.resolution_x = 900
    sc.render.resolution_y = 900
    sc.eevee.taa_render_samples = 48
    sc.view_settings.view_transform = 'AgX'
    try:
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    return 'scene'


def step_render(name='render.png', res=900):
    sc = bpy.context.scene
    sc.render.resolution_x = res
    sc.render.resolution_y = res
    sc.render.filepath = f'{OUT}/renders/{name}'
    bpy.ops.render.render(write_still=True)
    return sc.render.filepath


def step_save(name='fantasy_frog.blend'):
    bpy.ops.wm.save_as_mainfile(filepath=f'{OUT}/{name}')
    return name


def build_all():
    step_reset()
    step_body()
    step_mesh()
    step_eyes()
    step_sacs()
    step_colors()
    step_materials()
    step_rock()
    step_backdrop()
    step_scene()
    step_steam()
    return 'built'
