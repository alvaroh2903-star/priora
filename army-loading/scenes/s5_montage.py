"""Scene 5 · s5_montage (4.0 s) — rapid-cut kinetic word montage on a 0.4 s grid.

Ten full-frame graphic cards, hard cuts on the beat, backgrounds alternating
black+halftone (B) / full-bleed green (G) / bone-grey concrete (C):

  k  t     bg  card                     micro-motion
  0  0.0   B   PVP                      0.08 s hand-off flash from s4, then P-V-P slam in
                                        one frame apart (1.24->1), corner pulse + kick each
  1  0.4   G   SEM / REGRAS             lines slam in from opposite sides (motion blur),
                                        hazard-stripe block (hard-chipped paint) wipes + scrolls
  2  0.8   C   SÓ SKILL                 type drops + hard stop, two thrown paint splats
                                        (straight tapered spikes + beads) behind the upper
                                        K/I and the S foot, drips run
  3  1.2   B   PACIÊNCIA.               HIGH anchor: word slams 1.14 -> 1 then tracks apart;
                                        green timer line fills low in the frame
  4  1.6   G   POSIÇÃO.                 CENTRE: stepped grid-snap into position, brackets
                                        close, registration marks + signed coordinate readout
  5  2.0   C   PRECISÃO                 LOW: huge word bleeding off both edges, sliced, halves
                                        slide into register (forward motion blur); ruler in
                                        the upper third, marker settles on 0
  6  2.4   B   ammo 30 -> 00            fixed 2-digit readout (dim leading zero), shaded
                                        tumbling casings fan out of an ejection glint
                                        (shell), magazine row empties, 00 pops green
  7  2.8   G   kill-feed strip          worn-print ARMY ▸ ✕ ▸ ELIMINADO slab (edge chips, grit,
                                        halftone dissolve tail) slams in, ✕ stamps with a hot
                                        edge flash + kick, echo rows drift apart
  8  3.2   C   reticle lock             hand-drawn reticle whips in and locks within two
                                        frames of the click, lock brackets, green hit splat
  9  3.6   B   O SILÊNCIO / TAMBÉM /    typed 3 chars/frame, ELIMINA. lands whole in green
               ELIMINA.                 with a punch, solid cursor hold; hard cut to black
                                        at 4.0 (scene 6 opens black)

Every cut is an impact (0.0 ... 3.2) with a decaying screen-space shake; HUD
corner brackets + card index stay locked to the screen while content shakes,
and the halftone corner fields fade out under the HUD text and under each
card's small captions (per-card keep-out boxes), so all small type stays crisp.
All type is Anton, built once (3x supersampled, distressed: eaten edges,
grit, halftone fade at the feet, scratches) and cached.
"""
from lib import *

DUR = 4.0
BEAT = 0.4
CUES = sorted([(round(BEAT * i, 3), "impact") for i in range(9)] + [(2.4, "shell"), (3.2, "click")])

ANTON = os.path.join(FONTS, "Anton-Regular.ttf")
OSWALD = os.path.join(FONTS, "Oswald.ttf")
DT = 1.0 / FPS

CONC = np.array([172, 169, 160], np.float32)      # bone-grey concrete
FLASH_C = np.array([222, 255, 192], np.float32)  # scene 4's exit flash colour
KINDS = "BGCBGCBGCB"


# ================================================================ small utils
def _col(c):
    return tuple(float(v) for v in c)


def _pm(lay):
    """straight RGBA layer -> premultiplied"""
    return premul(lay)


def _comp(f, pm, x, y, op=1.0):
    """Composite premultiplied RGBA pm onto f at integer (x, y)."""
    x, y = int(round(x)), int(round(y))
    h, w = pm.shape[:2]
    x0, y0 = max(x, 0), max(y, 0)
    x1, y1 = min(x + w, W), min(y + h, H)
    if x1 <= x0 or y1 <= y0 or op <= 0:
        return
    s = pm[y0 - y:y1 - y, x0 - x:x1 - x]
    d = f[y0:y1, x0:x1]
    if op >= 0.999:
        d *= 1 - s[..., 3:4]
        d += s[..., :3]
    else:
        d *= 1 - s[..., 3:4] * op
        d += s[..., :3] * op


