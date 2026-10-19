"""Scene 5 · s5_montage (4.0 s) — rapid-cut kinetic word montage on a 0.4 s grid.

Ten full-frame graphic cards, hard cuts on the beat, backgrounds alternating
black+halftone (B) / full-bleed green (G) / bone-grey concrete (C):

  k  t     bg  card                     micro-motion
  0  0.0   B   PVP                      scale punch 1.24->1, push; flash hand-off from s4
  1  0.4   G   SEM / REGRAS             lines slam in from opposite sides (motion blur),
                                        hazard-stripe block wipes + scrolls
  2  0.8   C   SÓ SKILL                 type drops + hard stop, green spray splat pops,
                                        drips run, flecks
  3  1.2   B   PACIÊNCIA.               letters slowly track apart, green timer line fills
  4  1.6   G   POSIÇÃO.                 stepped grid-snap into position, brackets close,
                                        registration marks + coordinates
  5  2.0   C   PRECISÃO.                word sliced, halves slide into register, ruler
                                        marker settles on 0
  6  2.4   B   ammo 30 -> 0             full-auto count down, green casings eject
                                        (shell), magazine row empties, 0 turns green
  7  2.8   G   kill-feed strip          ARMY ▸ ✕ ▸ ELIMINADO strip slams in, ✕ stamps,
                                        echo rows stack
  8  3.2   C   reticle lock             hand-drawn reticle whips in and locks (click),
                                        lock brackets, green hit splat
  9  3.6   B   O SILÊNCIO / TAMBÉM /    typed letter by letter, green block cursor;
               ELIMINA.                 hard cut to black at 4.0 (scene 6 opens black)

Every cut is an impact (0.0 ... 3.2) with a decaying screen-space shake; HUD
corner brackets + card index stay locked to the screen while content shakes.
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


def _vblur_amount(fn, u, scale=1.0):
    """Shutter-length (half frame) displacement of a motion function fn(u)."""
    return abs(fn(u) - fn(u - DT * 0.5)) * scale


# ================================================================ distressed type
@lru_cache(maxsize=64)
def _mask(text, path, px, ss=3, pad=18):
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


def _wear(m, seed, sc, amt=1.0, feet=1.0, base=None, cap=None):
    """Poster-print distress of a type alpha mask (1x)."""
    h, w = m.shape
    rng = np.random.default_rng(seed)
    nf = value_noise(w, h, max(1.6, 2.0 * sc), 2, seed + 1)
    nm = value_noise(w, h, 7 * sc, 3, seed + 3)
    nc = value_noise(w, h, 17 * sc, 3, seed + 2)
    mb = cv2.GaussianBlur(m, (0, 0), 0.75 + 0.35 * sc)
    chip = np.clip((nc - 0.70) * 4, 0, 1)
    rough = np.clip((mb - 0.5 + (nf - 0.5) * 0.55 * amt + (nm - 0.5) * 0.30 * amt - chip * 0.5 * amt) * 6.5 + 0.5, 0, 1)
    # grit density: clumps + edges
    inner = cv2.GaussianBlur(m, (0, 0), 6 * sc)
    edge = np.clip((0.93 - inner) * 2.4, 0, 1) * m
    clump = value_noise(w, h, 40 * sc, 4, seed + 6)
    dens = np.clip((clump - 0.35) * 1.8, 0, 1) * 0.75 + edge * 0.7
    sm = (rng.random((h, w)) < 0.05).astype(np.float32)
    sm = cv2.GaussianBlur(sm, (0, 0), 0.55) * 2.2
    bgk = (rng.random((h // 3 + 1, w // 3 + 1)) < 0.05).astype(np.float32)
    bgk = cv2.resize(bgk, (w, h), interpolation=cv2.INTER_LINEAR)
    bgk = np.clip((cv2.GaussianBlur(bgk, (0, 0), 0.8) - 0.1) * 6, 0, 1)
    speck = np.clip((sm + bgk) * np.clip(dens * 1.3, 0, 1), 0, 1)
    # faint mesh + halftone fade at the feet
    cell = 5.5 + 1.2 * sc
    mesh = _dot_holes(w, h, cell, 45.0, np.clip((value_noise(w, h, 100 * sc, 3, seed + 7) - 0.45) * 1.4, 0, 0.40))
    dots = np.zeros((h, w), np.float32)
    if feet > 0 and base is not None:
        ty = base - cap
        yy = (np.arange(h, dtype=np.float32)[:, None] - ty) / max(cap, 1)
        bot = np.clip((yy - 0.68) / 0.32, 0, 1) * np.clip(value_noise(w, h, 70 * sc, 3, seed + 9) * 1.8 - 0.45, 0, 1) * feet
        r0 = int(max(ty + 0.66 * cap, 0))
        if r0 < h:
            dots[r0:] = _dot_holes(w, h, cell * 1.25, 45.0, np.clip(bot[r0:], 0, 1), r0)
    wear = value_noise(w, h, 60 * sc, 5, seed + 4)
    holes = np.clip((wear + (nm - 0.5) * 0.12 - 0.79) * 14, 0, 1)
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
    tex = (1 - 0.95 * holes) * (1 - 0.9 * dots) * (1 - 0.55 * mesh) * (1 - 0.92 * speck) * (1 - 0.8 * scr)
    return (rough * np.clip(1 - (1 - tex) * amt, 0, 1)).astype(np.float32)


@lru_cache(maxsize=64)
def _type(text, px, seed, color, amt=1.0, feet=1.0, path=ANTON):
    """Distressed type -> dict(pm, base, cap, xs, bbox). color: 'bone'|'ink'|'green'|'white'."""
    m, base, cap, xs = _mask(text, path, px)
    sc = px / 380.0
    a = _wear(m, seed, sc, amt, feet, base, cap) if amt > 0 else m.copy()
    h, w = a.shape
    if color == "bone":
        tone = value_noise(w, h, 70 * sc, 4, seed + 8)
        col = BONE[None, None, :] * (0.84 + 0.18 * tone[..., None])
    elif color == "green":
        tone = value_noise(w, h, 70 * sc, 4, seed + 8)
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


@lru_cache(maxsize=64)
def _small(text, size, color, tracking=2, fname="oswald"):
    lay = text_layer(text, fname, size, fill=np.asarray(color, np.float32), tracking=tracking, pad=4)
    return _pm(lay)


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


def _corners(f, color, k=1.0, op=1.0, flip=False):
    d, g, cell = _corner_maps()
    ch, cw = d.shape
    m = np.clip((np.minimum(g * (0.62 * k), 0.52) - d) * cell * 0.9 + 0.5, 0, 1) * (g > 0.01)
    m *= op
    if flip:
        m = m[:, ::-1]
        tl = f[:ch, W - cw:]
        br = f[H - ch:, :cw]
    else:
        tl = f[:ch, :cw]
        br = f[H - ch:, W - cw:]
    color = np.asarray(color, np.float32)
    tl += (color - tl) * m[..., None]
    br += (color - br) * (m[::-1, ::-1] * 0.85)[..., None]


@lru_cache(maxsize=4)
def _plate(kind):
    """Static background plates (layout space)."""
    if kind == "B":
        n = value_noise(W, H, 260, 6, 531)
        fn = value_noise(W, H, 4, 2, 532)
        b = np.empty((H, W, 3), np.float32)
        b[:] = INK
        b += ((n - 0.5) * 12 + (fn - 0.5) * 6)[..., None]
        gr = grunge(W, H, 533)
        b += ((1 - gr) * 7)[..., None]
        return b
    if kind == "G":
        n = value_noise(W, H, 300, 6, 541)
        fn = value_noise(W, H, 5, 2, 542)
        bl = value_noise(W, H, 60, 4, 543)
        gr = grunge(W, H, 544)
        b = np.empty((H, W, 3), np.float32)
        b[:] = GREEN
        shade = 0.90 + 0.14 * (n - 0.5) * 2 * 0.5 + (fn - 0.5) * 0.06
        b *= shade[..., None]
        # worn / dirty patches go toward casing green, pinholes + scratches to dark
        dirt = np.clip((bl - 0.62) * 3.0, 0, 1) * 0.55
        b += (GREEN_DK - b) * dirt[..., None]
        b += (INK - b) * ((1 - gr) * 0.5)[..., None]
        return b
    if kind == "C":
        n = value_noise(W, H, 320, 6, 551)
        mid = value_noise(W, H, 40, 4, 552)
        fn = value_noise(W, H, 3, 2, 553)
        gr = grunge(W, H, 554)
        b = np.empty((H, W, 3), np.float32)
        b[:] = CONC
        b *= (0.86 + 0.2 * n + 0.07 * (mid - 0.5) + 0.06 * (fn - 0.5))[..., None]
        stain = np.clip((value_noise(W, H, 150, 4, 555) - 0.6) * 2.5, 0, 1)
        b += (np.float32([118, 116, 110]) - b) * (stain * 0.45)[..., None]
        b += (INK - b) * ((1 - gr) * 0.55)[..., None]
        cr = crack_mask(W, H, W * 0.18, H * 0.82, seed=556, branches=7, progress=0.75, thickness=2)
        cr = np.maximum(cr, crack_mask(W, H, W * 0.86, H * 0.12, seed=557, branches=6, progress=0.6, thickness=1))
        b += (np.float32([60, 60, 58]) - b) * (cr * 0.6)[..., None]
        return b
    raise ValueError(kind)


def _bg(kind, u, flip=False, pulse=1.0):
    f = _plate(kind).copy()
    k = 1.0 + 0.55 * math.exp(-u * 12) * pulse
    if kind == "B":
        _corners(f, BONE, k, 0.5, flip)
    elif kind == "G":
        _corners(f, INK, k * 1.05, 0.9, flip)
    else:
        _corners(f, INK, k, 0.72, flip)
    return f


def _ink_for(kind):
    return BONE * 0.86 if kind == "B" else INK


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


def _green_bloom(f, gain=0.42, thr=45):
    q = cv2.resize(f, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    key = np.clip((q[..., 1] - 0.5 * (q[..., 0] + q[..., 2]) - thr) / 70, 0, 1)
    gsum = cv2.GaussianBlur(key, (0, 0), 5) * 0.5 + cv2.GaussianBlur(key, (0, 0), 18) * 0.5
    f += cv2.resize(gsum, (W, H), interpolation=cv2.INTER_LINEAR)[..., None] * (GREEN * gain)


# ================================================================ HUD (screen space)
def _hud(f, k, kind, u):
    c = BONE * 0.78 if kind == "B" else INK
    m, arm, th = 46, 44, 4
    _brackets(f, m, m, W - m, H - m, arm, th, c)
    idx = _small(f"{k + 1:02d}", 30, _col(c), 3)
    _comp(f, idx, m + 16, m + 12)
    lab = _small("ARMY // PVP", 22, _col(c), 5)
    _comp(f, lab, W - m - 16 - lab.shape[1], m + 14)
    # beat ticks: 10 small bars, current one green/ink-solid
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
def _c_pvp(u, fi):
    f = _bg("B", u)
    T = _type("PVP", 900, 11, "bone")
    e = ease_out_expo(clamp(u / 0.2))
    s = 1.0 + 0.24 * (1 - e) + 0.035 * u / BEAT
    _put(f, T["pm"], _anchor_cap(T), 960, 548, s)
    # green floor line
    light_streak(f, 1012, 0.55 + 0.6 * math.exp(-u * 10), GREEN, thickness=2, length=0.8)
    # small caption block
    cap = _small("SERVIDOR\nCOMPETITIVO", 30, _col(BONE * 0.85), 3)
    _comp(f, cap, 118, 860)
    _poly(f, [(118, 846), (166, 846), (166, 851), (118, 851)], GREEN)
    _green_bloom(f, 0.35)
    return f, dict(s=1.0, push=0.0, shake=16)


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
    return np.clip(m * (1 - (1 - g) * 0.9), 0, 1).astype(np.float32)


def _c_regras(u, fi):
    f = _bg("G", u, flip=True)
    T1 = _type("SEM", 520, 21, "ink")
    T2 = _type("REGRAS", 520, 22, "ink")
    cap = T2["cap"]
    x0b, _, x1b, _ = T2["bbox"]
    wR = x1b - x0b
    left = (W - wR) / 2
    top1 = 84
    top2 = top1 + cap + 40

    def slide(uu, sgn, delay=0.0):
        return sgn * 1100 * (1 - ease_out_expo(clamp((uu - delay) / 0.17)))

    d1 = slide(u, -1) + 9 * u / BEAT
    d2 = slide(u, 1, 0.0) - 9 * u / BEAT
    b1 = int(_vblur_amount(lambda q: slide(q, -1), u))
    b2 = int(_vblur_amount(lambda q: slide(q, 1, 0.0), u))
    # hazard stripe block right of SEM
    s0x = T1["bbox"][2] - T1["bbox"][0]
    bx0 = left + s0x + 46
    bx1 = left + wR
    rv = ease_out_expo(clamp((u - 0.05) / 0.16))
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
    c = _small("ZERO DESCULPAS.", 26, _col(INK), 4)
    _comp(f, c, bx1 - c.shape[1] + d1 * 0.4, top1 + cap + 6)
    return f, dict(s=1.0, push=0.025, shake=12)


# ================================================================ card 2 — SÓ SKILL
@lru_cache(maxsize=1)
def _splat_big():
    m = splatter(1250, 820, seed=572, density=1.4, drips=False)
    return m


def _c_skill(u, fi):
    f = _bg("C", u)
    T = _type("SÓ SKILL", 560, 31, "ink")
    # green spray splat behind the type
    sp = _splat_big()
    pe = ease_out_expo(clamp(u / 0.07))
    ss = 0.55 + 0.45 * pe
    a = sp
    pmk = np.dstack([a[..., None] * GREEN, a]).astype(np.float32)
    _put(f, pmk, (625, 410), 1180, 560, ss)
    # drips running from the splat
    if u > 0.03:
        dm = drip_mask(560, 380, (u - 0.03) * 1.8, seed=573, n=9, speed=1.0, max_len=0.95, width=(4, 10))
        sub = f[700:1080, 900:1460]
        sub += (GREEN - sub) * dm[:sub.shape[0], :sub.shape[1], None]
    def drop(q):
        return -230 * (1 - ease_out_expo(clamp(q / 0.12)))
    dy = drop(u)
    bl = int(_vblur_amount(drop, u))
    _put(f, T["pm"], _anchor_cap(T), 960, 600 + dy, 1.0, blur=(0, bl))
    return f, dict(s=1.0, push=0.03, shake=18)


# ================================================================ card 3 — PACIÊNCIA.
def _c_paciencia(u, fi):
    f = _bg("B", u, flip=True)
    T = _type("PACIÊNCIA.", 400, 41, "bone")
    xs = T["xs"]
    n = len(xs) - 1
    pm = T["pm"]
    tr = 3 + 15 * ease_in_out(clamp(u / BEAT))
    x0, _, x1, _ = T["bbox"]
    wtot = (x1 - x0) + tr * (n - 1)
    left = (W - wtot) / 2
    top = 380
    for i in range(n):
        a0 = 0 if i == 0 else int(round(xs[i]))
        a1 = T["w"] if i == n - 1 else int(round(xs[i + 1]))
        strip = pm[:, a0:a1]
        _comp(f, strip, left - x0 + a0 + tr * i, top - (T["base"] - T["cap"]))
    # timer line (patience) under the word
    yb = top + T["cap"] + 44
    lx0, lx1 = left, left + wtot
    _poly(f, [(lx0, yb), (lx1, yb), (lx1, yb + 3), (lx0, yb + 3)], BONE * 0.22 + INK * 0.78)
    p = clamp(u / (BEAT - DT))
    hx = lx0 + (lx1 - lx0) * p
    _poly(f, [(lx0, yb - 1), (hx, yb - 1), (hx, yb + 4), (lx0, yb + 4)], GREEN)
    _poly(f, [(hx - 2, yb - 9), (hx + 2, yb - 9), (hx + 2, yb + 12), (hx - 2, yb + 12)], GREEN_HOT)
    lab = _small("AGUARDE O MOMENTO", 26, _col(BONE * 0.8), 5)
    _comp(f, lab, lx0, yb + 24)
    sec = _small(f"{u * 1000:03.0f} MS", 26, _col(GREEN), 4)
    _comp(f, sec, lx1 - sec.shape[1], yb + 24)
    _green_bloom(f, 0.4)
    return f, dict(s=1.06, push=0.0, shake=8, punch=0.05)


# ================================================================ card 4 — POSIÇÃO.
def _c_posicao(u, fi):
    f = _bg("G", u)
    T = _type("POSIÇÃO.", 500, 51, "ink")
    steps = [(-118, 64, 1.07, 78), (52, -30, 0.975, 44), (0, 0, 1.0, 22)]
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
    # registration marks at mid-height outside the brackets
    for xm in (bx0 - 48, bx1 + 48):
        ym = cy + oy
        cv2.circle(f, (int(xm * 16), int(ym * 16)), 18 * 16, _col(INK), 3, cv2.LINE_AA, 4)
        _line(f, (xm - 30, ym), (xm + 30, ym), INK, 3)
        _line(f, (xm, ym - 30), (xm, ym + 30), INK, 3)
    coords = ["X +0118  Y -0064", "X -0052  Y +0030", "X 0000  Y 0000"][st]
    c = _small(coords, 28, _col(INK), 4)
    _comp(f, c, bx1 - c.shape[1], by1 + 16)
    lk = _small("TRAVADO" if st == 2 else "AJUSTANDO", 28, _col(INK), 6)
    _comp(f, lk, bx0, by1 + 16)
    return f, dict(s=1.0, push=0.02, shake=10)


# ================================================================ card 5 — PRECISÃO.
def _c_precisao(u, fi):
    f = _bg("C", u, flip=True)
    T = _type("PRECISÃO.", 465, 61, "ink")
    pm = T["pm"]
    cut = int(round(T["base"] - T["cap"] * 0.48))
    e = ease_out_expo(clamp(u / 0.15))
    off = 150 * (1 - e)
    ac = _anchor_cap(T)
    cx, cy = 960, 520
    top_pm = pm[:cut]
    bot_pm = pm[cut:]
    bl = int(150 * (1 - ease_out_expo(clamp((u - DT * 0.5) / 0.15))) - off) if u > 0 else 0
    _put(f, top_pm, ac, cx - off, cy, blur=(abs(bl), 0))
    _put(f, bot_pm, (ac[0], ac[1] - cut), cx + off, cy, blur=(abs(bl), 0))
    ycut = cy - ac[1] + cut
    # cut line: dark hairline + green core while slicing
    li = clamp(1 - u / 0.22)
    if li > 0:
        _poly(f, [(0, ycut - 3), (W, ycut - 3), (W, ycut + 3), (0, ycut + 3)], INK * li + f[int(ycut), 40] * (1 - li))
        _poly(f, [(0, ycut - 1), (W, ycut - 1), (W, ycut + 1), (0, ycut + 1)], GREEN * li + f[int(ycut), 40] * (1 - li))
    # ruler under the word
    x0, _, x1, _ = T["bbox"]
    rl, rr = cx - (ac[0] - x0), cx + (x1 - ac[0])
    ry = cy + T["cap"] / 2 + 60
    _poly(f, [(rl, ry), (rr, ry), (rr, ry + 3), (rl, ry + 3)], INK)
    nt = 60
    for i in range(nt + 1):
        x = rl + (rr - rl) * i / nt
        L = 28 if i % 10 == 0 else (18 if i % 5 == 0 else 10)
        _poly(f, [(x - 1.2, ry), (x + 1.2, ry), (x + 1.2, ry + L), (x - 1.2, ry + L)], INK)
    me = ease_out_expo(clamp((u - 0.03) / 0.22))
    mx = lerp(rl + 120, cx, me) + 3 * math.sin(u * 40) * (1 - me)
    _poly(f, [(mx - 16, ry - 30), (mx + 16, ry - 30), (mx, ry - 4)], GREEN)
    _poly(f, [(mx - 16, ry - 30), (mx + 16, ry - 30), (mx, ry - 4)], GREEN)
    v = _small(f"{(1 - me) * 4.20:0.2f} MM".replace(".", ","), 28, _col(INK), 4)
    _comp(f, v, rr - v.shape[1], ry + 40)
    tl = _small("TOLERÂNCIA", 28, _col(INK), 6)
    _comp(f, tl, rl, ry + 40)
    return f, dict(s=1.0, push=0.03, shake=14)


# ================================================================ card 6 — ammo 30 -> 0
SHOT_DT = 0.0095


@lru_cache(maxsize=1)
def _digits():
    out = {}
    for d in "0123456789":
        out[d] = _type(d, 760, 600 + int(d), "bone", 0.9)
    out["g0"] = _type("0", 760, 700, "green", 0.6)
    return out


def _draw_number(f, txt, xr, ycap, green=False, dx=0, dy=0):
    D = _digits()
    x = xr
    for ch in reversed(txt):
        T = D["g0"] if (green and ch == "0") else D[ch]
        adv = T["xs"][1] - T["xs"][0]
        x -= adv
        _comp(f, T["pm"], x - T["xs"][0] + dx, ycap - (T["base"] - T["cap"]) + dy)
        x -= 18


def _casing(f, x, y, ang, L, col_body, col_hi, col_rim, a=1.0, bg=INK):
    """Spent casing as a tumbling 2D sprite (L = projected length)."""
    ca, sa = math.cos(ang), math.sin(ang)
    hw = 8.5
    pts = [(-L / 2, -hw), (L * 0.28, -hw), (L / 2, -hw * 0.72), (L / 2, hw * 0.72), (L * 0.28, hw), (-L / 2, hw)]
    rim = [(-L / 2 - 3, -hw - 1.5), (-L / 2 + 4, -hw - 1.5), (-L / 2 + 4, hw + 1.5), (-L / 2 - 3, hw + 1.5)]
    hi = [(-L / 2 + 6, -hw * 0.55), (L * 0.3, -hw * 0.55), (L * 0.3, -hw * 0.15), (-L / 2 + 6, -hw * 0.15)]

    def tr(P):
        return [(x + px * ca - py * sa, y + px * sa + py * ca) for px, py in P]
    mix = lambda c: np.asarray(bg, np.float32) + (np.asarray(c, np.float32) - bg) * a
    _poly(f, tr(pts), mix(col_body))
    _poly(f, tr(rim), mix(col_rim))
    if L > 20:
        _poly(f, tr(hi), mix(col_hi))


@lru_cache(maxsize=1)
def _casing_params():
    rng = np.random.default_rng(681)
    P = []
    for i in range(30):
        t0 = 0.004 + i * SHOT_DT
        P.append(dict(t0=t0, vx=rng.uniform(700, 1500), vy=-rng.uniform(650, 1250), g=rng.uniform(3200, 4200),
                      w=rng.uniform(18, 42) * rng.choice([-1, 1]), a0=rng.uniform(0, 6.28), sp=rng.uniform(14, 30),
                      ph=rng.uniform(0, 6.28), L=rng.uniform(48, 58)))
    return P


def _c_ammo(u, fi):
    f = _bg("B", u)
    shots = int(clamp((u - 0.004) / SHOT_DT + 1, 0, 30)) if u >= 0.004 else 0
    n = 30 - shots
    firing = 0 < shots < 30 or (shots == 30 and u < 0.004 + 30 * SHOT_DT + DT)
    rng = np.random.default_rng(fi * 7 + 3)
    rx, ry = (rng.normal(0, 4), rng.uniform(2, 9)) if firing else (0, 0)
    # muzzle-flash light
    if firing and (fi % 2 == 0):
        f += (GREEN * 0.10 + 6)[None, None, :] * 0.6
    xr, ycap = 1035, 175
    _draw_number(f, str(n), xr, ycap, green=(n == 0), dx=rx, dy=ry)
    cap = _digits()["0"]["cap"]
    lab = _small("MUNIÇÃO", 34, _col(BONE * 0.85), 8)
    _comp(f, lab, 1090, ycap + 10)
    sub = _small("/ 30", 64, _col(BONE * 0.55), 4, "anton")
    _comp(f, sub, 1090, ycap + 70)
    if n == 0:
        rl = _small("RECARREGAR", 34, _col(GREEN), 8)
        if (fi // 2) % 2 == 0:
            _comp(f, rl, 1090, ycap + cap - rl.shape[0] + 6)
    # magazine row
    rx0, rx1, rowy = 260, 1660, 930
    step = (rx1 - rx0) / 30
    for i in range(30):
        x = rx0 + i * step
        live = i < n
        bw = step * 0.62
        if live:
            _poly(f, [(x, rowy - 22), (x + bw, rowy - 22), (x + bw, rowy + 22), (x, rowy + 22)], GREEN_DK)
            _poly(f, [(x, rowy - 42), (x + bw, rowy - 42), (x + bw, rowy - 24), (x + bw * 0.5, rowy - 58), (x, rowy - 24)], GREEN)
        else:
            c = BONE * 0.18 + INK * 0.82
            _poly(f, [(x, rowy - 22), (x + bw, rowy - 22), (x + bw, rowy + 22), (x, rowy + 22)], c)
    # ejected casings
    ex, ey = 1120, 560
    for p in _casing_params():
        dt = u - p["t0"]
        if dt <= 0:
            continue
        for k, (ds, al) in enumerate(((-0.010, 0.25), (-0.005, 0.5), (0.0, 1.0))):
            tt = dt + ds
            if tt < 0:
                continue
            x = ex + p["vx"] * tt
            y = ey + p["vy"] * tt + 0.5 * p["g"] * tt * tt
            if x > W + 80 or y > H + 80:
                continue
            ang = p["a0"] + p["w"] * tt
            L = p["L"] * (0.35 + 0.65 * abs(math.cos(p["ph"] + p["sp"] * tt)))
            _casing(f, x, y, ang, L, GREEN_DK, GREEN, GREEN_DK * 0.6, al)
    # ejection port flash for the first frames of each burst
    _green_bloom(f, 0.4)
    return f, dict(s=1.0, push=0.03, shake=10 + (6 if firing else 0), cont=firing)


# ================================================================ card 7 — kill feed
@lru_cache(maxsize=4)
def _feed_strip(sc):
    """Kill-feed strip as premultiplied layer at scale sc."""
    hgt = int(200 * sc)
    TA = _type("ARMY", int(150 * sc), 801, "white", 0.25, 0.0)
    TE = _type("ELIMINADO", int(150 * sc), 802, "bone", 0.35, 0.0)
    ic = load_layer("logo_icon")
    ic = resize_layer(ic, (hgt * 0.62) / ic.shape[0])
    gap = int(44 * sc)
    arw = int(34 * sc)
    xb = int(130 * sc)
    items_w = ic.shape[1] + gap + (TA["bbox"][2] - TA["bbox"][0]) + gap + arw + gap + xb + gap + arw + gap + (TE["bbox"][2] - TE["bbox"][0])
    pad = int(64 * sc)
    sk = int(46 * sc)
    wid = items_w + 2 * pad + sk
    rgb = np.zeros((hgt, wid, 3), np.float32)
    al = np.zeros((hgt, wid), np.float32)
    _poly(al, [(sk, 0), (wid, 0), (wid - sk, hgt), (0, hgt)], 1.0)
    rgb[:] = INK * al[..., None]
    # green edge tab on the left
    tab = np.zeros((hgt, wid), np.float32)
    _poly(tab, [(sk, 0), (sk + 14 * sc, 0), (14 * sc, hgt), (0, hgt)], 1.0)
    rgb += (GREEN - rgb) * tab[..., None]
    x = pad + sk * 0.5
    cyl = hgt / 2

    def place(pm_, x_, y_):
        h_, w_ = pm_.shape[:2]
        x_, y_ = int(round(x_)), int(round(y_))
        s = rgb[y_:y_ + h_, x_:x_ + w_]
        p = pm_[:s.shape[0], :s.shape[1]]
        s *= 1 - p[..., 3:4]
        s += p[..., :3]
    pic = _pm(ic)
    place(pic, x, cyl - ic.shape[0] / 2)
    x += ic.shape[1] + gap
    place(TA["pm"], x - TA["bbox"][0], cyl - (TA["base"] - TA["cap"] / 2))
    x += TA["bbox"][2] - TA["bbox"][0] + gap
    for which in (0, 1):
        ah = arw * 1.1
        _poly(rgb, [(x, cyl - ah), (x + arw, cyl), (x, cyl + ah)], GREEN)
        x += arw + gap
        if which == 0:
            # ✕ in a green-outlined box
            bh = xb
            m = np.zeros((hgt, wid), np.float32)
            _line(m, (x + bh * 0.24, cyl - bh * 0.26), (x + bh * 0.76, cyl + bh * 0.26), 1.0, 15 * sc)
            _line(m, (x + bh * 0.24, cyl + bh * 0.26), (x + bh * 0.76, cyl - bh * 0.26), 1.0, 15 * sc)
            ob = np.zeros((hgt, wid), np.float32)
            _poly(ob, [(x, cyl - bh / 2), (x + bh, cyl - bh / 2), (x + bh, cyl + bh / 2), (x, cyl + bh / 2)], 1.0)
            ib = np.zeros((hgt, wid), np.float32)
            t5 = 6 * sc
            _poly(ib, [(x + t5, cyl - bh / 2 + t5), (x + bh - t5, cyl - bh / 2 + t5), (x + bh - t5, cyl + bh / 2 - t5), (x + t5, cyl + bh / 2 - t5)], 1.0)
            frame_ = np.clip(ob - ib, 0, 1)
            rgb += (GREEN - rgb) * np.clip(frame_ + m, 0, 1)[..., None]
            x += bh + gap
    place(TE["pm"], x - TE["bbox"][0], cyl - (TE["base"] - TE["cap"] / 2))
    lay = np.dstack([rgb * al[..., None], al]).astype(np.float32)
    return lay, (sk + 14 * sc + pad + ic.shape[1] + gap + (TA["bbox"][2] - TA["bbox"][0]) + gap * 2 + arw, xb)


def _c_feed(u, fi):
    f = _bg("G", u, flip=True)
    strip, (xbx, xbw) = _feed_strip(1.0)
    sh, sw = strip.shape[:2]
    small, _ = _feed_strip(0.5)

    def slide(q, d=0.0, amp=1500):
        return amp * (1 - ease_out_expo(clamp((q - d) / 0.16)))
    # echo rows (smaller) stacked above/below, staggered
    for (yy, d, xo) in ((262, 0.06, 330), (818, 0.10, -300)):
        if u >= d:
            dx = slide(u, d, 1300)
            bl = int(_vblur_amount(lambda q: slide(q, d, 1300), u))
            _put(f, small, (small.shape[1] / 2, small.shape[0] / 2), 960 + xo + dx, yy, blur=(bl, 0))
    dx = slide(u)
    bl = int(_vblur_amount(slide, u))
    cx = 960 + dx - 10 * u / BEAT
    _put(f, strip, (sw / 2, sh / 2), cx, 540, blur=(bl, 0))
    # ✕ stamp: a green box punches out and settles after the strip lands
    sp = clamp((u - 0.12) / 0.10)
    if 0 < sp < 1:
        r = xbw * (0.5 + 0.9 * ease_out_cubic(sp))
        bx = cx - sw / 2 + xbx + xbw / 2
        th = max(1, 10 * (1 - sp))
        cv2.rectangle(f, (int((bx - r) * 16), int((540 - r) * 16)), (int((bx + r) * 16), int((540 + r) * 16)), _col(INK), int(th), cv2.LINE_AA, 4)
    c = _small("ABATE CONFIRMADO", 28, _col(INK), 6)
    _comp(f, c, 960 - c.shape[1] / 2 + dx * 0.6, 540 + sh / 2 + 34)
    return f, dict(s=1.0, push=0.03, shake=12)


# ================================================================ card 8 — reticle lock
@lru_cache(maxsize=1)
def _reticle(S=980):
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
    return np.dstack([m[..., None] * INK, m]).astype(np.float32)


@lru_cache(maxsize=1)
def _splat_small():
    return splatter(420, 420, seed=881, density=0.9, drips=False)


def _c_reticle(u, fi):
    f = _bg("C", u)
    R = _reticle()
    S = R.shape[0]
    e = ease_out_expo(clamp(u / 0.11))
    s = lerp(1.55, 1.0, e) - 0.06 * ease_in_out(clamp((u - 0.11) / 0.28))
    ang = lerp(-34, 0, e)
    ox, oy = lerp(260, 0, e), lerp(-160, 0, e)
    cx, cy = 960, 520
    # green hit splat at the centre once locked
    if u >= 0.07:
        sp = _splat_small()
        pe = ease_out_expo(clamp((u - 0.07) / 0.06))
        a = sp
        pmk = np.dstack([a[..., None] * GREEN, a]).astype(np.float32)
        _put(f, pmk, (210, 210), cx, cy, 0.4 + 0.6 * pe)
    _put(f, R, (S / 2, S / 2), cx + ox, cy + oy, s, ang)
    # lock brackets snapping in
    lb = ease_out_expo(clamp((u - 0.05) / 0.08))
    if u >= 0.05:
        r = lerp(520, 250, lb)
        _brackets(f, cx - r, cy - r, cx + r, cy + r, 70, 10, INK)
    lab = _small("ALVO TRAVADO", 36, _col(INK), 8)
    dist = _small("DIST 1.240 M", 36, _col(INK), 6)
    if u >= 0.09:
        _poly(f, [(1290, 830), (1314, 830), (1314, 854), (1290, 854)], GREEN if (fi // 2) % 2 == 0 else INK)
        _comp(f, lab, 1328, 822)
        _comp(f, dist, 1328, 872)
    return f, dict(s=1.0, push=0.02, shake=14)


# ================================================================ card 9 — typed line
TYPE_LINES = ("O SILÊNCIO", "TAMBÉM", "ELIMINA.")
TYPE_END = 0.27


def _c_typed(u, fi):
    f = _bg("B", u, pulse=0.4)
    px = 250
    Ts = [_type(TYPE_LINES[0], px, 901, "bone"), _type(TYPE_LINES[1], px, 902, "bone"), _type(TYPE_LINES[2], px, 903, "green", 0.7)]
    cap = Ts[0]["cap"]
    total = sum(len(s.replace(" ", "")) for s in TYPE_LINES)
    nshow = int(total * clamp(u / TYPE_END) + 0.999) if u > 0 else 1
    nshow = max(1, nshow)
    left = 230
    tops = [150, 150 + cap + 90, 150 + 2 * (cap + 90)]
    shown = 0
    cur = None
    for li, (T, txt) in enumerate(zip(Ts, TYPE_LINES)):
        xs = T["xs"]
        cnt = 0
        upto = 0
        for i, ch in enumerate(txt):
            if ch == " ":
                if shown < nshow:
                    upto = i + 1
                continue
            if shown < nshow:
                shown += 1
                upto = i + 1
            cnt += 1
        if upto == 0:
            if cur is None:
                cur = (left, tops[li])
            break
        a1 = int(round(xs[upto])) if upto < len(txt) else T["w"]
        _comp(f, T["pm"][:, :a1], left - T["bbox"][0], tops[li] - (T["base"] - cap))
        cx_ = left - T["bbox"][0] + xs[upto] + 14
        cur = (cx_, tops[li])
        if upto < len(txt):
            break
    # green block cursor
    done = u >= TYPE_END
    if cur is not None and (not done or (fi // 3) % 2 == 0):
        x, y = cur
        if done:
            x = left - Ts[2]["bbox"][0] + Ts[2]["xs"][-1] + 14
            y = tops[2]
        _poly(f, [(x, y), (x + cap * 0.42, y), (x + cap * 0.42, y + cap), (x, y + cap)], GREEN)
    # thin rule + caption
    _poly(f, [(left, tops[0] - 62), (left + 90, tops[0] - 62), (left + 90, tops[0] - 56), (left, tops[0] - 56)], GREEN)
    _green_bloom(f, 0.38)
    light_streak(f, 1012, 0.5, GREEN, thickness=2, length=0.8)
    return f, dict(s=1.0, push=0.035, shake=0)


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
    if cam.get("cont"):
        dx2, dy2, _ = shake(u, 5.0, 61.0, seed=k * 5 + 2)
        dx, dy = dx + dx2, dy + dy2
    border = _plate(kind)[540, 960]
    f = warp_frame(f, s * cam.get("s", 1.0), ang * 0.6, dx, dy, border=border)
    # chromatic split on the first frames after each cut
    if u < 2.5 * DT:
        f = chroma(f, 6 if u < DT else 3)
    _hud(f, k, kind, u)
    # hand-off: scene 4 ends on a green-white over-exposure
    if k == 0 and u < 0.13:
        f = flash(f, 0.92 * (1 - u / 0.13) ** 2, FLASH_C)
    # glitch frames on two cuts
    if k in (6, 9) and u < DT:
        f = glitch(f, 0.45, fi)
    return np.clip(f, 0, 255)
