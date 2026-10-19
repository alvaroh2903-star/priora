"""Scene 1 · s1_ignite (3.0 s) — logo icon neon ignition, bullet fired out of the A.

Beat sheet (local seconds):
  0.00  pure black; halftone corners breathe in; the unlit sign is dead glass
  0.20  neon start: the sign is three tubes cut along the letter's own miters
        (left leg+shoulder, top bar, right shoulder+leg) plus the bullet.
        They sputter near-binary (dead <-> full), dark tube joints show while
        a neighbour is off, each catch throws real sparks + an electrode flare
  0.77  holds lit with a surge: green bloom, white A slightly hot, the worn
        concrete wall (grit, cracks, old green spray paint) catches the light
  0.90  short glitch burst (3 frames)
  1.0+  hold: slow push-in 1.00 -> 1.08 about the optically centred icon,
        haze drift, dust; 1.4-1.9 a specular glint crosses the A and bullet
  2.30  click: the bullet snaps back ~13 units (one frame), camera micro-punch,
        the A sags (power draw) while the bullet charges: green-hot core,
        rising tremble, growing lens streak, halo inhales in the last 4 frames
  2.60  shot: bullet leaves the A to the right (motion smear); the flash sits
        right of the A (hot core behind the A face, only soft halo over it,
        hue-preserving soft clip -> mint-white, never cream), green streak
        trails, sparks, smoke, camera kick
  2.80  whip-pan right (blur tied to camera speed) into a streaky white-green
        light wall (cut 3.0, s2 opens on the same white)

The logo is re-drawn as vector geometry (A polygon from the brand sheet,
bullet contours traced + smoothed from the asset) and rasterised every frame
with 4x supersampling straight in screen space, so it stays razor sharp
through the push-in and shake.
"""
from lib import *

DUR = 3.0
CUES = [(0.0, "hum"), (0.9, "glitch"), (2.3, "click"), (2.6, "shot")]

T_CLICK, T_SHOT, T_WHIP = 2.3, 2.6, 2.80
T_G0, T_G1 = 1.4, 1.9                      # glint pass

# ---------------------------------------------------------------- layout
S0 = 1.8                     # world px per logo unit
PIV = np.array([143.0, 120.0], np.float32)   # icon centre (logo units: A 0..260 + bullet tip 287)
ORG = np.array([972.0, 540.0], np.float32)   # optically centred (A at ~949, tip gets slight lead)
SS = 4                       # supersampling for vector rasterisation

# "A" from the brand sheet (logo units, 260 x 240)
A_POLY = np.array([(0, 240), (0, 80), (80, 0), (180, 0), (260, 80), (260, 240), (200, 240),
                   (200, 90), (158, 56), (102, 56), (60, 90), (60, 240)], np.float32)
B_CENTER = np.array([148.0, 149.5], np.float32)   # bullet centre (logo units)
B_TIP = np.array([287.0, 149.5], np.float32)
F_ANCH = np.array([312.0, 149.5], np.float32)     # muzzle-flash anchor: clear of the A's right leg

# neon tube seams: miters from the outer corners to the inner corners
_d1 = np.array([22.0, 56.0]) / math.hypot(22, 56)
SEAM_L = (80.0, 0.0, _d1[1], -_d1[0])     # point, normal (+ = towards the top bar)
SEAM_R = (180.0, 0.0, -_d1[1], -_d1[0])
SEAM_BW = 2.5                             # feather width (logo units)

C_OUT = np.array([10, 11, 12], np.float32)
C_HL = np.array([214, 245, 180], np.float32)
FLASH_C = np.array([232, 255, 218], np.float32)
FACE = np.array([221, 224, 223], np.float32)       # lit A face (headroom for glint / surge)
GLASS = np.array([29, 31, 31], np.float32)         # dead neon glass
A_EM = np.array([105, 225, 70], np.float32)        # A's green spill (the bullet is the main bloom)
ADD_G = np.array([70, 235, 78], np.float32)        # additive light tint: saturates to mint-white
FL_WHITE = np.array([225, 245, 225], np.float32)


def to_world(p):
    return ORG + S0 * (np.asarray(p, np.float32) - PIV)


# ---------------------------------------------------------------- vector shapes
def _trace(mask, up=8, sigma=0.75, eps=0.25):
    """Binary mask -> smoothed outer contour in edge coordinates."""
    h, w = mask.shape
    big = cv2.resize(mask.astype(np.float32), (w * up, h * up), interpolation=cv2.INTER_LINEAR)
    big = cv2.GaussianBlur(big, (0, 0), sigma * up)
    cs, _ = cv2.findContours((big > 0.5).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)
    c = cv2.approxPolyDP(c, eps * up, True).reshape(-1, 2).astype(np.float32)
    return (c + 0.5) / up


def _capsule(x0, x1, y, r, n=12):
    pts = []
    for i in range(n + 1):
        a = math.pi / 2 + math.pi * i / n
        pts.append((x0 + r * math.cos(a), y - r * math.sin(a)))
    for i in range(n + 1):
        a = -math.pi / 2 + math.pi * i / n
        pts.append((x1 + r * math.cos(a), y - r * math.sin(a)))
    return np.array(pts, np.float32)


@lru_cache(maxsize=1)
def bullet_shapes():
    B = load_layer("logo_bullet")
    al = B[..., 3] > 0.5
    al[:, :8] = False                                   # residue of the streaks
    cols = B[..., :3]
    casing = al & (np.abs(cols - GREEN_DK).sum(-1) < 40)
    proj = al & ((np.abs(cols - np.array([155, 227, 75], np.float32)).sum(-1) < 60) | (cols[..., 0] > 170))
    off = np.array([1.0, 113.0], np.float32)            # bullet asset -> A-local units
    return {
        "sil": _trace(al) + off,
        "casing": _trace(casing, sigma=0.6) + off,
        "proj": _trace(proj, sigma=0.6) + off,
        "hl": _capsule(111.5, 190.5, 21.0, 2.9) + off,
    }


def compose(M, S, off):
    """Affine logo-units -> screen: camera M (2x3) after world placement."""
    L = np.array([[S, 0, ORG[0] - S * PIV[0] + S * off[0]],
                  [0, S, ORG[1] - S * PIV[1] + S * off[1]]], np.float64)
    out = np.zeros((2, 3), np.float64)
    out[:, :2] = M[:, :2] @ L[:, :2]
    out[:, 2] = M[:, :2] @ L[:, 2] + M[:, 2]
    return out


def xf(M, pts):
    return pts @ M[:, :2].T.astype(np.float32) + M[:, 2].astype(np.float32)


def bbox_of(pts_list, pad=4):
    allp = np.concatenate(pts_list, 0)
    x0 = int(math.floor(allp[:, 0].min())) - pad
    y0 = int(math.floor(allp[:, 1].min())) - pad
    x1 = int(math.ceil(allp[:, 0].max())) + pad
    y1 = int(math.ceil(allp[:, 1].max())) + pad
    return x0, y0, x1, y1


