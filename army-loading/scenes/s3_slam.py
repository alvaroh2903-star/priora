"""Scene 3 · s3_slam (4.5 s) — kinetic distressed headline "UM TIRO. / UMA BAIXA."

Beat sheet (local seconds):
  0.00  cracked black frame handed over from scene 2; cracks fade, halftone
        corners breathe in, thin green floor line glows on
  0.20  "UM TIRO." drops in at 1.25x (zoom-blurred, white-hot) ...
  0.30  ... IMPACT: hard stop, one inverted flash frame, the white-hot type
        cools into worn bone print, dust burst + chips off the baseline,
        decaying shake, halftone corners pulse. Line sits big and alone.
  1.10  "UMA BAIXA." drops in under it ...
  1.20  ... IMPACT: line 1 is knocked up and down-scaled into the final
        justified two-line block; same flash / dust / shake / pulse
  2.00  SPRAY: green graffiti "ARMY" tag sprays on diagonally across the lower
        right of the headline (moving nozzle front with live mist), then the
        underline swoosh
  2.2-4.0  paint drips run down from the tag
  2.60-3.30  caption blocks type in (left, then right) with a green cursor
  3.40  CLICK: hand-drawn green reticle snaps onto the "O" of TIRO, ping ring,
        then tightens
  0-4.2 slow push-in drift the whole time
  4.20-4.50  WHOOSH: whip-pan to the right — everything smears out to the left
        (scene 4 opens on a matching settling smear from the right)

All type / tag / reticle layers are built once (2x supersampled, distressed)
and cached; per frame only transforms + compositing happen.
"""
from lib import *

DUR = 4.5
CUES = [(0.3, "impact"), (1.2, "impact"), (2.0, "spray"), (3.4, "click"), (4.2, "whoosh")]

T1, T2, TSP, TCL, TWH = 0.3, 1.2, 2.0, 3.4, 4.2
DT = 1.0 / FPS

ANTON = os.path.join(FONTS, "Anton-Regular.ttf")
TAGFONT = os.path.join(FONTS, "PermanentMarker-Regular.ttf")
OSWALD = os.path.join(FONTS, "Oswald.ttf")

HEAD_PX = 380          # final Anton size -> cap ~333 px, "UMA BAIXA." ~1645 px wide
STAGE = 1.28           # line 1 is built (and first shown) this much bigger
CAP_H = 333
LINE_GAP = 30
L1_TOP = 92            # final cap-top of line 1 (layout space, before camera)
STAGE_TOP = 290        # cap-top of the big line 1 while alone

CAP_PX = 44
CAP_LH = 50
CAP_COL = np.array([226, 222, 212], np.float32)
DUST_C = np.array([168, 165, 158], np.float32)


# ================================================================ helpers
def _ss_text_mask(text, path, size, ss=2, pad=24):
    f = ImageFont.truetype(path, int(size * ss))
    x0, y0, x1, y1 = f.getbbox(text)
    p = pad * ss
    w, h = x1 - x0 + 2 * p, y1 - y0 + 2 * p
    w += (-w) % ss
    h += (-h) % ss
    im = Image.new("L", (w, h), 0)
    ImageDraw.Draw(im).text((p - x0, p - y0), text, font=f, fill=255)
    return np.asarray(im, np.float32) / 255.0


def _dot_holes(w, h, cell, angle, amount):
    """Halftone holes: dot radius grows with amount (0..1 map)."""
    return _dot_holes_rows(w, h, 0, cell, angle, amount)


def _dot_holes_rows(w, h, r0, cell, angle, amount):
    """_dot_holes restricted to rows r0..h (same phase as the full grid)."""
    a = math.radians(angle)
    c, sn = math.cos(a) / cell, math.sin(a) / cell
    xs = np.arange(w, dtype=np.float32)[None, :]
    ys = np.arange(r0, h, dtype=np.float32)[:, None]
    u = xs * c + ys * sn
    v = ys * c - xs * sn
    u -= np.floor(u) + 0.5
    v -= np.floor(v) + 0.5
    d = np.sqrt(u * u + v * v)
    m = (amount * 0.72 - d) * (cell * 0.9) + 0.5
    np.clip(m, 0, 1, out=m)
    m *= amount > 0.03
    return m


