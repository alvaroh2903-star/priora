"""Scene 6 · s6_final (7.5 s) — hero end card: ARMY wordmark assembly, idle hold, collapse to black.

Beat sheet (local seconds):
  0.00  black (hard cut from scene 5); the worn concrete wall, halftone corners,
        green-tinted smoke and the thin green floor line fade/draw in
  0.20  WHOOSH: the bullet tears in from the left (already entering frame,
        near-linear, full-width speed streaks + heavy motion smear, lighting
        the wall as it passes), brakes hard and parks at 0.40 with a one-frame
        hot pulse + camera kick; the streaks retract into the logo's three
        motion streaks
  0.60  IMPACT + SUB DROP: the "A" slams down around the bullet (2 frames,
        scale ~2.5 -> 1.0, solid white-hot core with a radial zoom smear and a
        dark contact shadow, hard stop), radial impact light + contrast punch,
        a pressure wave rakes across the concrete (thin grain-lit ring + 4-frame
        radial refraction of the wall), green-hot cracks spread behind it, bone
        dust puffs + streaking chips off the baseline, decaying shake, a worn
        spray splatter (overspray halo) bursts out (bottom-left)
  0.80 / 1.00 / 1.20  R, M, Y slam in the same way (each its own tilt, crack,
        dust; small splat at 0.8, mid-right splat at 1.2); after the Y the
        whole mark gets a green glow pulse
  1.80  tagline "SKILL IS THE ONLY ADVANTAGE" rises word by word out of a mask
        line under the logo, flanking green rules draw out, ONLY in green
  2.20  SPRAY: a green graffiti star sprays on at top-right in one hand-drawn
        stroke (live nozzle mist), "ARMY" is written inside, paint drips run
  2.55  a green sniper reticle (short arms, full alpha, light motion blur)
        sweeps in from off-screen lower right (clear of the star tag being
        written), rises across Y-M-R on a spline and
        locks onto the bullet at 3.18 (ring tightens, arms snap out to full
        length, ping ring), holds framing the A icon (its lower arm/arcs fade
        above the tagline, whose left rule dims to ~38%), then expands and fades
        (3.85-4.35)
  3.00  HUD: "CONECTANDO AO SERVIDOR" types on at the bottom, progress bar +
        percentage fill with realistic stalls
  3.0-6.8  living hold: slow push-in with background parallax, glow breathing,
        smoke drifting behind and in front, motes, drips finishing, a glint
        sweep over the logo (also one at 1.3 when the mark locks), a light
        pulse running along the floor line, two one-frame micro-glitches
        (4.53 wordmark mid-band, 5.77 HUD row)
  6.80  GLITCH burst
  6.93-7.42  CRT-style collapse: picture squashes (luminance boosted, crisp hot
        core line from the first frame) into a hot green line, the
        line shrinks to a point and dies -> pure INK black for the loop

The wordmark is vector geometry traced from the brand sheet (A/R/M/Y polygons
in brand-sheet pixel units, bullet contours from the logo asset) rasterised
every frame with 4x supersampling directly in screen space, so it stays razor
sharp through slams, shake and push-in.
"""
from lib import *

DUR = 7.5
CUES = [(0.2, "whoosh"), (0.6, "impact"), (0.6, "sub_drop"), (0.8, "impact"), (1.0, "impact"),
        (1.2, "impact"), (2.2, "spray"), (6.8, "glitch")]

DT = 1.0 / FPS
T_BIN, T_BLAND = 0.20, 0.40          # bullet flight
SLAMS = (("A", 0.6, 4.0, 20.0, 1.0), ("R", 0.8, -3.0, 11.0, 0.7),
         ("M", 1.0, 2.5, 12.0, 0.75), ("Y", 1.2, -4.5, 16.0, 0.95))
T_SLAM = {s[0]: s[1] for s in SLAMS}
DROP = 0.08                          # letter drop: 2 frames before each slam
SHUT = 1.0                           # zoom-smear shutter (frames)
T_TAG = 1.8
T_SPRAY = 2.2
T_RET0, T_RETLOCK, T_RETOUT = 2.55, 3.18, 3.85
T_HUD = 3.0
T_GL = 6.8
T_COL = 6.93
T_BLACK = 7.42

# ---------------------------------------------------------------- layout (world = layout px)
SS = 4                                   # supersampling for vector raster
S = 1.10                                 # world px per logo unit
AX = 980.0                               # vertical axis of the lockup
LCU = np.array([570.0, 120.0], np.float32)   # letters centre (logo units)
LCS = np.array([AX, 468.0], np.float32)      # where it sits in the world
CAM_PIV = (AX, 505.0)

# letters, brand-sheet pixel units (A top-left = 0,0; cap height 240)
A_POLY = np.array([(0, 240), (0, 80), (80, 0), (180, 0), (260, 80), (260, 240), (200, 240),
                   (200, 90), (158, 56), (102, 56), (60, 90), (60, 240)], np.float32)
R_OUT = np.array([(316, 0), (500, 0), (536, 36), (536, 112), (508, 141), (544, 240), (484, 240),
                  (452, 152), (372, 152), (372, 240), (316, 240)], np.float32)
R_HOLE = np.array([(372, 52), (476, 52), (480, 56), (480, 96), (476, 100), (372, 100)], np.float32)
M_POLY = np.array([(568, 28), (596, 0), (648, 0), (718, 83), (788, 0), (840, 0), (868, 28), (868, 240),
                   (812, 240), (812, 93), (740, 176), (696, 176), (624, 93), (624, 240), (568, 240)], np.float32)
Y_POLY = np.array([(900, 0), (964, 0), (1019.5, 75), (1076, 0), (1140, 0), (1140, 8), (1048, 124),
                   (1048, 240), (992, 240), (992, 124)], np.float32)
LETTERS = {"A": [A_POLY], "R": [R_OUT, R_HOLE], "M": [M_POLY], "Y": [Y_POLY]}
L_CEN = {"A": (130.0, 120.0), "R": (430.0, 120.0), "M": (718.0, 120.0), "Y": (1020.0, 120.0)}
L_SPAN = {"A": (0, 260), "R": (316, 544), "M": (568, 868), "Y": (900, 1140)}

B_CENTER = np.array([148.0, 149.5], np.float32)
B_TIP = np.array([287.0, 149.5], np.float32)
# motion streaks (logo units, relative to the parked bullet): y, half-thickness at base, rest length
STREAKS = ((120.0, 4.3, 123.0, 1.0), (150.0, 4.2, 237.0, 1.0), (180.0, 4.3, 96.0, 0.85))
ST_BASE = 6.0

C_OUT = np.array([10, 11, 12], np.float32)
C_HL = np.array([214, 245, 180], np.float32)
ADD_G = np.array([105, 235, 78], np.float32)       # additive light tint (saturates to mint, never yellow)
DUST_C = np.array([160, 158, 150], np.float32)
TAG_C = np.array([232, 233, 228], np.float32)


def U2W(p):
    return LCS + S * (np.asarray(p, np.float32) - LCU)


def _m3(M2):
    return np.vstack([np.asarray(M2, np.float64), [0, 0, 1]])


def mat_units():
    return np.array([[S, 0, LCS[0] - S * LCU[0]], [0, S, LCS[1] - S * LCU[1]], [0, 0, 1]], np.float64)


def mat_about(cx, cy, s, ang, dx=0.0, dy=0.0):
    M = cv2.getRotationMatrix2D((float(cx), float(cy)), ang, s)
    M[0, 2] += dx
    M[1, 2] += dy
    return _m3(M)


def xf(M, pts):
    M = np.asarray(M, np.float64)
    return (np.asarray(pts, np.float64) @ M[:2, :2].T + M[:2, 2]).astype(np.float32)


def bbox_of(pts_list, pad=4):
    allp = np.concatenate(pts_list, 0)
    return (int(math.floor(allp[:, 0].min())) - pad, int(math.floor(allp[:, 1].min())) - pad,
            int(math.ceil(allp[:, 0].max())) + pad, int(math.ceil(allp[:, 1].max())) + pad)


def clipbox(b):
    x0, y0, x1, y1 = b
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W), min(y1, H)
    if x1 <= x0 + 1 or y1 <= y0 + 1:
        return None
    return x0, y0, x1, y1


def raster(polys, x0, y0, w, h, ss=SS):
    """Coverage (h, w) of screen-space polygons (even-odd) inside box."""
    can = np.zeros((h * ss, w * ss), np.uint8)
    pts = [np.round(((q - np.array([x0, y0], np.float32)) * ss - 0.5) * 16).astype(np.int32) for q in polys]
    cv2.fillPoly(can, pts, 255, cv2.LINE_8, 4)
    return cv2.resize(can, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) * (1 / 255.0)


def _col(c):
    return tuple(float(v) for v in c)


# ---------------------------------------------------------------- bullet shapes (traced from the asset)
def _trace(mask, up=8, sigma=0.75, eps=0.25):
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
    al[:, :8] = False
    cols = B[..., :3]
    casing = al & (np.abs(cols - GREEN_DK).sum(-1) < 40)
    proj = al & ((np.abs(cols - np.array([155, 227, 75], np.float32)).sum(-1) < 60) | (cols[..., 0] > 170))
    off = np.array([1.0, 113.0], np.float32)
    return {"sil": _trace(al) + off, "casing": _trace(casing, sigma=0.6) + off,
            "proj": _trace(proj, sigma=0.6) + off, "hl": _capsule(111.5, 190.5, 21.0, 2.9) + off}


# ---------------------------------------------------------------- motion
B_DIST = 600.0                         # start offset (logo units): the tip is at the frame edge at T_BIN
B_LIN = 0.8                            # fraction of the flight at constant speed, then a hard brake
B_TRAIL = 900.0                        # streak length while in flight (logo units)
FR_BLAND = int(round(T_BLAND * FPS))


def bullet_dx(t):
    """Bullet x offset in logo units (0 = parked in the A). Near-linear approach
    (extrapolated before T_BIN so trails/velocity are continuous), hard brake,
    tiny overshoot wobble."""
    p = (t - T_BIN) / (T_BLAND - T_BIN)
    if p < B_LIN:
        x = -B_DIST * (1 - p / B_LIN * 0.93)
    elif p < 1:
        q = (p - B_LIN) / (1 - B_LIN)
        x = -0.07 * B_DIST * (1 - q) ** 2
    else:
        x = 0.0
    if t > T_BLAND:
        d = t - T_BLAND
        x += 5.0 * math.sin(d * 38) * math.exp(-d * 14)
    sl = t - T_SLAM["A"]
    if sl >= 0:                       # the A slamming around it jolts it
        x += -3.0 * math.sin(sl * 55) * math.exp(-sl * 16)
    return x


def letter_pose(L, tau, extrap=False):
    """(scale, angle, dy, alpha) of a letter at time tau, or None if not in yet.
    The drop is a 2-frame accelerating zoom from ~2.6x to 1.0 (always opaque).
    extrap=True extends the pose before the drop start (for zoom-smear samples)."""
    t0 = T_SLAM[L]
    a0 = {s[0]: s[2] for s in SLAMS}[L]
    if tau < t0 - DROP and not extrap:
        return None
    if tau < t0:
        p = max((tau - (t0 - DROP)) / DROP, -0.6)
        e = math.copysign(abs(p) ** 1.6, p)
        return 1 + 1.6 * (1 - e), a0 * (1 - e), -40 * (1 - e), 1.0
    d = tau - t0
    return 1 - 0.032 * math.exp(-d * 15) * math.cos(d * 40), 0.0, 0.0, 1.0


def slam_k(t, rate=8.0):
    """Sum of decaying slam envelopes weighted by each slam's flash weight."""
    k = 0.0
    for L, t0, a0, amp, wgt in SLAMS:
        if t >= t0:
            k += wgt * math.exp(-(t - t0) * rate)
    return k


def camera(t, layer=1.0):
    """World -> screen matrix. layer < 1 = further back (less push-in / drift: parallax)."""
    u = prog(t, 0.0, T_COL)
    z = 1.0 + 0.042 * layer * (0.35 * u + 0.65 * ease_in_out(u))
    dx = (3.0 * math.sin(t * 0.8 + 0.4) + 1.2 * math.sin(t * 2.1)) * layer
    dy = (2.0 * math.sin(t * 0.6 + 1.9) + 0.8 * math.sin(t * 1.7 + 0.3)) * layer
    ang = 0.0
    for i, (L, t0, a0, amp, wgt) in enumerate(SLAMS):
        if t >= t0:
            sx, sy, sa = shake(t, amp=amp, freq=34, seed=i + 2, decay_from=t0, decay=9.5)
            dx += sx
            dy += sy
            ang += sa
            z += 0.016 * wgt * math.exp(-(t - t0) * 11)
    if fr_in(t, (int(round(T_GL * FPS)), int(round(T_GL * FPS)) + 2)):
        dx += 14
    fb = int(round(t * FPS)) - FR_BLAND          # bullet parks: 1-frame kick
    if fb == 0:
        dx += 5.0 * layer
        dy += 1.5 * layer
    elif fb == 1:
        dx -= 2.0 * layer
    M = cv2.getRotationMatrix2D(CAM_PIV, ang, z)
    M[0, 2] += dx
    M[1, 2] += dy
    return _m3(M), z


def fr_in(t, frs):
    return int(round(t * FPS)) in frs


