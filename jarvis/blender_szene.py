"""Läuft in Blender, nicht in Jarvis: baut ein Blueprint-Modell nach und rendert es oder speichert eine .blend-Datei.

jarvis/blender.py startet: blender -b --factory-startup --python blender_szene.py -- auftrag.json

auftrag.json: {"szene": {...wie im Blueprint...}, "bild": ".../foto.png", "vorschau": ".../foto.jpg",
"blend": ".../modell.blend", "breite": 1600, "hoehe": 900, "samples": 128, "samples_cpu": 48, "sekunden": 150,
"gpu": true}
Ohne "bild" wird nicht gerendert, ohne "blend" nichts gespeichert.

Jedes Teil entsteht aus seinen Maßen wie in blaupause.js (dort zeigt y nach oben, in Blender z) und bekommt ein
echtes Material (Metall, Lack, Glas, Leuchten). Dazu kommt ein Fotostudio mit Hohlkehle, Licht von vier Seiten und
eine Kamera, die das Modell schräg von vorne formatfüllend ins Bild nimmt. Mit "groesse_m" hat das Modell in
Blender seine echte Größe. Was Jarvis wissen muss, steht in Zeilen "JARVIS-BLENDER {json}" auf stdout.
"""

import json
import math
import os
import re
import sys
import time

import bmesh
import bpy
from mathutils import Matrix, Vector

START = time.time()
# three.js (y oben, z zum Betrachter) -> Blender (z oben, -y zum Betrachter)
UP = Matrix.Rotation(math.radians(90), 4, "X")


def report(step, **data):
    # nur ASCII: unter Windows schreibt Blender nicht unbedingt UTF-8, \u00e4 kommt trotzdem heil an
    print("JARVIS-BLENDER " + json.dumps({"schritt": step, **data}), flush=True)


def num(value, default=0.0):
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def vec(value, default):
    items = list(value) if isinstance(value, (list, tuple)) else []
    return [num(items[i], d) if i < len(items) else d for i, d in enumerate(default)]


def points(value, size, least):
    out = [vec(p, [0.0] * size) for p in (value if isinstance(value, list) else []) if isinstance(p, (list, tuple))]
    return out if len(out) >= least else None


def srgb(hex_text):
    text = str(hex_text or "").lstrip("#")
    try:
        return [int(text[i:i + 2], 16) / 255 for i in (0, 2, 4)] if len(text) == 6 else [0.6, 0.65, 0.7]
    except ValueError:
        return [0.6, 0.65, 0.7]


def linear(rgb):
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]


# ---------------------------------------------------------------------- Formen (wie in blaupause.js, y oben)


def lathe(profile, segments=64):
    """Umriss [[r, y], ...] um die y-Achse gedreht (THREE.LatheGeometry). Punkte mit r = 0 werden ein Pol."""
    verts, faces, rings = [], [], []
    for r, y in profile:
        if r <= 1e-6:
            rings.append([len(verts)] * segments)
            verts.append((0.0, y, 0.0))
            continue
        rings.append(list(range(len(verts), len(verts) + segments)))
        verts.extend((r * math.sin(2 * math.pi * i / segments), y, r * math.cos(2 * math.pi * i / segments))
                     for i in range(segments))
    for low, high in zip(rings, rings[1:]):
        for i in range(segments):
            j = (i + 1) % segments
            face = []
            for v in (low[i], low[j], high[j], high[i]):
                if v not in face:
                    face.append(v)
            if len(face) >= 3:
                faces.append(face)
    return verts, faces


