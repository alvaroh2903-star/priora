"""Scene 3 · s3_slam (4.5 s) — kinetic distressed headline "UM TIRO. / UMA BAIXA."

Beat sheet (local seconds):
  0.00  cracked black frame handed over from scene 2; cracks fade, halftone
        corners breathe in, thin green floor line glows on from zero
  0.20  "UM TIRO." drops in at 1.25x (smooth zoom-blurred, white-hot) ...
  0.30  ... IMPACT: hard stop, one inverted flash frame, the white-hot type
        cools into worn bone print, rising dust cloud + low dust skirt + chips
        kicked off the letter feet, decaying shake, halftone corners pulse.
        Line sits big and alone.
  0.84  line 1 makes room: glides up (motion-blurred) and settles to the width
        of line 2, so the two lines lock into one justified block
  1.10  "UMA BAIXA." drops in under it ...
  1.20  ... IMPACT: same flash / dust / shake / pulse, line 1 recoils
  2.00  SPRAY: green graffiti "ARMY" tag is written on letter by letter along
        its strokes (ragged, building spray front with live nozzle mist), then
        the underline swoosh; dense paint with overspray speckle
  2.2-4.0  paint drips run down from the tag
  2.60-3.30  caption blocks type in (left, then right) with a green cursor
  3.40  CLICK: hand-drawn green reticle snaps onto the "O" of TIRO, double
        ping ring, then tightens
  0-4.2 slow push-in drift the whole time
  4.20-4.50  WHOOSH: accelerating whip-pan to the right — everything smears out
        to the left into abstract streaks with a green/bone light-streak flash
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

HEAD_PX = 370          # line 2 Anton size ("UMA BAIXA." ~1585 px of ink, 83 % of the width)
L1_TRACK = 0.125       # letter-spacing of "UM TIRO." (em): justifies to line 2 at a sane cap height
L1_SPACE = 0.60        # ... with a tightened word space (the tracking already opens the gap)
STAGE_PX = 425         # line 1 is built at this size and slams in alone at it (~1700 px of ink)
LINE_GAP = 10
L1_TOP = 72            # final cap-top of line 1 (layout space, before camera)
STAGE_CY = 506         # optical centre of the big line 1 while alone
T_MV0, T_MV1 = T2 - 0.42, T2 - 0.12    # line 1 make-room move (parked before line 2 appears)

CAP_PX = 44
CAP_LH = 46
CAP_COL = np.array([226, 222, 212], np.float32)
DUST_C = np.array([168, 165, 158], np.float32)


# ================================================================ helpers
def _text_geom(text, path, size, ss=2, track=0.0, space=1.0):
    """Font at size*ss, per-glyph pen x (kerned prefix advance + tracking, in em of
    size; word spaces scaled by `space` so tracked words don't fall apart) and the
    ink bbox of the whole tracked string."""
    f = ImageFont.truetype(path, int(size * ss))
    if not track and space == 1.0:
        return f, None, f.getbbox(text)
    trk = track * size * ss
    dsp = (1.0 - space) * f.getlength(" ")
    xs = [f.getlength(text[:i]) + i * trk - text[:i].count(" ") * dsp for i in range(len(text))]
    bb = [(x + b[0], b[1], x + b[2], b[3]) for x, ch in zip(xs, text) if ch != " " for b in [f.getbbox(ch)]]
    box = (int(math.floor(min(b[0] for b in bb))), min(b[1] for b in bb),
           int(math.ceil(max(b[2] for b in bb))), max(b[3] for b in bb))
    return f, xs, box


def _ss_text_mask(text, path, size, ss=2, pad=24, track=0.0, space=1.0):
    """Supersampled text mask; track = extra letter-spacing in em, drawn glyph by glyph."""
    f, xs, (x0, y0, x1, y1) = _text_geom(text, path, size, ss, track, space)
    p = pad * ss
    w, h = x1 - x0 + 2 * p, y1 - y0 + 2 * p
    w += (-w) % ss
    h += (-h) % ss
    im = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(im)
    if xs is None:
        d.text((p - x0, p - y0), text, font=f, fill=255)
    else:
        for x, ch in zip(xs, text):
            if ch != " ":
                d.text((p - x0 + x, p - y0), ch, font=f, fill=255)
    return np.asarray(im, np.float32) / 255.0


def _dot_holes(w, h, cell, angle, amount):
    """Halftone holes: dot radius grows with amount (0..1 map)."""
    return _dot_holes_rows(w, h, 0, cell, angle, amount)


def _dot_holes_rows(w, h, r0, cell, angle, amount):
    """_dot_holes restricted to rows r0..h (same phase as the full grid)."""
    a = math.radians(angle)
    c, sn = np.float32(math.cos(a) / cell), np.float32(math.sin(a) / cell)
    xs = np.arange(w, dtype=np.float32)[None, :]
    ys = np.arange(r0, h, dtype=np.float32)[:, None]
    u = xs * c + ys * sn
    v = ys * c - xs * sn
    u -= np.floor(u)
    u -= np.float32(0.5)
    v -= np.floor(v)
    v -= np.float32(0.5)
    d = cv2.magnitude(u, v)
    amount = np.ascontiguousarray(amount, np.float32)
    k = cell * 0.9
    m = cv2.addWeighted(amount, 0.72 * k, d, -k, 0.5)      # (amount*0.72 - d) * k + 0.5
    np.clip(m, 0, 1, out=m)
    m[amount <= 0.03] = 0
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


def _smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


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


def _aw(a, k, b):
    """k * a + b in one fused pass (float32)."""
    return cv2.addWeighted(a, k, a, 0.0, b)


def _c01(a):
    """Clip to 0..1 in place (returns a)."""
    return np.clip(a, 0, 1, out=a)


@lru_cache(maxsize=4)
def _line(text, seed, px, track=0.0, space=1.0):
    """Distressed bone headline line at Anton size px (poster print look:
    eaten edges, clumped grit thickest near the edges, halftone fade at the
    feet, faint mesh, scratches + vertical streaks). Returns dict with the
    worn layer, the white-hot clean layer and the ink bbox."""
    ss = 2
    sc = px / 380.0
    mk = _ss_text_mask(text, ANTON, px, ss, pad=28, track=track, space=space)
    h2, w2 = mk.shape
    rng = np.random.default_rng(seed)
    # --- rough, eaten print edges (fused cv2 arithmetic: these maps are big)
    n_fine = value_noise(w2, h2, 4 * sc, 3, seed + 1)
    n_mid = _vn(w2, h2, 14 * sc, 3, seed + 3, 2)
    n_chip = _vn(w2, h2, 34 * sc, 3, seed + 2, 2)
    mb = cv2.GaussianBlur(mk, (0, 0), 2.0 * sc)
    chip = _c01(_aw(n_chip, 4.0, -0.64 * 4))
    # (mb - .5 + (fine - .5) * .7 + (mid - .5) * .35 - chip * .8) * 8 + .5
    rough = cv2.addWeighted(mb, 8.0, n_fine, 5.6, -7.7)
    rough = cv2.addWeighted(rough, 1.0, n_mid, 2.8, 0.0)
    rough = _c01(cv2.addWeighted(rough, 1.0, chip, -6.4, 0.0))
    # --- grit density: clumps + edges
    inner = cv2.GaussianBlur(mk, (0, 0), 12 * sc)
    edge = cv2.multiply(_c01(_aw(inner, -2.4, 0.93 * 2.4)), mk)
    clump = _vn(w2, h2, 80 * sc, 4, seed + 6, 4)
    dens = cv2.addWeighted(_c01(_aw(clump, 1.8, -0.35 * 1.8)), 0.75 * 1.3, edge, 0.7 * 1.3, 0.0)
    _c01(dens)                                            # = clip(dens * 1.3, 0, 1)
    sm = (rng.random((h2 // 2, w2 // 2)) < 0.07).astype(np.float32)
    sm = cv2.GaussianBlur(cv2.resize(sm, (w2, h2), interpolation=cv2.INTER_NEAREST), (0, 0), 0.7)
    bg = (rng.random((h2 // 5, w2 // 5)) < 0.05).astype(np.float32)
    bg = cv2.resize(bg, (w2, h2), interpolation=cv2.INTER_LINEAR)
    bg = _c01(_aw(cv2.GaussianBlur(bg, (0, 0), 1.2), 6.0, -0.48))
    speck = _c01(cv2.multiply(cv2.addWeighted(sm, 1.6, bg, 1.0, 0.0), dens))
    # --- mesh + halftone fade at the feet of the letters
    mesh = _dot_holes(w2, h2, 11, 45.0, np.clip(_aw(_vn(w2, h2, 200 * sc, 3, seed + 7, 4), 1.4, -0.63), 0, 0.55))
    ys = np.nonzero(mk.max(1) > 0.5)[0]
    ty, by = ys.min(), ys.max()
    r0 = int(ty + 0.59 * (by - ty))
    yy = (np.arange(r0, h2, dtype=np.float32)[:, None] - ty) / max(by - ty, 1)
    ramp = np.clip((yy - 0.60) / 0.40, 0, 1).astype(np.float32)
    bot = cv2.multiply(_c01(_aw(_vn(w2, h2, 140 * sc, 3, seed + 9, 4)[r0:], 1.8, -0.5)),
                       np.ascontiguousarray(np.broadcast_to(ramp, (h2 - r0, w2))))
    dots = np.zeros((h2, w2), np.float32)
    dots[r0:] = _dot_holes_rows(w2, h2, r0, 14, 45.0, bot)
    # --- scraped-off patches
    wear = _vn(w2, h2, 120 * sc, 5, seed + 4, 2)
    holes = _c01(cv2.addWeighted(wear, 14.0, n_mid, 14 * 0.12, -14 * (0.745 + 0.06)))
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
    tex = _aw(holes, -0.95, 1.0)
    tex = cv2.multiply(tex, _aw(dots, -0.9, 1.0))
    tex = cv2.multiply(tex, _aw(mesh, -0.6, 1.0))
    tex = cv2.multiply(tex, _aw(speck, -0.92, 1.0))
    tex = cv2.multiply(tex, simg.astype(np.float32), scale=-0.8 / 255.0) + tex      # * (1 - .8 * scr)
    a2 = cv2.multiply(rough, _c01(tex))
    w1, h1 = w2 // ss, h2 // ss
    alpha = cv2.resize(a2, (w1, h1), interpolation=cv2.INTER_AREA)
    clean = cv2.resize(rough, (w1, h1), interpolation=cv2.INTER_AREA)
    tone = _aw(value_noise(w1, h1, 140 * sc, 4, seed + 8), 0.16, 0.86)
    lay = cv2.merge([tone * float(BONE[0]), tone * float(BONE[1]), tone * float(BONE[2]), alpha])
    hot = cv2.merge([np.full((h1, w1), float(WHITE[i]), np.float32) for i in range(3)] + [clean])
    yk, xk = np.nonzero(clean > 0.3)
    bbox = (int(xk.min()), int(yk.min()), int(xk.max()) + 1, int(yk.max()) + 1)
    return {"lay": lay, "hot": hot, "bbox": bbox, "w": w1, "h": h1}


def _scaled(L, s):
    """Resampled copy of a line dict (INTER_AREA). The colour planes are defined
    everywhere (smooth bone tone / flat white), so straight-alpha resampling is
    exact here and needs no premultiply round trip."""
    out = {}
    for k in ("lay", "hot"):
        out[k] = resize_layer(L[k], s)
    h, w = out["lay"].shape[:2]
    out["w"], out["h"] = w, h
    out["bbox"] = tuple(int(round(v * s)) for v in L["bbox"])
    return out


@lru_cache(maxsize=1)
def _lines():
    """Big line 1 (stage), final line 1 (scaled so its ink width equals line 2's:
    justified two-line block), line 2, and that final scale."""
    L1big = _line("UM TIRO.", 11, STAGE_PX, L1_TRACK, L1_SPACE)
    L2 = _line("UMA BAIXA.", 23, HEAD_PX)
    b1, b2 = L1big["bbox"], L2["bbox"]
    s1f = (b2[2] - b2[0]) / (b1[2] - b1[0])
    L1 = _scaled(L1big, s1f)
    return L1big, L1, L2, s1f


@lru_cache(maxsize=1)
def _layout():
    L1big, L1, L2, s1f = _lines()
    cap1 = L1["bbox"][3] - L1["bbox"][1]
    cap2 = L2["bbox"][3] - L2["bbox"][1]
    capS = L1big["bbox"][3] - L1big["bbox"][1]
    L2top = L1_TOP + cap1 + LINE_GAP
    hw2 = (L2["bbox"][2] - L2["bbox"][0]) / 2
    return dict(cap1=cap1, cap2=cap2, capS=capS, L2top=L2top, ink_l=W / 2 - hw2, ink_r=W / 2 + hw2, s1f=s1f,
                stage_top=int(round(STAGE_CY - capS / 2)))


@lru_cache(maxsize=4)
def _foot_cols(key):
    """x offsets (from the ink centre, layer px) of columns with ink in the
    bottom rows of a line: where the dust and chips can come from."""
    L1big, _, L2, _ = _lines()
    L = L1big if key == 1 else L2
    bx0, by0, bx1, by1 = L["bbox"]
    a = L["hot"][by1 - 12:by1, bx0:bx1, 3]
    cols = np.nonzero(a.max(0) > 0.5)[0].astype(np.float32)
    return cols + bx0 - (bx0 + bx1) / 2


def _draw_line(f, L, s, icx, itop, hot=0.0, opacity=1.0, vblur=0):
    """Draw line L scaled by s about its centre so that its ink box is
    horizontally centred on icx with cap top at itop. vblur: vertical motion
    blur length in px."""
    bx0, by0, bx1, by1 = L["bbox"]
    w, h = L["w"], L["h"]
    if hot > 0.001:
        lay = L["lay"].copy()
        k = 1 - hot
        lay[..., :3] = L["hot"][..., :3] + (L["lay"][..., :3] - L["hot"][..., :3]) * k
        lay[..., 3] = L["hot"][..., 3] + (L["lay"][..., 3] - L["hot"][..., 3]) * k
    else:
        lay = L["lay"]
    if abs(s - 1) < 0.0015 and vblur < 2:
        over(f, lay, icx - (bx0 + bx1) / 2, itop - by0, opacity)
        return
    o = _xform(lay, s) if abs(s - 1) >= 0.0015 else lay
    oh, ow = o.shape[:2]
    if abs(s - 1) >= 0.0015:
        x = icx - (ow / 2 + s * ((bx0 + bx1) / 2 - w / 2))
        y = itop - (oh / 2 + s * (by0 - h / 2))
    else:
        x, y = icx - (bx0 + bx1) / 2, itop - by0
    if vblur >= 2:
        k = int(vblur) | 1
        p = k // 2 + 2
        pm = np.zeros((oh + 2 * p, ow, 4), np.float32)
        pm[p:p + oh] = premul(o)
        pm = cv2.blur(pm, (1, k))
        o = unpremul(pm)
        y -= p
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


def _ht_falloff(cw, ch):
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    nz = value_noise(cw, ch, 110, 3, 41)
    g = 1 - np.clip(np.hypot(xx / cw, yy / ch) * 1.05, 0, 1)
    return (np.clip(g * (0.6 + 0.7 * nz), 0, 1) ** 1.35).astype(np.float32)


HT_W, HT_H = 1100, 760         # corner dot fields (s2 hands over the 980x700 field; it grows by the first hit)


@lru_cache(maxsize=1)
def _halftone_maps():
    cw, ch = HT_W, HT_H
    cell = 14
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    a = math.radians(45)
    u = xx * math.cos(a) + yy * math.sin(a)
    v = -xx * math.sin(a) + yy * math.cos(a)
    fu = (u / cell) % 1 - 0.5
    fv = (v / cell) % 1 - 0.5
    d = np.sqrt(fu * fu + fv * fv).astype(np.float32)
    g = _ht_falloff(cw, ch)
    g0 = np.zeros_like(g)          # the hand-over field (same dot lattice, smaller falloff)
    g0[:700, :980] = _ht_falloff(980, 700)
    return d, g, g0, cell


def _halftone_corners(f, k, opacity, grow=1.0):
    d, g, g0, cell = _halftone_maps()
    ch, cw = d.shape
    if grow < 0.999:
        g = g0 + (g - g0) * grow
    cap = 0.52 + 0.06 * grow
    m = np.clip((np.minimum(g * (0.62 * k), cap) - d) * cell * 0.9 + 0.5, 0, 1) * (g > 0.01)
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
    n = np.clip((n - 0.36) * 2.2, 0, 1) ** 1.2
    return cv2.resize(n, (W, H), interpolation=cv2.INTER_LINEAR)


def _dust(f, t, T, xs_ink, yb, seed):
    """Slam dust from the baseline (yb) of a line whose inked foot columns are
    at frame x positions xs_ink: a rising, growing cloud, a low wide skirt that
    rolls out along the floor, and ballistic chips off the letter feet."""
    dt = t - T
    if dt < 0 or dt > 1.5:
        return
    rng = np.random.default_rng(seed)
    x0, x1 = float(xs_ink.min()), float(xs_ink.max())
    xc, hw = (x0 + x1) / 2, (x1 - x0) / 2
    q = 4
    y0, y1 = int(max(yb - 420, 0)), int(min(yb + 180, H))
    ch = (y1 - y0 + q - 1) // q
    can = np.zeros((ch, W // q), np.float32)
    ells = []
    # 1) rising puffs from the letter feet
    n = 50
    px0 = rng.choice(xs_ink, n) + rng.normal(0, 22, n)
    rel = (px0 - xc) / hw
    vx = rel * rng.uniform(60, 380, n) + rng.normal(0, 45, n)
    vy = -rng.uniform(90, 300, n)
    r0 = rng.uniform(14, 32, n)
    life = rng.uniform(0.6, 1.15, n)
    gx = (1 - math.exp(-dt * 4.0)) / 4.0
    gy = (1 - math.exp(-dt * 1.6)) / 1.6
    grow = 1 + 2.5 * ease_out_cubic(min(dt * 1.6, 1))
    for i in range(n):
        lf = dt / life[i]
        if lf >= 1:
            continue
        rr = r0[i] * grow
        a = (1 - lf) ** 1.5 * min(dt * 30 + 0.25, 1)
        ells.append((a, px0[i] + vx[i] * gx, yb + 8 + vy[i] * gy, rr * 1.5, rr * (0.5 + 0.4 * min(dt * 2.2, 1))))
    # 2) low wide skirt rolling outward along the floor
    m2 = 22
    sx0 = rng.choice(xs_ink, m2)
    rel2 = (sx0 - xc) / hw
    svx = rel2 * rng.uniform(250, 800, m2) + np.sign(rel2 + 1e-3) * rng.uniform(40, 160, m2)
    svy = -rng.uniform(5, 40, m2)
    sr0 = rng.uniform(20, 40, m2)
    slife = rng.uniform(0.8, 1.5, m2)
    gs = (1 - math.exp(-dt * 3.0)) / 3.0
    for i in range(m2):
        lf = dt / slife[i]
        if lf >= 1:
            continue
        rr = sr0[i] * (1 + 1.8 * ease_out_cubic(min(dt * 1.3, 1)))
        a = (1 - lf) ** 1.3 * min(dt * 30 + 0.3, 1) * 0.9
        ells.append((a, sx0[i] + svx[i] * gs, yb + 16 + svy[i] * gs, rr * 2.8, rr * 0.42))
    ells.sort(key=lambda e: e[0])
    for a, px, py, ax, ay in ells:
        cv2.ellipse(can, (int(px * 4 / q), int((py - y0) * 4 / q)), (max(1, int(ax * 4 / q)), max(1, int(ay * 4 / q))),
                    0, 0, 360, float(a), -1, cv2.LINE_AA, 2)
    can = cv2.GaussianBlur(can, (0, 0), 2.6 + 2.4 * max(0.0, 1 - dt * 5))   # first frames: one soft burst
    big = cv2.resize(can, (W, ch * q), interpolation=cv2.INTER_LINEAR)[:y1 - y0]
    ox = int(dt * 40)
    tx = np.roll(_dust_tex()[y0:y1], -ox, axis=1)
    a = np.clip(big * (0.35 + 0.9 * tx), 0, 1) * 0.55
    sub = f[y0:y1]
    sub += (DUST_C - sub) * a[..., None]
    # 3) fine chalk dust + chips, ballistic with drag (not on the impact frame)
    if dt < DT - 1e-6:
        return
    m = 220
    cx = rng.choice(xs_ink, m) + rng.uniform(-3, 3, m)
    cy0 = yb - rng.uniform(0, 70, m)
    rel = (cx - xc) / hw
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
        py = cy0[i] + cvy[i] * dd + 0.5 * grav[i] * dt * dt
        if not (0 <= px < W and 0 <= py < H):
            continue
        a = fade * br[i]
        bgc = f[int(py), int(px)]
        cv2.circle(f, (int(px * 4), int(py * 4)), max(1, int(sz[i] * 4)), _col(bgc + (BONE - bgc) * a), -1, cv2.LINE_AA, 2)


# ================================================================ graffiti tag
TAG_ANG = 11.0             # degrees, rising to the right
TAG_PX = 178               # marker font size of the tag lettering
TAG_X, TAG_Y = 1155, 750   # centre of the lettering (layout): crosses the feet of "AIXA", captions stay clear
T_LET = 0.40               # letters are written in this long (from TSP + 0.02)
DRIP_FLOOR = 1020          # lowest point a drip may reach (layout space; floor line is at 1036)


def _geo_dist(mask, seed):
    """Geodesic distance (octagonal metric, px) inside bool mask from seed (y, x)."""
    m8 = mask.astype(np.uint8)
    reached = np.zeros_like(m8)
    reached[seed] = 1
    dist = np.full(mask.shape, np.inf, np.float32)
    dist[seed] = 0
    ksq = np.ones((3, 3), np.uint8)
    kcr = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    i = 0
    while True:
        i += 1
        nxt = cv2.dilate(reached, ksq if i % 2 else kcr) & m8
        new = nxt > reached
        if not new.any():
            break
        dist[new] = i
        reached = nxt
    return dist


def _nearest_fill(tm):
    """Replace non-finite values with the value of the nearest finite pixel."""
    known = np.isfinite(tm)
    _, lab = cv2.distanceTransformWithLabels((~known).astype(np.uint8), cv2.DIST_L2, 5,
                                             labelType=cv2.DIST_LABEL_PIXEL)
    lut = np.zeros(int(lab.max()) + 1, np.float32)
    lut[lab[known]] = tm[known]
    return lut[lab]


@lru_cache(maxsize=1)
def _tag():
    """Green spray/brush 'ARMY' tag: italic marker caps + underline swoosh,
    bristle-eaten edges, tonal paint colour, overspray speckle, a stroke-wise
    reveal-time map (each letter traced from its start point along its strokes),
    the nozzle path and drip origins."""
    ss = 2
    mk = _ss_text_mask("ARMY", TAGFONT, TAG_PX, ss, pad=30)
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
    P2 = np.array([w * 0.43, h * 0.25])
    N = 140
    Ms = (T1_ @ R @ np.array([[1.0, sh, 0], [0, 1.0, 0], [0, 0, 1]]))[:2]
    for i in range(N + 1):
        s = i / N
        p = (1 - s) ** 2 * P0 + 2 * (1 - s) * s * P1 + s * s * P2
        q = Ms @ np.array([p[0], p[1], 1.0])
        r = ss * (3 + 14 * min(1, s * 4) ** 0.6 * (1 - s) ** 1.1 + 2.5 * (1 - s))
        cv2.circle(sw, tuple(np.round(q * 16).astype(int)), int(r * 16), 1.0, -1, cv2.LINE_AA, 4)

    def brush(mask, ang, seed):
        b = cv2.GaussianBlur(mask, (0, 0), 5)
        st = _streaks(CW, CH, ang, 260, 3.2, seed)
        e = b - 0.5 + (st - 0.5) * 0.9 * np.clip(1.2 - b, 0, 1)
        return np.clip(e * 5 + 0.5, 0, 1) * (mask > 0.02)

    lt = brush(lt, TAG_ANG + 76, 81)
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

    # ---- paint colour: tonal density, thin edges toward casing green, dense hot core
    bl = cv2.GaussianBlur(body, (0, 0), 2.2)
    thin = _smooth((0.62 - bl) / 0.5)
    core = _smooth((cv2.GaussianBlur(body, (0, 0), 6) - 0.80) / 0.2)
    tone = value_noise(ww, hh, 40, 3, 65) * 0.7 + value_noise(ww, hh, 11, 2, 67) * 0.3
    col = GREEN[None, None, :] * (0.76 + 0.30 * tone)[..., None]
    col += (GREEN_DK - col) * (0.38 * thin)[..., None]
    col += (GREEN_HOT - col) * (0.16 * core)[..., None]
    tcol = np.clip(col, 0, 255).astype(np.float32)

    # ---- overspray: soft halo, speckled fringe hugging the edge, sparse mist
    rng = np.random.default_rng(63)
    halo = cv2.GaussianBlur(body, (0, 0), 6) * 0.12
    solid = (body > 0.35).astype(np.uint8)
    ring1 = cv2.dilate(solid, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))).astype(np.float32)
    ring2 = cv2.dilate(solid, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))).astype(np.float32)
    rnd = rng.random((hh, ww)).astype(np.float32)
    lvl = rng.uniform(0.45, 1.0, (hh, ww)).astype(np.float32)
    fringe = ((rnd < 0.25) * ring1 + (rnd > 0.955) * (ring2 - ring1)) * lvl
    fringe = np.clip(cv2.GaussianBlur(fringe, (0, 0), 0.5) * 1.4, 0, 1) * (1 - np.clip(body * 1.5, 0, 1))
    near = cv2.GaussianBlur(body, (0, 0), 20)
    mist = (rng.random((hh, ww)).astype(np.float32) < near * 0.035).astype(np.float32)
    mist = np.clip(cv2.GaussianBlur(mist, (0, 0), 0.55) * 1.8, 0, 1) * (1 - body)
    # dark knock-out outline so the green separates from the bone type
    shadow = cv2.GaussianBlur(cv2.dilate(body, np.ones((5, 5), np.uint8)), (0, 0), 2.5)

    # ---- reveal-time map (half res): per letter, geodesic distance along the
    # strokes from the letter's start point (bottom-left), constant pen speed
    ds = 2
    hs, ws = hh // ds, ww // ds
    lt_s = cv2.resize(lt1, (ws, hs), interpolation=cv2.INTER_AREA)
    sw_s = cv2.resize(sw1, (ws, hs), interpolation=cv2.INTER_AREA)
    a = math.radians(TAG_ANG)
    yy, xx = np.mgrid[0:hs, 0:ws].astype(np.float32)
    U = xx * math.cos(a) - yy * math.sin(a)          # along the baseline
    V = xx * math.sin(a) + yy * math.cos(a)          # down, across it
    lm = cv2.dilate((lt_s > 0.3).astype(np.uint8), np.ones((3, 3), np.uint8))
    n_, lab, st, _ = cv2.connectedComponentsWithStats(lm, connectivity=8)
    big = st[1:, cv2.CC_STAT_AREA].max()
    comps = [i for i in range(1, n_) if st[i, cv2.CC_STAT_AREA] > 0.03 * big]
    comps.sort(key=lambda i: float(U[lab == i].mean()))
    parts = []
    for i in comps:
        x, y, w_, h_ = (int(v) for v in st[i, :4])
        msk = lab[y:y + h_, x:x + w_] == i
        score = np.where(msk, (U - 0.6 * V)[y:y + h_, x:x + w_], np.inf)
        seed = np.unravel_index(int(np.argmin(score)), score.shape)
        d = _geo_dist(msk, seed)
        parts.append((x, y, w_, h_, msk, d, float(d[np.isfinite(d)].max())))
    GAP = 0.022
    speed = sum(p[6] for p in parts) / (T_LET - GAP * (len(parts) - 1))     # half-res px / s
    t_let = np.full((hs, ws), np.inf, np.float32)
    t0 = TSP + 0.02
    for (x, y, w_, h_, msk, d, dmax) in parts:
        blk = t_let[y:y + h_, x:x + w_]
        blk[msk] = np.minimum(blk[msk], t0 + d[msk] / speed)
        t0 += dmax / speed + GAP
    # swoosh: one stroke from its left end
    smk = (sw_s > 0.3).astype(np.uint8)
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats(smk, connectivity=8)
    kk = 1 + int(np.argmax(st2[1:, cv2.CC_STAT_AREA]))
    smask = lab2 == kk
    seed = np.unravel_index(int(np.argmin(np.where(smask, U, np.inf))), smask.shape)
    dsw = _geo_dist(smask, seed)
    t_sw = TSP + 0.43 + dsw / float(dsw[np.isfinite(dsw)].max()) * 0.13
    tm = t_let.copy()
    use_sw = np.isfinite(t_sw) & ((sw_s > lt_s + 0.05) | ~np.isfinite(t_let))
    tm[use_sw] = t_sw[use_sw]
    tcore = tm.copy()
    tm = _nearest_fill(tm)
    # ragged spray front (static jitter of the arrival time, ~ +-12 px)
    jit = value_noise(ws, hs, 7, 2, 66) - 0.5
    tm = tm + jit * (24.0 / speed)
    tmap = cv2.resize(tm, (ww, hh), interpolation=cv2.INTER_LINEAR).astype(np.float32)

    # nozzle path: centre of the most recently painted pixels, per frame
    paint = np.isfinite(tcore)
    nozzle = {}
    for fi in range(int(TSP * FPS), int((TSP + 0.62) * FPS) + 2):
        tt = fi / FPS
        valid = paint & (tcore <= tt)
        if not valid.any():
            continue
        tmx = float(tcore[valid].max())
        if tt - tmx > 0.03:
            continue
        sel = valid & (tcore > tmx - 0.016)
        py_, px_ = np.nonzero(sel)
        nozzle[fi] = (float(px_.mean() * ds), float(py_.mean() * ds))

    # drip origins on the free bottom edges of the letter feet (A leg, M, Y stem ...)
    # and of the swoosh; long gravity runs from the letters, shorter ones elsewhere
    rng2 = np.random.default_rng(64)
    drips = []
    ox_ = TAG_X - lcx
    oy_ = TAG_Y - lcy
    xlim = _layout()["ink_r"] - max(int(e[-1]) for _, e in _caption(CAP_R)) - 24   # right caption block
    bot_all = np.zeros_like(body, bool)
    bot_all[:-6] = (body[:-6] > 0.6) & (body[6:] < 0.05)
    nl, llab, lst, _ = cv2.connectedComponentsWithStats((lt1 > 0.5).astype(np.uint8), connectivity=8)
    lbig = lst[1:, cv2.CC_STAT_AREA].max()
    letters = [i for i in range(1, nl) if lst[i, cv2.CC_STAT_AREA] > 0.03 * lbig]
    letters.sort(key=lambda i: lst[i, cv2.CC_STAT_LEFT] + lst[i, cv2.CC_STAT_WIDTH] / 2)
    SHORT, MED, LONG = (40, 70), (90, 140), (150, 220)

    def add(x, y, lens, dmin, dmax):
        wdt = float(rng2.uniform(3.8, 8.5))
        L = min(float(rng2.uniform(*lens)), DRIP_FLOOR - (y + oy_))
        t0 = float(tmap[y, x]) + 0.06 + float(rng2.uniform(0, 0.22))
        drips.append((x, y + 2, wdt, L, t0, float(rng2.uniform(dmin, dmax)), float(rng2.uniform(0.5, 0.75)),
                      float(rng2.uniform(0, 1))))

    def pick(region, lens_list, min_gap, taken):
        cy_, cx_ = np.nonzero(bot_all & region)
        order = np.argsort(-(cy_ + rng2.uniform(0, 30, len(cy_))))
        n = 0
        for i in order:
            x, y = int(cx_[i]), int(cy_[i])
            if any(abs(x - tx) < min_gap for tx in taken) or x + ox_ > xlim:
                continue
            taken.append(x)
            add(x, y, lens_list[n], 1.6, 1.9)
            n += 1
            if n >= len(lens_list):
                break

    taken = []
    # per letter (A, R, M, Y): which runs come off its feet
    plan = {0: [LONG, SHORT], 1: [], 2: [MED], 3: [LONG]}
    for j, li in enumerate(letters[:4]):
        if plan.get(j):
            pick(llab == li, plan[j], 56, taken)
    pick(sw1 > 0.5, [MED, SHORT], 90, taken)
    return dict(body=body, tmap=tmap, tcol=tcol, halo=halo, mist=mist, fringe=fringe, shadow=shadow, drips=drips,
                nozzle=nozzle, ox=int(round(TAG_X - lcx)), oy=int(round(TAG_Y - lcy)), w=ww, h=hh)


def _drip_layer(tg, t):
    hh, ww = tg["h"], tg["w"]
    dm = np.zeros((hh, ww), np.float32)
    for (x, y, wd, L, t0, dur, bk, ph) in tg["drips"]:
        if t < t0:
            continue
        p = clamp((t - t0) / dur)
        # gravity run that slows as the paint thins, with small stop-and-go spurts
        q = p + 0.55 / (6 * math.pi) * (math.sin(2 * math.pi * (3 * p + ph)) - math.sin(2 * math.pi * ph))
        cur = L * (1 - (1 - clamp(q)) ** 1.7)
        if cur < 0.5:
            continue
        # tapering run (slight sideways wander) + round bead at the tip
        top_w, mid_w = wd * 0.75, wd * 0.34
        yb = y + cur
        xb = x + 1.5 * math.sin(ph * 6.28 + cur / 40.0)
        poly = np.array([(x - top_w, y - 6), (x + top_w, y - 6), (xb + mid_w, yb), (xb - mid_w, yb)], np.float64)
        cv2.fillConvexPoly(dm, np.round(poly * 16).astype(np.int32), 1.0, cv2.LINE_AA, 4)
        br = wd * bk * (0.75 + 0.25 * min(cur / 30, 1))
        cv2.circle(dm, (int(round(xb * 16)), int(round((yb - br * 0.3) * 16))), int(br * 16), 1.0, -1, cv2.LINE_AA, 4)
    return dm


def _render_tag(f, t, fi):
    """Composite the tag; returns (fy0, fx0, cover) - the painted coverage in the
    frame window (used to keep the matte spray paint out of the bloom key)."""
    if t < TSP:
        return None
    tg = _tag()
    ox, oy, hh, ww = tg["ox"], tg["oy"], tg["h"], tg["w"]
    # visible window of the tag canvas inside the frame
    fx0, fy0 = max(ox, 0), max(oy, 0)
    fx1, fy1 = min(ox + ww, W), min(oy + hh, H)
    tx0, ty0 = fx0 - ox, fy0 - oy
    win = (slice(ty0, ty0 + fy1 - fy0), slice(tx0, tx0 + fx1 - fx0))
    # paint arrives with a ragged front and builds up over ~3 frames
    rv = t - tg["tmap"][win]
    rev = np.clip(rv / 0.016, 0, 1) * (0.5 + 0.5 * np.clip(rv / 0.10, 0, 1))
    dm = _drip_layer(tg, t)[win]
    body = np.maximum(tg["body"][win] * rev, dm)
    shadow = np.maximum(cv2.GaussianBlur(dm, (0, 0), 2.5), tg["shadow"][win] * rev)
    tcol = tg["tcol"][win]
    sub = f[fy0:fy1, fx0:fx1]
    sub *= (1 - 0.45 * shadow[..., None])
    sub += (GREEN * 0.6 - sub * 0.3) * (tg["halo"][win] * rev)[..., None]
    sub += (GREEN - sub) * (tg["mist"][win] * rev * 0.8)[..., None]
    sub += (tcol - sub) * (tg["fringe"][win] * np.clip(rv / 0.05, 0, 1))[..., None]
    sub += (tcol - sub) * body[..., None]
    cover = np.maximum(body, tg["fringe"][win])
    hh, ww = sub.shape[:2]
    # live nozzle mist at the spray front
    nz = tg["nozzle"].get(int(round(t * FPS)))
    if nz is not None:
        rng = np.random.default_rng(5000 + fi)
        front = (nz[0] - tx0 + rng.normal(0, 6), nz[1] - ty0 + rng.normal(0, 6))
        swoosh = t >= TSP + 0.43
        spread = 40 if swoosh else 50
        n = 560 if swoosh else 700
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
    return fy0, fx0, cover


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
RET_S = 640
RET_R = 0.30 * RET_S       # ring radius in the reticle layer at scale 1


@lru_cache(maxsize=1)
def _reticle():
    """Hand-drawn reticle: two loose wobbly ring passes with dry-brush breaks,
    wavering cross hairs (short top arm), irregular ticks; a soft dark
    under-stroke is baked in so it separates from the bone type."""
    S, ss = RET_S, 2
    N = S * ss
    img = np.zeros((N, N), np.float32)
    c = N / 2
    R = 0.30 * N
    rng = np.random.default_rng(71)

    def stroke(p0, p1, th):
        cv2.line(img, tuple(np.round(np.asarray(p0) * 16).astype(int)), tuple(np.round(np.asarray(p1) * 16).astype(int)),
                 1.0, max(1, int(round(th))), cv2.LINE_AA, 4)

    # ring: two loose passes with overshoot, 2nd/5th/9th-harmonic wobble, dry-brush breaks
    for (th, a0, span, jit, dr, nbrk) in ((11.0, -0.5, 2 * math.pi + 0.55, 7.0, 0, 3),
                                          (5.5, 2.2, 2 * math.pi * 0.55, 6.0, 8, 1)):
        k = 320
        ph = rng.uniform(0, 6.28, 3)
        brk = rng.uniform(0.12, 0.88, nbrk)
        bwd = rng.uniform(0.025, 0.045, nbrk)
        pts = []
        for i in range(k + 1):
            a = a0 + span * i / k
            rr = R + dr * ss + jit * ss * (math.sin(a * 2 + ph[0]) * 0.5 + math.sin(a * 5 + ph[1]) * 0.3
                                           + math.sin(a * 9 + ph[2]) * 0.2)
            pts.append(np.array([c + rr * math.cos(a), c + rr * math.sin(a)]))
        bristles = rng.uniform(-0.42, 0.42, (k, 3))
        keep = rng.random((k, 3))
        for i in range(k):
            s = i / k
            taper = min(1, s * 9 + 0.15, (1 - s) * 5 + 0.1)
            g = 1.0
            for b, bw in zip(brk, bwd):
                g = min(g, abs(s - b) / bw)
            p0, p1 = pts[i], pts[i + 1]
            if g >= 1:
                stroke(p0, p1, th * ss * taper)
                continue
            # dry brush: the stroke splits into thin bristle lines that drop out
            nrm = np.array([math.cos(a0 + span * s), math.sin(a0 + span * s)])
            for j in range(3):
                if keep[i, j] > 0.25 + 0.7 * g and g < 0.35:
                    continue
                o = nrm * th * ss * taper * (j - 1) * 0.36
                stroke(p0 + o, p1 + o, max(1.5, th * ss * taper * (0.18 + 0.5 * g)))
    # cross hairs: gap at centre, wavering lines, top arm short (stays inside frame)
    gap = 0.075 * N
    for dx, dy, L in ((1, 0, 0.47), (-1, 0, 0.455), (0, 1, 0.41), (0, -1, 0.30)):
        L = L * N
        ph = rng.uniform(0, 6.28, 2)
        amp = rng.uniform(2.0, 3.0) * ss
        k = 48

        def P(s):
            r = gap + (L - gap) * s
            wv = amp * (math.sin(s * math.pi * 1.3 + ph[0]) * 0.6 + math.sin(s * math.pi * 3.4 + ph[1]) * 0.4)
            return np.array([c + dx * r - dy * wv, c + dy * r + dx * wv])

        for i in range(k):
            s0, s1 = i / k, (i + 1) / k
            taper = min(1, (1 - s0) * 4 + 0.15, s0 * 10 + 0.4)
            stroke(P(s0), P(s1), 8.0 * ss * taper)
        for j, fr in enumerate((0.45, 0.66, 0.84, 1.20, 1.40)):
            pr = fr * R
            if pr > L - 0.02 * N:
                continue
            tl = (0.024 if j not in (2, 3) else 0.042) * N * rng.uniform(0.75, 1.25)
            ta = math.radians(rng.uniform(-4, 4))
            pc = P((pr - gap) / (L - gap))
            # tick direction: perpendicular to the arm, rotated a little
            tx, ty = -dy, dx
            tx, ty = tx * math.cos(ta) - ty * math.sin(ta), tx * math.sin(ta) + ty * math.cos(ta)
            off = rng.uniform(-0.15, 0.15) * tl
            stroke((pc[0] - tx * (tl - off), pc[1] - ty * (tl - off)), (pc[0] + tx * (tl + off), pc[1] + ty * (tl + off)),
                   5 * ss * rng.uniform(0.85, 1.15))
    cv2.circle(img, (int(c * 16), int(c * 16)), int(5.5 * ss * 16), 1.0, -1, cv2.LINE_AA, 4)
    img = np.clip(img, 0, 1)
    nz = value_noise(N, N, 4, 2, 72)
    img *= 1 - np.clip((nz - 0.72) * 3, 0, 1) * 0.45
    s_ = np.clip(cv2.resize(img, (S, S), interpolation=cv2.INTER_AREA), 0, 1)
    # soft dark under-stroke, baked: darken by 0.5*sh, then green over by s_
    sh = np.clip(cv2.GaussianBlur(cv2.dilate(s_, np.ones((3, 3), np.uint8)), (0, 0), 4.0) * 1.6, 0, 1) * 0.5
    A = 1 - (1 - sh) * (1 - s_)
    C = (INK[None, None, :] * (sh * (1 - s_))[..., None] + GREEN[None, None, :] * s_[..., None]) / np.maximum(A, 1e-5)[..., None]
    return np.dstack([C, A]).astype(np.float32)


@lru_cache(maxsize=1)
def _o_geom():
    """'O' of UM TIRO. in its final position (layout space): centre x, centre y,
    left and right ink x."""
    L1big, L1, L2, s1f = _lines()
    ss, pad = 2, 28
    f, xs, box = _text_geom("UM TIRO.", ANTON, STAGE_PX, ss, L1_TRACK, L1_SPACE)
    x0 = box[0]
    xo = xs[6] if xs is not None else f.getlength("UM TIRO") - f.getlength("O")
    ob = f.getbbox("O")
    lx0 = (pad * ss - x0 + xo + ob[0]) / ss
    lx1 = (pad * ss - x0 + xo + ob[2]) / ss
    bx0, _, bx1, _ = L1big["bbox"]
    ccx = (bx0 + bx1) / 2
    fx0 = W / 2 + (lx0 - ccx) * s1f
    fx1 = W / 2 + (lx1 - ccx) * s1f
    cap1 = _layout()["cap1"]
    return (fx0 + fx1) / 2, L1_TOP + cap1 / 2, fx0, fx1


# ================================================================ camera
def _camera(t):
    s = 1.0 + 0.055 * (t / DUR) + 0.012 * ease_in_out(prog(t, 0, 1.6))
    dx, dy, ang = 0.0, 0.0, 0.0
    for T, amp, sd in ((T1, 22, 1), (T2, 26, 2), (TCL, 5, 3)):
        a, b, c = shake(t, amp, 33, seed=sd, decay_from=T, decay=8.0)
        dx, dy, ang = dx + a, dy + b, ang + c
    a, b, c = shake(t, 1.6, 1.7, seed=9)        # hand-held drift
    dx, dy, ang = dx + a, dy + b, ang + c * 3
    pw = prog(t, TWH, DUR) ** 1.4               # whip: accelerating, ~350 px/frame at the cut
    dx -= 2400 * pw
    ang -= 0.8 * pw
    s += 0.03 * pw
    return s, ang, dx, dy, pw


# ================================================================ render
_HALF = {}


def _zoom_draw(f, L, s_lead, s_trail, cx, cy, opacity, n=16, clip_y=None):
    """Zoom-blurred white-hot copy of line L: weighted premultiplied average of
    n scales from s_lead (current, weighted most -> crisp front edge) to
    s_trail, rendered at half resolution, centred on (cx, cy)."""
    hp = _HALF.get(id(L))
    if hp is None:
        hp = resize_layer(premul(L["hot"]), 0.5)
        _HALF[id(L)] = hp
    h, w = hp.shape[:2]
    ow, oh = int(math.ceil(w * s_trail)) + 6, int(math.ceil(h * s_trail)) + 6
    acc = np.zeros((oh, ow, 4), np.float32)
    wsum = 0.0
    for j in range(n):
        u = j / (n - 1)
        sc = s_lead + (s_trail - s_lead) * u
        wt = math.exp(-1.6 * u)
        M = cv2.getRotationMatrix2D((w / 2, h / 2), 0, sc)
        M[0, 2] += ow / 2 - w / 2
        M[1, 2] += oh / 2 - h / 2
        acc += cv2.warpAffine(hp, M, (ow, oh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0) * wt
        wsum += wt
    acc /= wsum
    big = cv2.resize(acc, (ow * 2, oh * 2), interpolation=cv2.INTER_LINEAR)
    o = unpremul(big)
    if clip_y is not None:   # feathered top clip (frame row clip_y), 14 px ramp
        rows = np.arange(o.shape[0], dtype=np.float32) + (int(round(cy - oh)))
        o[..., 3] *= np.clip((rows - clip_y) / 14.0, 0, 1)[:, None]
    over(f, o, cx - ow, cy - oh, opacity)


def _slam(f, L, T, t, icx, itop, base_s=1.0, clip_y=None):
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
        # zoom about the line's landing centre
        cx = icx + (L["w"] / 2 - (bx0 + bx1) / 2) * base_s
        cy = itop + (L["h"] / 2 - by0) * base_s
        _zoom_draw(f, L, base_s * s, base_s * (s + step), cx, cy, 0.55 + 0.45 * p, clip_y=clip_y)
        return
    s = 1 - 0.022 * math.exp(-dt * 15) * math.cos(dt * 40)
    hot = 1 - ease_out_cubic(clamp(dt / 0.34))
    _draw_line(f, L, base_s * s, icx, itop, hot=hot)


def _bands(f, drift, amp):
    """Broad anamorphic green glow bands of the whip exit, soft-ended along x and
    hotter towards the left (match s4's opening bridge field at y 715 / 860)."""
    h, w = H // 2, W // 2
    y = np.arange(h, dtype=np.float32)[:, None] * 2
    x = np.arange(w, dtype=np.float32)[None, :] * 2
    out = np.zeros((h, w), np.float32)
    for yc, sy, a, xa, xb in ((716, 46, 0.5, -200, 1180), (860, 30, 0.38, -200, 760)):
        u = np.clip((x - xa - drift) / (xb - xa), 0, 1)
        prof = np.maximum(np.sin(np.pi * u), 0) ** 0.7 * (1 - 0.5 * u)
        out += a * np.exp(-((y - yc) / sy) ** 2) * prof
    f += cv2.resize(out, (W, H), interpolation=cv2.INTER_LINEAR)[..., None] * (GREEN * amp)


def _mv(t):
    """Line 1 make-room move progress (smootherstep)."""
    x = prog(t, T_MV0, T_MV1)
    return x * x * x * (x * (6 * x - 15) + 10)


def render(t, ctx):
    # snap float noise from the global timeline (e.g. 6.3 - 6.0) onto the frame grid
    r = round(t * FPS)
    if abs(t * FPS - r) < 1e-3:
        t = min(r / FPS, DUR - 1e-6)
    fi = ctx.get("local_frame", int(round(t * FPS)))
    L1big, L1, L2, s1f = _lines()
    lay = _layout()
    f = _bg().copy()

    # --- faint drifting haze
    _haze(f, t)

    # --- halftone corners: breathe in, pulse on each hit
    pulse = sum(math.exp(-(t - T) * 5.0) * 0.5 for T in (T1, T2) if t >= T)
    k = 0.45 + 0.55 * ease_out_cubic(prog(t, 0.0, 1.0)) + pulse + 0.03 * math.sin(t * 2.2)
    grow = ease_in_out(prog(t, 0.0, T1))       # from s2's hand-over field to the bolder one
    _halftone_corners(f, k, 0.30 + 0.12 * grow + 0.15 * min(pulse, 1), grow)

    # --- cracks inherited from scene 2, fading (kick on the first hit)
    ca = 0.32 * (1 - ease_in_out(prog(t, 0.0, 0.9)))
    if t >= T1:
        ca += 0.30 * math.exp(-(t - T1) * 8) * (1 - prog(t, T1, 1.0))
    if ca > 0.004:
        f += (BONE - f) * (_cracks() * ca)[..., None]

    # --- headline
    icx = W / 2
    L2top = lay["L2top"]
    # line 1 makes room (motion-blurred glide up + down-scale to line 2's width),
    # then recoils when line 2 lands under it
    mv = _mv(t)
    kick = -18 * math.exp(-(t - T2) * 11) * (1 if t >= T2 else 0)
    stage_top = lay["stage_top"]
    # line 2's zoom-blurred approach goes UNDER the parked line 1 and is clipped
    # just below its baseline (no double exposure over line 1)
    if t < T2:
        _slam(f, L2, T2, t, icx, L2top, clip_y=L1_TOP + lay["cap1"] + 4)
    if mv <= 0:
        _slam(f, L1big, T1, t, icx, stage_top)
    elif mv < 0.999:
        top = stage_top + (L1_TOP - stage_top) * mv
        top_p = stage_top + (L1_TOP - stage_top) * _mv(t - DT)
        vb = abs(top - top_p) * 0.6
        _draw_line(f, L1big, 1 + (s1f - 1) * mv, icx, top, vblur=vb)
    else:
        _draw_line(f, L1, 1.0, icx, L1_TOP + kick)
    if t >= T2:
        _slam(f, L2, T2, t, icx, L2top)

    _dust(f, t, T1, icx + _foot_cols(1), stage_top + lay["capS"], 101)
    _dust(f, t, T2, icx + _foot_cols(2), L2top + lay["cap2"], 202)

    # --- target lock: the O of TIRO flashes green when the reticle snaps on
    if TCL <= t < TCL + 0.4:
        k = 0.9 * math.exp(-(t - TCL) * 8)
        _, _, ox0, ox1 = _o_geom()
        xa, xb = int(ox0 - 4), int(ox1 + 4)
        ya, yb = int(L1_TOP - 8), int(L1_TOP + lay["cap1"] + 8)
        reg = f[ya:yb, xa:xb]
        lum = reg @ np.array([0.299, 0.587, 0.114], np.float32)
        msk = np.clip((lum - 70) / 90, 0, 1) * k
        reg += (GREEN - reg) * msk[..., None]

    # --- graffiti tag
    tag_cov = _render_tag(f, t, fi)

    # --- captions
    ink_l, ink_r = lay["ink_l"], lay["ink_r"]
    cy = L2top + lay["cap2"] + 50 - CAP_TOP_PAD - 6
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
        ox, oy = _o_geom()[:2]
        rs = lay["cap1"] / 2 * 1.04 / RET_R          # ring hugs the O
        dt = t - TCL
        if dt < 0:
            p = prog(t, TCL - 2 * DT, TCL)
            sc, rot, op = 1.75 - 0.45 * p, -32 * (1 - p), 0.3 + 0.4 * p
            sc *= rs / 0.93
        else:
            sc = (1.10 - 0.17 * ease_out_cubic(prog(dt, 0.0, 0.6)) + 0.04 * math.exp(-dt * 28)) * rs / 0.93
            rot = 5 * math.exp(-dt * 10) * math.cos(dt * 32)
            op = 1.0
        sx = 3.0 * math.sin(t * 3.1) * clamp((dt - 0.3) * 3)
        sy = 2.0 * math.sin(t * 2.3 + 1) * clamp((dt - 0.3) * 3)
        o = _xform(ret, sc, rot)
        over(f, o, ox - o.shape[1] / 2 + sx, oy - o.shape[0] / 2 + sy, op)
        # double ping ring: full-strength stroke in its own mask, faded by opacity
        for d0, th, amp in ((0.0, 4, 0.8), (0.06, 3, 0.5)):
            q = (dt - d0) / 0.32
            if not (0 <= q < 1):
                continue
            rr = 190 + 560 * ease_out_cubic(q)
            m = int(rr + 8)
            xa, xb = max(int(ox - m), 0), min(int(ox + m) + 1, W)
            ya, yb = max(int(oy - m), 0), min(int(oy + m) + 1, H)
            ring = np.zeros((yb - ya, xb - xa), np.float32)
            cv2.circle(ring, (int(round((ox - xa) * 4)), int(round((oy - ya) * 4))), int(rr * 4), 1.0, th, cv2.LINE_AA, 2)
            reg = f[ya:yb, xa:xb]
            reg += (GREEN - reg) * (ring * (amp * (1 - q) ** 1.5))[..., None]

    # --- green bloom (keyed on green pixels only)
    q = cv2.resize(f, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    key = np.clip((q[..., 1] - 0.5 * (q[..., 0] + q[..., 2]) - 45) / 70, 0, 1)
    if tag_cov is not None:     # spray paint is matte: no neon halo around the tag
        fy0, fx0, cov = tag_cov
        km = np.zeros((H, W), np.float32)
        km[fy0:fy0 + cov.shape[0], fx0:fx0 + cov.shape[1]] = cov
        km = cv2.resize(km, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
        key *= 1 - np.clip(km * 2.5, 0, 1)
    gsum = cv2.GaussianBlur(key, (0, 0), 5) * 0.5 + cv2.GaussianBlur(key, (0, 0), 18) * 0.5
    f += cv2.resize(gsum, (W, H), interpolation=cv2.INTER_LINEAR)[..., None] * (GREEN * 0.42)

    # --- thin green floor line (from zero: s2's last frame has none)
    li = 0.7 * ease_out_cubic(prog(t, 0.05, 0.6)) + 0.6 * pulse
    if li > 0.003:
        light_streak(f, 1036, li, GREEN, thickness=2, length=0.86)

    # --- camera (reflect border for shakes; wrap during the whip: never an empty edge)
    s, ang, dx, dy, pw = _camera(t)
    M = cv2.getRotationMatrix2D((W / 2, H / 2), ang, s)
    M[0, 2] += dx
    M[1, 2] += dy
    if pw > 0.002:
        # whip: what comes in from the right is the bare dark wall (no wrapped headline)
        f = cv2.warpAffine(f, M, (W, H), dst=_bg().copy(), flags=cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_TRANSPARENT)
        kk = int(1 + 590 * pw)
        f = cv2.blur(f, (kk, 1))
        f = cv2.blur(f, (max(1, kk // 2), 1))
        # the plate drops toward s4's darker opening smear; the light streaks carry the cut
        f *= 1 - 0.6 * ease_in_out(prog(t, TWH + 0.08, DUR - DT))
    else:
        f = cv2.warpAffine(f, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    if pw > 0.002:
        # hot light-streak flash ramping into the cut (s4 carries these streaks on)
        fl = 0.95 * ease_in_cubic(prog(t, TWH + 0.07, DUR - DT))
        if fl > 0.004:
            drift = (2036 - 2400 * pw) * 0.3
            for y, col, th, ln, cx, k_ in ((238, GREEN, 3, 0.52, 620, 1.0), (424, BONE, 2, 0.36, 700, 0.55),
                                          (905, GREEN, 2, 0.42, 860, 0.6), (716, GREEN, 6, 0.70, 560, 0.45)):
                light_streak(f, y, fl * k_, col, thickness=th, length=ln, cx=cx + drift)
            # broad soft green light bands under the streaks (s4 opens on the same two bands)
            _bands(f, drift, 1.6 * fl)

    # impact flash: one luminance-inverted frame on each slam, then a quick lift
    for T in (T1, T2):
        d = t - T
        if -1e-6 <= d < DT - 1e-6:
            lum = f @ np.array([0.299, 0.587, 0.114], np.float32)
            f = INK + (BONE - INK) * np.clip(1 - lum / 215.0, 0, 1)[..., None]
        elif DT - 1e-6 <= d < 3 * DT:
            f = f + (BONE - f) * 0.08 * (1 - (d - DT) / (2 * DT))
    return np.clip(f, 0, 255)