def _xform(lay, scale, angle=0.0):
    """Scale/rotate a layer about its centre (premultiplied warp).
    Returns the new layer; its centre corresponds to the old centre."""
    h, w = lay.shape[:2]
    if angle:
        d = int(math.ceil(math.hypot(w, h) * scale)) + 8
        ow, oh = d, d
    else:
        ow, oh = int(math.ceil(w * scale)) + 8, int(math.ceil(h * scale)) + 8
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, scale)
    M[0, 2] += ow / 2 - w / 2
    M[1, 2] += oh / 2 - h / 2
    o = cv2.warpAffine(premul(lay), M, (ow, oh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return unpremul(o)


def _col(c):
    return tuple(float(v) for v in c)


# ================================================================ headline type
def _streaks(w, h, ang_deg, along, across, seed):
    """Anisotropic noise 0..1: long features along ang_deg, short across."""
    D = int(math.hypot(w, h)) + 4
    g = np.random.default_rng(seed).random((max(2, int(D / across)), max(2, int(D / along)))).astype(np.float32)
    g = cv2.resize(g, (D, D), interpolation=cv2.INTER_CUBIC)
    M = cv2.getRotationMatrix2D((D / 2, D / 2), ang_deg, 1.0)
    M[0, 2] += w / 2 - D / 2
    M[1, 2] += h / 2 - D / 2
    return cv2.warpAffine(g, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def _vn(w, h, scale, octaves, seed, down=2):
    """Low-frequency value noise computed at 1/down resolution, upsampled."""
    if down <= 1:
        return value_noise(w, h, scale, octaves, seed)
    n = value_noise(max(2, w // down), max(2, h // down), scale / down, octaves, seed)
    return cv2.resize(n, (w, h), interpolation=cv2.INTER_LINEAR)


@lru_cache(maxsize=4)
def _line(text, seed, px):
    """Distressed bone headline line at Anton size px (poster print look:
    eaten edges, clumped grit thickest near the edges, halftone fade at the
    feet, faint mesh, scratches + vertical streaks). Returns dict with the
    worn layer, the white-hot clean layer and the ink bbox."""
    ss = 2
    sc = px / 380.0
    mk = _ss_text_mask(text, ANTON, px, ss, pad=28)
    h2, w2 = mk.shape
    rng = np.random.default_rng(seed)
    # --- rough, eaten print edges
    n_fine = value_noise(w2, h2, 4 * sc, 3, seed + 1)
    n_mid = _vn(w2, h2, 14 * sc, 3, seed + 3, 2)
    n_chip = _vn(w2, h2, 34 * sc, 3, seed + 2, 2)
    mb = cv2.GaussianBlur(mk, (0, 0), 2.0 * sc)
    chip = np.clip((n_chip - 0.70) * 4, 0, 1)
    rough = np.clip((mb - 0.5 + (n_fine - 0.5) * 0.7 + (n_mid - 0.5) * 0.35 - chip * 0.55) * 8 + 0.5, 0, 1)
    # --- grit density: clumps + edges
    inner = cv2.GaussianBlur(mk, (0, 0), 12 * sc)
    edge = np.clip((0.93 - inner) * 2.4, 0, 1) * mk
    clump = _vn(w2, h2, 80 * sc, 4, seed + 6, 4)
    dens = np.clip((clump - 0.35) * 1.8, 0, 1) * 0.75 + edge * 0.7
    sm = (rng.random((h2 // 2, w2 // 2)) < 0.07).astype(np.float32)
    sm = cv2.GaussianBlur(cv2.resize(sm, (w2, h2), interpolation=cv2.INTER_NEAREST), (0, 0), 0.7) * 1.6
    bg = (rng.random((h2 // 5, w2 // 5)) < 0.05).astype(np.float32)
    bg = cv2.resize(bg, (w2, h2), interpolation=cv2.INTER_LINEAR)
    bg = np.clip((cv2.GaussianBlur(bg, (0, 0), 1.2) - 0.08) * 6, 0, 1)
    speck = np.clip((sm + bg) * np.clip(dens * 1.3, 0, 1), 0, 1)
    # --- faint mesh + halftone fade at the feet of the letters
    mesh = _dot_holes(w2, h2, 11, 45.0, np.clip((_vn(w2, h2, 200 * sc, 3, seed + 7, 4) - 0.45) * 1.4, 0, 0.42))
    ys = np.nonzero(mk.max(1) > 0.5)[0]
    ty, by = ys.min(), ys.max()
    yy = (np.arange(h2, dtype=np.float32)[:, None] - ty) / max(by - ty, 1)
    bot = np.clip((yy - 0.70) / 0.30, 0, 1) * np.clip(_vn(w2, h2, 140 * sc, 3, seed + 9, 4) * 1.8 - 0.5, 0, 1)
    r0 = int(ty + 0.69 * (by - ty))
    dots = np.zeros((h2, w2), np.float32)
    dots[r0:] = _dot_holes_rows(w2, h2, r0, 14, 45.0, np.clip(bot[r0:], 0, 1))
    # --- a few scraped-off patches
    wear = _vn(w2, h2, 120 * sc, 5, seed + 4, 2)
    holes = np.clip((wear + (n_mid - 0.5) * 0.12 - 0.785) * 14, 0, 1)
    # --- scratches + vertical streaks
    simg = np.zeros((h2, w2), np.uint8)
    for _ in range(int(55 * len(text) / 8 * sc)):
        x0, y0 = rng.uniform(0, w2), rng.uniform(0, h2)
        ang = rng.normal(-0.4, 0.5)
        L = rng.uniform(10, 70) * ss * sc
        cv2.line(simg, (int(x0 * 16), int(y0 * 16)), (int((x0 + L * math.cos(ang)) * 16), int((y0 + L * math.sin(ang)) * 16)),
                 int(rng.uniform(120, 230)), 1, cv2.LINE_AA, 4)
    for _ in range(int(45 * len(text) / 8)):
        x0, y0 = rng.uniform(0, w2), rng.uniform(0, h2)
        L = rng.uniform(30, 240) * sc * 2
        cv2.line(simg, (int(x0 * 16), int(y0 * 16)), (int((x0 + rng.normal(0, 4)) * 16), int((y0 + L) * 16)),
                 int(rng.uniform(70, 170)), 1, cv2.LINE_AA, 4)
    scr = simg.astype(np.float32) / 255.0
    tex = (1 - 0.95 * holes) * (1 - 0.9 * dots) * (1 - 0.6 * mesh) * (1 - 0.92 * speck) * (1 - 0.8 * scr)
    a2 = rough * np.clip(tex, 0, 1)
    w1, h1 = w2 // ss, h2 // ss
    alpha = cv2.resize(a2, (w1, h1), interpolation=cv2.INTER_AREA)
    clean = cv2.resize(rough, (w1, h1), interpolation=cv2.INTER_AREA)
    tone = value_noise(w1, h1, 140 * sc, 4, seed + 8)
    col = BONE[None, None, :] * (0.86 + 0.16 * tone[..., None])
    lay = np.dstack([col, alpha]).astype(np.float32)
    hot = np.dstack([np.broadcast_to(WHITE, (h1, w1, 3)), clean]).astype(np.float32)
    yk, xk = np.nonzero(clean > 0.3)
    bbox = (int(xk.min()), int(yk.min()), int(xk.max()) + 1, int(yk.max()) + 1)
    return {"lay": lay, "hot": hot, "bbox": bbox, "w": w1, "h": h1}


def _scaled(L, s):
    """Resampled copy of a line dict (premultiplied INTER_AREA)."""
    out = {}
    for k in ("lay", "hot"):
        out[k] = unpremul(resize_layer(premul(L[k]), s))
    h, w = out["lay"].shape[:2]
    out["w"], out["h"] = w, h
    out["bbox"] = tuple(int(round(v * s)) for v in L["bbox"])
    return out


@lru_cache(maxsize=1)
def _lines():
    L1big = _line("UM TIRO.", 11, int(HEAD_PX * STAGE))
    L1 = _scaled(L1big, 1 / STAGE)
    L2 = _line("UMA BAIXA.", 23, HEAD_PX)
    return L1big, L1, L2


def _draw_line(f, L, s, icx, itop, hot=0.0, opacity=1.0):
    """Draw line L scaled by s about its centre so that its ink box is
    horizontally centred on icx with cap top at itop."""
    bx0, by0, bx1, by1 = L["bbox"]
    w, h = L["w"], L["h"]
    if hot > 0.001:
        lay = L["lay"].copy()
        k = 1 - hot
        lay[..., :3] = L["hot"][..., :3] + (L["lay"][..., :3] - L["hot"][..., :3]) * k
        lay[..., 3] = L["hot"][..., 3] + (L["lay"][..., 3] - L["hot"][..., 3]) * k
    else:
        lay = L["lay"]
    if abs(s - 1) < 0.0015:
        over(f, lay, icx - (bx0 + bx1) / 2, itop - by0, opacity)
        return
    o = _xform(lay, s)
    oh, ow = o.shape[:2]
    x = icx - (ow / 2 + s * ((bx0 + bx1) / 2 - w / 2))
    y = itop - (oh / 2 + s * (by0 - h / 2))
    over(f, o, x, y, opacity)


# ================================================================ background
@lru_cache(maxsize=1)
def _bg():
    n = value_noise(W, H, 260, 6, 31)
    fn = value_noise(W, H, 4, 2, 32)
    b = np.empty((H, W, 3), np.float32)
    b[:] = INK
    b += ((n - 0.5) * 10 + (fn - 0.5) * 5)[..., None]
    return b


@lru_cache(maxsize=1)
def _halftone_maps():
    cw, ch = 980, 700
    cell = 14
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    a = math.radians(45)
    u = xx * math.cos(a) + yy * math.sin(a)
    v = -xx * math.sin(a) + yy * math.cos(a)
    fu = (u / cell) % 1 - 0.5
    fv = (v / cell) % 1 - 0.5
    d = np.sqrt(fu * fu + fv * fv).astype(np.float32)
    nz = value_noise(cw, ch, 110, 3, 41)
    g = 1 - np.clip(np.hypot(xx / cw, yy / ch) * 1.05, 0, 1)
    g = np.clip(g * (0.6 + 0.7 * nz), 0, 1) ** 1.35
    return d, g.astype(np.float32), cell


def _halftone_corners(f, k, opacity):
    d, g, cell = _halftone_maps()
    ch, cw = d.shape
    m = np.clip((np.minimum(g * (0.62 * k), 0.52) - d) * cell * 0.9 + 0.5, 0, 1) * (g > 0.01)
    m *= opacity
    tl = f[:ch, :cw]
    tl += (BONE - tl) * m[..., None]
    br = f[H - ch:, W - cw:]
    br += (BONE - br) * (m[::-1, ::-1] * 0.8)[..., None]


@lru_cache(maxsize=1)
def _cracks():
    m = crack_mask(W, H, W * 0.52, H * 0.47, seed=7, branches=17, progress=1.0, thickness=2)
    m2 = crack_mask(W, H, W * 0.52, H * 0.47, seed=8, branches=9, progress=0.55, thickness=1)
    return np.clip(m + m2 * 0.7, 0, 1)


_HAZE_C = np.array([64, 80, 56], np.float32)


def _haze(f, t):
    """Faint drifting green-grey haze (half-res field, scrolled)."""
    fld = smoke_field(W // 2, H // 2, 3)
    hw, hh = W // 2, H // 2
    tt = t + 3.0
    ox = int((tt * 13) % hw)
    oy = int((tt * -3.5) % hh)
    crop = np.roll(np.roll(fld, -oy, 0), -ox, 1)[:hh, :hw]
    a = np.clip((crop - 0.45) * 2.2, 0, 1) * 0.09
    a = cv2.resize(a, (W, H), interpolation=cv2.INTER_LINEAR)
    f += (_HAZE_C - f) * a[..., None]


# ================================================================ dust + chips
@lru_cache(maxsize=1)
def _dust_tex():
    n = value_noise(W // 2, H // 2, 34, 4, 51)
    n = np.clip((n - 0.40) * 2.4, 0, 1) ** 1.3
    return cv2.resize(n, (W, H), interpolation=cv2.INTER_LINEAR)


def _dust(f, t, T, x0, x1, yb, seed):
    """Dust burst + chips from the baseline (yb) of a slammed line."""
    dt = t - T
    if dt < 0 or dt > 1.3:
        return
    rng = np.random.default_rng(seed)
    q = 4
    can = np.zeros((H // q, W // q), np.float32)
    n = 34
    xs = rng.uniform(x0, x1, n)
    rel = (xs - (x0 + x1) / 2) / ((x1 - x0) / 2)
    vx = rel * rng.uniform(80, 520, n) + rng.normal(0, 60, n)
    vy = -rng.uniform(20, 140, n)
    r0 = rng.uniform(14, 34, n)
    life = rng.uniform(0.7, 1.3, n)
    dmp = (1 - math.exp(-dt * 6)) / 6
    for i in range(n):
        lf = dt / life[i]
        if lf >= 1:
            continue
        px = xs[i] + vx[i] * dmp
        py = yb + 4 + vy[i] * dmp - 22 * dt
        rr = r0[i] * (1 + 2.4 * ease_out_cubic(min(dt * 1.8, 1)))
        a = (1 - lf) ** 1.8 * min(dt * 45, 1)
        cv2.ellipse(can, (int(px / q), int(py / q)), (max(1, int(rr * 1.8 / q)), max(1, int(rr * 0.55 / q))), 0, 0, 360, a, -1, cv2.LINE_AA)
    can = cv2.GaussianBlur(can, (0, 0), 2.5)
    y0, y1 = int(max(yb - 240, 0)), int(min(yb + 150, H))
    big = cv2.resize(can, (W, H), interpolation=cv2.INTER_LINEAR)[y0:y1]
    ox = int(dt * 30)
    tx = np.roll(_dust_tex()[y0:y1], -ox, axis=1)
    a = np.clip(big * tx, 0, 1) * 0.36
    sub = f[y0:y1]
    sub += (DUST_C - sub) * a[..., None]
    # fine chalk dust + chips, ballistic with drag
    m = 220
    cx = rng.uniform(x0, x1, m)
    rel = (cx - (x0 + x1) / 2) / ((x1 - x0) / 2)
    cvx = rel * rng.uniform(100, 900, m) + rng.normal(0, 140, m)
    cvy = -rng.uniform(60, 600, m)
    grav = rng.uniform(300, 1300, m)
    sz = rng.uniform(0.7, 2.6, m)
    br = rng.uniform(0.4, 1.0, m)
    lifes = rng.uniform(0.35, 1.0, m)
    dd = (1 - math.exp(-dt * 3.0)) / 3.0
    for i in range(m):
        fade = clamp(1 - dt / lifes[i])
        if fade <= 0:
            continue
        px = cx[i] + cvx[i] * dd
        py = yb - 6 + cvy[i] * dd + 0.5 * grav[i] * dt * dt
        if not (0 <= px < W and 0 <= py < H):
            continue
        a = fade * br[i]
        bgc = f[int(py), int(px)]
        cv2.circle(f, (int(px * 4), int(py * 4)), max(1, int(sz[i] * 4)), _col(bgc + (BONE - bgc) * a), -1, cv2.LINE_AA, 2)


# ================================================================ graffiti tag
TAG_ANG = 12.0          # degrees, rising to the right
TAG_X, TAG_Y = 1418, 724   # where the centre of the lettering lands (layout space)


@lru_cache(maxsize=1)
def _tag():
    """Green spray/brush 'ARMY' tag: italic marker caps + underline swoosh,
    bristle-eaten edges, overspray, reveal-time map and drip origins."""
    ss = 2
    mk = _ss_text_mask("ARMY", TAGFONT, 204, ss, pad=30)
    h, w = mk.shape
    CW, CH = 2300, 1500
    sh = -0.34
    A = np.array([[1.0, sh, 0], [0, 1.45, 0], [0, 0, 1]], np.float64)
    R = np.vstack([cv2.getRotationMatrix2D((0, 0), TAG_ANG, 1.0), [0, 0, 1]])
    T0 = np.array([[1, 0, -w / 2], [0, 1, -h / 2], [0, 0, 1]], np.float64)
    T1_ = np.array([[1, 0, CW / 2], [0, 1, CH / 2], [0, 0, 1]], np.float64)
    lt = cv2.warpAffine(mk, (T1_ @ R @ A @ T0)[:2], (CW, CH), flags=cv2.INTER_LINEAR)
    # underline swoosh: tapered brush stroke, flicking up past the Y
    sw = np.zeros((CH, CW), np.float32)
    P0 = np.array([-w * 0.56, h * 0.42])
    P1 = np.array([-w * 0.05, h * 0.50])
    P2 = np.array([w * 0.56, h * 0.16])
    N = 140
    Ms = (T1_ @ R @ np.array([[1.0, sh, 0], [0, 1.0, 0], [0, 0, 1]]))[:2]
    for i in range(N + 1):
        s = i / N
        p = (1 - s) ** 2 * P0 + 2 * (1 - s) * s * P1 + s * s * P2
        q = Ms @ np.array([p[0], p[1], 1.0])
        r = ss * (3 + 15 * min(1, s * 4) ** 0.6 * (1 - s) ** 1.1 + 2.5 * (1 - s))
        cv2.circle(sw, tuple(np.round(q * 16).astype(int)), int(r * 16), 1.0, -1, cv2.LINE_AA, 4)

    def brush(mask, ang, seed):
        b = cv2.GaussianBlur(mask, (0, 0), 5)
        st = _streaks(CW, CH, ang, 260, 3.2, seed)
        e = b - 0.5 + (st - 0.5) * 0.9 * np.clip(1.2 - b, 0, 1)
        return np.clip(e * 5 + 0.5, 0, 1) * (mask > 0.02)

    lt = brush(lt, TAG_ANG + 76 + math.degrees(math.atan(-sh)) * 0, 81)
    sw = brush(sw, TAG_ANG + 8, 82)
    nz = value_noise(CW, CH, 4, 2, 61)
    ero = 1 - np.clip((nz - 0.74) * 4, 0, 1) * 0.5
    w1, h1 = CW // ss, CH // ss
    lt1 = cv2.resize(lt * ero, (w1, h1), interpolation=cv2.INTER_AREA)
    sw1 = cv2.resize(sw * ero, (w1, h1), interpolation=cv2.INTER_AREA)
    body = np.maximum(lt1, sw1)
    ys, xs = np.nonzero(body > 0.01)
    pad = 110
    cx0, cy0 = max(xs.min() - pad, 0), max(ys.min() - pad, 0)
    cx1, cy1 = min(xs.max() + pad, w1), min(ys.max() + pad + 260, h1)
    lt1, sw1, body = lt1[cy0:cy1, cx0:cx1], sw1[cy0:cy1, cx0:cx1], body[cy0:cy1, cx0:cx1]
    hh, ww = body.shape
    ly, lx = np.nonzero(lt1 > 0.5)
    lcx, lcy = (lx.min() + lx.max()) / 2, (ly.min() + ly.max()) / 2
    # reveal-time map: nozzle travels along the tag, letters first then swoosh
    yy, xx = np.mgrid[0:hh, 0:ww].astype(np.float32)
    a = math.radians(TAG_ANG)
    u = xx * math.cos(a) - yy * math.sin(a)
    lu = u[lt1 > 0.3]
    ul = (u - lu.min()) / (lu.max() - lu.min())
    wob = (value_noise(ww, hh, 26, 2, 62) - 0.5) * 0.05
    t_let = TSP + 0.02 + np.clip(ul + wob, 0, 1) * 0.40
    su = u[sw1 > 0.3]
    us = (u - su.min()) / (su.max() - su.min())
    t_sw = TSP + 0.43 + np.clip(us + wob * 0.5, 0, 1) * 0.13
    tmap = np.where(sw1 > lt1 + 0.05, t_sw, t_let).astype(np.float32)
    # overspray: soft halo + scattered mist dots (static, revealed with tmap)
    halo = cv2.GaussianBlur(body, (0, 0), 6) * 0.14
    near = cv2.GaussianBlur(body, (0, 0), 20)
    rng = np.random.default_rng(63)
    mist = (rng.random((hh, ww)).astype(np.float32) < near * 0.05).astype(np.float32)
    mist = np.clip(cv2.GaussianBlur(mist, (0, 0), 0.55) * 1.8, 0, 1) * (1 - body)
    # dark knock-out outline so the green separates from the bone type
    shadow = cv2.GaussianBlur(cv2.dilate(body, np.ones((7, 7), np.uint8)), (0, 0), 3.0)
    # drip origins on the lowest edges of letters and swoosh
    rng2 = np.random.default_rng(64)
    drips = []

    def pick(mask, k, min_gap, taken):
        bot = (mask[:-5] > 0.6) & (mask[5:] < 0.05) & (body[5:] < 0.05)
        cy_, cx_ = np.nonzero(bot)
        order = np.argsort(-(cy_ + rng2.uniform(0, 60, len(cy_))))
        n = 0
        for i in order:
            x, y = int(cx_[i]), int(cy_[i])
            if any(abs(x - tx) < min_gap for tx in taken) or x + ox_ > 1470:
                continue
            taken.append(x)
            wdt = float(rng2.uniform(4.0, 8.5))
            L = float([rng2.uniform(16, 50), rng2.uniform(45, 110), rng2.uniform(110, 190)][n % 3])
            t0 = float(tmap[y, x]) + 0.06 + float(rng2.uniform(0, 0.25))
            dur = min(float(rng2.uniform(1.2, 1.7)), TSP + 2.05 - t0)
            drips.append((x, y + 2, wdt, L, t0, dur))
            n += 1
            if n >= k:
                break

    ox_ = TAG_X - lcx
    taken = []
    pick(lt1, 5, 50, taken)
    pick(sw1, 2, 70, taken)
    return dict(body=body, tmap=tmap, halo=halo, mist=mist, shadow=shadow, drips=drips,
                ox=int(round(TAG_X - lcx)), oy=int(round(TAG_Y - lcy)), w=ww, h=hh,
                umin=float(lu.min()), ulen=float(lu.max() - lu.min()),
                vmid=float((xx * math.sin(a) + yy * math.cos(a))[lt1 > 0.3].mean()))


def _drip_layer(tg, t):
    hh, ww = tg["h"], tg["w"]
    dm = np.zeros((hh, ww), np.float32)
    for (x, y, wd, L, t0, dur) in tg["drips"]:
        if t < t0:
            continue
        p = clamp((t - t0) / dur)
        cur = L * (1 - (1 - p) ** 2.4)
        if cur < 0.5:
            continue
        # tapering run + round bead at the tip
        top_w, mid_w = wd * 0.75, wd * 0.36
        yb = y + cur
        poly = np.array([(x - top_w, y - 6), (x + top_w, y - 6), (x + mid_w, yb), (x - mid_w, yb)], np.float64)
        cv2.fillConvexPoly(dm, np.round(poly * 16).astype(np.int32), 1.0, cv2.LINE_AA, 4)
        br = wd * (0.42 + 0.18 * min(cur / 40, 1))
        cv2.circle(dm, (int(round(x * 16)), int(round((yb - br * 0.3) * 16))), int(br * 16), 1.0, -1, cv2.LINE_AA, 4)
    return dm


def _render_tag(f, t, fi):
    if t < TSP:
        return
    tg = _tag()
    ox, oy, hh, ww = tg["ox"], tg["oy"], tg["h"], tg["w"]
    # visible window of the tag canvas inside the frame
    fx0, fy0 = max(ox, 0), max(oy, 0)
    fx1, fy1 = min(ox + ww, W), min(oy + hh, H)
    tx0, ty0 = fx0 - ox, fy0 - oy
    win = (slice(ty0, ty0 + fy1 - fy0), slice(tx0, tx0 + fx1 - fx0))
    rev = np.clip((t - tg["tmap"][win]) / 0.03, 0, 1)
    dm = _drip_layer(tg, t)[win]
    body = np.maximum(tg["body"][win] * rev, dm)
    shadow = np.maximum(cv2.GaussianBlur(dm, (0, 0), 3), tg["shadow"][win] * rev)
    sub = f[fy0:fy1, fx0:fx1]
    sub *= (1 - 0.72 * shadow[..., None])
    sub += (GREEN * 0.6 - sub * 0.3) * (tg["halo"][win] * rev)[..., None]
    sub += (GREEN - sub) * (tg["mist"][win] * rev * 0.8)[..., None]
    sub += (GREEN - sub) * body[..., None]
    hh, ww = sub.shape[:2]
    # live nozzle mist at the spray front
    a = math.radians(TAG_ANG)
    if TSP <= t < TSP + 0.44:
        pu = clamp((t - TSP - 0.02) / 0.40)
        uu = tg["umin"] + pu * tg["ulen"]
        vv = tg["vmid"] + math.sin(t * 44) * 75
        front = (uu * math.cos(a) + vv * math.sin(a) - tx0, -uu * math.sin(a) + vv * math.cos(a) - ty0)
        spread = 52
    elif TSP + 0.43 <= t < TSP + 0.58:
        front = None
        spread = 40
    else:
        front = None
        spread = 0
    if front is not None:
        rng = np.random.default_rng(5000 + fi)
        n = 700
        px = rng.normal(front[0], spread, n)
        py = rng.normal(front[1], spread, n)
        rs = rng.uniform(2, 6, n)
        gc = _col(GREEN)
        for i in range(n):
            if 0 <= px[i] < ww and 0 <= py[i] < hh:
                cv2.circle(sub, (int(px[i] * 4), int(py[i] * 4)), int(rs[i]), gc, -1, cv2.LINE_AA, 2)
        # soft cone glow at the nozzle
        gx, gy = int(front[0]), int(front[1])
        R = 90
        x0, y0 = max(gx - R, 0), max(gy - R, 0)
        x1, y1 = min(gx + R, ww), min(gy + R, hh)
        if x1 > x0 and y1 > y0:
            yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
            g = np.exp(-((xx - gx) ** 2 + (yy - gy) ** 2) / (2 * 38 ** 2)) * 0.35
            sub[y0:y1, x0:x1] += (GREEN - sub[y0:y1, x0:x1]) * g[..., None]


# ================================================================ captions
@lru_cache(maxsize=4)
def _caption(lines):
    """[(mask, char right-edges)] per line, Oswald SemiBold, slightly tracked."""
    f = ImageFont.truetype(OSWALD, CAP_PX)
    f.set_variation_by_name("SemiBold")
    track = 2.5
    asc, desc = f.getmetrics()
    out = []
    for ln in lines:
        w = int(sum(f.getlength(c) + track for c in ln) + 16)
        h = asc + desc + 12
        im = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(im)
        x = 4.0
        edges = []
        for c in ln:
            d.text((x, 6), c, font=f, fill=255)
            x += f.getlength(c) + track
            edges.append(x)
        out.append((np.asarray(im, np.float32) / 255.0, edges))
    return out


CAP_L = ("PACIÊNCIA,", "POSIÇÃO", "E PRECISÃO.")
CAP_R = ("O SILÊNCIO", "TAMBÉM", "ELIMINA.")
CAP_TOP_PAD = 12       # glyph cap-top offset inside the caption mask (Oswald 44)


def _render_caption(f, t, lines, x, y, t0, t1):
    if t < t0:
        return
    cap = _caption(lines)
    total = sum(len(l) for l in lines)
    n = total if t >= t1 else int(math.ceil(total * (t - t0) / (t1 - t0)))
    shown = 0
    cur = None
    for li, (m, edges) in enumerate(cap):
        k = min(len(edges), n - shown)
        shown += len(edges)
        if k <= 0:
            if cur is None:
                cur = (x + 4, y + li * CAP_LH)
            break
        xe = int(math.ceil(edges[k - 1])) + 1
        over(f, solid_layer(m[:, :xe], CAP_COL), x, y + li * CAP_LH)
        cur = (x + xe + 4, y + li * CAP_LH)
    on = t < t1 + 0.04 or ((t - t1) * 7) % 2 < 1.0 and t < t1 + 0.75
    if cur is not None and on:
        cx, cy = cur
        top = cy + 6 + 13
        cv2.rectangle(f, (int(cx), int(top)), (int(cx + 15), int(top + 38)), _col(GREEN), -1)


# ================================================================ reticle
@lru_cache(maxsize=1)
def _reticle():
    S, ss = 640, 2
    N = S * ss
    img = np.zeros((N, N), np.float32)
    c = N / 2
    R = 0.30 * N
    rng = np.random.default_rng(71)

    def stroke(p0, p1, th):
        cv2.line(img, tuple(np.round(np.asarray(p0) * 16).astype(int)), tuple(np.round(np.asarray(p1) * 16).astype(int)),
                 1.0, max(1, int(th)), cv2.LINE_AA, 4)

    # hand-drawn ring: two loose passes with overshoot
    for pi, (th, a0, span, jit, dr) in enumerate(((11.0, -0.5, 2 * math.pi + 0.55, 3.0, 0),
                                                 (5.5, 2.2, 2 * math.pi * 0.55, 4.0, 7))):
        k = 260
        ph = rng.uniform(0, 6.28, 2)
        pts = []
        for i in range(k + 1):
            a = a0 + span * i / k
            rr = R + dr * ss + jit * ss * (math.sin(a * 2 + ph[0]) * 0.6 + math.sin(a * 5 + ph[1]) * 0.4)
            pts.append((c + rr * math.cos(a), c + rr * math.sin(a)))
        for i in range(k):
            s = i / k
            taper = min(1, s * 9 + 0.15, (1 - s) * 5 + 0.1)
            stroke(pts[i], pts[i + 1], th * ss * taper)
    # cross hairs: gap at centre, overshooting the ring
    gap = 0.075 * N
    L = 0.485 * N
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        wob = rng.normal(0, 1.5 * ss)
        p0 = np.array([c + dx * gap, c + dy * gap])
        p1 = np.array([c + dx * L + dy * wob, c + dy * L + dx * wob])
        k = 40
        for i in range(k):
            s0, s1 = i / k, (i + 1) / k
            taper = min(1, (1 - s0) * 4 + 0.15, s0 * 10 + 0.4)
            stroke(p0 + (p1 - p0) * s0, p0 + (p1 - p0) * s1, 8.0 * ss * taper)
        for j, fr in enumerate((0.45, 0.66, 0.84, 1.20, 1.40)):
            pr = fr * R
            tl = (0.024 if j not in (2, 3) else 0.042) * N
            px, py = c + dx * pr, c + dy * pr
            if dx:
                stroke((px, py - tl), (px, py + tl), 5 * ss)
            else:
                stroke((px - tl, py), (px + tl, py), 5 * ss)
    cv2.circle(img, (int(c * 16), int(c * 16)), int(5.5 * ss * 16), 1.0, -1, cv2.LINE_AA, 4)
    img = np.clip(img, 0, 1)
    nz = value_noise(N, N, 4, 2, 72)
    img *= 1 - np.clip((nz - 0.72) * 3, 0, 1) * 0.45
    a = cv2.resize(img, (S, S), interpolation=cv2.INTER_AREA)
    return solid_layer(np.clip(a, 0, 1), GREEN)


@lru_cache(maxsize=1)
def _o_center():
    """Centre of the 'O' of UM TIRO. in its final position (layout space)."""
    f = ImageFont.truetype(ANTON, HEAD_PX)
    x0 = f.getbbox("UM TIRO.")[0]
    full = f.getbbox("UM TIRO.")
    ob = f.getbbox("O")
    xo = f.getlength("UM TIR")
    ink_w = full[2] - full[0]
    left = W / 2 - ink_w / 2
    cx = left + (xo - x0) + (ob[0] + ob[2]) / 2
    return cx, L1_TOP + CAP_H / 2, left + (xo - x0) + ob[0], left + (xo - x0) + ob[2]


# ================================================================ camera
def _camera(t):
    s = 1.0 + 0.055 * (t / DUR) + 0.012 * ease_in_out(prog(t, 0, 1.6))
    dx, dy, ang = 0.0, 0.0, 0.0
    for T, amp, sd in ((T1, 22, 1), (T2, 26, 2), (TCL, 5, 3)):
        a, b, c = shake(t, amp, 33, seed=sd, decay_from=T, decay=8.0)
        dx, dy, ang = dx + a, dy + b, ang + c
    a, b, c = shake(t, 1.6, 1.7, seed=9)        # hand-held drift
    dx, dy, ang = dx + a, dy + b, ang + c * 3
    pw = prog(t, TWH, DUR) ** 2.2
    dx -= 1100 * pw
    ang -= 0.8 * pw
    s += 0.03 * pw
    return s, ang, dx, dy, pw


# ================================================================ render
def _zoom_draw(f, L, scales, cx, cy, opacity):
    """Zoom-blurred white-hot copy of line L: premultiplied average of the
    layer at several scales about its centre, centred on (cx, cy)."""
    lay = L["hot"]
    h, w = lay.shape[:2]
    smax = max(scales)
    ow, oh = int(math.ceil(w * smax)) + 8, int(math.ceil(h * smax)) + 8
    pm = premul(lay)
    acc = np.zeros((oh, ow, 4), np.float32)
    for sc in scales:
        M = cv2.getRotationMatrix2D((w / 2, h / 2), 0, sc)
        M[0, 2] += ow / 2 - w / 2
        M[1, 2] += oh / 2 - h / 2
        acc += cv2.warpAffine(pm, M, (ow, oh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    acc /= len(scales)
    o = unpremul(acc)
    over(f, o, cx - ow / 2, cy - oh / 2, opacity)


def _slam(f, L, T, t, icx, itop, base_s=1.0):
    """Line L slams in at T: 1.25x -> 1.0 at constant speed into a hard stop,
    zoom-blurred on the way in, white-hot on landing, cooling to worn print."""
    if t < T - 0.1 - 1e-6:
        return
    dt = t - T
    bx0, by0, bx1, by1 = L["bbox"]
    if dt < 0:
        p = prog(t, T - 0.1, T)
        s = 1 + 0.25 * (1 - p)
        step = 0.25 / 3
        scales = [base_s * (s + step * j / 6) for j in range(7)]
        # zoom about the line's landing centre
        cx = icx + (L["w"] / 2 - (bx0 + bx1) / 2) * base_s
        cy = itop + (L["h"] / 2 - by0) * base_s
        _zoom_draw(f, L, scales, cx, cy, 0.55 + 0.45 * p)
        return
    s = 1 - 0.022 * math.exp(-dt * 15) * math.cos(dt * 40)
    hot = 1 - ease_out_cubic(clamp(dt / 0.34))
    _draw_line(f, L, base_s * s, icx, itop, hot=hot)


def _eio3(x):
    return 4 * x * x * x if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def render(t, ctx):
    # snap float noise from the global timeline (e.g. 6.3 - 6.0) onto the frame grid
    r = round(t * FPS)
    if abs(t * FPS - r) < 1e-3:
        t = min(r / FPS, DUR - 1e-6)
    fi = ctx.get("local_frame", int(round(t * FPS)))
    L1big, L1, L2 = _lines()
    f = _bg().copy()

    # --- faint drifting haze
    _haze(f, t)

    # --- halftone corners: breathe in, pulse on each hit
    pulse = sum(math.exp(-(t - T) * 5.0) * 0.5 for T in (T1, T2) if t >= T)
    k = 0.45 + 0.55 * ease_out_cubic(prog(t, 0.0, 1.0)) + pulse + 0.03 * math.sin(t * 2.2)
    _halftone_corners(f, k, 0.30 + 0.12 * min(pulse, 1))

    # --- cracks inherited from scene 2, fading (kick on the first hit)
    ca = 0.32 * (1 - ease_in_out(prog(t, 0.0, 0.9)))
    if t >= T1:
        ca += 0.30 * math.exp(-(t - T1) * 8) * (1 - prog(t, T1, 1.0))
    if ca > 0.004:
        f += (BONE - f) * (_cracks() * ca)[..., None]

    # --- headline
    icx = W / 2
    L2top = L1_TOP + CAP_H + LINE_GAP
    # line 1 makes room (quick anticipation move + down-scale), then recoils
    # when line 2 lands under it
    mv = _eio3(prog(t, T2 - 0.27, T2 - 0.035))
    kick = -18 * math.exp(-(t - T2) * 11) * (1 if t >= T2 else 0)
    if mv <= 0:
        _slam(f, L1big, T1, t, icx, STAGE_TOP)
    elif mv < 0.999:
        s = 1 + (1 / STAGE - 1) * mv
        _draw_line(f, L1big, s, icx, STAGE_TOP + (L1_TOP - STAGE_TOP) * mv)
    else:
        _draw_line(f, L1, 1.0, icx, L1_TOP + kick)
    _slam(f, L2, T2, t, icx, L2top)

    b1, b2 = L1big["bbox"], L2["bbox"]
    _dust(f, t, T1, icx - (b1[2] - b1[0]) / 2, icx + (b1[2] - b1[0]) / 2, STAGE_TOP + CAP_H * STAGE, 101)
    _dust(f, t, T2, icx - (b2[2] - b2[0]) / 2, icx + (b2[2] - b2[0]) / 2, L2top + CAP_H, 202)

    # --- target lock: the O of TIRO flashes green when the reticle snaps on
    if TCL <= t < TCL + 0.4:
        k = 0.9 * math.exp(-(t - TCL) * 8)
        _, _, ox0, ox1 = _o_center()
        xa, xb = int(ox0 - 4), int(ox1 + 4)
        ya, yb = int(L1_TOP - 8), int(L1_TOP + CAP_H + 8)
        reg = f[ya:yb, xa:xb]
        lum = reg @ np.array([0.299, 0.587, 0.114], np.float32)
        msk = np.clip((lum - 70) / 90, 0, 1) * k
        reg += (GREEN - reg) * msk[..., None]

    # --- graffiti tag
    _render_tag(f, t, fi)

    # --- captions
    ink_l = icx - (b2[2] - b2[0]) / 2
    ink_r = icx + (b2[2] - b2[0]) / 2
    cy = L2top + CAP_H + 52 - CAP_TOP_PAD - 6
    rw = max(int(e[-1]) for _, e in _caption(CAP_R))
    for (lines, x, t0, t1) in ((CAP_L, int(ink_l - 2), 2.60, 3.05), (CAP_R, int(ink_r - rw), 2.85, 3.30)):
        # short green rule wipes in just before the block types on
        rp = ease_out_cubic(prog(t, t0 - 0.12, t0 + 0.08))
        if rp > 0:
            ry = int(cy + 22 - 24)
            cv2.rectangle(f, (x + 6, ry), (x + 6 + int(round(58 * rp)), ry + 4), _col(GREEN), -1)
        _render_caption(f, t, lines, x, int(cy), t0, t1)

    # --- reticle snaps onto the O
    if t >= TCL - 2 * DT - 1e-6:
        ret = _reticle()
        ox, oy = _o_center()[:2]
        dt = t - TCL
        if dt < 0:
            p = prog(t, TCL - 2 * DT, TCL)
            sc, rot, op = 1.75 - 0.45 * p, -32 * (1 - p), 0.3 + 0.4 * p
        else:
            sc = 1.10 - 0.17 * ease_out_cubic(prog(dt, 0.0, 0.6)) + 0.04 * math.exp(-dt * 28)
            rot = 5 * math.exp(-dt * 10) * math.cos(dt * 32)
            op = 1.0
        sx = 3.0 * math.sin(t * 3.1) * clamp((dt - 0.3) * 3)
        sy = 2.0 * math.sin(t * 2.3 + 1) * clamp((dt - 0.3) * 3)
        o = _xform(ret, sc, rot)
        over(f, o, ox - o.shape[1] / 2 + sx, oy - o.shape[0] / 2 + sy, op)
        if 0 <= dt < 0.32:   # ping ring
            q = dt / 0.32
            rr = 190 + 560 * ease_out_cubic(q)
            cv2.circle(f, (int(ox * 4), int(oy * 4)), int(rr * 4), _col(GREEN * (1 - q) ** 1.5), 3, cv2.LINE_AA, 2)

    # --- green bloom (keyed on green pixels only)
    q = cv2.resize(f, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    key = np.clip((q[..., 1] - 0.5 * (q[..., 0] + q[..., 2]) - 45) / 70, 0, 1)
    gsum = cv2.GaussianBlur(key, (0, 0), 5) * 0.5 + cv2.GaussianBlur(key, (0, 0), 18) * 0.5
    f += cv2.resize(gsum, (W, H), interpolation=cv2.INTER_LINEAR)[..., None] * (GREEN * 0.42)

    # --- thin green floor line
    li = 0.35 + 0.35 * ease_out_cubic(prog(t, 0.0, 0.6)) + 0.6 * pulse
    light_streak(f, 1036, li, GREEN, thickness=2, length=0.86)

    # --- camera
    s, ang, dx, dy, pw = _camera(t)
    f = warp_frame(f, s, ang, dx, dy)
    if pw > 0.002:
        kk = int(1 + 360 * pw)
        f = cv2.blur(f, (kk, 1))
        f = cv2.blur(f, (max(1, kk // 2), 1))

    # impact flash: one luminance-inverted frame on each slam, then a quick lift
    for T in (T1, T2):
        d = t - T
        if -1e-6 <= d < DT - 1e-6:
            lum = f @ np.array([0.299, 0.587, 0.114], np.float32)
            f = INK + (BONE - INK) * np.clip(1 - lum / 215.0, 0, 1)[..., None]
        elif DT - 1e-6 <= d < 3 * DT:
            f = f + (BONE - f) * 0.08 * (1 - (d - DT) / (2 * DT))
    return np.clip(f, 0, 255)