def rounder(profile, steps=4, corner=40):
    """Ein Umriss mit wenigen Punkten (Helm, Rumpf) wird zwischen den Punkten zur weichen Kurve (Catmull-Rom).
    Knicke über `corner` Grad (Düsen, Kanten) bleiben Knicke."""
    if len(profile) < 3:
        return profile
    pts = [Vector((r, y)) for r, y in profile]

    def bend(i):
        if i == 0 or i == len(pts) - 1:
            return 180.0
        a, b = pts[i] - pts[i - 1], pts[i + 1] - pts[i]
        if a.length < 1e-9 or b.length < 1e-9:
            return 180.0
        return math.degrees(a.angle(b))

    def tangent(i):
        if bend(i) > corner:
            return None
        return (pts[i + 1] - pts[i - 1]) / 2

    out = []
    for i in range(len(pts) - 1):
        p0, p1 = pts[i], pts[i + 1]
        t0, t1 = tangent(i), tangent(i + 1)
        out.append([p0.x, p0.y])
        if t0 is None and t1 is None:
            continue
        t0 = t0 if t0 is not None else p1 - p0
        t1 = t1 if t1 is not None else p1 - p0
        for k in range(1, steps):
            s = k / steps
            h = (2 * s ** 3 - 3 * s ** 2 + 1, s ** 3 - 2 * s ** 2 + s, -2 * s ** 3 + 3 * s ** 2, s ** 3 - s ** 2)
            p = p0 * h[0] + t0 * h[1] + p1 * h[2] + t1 * h[3]
            out.append([max(0.0, p.x), p.y])
    out.append([pts[-1].x, pts[-1].y])
    return out


def sphere(r):
    steps = 32
    return lathe([[r * math.cos(a), r * math.sin(a)]
                  for a in (-math.pi / 2 + math.pi * k / steps for k in range(steps + 1))], 64)


def cylinder(top, bottom, height):
    return lathe([[0.0, -height / 2], [bottom, -height / 2], [top, height / 2], [0.0, height / 2]], 64)


def capsule(r, length):
    steps = 12
    low = [[r * math.cos(a), -length / 2 + r * math.sin(a)] for a in (-math.pi / 2 + math.pi / 2 * k / steps
                                                                      for k in range(steps + 1))]
    high = [[r * math.cos(a), length / 2 + r * math.sin(a)] for a in (math.pi / 2 * k / steps for k in range(steps + 1))]
    return lathe(low + high, 48)


def torus(radius, tube, major=96, minor=24):
    verts, faces = [], []
    for i in range(major):
        u = 2 * math.pi * i / major
        for j in range(minor):
            v = 2 * math.pi * j / minor
            ring = radius + tube * math.cos(v)
            verts.append((ring * math.cos(u), ring * math.sin(u), tube * math.sin(v)))
    for i in range(major):
        for j in range(minor):
            k, m = (i + 1) % major, (j + 1) % minor
            faces.append([i * minor + j, k * minor + j, k * minor + m, i * minor + m])
    return verts, faces


def box(w, h, d):
    x, y, z = w / 2, h / 2, d / 2
    verts = [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z), (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]
    return verts, [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]]


def smooth(mesh, angle=40):
    """Glatt schattiert, Kanten über `angle` Grad bleiben scharf (Blender 4.1+ und älter)."""
    try:
        mesh.shade_smooth()
    except AttributeError:
        mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    try:
        mesh.set_sharp_from_angle(angle=math.radians(angle))
    except AttributeError:
        mesh.use_auto_smooth = True
        mesh.auto_smooth_angle = math.radians(angle)
    mesh.update()


def tidy(mesh, angle=40):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    smooth(mesh, angle)
    return mesh


def mesh_from(name, data):
    verts, faces = data
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    return tidy(mesh)


def curve_mesh(name, setup):
    """Eine Kurve (Profil mit Löchern, Rohr) bauen lassen und als Netz übernehmen."""
    curve = bpy.data.curves.new(name, "CURVE")
    setup(curve)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.scene.collection.objects.link(obj)
    try:
        mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    finally:
        bpy.data.objects.remove(obj)
        bpy.data.curves.remove(curve)
    mesh.name = name
    return tidy(mesh)


def extrusion(name, part):
    outline = points(part.get("umriss"), 2, 3)
    if outline is None:
        return None
    holes = [h for h in (points(x, 2, 3) for x in (part.get("loecher") or [])[:24]) if h]
    depth = max(0.001, num(part.get("tiefe"), 0.1))
    bevel = min(max(0.0, num(part.get("fase"))), depth / 3)

    def setup(curve):
        curve.dimensions = "2D"
        curve.fill_mode = "BOTH"
        curve.extrude = depth / 2
        curve.bevel_depth = bevel
        curve.bevel_resolution = 3 if bevel > 0 else 0
        for ring in [outline] + holes:
            spline = curve.splines.new("POLY")
            spline.points.add(len(ring) - 1)
            for point, (x, y) in zip(spline.points, ring):
                point.co = (x, y, 0.0, 1.0)
            spline.use_cyclic_u = True

    return curve_mesh(name, setup)


