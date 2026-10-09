"""Weiche Formen für den Blueprint (Form "weich"): Kugeln und Stäbe, die wie flüssiges Metall ineinanderfließen.

Georg: "die Modelle sehen so arsch aus, ich möchte sagen können: hol das Herz, animier das so, dass es verschmilzt".
Aus Quadern und Zylindern wird kein schönes Herz. Eine weiche Form ist dagegen eine glatte Vereinigung von Kugeln
[x, y, z, r] und Stäben [x1, y1, z1, x2, y2, z2, r] (Abstandsfelder mit weichem Minimum, "glaette" = wie weit sie
ineinanderfließen). Daraus wird ein Netz über ein Gitter gelegt (Surface Nets): jede Gitterzelle, durch die die
Oberfläche geht, bekommt einen Punkt, und je vier Punkte um eine geschnittene Gitterkante ein Viereck.

blaupause.js rechnet dasselbe im Fenster (dort auch jedes Bild neu, wenn die Kugeln beim Verschmelzen zueinander
fließen). Hier entsteht das Netz für Blender ("Render das", "Öffne das in Blender"), das selbst kein Gitter rechnet.
"""

from __future__ import annotations

import math

MAX_BALLS = 32
MAX_RODS = 16
RESOLUTION = 64  # Zellen entlang der längsten Seite (im Fenster 56, beim Verschmelzen weniger)


def _smin(a, b, k: float):
    """Weiches Minimum (polynomiell): k = wie weit die Formen ineinanderfließen, 0 = harte Kante."""
    import numpy as np

    if k <= 0:
        return np.minimum(a, b)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def field(points, balls, rods, k: float):
    """Abstand zur Oberfläche für viele Punkte (N x 3): innen negativ, außen positiv."""
    import numpy as np

    d = np.full(len(points), 1e9)
    for x, y, z, r in balls:
        d = _smin(d, np.linalg.norm(points - (x, y, z), axis=1) - r, k)
    for x1, y1, z1, x2, y2, z2, r in rods:
        a = np.array((x1, y1, z1))
        ab = np.array((x2, y2, z2)) - a
        length = float(ab @ ab) or 1e-12
        t = np.clip(((points - a) @ ab) / length, 0.0, 1.0)
        d = _smin(d, np.linalg.norm(points - (a + t[:, None] * ab), axis=1) - r, k)
    return d


def bounds(balls, rods, k: float):
    lows, highs = [], []
    for x, y, z, r in balls:
        lows.append((x - r, y - r, z - r))
        highs.append((x + r, y + r, z + r))
    for x1, y1, z1, x2, y2, z2, r in rods:
        lows.append((min(x1, x2) - r, min(y1, y2) - r, min(z1, z2) - r))
        highs.append((max(x1, x2) + r, max(y1, y2) + r, max(z1, z2) + r))
    pad = k * 0.5 + 0.02
    low = [min(p[i] for p in lows) - pad for i in range(3)]
    high = [max(p[i] for p in highs) + pad for i in range(3)]
    return low, high