def glow_level(t, pulses=True):
    """Green backlight level behind the mark."""
    k = 0.45 * ease_out_cubic(prog(t, 0.28, 0.6))
    k += 0.55 * ease_out_cubic(prog(t, 0.6, 1.4))
    if pulses:
        k += 0.3 * slam_k(t, 12.0)
        k += 0.2 * math.exp(-((t - 1.42) / 0.2) ** 2)                   # pulse after the Y
    if t > 1.6:
        k *= 1 + 0.09 * math.sin((t - 1.6) * 2 * math.pi / 2.3)       # breathing
    return k


def logo_pulse(t):
    """Extra green glow on the letters: assembly pulse after the Y + idle breathing."""
    k = 0.6 * math.exp(-((t - 1.42) / 0.17) ** 2)
    if t > 1.6:
        k += 0.025 * (1 + math.sin((t - 1.6) * 2 * math.pi / 2.3))
    return k


# ---------------------------------------------------------------- background (world)
# long concrete crack runs (waypoints, world px): lower-left and lower-right, routed around the HUD
CRACK_RUNS = (((-12, 712), (180, 760), (330, 818), (470, 880), (560, 960), (612, 1092)),
              ((1932, 742), (1780, 800), (1640, 868), (1500, 930), (1400, 1000), (1330, 1092)),
              ((-12, 640), (90, 668), (175, 708)))


def _jag_line(img, pts, w):
    p = np.round(np.asarray(pts, np.float64) * 16).astype(np.int32)
    for a, b in zip(p[:-1], p[1:]):
        cv2.line(img, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), 1.0, int(w), cv2.LINE_AA, 4)


@lru_cache(maxsize=1)
def crack_runs():
    """Static hairline crack runs: a jagged random walk through each waypoint chain, with short side branches."""
    img = np.zeros((H, W), np.float32)
    rng = np.random.default_rng(88)
    for ri, wp in enumerate(CRACK_RUNS):
        pts = [np.array(wp[0], np.float64)]
        for a, b in zip(wp[:-1], wp[1:]):
            a, b = np.array(a, np.float64), np.array(b, np.float64)
            n = max(3, int(np.linalg.norm(b - a) / 11))
            for k in range(1, n + 1):
                q = a + (b - a) * k / n
                if k < n:
                    d = b - a
                    nrm = np.array([-d[1], d[0]]) / (np.linalg.norm(d) + 1e-6)
                    q = q + nrm * rng.normal(0, 3.2)
                pts.append(q)
        pts = np.array(pts)
        main_w = 2 if ri < 2 else 1
        # main run: 2 px in the middle stretch, 1 px toward the ends
        m = len(pts)
        i0, i1 = int(m * 0.18), int(m * 0.7)
        _jag_line(img, pts[:i0 + 1], 1)
        _jag_line(img, pts[i0:i1 + 1], main_w)
        _jag_line(img, pts[i1:], 1)
        # side branches
        for i in range(2, m - 2):
            if rng.random() < 0.13:
                d = pts[i + 1] - pts[i - 1]
                ang = math.atan2(d[1], d[0]) + rng.choice([-1, 1]) * rng.uniform(0.6, 1.25)
                bp = [pts[i].copy()]
                seg = rng.uniform(7, 13)
                for _ in range(int(rng.integers(3, 8))):
                    ang += rng.normal(0, 0.35)
                    bp.append(bp[-1] + seg * np.array([math.cos(ang), math.sin(ang)]))
                _jag_line(img, bp, 1)
    return np.clip(img, 0, 1)


@lru_cache(maxsize=1)
def crack_run_fade():
    """Intensity variation along the runs so they break up like real hairlines."""
    n = value_noise(W, H, 90, 2, 89)
    return (0.25 + 0.75 * np.clip((n - 0.25) * 2.2, 0, 1)).astype(np.float32)