def raster(screen_polys, x0, y0, w, h):
    """Coverage (h, w) of screen-space polygons inside box (x0, y0, w, h)."""
    can = np.zeros((h * SS, w * SS), np.uint8)
    pts = []
    for q in screen_polys:
        qq = (q - np.array([x0, y0], np.float32)) * SS - 0.5
        pts.append(np.round(qq * 16).astype(np.int32))
    cv2.fillPoly(can, pts, 255, cv2.LINE_8, 4)
    return cv2.resize(can, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) * (1 / 255.0)


@lru_cache(maxsize=1)
def logo_texture():
    """Subtle print wear for the lit faces, in logo units at 3 px/unit."""
    g = grunge(300 * 3, 260 * 3, 21)
    n = value_noise(300 * 3, 260 * 3, 40, 3, 22)
    return (0.955 + 0.03 * g + 0.015 * n).astype(np.float32)


def _sstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


# ---------------------------------------------------------------- light levels
# per-frame neon levels (bullet, left tube, top tube, right tube) during start-up.
# Authored near-binary and pushed through _bin() so a tube is either dead glass
# or (almost) full; only the bullet keeps a faint electrode ember (< 0.12).
_FLICK_RAW = {
    0: (0, 0, 0, 0), 1: (0, 0, 0, 0), 2: (0, 0, 0, 0), 3: (0, 0, 0, 0),
    4: (.07, 0, 0, 0), 5: (.04, 0, 0, 0),
    6: (1.0, .95, 0, 0), 7: (.9, 0, 0, 0), 8: (.08, 0, 0, 0),
    9: (.04, 0, 0, 0), 10: (.02, 0, 0, 0), 11: (.06, 0, 0, 0),
    12: (1.05, 1.0, .95, 1.0), 13: (1.0, 1.0, 0, .95), 14: (.1, 0, 0, 0),
    15: (.95, 0, 0, .95), 16: (.1, 0, 0, 0), 17: (.05, 0, 0, 0), 18: (.03, 0, 0, 0),
    19: (1.05, 1.0, 0, 1.0), 20: (1.0, 1.0, 0, 1.0), 21: (1.1, 1.05, 1.0, 1.05),
    22: (1.0, 1.0, .95, 1.0), 23: (1.28, 1.22, 1.16, 1.22), 24: (1.18, 1.12, 1.08, 1.12),
    25: (1.1, 1.06, 1.04, 1.06), 26: (1.04, 1.02, 1.01, 1.02),
    27: (1.32, 1.3, 1.3, 1.3), 28: (.5, .55, .45, .6), 29: (1.18, 1.12, 1.1, 1.12),
}


def _bin(v):
    """Near-binary neon response: dead below ~.25, full above ~.6, surges kept."""
    x = clamp((v - 0.25) / 0.35)
    return x * x * (3 - 2 * x) * max(v, 1.0)


_FLICK = {fr: (b if b < 0.12 else _bin(b), _bin(l), _bin(tt), _bin(r)) for fr, (b, l, tt, r) in _FLICK_RAW.items()}


def charge(t):
    """0..1 charge build between the click and the shot."""
    return ease_in_out(prog(t, T_CLICK + 0.03, T_SHOT - 1 / FPS))


def inhale(t):
    """0..1 over the last 4 frames before the shot (halo pulls in), 0 after."""
    if t >= T_SHOT:
        return 0.0
    return ease_in_cubic(prog(t, T_SHOT - 4 / FPS, T_SHOT))


def levels(t, fr):
    """(bullet, L, T, R) emission levels; >1 = surge."""
    if fr in _FLICK:
        return _FLICK[fr]
    hum = 1.0 + 0.012 * math.sin(t * 2 * math.pi * 7.3) + 0.008 * math.sin(t * 2 * math.pi * 13.1 + 1)
    b = hum + 0.045 * math.sin(t * 2 * math.pi * 0.85 - 1.2)      # slow neon breathing on the bullet
    a = hum
    if fr == 48:                    # mains hiccup: the whole sign, never one segment
        a, b = 0.9, b * 0.94
    if T_CLICK <= t < T_SHOT:       # click: the A sags (power draw) while the bullet charges
        ch = charge(t)
        a = {69: 0.42, 70: 0.74}.get(fr, hum * (0.86 + 0.03 * math.sin(t * 2 * math.pi * 11)))
        b = hum * (1.1 + 0.42 * ch) + 0.06 * ch * math.sin(t * 2 * math.pi * 14)
    if t >= T_SHOT:
        k = math.exp(-(t - T_SHOT) * 9)
        a = 1.0 + 0.2 * k
        b = 0.0
    return (b, a, a, a)


# ---------------------------------------------------------------- world background
@lru_cache(maxsize=1)
def wall_maps():
    n = value_noise(W, H, 320, 3, 11)
    mid = value_noise(W, H, 40, 3, 13)
    fine = value_noise(W, H, 3, 1, 12)
    g = grunge(W, H, 4)
    rng0 = np.random.default_rng(19)
    pits = cv2.GaussianBlur((rng0.random((H, W), dtype=np.float32) > 0.992).astype(np.float32), (0, 0), 1.1) * 2.5
    tex = (0.5 + 0.2 * n + 0.2 * mid + 0.25 * fine) * (0.7 + 0.3 * g) * (1 - np.clip(pits, 0, 0.8))
    tex = np.clip(0.78 + (tex - 0.78) * 1.7, 0.05, 1.3)          # stretch: stains / pits / scratches read
    yy = np.arange(H, dtype=np.float32)[:, None]
    xx = np.arange(W, dtype=np.float32)[None, :]
    bc = to_world(B_CENTER)
    ac = to_world((130, 110))

    def gauss(c, sx, sy):
        return np.exp(-((xx - c[0]) / sx) ** 2) * np.exp(-((yy - c[1]) / sy) ** 2)

    sg = gauss(bc, 470, 270) + 0.03 * gauss(bc, 1000, 560)
    sa = gauss(ac, 330, 300)
    lmid = gauss(bc, 820, 470)                       # reach of the sign light for paint / crack lips
    # old green spray paint on the wall
    paint = np.zeros((H, W), np.float32)
    for (sx, sy, sw, sh, sd) in ((1330, 250, 420, 300, 3), (430, 740, 380, 260, 4), (1400, 800, 300, 220, 6)):
        m = splatter(sw, sh, seed=sd, density=0.6, drips=True, main_blob=False)
        m = cv2.GaussianBlur(m, (0, 0), 0.8)
        paint[sy:sy + sh, sx:sx + sw] = np.maximum(paint[sy:sy + sh, sx:sx + sw], m)
    # crack systems: dark gap offset down-right + a lit lip that catches the sign light
    cr = np.maximum(crack_mask(W, H, 1480, 120, seed=5, branches=6, thickness=2),
                    crack_mask(W, H, 260, 1010, seed=9, branches=5, thickness=2))
    cr = cv2.GaussianBlur(cr, (0, 0), 0.6)
    shd = np.roll(np.roll(cr, 2, 0), 2, 1)
    tex = tex * (1 - 0.65 * shd) * (1 - 0.25 * paint)
    base = (INK * (0.8 + 0.22 * tex)[..., None]).astype(np.float32)
    SG = (tex * tex * tex * sg)[..., None] * np.array([46, 92, 18], np.float32)
    SA = (tex * sa)[..., None] * np.array([12, 14, 11], np.float32)
    DET = ((paint * (0.3 + 0.7 * lmid))[..., None] * (GREEN_DK * 0.36)
           + (np.clip(cr - 0.35 * shd, 0, 1) * (0.28 + 0.72 * lmid))[..., None] * np.array([30, 38, 31], np.float32))
    return base, SG.astype(np.float32), SA.astype(np.float32), DET.astype(np.float32), tex.astype(np.float32)