def mesh(balls, rods=(), k: float = 0.12, resolution: int = RESOLUTION):
    """(Punkte, Dreiecke, Normalen) der weichen Form, oder None, wenn sie leer ist."""
    import numpy as np

    balls = [tuple(float(v) for v in b) for b in list(balls)[:MAX_BALLS]]
    rods = [tuple(float(v) for v in r) for r in list(rods)[:MAX_RODS]]
    if not balls and not rods:
        return None
    low, high = bounds(balls, rods, k)
    step = max(high[i] - low[i] for i in range(3)) / max(8, int(resolution))
    n = [max(2, int(math.ceil((high[i] - low[i]) / step))) for i in range(3)]
    axes = [low[i] + step * np.arange(n[i] + 1) for i in range(3)]
    gx, gy, gz = np.meshgrid(*axes, indexing="ij")
    grid = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
    values = field(grid, balls, rods, k).reshape(n[0] + 1, n[1] + 1, n[2] + 1)
    inside = values < 0
    if not inside.any() or inside.all():
        return None

    # Ecken einer Zelle und ihre zwölf Kanten
    corners = [(i, j, l) for l in (0, 1) for j in (0, 1) for i in (0, 1)]
    edges = [(a, b) for a in range(8) for b in range(a + 1, 8)
             if sum(abs(corners[a][d] - corners[b][d]) for d in range(3)) == 1]
    c = np.stack([inside[i:i + n[0], j:j + n[1], l:l + n[2]] for i, j, l in corners])
    crossing = c.any(axis=0) & ~c.all(axis=0)
    cells = np.argwhere(crossing)
    index = -np.ones(n, dtype=np.int64)
    index[tuple(cells.T)] = np.arange(len(cells))

    # Ein Punkt pro Zelle: Mittel der Stellen, an denen die Oberfläche die Zellkanten schneidet
    sums = np.zeros((len(cells), 3))
    counts = np.zeros(len(cells))
    for a, b in edges:
        ca, cb = np.array(corners[a]), np.array(corners[b])
        va = values[tuple((cells + ca).T)]
        vb = values[tuple((cells + cb).T)]
        cut = (va < 0) != (vb < 0)
        t = np.where(cut, va / np.where(va - vb == 0, 1e-12, va - vb), 0.0)
        point = cells + ca + t[:, None] * (cb - ca)
        sums += np.where(cut[:, None], point, 0.0)
        counts += cut
    verts = np.array(low) + step * (sums / np.maximum(counts, 1)[:, None])

    # Vierecke um jede geschnittene Gitterkante (die vier Zellen drumherum)
    quads = []
    for axis in range(3):
        u, v = (axis + 1) % 3, (axis + 2) % 3
        sl = [slice(0, n[d] + 1) for d in range(3)]
        sl[axis] = slice(0, n[axis])
        a = inside[tuple(sl)]
        sl2 = list(sl)
        sl2[axis] = slice(1, n[axis] + 1)
        b = inside[tuple(sl2)]
        cut = np.argwhere(a != b)
        if not len(cut):
            continue
        keep = (cut[:, u] > 0) & (cut[:, u] < n[u]) & (cut[:, v] > 0) & (cut[:, v] < n[v])
        cut = cut[keep]
        flip = a[tuple(cut.T)]  # innen am Anfang der Kante: Normale zeigt in Richtung der Achse

        def cell(du, dv):
            p = cut.copy()
            p[:, u] -= du
            p[:, v] -= dv
            return index[tuple(p.T)]

        q = np.stack([cell(1, 1), cell(0, 1), cell(0, 0), cell(1, 0)], axis=1)
        ok = (q >= 0).all(axis=1)
        q, flip = q[ok], flip[ok]
        q = np.where(flip[:, None], q, q[:, ::-1])
        quads.append(q)
    if not quads:
        return None
    quads = np.concatenate(quads)
    tris = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])

    # Glatte Normalen aus dem Feld (zeigt nach außen)
    e = step * 0.5
    grad = np.stack([field(verts + d, balls, rods, k) - field(verts - d, balls, rods, k)
                     for d in (np.array((e, 0, 0)), np.array((0, e, 0)), np.array((0, 0, e)))], axis=1)
    normals = grad / np.maximum(np.linalg.norm(grad, axis=1), 1e-12)[:, None]
    return verts, tris, normals


def blender_mesh(part: dict, resolution: int = RESOLUTION) -> dict | None:
    """Fürs Blender-Skript: {"punkte": [[x,y,z],...], "flaechen": [[a,b,c],...]} oder None."""
    made = mesh(part.get("kugeln") or [], part.get("staebe") or [], float(part.get("glaette", 0.12) or 0.0),
                resolution)
    if made is None:
        return None
    verts, tris, _normals = made
    return {"punkte": [[round(float(v), 5) for v in p] for p in verts], "flaechen": tris.tolist()}