def _put(f, pm, anchor, ax, ay, s=1.0, ang=0.0, op=1.0, blur=(0, 0)):
    """Place premultiplied layer so that layer point `anchor` lands on (ax, ay),
    scaled by s / rotated by ang (deg) about that anchor. blur=(kx, ky) adds a
    directional box motion blur."""
    h, w = pm.shape[:2]
    if abs(s - 1) < 1e-3 and abs(ang) < 1e-3 and blur[0] < 2 and blur[1] < 2:
        _comp(f, pm, ax - anchor[0], ay - anchor[1], op)
        return
    M = cv2.getRotationMatrix2D((float(anchor[0]), float(anchor[1])), ang, s)
    M[0, 2] += ax - anchor[0]
    M[1, 2] += ay - anchor[1]
    cs = np.array([[0, 0, 1], [w, 0, 1], [0, h, 1], [w, h, 1]], np.float64) @ M.T
    bx = int(math.floor(cs[:, 0].min())) - 2 - blur[0] // 2
    by = int(math.floor(cs[:, 1].min())) - 2 - blur[1] // 2
    bx1 = int(math.ceil(cs[:, 0].max())) + 3 + blur[0] // 2
    by1 = int(math.ceil(cs[:, 1].max())) + 3 + blur[1] // 2
    bx, by = max(bx, -blur[0]), max(by, -blur[1])
    bx1, by1 = min(bx1, W + blur[0]), min(by1, H + blur[1])
    if bx1 <= bx or by1 <= by:
        return
    M[0, 2] -= bx
    M[1, 2] -= by
    o = cv2.warpAffine(pm, M, (bx1 - bx, by1 - by), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    if blur[0] >= 2 or blur[1] >= 2:
        o = cv2.blur(o, (max(1, int(blur[0])), max(1, int(blur[1]))))
    _comp(f, o, bx, by, op)


def _vn(w, h, scale, octaves, seed, down=2):
    """Low-frequency value noise computed at 1/down resolution, upsampled."""
    if down <= 1 or scale / down < 2:
        return value_noise(w, h, scale, octaves, seed)
    n = value_noise(max(2, w // down), max(2, h // down), scale / down, octaves, seed)
    return cv2.resize(n, (w, h), interpolation=cv2.INTER_LINEAR)


def _vblur_amount(fn, u, scale=0.6, cap=70):
    """Shutter-length (half frame) displacement of a motion function fn(u)."""
    return min(abs(fn(u + DT * 0.5) - fn(u)) * scale, cap)


# ================================================================ distressed type
@lru_cache(maxsize=64)
def _mask(text, path, px, ss=None, pad=18):
    if ss is None:
        ss = 3 if px < 300 else 2
    f = ImageFont.truetype(path, int(round(px * ss)))
    l, t, r, b = f.getbbox(text, anchor="ls")
    p = pad * ss
    adv = f.getlength(text)
    Wc = int(math.ceil(max(r, adv) + 2 * p))
    Hc = int(math.ceil(b - t + 2 * p))
    Wc += (-Wc) % ss
    Hc += (-Hc) % ss
    im = Image.new("L", (Wc, Hc), 0)
    base = p - t
    ImageDraw.Draw(im).text((p, base), text, font=f, fill=255, anchor="ls")
    m = np.asarray(im, np.float32) / 255.0
    m1 = cv2.resize(m, (Wc // ss, Hc // ss), interpolation=cv2.INTER_AREA)
    cap = -f.getbbox("H", anchor="ls")[1] / ss
    xs = [(p + f.getlength(text[:i])) / ss for i in range(len(text) + 1)]
    return m1, base / ss, cap, xs


def _dot_holes(w, h, cell, angle, amount, r0=0):
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


def _wear(m, seed, sc, amt=1.0, feet=1.0, base=None, cap=None, guard=0):
    """Poster-print distress of a type alpha mask (1x). guard > 0 keeps the big
    wear holes `guard` px inside the strokes, so no hole cuts a thin stem."""
    h, w = m.shape
    rng = np.random.default_rng(seed)
    nf = value_noise(w, h, max(1.6, 2.0 * sc), 2, seed + 1)
    nm = value_noise(w, h, 7 * sc, 3, seed + 3)
    nc = _vn(w, h, 17 * sc, 3, seed + 2, 2)
    mb = cv2.GaussianBlur(m, (0, 0), 0.75 + 0.35 * sc)
    chip = np.clip((nc - 0.70) * 4, 0, 1)
    rough = np.clip((mb - 0.5 + (nf - 0.5) * 0.55 * amt + (nm - 0.5) * 0.30 * amt - chip * 0.5 * amt) * 6.5 + 0.5, 0, 1)
    # grit density: clumps + edges
    inner = cv2.GaussianBlur(m, (0, 0), 6 * sc)
    edge = np.clip((0.93 - inner) * 2.4, 0, 1) * m
    clump = _vn(w, h, 40 * sc, 4, seed + 6, 2)
    dens = np.clip((clump - 0.35) * 1.8, 0, 1) * 0.75 + edge * 0.7
    sm = (rng.random((h, w)) < 0.05).astype(np.float32)
    sm = cv2.GaussianBlur(sm, (0, 0), 0.55) * 2.2
    bgk = (rng.random((h // 3 + 1, w // 3 + 1)) < 0.05).astype(np.float32)
    bgk = cv2.resize(bgk, (w, h), interpolation=cv2.INTER_LINEAR)
    bgk = np.clip((cv2.GaussianBlur(bgk, (0, 0), 0.8) - 0.1) * 6, 0, 1)
    speck = np.clip((sm + bgk) * np.clip(dens * 1.3, 0, 1), 0, 1)
    # faint mesh + halftone fade at the feet
    cell = 5.5 + 1.2 * sc
    mesh = _dot_holes(w, h, cell, 45.0, np.clip((_vn(w, h, 100 * sc, 3, seed + 7, 4) - 0.45) * 1.4, 0, 0.40))
    dots = np.zeros((h, w), np.float32)
    if feet > 0 and base is not None:
        ty = base - cap
        yy = (np.arange(h, dtype=np.float32)[:, None] - ty) / max(cap, 1)
        # fade grows toward the baseline, then backs off below it (cedillas, commas)
        ramp = np.clip((yy - 0.68) / 0.32, 0, 1) * np.clip(1 - (yy - 0.97) / 0.04, 0.12, 1)
        bot = ramp * np.clip(_vn(w, h, 70 * sc, 3, seed + 9, 4) * 1.8 - 0.45, 0, 1) * feet
        r0 = int(max(ty + 0.66 * cap, 0))
        if r0 < h:
            dots[r0:] = _dot_holes(w, h, cell * 1.25, 45.0, np.clip(bot[r0:], 0, 1), r0)
    wear = _vn(w, h, 60 * sc, 5, seed + 4, 2)
    holes = np.clip((wear + (nm - 0.5) * 0.10 + (nf - 0.5) * 0.05 - 0.79) * 45, 0, 1)
    if guard > 0:
        k = 2 * int(guard) + 1
        inner_ok = cv2.erode(m, np.ones((k, k), np.uint8)) > 0.5
        holes *= cv2.GaussianBlur(inner_ok.astype(np.float32), (0, 0), 1.0)
    # scratches + vertical streaks
    simg = np.zeros((h, w), np.uint8)
    nsc = int(w * h / 9000)
    for _ in range(nsc):
        x0, y0 = rng.uniform(0, w), rng.uniform(0, h)
        an = rng.normal(-0.4, 0.5)
        L = rng.uniform(5, 35) * sc
        cv2.line(simg, (int(x0 * 16), int(y0 * 16)), (int((x0 + L * math.cos(an)) * 16), int((y0 + L * math.sin(an)) * 16)),
                 int(rng.uniform(120, 230)), 1, cv2.LINE_AA, 4)
    for _ in range(int(nsc * 0.8)):
        x0, y0 = rng.uniform(0, w), rng.uniform(0, h)
        L = rng.uniform(15, 120) * sc
        cv2.line(simg, (int(x0 * 16), int(y0 * 16)), (int((x0 + rng.normal(0, 2)) * 16), int((y0 + L) * 16)),
                 int(rng.uniform(70, 170)), 1, cv2.LINE_AA, 4)
    scr = simg.astype(np.float32) / 255.0
    tex = (1 - 0.95 * holes) * (1 - 0.9 * dots) * (1 - 0.3 * mesh) * (1 - 0.92 * speck) * (1 - 0.8 * scr)
    return (rough * np.clip(1 - (1 - tex) * amt, 0, 1)).astype(np.float32)


@lru_cache(maxsize=64)
def _type(text, px, seed, color, amt=1.0, feet=1.0, path=ANTON, guard=0):
    """Distressed type -> dict(pm, base, cap, xs, bbox). color: 'bone'|'ink'|'green'|'white'."""
    m, base, cap, xs = _mask(text, path, px)
    sc = px / 380.0
    a = _wear(m, seed, sc, amt, feet, base, cap, guard) if amt > 0 else m.copy()
    h, w = a.shape
    if color == "bone":
        tone = _vn(w, h, 70 * sc, 4, seed + 8, 4)
        col = BONE[None, None, :] * (0.84 + 0.18 * tone[..., None])
    elif color == "green":
        tone = _vn(w, h, 70 * sc, 4, seed + 8, 4)
        col = GREEN[None, None, :] * (0.9 + 0.14 * tone[..., None])
    elif color == "white":
        col = np.broadcast_to(WHITE, (h, w, 3))
    else:
        col = np.broadcast_to(INK, (h, w, 3))
    pm = np.dstack([col * a[..., None], a]).astype(np.float32)
    ys, xk = np.nonzero(m > 0.3)
    bbox = (int(xk.min()), int(ys.min()), int(xk.max()) + 1, int(ys.max()) + 1)
    return {"pm": pm, "base": base, "cap": cap, "xs": xs, "bbox": bbox, "w": w, "h": h}


def _anchor_cap(T):
    """layer point: horizontal ink centre, vertical cap centre"""
    x0, _, x1, _ = T["bbox"]
    return ((x0 + x1) / 2.0, T["base"] - T["cap"] / 2.0)


@lru_cache(maxsize=16)
def _capfont(fname, size, weight):
    if fname == "anton":
        return ImageFont.truetype(ANTON, size)
    f = ImageFont.truetype(OSWALD, size)
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


@lru_cache(maxsize=96)
def _small(text, size, color, tracking=2, fname="oswald", weight=600):
    """Small caption (own font instance so the shared lib font cache is never
    modified), 2x supersampled, multi-line with \n. Premultiplied layer."""
    ss = 2
    f = _capfont(fname, size * ss, weight)
    asc, desc = f.getmetrics()
    lines = text.split("\n")
    lh = int((asc + desc) * 0.92)
    wmax = max(sum(f.getlength(ch) + tracking * ss for ch in ln) for ln in lines)
    w, h = int(wmax + 16 * ss), int(lh * len(lines) + 16 * ss)
    im = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(im)
    y = 8 * ss
    for ln in lines:
        x = 8 * ss
        for ch in ln:
            d.text((x, y), ch, font=f, fill=255)
            x += f.getlength(ch) + tracking * ss
        y += lh
    a = np.asarray(im, np.float32) / 255.0
    ys, xs = np.nonzero(a > 0.02)
    a = a[max(ys.min() - 4, 0): ys.max() + 5, max(xs.min() - 4, 0): xs.max() + 5]
    a = cv2.resize(a, (max(1, a.shape[1] // ss), max(1, a.shape[0] // ss)), interpolation=cv2.INTER_AREA)
    c = np.asarray(color, np.float32)
    out = np.empty(a.shape + (4,), np.float32)
    out[..., :3] = c * a[..., None]
    out[..., 3] = a
    return out


# ================================================================ backgrounds
@lru_cache(maxsize=1)
def _corner_maps():
    cw, ch = 1000, 720
    cell = 15
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    a = math.radians(45)
    u = xx * math.cos(a) + yy * math.sin(a)
    v = -xx * math.sin(a) + yy * math.cos(a)
    fu = (u / cell) % 1 - 0.5
    fv = (v / cell) % 1 - 0.5
    d = np.sqrt(fu * fu + fv * fv).astype(np.float32)
    nz = value_noise(cw, ch, 110, 3, 141)
    g = 1 - np.clip(np.hypot(xx / cw, yy / ch) * 1.05, 0, 1)
    g = np.clip(g * (0.6 + 0.7 * nz), 0, 1) ** 1.35
    return d, g.astype(np.float32), cell


@lru_cache(maxsize=1)
def _hud_keep():
    """Screen-space keep-out (0..1, feathered) around the HUD text: card chip
    (top-left), ARMY // PVP label (top-right), beat ticks (bottom-left)."""
    q = 4                                   # built at 1/4 res (it is a soft map)
    K = np.zeros((H // q, W // q), np.float32)
    # boxes are in content (pre-camera) space and cover the HUD items for any
    # camera zoom 1.03..1.10 the cards use (plus shake)
    for (x0, y0, x1, y1) in ((0, 0, 196, 146), (1612, 0, W, 144), (0, 952, 360, H)):
        K[y0 // q:y1 // q, x0 // q:x1 // q] = 1
    # wide feather: dots shrink away gradually instead of a boxed cut-out
    K = cv2.GaussianBlur(K, (0, 0), 38 / q)
    K = cv2.resize(K, (W, H), interpolation=cv2.INTER_LINEAR)
    return np.clip(K * 2.1, 0, 1).astype(np.float32)


@lru_cache(maxsize=4)
def _corner_g(flip, corner):
    """Halftone gradient for one corner field with the HUD keep-out cleared, so
    dots shrink away under HUD text (expressed in the corner field's frame)."""
    d, g, cell = _corner_maps()
    ch, cw = d.shape
    K = _hud_keep()
    if not flip:
        Kc = K[:ch, :cw] if corner == 0 else K[H - ch:, W - cw:][::-1, ::-1]
    else:
        Kc = K[:ch, W - cw:][:, ::-1] if corner == 0 else K[H - ch:, :cw][::-1, :]
    return (g * (1 - Kc)).astype(np.float32)


@lru_cache(maxsize=16)
def _keep_map(boxes, feather=22):
    """Extra screen-space keep-out (content space) for a card's small captions:
    the halftone dots shrink away around them (like the HUD keep-out), so HUD
    type never sits on dots of its own colour. boxes: tuple of int boxes."""
    q = 4
    K = np.zeros((H // q, W // q), np.float32)
    for (x0, y0, x1, y1) in boxes:
        K[max(y0, 0) // q:max(y1, 0) // q + 1, max(x0, 0) // q:max(x1, 0) // q + 1] = 1
    K = cv2.GaussianBlur(K, (0, 0), feather / q)
    K = cv2.resize(K, (W, H), interpolation=cv2.INTER_LINEAR)
    return np.clip(K * 2.1, 0, 1).astype(np.float32)


def _corners(f, color, k=1.0, op=1.0, flip=False, keep=None):
    d, g, cell = _corner_maps()
    ch, cw = d.shape
    color = np.asarray(color, np.float32)
    for corner in (0, 1):
        gk = _corner_g(flip, corner)
        if keep is not None:
            K = _keep_map(keep)
            if not flip:
                Kc = K[:ch, :cw] if corner == 0 else K[H - ch:, W - cw:][::-1, ::-1]
            else:
                Kc = K[:ch, W - cw:][:, ::-1] if corner == 0 else K[H - ch:, :cw][::-1, :]
            gk = gk * (1 - Kc)
        m = np.clip((np.minimum(gk * (0.62 * k), 0.52) - d) * cell * 0.9 + 0.5, 0, 1) * (gk > 0.01)
        m *= op * (1.0 if corner == 0 else 0.85)
        if not flip:
            reg, mm = (f[:ch, :cw], m) if corner == 0 else (f[H - ch:, W - cw:], m[::-1, ::-1])
        else:
            reg, mm = (f[:ch, W - cw:], m[:, ::-1]) if corner == 0 else (f[H - ch:, :cw], m[::-1, :])
        reg += (color - reg) * mm[..., None]


def _knock(f, kind, x0, y0, x1, y1, feather=10):
    """Feathered knock-out of the halftone/texture under a label: blend back to
    the clean plate inside the (padded) box."""
    pad = feather * 2
    X0, Y0 = max(int(x0) - pad, 0), max(int(y0) - pad, 0)
    X1, Y1 = min(int(x1) + pad, W), min(int(y1) + pad, H)
    if X1 <= X0 or Y1 <= Y0:
        return
    m = np.zeros((Y1 - Y0, X1 - X0), np.float32)
    m[max(int(y0) - Y0, 0):int(y1) - Y0, max(int(x0) - X0, 0):int(x1) - X0] = 1
    m = np.clip(cv2.GaussianBlur(m, (0, 0), feather * 0.5) * 1.4, 0, 1)
    sub = f[Y0:Y1, X0:X1]
    sub += (_plate(kind)[Y0:Y1, X0:X1] - sub) * m[..., None]


@lru_cache(maxsize=4)
def _grit(seed, amount=1.0):
    """Fine print / concrete grit (0..1 darkening mask): pores, clustered
    specks, a few hairline scratches. No big blotches."""
    rng = np.random.default_rng(seed)
    clump = value_noise(W // 2, H // 2, 90, 3, seed + 1)
    clump = cv2.resize(clump, (W, H), interpolation=cv2.INTER_LINEAR)
    p = 0.004 + 0.03 * np.clip((clump - 0.45) * 2.2, 0, 1)
    sp = (rng.random((H, W)) < p).astype(np.float32)
    sp = cv2.GaussianBlur(sp, (0, 0), 0.6) * 1.6
    big = (rng.random((H // 3, W // 3)) < 0.0035).astype(np.float32)
    big = cv2.resize(big, (W, H), interpolation=cv2.INTER_LINEAR)
    big = np.clip((cv2.GaussianBlur(big, (0, 0), 1.0) - 0.06) * 5, 0, 1)
    sc = np.zeros((H, W), np.uint8)
    for _ in range(70):
        x0, y0 = rng.uniform(0, W), rng.uniform(0, H)
        an = rng.normal(-0.35, 0.5)
        L = rng.uniform(30, 220)
        cv2.line(sc, (int(x0 * 16), int(y0 * 16)), (int((x0 + L * math.cos(an)) * 16), int((y0 + L * math.sin(an)) * 16)),
                 int(rng.uniform(60, 150)), 1, cv2.LINE_AA, 4)
    m = np.clip(sp + big * 0.8 + sc.astype(np.float32) / 255.0 * 0.5, 0, 1) * amount
    return m.astype(np.float32)


def _compose_plate(base, shade, mixes, offset=None):
    """Per-channel plate composition (cheaper than broadcasting 3-ch temporaries):
    base colour * shade, then successive lerps toward (colour, alpha) pairs."""
    out = np.empty((H, W, 3), np.float32)
    for c in range(3):
        ch = np.full((H, W), float(base[c]), np.float32) if shade is None else shade * float(base[c])
        for col, al in mixes:
            ch += (float(col[c]) - ch) * al
        if offset is not None:
            ch += offset
        out[..., c] = ch
    return out


@lru_cache(maxsize=4)
def _plate(kind):
    """Static background plates (layout space)."""
    if kind == "B":
        n = _vn(W, H, 260, 6, 531, 4)
        fn = value_noise(W, H, 3, 2, 542)[::-1]
        off = (n - 0.5) * 12 + (fn - 0.5) * 6 + _grit(545)[::-1] * 9
        return _compose_plate(INK, None, [], off)
    if kind == "G":
        n = _vn(W, H, 380, 5, 541, 4)
        mid = _vn(W, H, 48, 3, 543, 2)
        fn = value_noise(W, H, 3, 2, 542)
        shade = 0.99 + 0.10 * (n - 0.5) + 0.04 * (mid - 0.5) + 0.06 * (fn - 0.5)
        stain = np.clip((_vn(W, H, 220, 4, 544, 4) - 0.64) * 2.6, 0, 1) * 0.22
        return _compose_plate(GREEN, shade, [(GREEN_DK, stain), (INK, _grit(545) * 0.75)])
    if kind == "C":
        n = _vn(W, H, 380, 5, 551, 4)
        mid = _vn(W, H, 40, 4, 552, 2)
        fn = value_noise(W, H, 3, 2, 542)[:, ::-1]
        shade = 0.93 + 0.12 * (n - 0.5) + 0.06 * (mid - 0.5) + 0.08 * (fn - 0.5)
        stain = np.clip((_vn(W, H, 200, 4, 555, 4) - 0.62) * 2.5, 0, 1) * 0.25
        cr = crack_mask(W, H, W * 0.12, H * 0.88, seed=556, branches=7, progress=0.7, thickness=2)
        cr = np.maximum(cr, crack_mask(W, H, W * 0.9, H * 0.08, seed=557, branches=6, progress=0.55, thickness=1))
        return _compose_plate(CONC, shade, [(np.float32([128, 125, 118]), stain), (INK, _grit(545)[:, ::-1] * 0.7),
                                            (np.float32([84, 83, 80]), cr * 0.45)])
    raise ValueError(kind)


def _bg(kind, u, flip=False, pulse=1.0, k=None, keep=None):
    f = _plate(kind).copy()
    if k is None:
        k = 1.0 + 0.55 * math.exp(-u * 12) * pulse
    if kind == "B":
        _corners(f, BONE, k, 0.5, flip, keep)
    elif kind == "G":
        _corners(f, INK, k * 0.88, 0.8, flip, keep)
    else:
        _corners(f, INK, k, 0.72, flip, keep)
    return f


# ================================================================ shapes
def _poly(img, pts, color, shift=4):
    p = np.round(np.asarray(pts, np.float64) * (1 << shift)).astype(np.int32)
    cv2.fillPoly(img, [p], _col(color) if not np.isscalar(color) else color, cv2.LINE_AA, shift)


def _line(img, p0, p1, color, th, shift=4):
    a = tuple(int(round(v * (1 << shift))) for v in p0)
    b = tuple(int(round(v * (1 << shift))) for v in p1)
    cv2.line(img, a, b, _col(color) if not np.isscalar(color) else color, max(1, int(round(th))), cv2.LINE_AA, shift)


def _brackets(f, x0, y0, x1, y1, arm, th, color):
    for (cx, cy, sx, sy) in ((x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)):
        _poly(f, [(cx, cy), (cx + sx * arm, cy), (cx + sx * arm, cy + sy * th), (cx + sx * th, cy + sy * th),
                  (cx + sx * th, cy + sy * arm), (cx, cy + sy * arm)], color)


def _spike_poly(c, a, r0, L, wb, rng, segs):
    """Bent, tapering paint streak from radius r0 to L along angle a: a
    polyline whose joints random-walk sideways, outlined into a polygon."""
    ca, sa = math.cos(a), math.sin(a)
    nx, ny = -sa, ca
    off = 0.0
    cen = []
    for j in range(segs + 1):
        q = j / segs
        d = r0 + (L - r0) * q
        if j:
            off += rng.normal(0, 0.06 * (L - r0))
        cen.append((c + d * ca + off * nx, c + d * sa + off * ny))
    cen = np.array(cen)
    # densify with a smooth (quadratic) pass so the bend reads as a curve
    t = np.linspace(0, 1, 6 * segs + 1)
    xs = np.interp(t, np.linspace(0, 1, segs + 1), cen[:, 0])
    ys = np.interp(t, np.linspace(0, 1, segs + 1), cen[:, 1])
    xs = np.convolve(np.pad(xs, 2, mode="edge"), np.ones(5) / 5, "valid")
    ys = np.convolve(np.pad(ys, 2, mode="edge"), np.ones(5) / 5, "valid")
    tx, ty = np.gradient(xs), np.gradient(ys)
    tn = np.hypot(tx, ty) + 1e-6
    px, py = -ty / tn, tx / tn
    wob = 1 + 0.18 * np.sin(t * rng.uniform(9, 15) + rng.uniform(0, 6.28))
    wdt = (wb * (1 - t) ** 0.9 * 0.72 + wb * 0.28) * wob
    left = np.stack([xs + px * wdt, ys + py * wdt], 1)
    right = np.stack([xs - px * wdt, ys - py * wdt], 1)[::-1]
    return np.vstack([left, right]), (xs[-1], ys[-1])


SPLAT_STYLES = {
    # spikes count, spike length (xR), base width (xR), bend segments, bead prob, mist density, droplets
    "paint": dict(slen=(0.62, 1.25), swid=(0.05, 0.13), segs=0, bead=0.75, mist=0.10, drops=70),
    "spray": dict(slen=(0.45, 0.85), swid=(0.03, 0.08), segs=4, bead=0.7, mist=0.22, drops=110),
}


@lru_cache(maxsize=8)
def _splat(R, seed, spikes=22, ndrips=6, style="paint"):
    """Spray-paint impact splat: noisy core, tapered radial spikes (straight
    with beads for 'paint', bent thin streaks for 'spray'), satellite droplets,
    overspray mist, and drip origins. Returns dict(body, mist, drips, c)."""
    sty = SPLAT_STYLES[style]
    rng = np.random.default_rng(seed)
    ss = 1
    S = int(R * 2.8) * ss
    c = S / 2
    Rs = R * ss
    body = np.zeros((S, S), np.float32)
    # core
    na = 360
    ang = np.linspace(0, 2 * math.pi, na, endpoint=False)
    k = np.zeros(na)
    for fq in (2, 3, 5, 7, 11):
        k += rng.normal(0, 1.0 / fq) * np.sin(fq * ang + rng.uniform(0, 6.28))
    r = Rs * 0.52 * (1 + 0.22 * k)
    pts = np.stack([c + r * np.cos(ang), c + r * np.sin(ang)], 1)
    cv2.fillPoly(body, [np.round(pts * 16).astype(np.int32)], 1.0, cv2.LINE_AA, 4)
    # spikes
    base_a = rng.uniform(0, 2 * math.pi) if sty["segs"] else 0.0   # (paint style keeps its rng sequence)
    for i in range(spikes):
        if sty["segs"]:
            a = base_a + (i + rng.uniform(-0.35, 0.35)) / spikes * 2 * math.pi
        else:
            a = rng.uniform(0, 2 * math.pi)
        L = Rs * rng.uniform(*sty["slen"]) * (1.0 if rng.random() < 0.7 else 0.75)
        wb = Rs * rng.uniform(*sty["swid"])
        if sty["segs"]:
            L += Rs * 0.32
            poly, tip_xy = _spike_poly(c, a, Rs * 0.32, L, wb, rng, sty["segs"] + int(rng.random() < 0.5))
            cv2.fillPoly(body, [np.round(poly * 16).astype(np.int32)], 1.0, cv2.LINE_AA, 4)
            ta = math.atan2(tip_xy[1] - c, tip_xy[0] - c)
            tipd = math.hypot(tip_xy[0] - c, tip_xy[1] - c)
        else:
            tip = (c + L * math.cos(a), c + L * math.sin(a))
            p1 = (c + Rs * 0.3 * math.cos(a) - wb * math.sin(a), c + Rs * 0.3 * math.sin(a) + wb * math.cos(a))
            p2 = (c + Rs * 0.3 * math.cos(a) + wb * math.sin(a), c + Rs * 0.3 * math.sin(a) - wb * math.cos(a))
            cv2.fillConvexPoly(body, np.round(np.array([p1, tip, p2]) * 16).astype(np.int32), 1.0, cv2.LINE_AA, 4)
            ta, tipd = a, L
        if sty["segs"] and rng.random() < sty["bead"]:   # blob where the jet ends
            br = wb * rng.uniform(0.45, 0.75)
            cv2.circle(body, (int(tip_xy[0] * 16), int(tip_xy[1] * 16)), max(16, int(br * 16)), 1.0, -1, cv2.LINE_AA, 4)
        elif rng.random() < sty["bead"]:
            d = tipd * rng.uniform(1.04, 1.22)
            br = wb * rng.uniform(0.35, 0.8)
            cv2.circle(body, (int((c + d * math.cos(ta)) * 16), int((c + d * math.sin(ta)) * 16)), max(16, int(br * 16)), 1.0, -1,
                       cv2.LINE_AA, 4)
    # satellite droplets
    for i in range(sty["drops"]):
        a = rng.uniform(0, 2 * math.pi)
        d = Rs * (0.55 + rng.exponential(0.35))
        if d > c * 0.95:
            continue
        br = Rs * 0.05 * rng.uniform(0.2, 1.0) * max(0.25, 1.2 - d / Rs * 0.6)
        cv2.circle(body, (int((c + d * math.cos(a)) * 16), int((c + d * math.sin(a)) * 16)), max(16, int(br * 16)), 1.0, -1, cv2.LINE_AA, 4)
    # ragged paint edge
    nz = value_noise(S, S, 3, 2, seed + 1)
    bb = cv2.GaussianBlur(body, (0, 0), 1.1)
    body = np.clip((bb - 0.5 + (nz - 0.5) * 0.35) * 5 + 0.5, 0, 1)
    body = cv2.resize(body, (S // ss, S // ss), interpolation=cv2.INTER_AREA)
    S1 = S // ss
    c1 = S1 / 2
    # overspray mist: fine dots, dense near the splat
    q4 = cv2.resize(body, (S1 // 4, S1 // 4), interpolation=cv2.INTER_AREA)
    near = cv2.resize(cv2.GaussianBlur(q4, (0, 0), R * 0.18 / 4), (S1, S1), interpolation=cv2.INTER_LINEAR)
    near = near / max(near.max(), 1e-6)
    mist = (rng.random((S1, S1)) < near * sty["mist"]).astype(np.float32)
    mist = np.clip(cv2.GaussianBlur(mist, (0, 0), 0.5) * 2.0, 0, 1)
    if sty["mist"] > 0.15:   # coarser overspray specks too
        m2 = (rng.random((S1, S1)) < near * sty["mist"] * 0.12).astype(np.float32)
        mist = np.maximum(mist, np.clip(cv2.GaussianBlur(m2, (0, 0), 1.0) * 5.0, 0, 1))
    mist *= 1 - body
    # paint density variation inside the body (subtle)
    tone = _vn(S1, S1, R * 0.15, 3, seed + 2, 2)
    # drip origins: lowest points of the core
    drips = []
    for i in range(ndrips):
        x = c1 + rng.uniform(-0.42, 0.42) * R
        col = body[:, int(x)]
        ys = np.nonzero(col[int(c1):] > 0.5)[0]
        if not len(ys):
            continue
        # walk down while contiguous
        y = int(c1)
        while y + 1 < S1 and body[y + 1, int(x)] > 0.5:
            y += 1
        drips.append((float(x), float(y - 3), rng.uniform(0.05, 0.11) * R, rng.uniform(0.35, 1.0) * R, rng.uniform(0.0, 0.08)))
    return dict(body=body.astype(np.float32), mist=mist.astype(np.float32), tone=tone, drips=drips, c=c1, S=S1)


@lru_cache(maxsize=8)
def _splat_static(R, seed, spikes, ndrips, style="paint"):
    """Static premultiplied splat body + overspray (cached)."""
    sp = _splat(R, seed, spikes, ndrips, style)
    a = np.clip(sp["body"] + sp["mist"] * 0.85, 0, 1).astype(np.float32)
    out = np.empty(a.shape + (4,), np.float32)
    sh = (0.92 + 0.12 * sp["tone"]) * a
    for c in range(3):
        out[..., c] = sh * float(GREEN[c])
    out[..., 3] = a
    return out


def _drip_layer(sp, t_drip, drip_speed=1.0):
    """Premultiplied drips (small canvas) grown to t_drip -> (pm, x0, y0) in
    splat-canvas coordinates, or None."""
    runs = []
    for (x, y, wd, L, d0) in sp["drips"]:
        p = clamp((t_drip - d0) * drip_speed)
        if p <= 0:
            continue
        cur = L * (1 - (1 - p) ** 2.2)
        runs.append((x, y, wd, min(y + cur, sp["S"] - wd - 2)))
    if not runs:
        return None
    x0 = int(min(r[0] - r[2] for r in runs)) - 4
    x1 = int(max(r[0] + r[2] for r in runs)) + 5
    y0 = int(min(r[1] for r in runs)) - 6
    y1 = int(max(r[3] + r[2] for r in runs)) + 5
    dm = np.zeros((y1 - y0, x1 - x0), np.float32)
    for (x, y, wd, yb) in runs:
        x, y, yb = x - x0, y - y0, yb - y0
        poly = np.array([(x - wd * 0.8, y - 4), (x + wd * 0.8, y - 4), (x + wd * 0.42, yb), (x - wd * 0.42, yb)])
        cv2.fillConvexPoly(dm, np.round(poly * 16).astype(np.int32), 1.0, cv2.LINE_AA, 4)
        cv2.circle(dm, (int(x * 16), int(yb * 16)), int(wd * 0.62 * 16), 1.0, -1, cv2.LINE_AA, 4)
    return np.dstack([dm[..., None] * GREEN, dm]).astype(np.float32), x0, y0


def _draw_splat(f, R, seed, spikes, ndrips, cx, cy, scale, t_drip, drip_speed=1.0, style="paint"):
    sp = _splat(R, seed, spikes, ndrips, style)
    c = sp["c"]
    d = _drip_layer(sp, t_drip, drip_speed)
    if d is not None:
        pm, x0, y0 = d
        _put(f, pm, (c - x0, c - y0), cx, cy, scale)
    _put(f, _splat_static(R, seed, spikes, ndrips, style), (c, c), cx, cy, scale)


def _green_bloom(f, gain=0.42, thr=45, wide=0.0):
    """Green-keyed bloom. wide adds an extra halo that sits mostly outside the
    green shapes (a glow boost that does not wash the green toward yellow)."""
    q = cv2.resize(f, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    key = np.clip((q[..., 1] - 0.5 * (q[..., 0] + q[..., 2]) - thr) / 70, 0, 1)
    gsum = cv2.GaussianBlur(key, (0, 0), 5) * 0.5 + cv2.GaussianBlur(key, (0, 0), 18) * 0.5
    if wide > 0:
        gsum = gsum * gain + cv2.GaussianBlur(key, (0, 0), 14) * (1 - cv2.GaussianBlur(key, (0, 0), 2)) * wide
        f += cv2.resize(gsum, (W, H), interpolation=cv2.INTER_LINEAR)[..., None] * GREEN
        return
    f += cv2.resize(gsum, (W, H), interpolation=cv2.INTER_LINEAR)[..., None] * (GREEN * gain)


# ================================================================ HUD (screen space)
def _hud(f, k, kind, u):
    c = BONE * 0.78 if kind == "B" else INK
    m, arm, th = 46, 44, 4
    _brackets(f, m, m, W - m, H - m, arm, th, c)
    # card index chip
    chip_bg, chip_fg = {"B": (GREEN, INK), "G": (INK, GREEN), "C": (INK, BONE)}[kind]
    idx = _small(f"{k + 1:02d}", 26, _col(chip_fg), 3)
    cx0, cy0 = m + 14, m + 12
    _poly(f, [(cx0, cy0), (cx0 + idx.shape[1] + 14, cy0), (cx0 + idx.shape[1] + 14, cy0 + idx.shape[0] + 6), (cx0, cy0 + idx.shape[0] + 6)], chip_bg)
    _comp(f, idx, cx0 + 7, cy0 + 3)
    lab = _small("ARMY // PVP", 22, _col(c), 5)
    _comp(f, lab, W - m - 16 - lab.shape[1], m + 14)
    # beat ticks: 10 small bars, current one highlighted
    x0 = m + 16
    y0 = H - m - 22
    for i in range(10):
        on = i <= k
        if kind == "G":
            col = INK if on else GREEN_DK
        else:
            col = GREEN if (i == k) else (c if on else c * 0.45 + (CONC if kind == "C" else INK) * 0.55)
        _poly(f, [(x0 + i * 22, y0), (x0 + i * 22 + 14, y0), (x0 + i * 22 + 14, y0 + 6), (x0 + i * 22, y0 + 6)], col)


# ================================================================ card 0 — PVP
PVP_T0 = 0.03            # first letter lands just as the hand-off flash clears
PVP_LANDS = (PVP_T0, PVP_T0 + DT, PVP_T0 + 2 * DT)
PVP_GUARD = 4            # big wear holes stay inside the strokes; seed 17 keeps the V vertex whole


@lru_cache(maxsize=1)
def _pvp_letters():
    """Split the distressed PVP word at the ink gaps between letters."""
    T = _type("PVP", 860, 17, "bone", guard=PVP_GUARD)
    a = T["pm"][..., 3]
    col = a.max(axis=0) > 0.02
    xs = T["xs"]
    cuts = [0]
    for i in (1, 2):
        lo, hi = int(xs[i]) - 60, int(xs[i]) + 60
        seg = col[lo:hi]
        gap = np.nonzero(~seg)[0]
        cuts.append(lo + int(gap.mean()) if len(gap) else int(round(xs[i])))
    cuts.append(T["w"])
    out = []
    for i in range(3):
        a0, a1 = cuts[i], cuts[i + 1]
        cc = np.nonzero(col[a0:a1])[0]
        cxl = a0 + (cc.min() + cc.max()) / 2.0 if len(cc) else (a0 + a1) / 2.0
        out.append((T["pm"][:, a0:a1].copy(), a0, cxl))
    return T, out


def _c_pvp(u, fi):
    T, letters = _pvp_letters()
    # halftone corners pulse on every landing
    kc = 1.0 + sum(0.42 * math.exp(-(u - l) * 13) for l in PVP_LANDS if u >= l)
    f = _bg("B", u, k=min(kc, 1.75))
    ac = _anchor_cap(T)
    push = 1.0 + 0.02 * u / BEAT
    for (pm, a0, cxl), l in zip(letters, PVP_LANDS):
        if u < l:
            continue
        e = ease_out_expo(clamp((u - l) / 0.17))
        s = push + 0.24 * (1 - e)
        _put(f, pm, (cxl - a0, ac[1]), 960 + (cxl - ac[0]) * push, 548, s)
    # green floor line
    light_streak(f, 1012, 0.55 + 0.6 * math.exp(-max(u - PVP_T0, 0) * 10), GREEN, thickness=2, length=0.8)
    # small caption block, with >= 60 px of air to the P stem
    cap = _small("SERVIDOR\nCOMPETITIVO", 30, _col(BONE * 0.85), 3)
    _comp(f, cap, 100, 860)
    _poly(f, [(100, 846), (148, 846), (148, 851), (100, 851)], GREEN)
    _green_bloom(f, 0.35)
    return f, dict(s=1.0, push=0.03, shake=0, kicks=((PVP_LANDS[0], 16), (PVP_LANDS[1], 8), (PVP_LANDS[2], 11)))


# ================================================================ card 1 — SEM / REGRAS
@lru_cache(maxsize=1)
def _stripes_tex():
    w, h = 1400, 700
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    per = 92.0
    u = (xx + yy) / math.sqrt(2)
    ph = (u / (per / math.sqrt(2) * math.sqrt(2))) % 1.0
    # anti-aliased stripe: 50% duty
    dd = np.abs(ph - 0.5) * per
    m = np.clip(per * 0.25 - dd + 0.5, 0, 1)
    g = grunge(w, h, 561)
    # hard-edged paint wear: worn spots are clean chips (no translucent haze)
    g2 = np.clip((g - 0.55) * 5, 0, 1)
    return np.clip(m * g2, 0, 1).astype(np.float32)


def _c_regras(u, fi):
    f = _bg("G", u, flip=True)
    T1 = _type("SEM", 488, 21, "ink")
    T2 = _type("REGRAS", 488, 22, "ink")
    cap = T2["cap"]
    x0b, _, x1b, _ = T2["bbox"]
    wR = x1b - x0b
    left = (W - wR) / 2
    top1 = (H - (2 * cap + 38)) / 2 - 4
    top2 = top1 + cap + 38

    def slide(uu, sgn, delay=0.0):
        return sgn * 300 * (1 - ease_out_expo(clamp((uu - delay) / 0.11)))

    d1 = slide(u, -1) + 9 * u / BEAT
    d2 = slide(u, 1, 0.0) - 9 * u / BEAT
    b1 = int(_vblur_amount(lambda q: slide(q, -1), u))
    b2 = int(_vblur_amount(lambda q: slide(q, 1, 0.0), u))
    # hazard stripe block right of SEM
    s0x = T1["bbox"][2] - T1["bbox"][0]
    bx0 = left + s0x + 46
    bx1 = left + wR
    rv = ease_out_expo(clamp((u - 0.02) / 0.12))
    bw = int((bx1 - bx0) * rv)
    if bw > 2:
        st = _stripes_tex()
        off = int(u * 260) % 92
        hh = int(cap)
        crop = st[off:off + hh, :bw]
        y0 = int(top1)
        x0 = int(bx0 + d1 * 0.4)
        sub = f[y0:y0 + hh, x0:x0 + bw]
        sub += (INK - sub) * crop[:sub.shape[0], :sub.shape[1], None]
    _put(f, T1["pm"], (T1["bbox"][0], T1["base"] - cap), left + d1, top1, blur=(b1, 0))
    _put(f, T2["pm"], (T2["bbox"][0], T2["base"] - cap), left + d2, top2, blur=(b2, 0))
    # small caption tucked under stripes
    if rv > 0.9:
        c = _small("ZERO DESCULPAS.", 26, _col(INK), 4)
        _comp(f, c, bx1 - c.shape[1] + d1 * 0.4, top1 + cap + 6)
    return f, dict(s=1.0, push=0.025, shake=12)


# ================================================================ card 2 — SÓ SKILL
SK_R, SK_SEED, SK_SPIKES, SK_CX, SK_CY = 340, 572, 16, 1330, 420
SK2_CX, SK2_CY = 735, 800

def _c_skill(u, fi):
    f = _bg("C", u)
    # 520 px: ~110 px clear of each frame edge after the camera push
    T = _type("SÓ SKILL", 520, 31, "ink")
    # green paint splat (straight tapered spikes + beads) behind the upper
    # K/I join, so the lower half of SKILL stays ink on concrete
    pe = ease_out_expo(clamp(u / 0.06))
    _draw_splat(f, SK_R, SK_SEED, SK_SPIKES, 7, SK_CX, SK_CY, 0.5 + 0.5 * pe if pe < 0.999 else 1.0, u * 2.4)
    # second, smaller throw at the lower-left of SKILL, one frame later
    if u >= DT - 1e-4:
        p2 = ease_out_expo(clamp((u - DT) / 0.06))
        _draw_splat(f, 150, 577, 14, 3, SK2_CX, SK2_CY, 0.5 + 0.5 * p2 if p2 < 0.999 else 1.0, (u - DT) * 2.6)
    def drop(q):
        return -170 * (1 - ease_out_expo(clamp(q / 0.1)))
    dy = drop(u)
    bl = int(_vblur_amount(drop, u))
    _put(f, T["pm"], _anchor_cap(T), 960, 600 + dy, 1.0, blur=(0, bl))
    return f, dict(s=1.0, push=0.03, shake=18)


# ================================================================ card 3 — PACIÊNCIA.
PAC_TOP = 214            # cap top: upper third (cards 3/4/5 anchor high / centre / low)
PAC_LINE_Y = 838         # timer line, low

def _c_paciencia(u, fi):
    """High anchor: the word sits in the upper third and slams in (1.14 -> 1),
    then tracks apart; the patience timer runs low, across the same width."""
    T = _type("PACIÊNCIA.", 372, 41, "bone")
    xs = T["xs"]
    n = len(xs) - 1
    pm = T["pm"]
    tr = 2 + 13 * ease_out_cubic(clamp(u / BEAT))
    x0, _, x1, _ = T["bbox"]
    wtot = (x1 - x0) + tr * (n - 1)
    left = (W - wtot) / 2
    top = PAC_TOP
    yb = PAC_LINE_Y
    lx0, lx1 = left, left + wtot
    lab = _small("AGUARDE O MOMENTO", 26, _col(BONE * 0.8), 5)
    sec = _small(f"{u * 1000:03.0f} MS", 26, _col(GREEN), 4)
    cy_ = yb + 24
    # captions under the timer: halftone dots shrink away around them (the
    # boxes cover the whole tracking range, so the keep-out is static)
    lmin = (W - (x1 - x0) - 15 * (n - 1)) / 2
    lmax = (W - (x1 - x0) - 2 * (n - 1)) / 2
    ch_ = max(lab.shape[0], sec.shape[0])
    keep = ((int(lmin) - 14, cy_ - 8, int(lmax + lab.shape[1]) + 14, cy_ + ch_ + 8),
            (int(W - lmax - sec.shape[1] - 30), cy_ - 8, int(W - lmin) + 14, cy_ + ch_ + 8))
    f = _bg("B", u, flip=True, keep=keep)
    # type slam about the cap centre, then the tracking drift
    sl = 1.0 + 0.14 * (1 - ease_out_expo(clamp(u / 0.12)))
    acx, acy = W / 2, top + T["cap"] / 2
    ytop = top - (T["base"] - T["cap"])
    for i in range(n):
        a0 = 0 if i == 0 else int(round(xs[i]))
        a1 = T["w"] if i == n - 1 else int(round(xs[i + 1]))
        strip = pm[:, a0:a1]
        sx = left - x0 + a0 + tr * i
        if sl > 1.001:
            _put(f, strip, (acx - sx, acy - ytop), acx, acy, sl)
        else:
            _comp(f, strip, sx, ytop)
    # timer line (patience), low in the frame
    _poly(f, [(lx0, yb), (lx1, yb), (lx1, yb + 3), (lx0, yb + 3)], BONE * 0.22 + INK * 0.78)
    p = clamp(u / (BEAT - DT))
    hx = lx0 + (lx1 - lx0) * p
    _poly(f, [(lx0, yb - 1), (hx, yb - 1), (hx, yb + 4), (lx0, yb + 4)], GREEN)
    _poly(f, [(hx - 2, yb - 9), (hx + 2, yb - 9), (hx + 2, yb + 12), (hx - 2, yb + 12)], GREEN_HOT)
    _comp(f, lab, lx0, cy_)
    _comp(f, sec, lx1 - sec.shape[1], cy_)
    _green_bloom(f, 0.4)
    return f, dict(s=1.06, push=0.0, shake=8, punch=0.05)


# ================================================================ card 4 — POSIÇÃO.
def _c_posicao(u, fi):
    f = _bg("G", u)
    T = _type("POSIÇÃO.", 440, 51, "ink")
    steps = [(-60, 34, 1.04, 64), (30, -18, 0.985, 44), (0, 0, 1.0, 30)]
    st = 0 if u < 2 * DT - 1e-4 else (1 if u < 4 * DT - 1e-4 else 2)
    ox, oy, s, mg = steps[st]
    drift = 6 * clamp((u - 4 * DT) / (BEAT - 4 * DT)) if st == 2 else 0
    cx, cy = 960, 505
    _put(f, T["pm"], _anchor_cap(T), cx + ox + drift, cy + oy, s)
    x0, y0, x1, y1 = T["bbox"]
    ac = _anchor_cap(T)
    bx0 = cx + (x0 - ac[0]) * s + ox - mg
    bx1 = cx + (x1 - ac[0]) * s + ox + mg
    by0 = cy + (y0 - ac[1]) * s + oy - mg
    by1 = cy + (y1 - ac[1]) * s + oy + mg
    _brackets(f, bx0, by0, bx1, by1, 64, 9, INK)
    # registration marks at mid-height outside the brackets (kept on-frame)
    for xm in (max(bx0 - 46, 110), min(bx1 + 46, W - 110)):
        ym = cy + oy
        cv2.circle(f, (int(xm * 16), int(ym * 16)), 17 * 16, _col(INK), 3, cv2.LINE_AA, 4)
        _line(f, (xm - 26, ym), (xm + 26, ym), INK, 3)
        _line(f, (xm, ym - 26), (xm, ym + 26), INK, 3)
    # readouts sit inside the bottom bracket corners, on the bracket line;
    # signs follow the actual offset; anchors clamped to a safe box
    coords = f"X {ox:+05d}  Y {oy:+05d}"
    c = _small(coords, 28, _col(INK), 4)
    lk = _small("TRAVADO" if st == 2 else "AJUSTANDO", 28, _col(INK), 6)
    lh = max(c.shape[0], lk.shape[0])
    ly = min(by1 - lh + 3, H - 130 - lh)
    lkx = clamp(bx0 + 64 + 18, 120, W - 120 - lk.shape[1])
    cxr = clamp(bx1 - 64 - 18 - c.shape[1], 120, W - 120 - c.shape[1])
    for (lay, lx_) in ((lk, lkx), (c, cxr)):
        _knock(f, "G", lx_ - 8, ly - 4, lx_ + lay.shape[1] + 8, ly + lay.shape[0] + 4, 12)
        _comp(f, lay, lx_, ly)
    return f, dict(s=1.0, push=0.02, shake=10)


# ================================================================ card 5 — PRECISÃO.
PRE_PX = 570             # deliberate bleed: ~45-75 px off both frame edges (cuts the P stem / O bowl)
PRE_TXT = "PRECISÃO"     # the full stop would sit off-frame anyway (a sliver of it read as an accident)
PRE_OFF = 180            # slice: halves start this far out of register
PRE_CX, PRE_CY = 960, 650   # ink centre; low anchor (cards 3/4/5: high / centre / low)
PRE_RY = 186             # ruler line, upper third (ticks up, marker below)
PRE_RL, PRE_RR = 250, 1670


def _pre_off(q):
    return PRE_OFF * (1 - ease_out_expo(clamp(q / 0.15)))


def _c_precisao(u, fi):
    T = _type(PRE_TXT, PRE_PX, 61, "ink")
    pm = T["pm"]
    rl, rr, ry = PRE_RL, PRE_RR, PRE_RY
    v = _small(f"{(1 - ease_out_expo(clamp((u - 0.03) / 0.22))) * 4.20:0.2f} MM".replace(".", ","), 28, _col(INK), 4)
    tl = _small("TOLERÂNCIA", 28, _col(INK), 6)
    capy = ry - 28 - 16 - tl.shape[0]
    # the whole ruler block sits in a clear band of the halftone field
    keep = ((rl - 18, capy - 10, rr + 18, ry + 44),)
    f = _bg("C", u, flip=True, keep=keep)
    cut = int(round(T["base"] - T["cap"] * 0.48))
    off = _pre_off(u)
    ac = _anchor_cap(T)
    cx, cy = PRE_CX, PRE_CY
    top_pm = pm[:cut]
    bot_pm = pm[cut:]
    # forward shutter: the fastest frame (the cut) carries the most smear
    bl = int(_vblur_amount(_pre_off, u, 0.8, 70))
    _put(f, top_pm, ac, cx - off, cy, blur=(bl, 0))
    _put(f, bot_pm, (ac[0], ac[1] - cut), cx + off, cy, blur=(bl, 0))
    ycut = cy - ac[1] + cut
    # cut line: dark hairline + green core while slicing, full frame width
    li = clamp(1 - u / 0.2) ** 1.5
    if li > 0.01:
        yc = int(round(ycut))
        band = f[yc - 4:yc + 5]
        prof = np.array([0.35, 0.7, 1, 1, 1, 1, 1, 0.7, 0.35], np.float32)[:, None, None]
        core = np.array([0, 0, 0, 1, 1, 1, 0, 0, 0], np.float32)[:, None, None]
        band += (INK - band) * prof * li * 0.9
        band += (GREEN - band) * core * li
    # ruler in the upper third: ticks point up, marker rides under the line
    _poly(f, [(rl, ry), (rr, ry), (rr, ry + 3), (rl, ry + 3)], INK)
    nt = 60
    for i in range(nt + 1):
        x = rl + (rr - rl) * i / nt
        L = 28 if i % 10 == 0 else (18 if i % 5 == 0 else 10)
        _poly(f, [(x - 1.2, ry - L), (x + 1.2, ry - L), (x + 1.2, ry + 3), (x - 1.2, ry + 3)], INK)
    me = ease_out_expo(clamp((u - 0.03) / 0.22))
    mx = lerp(rl + 120, cx, me) + 3 * math.sin(u * 40) * (1 - me)
    _poly(f, [(mx - 19, ry + 40), (mx + 19, ry + 40), (mx, ry + 7)], INK)
    _poly(f, [(mx - 13, ry + 36), (mx + 13, ry + 36), (mx, ry + 12)], GREEN)
    _comp(f, tl, rl, capy)
    _comp(f, v, rr - v.shape[1], capy)
    return f, dict(s=1.0, push=0.03, shake=14)


# ================================================================ card 6 — ammo 30 -> 0
SHOT_DT = 0.0095
SHOT_T0 = 0.004
N_CAS = 14                      # casings (spread over the 30-round burst; <= 12 on screen at once)
CAS_LEN = 130.0                 # on-screen casing length at scale 1
DIG_CELL = 376                  # fixed tabular digit cell (Anton '0' advance at 760 px)
DIG_GAP = 18
NUM_CX = 860                    # centre of the fixed 2-digit block
NUM_YCAP = 170


def _digit(d, green=False):
    """Distressed Anton digit (built lazily, cached by _type)."""
    if green:
        return _type(d, 760, 700 + int(d), "green", 0.6)
    return _type(d, 760, 600 + int(d), "bone", 0.9)


def _num_layout():
    """x of the two fixed digit cells (left edges) -> block never moves."""
    wtot = 2 * DIG_CELL + DIG_GAP
    x0 = NUM_CX - wtot / 2
    return (x0, x0 + DIG_CELL + DIG_GAP), x0 + wtot


def _draw_number(f, n, green=False, dx=0.0, dy=0.0, s=1.0):
    """Fixed 2-digit HUD readout '09': leading zero dimmed, digits centred in
    tabular cells; s scales the whole block about its centre."""
    txt = f"{n:02d}"
    cells, _ = _num_layout()
    cap = _digit("0")["cap"]
    cy = NUM_YCAP + cap / 2
    for i, ch in enumerate(txt):
        T = _digit(ch, green)
        adv = T["xs"][1] - T["xs"][0]
        lead = (i == 0 and n < 10 and not green)
        ccx = cells[i] + DIG_CELL / 2
        # layer point at the glyph's advance centre / cap centre
        anchor = (T["xs"][0] + adv / 2, T["base"] - T["cap"] / 2)
        px = NUM_CX + (ccx - NUM_CX) * s + dx
        _put(f, T["pm"], anchor, px, cy + dy, s, op=0.22 if lead else 1.0)


# ---------------------------------------------------------------- casing sprite
CAS_SPR_L = 168        # sprite length (px) the sprite is built at (1x), >= max on-screen length
CAS_SPR_R = 17.5       # body radius at that size


def _lut(v, stops):
    xs = [p for p, _ in stops]
    out = np.empty(v.shape + (3,), np.float32)
    for c in range(3):
        out[..., c] = np.interp(v, xs, [float(col[c]) for _, col in stops])
    return out


@lru_cache(maxsize=1)
def _casing_sprites():
    """Rifle casing, side view (axis along x, head left, open mouth right) plus
    two end-on caps (head with primer, open mouth). Built at 4x, cylindrical
    shading across the width, premultiplied RGBA at 1x."""
    ss = 4
    L, R = CAS_SPR_L, CAS_SPR_R
    pad = 3
    Wc, Hc = int((L + 2 * pad) * ss), int((2 * R + 2 * pad) * ss)
    xx = (np.arange(Wc, dtype=np.float32) + 0.5) / ss - pad          # 0..L along axis
    yy = (np.arange(Hc, dtype=np.float32) + 0.5) / ss - pad - R      # -R..R across
    q = xx / L
    # radius profile: rim, extractor groove, body (slight taper), shoulder, neck
    r = np.interp(q, [0.0, 0.004, 0.036, 0.046, 0.062, 0.078, 0.092, 0.70, 0.79, 0.81, 1.0],
                  [0.90, 0.985, 0.985, 0.80, 0.76, 0.80, 0.985, 0.94, 0.66, 0.64, 0.64]) * R
    inside = (np.abs(yy)[:, None] <= r[None, :]) & (xx[None, :] >= 0) & (xx[None, :] <= L)
    v = np.clip(yy[:, None] / np.maximum(r[None, :], 1e-3), -1, 1)
    base = _lut(v, [(-1.0, GREEN_DK * 0.70), (-0.80, GREEN * 0.80), (-0.56, GREEN), (-0.44, GREEN_HOT),
                    (-0.34, GREEN_HOT * 0.97 + GREEN * 0.03), (-0.22, GREEN), (0.15, GREEN * 0.86),
                    (0.55, GREEN_DK), (0.86, GREEN_DK * 0.72), (1.0, GREEN_DK * 0.48)])
    qq = np.broadcast_to(q[None, :], v.shape)
    k = np.ones(v.shape, np.float32)
    k *= np.where((qq > 0.036) & (qq < 0.092), 0.48, 1.0)                 # extractor groove
    k *= np.where(qq < 0.036, 0.80, 1.0)                                   # rim
    k *= np.where((qq > 0.70) & (qq < 0.81), 0.82, 1.0)                   # shoulder faces away
    k *= 1 - 0.22 * np.clip((qq - 0.80) / 0.2, 0, 1)                        # sooty neck
    k *= 1 - 0.10 * np.clip((0.3 - qq) / 0.3, 0, 1)
    col = base * k[..., None]
    # bright lip at the mouth + groove edge highlights
    lip = (qq > 0.985).astype(np.float32) * np.clip(1 - np.abs(v + 0.2), 0, 1)
    col += (GREEN_HOT * 0.9 - col) * lip[..., None] * 0.8
    a = inside.astype(np.float32)
    # dark silhouette edge so overlapping casings separate
    er = cv2.erode(a, np.ones((5, 5), np.uint8))
    edge = np.clip(a - er, 0, 1)
    col *= (1 - 0.75 * edge)[..., None]
    pm = np.dstack([col * a[..., None], a])
    side = cv2.resize(pm, (Wc // ss, Hc // ss), interpolation=cv2.INTER_AREA).astype(np.float32)

    def cap(rad, kind):
        n = int(math.ceil((rad + pad) * 2 * ss))
        g = (np.arange(n, dtype=np.float32) + 0.5) / ss - n / ss / 2
        X, Y = np.meshgrid(g, g)
        d = np.hypot(X, Y) / rad
        a_ = (d <= 1).astype(np.float32)
        lam = np.clip(0.55 - 0.45 * (X + Y * 1.3) / rad, 0, 1)            # lit from upper-left
        c_ = GREEN_DK[None, None] * (0.75 + 0.55 * lam[..., None])
        if kind == "head":
            ring = ((d > 0.80) & (d < 0.86)).astype(np.float32)
            c_ *= (1 - 0.5 * ring)[..., None]
            pr = np.hypot(X, Y) < rad * 0.30
            prr = (np.hypot(X, Y) >= rad * 0.30) & (np.hypot(X, Y) < rad * 0.37)
            c_ = np.where(pr[..., None], GREEN[None, None] * (0.8 + 0.3 * lam[..., None]), c_)
            c_ = np.where(prr[..., None], GREEN_DK[None, None] * 0.45, c_)
        else:   # open mouth: thin lit ring, dark bore
            hole = d < 0.74
            c_ = np.where((d >= 0.74)[..., None], GREEN[None, None] * (0.62 + 0.55 * lam[..., None]), c_)
            bore = INK + (GREEN_DK - INK) * 0.18 * np.clip(1 - d / 0.74, 0, 1)[..., None]
            c_ = np.where(hole[..., None], bore, c_)
        e_ = np.clip(a_ - cv2.erode(a_, np.ones((5, 5), np.uint8)), 0, 1)
        c_ = c_ * (1 - 0.7 * e_)[..., None]
        p_ = np.dstack([c_ * a_[..., None], a_]).astype(np.float32)
        return cv2.resize(p_, (n // ss, n // ss), interpolation=cv2.INTER_AREA).astype(np.float32)

    return side, cap(R * 0.985, "head"), cap(R * 0.64, "mouth"), pad


@lru_cache(maxsize=128)
def _trail_kernel(n, ang_q, core=0.6):
    """Motion-blur kernel of length n px along ang_q (deg): a crisp share at the
    current position plus a linearly fading shutter trail behind the motion
    (filter2D correlates, so the kernel extends toward +velocity)."""
    k = 2 * n + 3
    img = np.zeros((k, k), np.float32)
    c = (k - 1) / 2
    a = math.radians(ang_q)
    dx, dy = math.cos(a), math.sin(a)
    m = max(2, 3 * n)
    for i in range(m):
        t = i / (m - 1)
        wgt = (1 - t) * (1 - core) / m * 2
        x, y = c + dx * n * t, c + dy * n * t
        x0, y0 = int(math.floor(x)), int(math.floor(y))
        fx, fy = x - x0, y - y0
        img[y0, x0] += wgt * (1 - fx) * (1 - fy)
        img[y0, x0 + 1] += wgt * fx * (1 - fy)
        img[y0 + 1, x0] += wgt * (1 - fx) * fy
        img[y0 + 1, x0 + 1] += wgt * fx * fy
    img[int(c), int(c)] += core
    return img / img.sum()


def _aff(sx, sy, ang, ox, oy, px, py):
    """2x3 affine: sprite point (ox, oy) -> (px, py), scaled (sx along sprite x,
    sy along sprite y), then rotated by ang (rad)."""
    ca, sa = math.cos(ang), math.sin(ang)
    A = np.array([[ca * sx, -sa * sy], [sa * sx, ca * sy]], np.float64)
    t = np.array([px, py]) - A @ np.array([ox, oy])
    return np.hstack([A, t[:, None]])


def _casing(f, x, y, ang, phi, scl, vx, vy, op=1.0):
    """Spent casing tumbling in 3D: phi tilts the axis toward the camera
    (foreshortening + visible end cap), ang spins it in-plane, motion blur
    along the velocity."""
    side, head, mouth, pad = _casing_sprites()
    s = scl * CAS_LEN / CAS_SPR_L
    c, sn = math.cos(phi), math.sin(phi)
    lx = max(abs(c), 0.16)
    sh_, sw_ = side.shape[:2]
    sc_x, sc_y = pad + CAS_SPR_L / 2, sh_ / 2
    blur = min(math.hypot(vx, vy) * DT * 0.5, 24.0)     # capped: metal stays solid
    bp = int(math.ceil(blur)) + 4
    ext = (CAS_SPR_L / 2 * lx + CAS_SPR_R) * s + 4
    bx, by = int(math.floor(x - ext)) - bp, int(math.floor(y - ext)) - bp
    bw = int(math.ceil(2 * ext)) + 2 * bp + 2
    if bx > W or by > H or bx + bw < 0 or by + bw < 0:
        return
    M = _aff(lx * s, s, ang, sc_x, sc_y, x - bx, y - by)
    o = cv2.warpAffine(side, M, (bw, bw), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    if abs(sn) > 0.14:
        capl = mouth if sn > 0 else head
        end = 1.0 if sn > 0 else -1.0
        ex_ = x + math.cos(ang) * end * (CAS_SPR_L / 2 - 1) * lx * s
        ey_ = y + math.sin(ang) * end * (CAS_SPR_L / 2 - 1) * lx * s
        n = capl.shape[0]
        Mc = _aff(abs(sn) * s, s, ang, n / 2, n / 2, ex_ - bx, ey_ - by)
        oc = cv2.warpAffine(capl, Mc, (bw, bw), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        o *= 1 - oc[..., 3:4]
        o += oc
    if blur >= 2:
        kq = int(round(math.degrees(math.atan2(vy, vx)) / 6.0)) * 6
        o = cv2.filter2D(o, -1, _trail_kernel(int(round(blur)), kq), anchor=(-1, -1), borderType=cv2.BORDER_CONSTANT)
    _comp(f, o, bx, by, op)


@lru_cache(maxsize=1)
def _casing_params():
    rng = np.random.default_rng(683)
    P = []
    for j in range(N_CAS):
        shot = int(round(j * 29 / (N_CAS - 1)))
        P.append(dict(t0=SHOT_T0 + shot * SHOT_DT + 0.002, vx=rng.uniform(2200, 4200), vy=-rng.uniform(1300, 2600),
                      g=rng.uniform(5200, 7000), w=rng.uniform(9, 22) * rng.choice([-1, 1]), a0=rng.uniform(-0.9, 0.3),
                      sp=rng.uniform(10, 22) * rng.choice([-1, 1]), ph=rng.uniform(0, 6.28), sc=rng.uniform(0.8, 1.28)))
    # spread the launch directions evenly so they fan out (no clumping); fast
    # enough that every casing leaves the frame within ~0.25 s
    vys = np.linspace(-2600, -1300, N_CAS)
    vxs = np.linspace(2200, 4200, N_CAS)
    order = np.random.default_rng(764).permutation(N_CAS)      # seeds picked for the least overlap
    order2 = np.random.default_rng(700).permutation(N_CAS)
    for j, p in enumerate(P):
        p["vy"] = float(vys[order[j]] + rng.uniform(-60, 60))
        p["vx"] = float(vxs[order2[j]] + rng.uniform(-80, 80))
    return P


@lru_cache(maxsize=1)
def _radial(r=520):
    yy, xx = np.mgrid[-r:r, -r:r].astype(np.float32)
    d = np.sqrt(xx * xx + yy * yy) / r
    return np.clip(1 - d, 0, 1) ** 2.2


@lru_cache(maxsize=4)
def _star(R=150, rot=0):
    """Additive 4-point star flare (GREEN_HOT), premultiplied-style RGB*intensity."""
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1].astype(np.float32)
    if rot:
        a = math.radians(rot)
        xx, yy = xx * math.cos(a) + yy * math.sin(a), -xx * math.sin(a) + yy * math.cos(a)
    ax, ay = np.abs(xx), np.abs(yy)
    rays = np.exp(-ay / 1.6) * np.exp(-ax / (R * 0.30)) + np.exp(-ax / 1.6) * np.exp(-ay / (R * 0.20)) * 0.75
    core = np.exp(-(xx * xx + yy * yy) / (2 * 9.0 ** 2)) + 0.35 * np.exp(-(xx * xx + yy * yy) / (2 * 28.0 ** 2))
    i = np.clip(rays * 0.9 + core, 0, 1.4).astype(np.float32)
    return np.dstack([i[..., None] * GREEN_HOT, np.ones_like(i)]).astype(np.float32)


def _glow_at(f, x, y, k, col=GREEN):
    gl = _radial()
    r = gl.shape[0] // 2
    x, y = int(x), int(y)
    y0, y1, x0, x1 = max(y - r, 0), min(y + r, H), max(x - r, 0), min(x + r, W)
    if y1 <= y0 or x1 <= x0:
        return
    sub = f[y0:y1, x0:x1]
    g = gl[y0 - (y - r):y1 - (y - r), x0 - (x - r):x1 - (x - r)]
    sub += (np.asarray(col, np.float32) * 0.16)[None, None, :] * (g * k)[..., None]


def _round_icon(f, x, y, w, h, live):
    """Magazine round, upright: casing + ogive head."""
    if live:
        cb = y + h * 0.42
        _poly(f, [(x, cb), (x + w, cb), (x + w, y + h), (x, y + h)], GREEN_DK)
        _poly(f, [(x + w * 0.62, cb + 3), (x + w * 0.8, cb + 3), (x + w * 0.8, y + h - 3), (x + w * 0.62, y + h - 3)], GREEN * 0.85)
        # ogive: x-half-width shrinks with height following a circular arc
        pts = []
        top = y
        for i in range(13):
            q = i / 12
            yy = cb - (cb - top) * q
            half = (w / 2) * math.sqrt(max(0.0, 1 - q ** 2.2))
            pts.append((x + w / 2 - half, yy))
        right = [(x + w - (px - x), py) for px, py in reversed(pts)]
        _poly(f, pts + right, GREEN)
    else:
        c = BONE * 0.16 + INK * 0.84
        _poly(f, [(x, y + h * 0.42), (x + w, y + h * 0.42), (x + w, y + h), (x, y + h)], c)


def _c_ammo(u, fi):
    f = _bg("B", u)
    shots = int(clamp((u - SHOT_T0) / SHOT_DT + 1, 0, 30)) if u >= SHOT_T0 else 0
    n = 30 - shots
    last = SHOT_T0 + 29 * SHOT_DT
    firing = 0 < shots and u < last + 2 * DT
    rng = np.random.default_rng(fi * 7 + 3)
    rx, ry = (rng.normal(0, 2.5), rng.uniform(1, 4)) if (firing and n > 0) else (0, 0)
    cells, xr = _num_layout()
    cap = _digit("0")["cap"]
    ex, ey = xr + 96, NUM_YCAP + cap * 0.50          # ejection port, right of the readout
    # ejection light: radial glow + star flare on every shot, dying after the last
    if shots > 0:
        since = u - last
        if n > 0:
            k = 0.95 if fi % 2 == 0 else 0.6
            k *= rng.uniform(0.85, 1.1)
        else:
            k = 1.0 * clamp(1 - since / (2 * DT)) ** 1.5
        if k > 0.02:
            _glow_at(f, ex, ey, k * 1.6)
            st = _star(150, 0 if fi % 2 == 0 else 12)
            sz = st.shape[0]
            over(f, st, ex - sz // 2, ey - sz // 2, min(1.0, k), "add")
    green = n == 0
    t_zero = math.ceil((last - 1e-6) / DT) * DT     # first frame that shows 00
    sc = 1.0
    if green:
        pz = clamp((u - t_zero) / 0.07)
        sc = 1.0 + 0.06 * (1 - ease_out_cubic(pz))
    _draw_number(f, n, green, rx, ry, sc)
    lx = xr + 44
    lab = _small("MUNIÇÃO", 34, _col(BONE * 0.85), 8)
    _comp(f, lab, lx, NUM_YCAP + 6)
    sub_ = _small("/ 30", 64, _col(BONE * 0.5), 4, "anton")
    _comp(f, sub_, lx, NUM_YCAP + 62)
    if green:
        rl = _small("RECARREGAR", 34, _col(GREEN), 8)
        if (fi // 2) % 2 == 0:
            _comp(f, rl, lx, NUM_YCAP + cap - rl.shape[0] + 4)
    # magazine row
    rx0, rx1, rowy = 300, 1620, 885
    step = (rx1 - rx0) / 30
    for i in range(30):
        x = rx0 + i * step + (step - step * 0.5) / 2
        _round_icon(f, x, rowy, step * 0.5, 92, i < n)
    # ejected casings: shaded sprite, 3D tumble, velocity motion blur
    for p in _casing_params():
        tt = u - p["t0"]
        if tt <= 0:
            continue
        x = ex + 30 + p["vx"] * tt
        y = ey + p["vy"] * tt + 0.5 * p["g"] * tt * tt
        if x > W + 140 or y > H + 140:
            continue
        vy = p["vy"] + p["g"] * tt
        ang = p["a0"] + p["w"] * tt
        phi = p["ph"] + p["sp"] * tt
        op = clamp(1 - (tt - 0.22) / 0.08)       # late stragglers fade: no pile-up
        if op <= 0:
            continue
        _casing(f, x, y, ang, phi, p["sc"] * (0.72 + 0.28 * min(tt * 9, 1)), p["vx"], vy, op)
    _green_bloom(f, 0.36, wide=(0.55 * math.exp(-max(u - t_zero, 0) * 12) if green else 0.0))
    return f, dict(s=1.0, push=0.03, shake=10, cont=firing)


# ================================================================ card 7 — kill feed
@lru_cache(maxsize=4)
def _feed_strip(sc):
    """Kill-feed strip as premultiplied layer at scale sc. The INK slab is a
    worn print (grunge wear + a halftone dissolve on its right end); the logo,
    type, arrows and the X box sit on it fully opaque."""
    hgt = int(200 * sc)
    TA = _type("ARMY", int(150 * sc), 801, "white", 0.25, 0.0)
    TE = _type("ELIMINADO", int(150 * sc), 802, "bone", 0.35, 0.0)
    ic0 = load_layer("logo_icon")
    k_ = (hgt * 0.62) / ic0.shape[0]
    ic = cv2.resize(premul(ic0), (int(round(ic0.shape[1] * k_)), int(round(ic0.shape[0] * k_))), interpolation=cv2.INTER_AREA)
    gap = int(44 * sc)
    arw = int(34 * sc)
    xb = int(130 * sc)
    items_w = ic.shape[1] + gap + (TA["bbox"][2] - TA["bbox"][0]) + gap + arw + gap + xb + gap + arw + gap + (TE["bbox"][2] - TE["bbox"][0])
    pad = int(64 * sc)
    fade_w = int(150 * sc)          # extra slab length on the right that dissolves into dots
    sk = int(46 * sc)
    wid = items_w + 2 * pad + sk + fade_w
    al = np.zeros((hgt, wid), np.float32)
    _poly(al, [(sk, 0), (wid, 0), (wid - sk, hgt), (0, hgt)], 1.0)
    # green edge tab on the left (part of the slab paint)
    tab = np.zeros((hgt, wid), np.float32)
    _poly(tab, [(sk, 0), (sk + 14 * sc, 0), (14 * sc, hgt), (0, hgt)], 1.0)
    # opaque items layer (premultiplied rgb + alpha)
    it = np.zeros((hgt, wid, 3), np.float32)
    ia = np.zeros((hgt, wid), np.float32)
    x = pad + sk * 0.5
    cyl = hgt / 2

    def place(pm_, x_, y_):
        h_, w_ = pm_.shape[:2]
        x_, y_ = int(round(x_)), int(round(y_))
        X0, Y0 = max(x_, 0), max(y_, 0)
        X1, Y1 = min(x_ + w_, wid), min(y_ + h_, hgt)
        if X1 <= X0 or Y1 <= Y0:
            return
        p = pm_[Y0 - y_:Y1 - y_, X0 - x_:X1 - x_]
        s_ = it[Y0:Y1, X0:X1]
        s_ *= 1 - p[..., 3:4]
        s_ += p[..., :3]
        a_ = ia[Y0:Y1, X0:X1]
        a_ *= 1 - p[..., 3]
        a_ += p[..., 3]

    def solid(mask, col):
        it[:] = it * (1 - mask[..., None]) + np.asarray(col, np.float32) * mask[..., None]
        ia[:] = ia * (1 - mask) + mask

    place(ic, x, cyl - ic.shape[0] / 2)
    x += ic.shape[1] + gap
    place(TA["pm"], x - TA["bbox"][0], cyl - (TA["base"] - TA["cap"] / 2))
    x += TA["bbox"][2] - TA["bbox"][0] + gap
    for which in (0, 1):
        ah = arw * 1.1
        am = np.zeros((hgt, wid), np.float32)
        _poly(am, [(x, cyl - ah), (x + arw, cyl), (x, cyl + ah)], 1.0)
        solid(am, GREEN)
        x += arw + gap
        if which == 0:
            # X in a green-outlined box
            box_x = x
            bh = xb
            m = np.zeros((hgt, wid), np.float32)
            _line(m, (x + bh * 0.24, cyl - bh * 0.26), (x + bh * 0.76, cyl + bh * 0.26), 1.0, 15 * sc)
            _line(m, (x + bh * 0.24, cyl + bh * 0.26), (x + bh * 0.76, cyl - bh * 0.26), 1.0, 15 * sc)
            ob = np.zeros((hgt, wid), np.float32)
            _poly(ob, [(x, cyl - bh / 2), (x + bh, cyl - bh / 2), (x + bh, cyl + bh / 2), (x, cyl + bh / 2)], 1.0)
            ib = np.zeros((hgt, wid), np.float32)
            t5 = 6 * sc
            _poly(ib, [(x + t5, cyl - bh / 2 + t5), (x + bh - t5, cyl - bh / 2 + t5), (x + bh - t5, cyl + bh / 2 - t5), (x + t5, cyl + bh / 2 - t5)], 1.0)
            solid(np.clip(np.clip(ob - ib, 0, 1) + m, 0, 1), GREEN)
            x += bh + gap
    place(TE["pm"], x - TE["bbox"][0], cyl - (TE["base"] - TE["cap"] / 2))
    x_end = x + TE["bbox"][2] - TE["bbox"][0]
    # worn print slab: hard-edged paint chips, fine grit/scratches, a rough
    # print edge, and a halftone dissolve after the last word (no soft haze)
    cn = value_noise(wid, hgt, int(22 * sc + 6), 4, 803)
    yy_ = np.arange(hgt, dtype=np.float32)[:, None]
    ev = np.clip(1 - np.minimum(yy_, hgt - yy_) / (34 * sc), 0, 1)     # chips gather at the slab edges
    chips = np.clip((cn - 0.81 + 0.10 * ev) * 14, 0, 1)
    grit = _grit(545)[:hgt, W - wid:][:, ::-1] if wid <= W else 0.0
    wear = (1 - 0.92 * chips) * (1 - 0.85 * grit)
    nf = value_noise(wid, hgt, 3, 2, 804)
    al = np.clip((cv2.GaussianBlur(al, (0, 0), 1.2) - 0.5 + (nf - 0.5) * 0.45) * 5 + 0.5, 0, 1) * (al > 0.02)
    xs_ = np.arange(wid, dtype=np.float32)[None, :]
    amt = np.clip((xs_ - (x_end + 14 * sc)) / max(wid - sk * 0.4 - (x_end + 14 * sc), 1), 0, 1) ** 0.8
    amt = np.broadcast_to(amt, (hgt, wid)).copy()
    dots = _dot_holes(wid, hgt, max(5.0, 12 * sc), 45.0, amt)
    sa = al * wear * (1 - dots)
    scol = INK[None, None, :] + (GREEN - INK)[None, None, :] * tab[..., None]
    rgb = it + scol * (sa * (1 - ia))[..., None]
    A = ia + sa * (1 - ia)
    lay = np.dstack([rgb, A]).astype(np.float32)
    return lay, (box_x, xb)


FEED_SC = 0.92                # main strip scale (the slab carries a dissolve tail on the right)
FEED_STAMP = 0.10 - 1e-3      # (epsilon: u is a float difference of t and the beat)


def _c_feed(u, fi):
    f = _bg("G", u, flip=True)
    strip, (xbx, xbw) = _feed_strip(FEED_SC)
    sh, sw = strip.shape[:2]
    small, _ = _feed_strip(0.5)

    def slide(q, d=0.0, amp=400):
        return amp * (1 - ease_out_expo(clamp((q - d) / 0.11)))
    # echo rows (smaller) stacked above/below, staggered, with continuous
    # opposing parallax drift
    for (yy, d, xo, drift) in ((262, 0.06, 330, -42), (818, 0.10, -300, 34)):
        if u >= d:
            dx = slide(u, d, 900) + drift * u / BEAT
            bl = int(_vblur_amount(lambda q: slide(q, d, 900), u))
            _put(f, small, (small.shape[1] / 2, small.shape[0] / 2), 960 + xo + dx, yy, blur=(bl, 0))
    dx = slide(u)
    bl = int(_vblur_amount(slide, u))
    cx = 960 + dx - 14 * u / BEAT
    _put(f, strip, (sw / 2, sh / 2), cx, 540, blur=(bl, 0))
    # ✕ "confirmed" stamp: box flips to solid green with a scale pop + hot edge flash
    sp = clamp((u - FEED_STAMP) / 0.09)
    bx = cx - sw / 2 + xbx + xbw / 2
    if u >= FEED_STAMP:
        q = ease_out_cubic(sp)
        r = xbw / 2 * (1 + 0.32 * (1 - q))
        hot = clamp(1 - (u - FEED_STAMP) / (2 * DT))
        if hot > 0:
            rh = r + 10
            _poly(f, [(bx - rh, 540 - rh), (bx + rh, 540 - rh), (bx + rh, 540 + rh), (bx - rh, 540 + rh)],
                  GREEN + (GREEN_HOT - GREEN) * hot)
            _poly(f, [(bx - r, 540 - r), (bx + r, 540 - r), (bx + r, 540 + r), (bx - r, 540 + r)], INK)
            r -= 6
        _poly(f, [(bx - r, 540 - r), (bx + r, 540 - r), (bx + r, 540 + r), (bx - r, 540 + r)], GREEN)
        k_ = r * 0.5
        _line(f, (bx - k_, 540 - k_ * 1.04), (bx + k_, 540 + k_ * 1.04), INK, 16 * r / (xbw / 2))
        _line(f, (bx - k_, 540 + k_ * 1.04), (bx + k_, 540 - k_ * 1.04), INK, 16 * r / (xbw / 2))
    # caption slides up into place after the stamp
    cp = clamp((u - 0.12) / 0.08)
    if cp > 0:
        c = _small("ABATE CONFIRMADO", 28, _col(INK), 6)
        ce = ease_out_cubic(cp)
        _comp(f, c, 960 - c.shape[1] / 2 - 14 * u / BEAT, 540 + sh / 2 + 34 + 18 * (1 - ce), ce)
    return f, dict(s=1.0, push=0.03, shake=12, kicks=((FEED_STAMP, 8, 22.0),))


# ================================================================ card 8 — reticle lock
@lru_cache(maxsize=2)
def _reticle(S=980, color="ink"):
    m = _reticle_mask(S)
    c = INK if color == "ink" else (BONE if color == "bone" else GREEN)
    return np.dstack([m[..., None] * c, m]).astype(np.float32)


@lru_cache(maxsize=1)
def _reticle_mask(S=980):
    ss = 2
    N = S * ss
    img = np.zeros((N, N), np.float32)
    c = N / 2
    R = 0.33 * N
    rng = np.random.default_rng(871)

    def stroke(p0, p1, th):
        cv2.line(img, tuple(np.round(np.asarray(p0) * 16).astype(int)), tuple(np.round(np.asarray(p1) * 16).astype(int)),
                 1.0, max(1, int(th)), cv2.LINE_AA, 4)
    for (th, a0, span, jit, dr) in ((13.0, -0.5, 2 * math.pi + 0.5, 3.0, 0), (6.0, 2.2, 2 * math.pi * 0.5, 4.0, 9)):
        k = 300
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
    gap = 0.07 * N
    L = 0.49 * N
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        wob = rng.normal(0, 1.5 * ss)
        p0 = np.array([c + dx * gap, c + dy * gap])
        p1 = np.array([c + dx * L + dy * wob, c + dy * L + dx * wob])
        k = 40
        for i in range(k):
            s0, s1 = i / k, (i + 1) / k
            taper = min(1, (1 - s0) * 4 + 0.15, s0 * 10 + 0.4)
            stroke(p0 + (p1 - p0) * s0, p0 + (p1 - p0) * s1, 9.0 * ss * taper)
        for j in range(1, 5):
            q = gap + (R - gap) * j / 4.6
            tl = (14 if j % 2 == 0 else 8) * ss
            px, py = c + dx * q, c + dy * q
            stroke((px - dy * tl, py - dx * tl), (px + dy * tl, py + dx * tl), 6 * ss)
    m = cv2.resize(img, (S, S), interpolation=cv2.INTER_AREA)
    gr = grunge(S, S, 872)
    m = m * (1 - (1 - gr) * 0.6)
    return m.astype(np.float32)


RET_LAB = (1458, 830)
RET_DIST = (1458, 880)
RET_SQ = (1420, 838, 1444, 862)


def _c_reticle(u, fi):
    lab = _small("ALVO TRAVADO", 36, _col(INK), 8)
    dist = _small("DIST 1.240 M", 36, _col(INK), 6)
    wlab = max(lab.shape[1], dist.shape[1])
    # the HUD readout gets a clear patch in the halftone field (dots shrink away)
    keep = ((RET_SQ[0] - 12, RET_LAB[1] - 10, RET_LAB[0] + wlab + 14, RET_DIST[1] + dist.shape[0] + 10),)
    f = _bg("C", u, keep=keep)
    R = _reticle()
    S = R.shape[0]
    WHIP = 0.07                 # lock lands within ~2 frames of the click cue
    e = ease_out_expo(clamp(u / WHIP))
    s = lerp(1.55, 1.0, e) - 0.06 * ease_in_out(clamp((u - WHIP) / (BEAT - WHIP - DT)))
    ang = lerp(-34, 0, e)
    ox, oy = lerp(260, 0, e), lerp(-160, 0, e)
    bl = int(_vblur_amount(lambda q: 300 * (1 - ease_out_expo(clamp(q / WHIP))), u, 0.5, 40)) if u < WHIP else 0
    cx, cy = 960, 520
    # green hit splat at the centre once locked
    T_HIT = 0.05
    if u >= T_HIT:
        pe = ease_out_expo(clamp((u - T_HIT) / 0.05))
        _draw_splat(f, 190, 881, 20, 4, cx, cy, 0.45 + 0.55 * pe if pe < 0.999 else 1.0, (u - T_HIT) * 2.6)
    _put(f, R, (S / 2, S / 2), cx + ox, cy + oy, s, ang, blur=(bl, bl // 2))
    # lock ping: thin ink ring expanding off the scope ring
    q = (u - T_HIT) / 0.16
    if 0 <= q < 1:
        rr = 330 * s + 300 * ease_out_cubic(q)
        th = max(1, int(round(6 * (1 - q))))
        ov = f.copy()
        cv2.circle(ov, (int(cx * 16), int(cy * 16)), int(rr * 16), _col(INK), th, cv2.LINE_AA, 4)
        f += (ov - f) * (1 - q)
    # lock brackets snapping in
    if u >= 0.03:
        lb = ease_out_expo(clamp((u - 0.03) / 0.05))
        r = lerp(640, 382, lb)
        _brackets(f, cx - r, cy - r, cx + r, cy + r, 76, 10, INK)
    if u >= T_HIT + DT * 0.5:
        x0_, y0_, x1_, y1_ = RET_SQ
        _poly(f, [(x0_, y0_), (x1_, y0_), (x1_, y1_), (x0_, y1_)], GREEN if (fi // 2) % 2 == 0 else INK)
        _comp(f, lab, *RET_LAB)
        _comp(f, dist, *RET_DIST)
    return f, dict(s=1.0, push=0.02, shake=6, kicks=((T_HIT, 12, 10.0),))


# ================================================================ card 9 — typed line
TYPE_LINES = ("O SILÊNCIO", "TAMBÉM", "ELIMINA.")
TYPE_CPF = 3                 # characters per frame for the first two lines
TYPE_END = 5 * DT            # 'ELIMINA.' lands whole on this frame (~3.77 s)


def _c_typed(u, fi):
    f = _bg("B", u, pulse=0.4)
    # a huge dim reticle drifting in the negative space on the right
    Rb = _reticle(980, "bone")
    _put(f, Rb, (490, 490), 1530 - 30 * u / BEAT, 560, 1.32 - 0.05 * u / BEAT, 8 + 6 * u / BEAT, op=0.10)
    px = 222
    Ts = [_type(TYPE_LINES[0], px, 911, "bone", guard=4), _type(TYPE_LINES[1], px, 902, "bone", guard=4),
          _type(TYPE_LINES[2], px, 903, "green", 0.7, guard=4)]
    cap = Ts[0]["cap"]
    left = 262
    pitch = cap + 72
    top0 = int((H - (cap + 2 * pitch)) / 2 + 22)
    tops = [top0, top0 + pitch, top0 + 2 * pitch]
    fl = int(u / DT + 1e-3)
    nshow = TYPE_CPF * (fl + 1)
    landed = u >= TYPE_END - 1e-4
    shown = 0
    cur = None
    for li in (0, 1):
        T, txt = Ts[li], TYPE_LINES[li]
        upto = 0
        for i, ch in enumerate(txt):
            if ch != " ":
                if shown >= nshow:
                    break
                shown += 1
            upto = i + 1
        if upto == 0:
            break
        a1 = int(round(T["xs"][upto])) if upto < len(txt) else T["w"]
        _comp(f, T["pm"][:, :a1], left - T["bbox"][0], tops[li] - (T["base"] - cap))
        cur = (left - T["bbox"][0] + T["xs"][upto] + 14, tops[li])
        if upto < len(txt):
            break
    T3 = Ts[2]
    if landed:
        # ELIMINA. lands as one green word with a small punch (about its left edge)
        q = clamp((u - TYPE_END) / (3 * DT))
        s3 = 1.0 + 0.05 * (1 - ease_out_cubic(q))
        _put(f, T3["pm"], (T3["bbox"][0], T3["base"] - cap / 2), left, tops[2] + cap / 2, s3)
        cur = (left + (T3["xs"][-1] - T3["bbox"][0]) * s3 + 14, tops[2])
    # green block cursor: solid (no blink) so every frame, incl. the last, reads clean
    if cur is not None:
        x, y = cur
        _poly(f, [(x, y), (x + cap * 0.42, y), (x + cap * 0.42, y + cap), (x, y + cap)], GREEN)
    # vertical green rule growing with the typed lines
    yb = cur[1] + cap if cur is not None else tops[0] + cap
    _poly(f, [(left - 58, tops[0]), (left - 50, tops[0]), (left - 50, yb), (left - 58, yb)], GREEN)
    _green_bloom(f, 0.38, wide=(0.45 * math.exp(-(u - TYPE_END) * 14) if landed else 0.0))
    light_streak(f, 1012, 0.5, GREEN, thickness=2, length=0.8)
    return f, dict(s=1.0, push=0.035, shake=0, kicks=((TYPE_END, 6, 12.0),))


def _glitch_g(f, amount, seed):
    """Palette-safe glitch: horizontal slice displacement, a few slices
    crushed to green mono / ink, and a green ghost offset. No RGB split."""
    rng = np.random.default_rng(seed)
    o = f.copy()
    lum = None
    for _ in range(int(6 + amount * 16)):
        y = int(rng.integers(0, H - 12))
        h = int(rng.integers(4, int(12 + 60 * amount)))
        sft = int(rng.normal(0, 120 * amount))
        o[y:y + h] = np.roll(f[y:y + h], sft, axis=1)
        r = rng.random()
        if r < 0.22:
            band = o[y:y + h]
            l_ = band @ np.array([0.299, 0.587, 0.114], np.float32)
            o[y:y + h] = INK + (GREEN - INK) * np.clip(l_ / 200.0, 0, 1)[..., None]
        elif r < 0.30:
            o[y:y + h] *= 0.25
    gh = np.roll(o, int(18 * amount + 6), axis=1)
    gl = gh @ np.array([0.299, 0.587, 0.114], np.float32)
    o += (GREEN * 0.35)[None, None, :] * np.clip((gl - 120) / 135, 0, 1)[..., None] * amount
    return o


CARDS = [_c_pvp, _c_regras, _c_skill, _c_paciencia, _c_posicao, _c_precisao, _c_ammo, _c_feed, _c_reticle, _c_typed]


# ================================================================ render
def render(t, ctx):
    fi = int(ctx.get("frame", int(round(t * FPS))))
    k = min(int(math.floor(t / BEAT + 1e-4)), 9)
    u = max(t - k * BEAT, 0.0)
    kind = KINDS[k]
    f, cam = CARDS[k](u, fi)
    # camera: overscan, slow push, impact punch + decaying shake
    s = 1.03 + cam.get("push", 0.0) * (u / BEAT) + cam.get("punch", 0.0) * math.exp(-u * 16)
    amp = cam.get("shake", 0)
    dx, dy, ang = shake(u, amp, 26.0, seed=k * 3 + 1, decay_from=0.0, decay=9.0)
    for j, kick in enumerate(cam.get("kicks", ())):
        t0_, a_ = kick[0], kick[1]
        dec = kick[2] if len(kick) > 2 else 9.0
        kx, ky, ka = shake(u, a_, 26.0, seed=k * 3 + 7 + j * 5, decay_from=t0_, decay=dec)
        dx, dy, ang = dx + kx, dy + ky, ang + ka
    if cam.get("cont"):
        dx2, dy2, _ = shake(u, 5.0, 61.0, seed=k * 5 + 2)
        dx, dy = dx + dx2, dy + dy2
    border = _plate(kind)[540, 960]
    f = warp_frame(f, s * cam.get("s", 1.0), ang * 0.6, dx, dy, border=border)
    # chromatic split on the first frames after each cut
    _hud(f, k, kind, u)
    # hand-off: scene 4 ends on a green-white over-exposure
    if k == 0 and u < 0.08:
        f = flash(f, 0.92 * (1 - u / 0.08) ** 2, FLASH_C)
    # glitch frames on two cuts
    if k in (6, 9) and u < 0.5 * DT:
        f = _glitch_g(f, 0.5, fi)
    return np.clip(f, 0, 255)