@lru_cache(maxsize=1)
def haze_maps():
    w4, h4 = W // 4, H // 4
    f1 = value_noise(w4 * 2, h4 * 2, 90, 5, 31)
    f2 = value_noise(w4 * 2, h4 * 2, 55, 4, 32)
    yy, xx = np.mgrid[0:h4, 0:w4].astype(np.float32)
    bc = to_world(B_CENTER) / 4
    sp = np.exp(-(((xx - bc[0]) / 150) ** 2 + ((yy - bc[1]) / 88) ** 2)) + 0.01
    return f1.astype(np.float32), f2.astype(np.float32), sp.astype(np.float32)


def _scroll(f, ox, oy, w, h):
    M = np.float32([[1, 0, ox], [0, 1, oy]])
    return cv2.warpAffine(f, M, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_WRAP)


def haze_density(t):
    """Two drifting smoke layers, quarter res, 0..1."""
    f1, f2, sp = haze_maps()
    h4, w4 = sp.shape
    a = _scroll(f1, 40 + t * 15, 20 + t * 5, w4, h4)
    b = _scroll(f2, 90 - t * 8, 60 + t * 3, w4, h4)
    return np.clip((a * 0.6 + b * 0.4 - 0.4) * 2.2, 0, 1)


def haze(t, lvl, dens):
    sp = haze_maps()[2]
    a = dens * sp * (0.05 + 0.95 * lvl)
    col = a[..., None] * np.array([16, 29, 10], np.float32)
    return cv2.resize(col, (W, H), interpolation=cv2.INTER_LINEAR)


def god_rays(small_emis, dens, cx, cy, strength):
    """Radial light shafts from (cx, cy) (quarter-res coords) through the haze."""
    h4, w4 = dens.shape
    src = small_emis * (dens[..., None] ** 1.5)
    acc = np.zeros_like(src)
    n = 10
    for i in range(n):
        sc = 1.0 - 0.045 * i
        M = np.float32([[sc, 0, cx * (1 - sc)], [0, sc, cy * (1 - sc)]])
        acc += cv2.warpAffine(src, M, (w4, h4), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP) * (1 - i / n)
    acc *= strength / n * (0.25 + 0.75 * dens[..., None])
    return acc


# ---------------------------------------------------------------- halftone corners (screen space)
@lru_cache(maxsize=1)
def halftone_maps():
    cell = 19.0
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    a = math.radians(45)
    u = xx * math.cos(a) + yy * math.sin(a)
    v = -xx * math.sin(a) + yy * math.cos(a)
    fu = (u / cell) % 1 - 0.5
    fv = (v / cell) % 1 - 0.5
    d = np.sqrt(fu * fu + fv * fv).astype(np.float32)
    g = np.zeros((H, W), np.float32)
    for cx, cy, s in ((0, 0, 1.0), (W, 0, 0.85), (0, H, 0.8), (W, H, 1.0)):
        r = np.hypot((xx - cx) / (W * 0.40), (yy - cy) / (H * 0.66))
        g = np.maximum(g, s * np.clip(1 - r, 0, 1) ** 1.1)
    br = grunge(W, H, 8)
    g *= 0.6 + 0.4 * value_noise(W, H, 150, 3, 9)
    gB = (g * 0.62 * cell * 0.9).astype(np.float32)            # dot coverage = clip(gB*k - dB) * br
    dB = (d * cell * 0.9 - 0.5).astype(np.float32)
    return gB, dB, br.astype(np.float32)


def halftone_layer(t, frame, lvl):
    gB, dB, br = halftone_maps()
    k = ease_out_cubic(prog(t, 0.0, 0.9)) * (1.0 + 0.07 * math.sin(t * 2 * math.pi / 1.7))
    if k <= 0.001:
        return frame
    op = 0.11 + 0.07 * min(lvl, 1.2)
    m = cv2.scaleAdd(gB, float(k), -dB)
    np.clip(m, 0, 1, out=m)
    m *= br
    m *= op
    m3 = cv2.merge([m, m, m])
    frame += (BONE - frame) * m3
    return frame


# ---------------------------------------------------------------- particles
def spark_burst(seed, n, origin, ang, spread, vmin, vmax, life):
    rng = np.random.default_rng(seed)
    a = ang + rng.normal(0, spread, n)
    v = rng.uniform(vmin, vmax, n)
    lf = life * rng.uniform(0.55, 1.0, n)
    jit = rng.normal(0, 4, (n, 2))
    wd = rng.integers(2, 4, n)
    return [(origin[0] + jit[i, 0], origin[1] + jit[i, 1], v[i] * math.cos(a[i]), v[i] * math.sin(a[i]), lf[i], int(wd[i]))
            for i in range(n)]


# spark origins at the tube electrodes (seams / leg ends), keyed by the frame the tube catches
_IGN = {6: [(30, 238, -1.57), (91, 28, -2.0), (12, 150, 3.0)],
        12: [(91, 28, -2.0), (169, 28, -1.1), (230, 238, -1.57)],
        15: [(169, 28, -1.1), (230, 238, -1.4)],
        19: [(30, 238, -1.8), (230, 238, -1.3)],
        21: [(91, 28, -1.9), (169, 28, -1.2)]}


@lru_cache(maxsize=1)
def ignition_bursts():
    """(t0, world origin, particles) spark bursts at the tube ignitions."""
    out = []
    for fr, lst in _IGN.items():
        for j, (x, y, ang) in enumerate(lst):
            w = to_world((x, y))
            n = 12 + (fr * 7 + j * 3) % 5
            out.append((fr / FPS, w, spark_burst(fr * 31 + j, n, w, ang, 0.75, 260, 980, 0.4)))
    return out


@lru_cache(maxsize=1)
def muzzle_sparks():
    tip = to_world(B_TIP + np.array([12, 0], np.float32))
    return [p[:5] + (1,) for p in spark_burst(77, 34, tip, 0.0, 0.38, 1400, 3400, 0.24)]