def tube(name, part):
    path = points(part.get("pfad"), 3, 2)
    if path is None:
        return None
    radius = max(0.001, num(part.get("radius"), 0.03))

    def setup(curve):
        curve.dimensions = "3D"
        curve.bevel_depth = radius
        curve.bevel_resolution = 5
        curve.use_fill_caps = True
        curve.resolution_u = 16
        spline = curve.splines.new("BEZIER")
        spline.bezier_points.add(len(path) - 1)
        for point, co in zip(spline.bezier_points, path):
            point.co = co
            point.handle_left_type = point.handle_right_type = "AUTO"

    return curve_mesh(name, setup)


def geometry(part):
    """Das Netz eines Teils in seinen eigenen Koordinaten (y oben), oder None."""
    name = str(part.get("id") or "teil")
    form = part.get("form")
    m = part.get("masse") if isinstance(part.get("masse"), list) else []

    def size(i, default):
        value = num(m[i], default) if i < len(m) else default
        return value if value > 0 else default

    if form == "quader":
        return mesh_from(name, box(size(0, 0.5), size(1, 0.5), size(2, 0.5)))
    if form == "kugel":
        return mesh_from(name, sphere(size(0, 0.3)))
    if form == "zylinder":
        top = max(0.0, num(m[0], 0.2) if m else 0.2)
        bottom = max(0.0, num(m[1], 0.2) if len(m) > 1 else 0.2)
        return mesh_from(name, cylinder(top, bottom if top or bottom else 0.01, size(2, 0.5)))
    if form == "kegel":
        return mesh_from(name, cylinder(0.0, size(0, 0.2), size(1, 0.5)))
    if form == "ring":
        return mesh_from(name, torus(size(0, 0.4), size(1, 0.05)))
    if form == "kapsel":
        return mesh_from(name, capsule(size(0, 0.15), size(1, 0.5)))
    if form == "drehkoerper":
        profile = points(part.get("profil"), 2, 2)
        return mesh_from(name, lathe(rounder([[max(0.0, r), y] for r, y in profile]), 96)) if profile else None
    if form == "extrusion":
        return extrusion(name, part)
    if form == "rohr":
        return tube(name, part)
    return None


def part_matrix(part):
    pos = vec(part.get("pos"), [0.0, 0.0, 0.0])
    rx, ry, rz = (math.radians(a) for a in vec(part.get("dreh"), [0.0, 0.0, 0.0]))
    sx, sy, sz = (max(1e-4, v) for v in vec(part.get("skala"), [1.0, 1.0, 1.0]))
    # three.js-Euler "XYZ" heißt Rx · Ry · Rz
    rot = Matrix.Rotation(rx, 4, "X") @ Matrix.Rotation(ry, 4, "Y") @ Matrix.Rotation(rz, 4, "Z")
    return UP @ Matrix.Translation(pos) @ rot @ Matrix.Diagonal((sx, sy, sz, 1.0))


# ---------------------------------------------------------------------- Materialien


def put(node, names, value):
    """Eingang setzen; die Namen haben sich mit Blender 4.0 geändert (Emission -> Emission Color usw.)."""
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            try:
                socket.default_value = value
                return True
            except (TypeError, ValueError):
                pass
    return False


def node_tree(owner):
    if bpy.app.version < (5, 0, 0):  # ab Blender 5.0 immer an (und das Umschalten veraltet)
        owner.use_nodes = True
    return owner.node_tree


