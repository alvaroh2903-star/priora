"""Scene 2 · s2_bullet (3.0 s) — macro slow-motion bullet flight -> lens hit.

Beat sheet (local seconds):
  0.00  hand-off from s1's white-green whip flash: the streaky light wall is
        already sliding off to the left on frame 0 while the camera whips in and
        "catches" the bullet (enters from the right, heavy smear) — whoosh 0.1
  0.3+  macro slow-mo, 3/4 side view: the brand bullet (re-drawn in 3D as a
        solid of revolution: flat logo colours, logo highlight capsule, dark
        screen-space outline, GREEN_HOT rim light, cylinder shading, spinning
        engraved rifling) drifts left->right with a slight precession. Mach-cone
        shock rings, bow-shock V, green speed streaks, logo streaks; two lit smoke
        walls hug the flight path and bow outwards behind the tip. Stencil HUD on
        3D planes: distressed bone ".50 BMG" (halftone breakup) in the back,
        "VELOCIDADE 853 M/S" + "ENERGIA 18.000 J" in front; range tape + DIST.
  1.30  ricochet zing: DIST locks on 1.240 M (corner brackets snap on, 2 frames
        hot), narrow specular sweep over the upper half, 3 px pop ring with its own
        bloom, 20 tapered sparks (never over the bullet), 18 px kick
  1.35  the camera swings to a steep 3/4 (46-50 deg, casing still reads as a
        GREEN_DK ring behind); type planes smear away, the tape is gone by 1.55;
        a ghost "ALVO TRAVADO" plane carries the parallax type through 2.35
  1.35+ log-space dolly (rate keeps climbing to the last frame) + focal ramp
        x1 -> x3; graphic two-tone nose (lit GREEN / GREEN_DK shadow split on the
        projected terminator meridians), print grit + halftone in the shadow,
        capsule on the upper ogive; lock ring + "IMPACTO EM 0,xxx M" countdown on
        the right third from 1.75
  2.27+ the nose turns onto the lens (50 -> 85 deg) while the tip travels onto the
        crack origin: 6 facet lines, white tip disc growing, zoom blur + speed
        lines, 2-frame growth smear; the ogive covers ~75 % / ~88 % of frames 78/79
  2.65  lens hit (frame 80): white flash; frame 81 negative beat (black glass,
        blazing cracks, hot star core), then an additive radial glow; crack
        network races out from (0.52 W, 0.47 H) with spiderweb rings and 7 long
        straight radial fractures, per-shard refraction + green sheen, glinting
        crack segments, rays, heavy decaying shake — glass + impact
  2.8+  relaxes into scene 3's opening plate (same crack_mask network at 0.32,
        same bg / haze / halftone, s3's camera drift): frame 89 == s3 frame 0

Everything 3D lives in the bullet's co-moving frame (+X = flight direction,
+Y up); the camera orbits it.  Logo geometry measured from logo_bullet.png.
"""
from lib import *

DUR = 3.0
CUES = [(0.1, "whoosh"), (1.3, "ricochet"), (2.65, "glass"), (2.65, "impact")]

T_ZING = 1.3
T_SWING0, T_SWING1 = 1.35, 1.70
T_APP0 = 1.35                    # approach dolly starts (overlaps the swing, C1 smooth)
T_LOCK0, T_LOCK1 = 1.55, 1.95    # wobble dies / pivot locks onto the real tip
TH_SWING, TH_CREEP = 22.0, 4.0   # orbit: 24 deg -> 46 deg (swing) -> 50 deg (casing still reads as a ring behind)
T_TURN0 = 2.27                   # last beat: the nose turns onto the lens
TH_END = 85.0
D_END = 26.0
T_HIT = 2.65
F_HIT = 80                       # first frame after the hit (2.667 s)
T_LAST = (F_HIT - 1) / FPS       # last bullet frame (2.633 s): the nose breaks the near plane here
FOC = 1400.0                     # focal length (px)
FOC_RAMP = 2.0                   # focal ramps x1 -> x3 over the approach: flatter 3/4 product-shot perspective,
                                 # then a narrow lens so the ogive cone overfills the frame
CX, CY = W / 2.0, H / 2.0
YV = np.array([0.0, 1.0, 0.0])
XV = np.array([1.0, 0.0, 0.0])

ADD_G = np.array([105, 235, 78], np.float32)     # additive light tint (saturates to mint, never yellow)
MINT = np.array([218, 255, 205], np.float32)
C_OUT = np.array([10, 11, 12], np.float32)
C_HL = np.array([214, 245, 180], np.float32)
FLASH_C = np.array([243, 255, 230], np.float32)

# ---------------------------------------------------------------- bullet geometry (logo proportions)
BL = 1000.0                      # tail -> tip
S0 = -500.0                      # tail position along the axis (centre at origin)
R_B = 90.0
OUTL = 22.0
S_CAS, S_GAP, S_FLAT = 294.0, 321.0, 573.0


def r_body(s):
    s = np.atleast_1d(np.asarray(s, np.float64))
    r = np.full(s.shape, R_B)
    rc = 20.0
    b = s < rc
    r[b] = R_B - rc + np.sqrt(np.clip(rc ** 2 - (rc - s[b]) ** 2, 0, None))
    o = s > S_FLAT
    u = np.clip((s[o] - S_FLAT) / (BL - S_FLAT), 0, 1)
    r[o] = R_B * (1 - u ** 1.56)
    r[(s < 0) | (s > BL)] = 0
    return r


@lru_cache(maxsize=1)
def profiles():
    """Slice stations (s, r) per region, plus the outline offset curve."""
    cas = np.concatenate([[0.0, 0.6, 2, 4, 7, 10, 14, 20], [S_CAS]])
    gap = np.array([S_CAS, S_GAP])
    og = np.unique(np.concatenate([S_FLAT + (BL - S_FLAT) * np.linspace(0, 1, 34) ** 0.8, [993.0, S_TIPZ, 998.0]]))
    pro = np.concatenate([[S_GAP], og])
    fine = np.linspace(0, BL, 801)
    rf = r_body(fine)
    so = np.concatenate([np.linspace(-OUTL, 30, 14), [S_CAS], np.linspace(S_FLAT - 20, BL + OUTL * 1.4, 40)])
    ro = []
    for s in so:
        dd = np.abs(fine - s)
        m = dd <= OUTL
        v = rf[m] + np.sqrt(np.clip(OUTL ** 2 - dd[m] ** 2, 0, None)) if m.any() else np.array([0.0])
        ro.append(max(v.max(), 0.0))
    ro = np.array(ro)
    keep = ro > 0.5
    return {
        "cas": (cas, r_body(cas)),
        "gap": (gap, np.full(2, R_B - 0.5)),
        "pro": (pro, np.maximum(r_body(pro), 0.15)),
        "out": (so[keep], ro[keep]),
    }


# ---------------------------------------------------------------- camera
def smooth(x):
    return x * x * (3 - 2 * x)


APP_G = 2.6                      # log-dolly shape: zoom rate keeps climbing all the way into the lens


def cam_dist(t):
    """Camera -> pivot distance. Cruise ~1320, then a C1-smooth dolly that is
    linear in log(D) shaped by u^APP_G: the projected nose grows exponentially
    with an ever-increasing rate, peaking on the last frame (no ease-out)."""
    D = 1380.0 - 60.0 * prog(t, 0, 1.3)
    u = max(t - T_APP0, 0.0) / (T_LAST - T_APP0)
    g = u ** APP_G
    return math.exp(math.log(D) + (math.log(D_END) - math.log(D)) * g)


def foc_at(t):
    return FOC * (1 + FOC_RAMP * prog(t, T_APP0, T_LAST) ** 2)


def turn_k(t):
    """0..1 final turn of the nose onto the lens (accelerates into the hit)."""
    x = prog(t, T_TURN0, T_LAST)
    return x * x * (2.2 - 1.2 * x)


def cam_state(t):
    """(theta, elev, dist, pivot(3), roll) in degrees / world units."""
    ia = ease_out_cubic(prog(t, 0.0, 0.55))
    sw = smooth(prog(t, T_SWING0, T_SWING1))
    # steep 3/4 while closing in (casing ring stays visible), then the nose turns onto the lens
    th = 19.0 + 5.0 * prog(t, 0, T_SWING0) + TH_SWING * sw + TH_CREEP * smooth(prog(t, T_SWING1, T_TURN0))
    th += (TH_END - (19.0 + 5.0 + TH_SWING + TH_CREEP)) * turn_k(t)
    el = 6.5 * (1 - sw) + 3.0 * sw + 1.5 * math.sin(t * 0.8)
    D = cam_dist(t)
    px = 230.0 - 330.0 * prog(t, 0, T_SWING0) - 1250.0 * (1 - ia)
    px = px + (500.0 - px) * smooth(prog(t, T_SWING0 - 0.05, T_SWING1 + 0.1))
    py = 18.0 * (1 - sw)
    if wobble_amt(t) < 1.0:                           # lock onto the real nose for the approach
        tip = (BL + S0) * bullet_axes(t)[0]
        k = smooth(prog(t, T_LOCK0, T_LOCK1))
        px = px + (tip[0] - px) * k
        py = py + (tip[1] - py) * k
    roll = 7.0 * math.sin(math.pi * prog(t, T_SWING0, T_SWING1 + 0.25)) + 16.0 * ease_in_cubic(prog(t, 2.1, T_HIT))
    return th, el, D, np.array([px, py, 0.0]), roll


def cam_shake(t):
    dx = dy = 0.0
    # zing kick
    sx, sy, _ = shake(t, amp=18, freq=40, seed=2, decay_from=T_ZING, decay=11)
    dx += sx; dy += sy
    # approach vibration
    k = ease_in_cubic(prog(t, 2.0, T_HIT)) * 14.0
    if k > 0:
        dx += k * (math.sin(t * 93) * 0.6 + math.sin(t * 151 + 1) * 0.4)
        dy += k * (math.sin(t * 117 + 2) * 0.6 + math.sin(t * 173) * 0.4)
    # whip-in drift (slight vertical bob)
    dy += 2.0 * math.sin(t * 2.1 + 0.5)
    tx, ty = tip_path(t)
    return dx + tx - CX, dy + ty - CY


TIP_A, TIP_B = (1120.0, 590.0), (1072.0, 566.0)


def tip_path(t):
    """Screen point the locked tip sits on: drifts across the centre-right while
    closing in, then travels onto the crack origin (shared with scene 3) on the
    final turn."""
    k = smooth(prog(t, 1.4, 1.9))
    u = prog(t, 1.75, T_TURN0 + 0.05)
    px = TIP_A[0] + (TIP_B[0] - TIP_A[0]) * u
    py = TIP_A[1] + (TIP_B[1] - TIP_A[1]) * u
    f = smooth(prog(t, T_TURN0 + 0.02, T_LAST))
    px += (CRACK_C[0] - px) * f
    py += (CRACK_C[1] - py) * f
    return CX + (px - CX) * k, CY + (py - CY) * k


class Cam:
    def __init__(self, t, extra=(0.0, 0.0)):
        th, el, D, piv, roll = cam_state(t)
        thr, elr = math.radians(th), math.radians(el)
        self.C = piv + D * np.array([math.sin(thr) * math.cos(elr), math.sin(elr), -math.cos(thr) * math.cos(elr)])
        f = piv - self.C
        f /= np.linalg.norm(f)
        r = np.cross(YV, f)
        r /= np.linalg.norm(r)
        u = np.cross(f, r)
        self.f, self.r, self.u = f, r, u
        self.D, self.th, self.piv = D, th, piv
        self.foc = foc_at(t)
        ro = math.radians(roll)
        self.cr, self.sr = math.cos(ro), math.sin(ro)
        sx, sy = cam_shake(t)
        self.ox, self.oy = sx + extra[0], sy + extra[1]

    def depth(self, P):
        return (np.asarray(P, np.float64) - self.C) @ self.f

    def proj(self, P):
        """P (...,3) -> screen (...,2), depth (...)."""
        rel = np.asarray(P, np.float64) - self.C
        z = rel @ self.f
        zz = np.maximum(z, 1e-3)
        x = self.foc * (rel @ self.r) / zz
        y = -self.foc * (rel @ self.u) / zz
        xs = x * self.cr - y * self.sr
        ys = x * self.sr + y * self.cr
        return np.stack([xs + CX + self.ox, ys + CY + self.oy], -1), z


# ---------------------------------------------------------------- bullet raster
def wobble_amt(t):
    return 1.0 - smooth(prog(t, T_LOCK0, T_LOCK1))


def bullet_axes(t):
    k = wobble_amt(t)
    yaw = math.radians(1.4 * k * math.sin(2 * math.pi * 0.8 * t + 0.4))
    pit = math.radians(0.9 * k * math.sin(2 * math.pi * 1.2 * t + 1.1))
    d = np.array([math.cos(pit) * math.cos(yaw), math.sin(pit), -math.cos(pit) * math.sin(yaw)])
    e1 = np.cross(d, YV)
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(e1, d)
    return d, e1, e2


def ring_pts(cam, d, e1, e2, s, r, nphi, shift=None):
    """Projected circles for stations s (n,), radii r (n,) -> (n, nphi, 2)."""
    ph = np.linspace(0, 2 * math.pi, nphi, endpoint=False)
    cs = np.cos(ph)[None, :, None] * e1[None, None] + np.sin(ph)[None, :, None] * e2[None, None]
    C = (np.asarray(s)[:, None] + S0) * d[None]
    if shift is not None:
        C = C + shift
    P = C[:, None, :] + np.asarray(r)[:, None, None] * cs
    q, z = cam.proj(P)
    return q


def fill_union(can, q, ox, oy, ss):
    """Union of convex hulls of consecutive projected circles."""
    qq = ((q - np.array([ox, oy])) * ss * 16 - 8 * min(ss, 1)).astype(np.int32)
    for i in range(len(qq) - 1):
        h = cv2.convexHull(np.concatenate([qq[i], qq[i + 1]]))
        cv2.fillConvexPoly(can, h, 255, cv2.LINE_8, 4)


def surf_dirs(e1, e2, ang):
    return np.cos(ang)[..., None] * e1 + np.sin(ang)[..., None] * e2


S_TIPZ = 996.0                   # extra ogive stations near the meplat (crisp nose-on silhouette)
L_DIR = np.array([0.25, 1.0, -0.45])
L_HEAD = np.array([0.0, 1.0, 0.18])
HT_CELL, HT_PER = 15.0, 75       # close-up halftone screen: 36.87 deg lattice (12,9)/(-9,12) -> period 75 px