def draw_sparks(frame, emis, M, parts, dt, grav=900.0, col=(225, 255, 205), delay=0.0, tail=1 / 110):
    for x0, y0, vx, vy, lf, wd in parts:
        if dt < delay or dt > lf:
            continue
        a = (1 - dt / lf) ** 0.7 * clamp((dt - delay) / 0.03 + 0.3)
        t2 = max(dt - tail, 0)
        p1 = (x0 + vx * dt, y0 + vy * dt + 0.5 * grav * dt * dt)
        p0 = (x0 + vx * t2, y0 + vy * t2 + 0.5 * grav * t2 * t2)
        q = xf(M, np.array([p0, p1], np.float32))
        c = tuple(float(v) * a for v in col)
        p0i = (int(q[0, 0] * 16), int(q[0, 1] * 16))
        p1i = (int(q[1, 0] * 16), int(q[1, 1] * 16))
        if frame is not None:
            cv2.line(frame, p0i, p1i, c, wd, cv2.LINE_AA, 4)
        if emis is not None:
            cv2.line(emis, p0i, p1i, tuple(v * 2.2 for v in c), wd + 4, cv2.LINE_AA, 4)


@lru_cache(maxsize=1)
def flare_sprite():
    """Tiny electrode flare: hot dot + short horizontal anamorphic tick."""
    w, h = 220, 60
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx, dy = xx - w / 2, yy - h / 2
    a = (np.exp(-(dx * dx + dy * dy) / (2 * 4.5 ** 2)) * 1.6 + np.exp(-(dx * dx + dy * dy) / (2 * 14 ** 2)) * 0.35
         + np.exp(-np.abs(dx) / 40 - (dy / 1.6) ** 2) * 0.7)
    img = a[..., None] * np.array([150, 240, 120], np.float32) + np.clip(a - 0.8, 0, None)[..., None] * np.array([90, 15, 90], np.float32)
    return np.dstack([img, np.ones((h, w), np.float32)]).astype(np.float32)


@lru_cache(maxsize=1)
def motes():
    rng = np.random.default_rng(404)
    n = 70
    return (rng.uniform(-100, W + 100, n), rng.uniform(-50, H + 50, n), rng.uniform(-14, 22, n),
            rng.uniform(-22, -4, n), rng.uniform(0.6, 2.2, n), rng.uniform(0, 6.28, n))


@lru_cache(maxsize=4)
def soft_disk(r):
    s = int(r * 2 + 6)
    yy, xx = np.mgrid[0:s, 0:s].astype(np.float32) - s / 2
    d = np.hypot(xx, yy)
    a = np.clip((r - d) / 2.0, 0, 1) * (0.55 + 0.45 * np.clip(d / r, 0, 1))  # rim-heavy bokeh
    return a.astype(np.float32)


def draw_motes(frame, M, t, lvl):
    xs, ys, vx, vy, sz, ph = motes()
    bc = to_world(B_CENTER)
    for i in range(len(xs)):
        x = xs[i] + vx[i] * t + 6 * math.sin(t * 1.3 + ph[i])
        y = ys[i] + vy[i] * t + 4 * math.cos(t * 1.1 + ph[i])
        lit = math.exp(-(((x - bc[0]) / 620) ** 2 + ((y - bc[1]) / 380) ** 2))
        b = lvl * lit * (0.5 + 0.5 * math.sin(t * 3 + ph[i] * 3) ** 2)
        if b < 0.03:
            continue
        q = xf(M, np.array([[x, y]], np.float32))[0]
        if i % 9 == 0:   # big out-of-focus foreground flecks
            r = 9 + 7 * (sz[i] - 0.6)
            dsk = soft_disk(round(r))
            lay = np.dstack([np.broadcast_to(np.array([150, 220, 90], np.float32), dsk.shape + (3,)), dsk])
            over_center(frame, lay, q[0], q[1], 0.16 * b, "add")
        else:
            c = tuple(float(v) for v in np.array([170, 235, 120]) * b * 0.9)
            cv2.circle(frame, (int(q[0] * 16), int(q[1] * 16)), int(sz[i] * 16), c, -1, cv2.LINE_AA, 4)