def material(part):
    kind = str(part.get("material") or "metall")
    hex_text = str(part.get("farbe") or "#9aa7b0").lower()
    key = f"{hex_text} {kind}"
    found = bpy.data.materials.get(key)
    if found is not None:
        return found
    mat = bpy.data.materials.new(key)
    nodes = node_tree(mat).nodes
    bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
    rgb = srgb(hex_text)
    base = linear(rgb)
    mat.diffuse_color = (*base, 1.0)
    if bsdf is None:
        return mat
    high, low = max(rgb), min(rgb)
    saturation = (high - low) / high if high > 0 else 0.0
    put(bsdf, ("Base Color",), (*base, 1.0))
    if kind == "metall" and saturation > 0.35:
        # Lack auf Metall (Iron-Man-Rot, Autolack): farbig, mit glänzendem Klarlack
        put(bsdf, ("Metallic",), 0.45)
        put(bsdf, ("Roughness",), 0.34)
        put(bsdf, ("Coat Weight", "Clearcoat"), 1.0)
        put(bsdf, ("Coat Roughness", "Clearcoat Roughness"), 0.04)
    elif kind == "metall":
        put(bsdf, ("Metallic",), 1.0)
        put(bsdf, ("Roughness",), 0.24)
        put(bsdf, ("Anisotropic",), 0.3)
    elif kind == "matt":
        put(bsdf, ("Metallic",), 0.0)
        put(bsdf, ("Roughness",), 0.62)
    elif kind == "glas":
        tint = linear([0.55 + 0.45 * c for c in rgb])
        put(bsdf, ("Base Color",), (*tint, 1.0))
        put(bsdf, ("Metallic",), 0.0)
        put(bsdf, ("Roughness",), 0.02)
        put(bsdf, ("IOR",), 1.45)
        put(bsdf, ("Transmission Weight", "Transmission"), 1.0)
    elif kind == "leuchten":
        put(bsdf, ("Roughness",), 0.3)
        put(bsdf, ("Emission Color", "Emission"), (*base, 1.0))
        put(bsdf, ("Emission Strength",), 14.0)
    else:  # holo
        put(bsdf, ("Roughness",), 0.2)
        put(bsdf, ("Alpha",), 0.35)
        put(bsdf, ("Emission Color", "Emission"), (*base, 1.0))
        put(bsdf, ("Emission Strength",), 2.0)
    return mat


def studio_material():
    mat = bpy.data.materials.new("Studio")
    nodes = node_tree(mat).nodes
    bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
    base = linear(srgb("#1a1e26"))
    mat.diffuse_color = (*base, 1.0)
    if bsdf is not None:
        put(bsdf, ("Base Color",), (*base, 1.0))
        put(bsdf, ("Roughness",), 0.32)
        put(bsdf, ("Specular IOR Level", "Specular"), 0.5)
    return mat


# ---------------------------------------------------------------------- Szene


def clear():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.curves):
        for item in list(block):
            block.remove(item)


def build(scene_data):
    """Alle Teile als Objekte unter dem Leerobjekt "Modell", nach Baugruppen in Sammlungen. Gibt (Wurzel, Teile)."""
    scene = bpy.context.scene
    name = str(scene_data.get("name") or "Blueprint")[:60]
    model = bpy.data.collections.new(name)
    scene.collection.children.link(model)
    root = bpy.data.objects.new("Modell", None)
    root.empty_display_type = "PLAIN_AXES"
    model.objects.link(root)
    groups = {}
    objects = []
    for part in scene_data.get("teile") or []:
        if not isinstance(part, dict):
            continue
        try:
            mesh = geometry(part)
        except Exception as exc:  # ein kaputtes Teil hält das Bild nicht auf
            report("teil_fehler", id=str(part.get("id")), text=str(exc)[:200])
            continue
        if mesh is None:
            continue
        mesh.materials.append(material(part))
        obj = bpy.data.objects.new(str(part.get("name") or part.get("id") or "Teil")[:60], mesh)
        group = str(part.get("gruppe") or "").strip()
        target = model
        if group:
            if group not in groups:
                groups[group] = bpy.data.collections.new(group)
                model.children.link(groups[group])
            target = groups[group]
        target.objects.link(obj)
        obj.parent = root
        obj.matrix_basis = part_matrix(part)
        if part.get("versteckt"):
            obj.hide_render = True
            obj.hide_viewport = True
        if part.get("form") == "quader" and num(part.get("rundung")) > 0:
            bevel = obj.modifiers.new("Rundung", "BEVEL")
            bevel.width = num(part.get("rundung"))
            bevel.segments = 4
            bevel.limit_method = "ANGLE"
            try:
                bevel.harden_normals = True
            except AttributeError:
                pass
        objects.append(obj)
    bpy.context.view_layer.update()
    return root, objects


def bounds(objects):
    corners = [obj.matrix_world @ Vector(c) for obj in objects if not obj.hide_render for c in obj.bound_box]
    if not corners:
        return Vector((-1, -1, 0)), Vector((1, 1, 2)), corners
    low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return low, high, corners


