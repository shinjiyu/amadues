"""Infinity Castle (無限城): kit pieces -> block meshes -> procedural shaft assembly.

Run inside Blender:
    exec(open(PATH).read(), globals()); build_all(seed=7)

Layers
  kit      : box/obox/cyl primitives + shoji, railing, pillar, eave, stairs, tatami, lantern
  blocks   : one mesh per block variant (room, corridor, stair, facade), fixed material slots
  assembly : linked-duplicate instances placed around/inside a vertical shaft, any orientation
Local block frame: Z up, floor top at z=0, footprint centred on origin.
"""
import bpy, bmesh, math, random
from mathutils import Vector, Matrix, noise

OUT = '/Users/shinjiyu/Documents/amadues/experiments/infinity-castle'
MATS = ['WoodDark', 'WoodFloor', 'Tatami', 'Paper', 'RoofTile', 'Lacquer',
        'Lantern', 'TatamiEdge', 'Plaster', 'Brass']
MI = {n: i for i, n in enumerate(MATS)}
RADIUS = {'room': 7.0, 'corr': 5.0, 'stair': 7.0, 'facade': 5.5}


def _lantern_slots(me):
    f = list(me.get('lanterns', []))
    return [Vector(f[i:i + 3]) for i in range(0, len(f), 3)]


def _radius(mesh_name):
    for k, r in RADIUS.items():
        if k in mesh_name:
            return r
    return 6.0