# ---------------------------------------------------------------- muzzle flash sprite
@lru_cache(maxsize=4)
def flash_sprite(var):
    """Soft muzzle-flash light (additive RGB), split into hot core and soft halo; jet points right."""
    rng = np.random.default_rng(500 + var)
    w, h = 1150, 560
    cx, cy = 300, 280
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx, dy = xx - cx, yy - cy
    core = np.exp(-((dx / 58) ** 2 + (dy / 28) ** 2))
    fil = value_noise(w // 24 + 2, h, 6, 3, 610 + var)[:, : w // 24 + 2]
    fil = cv2.resize(fil, (w, h), interpolation=cv2.INTER_CUBIC)       # horizontal filaments
    r = 16 + np.clip(dx, 0, None) * 0.15
    jet = np.exp(-np.clip(dx, 0, None) / 330.0) * np.exp(-(dy / r) ** 2) * (dx > -30)
    jet *= 0.45 + 0.9 * fil
    pet = np.zeros((h, w), np.float32)
    for ang, L, wd, k in ((0.75, 150, 16, 0.7), (-0.75, 150, 16, 0.7), (2.4, 80, 13, 0.4), (-2.4, 80, 13, 0.4),
                          (0.32, 260, 14, 0.6), (-0.32, 260, 14, 0.6)):
        ang += rng.normal(0, 0.08)
        L *= rng.uniform(0.75, 1.2)
        al = dx * math.cos(ang) + dy * math.sin(ang)
        pp = -dx * math.sin(ang) + dy * math.cos(ang)
        pet += k * np.exp(-((al - L * 0.45) / (L * 0.5)) ** 2 - (pp / (wd + 0.12 * np.clip(al, 0, None))) ** 2) * (al > 0)
    pet *= 0.6 + 0.6 * fil
    win = (np.clip(np.minimum(xx, w - 1 - xx) / 140.0, 0, 1) * np.clip(np.minimum(yy, h - 1 - yy) / 120.0, 0, 1))
    win = win * win * (3 - 2 * win)
    I = (core * 1.5 + jet * 1.2 + pet) * win
    halo = np.exp(-(((dx - 140) / 380) ** 2 + (dy / 160) ** 2)) * win
    hot = (I[..., None] * ADD_G * 1.0 + np.clip(I - 0.45, 0, None)[..., None] * FL_WHITE * 0.9).astype(np.float32)
    soft = (halo[..., None] * ADD_G * 0.45).astype(np.float32)
    return hot, soft, (cx, cy)


# ---------------------------------------------------------------- tone mapping (palette-safe highlights)
KNEE = 235.0
MINT_T = np.array([0.92, 1.0, 0.93], np.float32)


def tonemap(frame):
    """Hue-preserving soft clip: anything brighter than the knee is scaled down
    by its max channel (no per-channel clipping -> no cream/yellow), then
    desaturated towards mint-white the hotter it was."""
    m = np.maximum(np.maximum(frame[..., 0], frame[..., 1]), frame[..., 2])
    ys, xs = np.nonzero(m > KNEE)
    if not len(ys):
        return frame
    px = frame[ys, xs]
    mm = m[ys, xs][:, None]
    ex = mm - KNEE
    L = KNEE + 20.0 * (1.0 - np.exp(-ex / 40.0))
    s = px * (L / mm)
    d = np.minimum(1.0 - np.exp(-ex / 220.0), 0.85)
    frame[ys, xs] = s + (L * MINT_T - s) * d
    return frame


# ---------------------------------------------------------------- glitch (palette-safe)
def glitch_fx(frame, amount, seed):
    rng = np.random.default_rng(seed)
    src = frame
    o = frame.copy()
    for _ in range(int(6 + 14 * amount)):
        y = int(rng.integers(int(H * 0.2), int(H * 0.8)))
        h = int(rng.integers(3, int(10 + 60 * amount)))
        s = int(rng.normal(0, 90 * amount))
        o[y:y + h] = np.roll(src[y:y + h], s, axis=1)
        r = rng.random()
        if r < 0.22:
            o[y:y + h] = tint_mono(o[y:y + h], GREEN, 1.0) * 1.15
        elif r < 0.3:
            o[y:y + h] *= 0.15
    for _ in range(int(1 + 3 * amount)):     # mosaic blocks
        bw, bh = int(rng.integers(80, 360)), int(rng.integers(20, 90))
        x, y = int(rng.integers(0, W - bw)), int(rng.integers(int(H * 0.25), int(H * 0.75) - bh))
        blk = o[y:y + bh, x:x + bw]
        sm = cv2.resize(blk, (max(1, bw // 16), max(1, bh // 16)), interpolation=cv2.INTER_AREA)
        o[y:y + bh, x:x + bw] = cv2.resize(sm, (bw, bh), interpolation=cv2.INTER_NEAREST)
    # green ghost instead of RGB split (keeps the palette)
    gh = np.roll(o, int(10 + 24 * amount), axis=1)
    lum = gh @ np.array([0.3, 0.6, 0.1], np.float32)
    o += lum[..., None] * (np.array([0.12, 0.35, 0.05], np.float32) * amount)
    for _ in range(2):
        y = int(rng.integers(int(H * 0.15), int(H * 0.85)))
        o[y:y + 2] = GREEN_HOT
    return o


# ---------------------------------------------------------------- camera
def whip_dx(t):
    if t < T_WHIP:
        return 0.0
    return 1900.0 * prog(t, T_WHIP, DUR - 1 / FPS) ** 2.2


def camera(t, fr):
    u = prog(t, 0.0, T_SHOT)
    z = 1.0 + 0.08 * (0.8 * u + 0.2 * u * u)
    dx = 3.0 * math.sin(t * 0.9 + 0.4) + 1.5 * math.sin(t * 2.3)
    dy = 2.0 * math.sin(t * 0.7 + 1.9) + 1.0 * math.sin(t * 1.9 + 0.3)
    ang = 0.12 * math.sin(t * 0.6 + 0.5)
    if t >= T_CLICK:                               # click: micro-punch
        e = math.exp(-(t - T_CLICK) * 18)
        z += 0.012 * e
        dy += 5.0 * e
        dx -= 3.0 * e
    if fr in (27, 28, 29):                         # glitch jolts
        dx += (9, -14, 5)[fr - 27]
    if t >= T_SHOT:
        dt = t - T_SHOT
        sx, sy, sa = shake(t, amp=26, freq=38, seed=3, decay_from=T_SHOT, decay=8.5)
        dx += sx - 30 * math.exp(-dt * 14) * (1 if dt < 0.12 else 0)
        dy += sy
        ang += sa
        z += 0.035 * math.exp(-dt * 10) + 0.02 * ease_out_cubic(prog(t, T_SHOT, DUR))
    dx -= whip_dx(t)
    # zoom about the icon's screen position (it is optically centred, so this keeps it put)
    M = cv2.getRotationMatrix2D((float(ORG[0]), float(ORG[1])), ang, z)
    M[0, 2] += dx
    M[1, 2] += dy
    return M, z


def bullet_back(t):
    """Smooth draw-back (logo units): one-frame snap on the click, then a slow creep."""
    snap = -13.0 * ease_out_expo(prog(t, T_CLICK - 1 / FPS, T_CLICK + 1 / FPS))
    creep = -4.0 * ease_in_cubic(prog(t, T_CLICK + 0.05, T_SHOT))
    return snap + creep


def bullet_offset(t):
    """Bullet displacement in logo units (tremble, draw-back, flight) + flight speed."""
    if t < T_CLICK - 1 / FPS:
        return 0.0, 0.0, 0.0
    if t < T_SHOT:
        back = bullet_back(t)
        jx = jy = 0.0
        if t >= T_CLICK + 0.02:
            p = prog(t, T_CLICK + 0.03, T_SHOT - 1 / FPS)
            amp = 1.5 + 6.5 * p ** 1.4
            fr = int(round(t * FPS))
            rng = np.random.default_rng(1700 + fr)
            sgn = 1.0 if fr % 2 else -1.0                   # alternating rattle
            jx = amp * sgn * (0.55 + 0.45 * rng.random())
            jy = amp * 0.45 * rng.uniform(-1, 1)
        return back + jx, jy, 0.0
    dt = t - T_SHOT
    v = 6300.0                   # logo units / s
    return 30.0 + v * dt + 4000 * dt * dt, 0.0, v


# ---------------------------------------------------------------- main render
def glint_field(t, xl, yl):
    """Specular band crossing the icon diagonally, 3-tap shutter blur."""
    if not (T_G0 - 0.03 < t < T_G1 + 0.03):
        return np.float32(0)
    u = xl + 0.6 * yl
    acc = 0.0
    for s in (-0.25, 0.0, 0.25):
        gp = prog(t + s / FPS, T_G0, T_G1)
        if 0 < gp < 1:
            pos = 20 + 420 * (0.4 * gp + 0.6 * ease_in_out(gp))
            acc = acc + np.exp(-((u - pos) / 8.0) ** 2) + 0.22 * np.exp(-((u - pos + 6) / 26.0) ** 2)
    return (acc / 3.0).astype(np.float32) if not isinstance(acc, float) else np.float32(0)


def logo_A(M, t, ll, lt, lr, unlit_k, amb):
    """Rasterised A: (box, coverage, colour, emission-colour) or None."""
    MA = compose(M, S0, (0, 0))
    qa = xf(MA, A_POLY)
    x0, y0, x1, y1 = bbox_of([qa])
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W), min(y1, H)
    if x1 <= x0 + 2 or y1 <= y0 + 2:
        return None
    w, h = x1 - x0, y1 - y0
    cov = raster([qa], x0, y0, w, h)
    inv = cv2.invertAffineTransform(MA).astype(np.float32)
    gy, gx = np.mgrid[y0:y1, x0:x1].astype(np.float32) + 0.5
    xl = inv[0, 0] * gx + inv[0, 1] * gy + inv[0, 2]
    yl = inv[1, 0] * gx + inv[1, 1] * gy + inv[1, 2]
    # tube segments, cut along the miters (outer corner -> inner corner), feathered
    s1 = (xl - SEAM_L[0]) * SEAM_L[2] + (yl - SEAM_L[1]) * SEAM_L[3]
    s2 = (xl - SEAM_R[0]) * SEAM_R[2] + (yl - SEAM_R[1]) * SEAM_R[3]
    wL = _sstep(0.5 - s1 / SEAM_BW)
    wR = _sstep(0.5 - s2 / SEAM_BW)
    wT = np.clip(1 - wL - wR, 0, 1)
    lv = wL * ll + wT * lt + wR * lr
    tex = cv2.remap(logo_texture(), xl * 3 + 60, yl * 3 + 30, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    glint = glint_field(t, xl, yl)
    lvc = np.clip(lv, 0, 1)[..., None]
    # dead glass: never darker than unlit tube, with a faint rim catching the other tubes' light
    unlit = INK + (GLASS - INK) * unlit_k
    rim = cov - cv2.erode(cov, np.ones((3, 3), np.uint8))
    lit = FACE * tex[..., None]
    col = unlit + (lit - unlit) * lvc
    col += (rim * amb * (1 - lvc[..., 0]))[..., None] * np.array([46, 62, 48], np.float32)
    hot = np.clip(lv - 1, 0, 1) * 1.2 + glint * np.clip(lv, 0, 1) * 0.9
    col += (np.float32(252) - col) * np.clip(hot, 0, 1)[..., None]
    # tube joints: a thin dark line on a seam only while the neighbours differ
    jl, jr = clamp(abs(ll - lt) * 1.6), clamp(abs(lr - lt) * 1.6)
    if jl > 0.01 or jr > 0.01:
        joint = np.maximum(np.exp(-(s1 / 0.75) ** 2) * jl * (s1 > -6), np.exp(-(s2 / 0.75) ** 2) * jr * (s2 > -6))
        col += (INK * 1.1 - col) * (0.85 * joint)[..., None]
    em = (cov * lv * (0.2 + 0.55 * glint))[..., None] * A_EM
    return (x0, y0, x1, y1), cov, col, em


def logo_bullet(M, t, z, lb, unlit_k):
    """Rasterised bullet: (box, premult rgb, alpha, emission) or None."""
    bx, by, bv = bullet_offset(t)
    MB = compose(M, S0, (bx, by))
    qs = {k: xf(MB, v) for k, v in bullet_shapes().items()}
    if t >= T_SHOT:
        blur = int(min(44, bv / FPS * S0 * z * 0.1))
    else:                                          # shutter blur of the smooth draw-back only (snap frame)
        blur = int(abs(bullet_back(t) - bullet_back(t - 1 / FPS)) * S0 * z * 0.5)
    x0, y0, x1, y1 = bbox_of([qs["sil"]], pad=4 + blur // 2 + 2)
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W), min(y1, H)
    if x1 <= x0 + 2 or y1 <= y0 + 2:
        return None
    w, h = x1 - x0, y1 - y0
    cs = raster([qs["sil"]], x0, y0, w, h)
    cc = raster([qs["casing"]], x0, y0, w, h)
    cp = raster([qs["proj"]], x0, y0, w, h)
    ch = raster([qs["hl"]], x0, y0, w, h)
    lbc = 1.0 if t >= T_SHOT else clamp(lb, 0, 1)
    if t >= T_SHOT:
        hot = 0.35
    else:
        hot = max(clamp((lb - 1.05) * 1.6, 0, 0.75) if t < T_CLICK else 0.0, 0.6 * charge(t))

    def mix(unlit, lit):
        u = INK + (np.asarray(unlit, np.float32) - INK) * unlit_k
        return u + (np.asarray(lit, np.float32) - u) * lbc

    c_cas = mix((25, 31, 21), GREEN_DK * 1.03)
    c_pro = mix((29, 37, 24), GREEN)
    c_hl = mix((38, 44, 35), C_HL)
    c_out = C_OUT
    rgb = np.empty((h, w, 3), np.float32)
    rgb[:] = c_out
    rgb += (c_cas - rgb) * cc[..., None]
    rgb += (c_pro - rgb) * cp[..., None]
    rgb += (c_hl - rgb) * ch[..., None]
    inv = None
    if hot > 0.01 or T_G0 - 0.03 < t < T_G1 + 0.03:
        inv = cv2.invertAffineTransform(MB).astype(np.float32)
        gy, gx = np.mgrid[y0:y1, x0:x1].astype(np.float32) + 0.5
        xl = inv[0, 0] * gx + inv[0, 1] * gy + inv[0, 2]
        yl = inv[1, 0] * gx + inv[1, 1] * gy + inv[1, 2]
    if hot > 0.01:                                 # green-hot core of the projectile (charge)
        core = np.exp(-(((xl - 200) / 70) ** 2 + ((yl - 150) / 15) ** 2)).astype(np.float32)
        k = (cp * np.clip(core * 1.3, 0, 1) * hot)[..., None]
        rgb += (GREEN_HOT - rgb) * k
    if T_G0 - 0.03 < t < T_G1 + 0.03:
        gl = glint_field(t, xl, yl) * (cp + ch)
        rgb += (np.float32(250) - rgb) * np.clip(gl * 0.75, 0, 1)[..., None]
    pm = rgb * cs[..., None]
    al = cs
    em = cp[..., None] * ADD_G + cc[..., None] * GREEN_DK * 0.5 + ch[..., None] * C_HL * 0.4
    em *= (lb if t < T_SHOT else 1.3)
    if blur > 2:
        k = np.ones((1, blur), np.float32) / blur
        pm = cv2.filter2D(pm, -1, k, borderType=cv2.BORDER_CONSTANT)
        al = cv2.filter2D(al, -1, k, borderType=cv2.BORDER_CONSTANT)
        em = cv2.filter2D(em, -1, k, borderType=cv2.BORDER_CONSTANT)
    return (x0, y0, x1, y1), pm, al, em


def render(t, ctx):
    fr = int(round(t * FPS))
    if abs(t * FPS - fr) < 1e-3:          # snap to the exact frame time (beats are frame-keyed)
        t = fr / FPS
    lb, ll, lt, lr = levels(t, fr)
    la = (ll + lt + lr) / 3.0
    M, z = camera(t, fr)
    # dead glass ghost: rises over the first 4 frames, never below 0.7 afterwards
    unlit_k = 0.7 * ease_in_out(prog(t, 0.02, 4 / FPS)) + 0.3 * ease_in_out(prog(t, 4 / FPS, 0.75))
    dt = t - T_SHOT
    inh = inhale(t)
    lw = min(max(lb, la), 1.3)

    # ---- world: concrete wall lit by the sign + haze, seen through the camera
    base, SG, SA, DET, tex = wall_maps()
    world = cv2.scaleAdd(SG, float(min(lb, 1.5) * (1 - 0.45 * inh)), base)
    cv2.scaleAdd(SA, float(min(la, 1.5)), world, dst=world)
    cv2.scaleAdd(DET, float(lw), world, dst=world)
    dens = haze_density(t)
    world += haze(t, lw * (1 - 0.4 * inh), dens)
    if dt >= 0:                                    # muzzle flash lights the wall
        k = math.exp(-dt * 12)
        if k > 0.03:
            fa = to_world(F_ANCH)
            w4, h4 = W // 4, H // 4
            yy, xx = np.ogrid[0:h4, 0:w4]
            rad = np.exp(-(((xx - fa[0] / 4 - 30) / 190) ** 2 + ((yy - fa[1] / 4) / 95) ** 2)).astype(np.float32)
            rad = cv2.resize(rad, (W, H), interpolation=cv2.INTER_LINEAR)
            world += ((0.35 + 0.65 * tex) * rad * k)[..., None] * np.array([70, 170, 62], np.float32)
            world += DET * (2.5 * k) * rad[..., None]
    frame = cv2.warpAffine(world, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)

    halftone_layer(t, frame, max(lb, la))

    # ---- logo pieces + emission buffer
    emis = np.zeros((H, W, 3), np.float32)
    amb = clamp(0.5 * min(lb, 1.2) + 0.5 * max(ll, lt, lr))
    A = logo_A(M, t, ll, lt, lr, unlit_k, amb)
    B = logo_bullet(M, t, z, lb, unlit_k) if (dt < 0 or bullet_offset(t)[0] < 900) else None
    if A is not None:
        (x0, y0, x1, y1), cov, col, em = A
        emis[y0:y1, x0:x1] += em
    if B is not None:
        (x0, y0, x1, y1), pm, al, em = B
        emis[y0:y1, x0:x1] += em
    addc = np.zeros((H, W, 3), np.float32)        # additive canvas (cv2 draws overwrite, so never draw on frame)
    if dt >= 0:
        draw_sparks(None, addc, M, muzzle_sparks(), dt, grav=700, delay=0.045)
    for t0, org, parts in ignition_bursts():
        if 0 <= t - t0 < 0.42:
            draw_sparks(None, addc, M, parts, t - t0, grav=1400, tail=1 / 24)
    emis += addc
    addc[:] = 0
    trails = None
    if dt >= 0:
        muzzle(emis, M, z, dt, 0.45, "hot")
        trails = streak_trails(M, dt)
        if trails is not None:
            (x0, y0, x1, y1), cov_s = trails
            emis[y0:y1, x0:x1] += cov_s[..., None] * ADD_G * 1.4

    # ---- neon glow sits UNDER the solid logo so the brand colours stay true
    small = cv2.resize(emis, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    g = (cv2.GaussianBlur(small, (0, 0), 1.6) * (0.5 + 0.45 * inh) + cv2.GaussianBlur(small, (0, 0), 6) * 0.5 * (1 - 0.45 * inh)
         + cv2.GaussianBlur(small, (0, 0), 20) * 0.22 * (1 - 0.75 * inh))
    rc = xf(M, to_world(B_CENTER if dt < 0 else F_ANCH)[None])[0] / 4
    g += god_rays(small, dens, rc[0], rc[1], 2.2 * (1 - 0.6 * inh))
    frame += cv2.resize(g, (W, H), interpolation=cv2.INTER_LINEAR)

    if dt < 0:                                   # idle lens streak sits behind the solid logo
        ana = (0.15 + 0.04 * math.sin(t * 5.1)) * min(lb, 1.2) ** 2
        if T_CLICK <= t:
            ana = 0.15 + 0.45 * charge(t) + 0.05 * math.sin(t * 2 * math.pi * 14)
        p = xf(M, to_world(B_CENTER)[None])[0]
        if ana > 0.01:
            anamorphic(frame, p[0], p[1], ana)

    if dt >= 0 and trails is not None:            # streak trails live in the A's plane, behind its face
        (x0, y0, x1, y1), cov_s = trails
        crop = frame[y0:y1, x0:x1]
        crop += (np.array([200, 255, 170], np.float32) - crop) * cov_s[..., None]

    if dt >= 0:                                   # hot flash core BEHIND the A face: the leg stays crisp
        muzzle(frame, M, z, dt, 1.0, "hot")

    if A is not None:
        (x0, y0, x1, y1), cov, col, em = A
        crop = frame[y0:y1, x0:x1]
        crop += (col - crop) * cov[..., None]

    if dt >= 0:                                   # only the soft halo spills over it
        muzzle(frame, M, z, dt, 0.8, "soft")

    if B is not None:
        (x0, y0, x1, y1), pm, al, em = B
        crop = frame[y0:y1, x0:x1]
        crop *= (1 - al)[..., None]
        crop += pm

    if dt >= 0:
        draw_sparks(addc, None, M, muzzle_sparks(), dt, grav=700, delay=0.045)
        smoke_puffs(frame, M, z, dt)
    for t0, org, parts in ignition_bursts():
        if 0 <= t - t0 < 0.42:
            draw_sparks(addc, None, M, parts, t - t0, grav=1400, tail=1 / 24)
        if 0 <= t - t0 < 0.5 / FPS:              # one-frame electrode flare
            q = xf(M, org[None])[0]
            over_center(addc, flare_sprite(), q[0], q[1], 0.9, "add")

    # ---- anamorphic streak from the muzzle (over everything: it's the lens)
    if dt >= 0:
        ana = 1.2 * math.exp(-dt * 8)
        p = xf(M, to_world(F_ANCH)[None])[0]
        if ana > 0.01:
            anamorphic(frame, p[0], p[1], ana)

    draw_motes(addc, M, t, lw)
    frame += addc
    frame = fast_bloom(frame, 225, 18, 0.22)
    frame = tonemap(frame)

    if fr in (27, 28, 29):
        frame = glitch_fx(frame, (0.9, 1.3, 0.6)[fr - 27], 900 + fr)

    if t >= T_WHIP:
        frame = whip(frame, t)
    return np.clip(frame, 0, 255)


def fast_bloom(frame, threshold, sigma, strength):
    small = cv2.resize(frame, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    hi = cv2.GaussianBlur(np.clip(small - threshold, 0, None), (0, 0), sigma / 4)
    return frame + cv2.resize(hi, (W, H), interpolation=cv2.INTER_LINEAR) * strength


@lru_cache(maxsize=1)
def _flood_rows():
    """Per-row reach / fringe width / lead-streak length of the light wall (0..1-ish).
    Three octaves of row noise + a few long rays, longest on the bullet line."""
    h2 = H // 2
    rng = np.random.default_rng(321)

    def octave(n, interp):
        return cv2.resize(rng.random((n, 1)).astype(np.float32), (1, h2), interpolation=interp)[:, 0]

    fine = octave(h2 // 2, cv2.INTER_LINEAR)
    med = octave(h2 // 14, cv2.INTER_CUBIC)
    coarse = octave(9, cv2.INTER_CUBIC)
    rays = (octave(h2 // 3, cv2.INTER_LINEAR) > 0.86).astype(np.float32)
    rays = cv2.GaussianBlur(rays[:, None], (0, 0), 0.8)[:, 0]
    yy = np.arange(h2, dtype=np.float32) * 2
    line = np.exp(-((yy - to_world(B_CENTER)[1]) / 140) ** 2)
    reach = np.clip(0.22 * fine ** 2 + 0.28 * med + 0.14 * coarse + 0.4 * line + 0.25 * rays, 0, 1.25)
    width = 0.45 + 0.9 * np.clip(octave(h2 // 10, cv2.INTER_CUBIC) * 0.7 + 0.3 * fine, 0, 1)
    lead = 0.3 + 0.7 * np.clip(0.5 * med + 0.6 * rays + 0.3 * fine, 0, 1)
    return reach.astype(np.float32), width.astype(np.float32), lead.astype(np.float32)


def whip(frame, t):
    """Whip-pan right after the bullet: smear tied to camera speed + a streaky white-green light wall."""
    p = prog(t, T_WHIP, DUR - 1 / FPS)
    w2, h2 = W // 2, H // 2
    small = cv2.resize(frame, (w2, h2), interpolation=cv2.INTER_AREA)
    disp = abs(whip_dx(t) - whip_dx(t - 1 / FPS))
    k = int(min(260, 0.6 * disp / 2))
    if k > 2:
        small = cv2.blur(cv2.blur(small, (k, 1)), (k, 1))     # triangle kernel: no hard box edges
        small = cv2.GaussianBlur(small, (1, 0), sigmaX=0.1, sigmaY=max(0.5, k / 36))   # a hair of vertical shake
    reach, width, lead = _flood_rows()
    r, wv, ld = reach[:, None], width[:, None], lead[:, None]
    xs = np.arange(w2, dtype=np.float32)[None, :] * 2
    e = (W + 160) - (W * 0.93 + 160) * p ** 1.6 - 520 * r * p
    soft = (60 + 260 * p) * wv
    d = (xs - e) / soft
    a = np.clip(d + 0.5, 0, 1)
    a = a * a * (3 - 2 * a)
    ahead = np.minimum(d, 0) * soft                                   # px ahead of the edge (<= 0)
    streak = np.exp(ahead / (ld * (60 + 700 * p))) * (d < 0.5)
    fringe = (np.exp(-(d * 1.4) ** 2) * 0.8 + 0.55 * streak * ld) * min(1.0, p * 4)
    col = FLASH_C * 0.92 + np.float32(0.08) * GREEN * (1 - a[..., None])
    small = small + (col - small) * a[..., None] + fringe[..., None] * ADD_G * 0.55
    small += np.float32(30) * p ** 2
    return cv2.resize(small, (W, H), interpolation=cv2.INTER_LINEAR)


@lru_cache(maxsize=2)
def _ana_profile(length):
    xs = np.linspace(-1, 1, 2 * length).astype(np.float32)
    px = np.exp(-np.abs(xs) * 3.0) * 0.8 + np.exp(-np.abs(xs) * 14) * 0.7
    ys = np.arange(-24, 25, dtype=np.float32)
    py = np.exp(-(ys / 1.4) ** 2) + 0.22 * np.exp(-(ys / 8) ** 2)
    prof = py[:, None] * px[None, :]
    lay = prof[..., None] * (ADD_G * 0.55 + WHITE * 0.2)
    return np.dstack([lay, np.ones(prof.shape, np.float32)]).astype(np.float32)


def anamorphic(frame, cx, cy, amt):
    over(frame, _ana_profile(W), cx - W, cy - 24, amt, "add")


def muzzle(frame, M, z, dt, amt=1.0, part="hot"):
    if dt > 0.24:
        return
    k = math.exp(-dt * 10) * (1.2 if dt < 0.01 else 1.0) * amt
    hot, soft, (cx, cy) = flash_sprite(int(dt * FPS + 0.5) % 4)
    spr = hot if part == "hot" else soft
    sc = z * (1.0 + 0.35 * ease_out_cubic(prog(dt, 0, 0.12)))
    q = xf(M, to_world(F_ANCH)[None])[0]
    sh, sw = spr.shape[:2]
    sm = cv2.resize(spr, (int(sw * sc), int(sh * sc)), interpolation=cv2.INTER_LINEAR)
    lay = np.dstack([sm, np.ones(sm.shape[:2], np.float32)])
    over(frame, lay, q[0] - cx * sc, q[1] - cy * sc, k, "add")


def streak_trails(M, dt):
    """Three tapered green streaks left in the air by the bullet (logo motif)."""
    fade = 1 - ease_in_out(prog(dt, 0.1, 0.42))
    if fade <= 0.01:
        return None
    bx = bullet_offset(T_SHOT + dt)[0]
    tail_x = to_world((9 + bx, 0))[0]
    start = to_world((-40, 0))[0]
    back = start + (tail_x - start) * ease_in_cubic(prog(dt, 0.08, 0.42))
    yc = to_world(B_CENTER)[1]
    polys = []
    for oy, th, ext in ((-15, 4.0, 0.8), (0, 8.0, 1.0), (15, 3.5, 0.62)):
        yy = yc + oy * S0
        fx = min(tail_x, W + 900)
        bxw = back + (1 - ext) * (fx - back)
        ht = th * S0 / 2
        polys.append(xf(M, np.array([(bxw, yy - 0.4), (fx + 30, yy - ht), (fx + 30, yy + ht), (bxw, yy + 0.4)],
                                    np.float32)))
    x0, y0, x1, y1 = bbox_of(polys, 6)
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W), min(y1, H)
    if x1 <= x0 + 2 or y1 <= y0 + 2:
        return None
    return (x0, y0, x1, y1), raster(polys, x0, y0, x1 - x0, y1 - y0) * fade


@lru_cache(maxsize=1)
def smoke_sprite():
    w, h = 520, 320
    n = value_noise(w, h, 60, 4, 77)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r = np.hypot((xx - w / 2) / (w * 0.45), (yy - h / 2) / (h * 0.45))
    a = np.clip(1 - r, 0, 1) ** 1.2 * np.clip((n - 0.3) * 1.8, 0, 1)
    return cv2.GaussianBlur(a, (0, 0), 3).astype(np.float32)


def smoke_puffs(frame, M, z, dt):
    for (px, py, s0, ds, vx, a0) in ((F_ANCH[0] + 10, F_ANCH[1], 0.45, 1.3, 420, 0.32),
                                     (-10, 150, 0.3, 0.7, -110, 0.18)):
        a = a0 * (1 - ease_in_out(prog(dt, 0.03, 0.4))) * ease_out_cubic(prog(dt, 0.0, 0.05))
        if a < 0.01:
            continue
        spr = smoke_sprite()
        sc = (s0 + ds * ease_out_cubic(prog(dt, 0, 0.4))) * z
        sm = cv2.resize(spr, (int(spr.shape[1] * sc), int(spr.shape[0] * sc)), interpolation=cv2.INTER_LINEAR)
        lit = np.array([52, 70, 46], np.float32) + np.array([110, 150, 90], np.float32) * math.exp(-dt * 9)
        lay = solid_layer(sm, lit)
        c = to_world((px, py)) + np.array([vx * dt, -40 * dt], np.float32)
        q = xf(M, c[None])[0]
        over_center(frame, lay, q[0] + sm.shape[1] * 0.3 * (1 if vx > 0 else -1), q[1], a)