@lru_cache(maxsize=1)
def wall():
    n = value_noise(W, H, 320, 3, 61)
    mid = value_noise(W, H, 40, 3, 62)
    fine = value_noise(W, H, 3, 1, 63)
    g = grunge(W, H, 64)
    rng = np.random.default_rng(65)
    pits = cv2.GaussianBlur((rng.random((H, W), dtype=np.float32) > 0.992).astype(np.float32), (0, 0), 1.1) * 2.5
    tex = (0.62 + 0.2 * n + 0.12 * mid + 0.16 * fine) * (0.7 + 0.3 * g) * (1 - np.clip(pits, 0, 0.8))
    # a few old cracks + scrapes (bone, very faint) like the key art
    cr = np.maximum(crack_mask(W, H, 1760, 1060, seed=66, branches=5, thickness=2),
                    crack_mask(W, H, 90, 40, seed=67, branches=5, thickness=1))
    cr = cv2.GaussianBlur(cr, (0, 0), 0.6)
    # long static concrete crack runs through the lower third (like the key art), bone, faint,
    # with a 1 px dark lip under them so they read as cut into the wall
    runs = crack_runs()
    lip = np.zeros_like(runs)
    lip[1:, 1:] = runs[:-1, :-1]
    tex = tex * (1 - 0.5 * cr) * (1 - 0.55 * np.clip(lip - runs, 0, 1))
    base = INK * (0.78 + 0.26 * tex)[..., None]
    base += (cr * 0.10)[..., None] * BONE
    base += (runs * crack_run_fade())[..., None] * (BONE * 0.3)
    # fine bone print speckle / dust on the wall (worn concrete, not fog)
    sp = np.clip((value_noise(W, H, 2, 1, 68) - 0.86) * 9, 0, 1) * np.clip((value_noise(W, H, 60, 2, 69) - 0.35) * 3, 0, 1)
    base += (sp * 0.05)[..., None] * BONE
    yy, xx = [a.astype(np.float32) * 4 + 2 for a in np.ogrid[0:H // 4, 0:W // 4]]
    bc = U2W(B_CENTER)
    sg = (np.exp(-(((xx - AX) / 700) ** 2 + ((yy - 470) / 215) ** 2)) * 0.55
          + np.exp(-(((xx - bc[0]) / 300) ** 2 + ((yy - bc[1]) / 160) ** 2)) * 0.55
          + 0.10 * np.exp(-(((xx - AX) / 1200) ** 2 + ((yy - 500) / 560) ** 2))).astype(np.float32)
    sg = cv2.resize(sg, (W, H), interpolation=cv2.INTER_LINEAR)
    SG = (cv2.pow(np.clip(tex, 0, None).astype(np.float32), 1.7) * sg)[..., None] * (np.array([30, 66, 14], np.float32) * 0.6)
    D = (base - INK).astype(np.float32)
    tex4 = cv2.resize(tex, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    return D, base.astype(np.float32), SG.astype(np.float32), tex4.astype(np.float32)


@lru_cache(maxsize=1)
def ht_maps():
    cw, ch, cell = 1100, 720, 15.0
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    a = math.radians(45)
    u = xx * math.cos(a) + yy * math.sin(a)
    v = -xx * math.sin(a) + yy * math.cos(a)
    fu = (u / cell) % 1 - 0.5
    fv = (v / cell) % 1 - 0.5
    d = np.sqrt(fu * fu + fv * fv).astype(np.float32)
    nz = value_noise(cw, ch, 120, 3, 71)
    g = 1 - np.clip(np.hypot(xx / cw, yy / ch) * 1.02, 0, 1)
    g = np.clip(g * (0.55 + 0.75 * nz), 0, 1) ** 1.3
    br = grunge(cw, ch, 72)
    return d, g.astype(np.float32), br, cell


HT_CORNERS = ((False, False, 1.0), (True, True, 0.95), (True, False, 0.75), (False, True, 0.7))


@lru_cache(maxsize=20)
def ht_masks(kq):
    """Halftone corner masks (uint8) for dot-size level kq/50."""
    d, g, br, cell = ht_maps()
    k = kq / 50.0
    out = []
    for (fx, fy, s) in HT_CORNERS:
        gg = g
        if fx:
            gg = gg[:, ::-1]
        if fy:
            gg = gg[::-1]
        m = np.clip((np.minimum(gg * (0.62 * k * s), 0.5) - d) * cell * 0.9 + 0.5, 0, 1) * br
        out.append(np.round(m * 255).astype(np.uint8))
    return out


def halftone_corners(f, k, op):
    d = ht_maps()[0]
    ch, cw = d.shape
    for (fx, fy, s), m in zip(HT_CORNERS, ht_masks(int(round(k * 50)))):
        y0 = H - ch if fy else 0
        x0 = W - cw if fx else 0
        sub = f[y0:y0 + ch, x0:x0 + cw]
        sub += (BONE - sub) * (m * np.float32(op / 255.0))[..., None]


@lru_cache(maxsize=1)
def smoke_maps():
    w4, h4 = W // 4, H // 4
    f1 = value_noise(w4 * 2, h4 * 2, 100, 5, 81)
    f2 = value_noise(w4 * 2, h4 * 2, 60, 4, 82)
    yy, xx = np.mgrid[0:h4, 0:w4].astype(np.float32)
    shape = (0.35 + 0.65 * np.exp(-(((xx - AX / 4) / 300) ** 2 + ((yy - 120) / 110) ** 2))
             + 0.35 * np.clip((yy - h4 * 0.55) / (h4 * 0.45), 0, 1))
    return f1.astype(np.float32), f2.astype(np.float32), shape.astype(np.float32)


def _scroll(f, ox, oy, w, h):
    M = np.float32([[1, 0, ox], [0, 1, oy]])
    return cv2.warpAffine(f, M, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_WRAP)


def smoke_density(t):
    f1, f2, shape = smoke_maps()
    h4, w4 = shape.shape
    a = _scroll(f1, 60 + t * 16, 30 + t * 4, w4, h4)
    b = _scroll(f2, 140 - t * 9, 80 - t * 3, w4, h4)
    return np.clip((a * 0.6 + b * 0.4 - 0.40) * 2.6, 0, 1) * shape


def fg_haze_q(t, k):
    """Thin drifting smoke in front of everything: quarter-res additive light (merged into the bloom pass)."""
    f1, f2, shape = smoke_maps()
    h4, w4 = shape.shape
    a = _scroll(f2, 300 + t * 26, 40 - t * 6, w4, h4)
    b = _scroll(f1, 500 - t * 14, 200 + t * 5, w4, h4)
    d = np.clip((a * 0.55 + b * 0.45 - 0.47) * 3.0, 0, 1) * (0.4 + 0.6 * shape) * (0.085 * k)
    return d[..., None] * np.array([56, 66, 52], np.float32)


# ---------------------------------------------------------------- spray splatters (world)
# (cx, cy, w, h, seed, t0, op): asymmetric — a big burst bleeding off the bottom-left edge (A slam),
# a small satellite splat beside it (R slam), one mid-right partly off-frame (Y slam). The star tag
# anchors the top, so the top corners stay clean.
SPLATS = ((110, 968, 480, 430, 5, 0.6, 0.85), (430, 902, 200, 180, 17, 0.8, 0.85),
          (1880, 700, 420, 380, 7, 1.2, 0.85))
SPLAT_NDRIP = (3, 1, 4)              # the small satellite gets a single tapered, wobbly run


@lru_cache(maxsize=4)
def splat_geom(i):
    """Spray burst elements (relative to the splat centre): lumpy core, spikes, satellites, mist, drips."""
    cx, cy, w, h, seed, t0, op = SPLATS[i]
    rng = np.random.default_rng(seed)
    R = 0.17 * min(w, h)
    core = [(rng.uniform(0, 2 * math.pi), abs(rng.normal(0, 0.42)) * R, R * rng.uniform(0.22, 0.55)) for _ in range(26)]
    spikes = [(rng.uniform(0, 2 * math.pi), R * rng.uniform(1.0, 2.1), R * rng.uniform(0.10, 0.2)) for _ in range(9)]
    sats = []
    for _ in range(190):
        a = rng.uniform(0, 2 * math.pi)
        d = R * (0.9 + rng.exponential(0.85))
        r = R * 0.13 * math.exp(-(d / R - 0.9) * 0.9) * rng.uniform(0.25, 1.1)
        sats.append((a, d, r, rng.random() < 0.3))
    nm = int(w * h * 0.0042)                     # speckle mist: 2D density ~ exp(-2 rr)
    mist = (rng.uniform(0, 2 * math.pi, nm), rng.gamma(2.0, 0.5, nm) * 0.98, rng.uniform(0.45, 1.5, nm),
            rng.uniform(0.55, 1.0, nm))
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    rr = np.hypot((xx - w / 2) / (w * 0.5), (yy - h / 2) / (h * 0.5)).astype(np.float32)
    # worn paint: strong grunge so the concrete shows through, plus thinner (patchy) coverage in places
    tex = ((0.35 + 0.65 * grunge(w, h, seed + 30)) * (0.72 + 0.28 * value_noise(w, h, 30, 3, seed + 4))
           * np.clip((1 - rr) * 6, 0, 1)).astype(np.float32)
    return dict(R=R, core=core, spikes=spikes, sats=sats, mist=mist, tex=tex, rr=rr, rng_seed=seed)


@lru_cache(maxsize=32)
def splat_mask(i, eq):
    """Splat coverage (h, w) with the burst spread e = eq/20 (0: drops still clumped at ~40% radius)."""
    cx, cy, w, h, seed, t0, op = SPLATS[i]
    G = splat_geom(i)
    e = eq / 20.0
    ss = 2
    R = G["R"] * ss
    img = np.zeros((h * ss, w * ss), np.float32)
    c0 = np.array([w * ss / 2, h * ss / 2])

    def disk(p, r, v=1.0):
        cv2.circle(img, (int(p[0] * 16), int(p[1] * 16)), max(8, int(r * 16)), v, -1, cv2.LINE_AA, 4)

    def u(a):
        return np.array([math.cos(a), math.sin(a)])

    kd = 0.4 + 0.6 * e                                    # satellites fly out from ~40% radius
    for a, d, r in G["core"]:
        disk(c0 + d * ss * (0.55 + 0.45 * e) * u(a), r * ss * (0.7 + 0.3 * e))
    for a, L, r0 in G["spikes"]:
        n = 14
        L = L * ss * (0.25 + 0.75 * e)
        for k in range(n):
            q = k / (n - 1)
            disk(c0 + (R * 0.5 + L * q) * u(a), r0 * ss * (1 - 0.75 * q))
        disk(c0 + (R * 0.5 + L * 1.08) * u(a), r0 * ss * 0.55)
    for a, d, r, ell in G["sats"]:
        r = r * ss
        if r * 2 < 1.2:
            continue
        p = c0 + d * ss * kd * u(a)
        if ell:
            el = 2.2 + 1.2 * (1 - e)                       # in-flight drops stretch radially
            cv2.ellipse(img, (int(p[0] * 16), int(p[1] * 16)), (max(8, int(r * el * 16)), max(8, int(r * 0.8 * 16))),
                        math.degrees(a), 0, 360, 1.0, -1, cv2.LINE_AA, 4)
        else:
            disk(p, r)
    img = cv2.GaussianBlur(img, (0, 0), 0.6 * ss)
    nz = value_noise(w * ss, h * ss, 6 * ss, 3, seed + 3)
    img = np.clip((img - 0.5 + (nz - 0.5) * 0.35) * 4 + 0.5, 0, 1)
    m = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
    # fine speckle mist (1x, anti-aliased dots)
    mi = np.zeros((h, w), np.float32)
    ang, rr, rad, br = G["mist"]
    mx = w / 2 + np.cos(ang) * rr * (w * 0.5) * kd
    my = h / 2 + np.sin(ang) * rr * (h * 0.5) * kd
    for k in range(len(ang)):
        cv2.circle(mi, (int(mx[k] * 16), int(my[k] * 16)), max(6, int(rad[k] * 16)), float(br[k]), -1, cv2.LINE_AA, 4)
    m = np.maximum(m, np.clip(mi, 0, 1) * 0.95)
    return (m * G["tex"]).astype(np.float32)


@lru_cache(maxsize=4)
def splat_drips(i):
    cx, cy, w, h, seed, t0, op = SPLATS[i]
    m = splat_mask(i, 20)
    G = splat_geom(i)
    rng = np.random.default_rng(seed + 50)
    drips = []
    for k in range(SPLAT_NDRIP[i]):
        x = w / 2 + rng.normal(0, G["R"] * 0.6)
        col = m[:, int(clamp(x, 0, w - 1))]
        ys = np.nonzero(col > 0.45)[0]
        ys = ys[ys < h * 0.62]
        if len(ys) == 0:
            continue
        L = float(rng.uniform(40, 140)) if SPLAT_NDRIP[i] > 1 else 70.0
        drips.append((float(x), float(ys.max()) - 2, float(rng.uniform(5.0, 9.0)), L,
                      float(t0 + 0.15 + rng.uniform(0, 0.5)), float(rng.uniform(1.6, 2.8))))
    return drips


def draw_drip(dm, x, y, wd, cur, L, ph):
    """One paint drip hanging from (x, y): tapering stem (root width wd -> half at full length L),
    gentle wobble, round bulb at the running end (~1.6x the local stem width)."""
    hh = dm.shape[0]
    yb = min(y + cur, hh - wd - 3)
    if yb <= y - 5:
        return
    n = max(3, int((yb - y + 6) / 3) + 2)
    ys = np.linspace(y - 6, yb, n)
    q = np.clip((ys - y) / max(L, 1.0), 0, 1)
    hw = 0.5 * wd * (1 - 0.58 * q)
    xs = x + (1.6 * np.sin(ys * 0.08 + ph) + 0.8 * np.sin(ys * 0.23 + ph * 2.3)) * np.clip((ys - y) / 12.0, 0, 1)
    poly = np.concatenate([np.stack([xs - hw, ys], 1), np.stack([xs + hw, ys], 1)[::-1]])
    cv2.fillPoly(dm, [np.round(poly * 16).astype(np.int32)], 1.0, cv2.LINE_AA, 4)
    rb = 1.6 * hw[-1] * min(1.0, 0.55 + cur / 40.0)
    cv2.circle(dm, (int(round(xs[-1] * 16)), int(round((yb - rb * 0.25) * 16))), max(8, int(rb * 16)), 1.0, -1, cv2.LINE_AA, 4)


def drip_canvas(shape, drips, t):
    hh, ww = shape
    dm = np.zeros((hh, ww), np.float32)
    for j, (x, y, wd, L, t0, dur) in enumerate(drips):
        if t < t0:
            continue
        p = clamp((t - t0) / dur)
        cur = L * (1 - (1 - p) ** 2.4)
        if cur < 0.5:
            continue
        draw_drip(dm, x, y, wd, cur, L, j * 1.9 + x * 0.013)
    return dm


def draw_splats(f, t):
    for i, (cx, cy, w, h, seed, t0, op) in enumerate(SPLATS):
        if t < t0:
            continue
        p = prog(t, t0 - 0.5 * DT, t0 + 2.5 * DT)        # 3-frame spray burst
        e = 1 - (1 - p) ** 2
        m = splat_mask(i, int(round(e * 20)))
        a = np.maximum(m, drip_canvas(m.shape, splat_drips(i), t))
        hot = math.exp(-(t - t0) * 11)
        x0, y0 = int(cx - w / 2), int(cy - h / 2)
        # soft overspray halo around the core (dim green haze on the concrete), then the paint itself
        blend_at(f, x0, y0, splat_halo(i, int(round(e * 20))) * 0.2, GREEN * 0.5)
        blend_at(f, x0, y0, a * op, GREEN)
        # wet paint sheen: faint additive glow so the green reads saturated, not olive
        add_at(f, x0, y0, splat_glow(i, int(round(e * 20))) * (0.22 + 0.25 * hot), ADD_G)


@lru_cache(maxsize=32)
def splat_halo(i, eq):
    sm = cv2.resize(splat_mask(i, eq), None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    g = cv2.GaussianBlur(sm, (0, 0), 6.0)
    cx, cy, w, h, seed, t0, op = SPLATS[i]
    g = cv2.resize(g, (w, h), interpolation=cv2.INTER_LINEAR)
    rr = splat_geom(i)["rr"]
    return (np.clip(g * 1.7, 0, 1) * np.clip((1 - rr) * 4, 0, 1)).astype(np.float32)


@lru_cache(maxsize=32)
def splat_glow(i, eq):
    sm = cv2.resize(splat_mask(i, eq), None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    g = cv2.GaussianBlur(sm, (0, 0), 3.0)
    cx, cy, w, h, seed, t0, op = SPLATS[i]
    return np.clip(cv2.resize(g, (w, h), interpolation=cv2.INTER_LINEAR), 0, 1).astype(np.float32)


def add_at(f, x0, y0, a, col):
    """Additively add colour * a (h, w) with top-left (x0, y0); clipped."""
    h, w = a.shape
    cb = clipbox((x0, y0, x0 + w, y0 + h))
    if cb is None:
        return
    X0, Y0, X1, Y1 = cb
    aa = a[Y0 - y0:Y1 - y0, X0 - x0:X1 - x0]
    f[Y0:Y1, X0:X1] += aa[..., None] * np.asarray(col, np.float32)


def blend_at(f, x0, y0, a, col):
    """Normal-blend a solid colour with alpha map a (h, w) whose top-left is (x0, y0); clipped."""
    h, w = a.shape
    cb = clipbox((x0, y0, x0 + w, y0 + h))
    if cb is None:
        return
    X0, Y0, X1, Y1 = cb
    aa = a[Y0 - y0:Y1 - y0, X0 - x0:X1 - x0]
    sub = f[Y0:Y1, X0:X1]
    sub += (np.asarray(col, np.float32) - sub) * aa[..., None]


# ---------------------------------------------------------------- slam cracks (world)
CRW, CRH = 680, 560


@lru_cache(maxsize=64)
def crack_local(L, q):
    p = q / 16.0
    cu = L_CEN[L]
    i = "ARMY".index(L)
    m = crack_mask(CRW, CRH, CRW // 2, CRH // 2, seed=140 + i, branches=7, progress=p, thickness=2)
    m2 = crack_mask(CRW, CRH, CRW // 2, CRH // 2, seed=150 + i, branches=4, progress=p * 0.6, thickness=1)
    return np.clip(m + 0.7 * m2, 0, 1) * crack_fade()


@lru_cache(maxsize=4)
def crack_sparse(L, x0, y0):
    m = crack_local(L, 16)
    ys, xs = np.nonzero(m > 0.004)
    v = m[ys, xs].astype(np.float32)
    ys, xs = ys + y0, xs + x0
    ok = (ys >= 0) & (ys < H) & (xs >= 0) & (xs < W)
    return ys[ok], xs[ok], v[ok]


@lru_cache(maxsize=1)
def crack_fade():
    yy, xx = np.mgrid[0:CRH, 0:CRW].astype(np.float32)
    r = np.hypot((xx - CRW / 2) / (CRW / 2), (yy - CRH / 2) / (CRH / 2))
    return np.clip((1 - r) / 0.45, 0, 1) ** 1.2


def draw_cracks(f, t):
    for L, t0, a0, amp, wgt in SLAMS:
        if t < t0:
            continue
        d = t - t0
        q = int(round(16 * ease_out_cubic(clamp(d / 0.28))))
        if q <= 0:
            continue
        c = U2W(L_CEN[L])
        x0, y0 = int(c[0] - CRW // 2), int(c[1] - CRH // 2)
        hot = math.exp(-d * 6.5)
        if q >= 16:                                   # fully grown: touch only the crack pixels
            ys, xs, v = crack_sparse(L, x0, y0)
            px = f[ys, xs]
            px *= (1 - 0.5 * v)[:, None]
            px += v[:, None] * (BONE * 0.14 + ADD_G * (0.9 * hot + 0.03))
            f[ys, xs] = px
            continue
        m = crack_local(L, q)
        cb = clipbox((x0, y0, x0 + CRW, y0 + CRH))
        if cb is None:
            continue
        X0, Y0, X1, Y1 = cb
        mm = m[Y0 - y0:Y1 - y0, X0 - x0:X1 - x0]
        sub = f[Y0:Y1, X0:X1]
        sub *= (1 - 0.5 * mm)[..., None]
        sub += mm[..., None] * (BONE * 0.14 + ADD_G * (0.9 * hot + 0.03))


# ---------------------------------------------------------------- graffiti star tag (world)
STAR_C = np.array([1706.0, 192.0], np.float32)   # inside title-safe, clear of the Y
STAR_K = 0.86                  # star size
STAR_CAN = (440, 560)          # canvas w, h (1x)
STAR_O = (220, 200)            # star centre inside the canvas


def _rough_edges(mask, seed, amt=0.55, blur=2.2):
    h, w = mask.shape
    b = cv2.GaussianBlur(mask, (0, 0), blur)
    nz = value_noise(w, h, 5, 3, seed)
    e = b - 0.5 + (nz - 0.5) * amt * np.clip(1.3 - b, 0, 1)
    return np.clip(e * 5 + 0.5, 0, 1) * (mask > 0.02)


@lru_cache(maxsize=1)
def star_tag():
    ss = 2
    CW, CH = STAR_CAN
    W2, H2 = CW * ss, CH * ss
    cx, cy = STAR_O[0] * ss, STAR_O[1] * ss
    R, r = 128 * STAR_K * ss, 55 * STAR_K * ss
    rng = np.random.default_rng(71)
    rot = math.radians(-10)
    verts = []
    for k in range(10):
        a = -math.pi / 2 + k * math.pi / 5 + rot
        rad = (R if k % 2 == 0 else r) * (1 + rng.normal(0, 0.04))
        verts.append(np.array([cx + rad * math.cos(a), cy + rad * math.sin(a)]))
    path = verts + [verts[0], verts[0] + (verts[1] - verts[0]) * 0.32]
    pts = []
    for i in range(len(path) - 1):
        p0, p1 = path[i], path[i + 1]
        n = int(np.linalg.norm(p1 - p0) / 2.0) + 1
        for j in range(n):
            pts.append(p0 + (p1 - p0) * j / n)
    pts.append(path[-1])
    pts = np.array(pts)
    seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
    s = seg / seg[-1]
    wob = (value_noise(len(pts), 2, 40, 2, 72)[0] - 0.5) * 2
    tang = np.gradient(pts, axis=0)
    nrm = np.stack([-tang[:, 1], tang[:, 0]], 1) / (np.linalg.norm(tang, axis=1)[:, None] + 1e-6)
    pts = pts + nrm * (wob[:, None] * 3.0 * ss)
    rad = ss * (8.6 * np.clip(s / 0.03, 0.25, 1) ** 0.5 * np.clip((1 - s) / 0.06, 0.2, 1) ** 0.7
                * (0.9 + 0.2 * value_noise(len(pts), 2, 25, 2, 73)[0]))
    body = np.zeros((H2, W2), np.float32)
    tm = np.full((H2, W2), 99.0, np.float32)
    ts = T_SPRAY + 0.02 + s * 0.40
    for i in range(len(pts) - 1, -1, -1):          # earliest stamp wins
        c = (int(round(pts[i, 0] * 16)), int(round(pts[i, 1] * 16)))
        cv2.circle(tm, c, int(rad[i] * 16 + 24), float(ts[i]), -1, cv2.LINE_8, 4)
        cv2.circle(body, c, int(rad[i] * 16), 1.0, -1, cv2.LINE_AA, 4)
    star = _rough_edges(body, 74)
    # "ARMY" inside, marker caps, sheared + rotated
    f = ImageFont.truetype(os.path.join(FONTS, "PermanentMarker-Regular.ttf"), int(70 * ss))
    x0, y0, x1, y1 = f.getbbox("ARMY")
    tw, th = x1 - x0 + 40 * ss, y1 - y0 + 40 * ss
    im = Image.new("L", (tw, th), 0)
    ImageDraw.Draw(im).text((20 * ss - x0, 20 * ss - y0), "ARMY", font=f, fill=255)
    tmk = np.asarray(im, np.float32) / 255.0
    A_ = np.array([[1.0, -0.22, 0], [0, 1.18, 0], [0, 0, 1]])
    Rm = _m3(cv2.getRotationMatrix2D((0, 0), 13, 1.0))
    T0 = np.array([[1, 0, -tw / 2], [0, 1, -th / 2], [0, 0, 1]])
    T1 = np.array([[1, 0, cx + 16 * ss], [0, 1, cy + 1 * ss], [0, 0, 1]])   # tag clears the left arm
    Mt = (T1 @ Rm @ A_ @ T0)[:2]
    txt = cv2.warpAffine(tmk, Mt, (W2, H2), flags=cv2.INTER_LINEAR)
    txt = _rough_edges(txt, 75, 0.45, 1.6)
    yy, xx = np.mgrid[0:H2, 0:W2].astype(np.float32)
    a = math.radians(-13)
    u = xx * math.cos(a) - yy * math.sin(a)
    lu = u[txt > 0.4]
    ul = (u - lu.min()) / (lu.max() - lu.min())
    t_txt = T_SPRAY + 0.46 + np.clip(ul, 0, 1) * 0.24
    ko = cv2.GaussianBlur(cv2.dilate((txt > 0.3).astype(np.float32), np.ones((9 * ss // 2 * 2 + 1,) * 2, np.uint8)), (0, 0), 1.2)
    w1, h1 = CW, CH
    star1 = cv2.resize(star, (w1, h1), interpolation=cv2.INTER_AREA)
    txt1 = cv2.resize(txt, (w1, h1), interpolation=cv2.INTER_AREA)
    ko1 = np.clip(cv2.resize(ko, (w1, h1), interpolation=cv2.INTER_AREA), 0, 1)
    tst1 = cv2.resize(tm, (w1, h1), interpolation=cv2.INTER_NEAREST)
    tst1 = np.minimum(tst1, cv2.erode(tst1, np.ones((3, 3), np.uint8)))
    ttx1 = cv2.resize(t_txt.astype(np.float32), (w1, h1), interpolation=cv2.INTER_LINEAR)
    body1 = np.maximum(star1 * (1 - ko1), txt1)
    tm1 = np.where(txt1 > star1 * (1 - ko1), ttx1, tst1).astype(np.float32)
    halo = cv2.GaussianBlur(body1, (0, 0), 7) * 0.16
    near = cv2.GaussianBlur(body1, (0, 0), 18)
    rng2 = np.random.default_rng(76)
    mist = (rng2.random((h1, w1)).astype(np.float32) < near * 0.06).astype(np.float32)
    mist = np.clip(cv2.GaussianBlur(mist, (0, 0), 0.55) * 1.8, 0, 1) * (1 - body1)
    tmh = cv2.GaussianBlur(np.where(tm1 < 50, tm1, 0), (0, 0), 10)
    wgt = cv2.GaussianBlur((tm1 < 50).astype(np.float32), (0, 0), 10)
    tmh = np.where(wgt > 1e-3, tmh / np.maximum(wgt, 1e-3), T_SPRAY + 0.4).astype(np.float32)
    shadow = cv2.GaussianBlur(cv2.dilate(body1, np.ones((5, 5), np.uint8)), (0, 0), 2.5)
    # drips from the lowest edges
    drips = []
    bot = (body1[:-4] > 0.6) & (body1[4:] < 0.05)
    cy_, cx_ = np.nonzero(bot)
    order = np.argsort(-(cy_ + rng2.uniform(0, 70, len(cy_))))
    taken = []
    for i in order:
        x, y = int(cx_[i]), int(cy_[i])
        if any(abs(x - q) < 48 for q in taken):
            continue
        taken.append(x)
        n = len(drips)
        L = float([rng2.uniform(60, 90), rng2.uniform(22, 40), rng2.uniform(110, 150), rng2.uniform(35, 60)][n % 4])
        L = min(L, h1 - y - 20)
        t0 = float(tm1[y, x]) + 0.08 + float(rng2.uniform(0, 0.3))
        drips.append((float(x), float(y + 2), float(rng2.uniform(7.0, 10.5)), L, t0, float(rng2.uniform(1.4, 2.4))))
        if len(drips) >= 4:
            break
    return dict(body=body1, tmap=tm1, star=star1, txt=txt1, ko=ko1, tst=tst1, ttx=ttx1, halo=halo, mist=mist, tmh=tmh, shadow=shadow, drips=drips,
                path=pts / ss, ptimes=ts, w=w1, h=h1)


@lru_cache(maxsize=1)
def mist_sprite():
    s = 120
    yy, xx = np.mgrid[0:s, 0:s].astype(np.float32) - s / 2
    return np.exp(-(xx ** 2 + yy ** 2) / (2 * 22 ** 2)).astype(np.float32)


def draw_star(f, t, fr):
    if t < T_SPRAY:
        return
    tg = star_tag()
    w, h = tg["w"], tg["h"]
    ox, oy = int(STAR_C[0] - STAR_O[0]), int(STAR_C[1] - STAR_O[1])
    cb = clipbox((ox, oy, ox + w, oy + h))
    X0, Y0, X1, Y1 = cb
    win = (slice(Y0 - oy, Y1 - oy), slice(X0 - ox, X1 - ox))
    rs = np.clip((t - tg["tst"][win]) / 0.035, 0, 1)
    rt = np.clip((t - tg["ttx"][win]) / 0.035, 0, 1)
    rev = np.clip((t - tg["tmap"][win]) / 0.035, 0, 1)
    revh = np.clip((t - tg["tmh"][win]) / 0.08, 0, 1)
    dm = drip_canvas((h, w), tg["drips"], t)[win]
    body = np.maximum(np.maximum(tg["star"][win] * rs * (1 - tg["ko"][win] * rt), tg["txt"][win] * rt), dm)
    sh = np.maximum(tg["shadow"][win] * rev, cv2.GaussianBlur(dm, (0, 0), 2.5))
    sub = f[Y0:Y1, X0:X1]
    sub *= (1 - 0.6 * sh)[..., None]
    sub += (GREEN * 0.55 - sub * 0.3) * (tg["halo"][win] * revh)[..., None]
    sub += (GREEN - sub) * (tg["mist"][win] * revh * 0.7)[..., None]
    wet = math.exp(-max(t - T_SPRAY - 0.75, 0) * 3)
    col = GREEN + (GREEN_HOT - GREEN) * 0.25 * wet
    sub += (col - sub) * body[..., None]
    # live nozzle mist at the spray front
    if T_SPRAY <= t < T_SPRAY + 0.72:
        if t < T_SPRAY + 0.43:
            i = int(np.searchsorted(tg["ptimes"], t))
            i = min(i, len(tg["path"]) - 1)
            px, py = tg["path"][i]
        else:
            u = prog(t, T_SPRAY + 0.46, T_SPRAY + 0.70)
            px, py = STAR_O[0] - 66 + 168 * u, STAR_O[1] + 5 + 36 * u * -0.45
        rng = np.random.default_rng(3000 + fr)
        ms = mist_sprite()
        lay = solid_layer(ms * 0.35, GREEN)
        over_center(f, lay, ox + px, oy + py, 1.0)
        n = 70
        ang = rng.uniform(0, 2 * math.pi, n)
        rr = np.abs(rng.normal(0, 26, n))
        for k in range(n):
            x, y = ox + px + rr[k] * math.cos(ang[k]), oy + py + rr[k] * math.sin(ang[k])
            if 0 <= x < W and 0 <= y < H:
                bg = f[int(y), int(x)]
                cv2.circle(f, (int(x * 4), int(y * 4)), int(rng.uniform(2, 6)), _col(bg + (GREEN - bg) * 0.8), -1, cv2.LINE_AA, 2)


# ---------------------------------------------------------------- reticle (screen)
RET_SZ = 640


RET_LOCK_SC = 0.94          # locked size: the ring frames the A icon and clears the tagline's "SKILL"
RET_ARM0 = 0.6              # arm length fraction while hunting (extends to 1.0 on lock)
RET_FADE_Y = 628.0          # world y below which the arms/arcs fade once locked (tagline above stays clear)


def _ret_line(img, a, b, v, th):
    cv2.line(img, (int(a[0] * 16), int(a[1] * 16)), (int(b[0] * 16), int(b[1] * 16)), v, max(1, int(round(th))), cv2.LINE_AA, 4)


@lru_cache(maxsize=1)
def reticle_base():
    """(ring + centre dot, outer arcs) alpha layers, RET_SZ square."""
    ss = 2
    s = RET_SZ * ss
    c = s / 2
    ring = np.zeros((s, s), np.float32)
    Rr = 190 * ss
    n = 360
    nz = value_noise(n + 1, 2, 30, 3, 92)[0]
    pts = []
    for i in range(n + 9):
        a = -2.2 + i / n * 2 * math.pi
        rr = Rr + (nz[i % (n + 1)] - 0.5) * 5 * ss
        pts.append((c + rr * math.cos(a), c + rr * math.sin(a)))
    pts = np.array(pts)
    for i in range(len(pts) - 1):
        th = 4.6 * ss * (0.55 + 0.45 * min(1, i / 25, (len(pts) - 1 - i) / 25))
        _ret_line(ring, pts[i], pts[i + 1], 1.0, th)
    cv2.circle(ring, (int(c * 16), int(c * 16)), int(4 * ss * 16), 1.0, -1, cv2.LINE_AA, 4)
    arcs = np.zeros((s, s), np.float32)
    for k in range(4):
        a0 = 45 + k * 90
        cv2.ellipse(arcs, (int(c * 16), int(c * 16)), (int(212 * ss * 16), int(212 * ss * 16)), 0, a0 - 24, a0 + 24, 0.85,
                    max(1, int(1.6 * ss)), cv2.LINE_AA, 4)
    grit = (0.78 + 0.22 * grunge(RET_SZ, RET_SZ, 93)).astype(np.float32)
    out = []
    for img in (ring, arcs):
        a1 = np.clip(cv2.resize(img, (RET_SZ, RET_SZ), interpolation=cv2.INTER_AREA), 0, 1) * grit
        out.append(a1.astype(np.float32))
    return tuple(out)


@lru_cache(maxsize=12)
def reticle_arms(q20):
    """Cross arms with ticks at length fraction q20/20 (ticks only where the arm reaches)."""
    frac = q20 / 20.0
    ss = 2
    s = RET_SZ * ss
    c = s / 2
    img = np.zeros((s, s), np.float32)
    r0, r1 = 34 * ss, 300 * ss
    rf = r0 + (r1 - r0) * frac
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nseg = 24
        for j in range(nseg):
            u0, u1 = j / nseg, (j + 1) / nseg
            q0, q1 = r0 + (rf - r0) * u0, r0 + (rf - r0) * u1
            th = (3.6 - 2.4 * u0 ** 2) * ss
            _ret_line(img, (c + dx * q0, c + dy * q0), (c + dx * q1, c + dy * q1), 1.0, th)
        for k in range(1, 6):
            p = (34 + k * 26) * ss
            if p > rf - 4 * ss:
                continue
            tl = (7 if k != 3 else 13) * ss
            if dx:
                a, b = (c + dx * p, c - tl), (c + dx * p, c + tl)
            else:
                a, b = (c - tl, c + dy * p), (c + tl, c + dy * p)
            _ret_line(img, a, b, 1.0, 2.2 * ss)
    a1 = np.clip(cv2.resize(img, (RET_SZ, RET_SZ), interpolation=cv2.INTER_AREA), 0, 1)
    return (a1 * (0.78 + 0.22 * grunge(RET_SZ, RET_SZ, 93))).astype(np.float32)


@lru_cache(maxsize=1)
def ret_keys():
    tgt = U2W((143.0, 149.5))
    # enters from the right edge below the logo's mid-line (well clear of the star tag being written
    # top-right), rises across Y-M-R and locks on the bullet
    return ((T_RET0, (2250.0, 700.0)), (2.80, (1400.0, 575.0)), (2.97, (880.0, 492.0)),
            (3.09, (468.0, 522.0)), (T_RETLOCK, (float(tgt[0]), float(tgt[1]))))


def hermite_path(t, keys):
    """C1 time-parametrised Hermite spline through (t, (x, y)) keys; zero velocity at the last key."""
    ts = [k[0] for k in keys]
    ps = [np.array(k[1], np.float64) for k in keys]
    n = len(keys)
    if t <= ts[0]:
        return ps[0].astype(np.float32)
    if t >= ts[-1]:
        return ps[-1].astype(np.float32)
    ms = []
    for i in range(n):
        if i == n - 1:
            ms.append(np.zeros(2))
        elif i == 0:
            ms.append((ps[1] - ps[0]) / (ts[1] - ts[0]))
        else:
            ms.append((ps[i + 1] - ps[i - 1]) / (ts[i + 1] - ts[i - 1]))
    i = max(j for j in range(n - 1) if ts[j] <= t)
    d = ts[i + 1] - ts[i]
    u = (t - ts[i]) / d
    h00 = 2 * u ** 3 - 3 * u ** 2 + 1
    h10 = u ** 3 - 2 * u ** 2 + u
    h01 = -2 * u ** 3 + 3 * u ** 2
    h11 = u ** 3 - u ** 2
    return (h00 * ps[i] + h10 * d * ms[i] + h01 * ps[i + 1] + h11 * d * ms[i + 1]).astype(np.float32)


def reticle_state(t):
    """(world centre, scale, angle, alpha) or None."""
    if t < T_RET0 or t > 4.35:
        return None
    pos = hermite_path(t, ret_keys())
    if t < T_RETLOCK + 0.3:                      # hand tremor while hunting
        k = 1 - prog(t, T_RETLOCK - 0.1, T_RETLOCK + 0.3)
        pos = pos + np.array([3.5 * math.sin(t * 23), 2.5 * math.sin(t * 29 + 1)], np.float32) * k
    sc = RET_LOCK_SC * (1.0 + 0.5 * (1 - ease_out_cubic(prog(t, T_RET0, T_RETLOCK + 0.1))))
    ang = 12.0 * (1 - ease_out_cubic(prog(t, T_RET0, T_RETLOCK + 0.05)))
    a = 1.0
    if t >= T_RETLOCK:
        d = t - T_RETLOCK
        sc *= 1 - 0.06 * math.sin(min(d / 0.16, 1) * math.pi) * math.exp(-d * 4)
    if t >= T_RETOUT:
        q = prog(t, T_RETOUT, 4.35)
        sc *= 1 + 0.28 * ease_in_cubic(q)
        a *= 1 - ease_in_out(q)
    return pos, sc, ang, a


def ret_presence(t):
    """0..1 while the locked reticle sits over the A (used to calm the tagline's left rule)."""
    return ease_in_out(prog(t, T_RETLOCK - 0.25, T_RETLOCK)) * (1 - ease_in_out(prog(t, T_RETOUT, 4.35)))


def draw_reticle(f, t, Mc, z):
    st = reticle_state(t)
    if st is None or st[3] <= 0.01:
        return
    pos, sc, ang, a = st
    ring, arcs = reticle_base()
    # arms: short while hunting (no long rotated 'laser' lines), snap out to full length over 4 frames on lock
    frac = RET_ARM0 + (1 - RET_ARM0) * ease_out_cubic(prog(t, T_RETLOCK, T_RETLOCK + 4 * DT))
    arms = reticle_arms(int(round(frac * 20)))
    q = xf(Mc, pos[None])[0]
    k = sc * z
    # once locked, fade the arms/arcs below the tagline line (source rows -> screen rows; angle ~0 here)
    fl = ease_out_cubic(prog(t, T_RETLOCK - 0.08, T_RETLOCK + 0.06))
    ext = np.maximum(arms, arcs)
    if fl > 0:
        ycut = xf(Mc, np.array([[pos[0], RET_FADE_Y]], np.float32))[0][1]
        rows = q[1] + (np.arange(RET_SZ, dtype=np.float32) - RET_SZ / 2 + 0.5) * k
        fade = 1 - fl * (1 - np.clip((ycut - rows) / 38.0, 0, 1))
        ext = ext * fade[:, None]
    src = np.maximum(ring, ext)
    size = int(RET_SZ * k * 1.05) + 8
    M = cv2.getRotationMatrix2D((RET_SZ / 2, RET_SZ / 2), ang, k)
    x0, y0 = int(q[0] - size / 2), int(q[1] - size / 2)
    M[0, 2] += q[0] - RET_SZ / 2 - x0
    M[1, 2] += q[1] - RET_SZ / 2 - y0
    cb = clipbox((x0, y0, x0 + size, y0 + size))
    if cb is None:
        return
    X0, Y0, X1, Y1 = cb
    M[0, 2] -= X0 - x0
    M[1, 2] -= Y0 - y0
    w, h = X1 - X0, Y1 - Y0
    al = cv2.warpAffine(src, M, (w, h), flags=cv2.INTER_LINEAR)
    # light motion blur while sweeping (capped so the lines stay solid)
    if t < T_RETLOCK + 0.1:
        st2 = reticle_state(t - DT * 0.5)
        if st2 is not None:
            dv = pos - st2[0]
            vel = float(np.hypot(*dv))
            if vel > 3:
                kk = int(min(vel * 0.9, 25)) | 1
                d = dv / max(vel, 1e-3)
                kern = np.zeros((kk, kk), np.float32)
                cv2.line(kern, (kk // 2 - int(round(d[0] * kk / 2)), kk // 2 - int(round(d[1] * kk / 2))),
                         (kk // 2 + int(round(d[0] * kk / 2)), kk // 2 + int(round(d[1] * kk / 2))), 1.0, 1)
                kern /= max(kern.sum(), 1e-6)
                # smear trail behind a crisp, full-strength current position (lines never go ghostly)
                al = np.maximum(al, cv2.filter2D(al, -1, kern) * 1.15)
    # glow from the final (blurred, faded) alpha, quarter-res
    gq = cv2.resize(al, (max(1, w // 4), max(1, h // 4)), interpolation=cv2.INTER_AREA)
    g = cv2.resize(cv2.GaussianBlur(gq, (0, 0), 1.75), (w, h), interpolation=cv2.INTER_LINEAR)
    sub = f[Y0:Y1, X0:X1]
    lockf = 0.0
    if t >= T_RETLOCK:
        lockf = math.exp(-(t - T_RETLOCK) * 7)
    col = GREEN + (GREEN_HOT - GREEN) * lockf
    sub += (g * a * (0.55 + 0.8 * lockf))[..., None] * ADD_G * 0.55
    sub += (col - sub) * (np.clip(al, 0, 1) * a)[..., None]
    # lock ping ring
    if T_RETLOCK <= t < T_RETLOCK + 0.35:
        d = prog(t, T_RETLOCK, T_RETLOCK + 0.35)
        rr = (190 + 120 * ease_out_cubic(d)) * k
        ring_ = np.zeros((h, w), np.float32)
        cv2.circle(ring_, (int((q[0] - X0) * 16), int((q[1] - Y0) * 16)), int(rr * 16), 1.0, 2, cv2.LINE_AA, 4)
        sub += (GREEN_HOT - sub) * (ring_ * (1 - d) * 0.9)[..., None]


# ---------------------------------------------------------------- tagline (screen, PIL per frame)
TAG_PX = 37
TAG_TRACK = 5.0
TAG_WORDS = ("SKILL", "IS", "THE", "ONLY", "ADVANTAGE")
TAG_TOP = 650.0            # world cap-top


TAG_SS = 3
TAG_PAD = 10


@lru_cache(maxsize=1)
def tag_layout():
    """Word x positions (world) from the supersampled font, so layout and masks agree."""
    f = font("inter_black", TAG_PX * TAG_SS)
    sp = (f.getlength(" ") * 1.25 + TAG_TRACK * TAG_SS) / TAG_SS
    widths = []
    for wd in TAG_WORDS:
        widths.append((sum(f.getlength(ch) + TAG_TRACK * TAG_SS for ch in wd) - TAG_TRACK * TAG_SS) / TAG_SS)
    total = sum(widths) + sp * (len(TAG_WORDS) - 1)
    x = AX - total / 2
    xs = []
    for wdt in widths:
        xs.append(x)
        x += wdt + sp
    asc = f.getbbox("H")[1] / TAG_SS
    cap = (f.getbbox("H")[3] - f.getbbox("H")[1]) / TAG_SS
    return xs, widths, total, asc, cap


@lru_cache(maxsize=8)
def tag_word_mask(i):
    """Supersampled, pre-filtered alpha mask of one tagline word; cap-top-left at (TAG_PAD, TAG_PAD)*SS."""
    wd = TAG_WORDS[i]
    ss = TAG_SS
    f = font("inter_black", TAG_PX * ss)
    xs, widths, total, asc, cap = tag_layout()
    pad = TAG_PAD * ss
    w = int(widths[i] * ss) + 2 * pad
    h = int(cap * ss) + 2 * pad
    im = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(im)
    x = pad
    for ch in wd:
        d.text((x, pad - asc * ss), ch, font=f, fill=255)
        x += f.getlength(ch) + TAG_TRACK * ss
    a = np.asarray(im, np.float32) / 255.0
    return cv2.GaussianBlur(a, (0, 0), 0.42 * ss)


def draw_word(f, i, Mc, xw, yw, color, alpha, clip_y_world):
    """Warp word mask i to screen (cap-top-left at world (xw, yw)), clipped below world y clip."""
    m = tag_word_mask(i)
    ss = TAG_SS
    h, w = m.shape
    A = np.array([[1.0 / ss, 0, xw - TAG_PAD], [0, 1.0 / ss, yw - TAG_PAD], [0, 0, 1]], np.float64)
    M = Mc @ A
    corners = xf(M, np.array([[0, 0], [w, 0], [0, h], [w, h]], np.float32))
    bb = clipbox(bbox_of([corners], 2))
    if bb is None:
        return
    X0, Y0, X1, Y1 = bb
    Ms = M.copy()
    Ms[0, 2] -= X0
    Ms[1, 2] -= Y0
    a = cv2.warpAffine(m, Ms[:2], (X1 - X0, Y1 - Y0), flags=cv2.INTER_LINEAR)
    if clip_y_world is not None:
        cy = xf(Mc, np.array([[xw, clip_y_world]]))[0][1]
        rows = np.arange(Y0, Y1, dtype=np.float32)[:, None] + 0.5
        a = a * np.clip(cy - rows, 0, 1)
    sub = f[Y0:Y1, X0:X1]
    sub += (np.asarray(color, np.float32) - sub) * (a * alpha)[..., None]


def draw_text(f, text, fo, x, y_top, color, alpha=1.0, track=0.0, clip_y=None, cc=0):
    """Draw screen-locked text with PIL font object fo, top of caps at y_top.
    cc > 0 pre-registers the R/B coverage against build.py's lateral chroma shift (k=cc), so
    small HUD type lands fringe-free (no cyan/red rainbow edges) after the global post."""
    if alpha <= 0.003:
        return
    asc = fo.getbbox("H")[1]
    wdt = sum(fo.getlength(ch) + track for ch in text) - track if track else fo.getlength(text)
    capb = fo.getbbox("Hg")
    bx0, by0 = int(math.floor(x)) - 4, int(math.floor(y_top)) - 6
    bw, bh = int(wdt) + 12, int(capb[3] - asc) + 14
    im = Image.new("L", (bw, bh), 0)
    d = ImageDraw.Draw(im)
    cx = x - bx0
    cy = y_top - by0 - asc
    if track:
        for ch in text:
            d.text((cx, cy), ch, font=fo, fill=255)
            cx += fo.getlength(ch) + track
    else:
        d.text((cx, cy), text, font=fo, fill=255)
    a = np.asarray(im, np.float32) / 255.0
    if clip_y is not None:
        rows = np.arange(bh, dtype=np.float32)[:, None] + by0
        a = a * np.clip(clip_y - rows, 0, 1)
    cb = clipbox((bx0, by0, bx0 + bw, by0 + bh))
    if cb is None:
        return
    X0, Y0, X1, Y1 = cb
    a = a[Y0 - by0:Y1 - by0, X0 - bx0:X1 - bx0] * alpha
    sub = f[Y0:Y1, X0:X1]
    if cc:
        a3 = np.repeat(a[..., None], 3, axis=2)
        a3[:, :, 0] = 0
        a3[:, :-cc, 0] = a[:, cc:]
        a3[:, :, 2] = 0
        a3[:, cc:, 2] = a[:, :-cc]
        sub += (np.asarray(color, np.float32) - sub) * a3
    else:
        sub += (np.asarray(color, np.float32) - sub) * a[..., None]
    return a, (X0, Y0)


def draw_tagline(f, t, Mc, z):
    if t < T_TAG - 0.05:
        return
    xs, widths, total, asc, cap = tag_layout()
    # rules
    rp = ease_out_cubic(prog(t, T_TAG - 0.04, T_TAG + 0.36))
    y_mid = TAG_TOP + cap * 0.5
    for side in (-1, 1):
        xin = AX + side * (total / 2 + 30)
        xout = xin + side * 150 * rp
        p0 = xf(Mc, np.array([[xin, y_mid]]))[0]
        p1 = xf(Mc, np.array([[xout, y_mid]]))[0]
        if rp > 0.01:
            th = 2.0 * z
            lay_w = int(abs(p1[0] - p0[0])) + 8
            y0 = int(p0[1] - 3)
            x0 = int(min(p0[0], p1[0]) - 4)
            ra = 1.0 - 0.62 * ret_presence(t) if side < 0 else 1.0     # dims to ~38%, never vanishes
            sub_box = clipbox((x0, y0, x0 + lay_w, y0 + 7))
            if sub_box is not None:
                X0, Y0, X1, Y1 = sub_box
                can = np.zeros((Y1 - Y0, X1 - X0), np.float32)
                q0 = (int((p0[0] - X0) * 16), int((p0[1] - Y0) * 16))
                q1 = (int((p1[0] - X0) * 16), int((p1[1] - Y0) * 16))
                cv2.line(can, q0, q1, 1.0, max(1, int(round(th))), cv2.LINE_AA, 4)
                sub = f[Y0:Y1, X0:X1]
                sub += (GREEN - sub) * (can * 0.85 * ra)[..., None]
            # end diamond
            pd = xf(Mc, np.array([[xout + side * 8, y_mid]]))[0]
            r = 4.2 * z * rp
            dia = np.array([(pd[0] - r, pd[1]), (pd[0], pd[1] - r), (pd[0] + r, pd[1]), (pd[0], pd[1] + r)], np.float32)
            bb = clipbox(bbox_of([dia], 3))
            if bb is not None:
                X0, Y0, X1, Y1 = bb
                cov = raster([dia], X0, Y0, X1 - X0, Y1 - Y0)
                sub = f[Y0:Y1, X0:X1]
                sub += (GREEN - sub) * (cov * ra)[..., None]
    for i, (wd, x) in enumerate(zip(TAG_WORDS, xs)):
        t0 = T_TAG + 0.04 + i * 0.065
        p = prog(t, t0, t0 + 0.32)
        if p <= 0:
            continue
        e = ease_out_cubic(p)
        rise = (1 - e) * cap * 1.15
        if wd == "ONLY":
            hot = math.exp(-max(t - (t0 + 0.25), 0) * 5)
            col = GREEN + (GREEN_HOT - GREEN) * 0.6 * hot
        else:
            col = TAG_C
        draw_word(f, i, Mc, x, TAG_TOP + rise, col, clamp(p * 3), TAG_TOP + cap + 2.0)


# ---------------------------------------------------------------- HUD (screen locked)
HUD_Y = 954.0        # caption cap-top
BAR_Y = 996.0        # bar track top (4 px track, 6 px fill)
BAR_W = 640.0
HUD_TXT = "CONECTANDO AO SERVIDOR"
PROG_KEYS = ((3.25, 0.0), (3.7, 0.17), (4.05, 0.22), (4.45, 0.39), (4.95, 0.44), (5.35, 0.61), (5.9, 0.68),
             (6.3, 0.83), (6.8, 0.91), (7.5, 0.95))


@lru_cache(maxsize=1)
def hud_font():
    f = ImageFont.truetype(os.path.join(FONTS, "Oswald.ttf"), 29)
    for nm in (b"SemiBold", "SemiBold", b"Medium", "Medium"):
        try:
            f.set_variation_by_name(nm)
            break
        except Exception:
            pass
    return f


def progress(t):
    if t <= PROG_KEYS[0][0]:
        return 0.0
    for (ta, va), (tb, vb) in zip(PROG_KEYS[:-1], PROG_KEYS[1:]):
        if t <= tb:
            return va + (vb - va) * ease_in_out(prog(t, ta, tb))
    return PROG_KEYS[-1][1]


def fill_cc(f, x0, y0, x1, y1, col, a, cc=2):
    """Blend a solid rect, pre-registered per channel against build.py's chroma shift (see draw_text)."""
    x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
    for ch, off in ((0, -cc), (1, 0), (2, cc)):
        X0, X1 = max(x0 + off, 0), min(x1 + off, W)
        if X1 > X0 and y1 > y0:
            sub = f[y0:y1, X0:X1, ch]
            sub += (float(col[ch]) - sub) * a


def draw_hud(f, t, fr):
    if t < T_HUD:
        return
    fo = hud_font()
    track = 5.0
    full_w = sum(fo.getlength(ch) + track for ch in HUD_TXT) - track
    bx0 = AX - BAR_W / 2
    # caption types on
    n = int(len(HUD_TXT) * ease_out_cubic(prog(t, T_HUD + 0.05, T_HUD + 0.5)) + 0.999)
    txt = HUD_TXT[:n]
    a_in = ease_out_cubic(prog(t, T_HUD, T_HUD + 0.12))
    x_txt = bx0 + 22
    if txt:
        draw_text(f, txt, fo, x_txt, HUD_Y, BONE, alpha=a_in, track=track, cc=2)
    w_now = sum(fo.getlength(ch) + track for ch in txt) if txt else 0
    # status block (blinks) left of caption
    blink = 1.0 if (int(t * 2.4) % 2 == 0) else 0.25
    cap = fo.getbbox("H")[3] - fo.getbbox("H")[1]
    sq = 11
    y_sq = HUD_Y + cap / 2 - sq / 2
    fill_cc(f, bx0, y_sq, bx0 + sq, int(y_sq) + sq, GREEN, a_in * blink)
    # typing cursor / animated dots
    if n < len(HUD_TXT):
        cxp = x_txt + w_now + 2
        fill_cc(f, cxp, HUD_Y, int(cxp) + 12, HUD_Y + cap, GREEN, 0.9)
    else:
        k = int((t - T_HUD) * 3.0) % 4
        for j in range(3):
            on = 1.0 if j < k else 0.18
            dx = x_txt + full_w + 9 + j * 12
            yb = HUD_Y + cap - 5
            fill_cc(f, dx, yb, int(dx) + 5, int(yb) + 5, BONE, 0.9 * on)
    # percentage
    pv = progress(t)
    pct = "%d%%" % int(round(pv * 100))
    pw = sum(fo.getlength(ch) + 3 for ch in pct) - 3
    draw_text(f, pct, fo, bx0 + BAR_W - pw, HUD_Y, GREEN, alpha=a_in, track=3, cc=2)
    # bar track draws out from the centre
    tp = ease_out_cubic(prog(t, T_HUD + 0.02, T_HUD + 0.4))
    hw = BAR_W / 2 * tp
    x0, x1 = int(round(AX - hw)), int(round(AX + hw))
    if x1 > x0:
        fill_cc(f, x0, BAR_Y, x1, BAR_Y + 4, BONE, 0.2)
        for k in range(11):
            xt = int(round(bx0 + BAR_W * k / 10))
            if x0 <= xt < x1:
                fill_cc(f, xt, BAR_Y + 9, xt + 2, BAR_Y + (16 if k % 5 == 0 else 13), BONE, 0.32)
    # fill
    fw = BAR_W * pv
    if fw > 0.5:
        xa, xb = bx0, bx0 + fw
        xi = int(math.floor(xb))
        fill_cc(f, xa, BAR_Y - 1, xi, BAR_Y + 5, GREEN, 1.0)
        frac = xb - xi
        fill_cc(f, xi, BAR_Y - 1, xi + 1, BAR_Y + 5, GREEN, frac)
        # hot head + glow
        hx = xb
        hg = np.exp(-((np.arange(-40, 41, dtype=np.float32)) / 14.0) ** 2)
        gy = np.exp(-((np.arange(-10, 11, dtype=np.float32)) / 3.5) ** 2)
        glw = (gy[:, None] * hg[None, :])[..., None] * ADD_G * (0.55 + 0.15 * math.sin(t * 11))
        lay = np.dstack([glw, np.ones(glw.shape[:2], np.float32)])
        over(f, lay, hx - 40, BAR_Y + 2 - 10, 1.0, "add")
        fill_cc(f, int(hx) - 4, BAR_Y - 2, int(hx), BAR_Y + 6, GREEN_HOT, 0.85)


# ---------------------------------------------------------------- particles
@lru_cache(maxsize=1)
def motes():
    rng = np.random.default_rng(404)
    n = 60
    return (rng.uniform(-100, W + 100, n), rng.uniform(0, H, n), rng.uniform(-10, 16, n),
            rng.uniform(-20, -5, n), rng.uniform(0.7, 2.0, n), rng.uniform(0, 6.28, n))


def draw_motes(f, Mc, t, lvl):
    xs, ys, vx, vy, sz, ph = motes()
    for i in range(len(xs)):
        x = xs[i] + vx[i] * t + 6 * math.sin(t * 1.3 + ph[i])
        y = (ys[i] + vy[i] * t + 4 * math.cos(t * 1.1 + ph[i])) % H
        lit = math.exp(-(((x - AX) / 800) ** 2 + ((y - 480) / 380) ** 2))
        b = lvl * (0.25 + 0.75 * lit) * (0.5 + 0.5 * math.sin(t * 3 + ph[i] * 3) ** 2)
        if b < 0.04:
            continue
        q = xf(Mc, np.array([[x, y]]))[0]
        if not (2 <= q[0] < W - 2 and 2 <= q[1] < H - 2):
            continue
        bg = f[int(q[1]), int(q[0])]
        c = bg + np.array([150, 225, 110], np.float32) * b * 0.55
        cv2.circle(f, (int(q[0] * 16), int(q[1] * 16)), int(sz[i] * 16), _col(c), -1, cv2.LINE_AA, 4)


@lru_cache(maxsize=1)
def dust_tex():
    n = value_noise(W // 2, H // 2, 7, 3, 51)
    return np.clip((n - 0.45) * 3.0, 0, 1).astype(np.float32)


def draw_dust(f, t, Mc):
    """Impact dust (broken-up puffs rolling off the baseline) + concrete chips with short motion streaks."""
    act = [(L, t0) for L, t0, *_ in SLAMS if 0 <= t - t0 < 0.9]
    if not act:
        return
    q = 2
    yb = U2W((0, 240))[1]
    can = None
    for L, t0 in act:
        dt = t - t0
        if dt >= 0.6:
            continue
        i = "ARMY".index(L)
        rng = np.random.default_rng(500 + i)
        u0, u1 = L_SPAN[L]
        x0, x1 = U2W((u0, 0))[0], U2W((u1, 0))[0]
        n = 60
        xs = rng.uniform(x0 - 10, x1 + 10, n)
        rel = (xs - (x0 + x1) / 2) / ((x1 - x0) / 2)
        vx = rel * rng.uniform(80, 340, n) + rng.normal(0, 40, n)
        vy = -rng.uniform(10, 110, n)
        r0 = rng.uniform(10, 24, n)
        life = rng.uniform(0.32, 0.6, n)
        dmp = (1 - math.exp(-dt * 7)) / 7
        if can is None:
            can = np.zeros((H // q, W // q), np.float32)
        for j in range(n):
            lf = dt / life[j]
            if lf >= 1:
                continue
            px = float(np.clip(xs[j] + vx[j] * dmp, x0 - 140, x1 + 140))
            py = yb + 2 + vy[j] * dmp - 30 * dt
            rr = r0[j] * (1 + 1.6 * ease_out_cubic(min(dt * 2.5, 1)))
            a = (1 - lf) ** 1.5 * min(dt * 60, 1)
            pq = xf(Mc, np.array([[px, py]]))[0]
            cv2.ellipse(can, (int(pq[0] / q * 16), int(pq[1] / q * 16)), (max(8, int(rr * 1.5 / q * 16)), max(8, int(rr * 0.75 / q * 16))),
                        0, 0, 360, a, -1, cv2.LINE_AA, 4)
    if can is not None:
        ys_ = np.nonzero(can.max(1) > 0.003)[0]
        if len(ys_):
            a0, a1 = max(ys_.min() - 4, 0), min(ys_.max() + 5, H // q)
            band = cv2.GaussianBlur(can[a0:a1], (0, 0), 1.3)
            band = np.clip(band * dust_tex()[a0:a1] * 1.6, 0, 1) * 0.6
            r0_, r1_ = a0 * q, a1 * q
            big = cv2.resize(band, (W, r1_ - r0_), interpolation=cv2.INTER_LINEAR)
            sub = f[r0_:r1_]
            sub += (BONE * 0.85 - sub) * big[..., None]
    # chips: drawn into an alpha canvas as short streaks along their velocity (2.5 frames of travel)
    segs = []
    for L, t0 in act:
        dt = t - t0
        if dt < DT * 0.5:                              # nothing on the hit frame itself (no row of dots)
            continue
        i = "ARMY".index(L)
        rng = np.random.default_rng(600 + i)
        u0, u1 = L_SPAN[L]
        x0, x1 = U2W((u0, 0))[0], U2W((u1, 0))[0]
        m = 70
        cx = rng.uniform(x0, x1, m)
        rel = (cx - (x0 + x1) / 2) / ((x1 - x0) / 2)
        cvx = rel * rng.uniform(100, 800, m) + rng.normal(0, 140, m)
        cvy = -rng.uniform(80, 650, m)
        grav = rng.uniform(500, 1500, m)
        sz = rng.uniform(1.5, 4.0, m)
        br = rng.uniform(0.45, 1.0, m)
        lifes = rng.uniform(0.35, 0.9, m)
        jit = rng.normal(0, 6, m)
        t_off = rng.uniform(0.012, 0.04, m)            # chips leave the baseline already moving

        def pos(j, tt):
            dd = (1 - math.exp(-tt * 3.0)) / 3.0
            return cx[j] + cvx[j] * dd, yb - 4 + jit[j] + cvy[j] * dd + 0.5 * grav[j] * tt * tt

        for j in range(m):
            fade = clamp(1 - dt / lifes[j])
            if fade <= 0:
                continue
            te = dt + t_off[j]
            ph = xf(Mc, np.array([pos(j, te), pos(j, max(te - 1.25 * DT, 0)), pos(j, max(te - 2.5 * DT, 0))]))
            segs.append((ph, sz[j], fade * br[j]))
    if not segs:
        return
    allp = np.concatenate([s_[0] for s_ in segs], 0)
    bb = clipbox((int(allp[:, 0].min()) - 6, int(allp[:, 1].min()) - 6, int(allp[:, 0].max()) + 7, int(allp[:, 1].max()) + 7))
    if bb is None:
        return
    X0, Y0, X1, Y1 = bb
    cm = np.zeros((Y1 - Y0, X1 - X0), np.float32)
    o = np.array([X0, Y0], np.float32)
    for ph, s_, a in segs:
        p = np.round((ph - o) * 16).astype(np.int32)
        th = max(1, int(round(s_ * 0.8)))
        cv2.line(cm, tuple(p[2]), tuple(p[1]), a * 0.3, max(1, th - 1), cv2.LINE_AA, 4)
        cv2.line(cm, tuple(p[1]), tuple(p[0]), a * 0.65, th, cv2.LINE_AA, 4)
        cv2.circle(cm, tuple(p[0]), max(8, int(s_ * 0.5 * 16)), a, -1, cv2.LINE_AA, 4)
    sub = f[Y0:Y1, X0:X1]
    sub += (BONE - sub) * np.clip(cm, 0, 1)[..., None]


# ---------------------------------------------------------------- logo
def logo_parts(t, Mc):
    """Rasterise letters (+ motion blur during drops), streaks and bullet in screen space.
    Returns a list of draw ops and quarter-res emission buffer."""
    Mu = mat_units()
    ops = []
    em = np.zeros((H // 4, W // 4, 3), np.float32)
    bullet_op = None

    # ---- streaks + bullet
    if t >= T_BIN:
        bx = bullet_dx(t)
        trail = max(0.0, bx - bullet_dx(t - 0.12))
        # near full-width speed streaks in flight, retracting over ~5 frames after the park
        trail = max(trail, B_TRAIL * (1 - ease_in_out(prog(t, T_BLAND, T_BLAND + 0.15))))
        vel = (bx - bullet_dx(t - 0.002)) / 0.002
        MB = Mc @ Mu @ np.array([[1, 0, bx], [0, 1, 0], [0, 0, 1]], np.float64)
        # streaks
        sp = []
        cone = None
        for (yc, hth, L, br) in STREAKS:
            LL = L + trail * (1.0 if yc == 150 else 0.7)
            poly = np.array([(ST_BASE - LL, yc - 0.3), (ST_BASE, yc - hth), (ST_BASE, yc + hth), (ST_BASE - LL, yc + 0.3)], np.float32)
            sp.append((xf(MB, poly), br, LL))
        LLc = 237 + trail
        cone = xf(MB, np.array([(ST_BASE - LLc, 150), (ST_BASE, 130), (ST_BASE, 170)], np.float32))
        ops.append(("streaks", sp, cone))
        for q, br, LL in sp:
            cv2.fillPoly(em, [np.round(xf(np.diag([0.25, 0.25, 1.0]), q) * 16).astype(np.int32)], _col(ADD_G * 0.9 * br), cv2.LINE_AA, 4)
        # bullet
        shp = bullet_shapes()
        qs = {k: xf(MB, v) for k, v in shp.items()}
        blur = int(min(300, abs(vel) * S / FPS * 1.1)) if t < T_BLAND else 0
        bullet_op = ("bullet", qs, blur)
        hotb = (1.0 + 0.6 * math.exp(-max(t - T_BLAND, 0) * 6) + 0.25 * slam_k(t, 7) + 0.5 * logo_pulse(t)
                + 0.07 * math.sin(t * 2 * math.pi / 2.3))
        cv2.fillPoly(em, [np.round(xf(np.diag([0.25, 0.25, 1.0]), qs["proj"]) * 16).astype(np.int32)], _col(ADD_G * 1.25 * hotb), cv2.LINE_AA, 4)
        cv2.fillPoly(em, [np.round(xf(np.diag([0.25, 0.25, 1.0]), qs["casing"]) * 16).astype(np.int32)], _col(GREEN_DK * 0.8 * hotb), cv2.LINE_AA, 4)
        fb = int(round(t * FPS)) - FR_BLAND
        if fb in (0, 1):                          # parking hit: 1-frame GREEN_HOT pulse at the tip
            tip = xf(Mc @ Mu, (B_TIP + np.array([bx - 10, 0], np.float32))[None])[0] / 4
            kq = (1.0, 0.3)[fb]
            c16 = (int(tip[0] * 16), int(tip[1] * 16))
            # impact read: hot core + short cross flare (vertical as strong as horizontal) + a small shock ring
            cv2.circle(em, c16, int(5 * 16), _col(GREEN_HOT * 2.4 * kq), -1, cv2.LINE_AA, 4)
            cv2.ellipse(em, c16, (int(20 * 16), int(1.3 * 16)), 0, 0, 360, _col(GREEN_HOT * 2.2 * kq), -1, cv2.LINE_AA, 4)
            cv2.ellipse(em, c16, (int(1.3 * 16), int(15 * 16)), 0, 0, 360, _col(GREEN_HOT * 2.0 * kq), -1, cv2.LINE_AA, 4)
            rr_ = (8.0, 13.0)[fb]
            cv2.circle(em, c16, int(rr_ * 16), _col(GREEN_HOT * (1.3, 0.55)[fb]), 1, cv2.LINE_AA, 4)

    # ---- letters
    poses = {}
    for L in "ARMY":
        ps = letter_pose(L, t)
        if ps is not None:
            poses[L] = ps
    settled = [L for L in poses if t - T_SLAM[L] > 0.35]
    moving = [L for L in poses if L not in settled]
    groups = []
    if settled:
        groups.append((settled, None))
    for L in moving:
        groups.append(([L], L))
    for letters, L in groups:
        smear = None
        if L is None:
            core = [xf(Mc @ Mu, p) for l in letters for p in LETTERS[l]]
            hot = 0.0
        else:
            t0 = T_SLAM[L]
            c = U2W(L_CEN[L])

            def polys_at(tau, extrap=False):
                s_, ang, dy, _ = letter_pose(L, tau, extrap)
                Ml = Mc @ mat_about(c[0], c[1], s_, ang, 0, dy) @ Mu
                return [xf(Ml, p) for p in LETTERS[L]]

            core = polys_at(t)
            if t < t0:
                # radial zoom smear: scale-space samples back over SHUT frames (bigger = earlier),
                # weights fade toward the oldest sample; the opaque core is drawn on top
                ns = 16
                smear = [(polys_at(t - DT * SHUT * k / (ns - 1), True), 1.0 - 0.85 * k / (ns - 1)) for k in range(ns)]
            hot = 1.0 if t < t0 else math.exp(-(t - t0) * 9)
        ops.append(("letters", core, smear, hot, L))
        ql = [np.round(xf(np.diag([0.25, 0.25, 1.0]), p) * 16).astype(np.int32) for p in core]
        k = 0.05 + (1.6 if L is None or t >= T_SLAM[L] else 0.9) * hot + logo_pulse(t)
        cv2.fillPoly(em, ql, _col(np.array([175, 235, 160], np.float32) * k), cv2.LINE_AA, 4)
    g = glint_fn(t, Mc)
    if g is not None and settled:
        mq = np.zeros((H // 4, W // 4), np.float32)
        for l in settled:
            for p in LETTERS[l]:
                cv2.fillPoly(mq, [np.round(xf(np.diag([0.25, 0.25, 1.0]) @ Mc @ Mu, p) * 16).astype(np.int32)], 1.0, cv2.LINE_AA, 4)
        band = g(0, 0, W, H)[::4, ::4]
        em += (mq * band)[..., None] * np.array([210, 255, 200], np.float32) * 0.9
    if bullet_op is not None:
        # a letter still dropping is closer to camera: it occludes the bullet. Exception: the A from its
        # second drop frame on (the bullet sits in front of its legs in the final mark, so no pop on landing)
        def occludes(o):
            if o[0] != "letters" or o[4] is None or t >= T_SLAM[o[4]]:
                return False
            return not (o[4] == "A" and t > T_SLAM["A"] - 1.5 * DT)
        idx = next((k for k, o in enumerate(ops) if occludes(o)), None)
        if idx is None:
            ops.append(bullet_op)
        else:
            ops.insert(idx, bullet_op)
    return ops, em


def draw_logo(f, ops, t, glint):
    for op in ops:
        if op[0] == "streaks":
            _, sp, cone = op
            for idx, (q, br, LL) in enumerate(sp):
                bb = clipbox(bbox_of([q], 3))
                if bb is None:
                    continue
                X0, Y0, X1, Y1 = bb
                cov = raster([q], X0, Y0, X1 - X0, Y1 - Y0)
                xr = np.arange(X0, X1, dtype=np.float32) + 0.5
                tipx, basex = q[:, 0].min(), q[:, 0].max()
                ramp = np.clip((xr - tipx) / max(basex - tipx, 1), 0, 1) ** 0.8
                a = cov * ramp[None, :]
                sub = f[Y0:Y1, X0:X1]
                col = GREEN * br + GREEN_DK * (1 - br)
                sub += (col - sub) * a[..., None]
            if cone is not None:
                bb = clipbox(bbox_of([cone], 3))
                if bb is not None:
                    X0, Y0, X1, Y1 = bb
                    cov = raster([cone], X0, Y0, X1 - X0, Y1 - Y0)
                    xr = np.arange(X0, X1, dtype=np.float32) + 0.5
                    tipx, basex = cone[:, 0].min(), cone[:, 0].max()
                    ramp = np.clip((xr - tipx) / max(basex - tipx, 1), 0, 1) ** 1.3
                    sub = f[Y0:Y1, X0:X1]
                    sub += (np.array([60, 92, 34], np.float32) - sub) * (cov * ramp[None, :] * 0.55)[..., None]
        elif op[0] == "letters":
            _, core, smear, hot, L = op
            allp = list(core) if smear is None else [p for polys, w in smear for p in polys] + list(core)
            bb = clipbox(bbox_of(allp, 3 if smear is None else 44))
            if bb is None:
                continue
            X0, Y0, X1, Y1 = bb
            w_, h_ = X1 - X0, Y1 - Y0
            cov = raster(core, X0, Y0, w_, h_)
            if smear is not None:
                # zoom smear (weighted average of the scale samples), under the solid core
                acc = np.zeros((h_, w_), np.float32)
                one = np.zeros((h_, w_), np.uint8)
                wsum = 0.0
                for polys, wk in smear:
                    one[:] = 0
                    pts = [np.round((q - np.array([X0, Y0], np.float32) - 0.5) * 16).astype(np.int32) for q in polys]
                    cv2.fillPoly(one, pts, 255, cv2.LINE_AA, 4)
                    acc += one.astype(np.float32) * np.float32(wk / 255.0)
                    wsum += wk
                sm = cv2.GaussianBlur(acc * np.float32(1.0 / wsum), (0, 0), 1.6)
                # dark contact shadow of the incoming letter so it separates from the letters below
                shp = np.zeros_like(cov)
                shp[8:] = cov[:-8]
                shd = cv2.GaussianBlur(np.maximum(shp, sm * 0.6), (0, 0), 12)
                sub = f[Y0:Y1, X0:X1]
                sub += (INK - sub) * (shd * 0.5)[..., None]
                cov = cov + np.clip(sm * 1.1, 0, 1) * 0.85 * (1 - cov)
            yy = (np.arange(Y0, Y1, dtype=np.float32)[:, None] - 336) / 264.0
            shade = 1.0 - 0.06 * np.clip(yy, 0, 1)
            col = WHITE[None, None, :] * (shade * letter_tex()[Y0:Y1, X0:X1])[..., None]
            if hot > 0.002:
                col = col + (np.float32(255) - col) * hot
            if glint is not None:
                g = glint(X0, Y0, X1, Y1)
                if g is not None:
                    col = col + (np.float32(255) - col) * (g * 0.8)[..., None]
            sub = f[Y0:Y1, X0:X1]
            sub += (col - sub) * cov[..., None]
        elif op[0] == "bullet":
            _, qs, blur = op
            bb = clipbox(bbox_of([qs["sil"]], 4 + blur // 2 + 2))
            if bb is None:
                continue
            X0, Y0, X1, Y1 = bb
            w, h = X1 - X0, Y1 - Y0
            cs = raster([qs["sil"]], X0, Y0, w, h)
            cc = raster([qs["casing"]], X0, Y0, w, h)
            cp = raster([qs["proj"]], X0, Y0, w, h)
            ch = raster([qs["hl"]], X0, Y0, w, h)
            rgb = np.empty((h, w, 3), np.float32)
            rgb[:] = C_OUT
            rgb += (GREEN_DK * 1.03 - rgb) * cc[..., None]
            hotp = 0.3 * math.exp(-max(t - T_BLAND, 0) * 5)
            rgb += (GREEN + (GREEN_HOT - GREEN) * hotp - rgb) * cp[..., None]
            rgb += (C_HL - rgb) * ch[..., None]
            if glint is not None:
                g = glint(X0, Y0, X1, Y1)
                if g is not None:
                    rgb += (np.float32(250) - rgb) * (g * (cp + ch) * 0.6)[..., None]
            pm = rgb * cs[..., None]
            al = cs
            if blur > 2:
                k = np.ones((1, blur), np.float32) / blur
                pm = cv2.filter2D(pm, -1, k, borderType=cv2.BORDER_CONSTANT)
                al = cv2.filter2D(al, -1, k, borderType=cv2.BORDER_CONSTANT)
            sub = f[Y0:Y1, X0:X1]
            sub *= (1 - al)[..., None]
            sub += pm


@lru_cache(maxsize=1)
def letter_tex():
    g = cv2.resize(grunge(W // 2, H // 2, 131), (W, H), interpolation=cv2.INTER_LINEAR)
    n = value_noise(W // 2, H // 2, 30, 3, 132)
    n = cv2.resize(n, (W, H), interpolation=cv2.INTER_LINEAR)
    return (0.955 + 0.03 * g + 0.015 * n).astype(np.float32)


def glint_fn(t, Mc):
    """Diagonal specular sweep across the logo at ~4.7 s (screen-space band)."""
    gp, amp = prog(t, 1.32, 1.78), 1.0
    if not 0 < gp < 1:
        gp, amp = prog(t, 4.6, 5.3), 0.75
    if not 0 < gp < 1:
        return None
    x_a = xf(Mc, U2W((-60, 0))[None])[0][0]
    x_b = xf(Mc, U2W((1250, 0))[None])[0][0]
    pos = x_a + (x_b - x_a) * ease_in_out(gp)

    def g(X0, Y0, X1, Y1):
        xx = np.arange(X0, X1, dtype=np.float32)[None, :]
        yy = np.arange(Y0, Y1, dtype=np.float32)[:, None]
        d = (xx + 0.45 * (yy - 470)) - pos
        return (np.exp(-(d / 22.0) ** 2) * 0.55 + np.exp(-(d / 70.0) ** 2) * 0.12) * amp
    return g


# ---------------------------------------------------------------- fx
def glitch_fx(frame, amount, seed, y_lo=0.15, y_hi=0.85, soft=False):
    """soft=True: idle micro-glitch (thin offset slivers only: no black/green bars, no ghost)."""
    rng = np.random.default_rng(seed)
    src = frame
    o = frame.copy()
    for _ in range(int(5 + 14 * amount)):
        y = int(rng.integers(int(H * y_lo), int(H * y_hi)))
        h = int(rng.integers(3, int(8 + 50 * amount)))
        s = int(rng.normal(0, 80 * amount))
        o[y:y + h] = np.roll(src[y:y + h], s, axis=1)
        r = rng.random()
        if soft:
            continue
        if r < 0.2:
            o[y:y + h] = tint_mono(o[y:y + h], GREEN, 1.0) * 1.1
        elif r < 0.28:
            o[y:y + h] *= 0.2
    if soft:
        return o
    for _ in range(int(1 + 3 * amount)):
        bw, bh = int(rng.integers(80, 340)), int(rng.integers(16, 80))
        x, y = int(rng.integers(0, W - bw)), int(rng.integers(int(H * y_lo), int(H * y_hi) - bh))
        blk = o[y:y + bh, x:x + bw]
        sm = cv2.resize(blk, (max(1, bw // 14), max(1, bh // 14)), interpolation=cv2.INTER_AREA)
        o[y:y + bh, x:x + bw] = cv2.resize(sm, (bw, bh), interpolation=cv2.INTER_NEAREST)
    gh = np.roll(o, int(8 + 22 * amount), axis=1)
    lum = gh @ np.array([0.3, 0.6, 0.1], np.float32)
    o += lum[..., None] * (np.array([0.10, 0.32, 0.05], np.float32) * amount)
    return o


def fast_bloom(frame, threshold, sigma, strength, extra_q=None):
    small = cv2.resize(frame, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    hi = cv2.GaussianBlur(np.clip(small - threshold, 0, None), (0, 0), sigma / 4) * strength
    if extra_q is not None:
        hi += extra_q
    frame += cv2.resize(hi, (W, H), interpolation=cv2.INTER_LINEAR)
    return frame


def collapse(frame, t):
    """CRT power-off: squash to a hot line, line shrinks to a dot, dies."""
    out = blank(INK)
    cy = H / 2
    p1 = prog(t, T_COL - DT, T_COL + 0.2)
    p2 = prog(t, T_COL + 0.2, T_COL + 0.38)
    p3 = prog(t, T_COL + 0.40, T_BLACK)
    if p1 < 1:
        e = p1 ** 1.6
        hh = max(2, int(round(H * (1 - e * 0.997))))
        ww = int(round(W * (1 + 0.04 * e)))
        sm = cv2.resize(frame, (ww, hh), interpolation=cv2.INTER_AREA)
        # luminance boost only (hot phosphor), per-pixel gain capped so saturated greens keep their hue
        dlt = np.maximum(sm - INK, 0)
        cap = (255.0 - INK.max()) / np.maximum(dlt.max(axis=2, keepdims=True), 1e-3)
        sm = INK + dlt * np.minimum(np.float32(1 + 2.5 * e), cap)
        x0 = (W - ww) // 2
        y0 = int(cy - hh / 2)
        src = sm[:, max(0, -x0):max(0, -x0) + W]
        out[y0:y0 + hh, max(0, x0):max(0, x0) + src.shape[1]] = src
        lw = 1.0
        li = 0.7 + 0.75 * e
    else:
        lw = 1 - ease_in_cubic(p2)
        li = 1.45 * (1 - ease_in_out(p3)) if p2 >= 1 else 1.45
    if lw > 0.002 or p3 < 1:
        half = max(W / 2 * lw, 3.0 * (1 - p3))
        xs = np.arange(W, dtype=np.float32)
        prof_x = np.clip((half - np.abs(xs - W / 2)) / max(half * 0.25, 2), 0, 1)
        ys = np.arange(-60, 61, dtype=np.float32)
        core = np.exp(-(ys / 1.6) ** 2)
        halo = np.exp(-(ys / 14.0) ** 2) * 0.35
        band = (core[:, None] * prof_x[None, :])[..., None] * (WHITE * 0.7 + GREEN_HOT * 0.3) \
            + (halo[:, None] * prof_x[None, :])[..., None] * ADD_G
        y0 = int(cy - 60)
        out[y0:y0 + 121] += band * li
        if p2 > 0:
            dot = np.exp(-((xs - W / 2) / (30 + 300 * lw)) ** 2)
            out[y0:y0 + 121] += (halo[:, None] * dot[None, :])[..., None] * ADD_G * li * 0.8
    return np.clip(out, 0, 255)


# ---------------------------------------------------------------- render
def render(t, ctx):
    fr = int(round(t * FPS))
    if abs(t * FPS - fr) < 1e-3:
        t = fr / FPS
    if t >= T_BLACK:
        return blank(INK)
    if t >= T_COL:
        pre = _render_main(min(t, T_COL + 0.2), fr)
        return collapse(pre, t)
    return _render_main(t, fr)


@lru_cache(maxsize=1)
def wave_grain():
    """Quarter-res wall grain for the pressure wave: high-passed texture, so the light rakes the relief."""
    _, _, _, tex4 = wall()
    hp = tex4 - cv2.GaussianBlur(tex4, (0, 0), 3.0)
    return np.clip(tex4 + 5.0 * hp, 0, None).astype(np.float32) ** 2


@lru_cache(maxsize=1)
def _grids():
    yy4, xx4 = np.mgrid[0:H // 4, 0:W // 4].astype(np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    return xx4 * 4 + 1.5, yy4 * 4 + 1.5, xx, yy


def shock_warp(frame, Mbg, d):
    """Sub-drop pressure wave as a short radial refraction of the wall plate (first frames after the A slam)."""
    c = xf(Mbg, U2W(L_CEN["A"])[None])[0]
    xx4, yy4, xx, yy = _grids()
    dx, dy = xx4 - c[0], yy4 - c[1]
    rr = np.sqrt((dx * 0.85) ** 2 + dy ** 2) + 1e-3
    R = 4 * (30 + 470 * ease_out_cubic(d / 0.5))
    wd = 26 + 60 * d
    k = (1 - d / (5 * DT)) ** 1.5
    disp = (np.exp(-((rr - R) / wd) ** 2) * ((rr - R) / wd) * 16.0 * k).astype(np.float32)
    ox = cv2.resize(dx / rr * disp, (W, H), interpolation=cv2.INTER_LINEAR)
    oy = cv2.resize(dy / rr * disp, (W, H), interpolation=cv2.INTER_LINEAR)
    return cv2.remap(frame, xx - ox, yy - oy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def _render_main(t, fr):
    Mc, z = camera(t)
    Mbg, _ = camera(t, 0.45)
    bgk = ease_out_cubic(prog(t, 0.0, 0.5))
    lk = glow_level(t)
    D, BASE, SG, tex4 = wall()

    # ---- world background
    if bgk >= 1:
        world = BASE.copy()
    else:
        world = INK + D * bgk
    world += SG * lk
    # quarter-res light: smoke + bullet pass light + slam flash
    dens = smoke_density(t)
    h4, w4 = dens.shape
    lkb = glow_level(t, pulses=False)
    add4 = (dens * (0.2 + 0.45 * min(lkb, 1.6)) * bgk)[..., None] * np.array([26, 32, 24], np.float32)
    yy4, xx4 = np.ogrid[0:h4, 0:w4]
    if T_BIN <= t < 0.9:
        bp = U2W(B_TIP + np.array([bullet_dx(t), 0]))
        k = 1.0 if t < T_BLAND else math.exp(-(t - T_BLAND) * 5)
        if int(round(t * FPS)) == FR_BLAND:
            k += 0.9
        g = np.exp(-(((xx4 - bp[0] / 4 + 20) / 70) ** 2 + ((yy4 - bp[1] / 4) / 30) ** 2)).astype(np.float32)
        add4 += ((0.3 + 0.7 * tex4) * g * k)[..., None] * np.array([30, 85, 22], np.float32)
    for L, t0, a0, amp, wgt in SLAMS:
        d = t - t0
        if 0 <= d < 0.6:
            k = wgt * math.exp(-d * 14)
            c = U2W(L_CEN[L]) / 4
            g = np.exp(-(((xx4 - c[0]) / 95) ** 2 + ((yy4 - c[1]) / 60) ** 2)).astype(np.float32)
            add4 += ((0.25 + 0.75 * tex4) * g * k)[..., None] * np.array([42, 92, 32], np.float32)
        if abs(d) < DT * 0.5:                          # hit frame: radial impact light centred on the letter
            c4 = U2W(L_CEN[L])
            rr2 = ((xx4 * 4.0 - c4[0]) ** 2 + (yy4 * 4.0 - c4[1]) ** 2).astype(np.float32)
            add4 += ((0.35 + 0.65 * tex4) * np.exp(-rr2 / (2 * 300.0 ** 2)) * wgt)[..., None] * np.array([48, 92, 36], np.float32)
    d = t - T_SLAM["A"]
    if 0 <= d < 0.5:                                  # sub-drop pressure wave across the wall
        c = U2W(L_CEN["A"]) / 4
        rr = np.sqrt(((xx4 - c[0]) * 0.85) ** 2 + (yy4 - c[1]) ** 2).astype(np.float32)
        R = 30 + 470 * ease_out_cubic(d / 0.5)
        ring = np.exp(-((rr - R) / (6 + 18 * d)) ** 2) * (1 - d / 0.5) ** 2
        # light raking across the concrete: only the raised grain catches it (high-passed wall texture)
        add4 += (wave_grain() * ring * 0.5)[..., None] * np.array([30, 58, 24], np.float32)
    world += cv2.resize(add4, (W, H), interpolation=cv2.INTER_LINEAR)
    draw_cracks(world, t)
    hk = ease_out_cubic(prog(t, 0.0, 0.9)) * (1.0 + 0.06 * math.sin(t * 2 * math.pi / 1.9) + 0.35 * slam_k(t, 6))
    if hk > 0.003:
        halftone_corners(world, hk, 0.32)
    draw_splats(world, t)
    draw_star(world, t, fr)

    frame = cv2.warpAffine(world, Mbg[:2], (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    d = t - T_SLAM["A"]
    if DT * 0.5 < d < DT * 4.5:                       # pressure wave refracts the wall for 4 frames
        frame = shock_warp(frame, Mbg, d)

    # ---- logo glow (under) + logo
    ops, em = logo_parts(t, Mc)
    gl = (cv2.GaussianBlur(em, (0, 0), 1.6) * 0.5 + cv2.GaussianBlur(em, (0, 0), 6) * 0.42
          + cv2.GaussianBlur(em, (0, 0), 20) * 0.2)
    gl *= (0.75 + 0.25 * min(lk, 1.5))
    frame += cv2.resize(gl, (W, H), interpolation=cv2.INTER_LINEAR)
    # letters still dropping are closer to camera than the dust/chips kicked up by earlier slams
    dropping = [o for o in ops if o[0] == "letters" and o[4] is not None and t < T_SLAM[o[4]]]
    gfn = glint_fn(t, Mc)
    draw_logo(frame, [o for o in ops if not any(o is d_ for d_ in dropping)], t, gfn)
    draw_dust(frame, t, Mc)
    draw_logo(frame, dropping, t, gfn)
    draw_tagline(frame, t, Mc, z)
    draw_reticle(frame, t, Mc, z)
    draw_motes(frame, Mc, t, bgk * (0.6 + 0.4 * min(lk, 1.2)))

    # floor light line
    ll = ease_out_cubic(prog(t, 0.05, 0.8))
    if ll > 0.01:
        light_streak(frame, 1036, (0.55 + 0.08 * math.sin(t * 3.1) + 0.3 * slam_k(t, 8)) * ll, GREEN, 2, 0.92 * ll, AX)
        if t > 1.5:
            ph = ((t - 1.5) % 2.6) / 2.6
            xh = AX - W * 0.46 + W * 0.92 * ease_in_out(ph)
            light_streak(frame, 1036, 0.55 * math.sin(math.pi * ph) * ll, GREEN_HOT, 2, 0.12, xh)

    draw_hud(frame, t, fr)

    # hit frame: 1-frame contrast punch (blacks stay black)
    for L, t0, a0, amp, wgt in SLAMS:
        if abs(t - t0) < DT * 0.5:
            frame -= INK
            frame *= np.float32(1.0 + 0.12 * wgt)
            frame += INK

    frame = fast_bloom(frame, 215, 18, 0.28, fg_haze_q(t, bgk))

    # glitches
    # idle micro-glitches: one frame each, confined to a band (wordmark mid-line at 4.53, HUD row at 5.77)
    if fr == 136:
        frame = glitch_fx(frame, 0.1, 7000 + fr, 0.40, 0.55, soft=True)
    if fr == 173:
        frame = glitch_fx(frame, 0.1, 7000 + fr, 0.875, 0.945, soft=True)
    g0 = int(round(T_GL * FPS))
    if g0 <= fr < g0 + 4:
        frame = glitch_fx(frame, (0.9, 1.3, 0.8, 1.1)[fr - g0], 7100 + fr, 0.05, 0.95)
    return np.clip(frame, 0, 255)