# ================================================================ builder
class Kit:
    """Accumulates primitives into one bmesh; T is the current local transform."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.T = Matrix.Identity(4)
        self._stack = []
        self.lanterns = []

    def push(self, m):
        self._stack.append(self.T)
        self.T = self.T @ m

    def pop(self):
        self.T = self._stack.pop()

    def _paint(self, verts, mat):
        fs = set()
        for v in verts:
            fs.update(v.link_faces)
        for f in fs:
            f.material_index = MI[mat]

    def box(self, x0, y0, z0, x1, y1, z1, mat):
        sx, sy, sz = abs(x1 - x0), abs(y1 - y0), abs(z1 - z0)
        if min(sx, sy, sz) < 1e-5:
            return
        c = Vector(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
        m = self.T @ Matrix.Translation(c) @ Matrix.Diagonal(Vector((sx, sy, sz, 1.0)))
        g = bmesh.ops.create_cube(self.bm, size=1.0, matrix=m)
        self._paint(g['verts'], mat)

    def obox(self, c, size, rot, mat):
        """Oriented box: centre c, size (sx,sy,sz), rot = 4x4 rotation."""
        m = self.T @ Matrix.Translation(Vector(c)) @ rot @ Matrix.Diagonal(Vector((*size, 1.0)))
        g = bmesh.ops.create_cube(self.bm, size=1.0, matrix=m)
        self._paint(g['verts'], mat)

    def cyl(self, c, r, h, mat, segs=10, rot=None, r2=None):
        m = self.T @ Matrix.Translation(Vector(c)) @ (rot or Matrix.Identity(4))
        g = bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs,
                                  radius1=r, radius2=r if r2 is None else r2, depth=h, matrix=m)
        self._paint(g['verts'], mat)

    def sphere(self, c, scale, mat, u=12, v=8):
        m = self.T @ Matrix.Translation(Vector(c)) @ Matrix.Diagonal(Vector((*scale, 1.0)))
        g = bmesh.ops.create_uvsphere(self.bm, u_segments=u, v_segments=v, radius=1.0, matrix=m)
        self._paint(g['verts'], mat)

    def mesh(self):
        old = bpy.data.meshes.get(self.name)
        if old:
            bpy.data.meshes.remove(old)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for n in MATS:
            me.materials.append(bpy.data.materials[n])
        # stored on the mesh so it survives re-exec of this script
        me['lanterns'] = [c for p in self.lanterns for c in p]
        return me


def RZ(deg):
    return Matrix.Rotation(math.radians(deg), 4, 'Z')


def TR(x, y, z):
    return Matrix.Translation(Vector((x, y, z)))


# ================================================================ kit pieces
def pillar(k, x, y, z0, z1, w=0.22, mat='WoodDark'):
    k.box(x - w / 2, y - w / 2, z0, x + w / 2, y + w / 2, z1, mat)
    k.box(x - w / 2 - 0.03, y - w / 2 - 0.03, z0, x + w / 2 + 0.03, y + w / 2 + 0.03, z0 + 0.08, mat)


def beam(k, x0, x1, y, z, h=0.24, d=0.16, mat='WoodDark'):
    k.box(x0, y - d / 2, z - h / 2, x1, y + d / 2, z + h / 2, mat)


def floor_boards(k, x0, y0, x1, y1, z, bw=0.21, th=0.05, rng=None):
    """Boards run along X, stacked in Y."""
    n = max(1, int((y1 - y0) / bw))
    w = (y1 - y0) / n
    for i in range(n):
        jit = (rng.random() - 0.5) * 0.004 if rng else 0.0
        k.box(x0, y0 + i * w + 0.004, z - th + jit, x1, y0 + (i + 1) * w - 0.004, z + jit, 'WoodFloor')


def tatami_floor(k, x0, y0, x1, y1, z):
    L, W = 1.8, 0.9
    row = 0
    y = y0
    while y < y1 - 1e-3:
        ya, yb = y, min(y + W, y1)
        x = x0 - (W if row % 2 else 0.0)
        while x < x1 - 1e-3:
            xa, xb = max(x, x0), min(x + L, x1)
            if xb - xa > 0.05:
                k.box(xa + 0.004, ya + 0.004, z, xb - 0.004, yb - 0.004, z + 0.05, 'Tatami')
                k.box(xa + 0.004, ya + 0.004, z, xb - 0.004, ya + 0.04, z + 0.053, 'TatamiEdge')
                k.box(xa + 0.004, yb - 0.04, z, xb - 0.004, yb - 0.004, z + 0.053, 'TatamiEdge')
            x += L
        y += W
        row += 1


def shoji_wall(k, x0, x1, y, z0, z1, pw=0.9, t=0.035):
    """Row of shoji panels along X at depth y (paper glows)."""
    n = max(1, round((x1 - x0) / pw))
    w = (x1 - x0) / n
    fr, kick = 0.035, 0.26
    for i in range(n):
        a, c = x0 + i * w, x0 + (i + 1) * w
        k.box(a, y - t, z0, a + fr, y + t, z1, 'WoodDark')
        k.box(c - fr, y - t, z0, c, y + t, z1, 'WoodDark')
        k.box(a + fr, y - t * 0.8, z0, c - fr, y + t * 0.8, z0 + kick, 'WoodDark')
        k.box(a + fr, y - t, z1 - fr, c - fr, y + t, z1, 'WoodDark')
        k.box(a + fr, y - 0.004, z0 + kick, c - fr, y + 0.004, z1 - fr, 'Paper')
        ih = z1 - fr - z0 - kick
        for j in (1, 2):
            xk = a + fr + (w - 2 * fr) * j / 3
            k.box(xk - 0.009, y - 0.016, z0 + kick, xk + 0.009, y + 0.016, z1 - fr, 'WoodDark')
        nh = max(2, int(ih / 0.32))
        for j in range(1, nh):
            zk = z0 + kick + ih * j / nh
            k.box(a + fr, y - 0.016, zk - 0.009, c - fr, y + 0.016, zk + 0.009, 'WoodDark')


def ranma(k, x0, x1, y, z0, z1):
    """Openwork transom above the shoji."""
    k.box(x0, y - 0.005, z0, x1, y + 0.005, z1, 'Paper')
    n = max(2, int((x1 - x0) / 0.14))
    for i in range(n + 1):
        x = x0 + (x1 - x0) * i / n
        k.box(x - 0.012, y - 0.03, z0, x + 0.012, y + 0.03, z1, 'WoodDark')
    k.box(x0, y - 0.03, (z0 + z1) / 2 - 0.012, x1, y + 0.03, (z0 + z1) / 2 + 0.012, 'WoodDark')


def railing(k, x0, x1, y, z, mat='WoodDark', h=0.88):
    n = max(1, round((x1 - x0) / 1.0))
    for i in range(n + 1):
        x = x0 + (x1 - x0) * i / n
        k.box(x - 0.045, y - 0.045, z, x + 0.045, y + 0.045, z + h + 0.04, mat)
    k.box(x0 - 0.05, y - 0.06, z + h, x1 + 0.05, y + 0.06, z + h + 0.06, mat)
    k.box(x0, y - 0.03, z + h * 0.5, x1, y + 0.03, z + h * 0.5 + 0.05, mat)
    k.box(x0, y - 0.035, z + 0.06, x1, y + 0.035, z + 0.13, mat)


def eave(k, x0, x1, y, z, depth=1.4, slope=0.42):
    """Tiled eave projecting toward +Y from (y, z), falling with slope."""
    ang = math.atan(slope)
    L = depth / math.cos(ang)
    R = Matrix.Rotation(-ang, 4, 'X')
    cy, cz = y + depth / 2, z - depth * slope / 2
    k.obox((0.5 * (x0 + x1), cy, cz), (x1 - x0 + 0.1, L, 0.07), R, 'RoofTile')
    n = max(2, int((x1 - x0) / 0.24))
    for i in range(n + 1):
        x = x0 + (x1 - x0) * i / n
        k.obox((x, cy, cz + 0.05), (0.1, L, 0.06), R, 'RoofTile')
    k.box(x0 - 0.05, y + depth - 0.02, z - depth * slope - 0.14, x1 + 0.05, y + depth + 0.07, z - depth * slope + 0.02, 'RoofTile')
    m = max(2, int((x1 - x0) / 0.38))
    for i in range(m + 1):
        x = x0 + (x1 - x0) * i / m
        k.obox((x, cy - 0.05, cz - 0.1), (0.06, L * 0.96, 0.08), R, 'WoodDark')
    k.box(x0, y - 0.05, z - 0.18, x1, y + 0.08, z, 'WoodDark')


def lantern(k, x, y, z, hang=0.4):
    """Hanging paper chochin; centre recorded for light placement."""
    k.box(x - 0.015, y - 0.015, z + 0.42, x + 0.015, y + 0.015, z + 0.42 + hang, 'WoodDark')
    k.sphere((x, y, z), (0.3, 0.3, 0.45), 'Lantern')
    k.cyl((x, y, z + 0.42), 0.18, 0.08, 'Lacquer', segs=12)
    k.cyl((x, y, z - 0.42), 0.18, 0.08, 'Lacquer', segs=12)
    k.lanterns.append(k.T @ Vector((x, y, z)))


def stairs(k, x0, x1, y0, run, rise, z0, rail=True):
    n = max(3, round(rise / 0.19))
    d, h = run / n, rise / n
    for i in range(n):
        ya = y0 + i * d
        zt = z0 + (i + 1) * h
        k.box(x0, ya, zt - 0.05, x1, ya + d + 0.03, zt, 'WoodFloor')
        k.box(x0 + 0.05, ya, zt - h, x1 - 0.05, ya + 0.03, zt - 0.05, 'WoodDark')
    ang = math.atan2(rise, run)
    L = math.hypot(run, rise)
    R = Matrix.Rotation(ang, 4, 'X')
    for x in (x0 - 0.05, x1 + 0.05):
        k.obox((x, y0 + run / 2, z0 + rise / 2 - 0.1), (0.1, L, 0.32), R, 'WoodDark')
        if rail:
            k.obox((x, y0 + run / 2, z0 + rise / 2 + 0.9), (0.1, L, 0.06), R, 'WoodDark')
            for i in range(0, n + 1, 3):
                yy = y0 + run * i / n
                zz = z0 + rise * i / n
                k.box(x - 0.04, yy - 0.04, zz, x + 0.04, yy + 0.04, zz + 0.95, 'WoodDark')


def supports(k, pts, z_top, depth, brace=3.0):
    """Kiyomizu-style post lattice hanging down into the void."""
    zb = z_top - depth
    for (x, y) in pts:
        k.box(x - 0.13, y - 0.13, zb, x + 0.13, y + 0.13, z_top, 'WoodDark')
    xs = sorted({p[0] for p in pts})
    ys = sorted({p[1] for p in pts})
    z = z_top - brace
    while z > zb + 0.5:
        for y in ys:
            k.box(xs[0], y - 0.06, z - 0.1, xs[-1], y + 0.06, z + 0.1, 'WoodDark')
        for x in xs:
            k.box(x - 0.06, ys[0], z - 0.1, x + 0.06, ys[-1], z + 0.1, 'WoodDark')
        z -= brace


# ================================================================ blocks
def blk_room(name, seed, sides=('shoji', 'shoji', 'open', 'shoji'), under=0.0):
    """8x8 tatami room; sides = (+Y, +X, -Y, -X)."""
    rng = random.Random(seed)
    k = Kit(name)
    k.box(-4, -4, -0.45, 4, 4, -0.05, 'WoodDark')
    tatami_floor(k, -3.6, -3.6, 3.6, 3.6, -0.05)
    for yaw, side in zip((0, 90, 180, 270), sides):
        k.push(RZ(yaw))
        floor_boards(k, -4, 3.6, 4, 4.0, 0.0, bw=0.2, rng=rng)
        for x in (-3.8, -1.9, 0.0, 1.9):
            pillar(k, x, 3.8, 0.0, 3.25)
        beam(k, -4, 4, 3.8, 2.25, h=0.14)
        beam(k, -4, 4, 3.8, 3.2)
        if side == 'shoji':
            for a in (-3.8, -1.9, 0.0, 1.9):
                shoji_wall(k, a + 0.11, a + 1.79, 3.8, 0.0, 2.18, pw=0.84)
                ranma(k, a + 0.11, a + 1.79, 3.8, 2.32, 3.08)
        elif side == 'open':
            railing(k, -3.7, 3.7, 3.95, 0.0)
            ranma(k, -3.7, 3.7, 3.8, 2.32, 3.08)
        eave(k, -4.2, 4.2, 4.0, 3.3, depth=1.5)
        k.pop()
    k.box(-3.9, -3.9, 3.3, 3.9, 3.9, 3.36, 'WoodDark')
    for i in range(18):
        x = -3.6 + 7.2 * i / 17
        k.box(x - 0.02, -3.8, 3.24, x + 0.02, 3.8, 3.3, 'WoodDark')
    # hipped roof: four-sided pyramid with a short ridge cap
    k.cyl((0, 0, 4.35), 3.9 * math.sqrt(2), 2.0, 'RoofTile', segs=4, rot=RZ(45), r2=0.35)
    k.box(-0.3, -0.3, 5.3, 0.3, 0.3, 5.55, 'RoofTile')
    for x in (-1.6, 1.6):
        lantern(k, x, 0.0, 2.45, hang=0.55)
    if under > 0:
        supports(k, [(x, y) for x in (-3.6, 0.0, 3.6) for y in (-3.6, 0.0, 3.6)], -0.45, under)
    return k.mesh()


def blk_corridor(name, seed, left='railing', right='shoji', under=0.0, red=False):
    """8 long (X) x 2.4 wide engawa corridor with roof."""
    rng = random.Random(seed)
    k = Kit(name)
    k.box(-4, -1.2, -0.35, 4, 1.2, -0.05, 'WoodDark')
    k.push(RZ(90))
    floor_boards(k, -1.2, -4, 1.2, 4, 0.0, bw=0.18, rng=rng)
    k.pop()
    for x in (-3.9, -1.95, 0.0, 1.95, 3.9):
        for y in (-1.1, 1.1):
            pillar(k, x, y, 0.0, 3.0, w=0.2)
    for y in (-1.1, 1.1):
        beam(k, -4, 4, y, 2.95)
    rail_mat = 'Lacquer' if red else 'WoodDark'
    for side, y, yaw in ((left, -1.1, 180), (right, 1.1, 0)):
        if side == 'railing':
            railing(k, -3.9, 3.9, y, 0.0, mat=rail_mat)
        elif side == 'shoji':
            for a in (-3.9, -1.95, 0.0, 1.95):
                shoji_wall(k, a + 0.1, a + 1.85, y, 0.0, 2.1, pw=0.9)
                ranma(k, a + 0.1, a + 1.85, y, 2.2, 2.85)
        k.push(RZ(yaw))
        eave(k, -4.1, 4.1, 1.2, 3.1, depth=1.2)
        k.pop()
    k.box(-4, -1.25, 3.05, 4, 1.25, 3.12, 'WoodDark')
    k.box(-4, -1.0, 3.12, 4, 1.0, 3.5, 'RoofTile')
    for x in (-2.0, 2.0):
        lantern(k, x, -1.55, 2.2, hang=0.55)
    if under > 0:
        supports(k, [(x, y) for x in (-3.9, 0.0, 3.9) for y in (-1.1, 1.1)], -0.35, under)
    return k.mesh()


def blk_stair(name, seed, rise=5.0, run=8.0):
    k = Kit(name)
    k.box(-1.2, -run / 2 - 1.4, -0.3, 1.2, -run / 2, 0.0, 'WoodDark')
    floor_boards(k, -1.2, -run / 2 - 1.4, 1.2, -run / 2, 0.0)
    stairs(k, -1.1, 1.1, -run / 2, run, rise, 0.0)
    k.box(-1.2, run / 2, rise - 0.3, 1.2, run / 2 + 1.4, rise, 'WoodDark')
    floor_boards(k, -1.2, run / 2, 1.2, run / 2 + 1.4, rise)
    for y, z in ((-run / 2 - 1.3, 0.0), (run / 2 + 1.3, rise)):
        for x in (-1.15, 1.15):
            pillar(k, x, y, z, z + 3.0, w=0.2)
        beam(k, -1.3, 1.3, y, z + 2.9)
        lantern(k, 0.0, y, z + 2.3, hang=0.4)
    return k.mesh()


def blk_facade(name, seed, red=False):
    """8 wide, 2-storey (7 tall) front; back plane y=0, faces -Y."""
    rng = random.Random(seed)
    k = Kit(name)
    k.box(-4, 0.05, -0.3, 4, 1.8, 7.0, 'WoodDark')
    for s in range(2):
        z = s * 3.5
        style = rng.choice(['balcony', 'balcony', 'wall', 'deep'])
        dep = 1.4 if style != 'deep' else 2.4
        k.box(-4, -dep, z - 0.3, 4, 0.05, z, 'WoodDark')
        floor_boards(k, -4, -dep, 4, 0.0, z, bw=0.2, rng=rng)
        for x in (-3.9, -1.95, 0.0, 1.95, 3.9):
            pillar(k, x, -0.05, z, z + 3.25, w=0.2)
        beam(k, -4, 4, -0.05, z + 2.25, h=0.14)
        beam(k, -4, 4, -0.05, z + 3.1)
        if style == 'wall':
            k.box(-4, -0.02, z, 4, 0.05, z + 3.25, 'Plaster')
            for a in (-3.9, -1.95, 0.0, 1.95):
                if rng.random() < 0.7:
                    shoji_wall(k, a + 0.35, a + 1.6, -0.06, z + 0.9, z + 2.0, pw=0.62)
        else:
            for a in (-3.9, -1.95, 0.0, 1.95):
                shoji_wall(k, a + 0.1, a + 1.85, -0.05, z, z + 2.18, pw=0.9)
                ranma(k, a + 0.1, a + 1.85, -0.05, 2.3 + z, z + 3.02)
            for x in (-3.9, -1.95, 0.0, 1.95, 3.9):
                pillar(k, x, -dep + 0.12, z, z + 3.25, w=0.2)
            beam(k, -4, 4, -dep + 0.12, z + 3.1)
            railing(k, -3.9, 3.9, -dep + 0.12, z, mat='Lacquer' if red else 'WoodDark')
        k.push(RZ(180))
        eave(k, -4.1, 4.1, dep - 0.1, z + 3.35, depth=1.3)
        k.pop()
        for x in (-2.0, 2.0):
            if rng.random() < 0.8:
                lantern(k, x, -dep - 0.3, z + 2.6, hang=0.45)
    return k.mesh()


# ================================================================ materials
def _new_mat(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    out.location = (500, 0)
    bs = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bs.location = (200, 0)
    nt.links.new(bs.outputs['BSDF'], out.inputs['Surface'])
    return m, nt, bs


def _wood(name, c0, c1, rough, scale):
    m, nt, bs = _new_mat(name)
    N, L = nt.nodes, nt.links
    tc = N.new('ShaderNodeTexCoord')
    tc.location = (-900, 0)
    wv = N.new('ShaderNodeTexWave')
    wv.wave_type = 'BANDS'
    wv.bands_direction = 'X'
    wv.inputs['Scale'].default_value = scale
    wv.inputs['Distortion'].default_value = 6.0
    wv.inputs['Detail'].default_value = 4.0
    wv.location = (-650, 0)
    L.new(tc.outputs['Object'], wv.inputs['Vector'])
    cr = N.new('ShaderNodeValToRGB')
    cr.location = (-400, 0)
    cr.color_ramp.elements[0].color = (*c0, 1)
    cr.color_ramp.elements[1].color = (*c1, 1)
    L.new(wv.outputs['Fac'], cr.inputs['Fac'])
    L.new(cr.outputs['Color'], bs.inputs['Base Color'])
    bp = N.new('ShaderNodeBump')
    bp.inputs['Strength'].default_value = 0.15
    bp.location = (-150, -250)
    L.new(wv.outputs['Fac'], bp.inputs['Height'])
    L.new(bp.outputs['Normal'], bs.inputs['Normal'])
    bs.inputs['Roughness'].default_value = rough
    return m


def step_materials():
    _wood('WoodDark', (0.07, 0.03, 0.012), (0.17, 0.075, 0.032), 0.45, 3.0)
    _wood('WoodFloor', (0.14, 0.06, 0.024), (0.3, 0.14, 0.06), 0.18, 2.0)
    m, nt, bs = _new_mat('Tatami')
    N, L = nt.nodes, nt.links
    tc = N.new('ShaderNodeTexCoord')
    wv = N.new('ShaderNodeTexWave')
    wv.inputs['Scale'].default_value = 90.0
    wv.inputs['Distortion'].default_value = 0.5
    L.new(tc.outputs['Object'], wv.inputs['Vector'])
    cr = N.new('ShaderNodeValToRGB')
    cr.color_ramp.elements[0].color = (0.3, 0.26, 0.1, 1)
    cr.color_ramp.elements[1].color = (0.45, 0.4, 0.18, 1)
    L.new(wv.outputs['Fac'], cr.inputs['Fac'])
    L.new(cr.outputs['Color'], bs.inputs['Base Color'])
    bs.inputs['Roughness'].default_value = 0.7
    m, nt, bs = _new_mat('Paper')
    bs.inputs['Base Color'].default_value = (0.6, 0.45, 0.28, 1)
    bs.inputs['Emission Color'].default_value = (1.0, 0.42, 0.13, 1)
    bs.inputs['Emission Strength'].default_value = 2.6
    bs.inputs['Roughness'].default_value = 0.8
    m, nt, bs = _new_mat('RoofTile')
    bs.inputs['Base Color'].default_value = (0.03, 0.032, 0.036, 1)
    bs.inputs['Roughness'].default_value = 0.35
    bs.inputs['Metallic'].default_value = 0.2
    m, nt, bs = _new_mat('Lacquer')
    bs.inputs['Base Color'].default_value = (0.32, 0.025, 0.015, 1)
    bs.inputs['Roughness'].default_value = 0.25
    bs.inputs['Coat Weight'].default_value = 0.6
    m, nt, bs = _new_mat('Lantern')
    bs.inputs['Base Color'].default_value = (0.8, 0.25, 0.06, 1)
    bs.inputs['Emission Color'].default_value = (1.0, 0.3, 0.06, 1)
    bs.inputs['Emission Strength'].default_value = 5.0
    m, nt, bs = _new_mat('TatamiEdge')
    bs.inputs['Base Color'].default_value = (0.015, 0.02, 0.015, 1)
    m, nt, bs = _new_mat('Plaster')
    bs.inputs['Base Color'].default_value = (0.38, 0.3, 0.22, 1)
    bs.inputs['Roughness'].default_value = 0.9
    m, nt, bs = _new_mat('Brass')
    bs.inputs['Base Color'].default_value = (0.8, 0.55, 0.2, 1)
    bs.inputs['Metallic'].default_value = 1.0
    bs.inputs['Roughness'].default_value = 0.3
    return 'materials'


# ================================================================ steps
def step_reset():
    # read_homefile would reload prefs and drop the MCP bridge addon
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    for coll in (bpy.data.meshes, bpy.data.metaballs, bpy.data.materials, bpy.data.cameras,
                 bpy.data.lights, bpy.data.images, bpy.data.curves):
        for d in list(coll):
            coll.remove(d)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    return 'reset'


def step_blocks():
    step_materials()
    made = []
    made.append(blk_room('B_room_a', 1, ('shoji', 'shoji', 'open', 'shoji')))
    made.append(blk_room('B_room_b', 2, ('shoji', 'open', 'open', 'shoji'), under=12.0))
    made.append(blk_room('B_room_c', 3, ('open', 'shoji', 'open', 'shoji')))
    made.append(blk_corridor('B_corr_a', 4, 'railing', 'shoji'))
    made.append(blk_corridor('B_corr_b', 5, 'railing', 'railing', red=True))
    made.append(blk_corridor('B_corr_c', 6, 'railing', 'shoji', under=14.0))
    made.append(blk_stair('B_stair_a', 7))
    for i in range(4):
        made.append(blk_facade(f'B_facade_{i}', 10 + i, red=(i == 2)))
    return [(m.name, len(m.vertices)) for m in made]


def _coll(name):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


def _place(coll, mesh_name, loc, R, tag):
    me = bpy.data.meshes[mesh_name]
    ob = bpy.data.objects.new(f'{tag}_{mesh_name}', me)
    ob.matrix_world = Matrix.Translation(Vector(loc)) @ R
    coll.objects.link(ob)
    return ob


def _up_frame(up, yaw_deg):
    """Rotation taking local +Z to `up`, then spinning yaw about it."""
    up = Vector(up).normalized()
    q = Vector((0, 0, 1)).rotation_difference(up)
    if up.z < -0.999:
        q = Matrix.Rotation(math.pi, 3, 'X').to_quaternion()
    return Matrix.Rotation(math.radians(yaw_deg), 4, up) @ q.to_matrix().to_4x4()


SHAFT_W = 16.0
Z_LEVELS = list(range(-63, 43, 7))
DEEP_BOTTOM = -420.0
DEEP_LEVELS = list(range(-70, int(DEEP_BOTTOM), -7))
CAM = ((-6.0, -7.0, 4.0), (4.0, 5.0, -20.0))


def _view_clearance(cam, target, length=26.0):
    """Spheres along the camera ray that assembly must leave empty."""
    c, t = Vector(cam), Vector(target)
    d = (t - c).normalized()
    return [(c + d * s, 3.0 + 0.18 * s) for s in range(0, int(length), 3)]


def step_assemble(seed=7, cam=CAM, extra_clear=None, deep=False):
    rng = random.Random(seed)
    coll = _coll('Castle')
    for ob in list(coll.objects):
        bpy.data.objects.remove(ob)
    W = SHAFT_W
    facades = [f'B_facade_{i}' for i in range(4)]
    placed = []
    clear = (_view_clearance(*cam) if cam else []) + list(extra_clear or [])

    legs = {'B_room_b': 12.0, 'B_corr_c': 14.0}

    def free(name, loc, R=None):
        r = _radius(name)
        probes = [Vector(loc)]
        if name in legs and R is not None:
            down = (R @ Vector((0, 0, -1, 0))).to_3d()
            probes += [Vector(loc) + down * s for s in (4.0, 8.0, legs[name])]
        return all((q - p).length > r + cr for q in probes for p, cr in clear)

    # 1) four walls of stacked facades facing into the shaft (the endless atrium)
    walls = [((0, W), 0), ((0, -W), 180), ((W, 0), -90), ((-W, 0), 90)]
    for (wx, wy), yaw in walls:
        R = RZ(yaw)
        inward = (R @ Vector((0, -1, 0, 0))).to_3d()
        along = (R @ Vector((1, 0, 0, 0))).to_3d()
        col_shift = [rng.choice((0.0, 0.0, 1.75, 3.5, -1.75)) for _ in range(4)]
        for z in Z_LEVELS + (DEEP_LEVELS if deep else []):
            inset = rng.choice((0.0, 0.0, 0.0, 1.2, 2.4))
            for i in range(4):
                off = -12 + 8 * i
                zz = z + col_shift[i]
                loc = Vector((wx, wy, zz)) + along * off + inward * (inset + rng.choice((0.0, 0.0, 0.8, -0.8)))
                spin = rng.random()
                Rf = R
                if spin < 0.26:
                    if spin >= 0.2:
                        continue  # a missing bay: a dark cavity into the wall
                    # storeys run sideways or upside down; spin about the bay centre
                    ang = rng.choice((90, -90)) if spin < 0.12 else 180
                    Rs = Matrix.Rotation(math.radians(ang), 4, inward)
                    centre = loc + Vector((0, 0, 3.5))
                    loc = centre + (Rs @ (loc - centre).to_4d()).to_3d()
                    Rf = Rs @ R
                placed.append(_place(coll, rng.choice(facades), loc, Rf, 'F'))

    # 2) sideways / upside-down rooms and corridors growing out of the walls
    kinds = ['B_room_a', 'B_room_c', 'B_corr_a', 'B_corr_b', 'B_stair_a']
    for (wx, wy), yaw in walls:
        R = RZ(yaw)
        inward = (R @ Vector((0, -1, 0, 0))).to_3d()
        along = (R @ Vector((1, 0, 0, 0))).to_3d()
        for _ in range(9):
            z = rng.uniform(-50, 30)
            off = rng.uniform(-10, 10)
            base = Vector((wx, wy, z)) + along * off + inward * 3.2
            Rb = _up_frame(inward, rng.choice((0, 90, 180, 270)))
            name = rng.choice(kinds)
            if free(name, base, Rb):
                placed.append(_place(coll, name, base, Rb, 'S'))

    # 3) bridges spanning the shaft at random heights (some rolled sideways / upside down)
    for _ in range(14):
        z = rng.uniform(-45, 25)
        axis = rng.choice(('x', 'y'))
        c = rng.uniform(-9, 9)
        roll = rng.choice((0, 0, 0, 90, 180))
        name = rng.choice(('B_corr_a', 'B_corr_b', 'B_corr_c'))
        segs = []
        for i in range(4):
            t = -12 + 8 * i
            if axis == 'x':
                loc = (t, c, z)
                R = Matrix.Rotation(math.radians(roll), 4, 'X')
            else:
                loc = (c, t, z)
                R = RZ(90) @ Matrix.Rotation(math.radians(roll), 4, 'X')
            segs.append((loc, R))
        if all(free(name, loc, R) for loc, R in segs):
            for loc, R in segs:
                placed.append(_place(coll, name, loc, R, 'Br'))

    # 4) floating rooms and stairs inside the void, any of the six gravity directions
    ups = [(0, 0, 1)] * 4 + [(0, 0, -1), (1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0)]
    for _ in range(22):
        loc = (rng.uniform(-8, 8), rng.uniform(-8, 8), rng.uniform(-55, 30))
        Rb = _up_frame(rng.choice(ups), rng.choice((0, 90, 180, 270)))
        name = rng.choice(('B_room_b', 'B_stair_a', 'B_room_a'))
        if free(name, loc, Rb):
            placed.append(_place(coll, name, loc, Rb, 'V'))

    # 5) the abyss below the fall: bridges and floating rooms keep crossing at every depth,
    #    always off-axis so the vanishing point down the shaft centre stays open
    if deep:
        clear += [(Vector((0, 0, zc)), 5.0) for zc in range(-50, int(DEEP_BOTTOM), -4)]
        z = -58.0
        while z > DEEP_BOTTOM + 10:
            z -= rng.uniform(9, 17)
            axis = rng.choice(('x', 'y'))
            c = rng.choice((-1, 1)) * rng.uniform(8.0, 11.0)
            roll = rng.choice((0, 0, 90, 180))
            name = rng.choice(('B_corr_a', 'B_corr_b'))
            for i in range(4):
                t = -12 + 8 * i
                if axis == 'x':
                    loc, R = (t, c, z), Matrix.Rotation(math.radians(roll), 4, 'X')
                else:
                    loc, R = (c, t, z), RZ(90) @ Matrix.Rotation(math.radians(roll), 4, 'X')
                if free(name, loc, R):
                    placed.append(_place(coll, name, loc, R, 'Db'))
            if rng.random() < 0.8:
                a = rng.uniform(0, 2 * math.pi)
                rr = rng.uniform(9, 11.5)
                loc = (rr * math.cos(a), rr * math.sin(a), z - rng.uniform(3, 7))
                Rb = _up_frame(rng.choice(ups), rng.choice((0, 90, 180, 270)))
                name = rng.choice(('B_room_b', 'B_stair_a', 'B_room_a', 'B_room_c'))
                if free(name, loc, Rb):
                    placed.append(_place(coll, name, loc, Rb, 'Dv'))
    return len(placed)


def step_lights(cam_loc=None, max_lights=110, radius=45.0, path=None, path_radius=16.0):
    coll = _coll('Lights')
    for ob in list(coll.objects):
        bpy.data.objects.remove(ob)
    for l in list(bpy.data.lights):
        if l.users == 0:
            bpy.data.lights.remove(l)
    cam = bpy.context.scene.camera
    c = Vector(cam_loc) if cam_loc else (cam.location if cam else Vector((0, 0, 0)))
    pts = []
    for ob in bpy.data.collections['Castle'].objects:
        for p in _lantern_slots(ob.data):
            w = ob.matrix_world @ p
            if path:
                d = min((w - q).length for q in path)
                if d < path_radius:
                    pts.append((d, w))
                continue
            d = (w - c).length
            if d < radius:
                pts.append((d, w))
    pts.sort(key=lambda t: t[0])
    ld = bpy.data.lights.new('LanternLight', 'POINT')
    ld.energy = 120.0
    ld.color = (1.0, 0.5, 0.2)
    ld.shadow_soft_size = 0.4
    ld.use_shadow = path is None
    for i, (_, w) in enumerate(pts[:max_lights]):
        lo = bpy.data.objects.new(f'L{i}', ld)
        lo.location = w
        coll.objects.link(lo)
    # warm glow down the shaft axis: lights the haze and the facing walls
    gd = bpy.data.lights.new('ShaftGlow', 'POINT')
    gd.energy = 5000.0
    gd.color = (1.0, 0.55, 0.28)
    gd.shadow_soft_size = 4.0
    # off-axis so a camera falling down the centre never looks straight into one
    i = 0
    for z in range(-60, 41, 20):
        for cx, cy in ((10, 10), (-10, -10)) if (z // 20) % 2 else ((10, -10), (-10, 10)):
            lo = bpy.data.objects.new(f'G{i}', gd)
            lo.location = (float(cx), float(cy), float(z))
            coll.objects.link(lo)
            i += 1
    if path:
        # sparse shadowless glows down the abyss so far layers read as warm bands in the haze
        dd = bpy.data.lights.new('ShaftGlowDeep', 'POINT')
        dd.energy = 5000.0
        dd.color = (1.0, 0.45, 0.16)
        dd.shadow_soft_size = 6.0
        dd.use_shadow = False
        for k, z in enumerate(range(-85, int(DEEP_BOTTOM), -30)):
            a = k * 2.4
            lo = bpy.data.objects.new(f'GD{k}', dd)
            lo.location = (11 * math.cos(a), 11 * math.sin(a), float(z))
            coll.objects.link(lo)
    return len(pts[:max_lights])


def _look_at(ob, target, roll=0.0):
    d = Vector(target) - ob.location
    q = d.to_track_quat('-Z', 'Y')
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = q @ Matrix.Rotation(math.radians(roll), 3, 'Z').to_quaternion()


def step_scene(cam=CAM[0], target=CAM[1], lens=18.0, roll=0.0):
    sc = bpy.context.scene
    ob = bpy.data.objects.get('Cam')
    if ob is None:
        cd = bpy.data.cameras.new('Cam')
        ob = bpy.data.objects.new('Cam', cd)
        sc.collection.objects.link(ob)
    ob.data.lens = lens
    ob.data.clip_end = 500
    ob.location = cam
    _look_at(ob, target, roll)
    sc.camera = ob

    w = sc.world or bpy.data.worlds.new('World')
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (0.02, 0.012, 0.008, 1)
    bg.inputs['Strength'].default_value = 1.0

    hz = bpy.data.objects.get('Haze')
    if hz is None:
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        me = bpy.data.meshes.new('Haze')
        bm.to_mesh(me)
        bm.free()
        hz = bpy.data.objects.new('Haze', me)
        sc.collection.objects.link(hz)
        m = bpy.data.materials.get('HazeVol') or bpy.data.materials.new('HazeVol')
        m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        vol = nt.nodes.new('ShaderNodeVolumePrincipled')
        vol.inputs['Color'].default_value = (0.9, 0.62, 0.4, 1)
        vol.inputs['Density'].default_value = 0.012
        vol.inputs['Anisotropy'].default_value = 0.4
        nt.links.new(vol.outputs['Volume'], out.inputs['Volume'])
        me.materials.append(m)
    hz.location = (0, 0, -10)
    hz.scale = (2 * SHAFT_W + 10, 2 * SHAFT_W + 10, 130)

    sc.eevee.volumetric_end = 120.0
    sc.eevee.volumetric_tile_size = '8'
    sc.eevee.taa_render_samples = 32
    try:
        sc.eevee.use_raytracing = True
    except AttributeError:
        pass
    sc.view_settings.view_transform = 'AgX'
    try:
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except TypeError:
        pass
    sc.render.resolution_x = 1280
    sc.render.resolution_y = 720
    return 'scene'


def step_render(name='ic.png', res=(1280, 720), samples=32):
    import os
    os.makedirs(f'{OUT}/renders', exist_ok=True)
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.eevee.taa_render_samples = samples
    sc.render.filepath = f'{OUT}/renders/{name}'
    bpy.ops.render.render(write_still=True)
    return sc.render.filepath


def step_save(name='infinity_castle.blend'):
    bpy.ops.wm.save_as_mainfile(filepath=f'{OUT}/{name}')
    return name


def _sock(node, name, value):
    try:
        node.inputs[name].default_value = value
        return True
    except (KeyError, TypeError, ValueError):
        return False


def step_look():
    """Anime-style grade: orange light vs indigo shadow, bloom, lit haze, glossy floors."""
    sc = bpy.context.scene
    ee = sc.eevee

    # --- materials
    m = bpy.data.materials['Paper']
    nt = m.node_tree
    bs = nt.nodes['Principled BSDF']
    bs.inputs['Emission Color'].default_value = (1.0, 0.36, 0.08, 1)
    oi = nt.nodes.get('OI') or nt.nodes.new('ShaderNodeObjectInfo')
    oi.name = 'OI'
    mr = nt.nodes.get('MR') or nt.nodes.new('ShaderNodeMapRange')
    mr.name = 'MR'
    mr.inputs['To Min'].default_value = 1.2
    mr.inputs['To Max'].default_value = 5.5
    nt.links.new(oi.outputs['Random'], mr.inputs['Value'])
    nt.links.new(mr.outputs['Result'], bs.inputs['Emission Strength'])
    bs = bpy.data.materials['Lantern'].node_tree.nodes['Principled BSDF']
    bs.inputs['Emission Color'].default_value = (1.0, 0.32, 0.05, 1)
    bs.inputs['Emission Strength'].default_value = 9.0
    bs = bpy.data.materials['WoodFloor'].node_tree.nodes['Principled BSDF']
    bs.inputs['Roughness'].default_value = 0.1
    bs.inputs['Coat Weight'].default_value = 0.6
    bs = bpy.data.materials['Lacquer'].node_tree.nodes['Principled BSDF']
    bs.inputs['Base Color'].default_value = (0.45, 0.02, 0.01, 1)

    # --- world + haze
    bg = sc.world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.004, 0.006, 0.014, 1)
    vol = bpy.data.materials['HazeVol'].node_tree.nodes['Principled Volume']
    vol.inputs['Color'].default_value = (1.0, 0.86, 0.72, 1)
    vol.inputs['Density'].default_value = 0.011
    vol.inputs['Anisotropy'].default_value = 0.55

    # --- lights
    for ob in bpy.data.collections['Lights'].objects:
        if ob.data.name.startswith('LanternLight'):
            ob.data.color = (1.0, 0.36, 0.09)
            ob.data.energy = 160.0
        elif ob.data.name.startswith('ShaftGlow'):
            ob.data.color = (1.0, 0.42, 0.14)
            ob.data.energy = 3500.0
    sky = bpy.data.objects.get('CoolTop')
    if sky is None:
        sd = bpy.data.lights.new('CoolTop', 'SUN')
        sky = bpy.data.objects.new('CoolTop', sd)
        sc.collection.objects.link(sky)
    sky.data.energy = 0.35
    sky.data.color = (0.45, 0.55, 1.0)
    sky.data.angle = math.radians(20)
    sky.rotation_euler = (math.radians(15), math.radians(10), 0)

    # --- engine
    ee.use_raytracing = True
    ee.ray_tracing_method = 'SCREEN'
    ee.use_fast_gi = True
    ee.use_shadows = True
    ee.volumetric_tile_size = '4'
    ee.volumetric_samples = 64
    ee.use_volumetric_shadows = True
    ee.volumetric_light_clamp = 0.0
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.view_settings.exposure = 0.2

    # --- compositor: bloom -> split-tone -> saturation -> vignette
    ng = bpy.data.node_groups.get('AnimeGrade')
    if ng:
        bpy.data.node_groups.remove(ng)
    ng = bpy.data.node_groups.new('AnimeGrade', 'CompositorNodeTree')
    ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    N, L = ng.nodes, ng.links
    rl = N.new('CompositorNodeRLayers')
    rl.location = (-800, 0)
    gl = N.new('CompositorNodeGlare')
    gl.location = (-550, 0)
    for v in ('Bloom', 'BLOOM'):
        if _sock(gl, 'Type', v):
            break
    _sock(gl, 'Quality', 'High') or _sock(gl, 'Quality', 'HIGH')
    _sock(gl, 'Threshold', 0.9)
    _sock(gl, 'Strength', 0.55)
    _sock(gl, 'Size', 0.8)
    _sock(gl, 'Saturation', 1.2)
    L.new(rl.outputs['Image'], gl.inputs['Image'])
    cb = N.new('CompositorNodeColorBalance')
    cb.location = (-300, 0)
    lift = [s for s in cb.inputs if s.name == 'Lift' and s.type == 'RGBA']
    gain = [s for s in cb.inputs if s.name == 'Gain' and s.type == 'RGBA']
    if lift:
        lift[0].default_value = (0.98, 0.99, 1.035, 1)
    if gain:
        gain[0].default_value = (1.05, 1.0, 0.9, 1)
    L.new(gl.outputs['Image'], cb.inputs['Image'])
    hs = N.new('CompositorNodeHueSat')
    hs.location = (-80, 0)
    _sock(hs, 'Saturation', 1.1)
    L.new(cb.outputs['Image'], hs.inputs['Image'])
    em = N.new('CompositorNodeEllipseMask')
    em.location = (-300, -300)
    _sock(em, 'Size', (1.3, 1.3))
    bl = N.new('CompositorNodeBlur')
    bl.location = (-80, -300)
    _sock(bl, 'Size', (300.0, 300.0))
    L.new(em.outputs[0], bl.inputs[0])
    mx = N.new('CompositorNodeMixRGB') if hasattr(bpy.types, 'CompositorNodeMixRGB') else N.new('ShaderNodeMix')
    mx.location = (150, 0)
    out = N.new('NodeGroupOutput')
    out.location = (400, 0)
    if mx.bl_idname == 'ShaderNodeMix':
        mx.data_type = 'RGBA'
        mx.blend_type = 'MULTIPLY'
        mx.inputs['Factor'].default_value = 0.55
        L.new(hs.outputs['Image'], mx.inputs['A'])
        L.new(bl.outputs[0], mx.inputs['B'])
        L.new(mx.outputs['Result'], out.inputs[0])
    else:
        mx.blend_type = 'MULTIPLY'
        mx.inputs[0].default_value = 0.55
        L.new(hs.outputs['Image'], mx.inputs[1])
        L.new(bl.outputs[0], mx.inputs[2])
        L.new(mx.outputs[0], out.inputs[0])
    sc.compositing_node_group = ng
    sc.render.use_compositing = True
    return [n.bl_idname for n in N]


VIEWS = {
    'down': ((-6.0, -7.0, 4.0), (4.0, 5.0, -20.0), 18.0),
    'across': ((-11.0, -3.0, -8.0), (12.0, 4.0, -4.0), 16.0),
    'up': ((3.0, -6.0, -30.0), (-2.0, 3.0, 5.0), 16.0),
}


def render_view(view, seed=7, res=(1280, 720), samples=32):
    cam, target, lens = VIEWS[view]
    step_assemble(seed, cam=(cam, target))
    step_scene(cam=cam, target=target, lens=lens)
    step_lights()
    return step_render(f'ic_{view}.png', res, samples)


FPS = 24
FALL_FRAMES = 192
FALL_TOP, FALL_BOTTOM = 40.0, -44.0


def _fall_profile(n=FALL_FRAMES):
    """Normalised distance per frame: accelerate, rush, then ease into a float."""
    v = []
    for f in range(n):
        t = f / (n - 1)
        up = _smooth01(t / 0.22)
        down = 1.0 - 0.72 * _smooth01((t - 0.72) / 0.28)
        v.append(max(up, 0.04) * down)
    s, acc = [0.0], 0.0
    for a, b in zip(v[:-1], v[1:]):
        acc += (a + b) / 2
        s.append(acc)
    return [x / acc for x in s]


def _smooth01(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def fall_pose(f, prof):
    """Camera location and euler for frame index f (0-based)."""
    n = len(prof)
    t = f / (n - 1)
    s = prof[f]
    z = FALL_TOP + (FALL_BOTTOM - FALL_TOP) * s
    r = 1.5 + 2.5 * s
    th = math.pi * 1.4 * s
    loc = Vector((r * math.cos(th), r * math.sin(th), z))
    look_up = _smooth01((t - 0.7) / 0.3)
    pitch = -86.0 + 64.0 * look_up
    heading = 20.0 + 230.0 * s + 25.0 * look_up
    speed = (prof[min(f + 1, n - 1)] - prof[max(f - 1, 0)]) * (n - 1) / 2
    shake = 0.6 * speed
    roll = 7.0 * math.sin(t * 5.0) + shake * noise.noise(Vector((t * 40, 0, 0))) * 3.0
    pitch += shake * noise.noise(Vector((0, t * 37, 0))) * 2.0
    eul = (math.radians(90.0 + pitch), math.radians(roll), math.radians(heading))
    return loc, eul


def step_fall_anim(seed=7, samples=24, res=(1280, 720)):
    prof = _fall_profile()
    poses = [fall_pose(f, prof) for f in range(FALL_FRAMES)]
    path = [p for p, _ in poses]
    clear = [(p, 3.2) for p in path[::3]]
    # keep the final look-out direction open as well
    last_loc, last_eul = poses[-1]
    fwd = (Matrix.Rotation(last_eul[2], 3, 'Z') @ Matrix.Rotation(last_eul[0], 3, 'X')) @ Vector((0, 0, -1))
    clear += [(last_loc + fwd * s, 3.0 + 0.15 * s) for s in range(0, 24, 3)]
    n = step_assemble(seed, cam=None, extra_clear=clear, deep=True)
    step_scene(cam=tuple(path[0]), target=tuple(path[0] + Vector((0, 0.1, -10))), lens=18.0)
    nl = step_lights(path=path[::4], max_lights=420, path_radius=14.0)
    step_look()

    sc = bpy.context.scene
    sc.camera.data.clip_end = 1200
    hz = bpy.data.objects['Haze']
    top = FALL_TOP + 25
    hz.location = (0, 0, (top + DEEP_BOTTOM) / 2)
    hz.scale = (2 * SHAFT_W + 10, 2 * SHAFT_W + 10, top - DEEP_BOTTOM + 20)
    sc.eevee.volumetric_start = 0.1
    sc.eevee.volumetric_end = 520.0
    sc.eevee.volumetric_sample_distribution = 0.9
    # thicker haze below the fall so each deeper storey fades a little more
    dh = bpy.data.objects.get('HazeDeep')
    if dh is None:
        dh = bpy.data.objects.new('HazeDeep', hz.data.copy())
        sc.collection.objects.link(dh)
        dm = bpy.data.materials['HazeVol'].copy()
        dm.name = 'HazeDeepVol'
        dh.data.materials[0] = dm
    dv = dh.data.materials[0].node_tree.nodes['Principled Volume']
    dv.inputs['Density'].default_value = 0.02
    dv.inputs['Color'].default_value = (1.0, 0.7, 0.5, 1)
    dh.location = (0, 0, (-55 + DEEP_BOTTOM) / 2)
    dh.scale = (2 * SHAFT_W + 8, 2 * SHAFT_W + 8, -55 - DEEP_BOTTOM)

    sc = bpy.context.scene
    cam = sc.camera
    cam.animation_data_clear()
    cam.rotation_mode = 'XYZ'
    for f, (loc, eul) in enumerate(poses):
        cam.location = loc
        cam.rotation_euler = eul
        cam.keyframe_insert('location', frame=f + 1)
        cam.keyframe_insert('rotation_euler', frame=f + 1)
    sc.frame_start, sc.frame_end = 1, FALL_FRAMES
    sc.render.fps = FPS
    sc.render.use_motion_blur = True
    sc.render.motion_blur_shutter = 0.5
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.eevee.taa_render_samples = samples
    sc.render.image_settings.file_format = 'PNG'
    sc.render.filepath = f'{OUT}/renders/fall/f_'
    return {'instances': n, 'lights': nl}


REVEAL_A = ((20, 70.0), (130, -450.0))    # (frame, z) of the clay -> colour front
REVEAL_B = ((55, 70.0), (165, -450.0))    # (frame, z) of the lights-on front
REVEAL_BAND = 5.0


def _front_z(front, f):
    (f0, z0), (f1, z1) = front
    u = min(max((f - f0) / (f1 - f0), 0.0), 1.0)
    return z0 + (z1 - z0) * u


def _reveal_group():
    """Shader group: world Z -> A (clay->colour), B (lights on), Edge (glow at front B)."""
    g = bpy.data.node_groups.get('Reveal')
    if g:
        return g
    g = bpy.data.node_groups.new('Reveal', 'ShaderNodeTree')
    g.interface.new_socket('A', in_out='OUTPUT', socket_type='NodeSocketFloat')
    g.interface.new_socket('B', in_out='OUTPUT', socket_type='NodeSocketFloat')
    g.interface.new_socket('Edge', in_out='OUTPUT', socket_type='NodeSocketFloat')
    N, L = g.nodes, g.links
    out = N.new('NodeGroupOutput')
    geo = N.new('ShaderNodeNewGeometry')
    sep = N.new('ShaderNodeSeparateXYZ')
    L.new(geo.outputs['Position'], sep.inputs[0])
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 0.08
    L.new(geo.outputs['Position'], nz.inputs['Vector'])
    jit = N.new('ShaderNodeMath')
    jit.operation = 'MULTIPLY_ADD'
    L.new(nz.outputs['Fac'], jit.inputs[0])
    jit.inputs[1].default_value = 8.0
    jit.inputs[2].default_value = -4.0
    z = N.new('ShaderNodeMath')
    z.operation = 'ADD'
    L.new(sep.outputs['Z'], z.inputs[0])
    L.new(jit.outputs[0], z.inputs[1])

    def ramp(front_name, sock):
        v = N.new('ShaderNodeValue')
        v.name = v.label = front_name
        v.outputs[0].default_value = 1000.0
        mr = N.new('ShaderNodeMapRange')
        mr.interpolation_type = 'SMOOTHSTEP'
        L.new(z.outputs[0], mr.inputs['Value'])
        L.new(v.outputs[0], mr.inputs['From Min'])
        add = N.new('ShaderNodeMath')
        add.operation = 'ADD'
        L.new(v.outputs[0], add.inputs[0])
        add.inputs[1].default_value = REVEAL_BAND
        L.new(add.outputs[0], mr.inputs['From Max'])
        L.new(mr.outputs['Result'], out.inputs[sock])
        return v

    ramp('FrontA', 'A')
    vb = ramp('FrontB', 'B')
    d = N.new('ShaderNodeMath')
    d.operation = 'SUBTRACT'
    L.new(z.outputs[0], d.inputs[0])
    L.new(vb.outputs[0], d.inputs[1])
    e = N.new('ShaderNodeMapRange')
    e.interpolation_type = 'SMOOTHSTEP'
    ab = N.new('ShaderNodeMath')
    ab.operation = 'ABSOLUTE'
    L.new(d.outputs[0], ab.inputs[0])
    L.new(ab.outputs[0], e.inputs['Value'])
    e.inputs['From Min'].default_value = 0.7
    e.inputs['From Max'].default_value = 0.0
    L.new(e.outputs['Result'], out.inputs['Edge'])
    return g


def _linear(idblock):
    """Force LINEAR on every key of an ID's action (layered actions in Blender 5)."""
    from bpy_extras import anim_utils
    ad = idblock.animation_data
    cb = anim_utils.action_get_channelbag_for_slot(ad.action, ad.action_slot)
    for fc in cb.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'