def backdrop(center, radius, floor):
    """Hohlkehle wie im Fotostudio: Boden, der hinten in einer Rundung zur Wand wird."""
    r = radius
    back = center.y + 2.5 * r
    bend = 6 * r
    profile = [(center.y - 60 * r, floor), (back, floor)]
    profile += [(back + bend * math.sin(a), floor + bend - bend * math.cos(a))
                for a in (math.pi / 2 * k / 24 for k in range(1, 25))]
    profile.append((back + bend, floor + 40 * r))
    width = 60 * r
    verts = [(x, y, z) for y, z in profile for x in (center.x - width, center.x + width)]
    faces = [[2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2] for i in range(len(profile) - 1)]
    mesh = bpy.data.meshes.new("Studio")
    mesh.from_pydata(verts, [], faces)
    tidy(mesh, angle=60)
    mesh.materials.append(studio_material())
    obj = bpy.data.objects.new("Studio", mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def aim(obj, target):
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def lights(center, radius):
    """Hauptlicht vorne links, Aufheller rechts, kühles Kantenlicht von hinten, weiches Licht von oben."""
    r = radius
    setups = (
        ("Hauptlicht", (-2.4, -2.6, 2.4), 2.2, 1.0, (1.0, 0.97, 0.92)),
        ("Aufheller", (3.0, -1.6, 0.9), 3.0, 0.3, (0.86, 0.93, 1.0)),
        ("Kantenlicht", (1.2, 3.4, 2.6), 1.6, 1.3, (0.62, 0.88, 1.0)),
        ("Oberlicht", (0.0, 0.3, 4.2), 4.0, 0.35, (1.0, 1.0, 1.0)),
    )
    made = []
    for name, offset, size, share, tint in setups:
        light = bpy.data.lights.new(name, "AREA")
        light.shape = "DISK"
        light.size = size * r
        light.color = tint
        distance = Vector(offset).length * r
        light.energy = 45 * share * distance * distance
        obj = bpy.data.objects.new(name, light)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = center + Vector(offset) * r
        aim(obj, center)
        made.append(obj)
    return made


def camera(center, corners, aspect):
    """Schräg von vorne rechts, leicht von oben, das Modell füllt das Bild (mit Rand)."""
    data = bpy.data.cameras.new("Kamera")
    data.lens = 55
    data.sensor_fit = "HORIZONTAL"
    data.sensor_width = 36
    tan_h = 18 / data.lens
    tan_v = tan_h / aspect
    az, el = math.radians(34), math.radians(17)
    forward = Vector((-math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), -math.sin(el)))
    right = forward.cross(Vector((0, 0, 1))).normalized()
    up = right.cross(forward).normalized()
    target = center.copy()
    margin = 0.84
    distance = 1.0
    for _ in range(3):
        need = 0.0
        for c in corners:
            v = c - target
            depth = v.dot(forward)
            need = max(need, abs(v.dot(right)) / (tan_h * margin) - depth, abs(v.dot(up)) / (tan_v * margin) - depth)
        distance = max(need, 0.01)
        eye = target - forward * distance
        xs, ys = [], []
        for c in corners:
            v = c - eye
            depth = max(1e-6, v.dot(forward))
            xs.append(v.dot(right) / depth)
            ys.append(v.dot(up) / depth)
        # Ziel so verschieben, dass das Modell mittig sitzt, dann den Abstand neu rechnen
        target = target + right * ((min(xs) + max(xs)) / 2 * distance) + up * ((min(ys) + max(ys)) / 2 * distance)
    obj = bpy.data.objects.new("Kamera", data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = target - forward * distance
    aim(obj, target)
    data.clip_start = max(0.001, distance / 200)
    data.clip_end = distance * 100
    data.dof.use_dof = True
    data.dof.focus_distance = distance
    data.dof.aperture_fstop = 8.0
    bpy.context.scene.camera = obj
    return obj


def world():
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new("Studio")
    tree = node_tree(scene.world)
    background = next((n for n in tree.nodes if n.type == "BACKGROUND"), None)
    if background is not None:
        background.inputs["Color"].default_value = (*linear(srgb("#0d1016")), 1.0)
        background.inputs["Strength"].default_value = 1.0


def glare():
    """Leuchtende Teile strahlen etwas (Compositor). Geht das in dieser Blender-Version nicht, eben ohne."""
    scene = bpy.context.scene
    try:
        # Auf dem Prozessor: Blender 5 nimmt sonst die Grafikkarte und bricht ohne passenden Treiber hart ab.
        # Für ein Bild dauert das Leuchten so oder so nur Sekundenbruchteile.
        scene.render.compositor_device = "CPU"
    except (AttributeError, TypeError, ValueError):
        pass
    if hasattr(scene, "compositing_node_group"):
        return glare_5(scene)
    try:
        scene.use_nodes = True
        tree = scene.node_tree
        if tree is None:
            raise AttributeError("kein Compositor-Baum")
        layers = next(n for n in tree.nodes if n.type == "R_LAYERS")
        out = next(n for n in tree.nodes if n.type == "COMPOSITE")
        node = tree.nodes.new("CompositorNodeGlare")
        node.glare_type = "FOG_GLOW"
        for attr, value in (("quality", "HIGH"), ("threshold", 2.5), ("size", 7), ("mix", -0.55)):
            if hasattr(node, attr):
                setattr(node, attr, value)
        tree.links.new(layers.outputs["Image"], node.inputs["Image"])
        tree.links.new(node.outputs["Image"], out.inputs["Image"])
        return True
    except Exception as exc:
        report("ohne_glanz", text=str(exc)[:200])
        try:
            scene.use_nodes = False
        except Exception:
            pass
        return False


def glare_5(scene):
    """Ab Blender 5.0 ist der Compositor eine Knotengruppe, die Einstellungen des Leuchtens sind Eingänge."""
    try:
        tree = bpy.data.node_groups.new("Jarvis Leuchten", "CompositorNodeTree")
        tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        layers = tree.nodes.new("CompositorNodeRLayers")
        node = tree.nodes.new("CompositorNodeGlare")
        out = tree.nodes.new("NodeGroupOutput")
        for name, values in (("Type", ("Bloom", "Fog Glow")), ("Quality", ("High",)), ("Threshold", (2.5,)),
                             ("Strength", (0.45,)), ("Size", (0.6,))):
            socket = node.inputs.get(name)
            for value in values:
                try:
                    socket.default_value = value
                    break
                except (AttributeError, TypeError, ValueError):
                    continue
        tree.links.new(layers.outputs["Image"], node.inputs["Image"])
        tree.links.new(node.outputs["Image"], out.inputs[0])
        scene.compositing_node_group = tree
        return True
    except Exception as exc:
        report("ohne_glanz", text=str(exc)[:200])
        try:
            scene.compositing_node_group = None
        except Exception:
            pass
        return False


_SAMPLE = re.compile(r"Sample (\d+)/(\d+)")
_REMAINING = re.compile(r"Remaining:\s*(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)")
_shown = {"prozent": -1, "kerne": False}


def on_stats(stats, *_):
    """Fortschritt beim Rendern. Blender 5 schreibt ihn nicht mehr von selbst auf stdout, darum über den Handler."""
    text = str(stats or "")
    if not _shown["kerne"] and "kernel" in text.lower():
        _shown["kerne"] = True  # "Loading render kernels (may take a few minutes the first time)"
        report("kerne")
    found = _SAMPLE.search(text)
    if not found:
        return
    percent = min(100, round(int(found.group(1)) * 100 / max(1, int(found.group(2)))))
    if percent == _shown["prozent"]:
        return
    _shown["prozent"] = percent
    rest = _REMAINING.search(text)
    seconds = int(rest.group(1) or 0) * 3600 + int(rest.group(2)) * 60 + float(rest.group(3)) if rest else None
    report("fortschritt", prozent=percent, rest=seconds)


def use_gpu(wanted):
    """Grafikkarte für Cycles einschalten (OptiX, CUDA, HIP, oneAPI, Metal). Gibt den Namen oder "CPU"."""
    scene = bpy.context.scene
    scene.cycles.device = "CPU"
    if not wanted:
        return "CPU"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except (KeyError, AttributeError):
        return "CPU"
    for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            prefs.compute_device_type = kind
        except (TypeError, ValueError):
            continue
        try:
            prefs.refresh_devices()
        except AttributeError:
            prefs.get_devices()
        found = [d for d in prefs.devices if d.type == kind]
        if found:
            for device in prefs.devices:
                device.use = device.type == kind
            scene.cycles.device = "GPU"
            return f"{kind} ({found[0].name})"
    try:
        prefs.compute_device_type = "NONE"
    except (TypeError, ValueError):
        pass
    return "CPU"


def render_settings(job):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    cycles = scene.cycles
    cycles.samples = int(num(job.get("samples"), 128))
    for attr, value in (("use_adaptive_sampling", True), ("adaptive_threshold", 0.02), ("use_denoising", True),
                        ("max_bounces", 10), ("glossy_bounces", 6), ("transmission_bounces", 10),
                        ("transparent_max_bounces", 12), ("caustics_reflective", False),
                        ("caustics_refractive", False), ("blur_glossy", 0.5),
                        ("time_limit", num(job.get("sekunden"), 0.0))):
        if hasattr(cycles, attr):
            try:
                setattr(cycles, attr, value)
            except (TypeError, ValueError):
                pass
    try:
        cycles.denoiser = "OPENIMAGEDENOISE"
    except (TypeError, ValueError, AttributeError):
        pass
    scene.render.resolution_x = int(num(job.get("breite"), 1600))
    scene.render.resolution_y = int(num(job.get("hoehe"), 900))
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    view = scene.view_settings
    for transform, looks in (("AgX", ("AgX - Medium High Contrast", "Medium High Contrast")),
                             ("Filmic", ("Medium High Contrast", "Filmic - Medium High Contrast"))):
        try:
            view.view_transform = transform
        except (TypeError, ValueError):
            continue
        for look in looks:
            try:
                view.look = look
                break
            except (TypeError, ValueError):
                continue
        break
    try:
        scene.unit_settings.system = "METRIC"
    except (TypeError, ValueError):
        pass


def save_image(image, path, fmt, scene):
    settings = scene.render.image_settings
    settings.file_format = fmt
    settings.color_mode = "RGB"
    if fmt == "JPEG":
        settings.quality = 88
    else:
        settings.color_depth = "8"
        settings.compression = 15
    image.save_render(path, scene=scene)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        report("fehler", text="Kein Auftrag.")
        return 2
    with open(argv[0], encoding="utf-8") as handle:
        job = json.load(handle)
    scene_data = job.get("szene") if isinstance(job.get("szene"), dict) else {}
    clear()
    scene = bpy.context.scene
    render_settings(job)
    world()
    root, objects = build(scene_data)
    if not objects:
        report("fehler", text="Das Modell hat keine Teile, die Blender bauen kann.")
        return 3
    low, high, _ = bounds(objects)
    size = num(scene_data.get("groesse_m"), 0.0)
    if size > 0 and high.z - low.z > 1e-6:
        scale = min(1000.0, max(0.001, size / (high.z - low.z)))
        root.scale = (scale, scale, scale)
        bpy.context.view_layer.update()
        low, high, _ = bounds(objects)
    low, high, corners = bounds(objects)
    center = (low + high) / 2
    radius = max((high - low).length / 2, 1e-3)
    backdrop(center, radius, min(0.0, low.z))
    lights(center, radius)
    aspect = scene.render.resolution_x / max(1, scene.render.resolution_y)
    camera(center, corners, aspect)
    glare()
    device = use_gpu(bool(job.get("gpu", True)))
    if device == "CPU":  # auf dem Prozessor weniger Durchgänge: der Entrauscher glättet den Rest
        scene.cycles.samples = min(scene.cycles.samples, int(num(job.get("samples_cpu"), 48)))
    report("gebaut", teile=len(objects), geraet=device, sekunden=round(time.time() - START, 1))
    if job.get("blend"):
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(job["blend"]), check_existing=False, compress=True)
        report("gespeichert", blend=str(job["blend"]))
    if job.get("bild"):
        began = time.time()
        bpy.app.handlers.render_stats.append(on_stats)
        bpy.ops.render.render(write_still=False)
        image = bpy.data.images.get("Render Result")
        if image is None:
            report("fehler", text="Blender hat kein Bild geliefert.")
            return 4
        save_image(image, os.path.abspath(job["bild"]), "PNG", scene)
        if job.get("vorschau"):
            save_image(image, os.path.abspath(job["vorschau"]), "JPEG", scene)
        report("fertig", bild=str(job["bild"]), geraet=device, sekunden=round(time.time() - began, 1))
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as exc:
        report("fehler", text=f"{type(exc).__name__}: {exc}"[:300])
        code = 1
    sys.stdout.flush()
    if code:
        sys.exit(code)