@lru_cache(maxsize=1)
def _ht_dist():
    """Distance (cell units) to the nearest dot centre; periodic every 75 px in
    x and y, so an integer slice offset pins the screen to the bullet tip."""
    yy, xx = np.mgrid[0:HT_PER, 0:HT_PER].astype(np.float32)
    u = (xx * 0.8 + yy * 0.6) / HT_CELL
    v = (yy * 0.8 - xx * 0.6) / HT_CELL
    fu = u - np.floor(u) - 0.5
    fv = v - np.floor(v) - 0.5
    tile = np.sqrt(fu * fu + fv * fv).astype(np.float32)
    ny, nx = -(-(H + HT_PER) // HT_PER), -(-(W + HT_PER) // HT_PER)
    return np.ascontiguousarray(np.tile(tile, (ny, nx))[:H + HT_PER, :W + HT_PER])


def _pnoise(n, cell, octaves, seed):
    """Tileable fractal value noise (n x n, 0..1): each octave's random grid is
    interpolated with wrapped neighbours, so the texture repeats seamlessly."""
    rng = np.random.default_rng(seed)
    out = np.zeros((n, n), np.float32)
    amp, tot = 1.0, 0.0
    g = max(2, int(round(n / cell)))
    for _ in range(octaves):
        grid = rng.random((g, g)).astype(np.float32)
        big = cv2.resize(np.tile(grid, (3, 3)), (3 * n, 3 * n), interpolation=cv2.INTER_CUBIC)
        out += big[n:2 * n, n:2 * n] * amp
        tot += amp
        amp *= 0.5
        g = min(g * 2, n)
    out /= tot
    out -= out.min()
    return out / max(float(out.max()), 1e-6)


@lru_cache(maxsize=1)
def _grit():
    """Fine worn-print grit for the close-up surface (tileable, no big smudges)."""
    n = 512
    rng = np.random.default_rng(71)
    fine = _pnoise(n, 5, 2, 72)
    mid = _pnoise(n, 34, 3, 73)
    speck = rng.random((n, n)).astype(np.float32)
    g = np.ones((n, n), np.float32)
    g -= np.clip((fine - 0.6) * 3.0, 0, 1) * 0.6
    g -= np.clip((mid - 0.68) * 4.0, 0, 1) * 0.45
    g -= (speck > 0.986).astype(np.float32) * 0.8
    sc = np.zeros((n, n), np.uint8)
    for _ in range(26):
        x0, y0 = rng.integers(0, n), rng.integers(0, n)
        a = rng.normal(0.4, 0.5)
        L = rng.integers(20, 110)
        x1, y1 = int(x0 + L * math.cos(a)), int(y0 + L * math.sin(a))
        for ox in (-n, 0, n):
            for oy in (-n, 0, n):
                cv2.line(sc, (int(x0) + ox, int(y0) + oy), (x1 + ox, y1 + oy), 255, 1, cv2.LINE_AA)
    g -= sc.astype(np.float32) / 255 * 0.3
    return np.clip(g, 0, 1)


def grit_sample(w, h, x0, y0, ax, ay, mag):
    """Worn-paint grit (1 clean .. 0 worn) attached to the bullet: zooms about the
    tip with magnification `mag`; two octaves crossfaded on log2(mag) so the
    detail never blurs while the nose rushes in."""
    g = _grit()
    L = math.log2(max(mag, 1e-3))
    fr = L - math.floor(L)
    out = np.zeros((h, w), np.float32)
    for sc, wt in ((1.1 * 2.0 ** fr, 1.0 - fr), (1.1 * 2.0 ** (fr - 1.0), fr)):
        if wt < 0.02:
            continue
        M = np.float32([[1 / sc, 0, (x0 - ax) / sc + 256], [0, 1 / sc, (y0 - ay) / sc + 256]])
        out += cv2.warpAffine(g, M, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                              borderMode=cv2.BORDER_WRAP) * wt
    return out


def stroke_poly(qh, half):
    """Screen polyline (n,2) + per-point half widths -> closed ribbon polygon."""
    tg_ = np.gradient(qh, axis=0)
    tg_ /= np.maximum(np.linalg.norm(tg_, axis=1, keepdims=True), 1e-6)
    nr = np.stack([-tg_[:, 1], tg_[:, 0]], 1)
    return np.concatenate([qh + nr * half[:, None], (qh - nr * half[:, None])[::-1]])


def render_bullet(cam, t, zing_glint=0.0, smear=0.0):
    """Returns (x0, y0, rgb, alpha, emission, tip_screen) or None.

    Painter's algorithm over consecutive slice pairs (far -> near) with one
    coverage canvas per material; the logo's dark outline is a screen-space
    stroke (distance transform) so it never turns into a 3D shell.  Side views
    keep the flat logo look (soft cylinder shading); towards nose-on the form is
    a hard graphic two-tone (lit GREEN / shadow GREEN_DK) split along the
    projected terminator meridians, with print grit + halftone in the shadow."""
    d, e1, e2 = bullet_axes(t)
    pr = profiles()
    tip_q, tip_z = cam.proj(np.array([(BL + S0) * d]))
    zc_mid = max(cam.depth(((S_GAP + S_FLAT) / 2 + S0) * d), 5.0)
    R_px = cam.foc * R_B / zc_mid
    o_px = float(np.clip(0.24 * R_px, 2.5, 24.0))
    st = {}
    rmax = 0.0
    for k in ("cas", "gap", "pro"):
        s, r = pr[k]
        z = cam.depth((np.asarray(s) + S0)[:, None] * d[None])
        rmax = max(rmax, float(np.max(cam.foc * np.asarray(r) / np.maximum(z, 1.0))))
        st[k] = (s, r)
    nphi = int(np.clip(rmax / 2.5, 32, 200))
    qs = {k: ring_pts(cam, d, e1, e2, st[k][0], st[k][1], nphi) for k in st}
    allp = np.concatenate([q.reshape(-1, 2) for q in qs.values()])
    pad = int(math.ceil(o_px)) + 3
    x0 = int(math.floor(allp[:, 0].min())) - pad
    y0 = int(math.floor(allp[:, 1].min())) - pad
    x1 = int(math.ceil(allp[:, 0].max())) + pad
    y1 = int(math.ceil(allp[:, 1].max())) + pad
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W), min(y1, H)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    if smear > 0.01:                                   # the zoom smear spreads outwards: give it the whole frame
        x0, y0, x1, y1 = 0, 0, W, H
    w, h = x1 - x0, y1 - y0
    ss = 3 if w * h < 450000 else 2 if w * h < 700000 else 1

    def down(c):
        return cv2.resize(c, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) * (1 / 255.0)

    # view facing along the axis
    vc = cam.C - ((S_FLAT + S0) * d)
    vc = vc / np.linalg.norm(vc)
    dv = float(np.dot(vc, d))
    side = clamp((math.sqrt(max(1 - dv * dv, 0)) - 0.3) / 0.35)
    head = smooth(clamp((dv - 0.5) / 0.35))           # 0 side view (flat logo look) -> 1 nose-on (graphic two-tone)

    pairs = []
    for k in ("cas", "gap", "pro"):
        s, r = st[k]
        for i in range(len(s) - 1):
            zz = cam.depth(((s[i] + s[i + 1]) / 2 + S0) * d)
            pairs.append((zz, k, i))
    pairs.sort(key=lambda v: -v[0])
    cans = {k: np.zeros((h * ss, w * ss), np.uint8) for k in ("cas", "gap", "pro")}
    off = np.array([x0, y0])
    qq = {k: ((qs[k] - off) * ss * 16 - 8).astype(np.int32) for k in qs}
    lt = cv2.LINE_8 if ss > 1 else cv2.LINE_AA
    for zz, k, i in pairs:
        hull = cv2.convexHull(np.concatenate([qq[k][i], qq[k][i + 1]]))
        for kk, c in cans.items():
            cv2.fillConvexPoly(c, hull, 255 if kk == k else 0, lt, 4)
    body_ss = np.maximum(np.maximum(cans["cas"], cans["gap"]), cans["pro"])
    dist = cv2.distanceTransform((body_ss < 128).astype(np.uint8), cv2.DIST_L2, 5)
    if ss > 1:
        a_out = down(((dist <= o_px * ss) * 255).astype(np.uint8))
    else:
        a_out = np.clip(o_px + 0.5 - dist, 0, 1).astype(np.float32)
        a_out = np.maximum(a_out, body_ss.astype(np.float32) / 255)
    m = {k: down(c) for k, c in cans.items()}
    del cans, body_ss, dist                            # keep the peak footprint low (fresh pages are slow here)

    mc, mg, mp = m["cas"], m["gap"], m["pro"]
    body = mc + mp
    np.clip(body, 0, 1, out=body)
    shade = None
    if head < 0.999:                                   # soft light / shadow bands (cylinder shading, side views)
        Lp = L_DIR - np.dot(L_DIR, d) * d
        Lp /= np.linalg.norm(Lp)
        sb = np.concatenate([pr["cas"][0], pr["pro"][0][1:]])
        rb = r_body(sb)
        sig = max(1.5, R_px * 0.22)
        fs = float(np.clip(6.0 / sig, 0.1, 1.0))
        ws, hs = max(4, int(w * fs)), max(4, int(h * fs))
        lc = np.zeros((hs, ws), np.uint8)
        sc = np.zeros((hs, ws), np.uint8)
        n2 = max(24, min(nphi, 160) // 2)
        ql = ring_pts(cam, d, e1, e2, sb, rb * 0.52, n2, shift=(0.40 * rb)[:, None] * Lp[None])
        qs_ = ring_pts(cam, d, e1, e2, sb, rb * 0.56, n2, shift=(-0.42 * rb)[:, None] * Lp[None])
        fill_union(lc, ql, x0, y0, fs)
        fill_union(sc, qs_, x0, y0, fs)
        light = cv2.resize(cv2.GaussianBlur(lc.astype(np.float32) / 255, (0, 0), sig * fs), (w, h), interpolation=cv2.INTER_LINEAR)
        shad = cv2.resize(cv2.GaussianBlur(sc.astype(np.float32) / 255, (0, 0), sig * fs), (w, h), interpolation=cv2.INTER_LINEAR)
        shade = 1.0 + (0.14 * light - (0.5 - 0.22 * dv * dv) * shad) * body

    # hard two-tone (towards nose-on): everything on the far side of the projected
    # terminator meridians (rotated 8 deg into the shadow) is GREEN_DK
    shm = None
    if head > 0.02:
        Lh = L_HEAD - np.dot(L_HEAD, d) * d                # graphic key light: top, a touch from behind
        Lh /= np.linalg.norm(Lh)
        pm_ = (800.0 + S0) * d
        lq = cam.proj(np.stack([pm_, pm_ + Lh * 30.0]))[0]
        ls = lq[1] - lq[0]
        nl = math.hypot(ls[0], ls[1])
        ls = ls / nl if nl > 1e-6 else np.array([0.0, -1.0])
        big = -ls * (6000.0 * ss)
        tdir = np.cross(d, Lh)
        rot = math.radians(8.0)
        sm = np.concatenate([np.linspace(0, S_FLAT, 10), S_FLAT + (BL - S_FLAT) * np.linspace(0, 1, 34)[1:] ** 0.8])
        rm = r_body(sm)
        slope = np.gradient(rm, sm)
        ca = 1 / np.sqrt(1 + slope ** 2)
        sa = -slope * ca
        scn = np.zeros((h * ss, w * ss), np.uint8)
        for sg_ in (1.0, -1.0):
            nt = sg_ * tdir * math.cos(rot) - Lh * math.sin(rot)
            P = (sm + S0)[:, None] * d + rm[:, None] * nt
            nrm = nt[None] * ca[:, None] + d[None] * sa[:, None]
            vv = cam.C - P
            vis = np.einsum("ij,ij->i", nrm, vv) / np.linalg.norm(vv, axis=1)
            q, zq = cam.proj(P)
            qh = (q - off) * ss
            for i in range(len(sm) - 1):
                if vis[i] > -0.02 and vis[i + 1] > -0.02 and zq[i] > 1 and zq[i + 1] > 1:
                    quad = np.stack([qh[i], qh[i + 1], qh[i + 1] + big, qh[i] + big])
                    cv2.fillConvexPoly(scn, (quad * 16).astype(np.int32), 255, cv2.LINE_AA, 4)
        shm = down(scn) * body

    rdx, rdy = -0.42, -0.91
    rim = None
    full = np.clip(body + mg, 0, 1)
    ro = float(np.clip(R_px * 0.075, 2.0, 9.0))
    for k_, f_ in ((1.0, 0.65), (0.45, 0.6)):
        Mt = np.float32([[1, 0, rdx * ro * k_], [0, 1, rdy * ro * k_]])
        shf = cv2.warpAffine(full, Mt, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        band_ = body * (1 - shf) * f_
        rim = band_ if rim is None else rim + band_
    np.clip(rim, 0, 1, out=rim)
    rim *= 0.95

    groove = None
    lw = max(1, int(round(R_px * 0.03 * ss)))
    spin = 2 * math.pi * 1.1 * t
    if side > 0.02:                                    # engraved rifling on the bearing cylinder (spins)
        gcan = np.zeros((h * ss, w * ss), np.uint8)
        sg = np.linspace(S_GAP + 30, S_FLAT - 10, 14)
        rg = r_body(sg)
        for k in range(12):
            ang = spin + k * 2 * math.pi / 12 + (sg - S_GAP) * 0.0022
            dirs = surf_dirs(e1, e2, ang)
            P = (sg + S0)[:, None] * d + rg[:, None] * dirs
            vis = np.einsum("ij,ij->i", dirs, cam.C - P) / np.linalg.norm(cam.C - P, axis=1)
            q, _ = cam.proj(P)
            qg = ((q - off) * ss * 16).astype(np.int32)
            for i in range(len(sg) - 1):
                v = min(vis[i], vis[i + 1])
                if v > 0.12:
                    c = int(255 * min(1.0, (v - 0.12) / 0.25))
                    cv2.line(gcan, tuple(qg[i]), tuple(qg[i + 1]), c, lw, cv2.LINE_AA, 4)
        groove = down(gcan) * (side * 0.55) * mp
    facet = None
    vt = cam.C - (BL + S0) * d
    dvt = float(np.dot(vt / np.linalg.norm(vt), d))
    fac_k = smooth(clamp((dvt - 0.88) / 0.1))           # facets only once the nose really faces the lens
    if fac_k > 0.02:                                   # 6 faint facet lines converging on the tip
        fcan = np.zeros((h * ss, w * ss), np.uint8)
        sf = S_FLAT + (BL - 3 - S_FLAT) * np.linspace(0, 1, 26) ** 0.8
        rf = r_body(sf)
        slope = np.gradient(rf, sf)
        ca, sa = 1 / np.sqrt(1 + slope ** 2), -slope / np.sqrt(1 + slope ** 2)
        flw = max(1, int(round(float(np.clip(cam.foc * 1.3 / max(float(tip_z[0]) + 60.0, 1.0), 1.0, 4.0)) * ss)))
        fspin = 2 * math.pi * (0.4 * t + 0.1 * ease_in_cubic(prog(t, 1.9, T_HIT))) + 0.26
        for k in range(6):
            ang = fspin + k * 2 * math.pi / 6
            dirs = surf_dirs(e1, e2, np.full_like(sf, ang))
            P = (sf + S0)[:, None] * d + rf[:, None] * dirs
            nrm = dirs * ca[:, None] + d[None] * sa[:, None]
            vv = cam.C - P
            vis = np.einsum("ij,ij->i", nrm, vv) / np.linalg.norm(vv, axis=1)
            q, _ = cam.proj(P)
            qg = ((q - off) * ss * 16).astype(np.int32)
            for i in range(len(sf) - 1):
                v = min(vis[i], vis[i + 1])
                rr = rf[i + 1] / R_B
                if v > 0.05 and rr > 0.012:
                    c = int(255 * min(1.0, (v - 0.05) / 0.2) * min(1.0, (rr - 0.012) / 0.1))
                    cv2.line(fcan, tuple(qg[i]), tuple(qg[i + 1]), c, flw, cv2.LINE_AA, 4)
        facet = down(fcan) * (0.35 * fac_k) * mp

    # logo highlight capsule: on the bearing cylinder in side views, sliding up onto
    # the upper ogive (tapering into the tip, white core) as the nose turns to camera
    tc = cam.C - (S_FLAT + S0) * d
    tc /= np.linalg.norm(tc)
    vp = tc - np.dot(tc, d) * d
    up = YV - np.dot(YV, d) * d
    up /= np.linalg.norm(up)
    nh = 0.77 * vp + 0.64 * up
    nh /= np.linalg.norm(nh)
    ph = math.atan2(float(np.dot(nh, e2)), float(np.dot(nh, e1)))
    uu = np.linspace(0, 1, 30)
    s_a, s_b = lerp(365.0, 640.0, head), lerp(666.0, 985.0, head)
    s_u = s_a + (s_b - s_a) * uu
    r_u = r_body(s_u)
    P = (s_u + S0)[:, None] * d + (r_u * 0.92)[:, None] * surf_dirs(e1, e2, np.full_like(uu, ph))
    q, zq = cam.proj(P)
    qh = (q - off) * ss
    half = cam.foc * np.minimum(lerp(9.0, 6.0, head), 0.13 * r_u) / np.maximum(zq, 1.0) * ss
    pb = np.concatenate([qh - half[:, None], qh + half[:, None]]) / ss
    bx0, by0 = int(max(math.floor(pb[:, 0].min()) - 3, 0)), int(max(math.floor(pb[:, 1].min()) - 3, 0))
    bx1, by1 = int(min(math.ceil(pb[:, 0].max()) + 4, w)), int(min(math.ceil(pb[:, 1].max()) + 4, h))
    if bx1 - bx0 < 2 or by1 - by0 < 2:
        bx0, by0, bx1, by1 = 0, 0, 2, 2
    capsule_box = (bx0, by0, bx1, by1)
    bw_, bh_ = bx1 - bx0, by1 - by0
    qb = qh - np.array([bx0 * ss, by0 * ss])            # capsule canvases cover only its own box

    def down_box(c):
        return cv2.resize(c, (bw_, bh_), interpolation=cv2.INTER_AREA).astype(np.float32) * (1 / 255.0)
    hcan = np.zeros((bh_ * ss, bw_ * ss), np.uint8)
    cv2.fillPoly(hcan, [(stroke_poly(qb, half) * 16).astype(np.int32)], 255, cv2.LINE_AA, 4)
    cv2.circle(hcan, (int(qb[0, 0] * 16), int(qb[0, 1] * 16)), int(half[0] * 16), 255, -1, cv2.LINE_AA, 4)
    cv2.circle(hcan, (int(qb[-1, 0] * 16), int(qb[-1, 1] * 16)), int(half[-1] * 16), 255, -1, cv2.LINE_AA, 4)
    hl = down_box(hcan) * mp[by0:by1, bx0:bx1]          # box-local (capsule_box)
    hlw = None
    if head > 0.02:
        j0 = 12
        kw = np.zeros((bh_ * ss, bw_ * ss), np.uint8)
        cv2.fillPoly(kw, [(stroke_poly(qb[j0:], half[j0:] * 0.4) * 16).astype(np.int32)], 255, cv2.LINE_AA, 4)
        hlw = down_box(kw) * (0.85 * head) * mp[by0:by1, bx0:bx1]

    zg = zc = None
    if zing_glint > 0:                                 # specular sweep tail -> tip over the upper half
        gy, gx = np.ogrid[0:h, 0:w]
        tail_q = cam.proj(np.array([S0 * d]))[0][0]
        ax = tip_q[0] - tail_q
        L2 = max(float(np.dot(ax, ax)), 1.0)
        an = ax / math.sqrt(L2)
        nup = np.array([an[1], -an[0]]) if an[0] >= 0 else np.array([-an[1], an[0]])
        px_ = (gx + x0 - tail_q[0]).astype(np.float32)
        py_ = (gy + y0 - tail_q[1]).astype(np.float32)
        u = (px_ * ax[0] + py_ * ax[1]) / L2
        vperp = px_ * float(nup[0]) + py_ * float(nup[1])
        upper = np.clip(vperp / (0.35 * R_px) + 0.35, 0, 1)
        pos = -0.1 + 1.25 * zing_glint
        band = np.exp(-((u - pos) / 0.018) ** 2)
        zg = band * upper * mp * 0.9
        hl_f = np.zeros((h, w), np.float32)
        hl_f[capsule_box[1]:capsule_box[3], capsule_box[0]:capsule_box[2]] = hl
        zc = np.exp(-((u - pos) / 0.007) ** 2) * np.clip(hl_f * 1.5 + upper * 0.4, 0, 1) * mp

    tex = dots = None
    if head > 0.02:                                    # close-up surface: worn print grit + halftone shadow
        ax_, ay_ = float(tip_q[0, 0]), float(tip_q[0, 1])
        mag = cam.foc / max(float(tip_z[0]), 1.0)
        g = grit_sample(w, h, x0, y0, ax_, ay_, mag)
        g -= 1.0
        g *= body
        g *= 0.2 * head
        g += 1.0
        tex = g                                        # 1 - 0.2*head*(1-grit)*body
        sm4 = cv2.resize(shm, (max(4, w // 4), max(4, h // 4)), interpolation=cv2.INTER_AREA)
        sgm = max(2.0, 0.12 * cam.foc * 40.0 / max(float(tip_z[0]) + 120.0, 1.0) / 4)
        deep = cv2.resize(cv2.GaussianBlur(sm4, (0, 0), sgm), (w, h), interpolation=cv2.INTER_LINEAR)
        hd = _ht_dist()
        ox = (x0 - int(round(ax_))) % HT_PER
        oy = (y0 - int(round(ay_))) % HT_PER
        dd = hd[oy:oy + h, ox:ox + w]
        deep *= 0.4 * HT_CELL * 0.9
        deep += 0.12 * HT_CELL * 0.9 + 0.5
        deep -= dd * (HT_CELL * 0.9)
        np.clip(deep, 0, 1, out=deep)
        deep *= shm
        deep *= 0.75 * head
        dots = deep                                    # clip((r - d) * cell * 0.9 + 0.5) * shm, r = 0.12 + 0.4 * deep

    # colour: flat logo materials (outline / casing / projectile) with the soft side-view
    # shading fading into the hard two-tone towards nose-on, then the over-layers
    em_hl = rim * 0.5                                  # emission mask for the bloom (highlights + rim)
    em_hl[capsule_box[1]:capsule_box[3], capsule_box[0]:capsule_box[2]] += hl
    np.clip(em_hl, 0, 1, out=em_hl)
    sh_eff = None
    if shade is not None:
        sh_eff = shade if head < 0.001 else (shade - 1.0) * (1.0 - head) + 1.0
    body *= -1.0                                       # body -> outline weight (1 - casing - projectile)
    body += 1.0
    base_w = body
    mcS, mpS = mc, None
    if shm is not None:
        shm *= head                                    # shm -> two-tone weight S (dots already used it)
        mcS = shm * -0.37
        mcS += 1.0
        mcS *= mc
        shm *= mp
        mpS = shm
    fg = groove if facet is None else facet if groove is None else np.maximum(groove, facet)
    rim_c = rim * mc
    rim *= mp
    rim_p = rim
    hb = capsule_box                                   # over-layers limited to their own boxes
    layers = []
    if fg is not None:
        layers.append((fg, GREEN_DK * 0.78, None, 1.0))
    layers.append((rim_p, GREEN_HOT * 0.6 + C_HL * 0.4, None, 1.0))
    layers.append((rim_c, GREEN * 1.05, None, 1.0))
    layers.append((hl, C_HL, hb, 0.95))
    if hlw is not None:
        layers.append((hlw, WHITE, hb, 1.0))
    if zg is not None:
        layers.append((zg, C_HL, None, 1.0))
        layers.append((zc, WHITE, None, 1.0))
    tmp = np.empty((h, w), np.float32)
    chans = []
    for c in range(3):
        o = float(C_OUT[c])
        cdk = float(GREEN_DK[c])
        gc = float(GREEN[c])
        v = mp * gc
        cv2.scaleAdd(base_w, o, v, dst=v)
        cv2.scaleAdd(mcS, cdk * 1.02, v, dst=v)
        cv2.scaleAdd(mg, 3.0, v, dst=v)
        if mpS is not None:
            cv2.scaleAdd(mpS, cdk * 0.8 - gc, v, dst=v)
        if sh_eff is not None:
            v *= sh_eff
        for a, col, box, kk in layers:
            if box is None:
                np.subtract(float(col[c]), v, out=tmp)
                tmp *= a
                v += tmp
            else:                                      # box-local layer
                vv = v[box[1]:box[3], box[0]:box[2]]
                vv += (float(col[c]) - vv) * (a * kk)
        chans.append(v)
    if smear > 0.01:                                   # growth smear (frames 78-79); print texture stays crisp on top
        a_out = nose_smear(chans, a_out, float(tip_q[0, 0]) - x0, float(tip_q[0, 1]) - y0, smear)
    for c in range(3):
        v = chans[c]
        if tex is not None:
            v *= tex
        if dots is not None:
            np.subtract(float(GREEN_DK[c]) * 0.42, v, out=tmp)
            tmp *= dots
            v += tmp
    rgb = cv2.merge(chans)

    # tip pinpoint: crisp white spec + hot halo; grows into a disc as the nose reaches the lens
    tgw = 1.0 - clamp((side - 0.2) / 0.45)
    if tgw > 0.01:
        rad = float(np.clip(cam.foc * 0.6 / max(float(tip_z[0]), 1.0), 3.0, 140.0))
        hs_ = rad * (2.2 - 0.7 * clamp((rad - 5) / 50))
        R4 = int(hs_ * 2.6 + rad) + 2
        cxl, cyl = int(round(tip_q[0, 0])) - x0, int(round(tip_q[0, 1])) - y0
        a0, a1 = max(cxl - R4, 0), min(cxl + R4, w)
        b0, b1 = max(cyl - R4, 0), min(cyl + R4, h)
        if a1 > a0 and b1 > b0:
            tx_, ty_ = float(tip_q[0, 0]) - x0, float(tip_q[0, 1]) - y0
            st_ = 4 if R4 > 120 else 1                 # the soft halo is built coarse when it is big
            gy, gx = np.ogrid[b0:b1:st_, a0:a1:st_]
            dd = ((gx + 0.5 * (st_ - 1) - tx_) ** 2 + (gy + 0.5 * (st_ - 1) - ty_) ** 2).astype(np.float32)
            halo = np.exp(-dd / (2 * hs_ ** 2)) * (0.85 * tgw)
            if st_ > 1:
                halo = cv2.resize(halo, (a1 - a0, b1 - b0), interpolation=cv2.INTER_LINEAR)
            halo *= a_out[b0:b1, a0:a1]
            reg = rgb[b0:b1, a0:a1]
            reg += (GREEN_HOT - reg) * halo[..., None]
            c0, c1 = max(int(tx_ - rad) - 3, 0), min(int(tx_ + rad) + 4, w)
            d0, d1 = max(int(ty_ - rad) - 3, 0), min(int(ty_ + rad) + 4, h)
            if c1 > c0 and d1 > d0:
                gy, gx = np.ogrid[d0:d1, c0:c1]
                disk = np.clip(rad + 0.5 - np.sqrt(((gx - tx_) ** 2 + (gy - ty_) ** 2).astype(np.float32)), 0, 1) * tgw
                reg = rgb[d0:d1, c0:c1]
                reg += (WHITE - reg) * disk[..., None]
                a_out[d0:d1, c0:c1] = np.maximum(a_out[d0:d1, c0:c1], disk)
    return x0, y0, rgb, a_out, (mp, mc, em_hl), tip_q[0]


# ---------------------------------------------------------------- particles / smoke / rings
XMIN, XMAX = -4200.0, 3200.0


@lru_cache(maxsize=1)
def streak_parts():
    rng = np.random.default_rng(202)
    n = 340
    x0 = rng.uniform(XMIN, XMAX, n)
    rho = 170 + 2600 * rng.random(n) ** 1.5
    phi = rng.uniform(0, 2 * math.pi, n)
    spd = rng.uniform(0.8, 1.25, n)
    br = rng.random(n)
    ln = rng.uniform(0.6, 1.4, n)
    return x0, rho, phi, spd, br, ln


V_STREAK = 3400.0


def draw_streaks(cam, t, add_back, add_front, emis_s, zsplit, amt=1.0, lenk=1.0):
    x0, rho, phi, spd, br, ln = streak_parts()
    per = XMAX - XMIN
    X = XMIN + np.mod(x0 - V_STREAK * spd * t - XMIN, per)
    Y = rho * np.sin(phi)
    Z = rho * np.cos(phi)
    P0 = np.stack([X, Y, Z], -1)
    L = V_STREAK * spd * 0.075 * ln * lenk
    P1 = P0 + L[:, None] * XV
    q0, z0 = cam.proj(P0)
    q1, z1 = cam.proj(P1)
    near = 60.0
    for i in range(len(X)):
        za, zb = z0[i], z1[i]
        if za < near and zb < near:
            continue
        a, b = P0[i], P1[i]
        qa, qb = q0[i], q1[i]
        if za < near or zb < near:          # clip to near plane
            k = (near - za) / (zb - za)
            pc = a + (b - a) * k
            qc, _ = cam.proj(pc[None])
            if za < near:
                qa, za = qc[0], near
            else:
                qb, zb = qc[0], near
        zm = min(za, zb)
        # fade at the wrap ends
        fe = clamp((X[i] - XMIN) / 600) * clamp((XMAX - X[i] - L[i]) / 600)
        lum = (0.22 + 0.78 * br[i] ** 2) * fe * amt * clamp(2600.0 / (zm + 400)) * clamp((zm - near) / 120)
        if lum < 0.02:
            continue
        hot = br[i] > 0.86
        col = ((ADD_G * 0.7 + MINT * 0.45) if hot else ADD_G * 0.8) * lum
        th = int(np.clip(cam.foc * 4.0 / zm, 1, 5))
        dst = add_front if zm < zsplit else add_back
        pa = (int(qa[0] * 16), int(qa[1] * 16))
        pb = (int(qb[0] * 16), int(qb[1] * 16))
        # head (lead end is P0: particles move -X) bright, tail fades: 3 sub-segments
        for j, f in enumerate((1.0, 0.55, 0.22)):
            u0, u1 = j / 3, (j + 1) / 3
            sa = (int(pa[0] + (pb[0] - pa[0]) * u0), int(pa[1] + (pb[1] - pa[1]) * u0))
            sb = (int(pa[0] + (pb[0] - pa[0]) * u1), int(pa[1] + (pb[1] - pa[1]) * u1))
            cv2.line(dst, sa, sb, tuple(float(v) * f for v in col), th, cv2.LINE_AA, 4)
        if emis_s is not None:
            cv2.line(emis_s, (pa[0] // 4, pa[1] // 4), (pb[0] // 4, pb[1] // 4), tuple(float(v) * 0.35 for v in col),
                     max(1, th // 2 + 1), cv2.LINE_AA, 4)


@lru_cache(maxsize=1)
def smoke_sprites():
    out = []
    for v in range(5):
        s = 160
        n = value_noise(s, s, 26, 4, 900 + v)
        n2 = value_noise(s, s, 9, 3, 950 + v)
        yy, xx = np.mgrid[0:s, 0:s].astype(np.float32) - s / 2
        rr = np.hypot(xx, yy) / (s * 0.46)
        a = np.clip(1 - rr, 0, 1) ** 1.1 * np.clip((n * 0.7 + n2 * 0.3 - 0.36) * 3.0, 0, 1) ** 1.3
        out.append(cv2.GaussianBlur(a, (0, 0), 1.2).astype(np.float32))
    for v in range(3):                                 # dense, soft puffs for the lit walls along the flight path
        s = 160
        n = value_noise(s, s, 30, 4, 980 + v)
        n2 = value_noise(s, s, 10, 3, 990 + v)
        yy, xx = np.mgrid[0:s, 0:s].astype(np.float32) - s / 2
        rr = np.hypot(xx, yy) / (s * 0.47)
        a = np.clip(1 - rr, 0, 1) ** 1.5 * np.clip(0.2 + 1.0 * (n * 0.7 + n2 * 0.3), 0, 1)
        out.append(cv2.GaussianBlur(a, (0, 0), 1.5).astype(np.float32))
    return out


@lru_cache(maxsize=1)
def smoke_parts():
    rng = np.random.default_rng(55)
    n1, n2 = 44, 30
    n = n1 + n2
    x0 = rng.uniform(XMIN, XMAX, n)
    y = np.concatenate([rng.uniform(-1300, 1300, n1), rng.uniform(-420, 420, n2)])
    z = np.concatenate([rng.uniform(-300, 900, n1 // 3), rng.uniform(700, 4200, n1 - n1 // 3), rng.uniform(-250, 650, n2)])
    rad = np.concatenate([rng.uniform(260, 720, n1), rng.uniform(170, 380, n2)])
    var = rng.integers(0, 5, n)
    rot = rng.uniform(0, 360, n)
    spd = rng.uniform(0.85, 1.15, n)
    op = rng.uniform(0.35, 1.0, n)
    # two lit smoke walls hugging the flight path above / below (|Y| 220-330): the bullet parts them
    rw = np.random.default_rng(56)
    n3 = 64
    xw = (np.arange(n3) // 2 + rw.uniform(0.0, 1.0, n3)) / (n3 // 2) * (XMAX - XMIN) + XMIN
    yw = np.where(np.arange(n3) % 2 == 0, 1.0, -1.0) * rw.uniform(230, 330, n3)
    zw = rw.uniform(-220, 220, n3)
    x0 = np.concatenate([x0, xw])
    y = np.concatenate([y, yw])
    z = np.concatenate([z, zw])
    rad = np.concatenate([rad, rw.uniform(260, 380, n3)])
    var = np.concatenate([var, rw.integers(0, 5, n3)])
    rot = np.concatenate([rot, rw.uniform(0, 360, n3)])
    spd = np.concatenate([spd, rw.uniform(0.92, 1.08, n3)])
    op = np.concatenate([op, rw.uniform(0.7, 1.0, n3)])
    wall = np.concatenate([np.zeros(n, bool), np.ones(n3, bool)])
    return x0, y, z, rad, var, rot, spd, op, wall


V_AIR = 720.0


def splat(dens, col, spr, cx, cy, sx, sy, ang, alpha, color, stretch_dir=None, stretch=0.0):
    """Affine-splat a sprite (half-res buffers)."""
    s = spr.shape[0]
    A = np.array([[sx / s, 0], [0, sy / s]], np.float64)
    R = np.array([[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]])
    A = R @ A
    if stretch_dir is not None and stretch > 0.01:
        dv = stretch_dir / (np.linalg.norm(stretch_dir) + 1e-9)
        Sm = np.eye(2) + stretch * np.outer(dv, dv)
        A = Sm @ A
    corners = np.array([[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]]) @ A.T + [cx, cy]
    hh, ww = dens.shape
    bx0 = int(max(math.floor(corners[:, 0].min()), 0))
    by0 = int(max(math.floor(corners[:, 1].min()), 0))
    bx1 = int(min(math.ceil(corners[:, 0].max()), ww))
    by1 = int(min(math.ceil(corners[:, 1].max()), hh))
    if bx1 - bx0 < 2 or by1 - by0 < 2:
        return
    M = np.zeros((2, 3))
    M[:, :2] = A
    M[:, 2] = np.array([cx - bx0, cy - by0]) - A @ np.array([s / 2, s / 2])
    out = cv2.warpAffine(spr, M, (bx1 - bx0, by1 - by0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    out *= alpha
    dens[by0:by1, bx0:bx1] += out
    col[by0:by1, bx0:bx1] += out[..., None] * color


def smoke_light(P):
    """Green light from the bullet on a smoke puff at world P."""
    d = math.hypot(max(abs(P[0]) - 450, 0), math.hypot(P[1], P[2]))
    return 1.0 / (1.0 + (d / 380.0) ** 2)


SMK = 4                                              # smoke buffer downscale
SMOKE_C0 = np.array([10, 12, 11], np.float32)
SMOKE_C1 = np.array([112, 172, 88], np.float32)      # bullet light on the smoke (green-grey)


def draw_smoke(cam, t, amt=1.0):
    h2, w2 = H // SMK, W // SMK
    dens = np.zeros((h2, w2), np.float32)
    col = np.zeros((h2, w2, 3), np.float32)
    sprs = smoke_sprites()
    x0, y, z, rad, var, rot, spd, op, wall = smoke_parts()
    per = XMAX - XMIN
    X = XMIN + np.mod(x0 - V_AIR * spd * t - XMIN, per)
    items = []
    tipx = BL + S0
    for i in range(len(X)):
        Y, Z = y[i], z[i]
        rho = math.hypot(Y, Z)
        behind = tipx - X[i]
        if behind > 0 and rho < 1400:                     # parted by the bullet: bows outward behind the tip
            if wall[i]:
                push = 200 * (1 - math.exp(-behind / 300))
            else:
                push = 650 * (1 - math.exp(-behind / 380)) * math.exp(-(rho / 700) ** 2)
            k = (rho + push) / max(rho, 1)
            Y, Z = Y * k, Z * k
        P = np.array([X[i], Y, Z])
        items.append((cam.depth(P), i, P))
    # wake puffs: born at the tail, dragged behind, expanding
    rng = np.random.default_rng(77)
    wake = []
    for k in range(40):
        tb = -1.2 + k * 0.06
        a = t - tb
        if not (0 < a < 1.6):
            continue
        ph = rng.uniform(0, 2 * math.pi)
        rr = 40 + 160 * a
        P = np.array([S0 - 60 - 380 * a, rr * math.sin(ph + a * 2), rr * math.cos(ph + a * 2)])
        wake.append((cam.depth(P), -1 - k, P, a))
    allit = [(it[0], it[1], it[2], None) for it in items] + [(w_[0], w_[1], w_[2], w_[3]) for w_ in wake]
    allit.sort(key=lambda v: -v[0])
    rng2 = np.random.default_rng(78)
    wrot = rng2.uniform(0, 6.28, 64)
    for zc, i, P, age in allit:
        if zc < 80:
            continue
        if age is None:
            R = rad[i]
            alpha = (0.62 if wall[i] else 0.25) * op[i]
            fe = clamp((P[0] - XMIN) / 900) * clamp((XMAX - P[0]) / 900)
            alpha *= fe
            spr = sprs[5 + var[i] % 3] if wall[i] else sprs[var[i]]
            ang = math.radians(rot[i] + 8 * t)
            vel = V_AIR * spd[i]
        else:
            R = 70 + 420 * age
            alpha = 0.5 * (1 - math.exp(-age * 10)) * math.exp(-age * 1.7)
            spr = sprs[(-i) % 5]
            ang = wrot[(-i) % 64] + age * 1.5
            vel = 380.0
        alpha *= clamp((zc - 80) / 500) * amt
        if alpha < 0.004:
            continue
        q, _ = cam.proj(P[None])
        q = q[0] / SMK
        rs = cam.foc * R / zc / SMK
        if rs < 1.5 or q[0] + rs < 0 or q[0] - rs > w2 or q[1] + rs < 0 or q[1] - rs > h2:
            continue
        q2, _ = cam.proj((P - XV * vel * (1 / FPS))[None])
        mv = q2[0] / SMK - q
        stretch = min(np.linalg.norm(mv) * 0.6 / (2 * rs), 3.0)
        li = smoke_light(P)
        c = SMOKE_C0 + SMOKE_C1 * li
        if age is not None:
            c = c * 1.15
        splat(dens, col, spr, q[0], q[1], 2 * rs, 2 * rs, ang, alpha, c, mv, stretch)
    return dens, col


# ---------------------------------------------------------------- shock rings
RING_DT = 0.2
V_RING, C_RING = 1150.0, 620.0


def ring_list(t):
    out = []
    k0 = int(math.floor((t - 1.4) / RING_DT))
    k1 = int(math.floor(t / RING_DT))
    for k in range(k0, k1 + 1):
        tb = k * RING_DT + 0.07
        a = t - tb
        if 0 <= a < 1.0:
            out.append((a, 1.0, 1.0))
    if t >= T_ZING:                                   # the zing pop: big thin ring, snaps open fast
        a = t - T_ZING
        if a < 0.6:
            out.append((a, 1.3, 2.2))
    return out


def ring_geom(a, cf=1.0):
    if cf > 2.0:                                      # pop ring: fast exponential expansion
        return BL + S0 + 20 - V_RING * 0.5 * a, 40 + 950 * (1 - math.exp(-a * 9))
    return BL + S0 + 20 - V_RING * a, 30 + C_RING * cf * a


def draw_rings(cam, t, add_back, add_front, emis_s, zsplit, rmap=None):
    """Shock rings: crisp line (add buffers) + half-res pressure band (rmap) that
    drives a soft glow and a refractive push of the background."""
    nphi = 120
    ph = np.linspace(0, 2 * math.pi, nphi + 1)
    for a, inten, cf in ring_list(t):
        x, r = ring_geom(a, cf)
        pop = cf > 2.0
        if pop:
            al = inten * math.exp(-a * 7.0) * clamp(a / 0.02 + 0.2)
        else:
            al = inten * math.exp(-a * 3.6) * clamp(a / 0.05 + 0.15) * clamp((1.0 - a) / 0.25)
        if al < 0.01:
            continue
        P = np.stack([np.full(nphi + 1, x), r * np.sin(ph), r * np.cos(ph)], -1)
        q, z = cam.proj(P)
        if (z < 30).all():
            continue
        zm = max(float(np.median(z)), 1.0)
        thick = 3 if pop else int(np.clip(cam.foc * 2.6 / zm, 1, 3))
        col = (GREEN_HOT * 0.6 + MINT * 0.4) * al * 0.8 if pop else MINT * al * 0.55
        if rmap is not None and (z > 30).all():
            qh = (q * 8).astype(np.int32)                # half res, 4 bit shift
            cv2.polylines(rmap, [qh], False, float(min(al, 1.2)), 3 if not pop else 2, cv2.LINE_AA, 4)
        for j in range(nphi):
            if z[j] < 30 or z[j + 1] < 30:
                continue
            dst = add_front if z[j] < zsplit else add_back
            pa = (int(q[j, 0] * 16), int(q[j, 1] * 16))
            pb = (int(q[j + 1, 0] * 16), int(q[j + 1, 1] * 16))
            cv2.line(dst, pa, pb, tuple(float(v) for v in col), thick, cv2.LINE_AA, 4)
        if emis_s is not None:
            qs = (q[z > 30] / 4 * 16).astype(np.int32)
            if len(qs) > 2:
                cv2.polylines(emis_s, [qs], False, tuple(float(v) for v in ADD_G * al * (1.3 if pop else 0.45)),
                              3 if pop else 2, cv2.LINE_AA, 4)


def draw_cone(cam, t, add_back, emis_s, amt=1.0):
    """Bow-shock envelope (schlieren V) from the nose: silhouette of the Mach cone."""
    if amt < 0.01:
        return
    apex = np.array([BL + S0 + 20, 0.0, 0.0])
    x, r = ring_geom(0.85)
    ph = np.linspace(0, 2 * math.pi, 90, endpoint=False)
    P = np.stack([np.full(90, x), r * np.sin(ph), r * np.cos(ph)], -1)
    q, z = cam.proj(P)
    qa, za = cam.proj(apex[None])
    if (z < 40).any() or za[0] < 40:
        return
    pts = np.vstack([qa, q]).astype(np.float32)
    hull = cv2.convexHull(pts, returnPoints=False).ravel()
    if 0 not in hull:
        return                                         # apex inside: seen head-on
    j = int(np.where(hull == 0)[0][0])
    for nb in (hull[(j - 1) % len(hull)], hull[(j + 1) % len(hull)]):
        b = pts[nb]
        a0 = pts[0]
        n = 14
        for i in range(n):
            u0, u1 = i / n, (i + 1) / n
            f = max(0.0, 1 - u0 / 0.6) ** 1.5 * 0.34 * amt * clamp(u1 * 6)
            pa = a0 + (b - a0) * u0
            pb = a0 + (b - a0) * u1
            cv2.line(add_back, (int(pa[0] * 16), int(pa[1] * 16)), (int(pb[0] * 16), int(pb[1] * 16)),
                     tuple(float(v) * f for v in MINT), 2, cv2.LINE_AA, 4)
            if emis_s is not None:
                cv2.line(emis_s, (int(pa[0] * 4), int(pa[1] * 4)), (int(pb[0] * 4), int(pb[1] * 4)),
                         tuple(float(v) * f * 0.6 for v in ADD_G), 3, cv2.LINE_AA, 4)
    # faint cone sheet
    if emis_s is not None:
        hp = (pts[hull] * 4).astype(np.int32)
        sheet = np.zeros(emis_s.shape[:2], np.float32)
        cv2.fillConvexPoly(sheet, hp, 1.0, cv2.LINE_AA, 4)
        emis_s += sheet[..., None] * ADD_G * (0.03 * amt)


# ---------------------------------------------------------------- logo streak trail (3 tapered ribbons)
def draw_trail(cam, t, add_back, emis_s, amt=1.0):
    d, e1, e2 = bullet_axes(t)
    tail = S0 * d
    # offsets in the bullet's screen-facing plane: use e2 (up-ish)
    for oy, th, ln, k in ((0.55, 0.16, 0.62, 0.8), (0.0, 0.30, 1.0, 1.0), (-0.55, 0.14, 0.5, 0.7)):
        P0 = tail + e2 * (oy * R_B) - d * 30
        P1 = P0 - XV * (1500 * ln)
        n = 18
        us = np.linspace(0, 1, n)
        P = P0[None] + (P1 - P0)[None] * us[:, None]
        q, z = cam.proj(P)
        if (z < 60).any():
            continue
        wpx = cam.foc * (th * R_B) / z
        for i in range(n - 1):
            f = (1 - us[i]) ** 1.6 * k * amt
            c = tuple(float(v) * f for v in ADD_G * 0.95)
            w_ = int(max(1, wpx[i] * (1 - us[i] * 0.7)))
            cv2.line(add_back, (int(q[i, 0] * 16), int(q[i, 1] * 16)), (int(q[i + 1, 0] * 16), int(q[i + 1, 1] * 16)),
                     c, w_, cv2.LINE_AA, 4)
            if emis_s is not None:
                cv2.line(emis_s, (int(q[i, 0] * 4), int(q[i, 1] * 4)), (int(q[i + 1, 0] * 4), int(q[i + 1, 1] * 4)),
                         tuple(v * 0.8 for v in c), max(1, w_ // 3), cv2.LINE_AA, 4)


# ---------------------------------------------------------------- zing sparks
@lru_cache(maxsize=1)
def zing_sparks():
    rng = np.random.default_rng(1301)
    n = 20
    ang = rng.normal(0, 0.5, n) + math.pi              # backwards cone
    elev = rng.uniform(0, 2 * math.pi, n)
    v = rng.uniform(700, 2400, n)
    life = rng.uniform(0.18, 0.5, n)
    vx = v * np.cos(ang)
    vr = v * np.abs(np.sin(ang)) + rng.uniform(150, 600, n)
    return vx, vr, elev, life


def draw_sparks(cam, t, buf, emis_s):
    """Zing sparks: 3 px hot heads with tapered tails (masked by the bullet later)."""
    dt = t - T_ZING
    if dt < 0 or dt > 0.55:
        return
    vx, vr, elev, life = zing_sparks()
    tip = np.array([BL + S0 + 10, 0, 0])
    for i in range(len(vx)):
        if dt > life[i]:
            continue
        a = (1 - dt / life[i]) ** 1.3

        def pos(tt):
            x = tip[0] + (vx[i] - V_AIR * 0.5) * tt
            r = vr[i] * tt
            return np.array([x, 20 + r * math.sin(elev[i]) - 300 * tt * tt, r * math.cos(elev[i])])
        tl = 0.045
        P = np.stack([pos(max(dt - tl * f, 0)) for f in (0.0, 0.25, 0.55, 1.0)])
        q, z = cam.proj(P)
        if (z < 50).any():
            continue
        base = GREEN_HOT * 0.95 if i % 3 else MINT * 0.85
        for j, (th, f) in enumerate(((3, 1.0), (2, 0.6), (1, 0.3))):
            c = tuple(float(v) * a * f for v in base)
            cv2.line(buf, (int(q[j, 0] * 16), int(q[j, 1] * 16)), (int(q[j + 1, 0] * 16), int(q[j + 1, 1] * 16)), c, th,
                     cv2.LINE_AA, 4)
        cv2.circle(buf, (int(q[0, 0] * 16), int(q[0, 1] * 16)), 24, tuple(float(v) * a for v in WHITE * 0.9), -1, cv2.LINE_AA, 4)
        if emis_s is not None:
            cv2.line(emis_s, (int(q[0, 0] * 4), int(q[0, 1] * 4)), (int(q[2, 0] * 4), int(q[2, 1] * 4)),
                     tuple(float(v) * a * 1.2 for v in base), 2, cv2.LINE_AA, 4)


# ---------------------------------------------------------------- HUD type planes (3D)
def paste(dst, src, x, y):
    """Straight-alpha layer over straight-alpha layer, in place."""
    h, w = src.shape[:2]
    d = dst[y:y + h, x:x + w]
    a = src[..., 3:4]
    da = d[..., 3:4]
    oa = a + da * (1 - a)
    d[..., :3] = np.where(oa > 1e-5, (src[..., :3] * a + d[..., :3] * da * (1 - a)) / np.maximum(oa, 1e-5), 0)
    d[..., 3:4] = oa


def worn(lay, seed, amount=0.85, dots=0.35, cell=9):
    """Poster-style wear: grunge erosion + halftone dot breakup."""
    h, w = lay.shape[:2]
    o = distress(lay, amount, seed)
    ht = halftone(w, h, cell=cell, angle=45.0, seed=seed, falloff="noise")
    n = value_noise(w, h, 120, 3, seed + 3)
    k = np.clip((n - 0.45) * 3, 0, 1) * dots
    o[..., 3] *= 1 - k * (1 - ht)
    return o


def ht_breakup(lay, cell, seed, y0f=0.35, y1f=1.0, rmin=0.12):
    """Poster-style halftone breakup: solid at the top of the type, dissolving
    into shrinking dots towards the bottom (noise-modulated)."""
    h, w = lay.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u = (xx + yy) * (0.70710678 / cell)
    v = (yy - xx) * (0.70710678 / cell)
    fu = u - np.floor(u) - 0.5
    fv = v - np.floor(v) - 0.5
    dd = np.sqrt(fu * fu + fv * fv)
    ramp = np.clip((yy / h - y0f) / (y1f - y0f), 0, 1)
    ramp = ramp * ramp * (3 - 2 * ramp)
    n = value_noise(w, h, 90, 3, seed)
    r = 0.75 - (0.75 - rmin) * np.clip(ramp * (0.65 + 0.7 * n), 0, 1)
    o = lay.copy()
    o[..., 3] *= np.clip((r - dd) * cell * 0.9 + 0.5, 0, 1)
    return o


@lru_cache(maxsize=1)
def hud_layers():
    big = text_layer(".50 BMG", "stencil", 420, fill=BONE, pad=24)
    bw = worn(big, 31, 1.0, 0.7, 13)
    big = ht_breakup(bw, 13.0, 33, 0.38, 1.0, 0.1)
    xd = 24 + int(font("stencil", 420).getbbox(".")[2]) + 8          # keep the "." of .50 solid
    big[:, :xd, 3] = np.maximum(big[:, :xd, 3], bw[:, :xd, 3] * 0.9)
    alvo = text_layer("ALVO TRAVADO", "stencil", 230, fill=BONE, pad=18)          # ghost plane: lighter build
    alvo = ht_breakup(alvo, 10.0, 39, 0.3, 1.0, 0.12)                              # ghost: dot breakup only
    # velocity block
    cap = text_layer("VELOCIDADE", "oswald", 34, fill=BONE, tracking=7, pad=6)
    num = text_layer("853 M/S", "stencil", 150, fill=GREEN, pad=10)
    num = worn(num, 44, 0.55, 0.3, 7)
    w = max(cap.shape[1], num.shape[1]) + 40
    h = cap.shape[0] + num.shape[0] + 16
    blk = np.zeros((h, w, 4), np.float32)
    paste(blk, cap, 6, 0)
    paste(blk, num, 0, cap.shape[0] + 4)
    bar = np.zeros((h, w), np.uint8)
    cv2.line(bar, (cap.shape[1] + 18, cap.shape[0] // 2), (w - 4, cap.shape[0] // 2), 255, 2, cv2.LINE_AA)
    paste(blk, solid_layer(bar.astype(np.float32) / 255, GREEN), 0, 0)
    # energy tag
    cal = text_layer("ENERGIA", "oswald", 30, fill=BONE, tracking=6, pad=6)
    calv = text_layer("18.000 J", "stencil", 66, fill=WHITE, pad=8)
    cw = max(cal.shape[1], calv.shape[1]) + 10
    ch_ = cal.shape[0] + calv.shape[0] + 4
    cb = np.zeros((ch_, cw, 4), np.float32)
    paste(cb, cal, 4, 0)
    paste(cb, calv, 0, cal.shape[0] + 2)
    cb = worn(cb, 52, 0.3, 0.1, 6)
    return {"big": big, "vel": blk, "cal": cb, "alvo": alvo}


T_REF = 0.8
T_REF2 = 1.95
# name, screen centre at t_ref, depth (from camera), screen height px, drift speed (-X, u/s), opacity, t_ref
PLANES = (
    ("big", (1010, 272), 2400.0, 226.0, 150.0, 0.72, T_REF),     # ".50 BMG": far plane, distressed bone type
    ("vel", (560, 860), 900.0, 205.0, 420.0, 0.95, T_REF),
    ("cal", (1555, 872), 1250.0, 96.0, 300.0, 0.85, T_REF),      # ENERGIA: balances 853 M/S on the bottom band
    ("alvo", (930, 205), 2600.0, 190.0, 260.0, 0.24, T_REF2),    # ghost "ALVO TRAVADO" behind the swing / approach
)


@lru_cache(maxsize=1)
def plane_defs():
    lays = hud_layers()
    out = []
    for name, (sx, sy), z, hs, spd, op, tref in PLANES:
        lay = lays[name]
        lh, lw = lay.shape[:2]
        if tref == T_REF:                                  # cruise planes (unchanged framing)
            cam = Cam(tref, (0, 0))
            f_, ox, oy = FOC, 0.0, 0.0
        else:                                              # framed in the approach camera (focal ramp + tip offset)
            cam = Cam(tref)
            f_, ox, oy = cam.foc, cam.ox, cam.oy
        wpp = (hs / lh) * z / f_                           # world units per layer px
        cxw = cam.C + z * cam.f + (sx - CX - ox) * z / f_ * cam.r - (sy - CY - oy) * z / f_ * cam.u
        out.append((name, cxw, cam.r.copy(), cam.u.copy(), wpp, lw, lh, spd, op, tref))
    return out


@lru_cache(maxsize=8)
def premul_layer(name):
    return premul(hud_layers()[name])


SHUTTER = 0.5 / FPS


@lru_cache(maxsize=64)
def _line_kernel(qx, qy):
    """Normalised AA line kernel for a motion vector quantised to 0.5 px."""
    vx, vy = qx / 2.0, qy / 2.0
    n = int(math.ceil(max(abs(vx), abs(vy)))) + 3
    n += 1 - n % 2
    k = np.zeros((n, n), np.float32)
    c = n // 2
    cv2.line(k, (int((c - vx / 2) * 16), int((c - vy / 2) * 16)), (int((c + vx / 2) * 16), int((c + vy / 2) * 16)),
             1.0, 1, cv2.LINE_AA, 4)
    return k / max(float(k.sum()), 1e-6)


def draw_planes(frame, t, names, amt=1.0, blur=False):
    """3D type planes; while the camera swings each plane is warped once at
    mid-shutter and smeared with a line kernel along its own projected motion
    (smooth smear, no stepped ghost copies)."""
    cam = Cam(t - SHUTTER / 2) if blur else Cam(t)
    cam0, cam1 = (Cam(t - SHUTTER), Cam(t)) if blur else (None, None)
    for name, cw, pr_, pu, wpp, lw, lh, spd, op, tref in plane_defs():
        if name not in names:
            continue
        o = op * amt
        if name == "cal":
            o *= ease_out_cubic(prog(t, 0.35, 0.7))
        if o < 0.01:
            continue
        pm = premul_layer(name)
        c = cw - XV * spd * (t - SHUTTER / 2 * blur - tref)
        hw, hh = lw * wpp / 2, lh * wpp / 2
        P = np.stack([c - pr_ * hw + pu * hh, c + pr_ * hw + pu * hh, c + pr_ * hw - pu * hh, c - pr_ * hw - pu * hh])
        src = np.float32([[0, 0], [lw, 0], [lw, lh], [0, lh]])
        q, z = cam.proj(P)
        if (z < 120).any():
            continue
        ker, pad = None, 0
        if blur:
            ca = cam0.proj((cw - XV * spd * (t - SHUTTER - tref))[None])[0][0]
            cb = cam1.proj((cw - XV * spd * (t - tref))[None])[0][0]
            v = cb - ca
            if math.hypot(v[0], v[1]) > 1.2:
                vq = np.clip(np.round(v * 2), -400, 400)
                ker = _line_kernel(int(vq[0]), int(vq[1]))
                pad = ker.shape[0] // 2 + 1
        x0 = int(max(math.floor(q[:, 0].min()) - pad, 0))
        y0 = int(max(math.floor(q[:, 1].min()) - pad, 0))
        x1 = int(min(math.ceil(q[:, 0].max()) + pad, W))
        y1 = int(min(math.ceil(q[:, 1].max()) + pad, H))
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        Hm = cv2.getPerspectiveTransform(src, (q - [x0, y0]).astype(np.float32))
        wv = cv2.warpPerspective(pm, Hm, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        if ker is not None:
            wv = cv2.filter2D(wv, -1, ker, borderType=cv2.BORDER_CONSTANT)
        reg = frame[y0:y1, x0:x1]
        reg += (wv[..., :3] - reg * wv[..., 3:4]) * o


# ---------------------------------------------------------------- screen-space HUD: range tape + DIST readout
PX_PER_M = 90.0


@lru_cache(maxsize=64)
def label_layer(text, fname, size, color_key, tracking=0):
    col = {"bone": BONE, "green": GREEN, "white": WHITE}[color_key]
    return text_layer(text, fname, size, fill=col, tracking=tracking, pad=4)


def dist_m(t):
    """Range readout: counts up and locks on 1.240 m on the zing beat."""
    return 1228.0 + 12.0 * prog(t, 0.0, T_ZING)


def fmt_m(v):
    v = int(round(v))
    return f"{v // 1000}.{v % 1000:03d}"


def draw_tape(frame, t, amt):
    if amt < 0.01:
        return
    y = 92
    m = dist_m(t)
    base = CX - m * PX_PER_M
    lo = int(math.floor((0 - base) / (PX_PER_M / 5))) - 1
    hi = int(math.ceil((W - base) / (PX_PER_M / 5))) + 1
    lay = np.zeros((70, W), np.float32)
    for k in range(lo, hi + 1):
        x = base + k * PX_PER_M / 5
        major = k % 5 == 0
        ln = 22 if major else 10
        cv2.line(lay, (int(x * 16), (34 - ln) * 16), (int(x * 16), 34 * 16), 1.0 if major else 0.6, 2 if major else 1,
                 cv2.LINE_AA, 4)
    cv2.line(lay, (0, 34), (W, 34), 0.35, 1, cv2.LINE_AA)
    # fade at the edges
    xs = np.linspace(0, 1, W, dtype=np.float32)
    edge = np.clip(np.minimum(xs, 1 - xs) / 0.18, 0, 1) ** 1.5
    lay *= edge[None]
    frame[y - 34:y + 36] += (BONE - frame[y - 34:y + 36]) * (lay * 0.55 * amt)[..., None]
    for k in range(lo, hi + 1):
        if k % 5:
            continue
        x = base + k * PX_PER_M / 5
        e = edge[int(np.clip(x, 0, W - 1))]
        if e < 0.05:
            continue
        lab = label_layer(fmt_m(k / 5 * 1.0 * 1), "oswald", 22, "bone", 2)
        over(frame, lab, x - lab.shape[1] / 2, y + 6, 0.7 * amt * e)
    # centre pointer + readout
    tri = np.array([[CX - 9, y - 46], [CX + 9, y - 46], [CX, y - 34]], np.float32)
    cv2.fillConvexPoly(frame, (tri * 16).astype(np.int32), tuple(float(v) * amt + float(f) * (1 - amt) for v, f in zip(GREEN, frame[y - 40, int(CX)])), cv2.LINE_AA, 4)
    cv2.line(frame, (int(CX * 16), (y - 34) * 16), (int(CX * 16), (y + 2) * 16), tuple(float(v) for v in GREEN * amt), 2, cv2.LINE_AA, 4)
    lab = label_layer("DIST", "oswald", 30, "bone", 5)
    lock = T_ZING <= t < T_ZING + 2.5 / FPS
    val = label_layer(fmt_m(m) + " M", "stencil", 54, "white" if lock else "green")
    x = 118
    over(frame, lab, x, 150, 0.9 * amt)
    over(frame, val, x - 4, 186, amt)
    cap = label_layer("DISTÂNCIA AO ALVO", "oswald", 20, "bone", 4)
    over(frame, cap, x, 252, 0.55 * amt)
    if t >= T_ZING:                                    # lock: corner brackets snap onto the readout (2 frames)
        sn = 1.0 - ease_out_cubic(prog(t, T_ZING, T_ZING + 2 / FPS))
        hot = t < T_ZING + 2.5 / FPS
        col = tuple(float(c) * amt for c in (WHITE if hot else GREEN))
        bx0, by0 = x - 14 - 22 * sn, 184 - 14 * sn
        bx1, by1 = x - 4 + val.shape[1] + 10 + 22 * sn, 186 + val.shape[0] + 2 + 14 * sn
        L = 16
        for (cx_, cy_, sx_, sy_) in ((bx0, by0, 1, 1), (bx1, by0, -1, 1), (bx0, by1, 1, -1), (bx1, by1, -1, -1)):
            p = (int(cx_ * 16), int(cy_ * 16))
            cv2.line(frame, p, (int((cx_ + sx_ * L) * 16), p[1]), col, 3, cv2.LINE_AA, 4)
            cv2.line(frame, p, (p[0], int((cy_ + sy_ * L) * 16)), col, 3, cv2.LINE_AA, 4)


# ---------------------------------------------------------------- background
@lru_cache(maxsize=1)
def bg_maps():
    """Void background + halftone corners; smooth parts built small then upscaled.
    Returns (base, halftone, green-glow term, quarter-res light pool for the smoke)."""
    w4, h4 = W // 4, H // 4
    yq, xq = np.mgrid[0:h4, 0:w4].astype(np.float32) * 4 + 2
    n = value_noise(w4, h4, 65, 4, 61)
    g = np.exp(-(((xq - W * 0.52) / 900) ** 2 + ((yq - H * 0.52) / 420) ** 2))
    pool = np.exp(-(((xq - W * 0.56) / (W * 0.34)) ** 2 + ((yq - H * 0.52) / (H * 0.42)) ** 2)).astype(np.float32)
    gg = np.zeros((h4, w4), np.float32)
    for cx, cy, s in ((0, 0, 1.0), (W, H, 0.95), (W, 0, 0.55), (0, H, 0.6)):
        r = np.hypot((xq - cx) / (W * 0.36), (yq - cy) / (H * 0.6))
        gg = np.maximum(gg, s * np.clip(1 - r, 0, 1) ** 1.2)
    gg *= 0.55 + 0.45 * value_noise(w4, h4, 38, 3, 62)
    green_q = ((g * (0.6 + 0.4 * n))[..., None] * np.array([3, 7, 2], np.float32)).astype(np.float32)
    base_q = (INK[None, None] * ((0.8 + 0.25 * n) * (0.8 + 0.2 * pool))[..., None] + green_q).astype(np.float32)
    w2, h2 = W // 2, H // 2
    cell = 17.0 / 2                                     # dots built at half res
    yy, xx = np.mgrid[0:h2, 0:w2].astype(np.float32)
    c, s_ = math.cos(math.radians(45)) / cell, math.sin(math.radians(45)) / cell
    fu = (xx * c + yy * s_) % 1 - 0.5
    fv = (yy * c - xx * s_) % 1 - 0.5
    dd = np.sqrt(fu * fu + fv * fv)
    gh = cv2.resize(gg, (w2, h2), interpolation=cv2.INTER_LINEAR)
    m = np.clip((gh * 0.62 - dd) * cell * 1.1 + 0.5, 0, 1) * grunge(w2, h2, 63)
    base_h = cv2.resize(base_q, (w2, h2), interpolation=cv2.INTER_LINEAR)
    ht_h = ((BONE[None, None] - base_h) * m[..., None] * 0.10).astype(np.float32)
    base = cv2.resize(base_q, (W, H), interpolation=cv2.INTER_LINEAR)
    ht = cv2.resize(ht_h, (W, H), interpolation=cv2.INTER_LINEAR)
    green = cv2.resize(green_q, (W, H), interpolation=cv2.INTER_LINEAR)
    smoke_pool = (0.15 + 0.85 * pool)[..., None].astype(np.float32)
    return base, ht, green, smoke_pool


# ---------------------------------------------------------------- glass cracks
# Centre + base pattern match scene 3's opening frame exactly (it fades the same
# lib.crack_mask network out), so the cut is seamless.
CRACK_C = (W * 0.52, H * 0.47)
S3_CRACKS = ((7, 17, 1.0, 2), (8, 9, 0.55, 1))           # (seed, branches, progress, thickness)


def _crack_geom(cx, cy, seed, branches, progress):
    """Replica of lib.crack_mask's geometry (same RNG call sequence)."""
    rng = np.random.default_rng(seed)
    radials, side = [], []
    for b in range(branches):
        ang = b / branches * 2 * math.pi + rng.normal(0, 0.18)
        x, y = float(cx), float(cy)
        L = (0.25 + rng.random() * 0.75) * math.hypot(W, H) * 0.5 * progress
        steps = 18
        pts = [(x, y)]
        for s in range(steps):
            seg = L / steps
            ang += rng.normal(0, 0.22)
            nx, ny = x + math.cos(ang) * seg, y + math.sin(ang) * seg
            pts.append((nx, ny))
            if rng.random() < 0.18:
                ba = ang + rng.choice([-1, 1]) * rng.uniform(0.5, 1.1)
                bl = seg * rng.uniform(1.5, 4)
                side.append(((nx, ny), (nx + math.cos(ba) * bl, ny + math.sin(ba) * bl)))
            x, y = nx, ny
        radials.append(np.array(pts, np.float32))
    return radials, side


@lru_cache(maxsize=1)
def crack_maps():
    """Crack network: s3's base cracks (pixel-exact) + spiderweb rings / crushed
    core extras, arrival-radius map for the growth, shard cells (between the real
    crack lines) with tint / refraction offset / green sheen, glint edges."""
    rng = np.random.default_rng(2650)
    cx, cy = CRACK_C
    base = np.zeros((H, W), np.float32)
    for k, (sd, nb, pr, th) in enumerate(S3_CRACKS):
        base += crack_mask(W, H, cx, cy, seed=sd, branches=nb, progress=pr, thickness=th) * (1.0 if k == 0 else 0.7)
    base = np.clip(base, 0, 1)
    radials, side = _crack_geom(cx, cy, *S3_CRACKS[0][:2], S3_CRACKS[0][2])
    rad2, side2 = _crack_geom(cx, cy, *S3_CRACKS[1][:2], S3_CRACKS[1][2])

    def rad_of(p):
        return math.hypot(p[0] - cx, p[1] - cy)

    base_segs = []
    for p in radials + rad2:
        for j in range(len(p) - 1):
            base_segs.append((p[j], p[j + 1]))
    base_segs += [(np.array(a, np.float32), np.array(b, np.float32)) for a, b in side + side2]

    extra = []                                          # (p0, p1, thickness, brightness)
    order = sorted(range(len(radials)), key=lambda i: math.atan2(radials[i][3][1] - cy, radials[i][3][0] - cx))

    def at_radius(p, R):
        rr = np.hypot(p[:, 0] - cx, p[:, 1] - cy)
        idx = np.nonzero(rr >= R)[0]
        if len(idx) == 0 or idx[0] == 0:
            return None
        j = int(idx[0])
        u = (R - rr[j - 1]) / max(rr[j] - rr[j - 1], 1e-3)
        return p[j - 1] + (p[j] - p[j - 1]) * float(np.clip(u, 0, 1))

    for kk, R0 in enumerate((38, 74, 122, 190, 285, 420)):
        prb = 0.95 - kk * 0.11
        for ii in range(len(order)):
            if rng.random() > prb:
                continue
            a = at_radius(radials[order[ii]], R0 * rng.uniform(0.88, 1.12))
            b = at_radius(radials[order[(ii + 1) % len(order)]], R0 * rng.uniform(0.88, 1.12))
            if a is None or b is None or np.linalg.norm(a - b) > R0 * 1.4:
                continue
            mid = (a + b) / 2
            v = np.array([mid[0] - cx, mid[1] - cy])
            mid = mid - v / max(np.linalg.norm(v), 1) * R0 * rng.uniform(0.03, 0.1)
            n = 4
            pts = [a + (mid - a) * (s / n) for s in range(n)] + [mid + (b - mid) * (s / n) for s in range(n + 1)]
            pts = np.array(pts, np.float32)
            pts[1:-1] += rng.normal(0, 1.3, (2 * n - 1, 2)).astype(np.float32)
            for j in range(len(pts) - 1):
                extra.append((pts[j], pts[j + 1], 3 if R0 < 130 else 2, rng.uniform(0.85, 1.0)))
    na = 7                                              # long, nearly straight radial fractures (glass, not veins)
    a0s = rng.uniform(0, 2 * math.pi)
    for j in range(na):
        a = a0s + j * 2 * math.pi / na + rng.normal(0, 0.22)
        L = rng.uniform(620, 1150)
        r = rng.uniform(14, 30)
        x, y = cx + r * math.cos(a), cy + r * math.sin(a)
        nseg = int(L / 38)
        for q in range(nseg):
            a += rng.normal(0, 0.035)
            seg = L / nseg
            nx, ny = x + seg * math.cos(a), y + seg * math.sin(a)
            th = 3 if q < nseg * 0.3 else 2 if q < nseg * 0.7 else 1
            extra.append((np.array([x, y], np.float32), np.array([nx, ny], np.float32), th,
                          rng.uniform(0.85, 1.0) * (1 - 0.35 * q / nseg)))
            x, y = nx, ny
    for _ in range(90):                                 # crushed core
        a = rng.uniform(0, 2 * math.pi)
        r0 = abs(rng.normal(0, 18))
        L = rng.uniform(8, 28)
        b = a + rng.normal(0, 1.2)
        p0 = np.array([cx + r0 * math.cos(a), cy + r0 * math.sin(a)], np.float32)
        p1 = p0 + np.array([L * math.cos(b), L * math.sin(b)], np.float32)
        extra.append((p0, p1, 1, rng.uniform(0.5, 1.0)))

    ex = np.zeros((H, W), np.float32)
    binm = (base > 0.25).astype(np.uint8)
    arr = np.full((H, W), 1e9, np.float32)
    for p0, p1, th, br in extra:
        a0 = (int(p0[0] * 16), int(p0[1] * 16))
        a1 = (int(p1[0] * 16), int(p1[1] * 16))
        rr = max(rad_of(p0), rad_of(p1))
        cv2.line(ex, a0, a1, float(br * (0.8 + 0.2 * math.exp(-rr / 520))), th, cv2.LINE_AA, 4)
        cv2.line(binm, a0, a1, 1, th, cv2.LINE_8, 4)
        cv2.line(arr, a0, a1, float(rr), th + 3, cv2.LINE_8, 4)
    for p0, p1 in base_segs:
        rr = max(rad_of(p0), rad_of(p1))
        cv2.line(arr, (int(p0[0] * 16), int(p0[1] * 16)), (int(p1[0] * 16), int(p1[1] * 16)), float(rr), 5, cv2.LINE_8, 4)
    arr = cv2.erode(arr, np.ones((3, 3), np.uint8))       # arrival = min over neighbourhood (covers AA fringe)
    ex = np.clip(ex, 0, 1)
    # smooth / per-cell maps at half res, upscaled (cell edges sit under crack lines)
    w2, h2 = W // 2, H // 2
    yh, xh = np.mgrid[0:h2, 0:w2].astype(np.float32) * 2 + 0.5
    rh = np.hypot(xh - cx, yh - cy)

    def up(a, interp=cv2.INTER_LINEAR):
        return cv2.resize(a.astype(np.float32), (W, H), interpolation=interp)

    falloff = up(0.55 + 0.45 * np.exp(-rh / 520))
    shadow = np.roll(np.roll(np.maximum(base, ex), 1, 0), 1, 1)
    # frost only around the crushed core
    fr_ = 128
    fcx, fcy = int(cx), int(cy)
    fyy, fxx = np.mgrid[-fr_:fr_, -fr_:fr_].astype(np.float32)
    frost_c = np.exp(-(np.hypot(fxx, fyy) / 30) ** 2) * (0.5 + 0.5 * value_noise(2 * fr_, 2 * fr_, 6, 2, 2651))
    n_lab, lab = cv2.connectedComponents((1 - cv2.dilate(binm, np.ones((3, 3), np.uint8))).astype(np.uint8), connectivity=4)
    tint = rng.normal(0, 1, n_lab).astype(np.float32)
    sdir = rng.uniform(0, 2 * math.pi, n_lab)
    sph = rng.uniform(0, 2 * math.pi, n_lab).astype(np.float32)
    son = (rng.random(n_lab) < 0.4).astype(np.float32)
    for arrv in (tint, son):
        arrv[0] = 0
    # 4-5 big shards near the hit catch the light hard (x3 sheen)
    area = np.bincount(lab.ravel(), minlength=n_lab).astype(np.float64)
    ys_, xs_ = np.mgrid[0:H:4, 0:W:4]
    lq = lab[::4, ::4].ravel()
    cnt = np.maximum(np.bincount(lq, minlength=n_lab), 1)
    mxc = np.bincount(lq, weights=xs_.ravel(), minlength=n_lab) / cnt
    myc = np.bincount(lq, weights=ys_.ravel(), minlength=n_lab) / cnt
    near = np.hypot(mxc - cx, myc - cy) < 640
    cand = [i for i in np.argsort(-area) if i > 0 and near[i] and area[i] < W * H * 0.08][:5]
    boost = np.ones(n_lab, np.float32)
    for i in cand:
        boost[i] = 3.0
        son[i] = 1.0
    lh = lab[::2, ::2]
    sd = np.cos(sdir).astype(np.float32)[lh] * (xh - cx) / 300 + np.sin(sdir).astype(np.float32)[lh] * (yh - cy) / 300
    sheen = up(np.clip(np.sin(sd * 2.5 + sph[lh]), 0, 1) ** 5 * (son * boost)[lh] * np.exp(-(rh / 950) ** 2))
    tintm = up(tint[lh] * np.exp(-(rh / 1100) ** 2))
    # per-shard refraction: each pane of glass shifts what's behind it by 4-10 px
    ra = rng.uniform(0, 2 * math.pi, n_lab)
    rm = rng.uniform(4.0, 10.0, n_lab)
    ox_, oy_ = (np.cos(ra) * rm).astype(np.float32), (np.sin(ra) * rm).astype(np.float32)
    ox_[0] = oy_[0] = 0
    refx, refy = ox_[lab], oy_[lab]
    # crushed core: a solid bright star ~40 px across
    st_n = 11
    sa = rng.uniform(0, 2 * math.pi)
    spts = []
    for i in range(2 * st_n):
        ang = sa + i * math.pi / st_n + rng.normal(0, 0.08)
        rr_ = rng.uniform(15, 23) if i % 2 == 0 else rng.uniform(4.5, 7.0)
        spts.append((cx + rr_ * math.cos(ang), cy + rr_ * math.sin(ang)))
    star = np.zeros((H, W), np.float32)
    cv2.fillPoly(star, [(np.array(spts) * 16).astype(np.int32)], 1.0, cv2.LINE_AA, 4)
    sx0, sy0 = int(cx) - 40, int(cy) - 40
    star_p = star[sy0:sy0 + 80, sx0:sx0 + 80].copy()
    # glints = real crack segments (same int coords / thickness as crack_mask) lighting up
    gl = []
    tries = 0
    while len(gl) < 16 and tries < 400:
        tries += 1
        b_ = int(rng.integers(0, len(radials)))
        j0 = int(rng.integers(2, 13))
        m_ = int(rng.integers(2, 5))
        pts = radials[b_][j0:j0 + m_ + 1]
        rd = rad_of(pts[0])
        if rd < 60 or rd > 950 or len(pts) < 3:
            continue
        ths = [max(1, int(S3_CRACKS[0][3] * (1 - (j0 + q) / 18) + 0.5)) for q in range(len(pts) - 1)]
        gl.append(([(int(p[0]), int(p[1])) for p in pts], ths, rng.uniform(0, 6.28), rd))
    # pre-combined lines (+ arrival radius) for the per-frame pass
    lines = np.maximum(base * falloff, ex)
    return {
        "base": base.astype(np.float32), "extra": ex.astype(np.float32), "falloff": falloff, "lines": lines,
        "shadow": shadow.astype(np.float32), "arr": arr, "frost": frost_c.astype(np.float32), "frost_at": (fcx - fr_, fcy - fr_),
        "tint": tintm, "sheen": sheen, "glints": gl, "refx": refx.astype(np.float32), "refy": refy.astype(np.float32),
        "star": star_p, "star_at": (sx0, sy0),
    }


def crack_pass(frame, t, neg=0.0):
    dt = t - (F_HIT / FPS)
    cm = crack_maps()
    grow = ease_out_expo(prog(dt, -0.01, 0.2))
    front = 40 + 1500 * grow
    reach = (cm["arr"] <= front).astype(np.float32) if front < 1500 else None
    settle = smooth(prog(t, 2.8, DUR - 1 / FPS))          # hand-off: relax to s3's opening look
    tf = clamp(grow) * (1 - settle)
    lit = 0.7 + 0.3 * math.exp(-dt * 9)
    xf = 1 - smooth(prog(t, 2.72, 2.88))                   # the impact-only extras fade into the s3 network
    if tf > 0.02:
        frame += (cm["tint"] * (7.0 * tf))[..., None] + cm["sheen"][..., None] * (ADD_G * (38 * tf * lit * xf / 255.0))
        sh = cm["shadow"] if reach is None else cm["shadow"] * reach
        frame *= (1 - (0.65 * tf) * np.minimum(sh, 1))[..., None]
    k1 = 0.9 * lit * (1 - settle)
    k2 = 0.32 * settle                                  # == scene 3's opening crack opacity
    k3 = 0.95 * lit * xf * (1 - settle)
    fo = cm["falloff"] if neg <= 0 else cm["falloff"] + (1 - cm["falloff"]) * neg
    a = np.maximum(cm["base"] * (fo * k1 + k2), cm["extra"] * k3)
    if reach is not None:
        a *= reach
    vis = a
    core = (BONE * 0.6 + MINT * 0.4) * (1 - settle) + BONE * settle
    core = core + ((MINT * 0.55 + WHITE * 0.45) - core) * neg
    frame += (core[None, None] - frame) * a[..., None]
    fx, fy = cm["frost_at"]
    fz = cm["frost"]
    reg = frame[fy:fy + fz.shape[0], fx:fx + fz.shape[1]]
    reg += (BONE - reg) * (fz * (0.35 * lit * clamp(grow) * (1 - settle)))[..., None]
    sk = clamp(grow * 3) * xf * (1 - settle)
    if sk > 0.01:                                       # crushed core: solid hot star
        sx0, sy0 = cm["star_at"]
        sp = cm["star"]
        reg = frame[sy0:sy0 + sp.shape[0], sx0:sx0 + sp.shape[1]]
        reg += ((MINT * 0.5 + WHITE * 0.5) - reg) * (sp * sk)[..., None]
    # light running along real crack segments ("shards of green light"), additive
    lit = lit * (1 - settle) * xf
    gb, _ = _bufs()
    gb.fill(0)
    any_ = False
    for pts, ths, ph, rd in cm["glints"]:
        if rd > front:
            continue
        tw = max(0.0, math.sin(t * 7.0 + ph)) ** 4 * 0.8 + 1.5 * math.exp(-max(dt - rd / 7000, 0) * 10) + 0.6 * neg
        if tw < 0.03 or lit < 0.01:
            continue
        c = tuple(float(v) * min(tw, 1.5) * lit for v in (ADD_G * 0.7 + MINT * 0.55))
        for q in range(len(pts) - 1):
            cv2.line(gb, pts[q], pts[q + 1], c, ths[q], cv2.LINE_AA)
        any_ = True
    if any_:
        small = cv2.resize(gb, (W // 2, H // 2), interpolation=cv2.INTER_AREA)
        frame += gb
        frame += cv2.resize(cv2.GaussianBlur(small, (0, 0), 2.5), (W, H), interpolation=cv2.INTER_LINEAR) * 2.2
    return frame, vis


# ---------------------------------------------------------------- whip-in from s1 + impact
@lru_cache(maxsize=1)
def flood_rows():
    h2 = H // 2
    rng = np.random.default_rng(322)
    fine = cv2.resize(rng.random((h2 // 3, 1)).astype(np.float32), (1, h2), interpolation=cv2.INTER_LINEAR)[:, 0]
    coarse = cv2.resize(rng.random((9, 1)).astype(np.float32), (1, h2), interpolation=cv2.INTER_CUBIC)[:, 0]
    return np.clip(0.6 * fine ** 2 + 0.25 * coarse, 0, 1).astype(np.float32)


T_WHIP = 0.30


def whip_in(frame, t):
    p = prog(t, -0.08, T_WHIP)        # the light wall is already moving on frame 0
    if p >= 1:
        return frame
    w2, h2 = W // 2, H // 2
    small = cv2.resize(frame, (w2, h2), interpolation=cv2.INTER_AREA)
    k = int(1 + 110 * (1 - ease_out_cubic(prog(t, 0.0, 0.42))))
    if k > 2:
        small = cv2.blur(cv2.blur(small, (k, 1)), (k, 1))
    # overexposure settling
    small = small + (FLASH_C - small) * (0.6 * (1 - p) ** 2)
    r = flood_rows()[:, None]
    xs = np.arange(w2, dtype=np.float32)[None, :] * 2
    e = (W + 160) - (W + 1000) * p ** 1.45 - 700 * r * p      # right edge of the light wall
    soft = 80 + 300 * p
    dd = (e - xs) / soft
    a = np.clip(dd + 0.5, 0, 1)
    a = a * a * (3 - 2 * a)
    fringe = np.exp(-(dd * 1.4) ** 2) * min(1.0, p * 5) * (1 - p)
    col = FLASH_C * 0.97 + np.float32(0.03) * GREEN
    small = small + (col - small) * a[..., None] + fringe[..., None] * ADD_G * 0.6
    out = cv2.resize(small, (W, H), interpolation=cv2.INTER_LINEAR)
    if p > 0.85:          # cross to the full-res frame to keep it crisp at the end
        kk = (p - 0.85) / 0.15
        out = out * (1 - kk) + frame * kk
    return out


# ---------------------------------------------------------------- main
@lru_cache(maxsize=1)
def _bufs():
    return np.zeros((H, W, 3), np.float32), np.zeros((H, W, 3), np.float32)


def qbloom(frame, thr, sigma, strength):
    small = cv2.resize(frame, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(np.maximum(small - thr, 0), (0, 0), sigma)
    cv2.scaleAdd(cv2.resize(small, (W, H), interpolation=cv2.INTER_LINEAR), float(strength), frame, dst=frame)
    return frame


@lru_cache(maxsize=1)
def _grid():
    gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
    return gx, gy


RING_PUSH = 26.0                                     # refractive push gain (~4 px for a fresh ring)


def ring_fx(frame, rmap):
    """Shock-ring pressure bands: 2-3 px soft green glow + refractive push of what's
    behind. Only the 128 px tiles the (thin) rings actually touch are processed."""
    if float(rmap.max()) < 0.02:
        return frame
    soft = cv2.GaussianBlur(rmap, (0, 0), 1.6)
    gx = cv2.Sobel(soft, cv2.CV_32F, 1, 0, ksize=3, scale=RING_PUSH / 8.0)
    gy = cv2.Sobel(soft, cv2.CV_32F, 0, 1, ksize=3, scale=RING_PUSH / 8.0)
    glh = cv2.GaussianBlur(rmap, (0, 0), 1.1)
    col = ADD_G * 0.30 + MINT * 0.08
    T2 = 64                                            # tile size at half res
    act = cv2.dilate((soft > 0.004).astype(np.uint8), np.ones((5, 5), np.uint8))
    nty, ntx = -(-act.shape[0] // T2), -(-act.shape[1] // T2)
    pad = np.zeros((nty * T2, ntx * T2), np.uint8)
    pad[:act.shape[0], :act.shape[1]] = act
    tiles = pad.reshape(nty, T2, ntx, T2).max(axis=(1, 3))
    X, Y = _grid()
    done = []
    for ty, tx in zip(*np.nonzero(tiles)):
        hy0, hx0 = ty * T2, tx * T2
        hy1, hx1 = min(hy0 + T2, H // 2), min(hx0 + T2, W // 2)
        fy0, fx0, fy1, fx1 = hy0 * 2, hx0 * 2, hy1 * 2, hx1 * 2
        # sample the half-res maps with a 1-px apron so the upscale matches the full-frame version
        ay0, ax0 = max(hy0 - 1, 0), max(hx0 - 1, 0)
        ay1, ax1 = min(hy1 + 1, H // 2), min(hx1 + 1, W // 2)
        M = np.float32([[0.5, 0, hx0 - ax0 - 0.25], [0, 0.5, hy0 - ay0 - 0.25]])   # == cv2.resize x2 (linear)
        sz = (fx1 - fx0, fy1 - fy0)
        dx = cv2.warpAffine(gx[ay0:ay1, ax0:ax1], M, sz, flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                            borderMode=cv2.BORDER_REPLICATE)
        dy = cv2.warpAffine(gy[ay0:ay1, ax0:ax1], M, sz, flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                            borderMode=cv2.BORDER_REPLICATE)
        gl = cv2.warpAffine(glh[ay0:ay1, ax0:ax1], M, sz, flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                            borderMode=cv2.BORDER_REPLICATE)
        mx = X[fy0:fy1, fx0:fx1] + dx
        my = Y[fy0:fy1, fx0:fx1] + dy
        reg = cv2.remap(frame, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        reg += gl[..., None] * col
        done.append((fy0, fy1, fx0, fx1, reg))
    for fy0, fy1, fx0, fx1, reg in done:               # paste after sampling: tiles read the untouched frame
        frame[fy0:fy1, fx0:fx1] = reg
    return frame


def zoom_blur(frame, cx, cy, amt, mix=0.85):
    """Light radial zoom blur (half res) centred on the incoming tip. Iterated
    pairwise averaging (scales 1+a, 1+a/2, ... ) = 32 taps, so no stepped copies."""
    w2, h2 = W // 2, H // 2
    acc = cv2.resize(frame, (w2, h2), interpolation=cv2.INTER_AREA)
    a = amt
    for _ in range(5):
        M = cv2.getRotationMatrix2D((cx / 2, cy / 2), 0, 1.0 + a)
        acc = (acc + cv2.warpAffine(acc, M, (w2, h2), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)) * 0.5
        a *= 0.5
    blurred = cv2.resize(acc, (W, H), interpolation=cv2.INTER_LINEAR)
    return frame + (blurred - frame) * mix


@lru_cache(maxsize=1)
def _speed_parts():
    rng = np.random.default_rng(909)
    n = 64
    return (rng.uniform(0, 2 * math.pi, n), rng.uniform(0, 1, n), rng.uniform(0.8, 1.5, n),
            rng.uniform(0.25, 1.0, n), rng.random(n) < 0.25)


def speed_lines(buf, cx, cy, t, amt):
    """Screen-space radial speed lines bursting out of the tip (last ~0.3 s)."""
    if amt < 0.01:
        return
    ang, ph, spd, br, hot = _speed_parts()
    for i in range(len(ang)):
        u = (ph[i] + t * spd[i] * 2.6) % 1.0
        r0 = 90 + 1500 * u ** 1.7
        r1 = r0 + 40 + 520 * u ** 1.2
        f = math.sin(math.pi * u) * br[i] * amt * 1.5
        if f < 0.02:
            continue
        ca, sa = math.cos(ang[i]), math.sin(ang[i])
        col = tuple(float(v) * f for v in ((MINT * 0.6 + ADD_G * 0.4) if hot[i] else ADD_G * 0.7))
        p0 = (int((cx + ca * r0) * 16), int((cy + sa * r0) * 16))
        p1 = (int((cx + ca * r1) * 16), int((cy + sa * r1) * 16))
        cv2.line(buf, p0, p1, col, 3 if hot[i] else 2, cv2.LINE_AA, 4)


@lru_cache(maxsize=1)
def _spk_buf():
    return np.zeros((H, W, 3), np.float32)


def nose_smear(chans, al, cx, cy, a):
    """Radial growth smear about the tip (layer coords), in place on the colour
    planes: zoom blur sampling inwards only (never past the frame edge), built at
    half res. Colour and alpha are smeared separately: outside the silhouette the
    colour is already the outline ink, so this matches a premultiplied smear."""
    h, w = al.shape
    w2, h2 = (w + 1) // 2, (h + 1) // 2
    Ms, k = [], a
    for _ in range(4):
        Ms.append(cv2.getRotationMatrix2D((cx / 2, cy / 2), 0, 1.0 + k))
        k *= 0.5

    def smear1(p, out=None):
        q = cv2.resize(p, (w2, h2), interpolation=cv2.INTER_AREA)
        for M in Ms:
            q = cv2.addWeighted(q, 0.5, cv2.warpAffine(q, M, (w2, h2), flags=cv2.INTER_LINEAR,
                                                       borderMode=cv2.BORDER_REPLICATE), 0.5, 0.0)
        return cv2.resize(q, (w, h), dst=out, interpolation=cv2.INTER_LINEAR)
    for c in chans:
        smear1(c, c)
    return np.clip(smear1(al), 0, 1)


def render(t, ctx):
    t = float(t)
    fr = int(round(t * FPS))
    if abs(t * FPS - fr) < 1e-3:
        t = fr / FPS
    hit = fr >= F_HIT
    base, ht, _, pool = bg_maps()
    breathe = 0.85 + 0.15 * math.sin(t * 2.4)
    frame = cv2.addWeighted(base, 1.0, ht, breathe, 0.0)
    if hit:
        frame = impact(frame, t)
        return np.clip(frame, 0, 255, out=frame)

    cam = Cam(t)
    blur = T_SWING0 - 0.02 < t < 1.8                 # smear the type planes while the camera swings
    amt_planes = 1.0 - smooth(prog(t, T_SWING0 + 0.02, 1.72))
    draw_planes(frame, t, ("big",), amt_planes, blur)
    amt_alvo = smooth(prog(t, 1.40, 1.62)) * (1.0 - smooth(prog(t, 2.18, 2.36)))
    if amt_alvo > 0.01:                               # ghost stencil plane carries the parallax type through the swing
        draw_planes(frame, t, ("alvo",), amt_alvo, True)

    # smoke (quarter res), lit by the bullet; the edges of the frame stay INK
    dens, smoke_col = draw_smoke(cam, t)
    oma = 1.0 - np.clip(dens, 0, 0.92)
    smoke_col *= np.minimum(1.0, 0.92 / np.maximum(dens, 1e-3))[..., None]
    smoke_col *= pool
    oma3 = cv2.resize(np.repeat(oma[..., None], 3, axis=2), (W, H), interpolation=cv2.INTER_LINEAR)
    cv2.multiply(frame, oma3, dst=frame)

    zsplit = cam.depth(np.zeros(3))
    add_back, add_front = _bufs()
    add_back.fill(0)
    add_front.fill(0)
    emis_s = np.zeros((H // 4, W // 4, 3), np.float32)
    rmap = np.zeros((H // 2, W // 2), np.float32)
    late = ease_in_out(prog(t, T_HIT - 0.32, T_HIT - 0.02))   # last ~0.3 s: rushing into the lens
    streak_amt = (0.8 + 0.7 * smooth(prog(t, T_SWING0, T_HIT))) * (1.0 + late)
    draw_streaks(cam, t, add_back, add_front, emis_s, zsplit, streak_amt, 1.0 + late)
    draw_rings(cam, t, add_back, add_front, emis_s, zsplit, rmap)
    draw_cone(cam, t, add_back, emis_s, 1.0)
    draw_trail(cam, t, add_back, emis_s, 1.0 - smooth(prog(t, 1.45, 1.8)))
    spk = None
    if 0 <= t - T_ZING <= 0.55:
        spk = _spk_buf()
        spk.fill(0)
        draw_sparks(cam, t, spk, emis_s)

    zg = prog(t, T_ZING - 0.02, T_ZING + 0.14)
    sm_a = 0.0
    if fr >= F_HIT - 2:                               # 2-frame smear on the nose growth as it hits the lens
        sp = foc_at(t - 1 / FPS) / cam_dist(t - 1 / FPS)
        sm_a = max(cam.foc / cam.D / sp - 1.0, 0.0) * 0.4
    B = render_bullet(cam, t, zg if 0 < zg < 1 else 0.0, sm_a)
    if B is not None:
        x0, y0, rgb, al, em, tipq = B
        h, w = al.shape
        qx0, qy0 = x0 // 4, y0 // 4
        qx1, qy1 = min((x0 + w + 3) // 4, W // 4), min((y0 + h + 3) // 4, H // 4)
        for mk, colr in zip(em, (ADD_G * 0.55, GREEN_DK * 0.25, C_HL * 0.3)):
            pad = np.zeros(((qy1 - qy0) * 4, (qx1 - qx0) * 4), np.float32)
            hh_, ww_ = min(h, pad.shape[0] - (y0 - qy0 * 4)), min(w, pad.shape[1] - (x0 - qx0 * 4))
            pad[y0 - qy0 * 4:y0 - qy0 * 4 + hh_, x0 - qx0 * 4:x0 - qx0 * 4 + ww_] = mk[:hh_, :ww_]
            emis_s[qy0:qy1, qx0:qx1] += cv2.resize(pad, (qx1 - qx0, qy1 - qy0), interpolation=cv2.INTER_AREA)[..., None] * colr

    e8 = cv2.resize(emis_s, (W // 8, H // 8), interpolation=cv2.INTER_AREA)
    wide = cv2.resize(cv2.GaussianBlur(e8, (0, 0), 14), (W // 4, H // 4), interpolation=cv2.INTER_LINEAR)
    g = cv2.GaussianBlur(emis_s, (0, 0), 2.0) * 0.6 + cv2.GaussianBlur(emis_s, (0, 0), 9) * 0.3 + wide * 0.07
    g += smoke_col                                     # smoke light + glow share one upscale
    cv2.add(frame, cv2.resize(g, (W, H), interpolation=cv2.INTER_LINEAR), dst=frame)
    if late > 0.01 and B is not None:                 # background rushes: radial zoom blur (streaks stay crisp)
        frame = zoom_blur(frame, float(B[5][0]), float(B[5][1]), 0.25 * late, min(1.0, late * 1.5))
        speed_lines(add_back, float(B[5][0]), float(B[5][1]), t, late)
    cv2.add(frame, add_back, dst=frame)
    frame = ring_fx(frame, rmap)
    rr_k = range_ring_k(t)
    if B is not None and rr_k > 0:
        range_ring(frame, t, rr_k, B[5])

    if B is not None:
        x0, y0, rgb, al, em, tipq = B
        h, w = al.shape
        reg = frame[y0:y0 + h, x0:x0 + w]
        reg += (rgb - reg) * al[..., None]
        add_front[y0:y0 + h, x0:x0 + w] *= (1 - 0.8 * al)[..., None]    # keep streaks from slicing across the hero
        if spk is not None:
            spk[y0:y0 + h, x0:x0 + w] *= (1 - al)[..., None]           # sparks never cross the projectile
    cv2.add(frame, add_front, dst=frame)
    if spk is not None:
        cv2.add(frame, spk, dst=frame)
    draw_planes(frame, t, ("vel", "cal"), amt_planes, blur)

    if B is not None:
        tipq = B[5]
        z = t - T_ZING
        fl = (1.3 * math.exp(-z * 10) if z >= 0 else 0.0) + 0.12 * (1 - smooth(prog(t, T_SWING0, 1.9)))
        fl += 1.1 * ease_in_cubic(prog(t, 2.45, T_HIT - 0.01))            # the tip flares up just before it hits
        ana_flare(frame, tipq[0], tipq[1], fl)

    draw_tape(frame, t, ease_out_cubic(prog(t, 0.25, 0.6)) * (1.0 - smooth(prog(t, T_ZING + 0.08, 1.55))))
    if B is not None and rr_k > 0:
        range_label(frame, t, rr_k, B[5])

    frame = qbloom(frame, 215, 4.5, 0.25)
    if t < T_WHIP:
        frame = whip_in(frame, t)
    return np.clip(frame, 0, 255, out=frame)


@lru_cache(maxsize=2)
def _ana(length):
    xs = np.linspace(-1, 1, 2 * length).astype(np.float32)
    px = np.exp(-np.abs(xs) * 3.2) * 0.8 + np.exp(-np.abs(xs) * 16) * 0.8
    ys = np.arange(-20, 21, dtype=np.float32)
    py = np.exp(-(ys / 1.3) ** 2) + 0.2 * np.exp(-(ys / 7) ** 2)
    prof = py[:, None] * px[None, :]
    lay = prof[..., None] * (ADD_G * 0.55 + WHITE * 0.25)
    return np.dstack([lay, np.ones(prof.shape, np.float32)]).astype(np.float32)


def ana_flare(frame, x, y, amt):
    if amt > 0.01:
        over(frame, _ana(W), x - W, y - 20, amt, "add")


def range_ring_k(t):
    return ease_out_cubic(prog(t, 1.75, 1.95))


LBL_X, LBL_Y = 1436, 452                            # countdown block: right third, clear of the bullet


def _ring_R(t, k):
    return 150.0 + 26.0 * (1 - k) + 40.0 * smooth(prog(t, 2.0, 2.45))


def range_ring(frame, t, k, centre):
    """Lock-on tick ring round the incoming tip (drawn behind the bullet, so it
    reads as a bracket on the open side) + leader line to the countdown."""
    R = _ring_R(t, k)
    cx, cy = float(centre[0]), float(centre[1])
    x0 = int(max(cx - R - 24, 0)); x1 = int(min(cx + R + 24, W))
    y0 = int(max(cy - R - 24, 0)); y1 = int(min(cy + R + 24, H))
    if x1 - x0 > 4 and y1 - y0 > 4:
        lay = np.zeros((y1 - y0, x1 - x0), np.float32)
        rot = t * 1.4
        for i in range(72):
            a = rot + i / 72 * 2 * math.pi
            L = 18 if i % 6 == 0 else 8
            p0 = (cx - x0 + R * math.cos(a), cy - y0 + R * math.sin(a))
            p1 = (cx - x0 + (R + L) * math.cos(a), cy - y0 + (R + L) * math.sin(a))
            cv2.line(lay, (int(p0[0] * 16), int(p0[1] * 16)), (int(p1[0] * 16), int(p1[1] * 16)), 1.0,
                     2 if i % 6 == 0 else 1, cv2.LINE_AA, 4)
        reg = frame[y0:y1, x0:x1]
        reg += (GREEN - reg) * (lay * 0.8 * k)[..., None]


def range_label(frame, t, k, centre):
    """Countdown to impact (PT-BR decimal comma) on the empty right third, wired
    to the lock ring by a leader line; gone before the hit."""
    k = k * (1.0 - prog(t, 2.49, 2.56))
    if k <= 0.01:
        return
    rem = max(0.0, (T_HIT - t) / (T_HIT - 1.75))
    v = int(round(rem * 412))
    R = _ring_R(t, range_ring_k(t))
    cx, cy = float(centre[0]), float(centre[1])
    slide = 46.0 * (1 - ease_out_cubic(prog(t, 1.75, 2.0)))
    lx, ly = LBL_X + slide, LBL_Y
    cap = label_layer("IMPACTO EM", "oswald", 30, "bone", 8)
    lab = label_layer(f"0,{v:03d} M", "stencil", 84, "green")
    # leader: ring (up-right) -> elbow -> label bar
    a = math.radians(-32)
    px, py = cx + (R + 22) * math.cos(a), cy + (R + 22) * math.sin(a)
    ex, ey = lx - 26, ly + 22
    lay_k = ease_out_cubic(prog(t, 1.8, 2.02)) * k
    if lay_k > 0.01:
        mx = px + (ex - px) * lay_k
        cv2.line(frame, (int(px * 16), int(py * 16)), (int(mx * 16), int(py * 16)),
                 tuple(float(c) * 0.75 * k for c in GREEN), 2, cv2.LINE_AA, 4)
        if lay_k > 0.98:
            cv2.line(frame, (int(ex * 16), int(py * 16)), (int(ex * 16), int(ey * 16)),
                     tuple(float(c) * 0.75 * k for c in GREEN), 2, cv2.LINE_AA, 4)
        cv2.circle(frame, (int(px * 16), int(py * 16)), 4 * 16, tuple(float(c) * k for c in GREEN), -1, cv2.LINE_AA, 4)
    # vertical bar left of the block
    bh = int(30 + lab.shape[0] + 8)
    bx = int(lx - 12)
    frame[int(ly):int(ly) + bh, bx:bx + 4] += (GREEN - frame[int(ly):int(ly) + bh, bx:bx + 4]) * (0.9 * k)
    over(frame, cap, lx, ly - 2, 0.85 * k)
    over(frame, lab, lx - 6, ly + 34, k)


def impact(frame, t):
    dt = t - F_HIT / FPS
    fi = int(round(t * FPS)) - F_HIT                     # 0 = the white flash frame
    settle = smooth(prog(t, 2.8, DUR - 1 / FPS))
    neg = {1: 1.0, 2: 0.4, 3: 0.12}.get(fi, 0.0)        # "negative" beat: black glass, blazing cracks
    # behind the glass: the void (dimmed, hot core dying), relaxing into scene 3's opening plate
    frame *= 0.6
    if neg > 0:
        frame += (INK * 0.5 - frame) * (0.92 * neg)
    if settle > 0:
        frame += (s3_plate() - frame) * settle
    frame += _core_glow() * ((0.9 * math.exp(-dt * 7) + 0.12) * (1 - settle) * (1 - 0.85 * neg))
    rk = 1.3 * math.exp(-dt * 9) * (1 - smooth(prog(t, 2.74, 2.85))) * (1 - 0.65 * neg)
    if rk > 0.01:                                       # shards of green light: radial rays through the cracks
        frame += _rays() * rk
    cm = crack_maps()
    kr = clamp(ease_out_expo(prog(dt, -0.01, 0.2))) * (1 - smooth(prog(t, 2.7, 2.86)))
    if kr > 0.02:                                       # each shard refracts the background differently
        X, Y = _grid()
        frame = cv2.remap(frame, X + cm["refx"] * kr, Y + cm["refy"] * kr, cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REFLECT)
    frame, vis = crack_pass(frame, t, neg)
    if fi <= 0:                                          # frame 80: full white-green flash
        frame = flash(frame, 1.0, MINT * 0.4 + WHITE * 0.6)
    elif fi == 1:                                        # negative beat: only a tight hot core
        frame += _radial_flash(110.0) * 0.9
    else:                                                # then additive + radial: corners stay INK
        fl = 0.55 * math.exp(-(dt - 2 / FPS) * 15) * (1 - settle)
        if fl > 0.002:
            frame += _radial_flash(430.0) * fl
    frame = qbloom(frame, 170, 3.5, (0.45 * math.exp(-dt * 4) + 0.15) * (1 - settle))
    sx, sy, sa = shake(t, amp=46, freq=34, seed=9, decay_from=F_HIT / FPS, decay=9.0)
    fade = 1 - smooth(prog(t, 2.83, 2.95))
    # land on scene 3's opening camera (its hand-held drift at t=0) so frame 89 == s3 frame 0
    hx, hy, hc = shake(0.0, 1.6, 1.7, seed=9)
    sx, sy, sa = sx * fade + hx * (1 - fade), sy * fade + hy * (1 - fade), sa * 1.5 * fade + hc * 3 * (1 - fade)
    M = cv2.getRotationMatrix2D((W / 2, H / 2), sa, 1.0 + 0.05 * math.exp(-dt * 10) * fade)
    M[0, 2] += sx
    M[1, 2] += sy
    frame = cv2.warpAffine(frame, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    return frame


_S3_HAZE_C = np.array([64, 80, 56], np.float32)


@lru_cache(maxsize=1)
def s3_plate():
    """Scene 3's opening plate (mirrors s3_slam _bg + _haze + _halftone_corners at
    t=0, k=0.45, opacity 0.30). s2 relaxes into it so the cut is invisible."""
    n = value_noise(W, H, 260, 6, 31)
    fn = value_noise(W, H, 4, 2, 32)
    f = np.empty((H, W, 3), np.float32)
    f[:] = INK
    f += ((n - 0.5) * 10 + (fn - 0.5) * 5)[..., None]
    fld = smoke_field(W // 2, H // 2, 3)
    hw, hh = W // 2, H // 2
    ox, oy = int((3.0 * 13) % hw), int((3.0 * -3.5) % hh)
    crop = np.roll(np.roll(fld, -oy, 0), -ox, 1)[:hh, :hw]
    a = cv2.resize(np.clip((crop - 0.45) * 2.2, 0, 1) * 0.09, (W, H), interpolation=cv2.INTER_LINEAR)
    f += (_S3_HAZE_C - f) * a[..., None]
    cw, ch, cell = 980, 700, 14
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    an = math.radians(45)
    u = xx * math.cos(an) + yy * math.sin(an)
    v = -xx * math.sin(an) + yy * math.cos(an)
    fu = (u / cell) % 1 - 0.5
    fv = (v / cell) % 1 - 0.5
    d = np.sqrt(fu * fu + fv * fv).astype(np.float32)
    nz = value_noise(cw, ch, 110, 3, 41)
    g = 1 - np.clip(np.hypot(xx / cw, yy / ch) * 1.05, 0, 1)
    g = (np.clip(g * (0.6 + 0.7 * nz), 0, 1) ** 1.35).astype(np.float32)
    m = np.clip((np.minimum(g * (0.62 * 0.45), 0.52) - d) * cell * 0.9 + 0.5, 0, 1) * (g > 0.01) * 0.30
    tl = f[:ch, :cw]
    tl += (BONE - tl) * m[..., None]
    br = f[H - ch:, W - cw:]
    br += (BONE - br) * (m[::-1, ::-1] * 0.8)[..., None]
    return f


@lru_cache(maxsize=2)
def _radial_flash(rad):
    yy, xx = np.mgrid[0:H // 4, 0:W // 4].astype(np.float32) * 4 + 2
    r = np.hypot(xx - CRACK_C[0], yy - CRACK_C[1])
    m = cv2.resize(np.exp(-r / rad), (W, H), interpolation=cv2.INTER_LINEAR)
    return (m[..., None] * MINT).astype(np.float32)


@lru_cache(maxsize=1)
def _core_glow():
    yy, xx = np.mgrid[0:H // 4, 0:W // 4].astype(np.float32) * 4 + 2
    core = np.exp(-(((xx - CRACK_C[0]) / 260) ** 2 + ((yy - CRACK_C[1]) / 220) ** 2))
    core = cv2.resize(core, (W, H), interpolation=cv2.INTER_LINEAR)
    return (core[..., None] * ADD_G).astype(np.float32)


@lru_cache(maxsize=1)
def _rays():
    """Radial light shafts from the crack origin: 1D angular profile mapped over the frame."""
    rng = np.random.default_rng(81)
    na = 4096
    th = np.linspace(-math.pi, math.pi, na, endpoint=False)
    prof = np.zeros(na, np.float64)
    for _ in range(14):
        a0 = rng.uniform(-math.pi, math.pi)
        wd = rng.uniform(0.006, 0.03)
        da = (th - a0 + math.pi) % (2 * math.pi) - math.pi
        prof += np.exp(-(da / wd) ** 2) * rng.uniform(0.4, 1.0)
    prof = prof.astype(np.float32)
    yy, xx = np.mgrid[0:H // 2, 0:W // 2].astype(np.float32) * 2 + 1
    ang = np.arctan2(yy - CRACK_C[1], xx - CRACK_C[0])
    rr = np.hypot(xx - CRACK_C[0], yy - CRACK_C[1])
    idx = ((ang + math.pi) * (na / (2 * math.pi))).astype(np.int32) % na
    acc = prof[idx] * np.exp(-rr / 700) * np.clip(rr / 60, 0, 1)
    acc = cv2.resize(acc, (W, H), interpolation=cv2.INTER_CUBIC)
    return (np.clip(acc, 0, None)[..., None] * ADD_G * 0.9).astype(np.float32)