def _key(sock_owner, attr, pairs, data_path=None):
    for f, val in pairs:
        setattr(sock_owner, attr, val)
        sock_owner.keyframe_insert(data_path or attr, frame=f)


def step_reveal():
    """Clay model -> coloured -> lit, sweeping down the shaft storey by storey (fall animation)."""
    sc = bpy.context.scene
    prefs = bpy.context.preferences.edit
    interp = prefs.keyframe_new_interpolation_type
    prefs.keyframe_new_interpolation_type = 'LINEAR'
    try:
        return _step_reveal(sc)
    finally:
        prefs.keyframe_new_interpolation_type = interp


def _step_reveal(sc):
    g = _reveal_group()
    g.animation_data_clear()
    for name, front in (('FrontA', REVEAL_A), ('FrontB', REVEAL_B)):
        v = g.nodes[name].outputs[0]
        for f, zz in ((1, front[0][1]), front[0], front[1]):
            v.default_value = zz
            v.keyframe_insert('default_value', frame=f)
    _linear(g)

    for m in bpy.data.materials:
        if not m.use_nodes or m.name.startswith('Haze') or 'Principled BSDF' not in m.node_tree.nodes:
            continue
        nt = m.node_tree
        N, L = nt.nodes, nt.links
        bs = N['Principled BSDF']
        mo = next(n for n in N if n.bl_idname == 'ShaderNodeOutputMaterial')
        es = bs.inputs['Emission Strength']
        if es.is_linked and es.links[0].from_node.name.startswith('Rv'):
            mul0 = es.links[0].from_node
            src = mul0.inputs[0].links[0].from_socket if mul0.inputs[0].is_linked else None
            val = mul0.inputs[0].default_value
            for n in [n for n in N if n.name.startswith('Rv')]:
                N.remove(n)
            if src:
                L.new(src, es)
            else:
                es.default_value = val
        for n in [n for n in N if n.name.startswith('Rv')]:
            N.remove(n)
        rv = N.new('ShaderNodeGroup')
        rv.node_tree = g
        clay = N.new('ShaderNodeBsdfPrincipled')
        clay.inputs['Base Color'].default_value = (0.8, 0.8, 0.8, 1)
        clay.inputs['Roughness'].default_value = 0.65
        mix = N.new('ShaderNodeMixShader')
        L.new(rv.outputs['A'], mix.inputs['Fac'])
        L.new(clay.outputs[0], mix.inputs[1])
        L.new(bs.outputs[0], mix.inputs[2])
        mul = N.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        if es.is_linked:
            src = es.links[0].from_socket
            L.new(src, mul.inputs[0])
        else:
            mul.inputs[0].default_value = es.default_value
        L.new(rv.outputs['B'], mul.inputs[1])
        L.new(mul.outputs[0], es)
        glow = N.new('ShaderNodeEmission')
        glow.inputs['Color'].default_value = (1.0, 0.55, 0.2, 1)
        gm = N.new('ShaderNodeMath')
        gm.operation = 'MULTIPLY'
        L.new(rv.outputs['Edge'], gm.inputs[0])
        gm.inputs[1].default_value = 2.5
        L.new(gm.outputs[0], glow.inputs['Strength'])
        add = N.new('ShaderNodeAddShader')
        L.new(mix.outputs[0], add.inputs[0])
        L.new(glow.outputs[0], add.inputs[1])
        L.new(add.outputs[0], mo.inputs['Surface'])
        for n, tag in ((rv, 'RvGroup'), (clay, 'RvClay'), (mix, 'RvMix'), (mul, 'RvMul'),
                       (glow, 'RvGlow'), (gm, 'RvGlowMul'), (add, 'RvAdd')):
            n.name = tag

    # lantern lights switch on as front B passes their height (each needs its own light data)
    for ob in bpy.data.collections['Lights'].objects:
        ld = ob.data
        if ld.name.startswith('LanternLight'):
            ob.data = ld = ld.copy()
            ld.animation_data_clear()
            full = ld.energy
            (f0, z0), (f1, z1) = REVEAL_B
            f_on = f0 + (f1 - f0) * (z0 - ob.location.z) / (z0 - z1)
            _key(ld, 'energy', [(1, 0.0), (max(1, f_on - 1), 0.0), (f_on + 5, full)])
            _linear(ld)

    # global look: neutral clay studio -> dark, warm, hazy, graded
    A_END, LOOK0, LOOK1 = 95, 95, 160
    shared = {}
    for ob in bpy.data.collections['Lights'].objects:
        if ob.data.name.startswith('ShaftGlow'):
            shared[ob.data.name] = ob.data
    for ld in shared.values():
        ld.animation_data_clear()
        _key(ld, 'energy', [(LOOK0, 0.0), (LOOK1, ld.energy)])
    sky = bpy.data.objects['CoolTop'].data
    _key(sky, 'energy', [(LOOK0, 0.0), (LOOK1, sky.energy)])
    key = bpy.data.objects.get('ClayKey')
    if key is None:
        kd = bpy.data.lights.new('ClayKey', 'SUN')
        key = bpy.data.objects.new('ClayKey', kd)
        sc.collection.objects.link(key)
    key.rotation_euler = (math.radians(35), math.radians(-20), math.radians(40))
    key.data.angle = math.radians(8)
    _key(key.data, 'energy', [(1, 3.0), (A_END, 3.0), (LOOK1, 0.0)])

    bg = sc.world.node_tree.nodes['Background'].inputs['Color']
    final_bg = tuple(bg.default_value)
    _key(bg, 'default_value', [(1, (0.3, 0.3, 0.32, 1)), (A_END, (0.26, 0.25, 0.25, 1)), (LOOK1, final_bg)])
    for mname in ('HazeVol', 'HazeDeepVol'):
        m = bpy.data.materials.get(mname)
        if m:
            d = m.node_tree.nodes['Principled Volume'].inputs['Density']
            full = d.default_value
            _key(d, 'default_value', [(1, 0.0), (LOOK0 + 10, 0.0), (LOOK1, full)])
    vs = sc.view_settings
    _key(vs, 'exposure', [(1, 0.0), (LOOK1, 0.2)])

    ng = sc.compositing_node_group
    for n in ng.nodes:
        if n.bl_idname == 'CompositorNodeGlare':
            _key(n.inputs['Strength'], 'default_value', [(1, 0.0), (LOOK0 + 15, 0.0), (LOOK1, 0.55)])
        elif n.bl_idname == 'CompositorNodeColorBalance':
            _key(n.inputs['Factor'], 'default_value', [(1, 0.0), (LOOK0, 0.0), (LOOK1, 1.0)])
        elif n.bl_idname == 'ShaderNodeMix':
            _key(n.inputs['Factor'], 'default_value', [(1, 0.0), (LOOK0, 0.0), (LOOK1, 0.55)])
    sc.render.filepath = f'{OUT}/renders/fall_reveal/f_'
    return len(shared)


def build_all(seed=7):
    step_reset()
    step_blocks()
    n = step_assemble(seed)
    step_scene()
    nl = step_lights()
    return {'instances': n, 'lights': nl}
