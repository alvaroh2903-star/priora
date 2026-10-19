"""Shared toolkit for the ARMY loading-screen video.

Every scene module in scenes/ exposes:
    DUR: float                      scene length in seconds
    CUES: list[(t_local, kind)]     sound cues, kinds listed in CUE_KINDS
    render(t, ctx) -> np.ndarray    float32 (H, W, 3), values 0..255, sRGB

Frames are float32 RGB arrays in 0..255.  RGBA "layers" are float32 (h, w, 4)
with straight (non-premultiplied) alpha in 0..1 in channel 3 and colour 0..255.
Global post (grain, vignette, light chroma) is applied by build.py, so scenes
should NOT add their own film grain / vignette on top of everything.
"""
import math
import os
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(ROOT, "assets")
FONTS = os.path.join(ASSETS, "fonts")

W, H, FPS = 1920, 1080, 30

# ---------------------------------------------------------------- palette
GREEN = np.array([155, 230, 70], np.float32)      # toxic/neon green (logo bullet)
GREEN_DK = np.array([94, 143, 46], np.float32)    # bullet casing green
GREEN_HOT = np.array([200, 255, 120], np.float32) # glow core
BONE = np.array([214, 209, 198], np.float32)      # distressed off-white type
WHITE = np.array([242, 243, 245], np.float32)
INK = np.array([11, 12, 13], np.float32)          # background black
GREY = np.array([120, 122, 125], np.float32)

CUE_KINDS = (
    "impact",      # heavy type slam / hit
    "sub_drop",    # deep bass drop
    "whoosh",      # fast pass-by
    "shot",        # sniper gunshot
    "ricochet",    # bullet ricochet / fly-by zing
    "glitch",      # digital glitch burst
    "riser",       # tension riser leading into next cue (use t at riser START)
    "spray",       # spray-paint hiss
    "click",       # mechanical click / bolt / UI tick
    "shell",       # brass casing hitting floor
    "glass",       # glass / screen crack
    "beep",        # HUD beep
    "hum",         # neon / electric hum start
)

# ---------------------------------------------------------------- easing
def clamp(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def lerp(a, b, t):
    return a + (b - a) * t


def prog(t, t0, t1):
    """0..1 progress of t through [t0, t1], clamped."""
    return clamp((t - t0) / max(t1 - t0, 1e-6))


def ease_out_cubic(x):
    return 1 - (1 - x) ** 3


def ease_in_cubic(x):
    return x ** 3


def ease_in_out(x):
    return x * x * (3 - 2 * x)


def ease_out_expo(x):
    return 1.0 if x >= 1 else 1 - 2 ** (-10 * x)


def ease_out_back(x, s=1.70158):
    x -= 1
    return x * x * ((s + 1) * x + s) + 1


def ease_out_elastic(x):
    if x <= 0 or x >= 1:
        return float(x >= 1)
    return 2 ** (-10 * x) * math.sin((x * 10 - 0.75) * (2 * math.pi / 3)) + 1


# ---------------------------------------------------------------- fonts / text
FONT_FILES = {
    "anton": "Anton-Regular.ttf",            # huge condensed headline (UM TIRO.)
    "bebas": "BebasNeue-Regular.ttf",        # clean condensed caps
    "oswald": "Oswald.ttf",                  # condensed sans, small captions
    "stencil": "BlackOpsOne-Regular.ttf",    # military stencil
    "staatliches": "Staatliches-Regular.ttf",
    "marker": "PermanentMarker-Regular.ttf", # graffiti marker
    "graffiti": "SedgwickAveDisplay.ttf",    # spray/graffiti tag
    "scrawl": "RockSalt.ttf",                # rough handwriting
    "inter": "/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf",
    "inter_black": "/usr/share/fonts/opentype/inter/InterDisplay-Black.otf",
}


@lru_cache(maxsize=256)
def font(name, size):
    f = FONT_FILES.get(name, name)
    path = f if os.path.isabs(f) else os.path.join(FONTS, f)
    return ImageFont.truetype(path, int(size))


def text_layer(text, fname, size, fill=WHITE, tracking=0, pad=8, line_gap=0.0):
    """Render text (multi-line with \n) to an RGBA float layer, tight-ish bbox.
    tracking: extra pixels between letters."""
    f = font(fname, size)
    lines = text.split("\n")
    asc, desc = f.getmetrics()
    lh = asc + desc
    widths = []
    for ln in lines:
        if tracking:
            widths.append(sum(f.getlength(ch) + tracking for ch in ln) - tracking if ln else 0)
        else:
            widths.append(f.getlength(ln))
    w = int(max(widths) + 2 * pad) + 1
    h = int(lh * len(lines) + lh * line_gap * (len(lines) - 1) + 2 * pad)
    im = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(im)
    y = pad
    for ln in lines:
        x = pad
        if tracking:
            for ch in ln:
                d.text((x, y), ch, font=f, fill=255)
                x += f.getlength(ch) + tracking
        else:
            d.text((x, y), ln, font=f, fill=255)
        y += lh * (1 + line_gap)
    a = np.asarray(im, np.float32) / 255.0
    ys, xs = np.nonzero(a > 0.02)
    if len(xs):
        a = a[max(ys.min() - pad, 0): ys.max() + pad + 1, max(xs.min() - pad, 0): xs.max() + pad + 1]
    return solid_layer(a, fill)


def solid_layer(alpha, color):
    """Alpha mask (h,w) 0..1 -> RGBA layer filled with color."""
    h, w = alpha.shape
    lay = np.empty((h, w, 4), np.float32)
    lay[..., :3] = np.asarray(color, np.float32)
    lay[..., 3] = alpha
    return lay


# ---------------------------------------------------------------- images / assets
@lru_cache(maxsize=64)
def _load(path):
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im, np.float32).copy()
    a[..., 3] /= 255.0
    return a


def load_layer(name):
    """Load RGBA asset (assets/<name>.png) as float layer. Returns a copy."""
    p = name if os.path.isabs(name) else os.path.join(ASSETS, name if name.endswith(".png") else name + ".png")
    return _load(p).copy()


# Available logo pieces (assets/*.png), all extracted from the brand sheet:
#   logo_wordmark   full "ARMY" with bullet+streaks, 1440x320 (letters span x~270..1410)
#   logo_icon       "A" with bullet through it (no streaks), 288x248
#   logo_icon_streak  icon + green motion streaks on the left, 526x248
#   logo_letter_A/R/M/Y  individual white letters (A has no bullet), height 248
#   logo_bullet     the green bullet alone (with dark outline), 288x73
#   logo_streaks    just the three green motion streaks, 245x100
# Placing letters to rebuild the wordmark: in logo_wordmark coordinates the
# crops start at x = A:268  R:583  M:836  Y:1168, y = 36; bullet at (271,153).
WORDMARK_PIECES = {"A": (268, 36), "R": (583, 36), "M": (836, 36), "Y": (1168, 36),
                   "bullet": (271, 153), "streaks": (30, 140)}


def resize_layer(lay, scale=None, size=None, interp=None):
    h, w = lay.shape[:2]
    if size is None:
        size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    if interp is None:
        interp = cv2.INTER_AREA if size[0] < w else cv2.INTER_CUBIC
    out = cv2.resize(lay, size, interpolation=interp)
    out[..., 3] = np.clip(out[..., 3], 0, 1)
    return out


def transform_layer(lay, scale=1.0, angle=0.0, out_size=None):
    """Scale + rotate (degrees, CCW) around center; returns new layer with
    enough canvas to hold the result (or out_size)."""
    h, w = lay.shape[:2]
    if out_size is None:
        diag = int(math.ceil(math.hypot(w, h) * scale)) + 4
        out_size = (diag, diag)
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, scale)
    M[0, 2] += out_size[0] / 2 - w / 2
    M[1, 2] += out_size[1] / 2 - h / 2
    pm = premul(lay)
    out = cv2.warpAffine(pm, M, out_size, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return unpremul(out)


def premul(lay):
    o = lay.copy()
    o[..., :3] *= o[..., 3:4]
    return o


def unpremul(lay):
    o = lay.copy()
    a = np.maximum(o[..., 3:4], 1e-5)
    o[..., :3] = np.where(o[..., 3:4] > 1e-5, o[..., :3] / a, 0)
    o[..., 3] = np.clip(o[..., 3], 0, 1)
    return o


# ---------------------------------------------------------------- compositing
def blank(color=INK):
    f = np.empty((H, W, 3), np.float32)
    f[:] = np.asarray(color, np.float32)
    return f


def _clip_rect(dst_shape, lay_shape, x, y):
    H_, W_ = dst_shape[:2]
    h, w = lay_shape[:2]
    x0, y0 = max(x, 0), max(y, 0)
    x1, y1 = min(x + w, W_), min(y + h, H_)
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1, x0 - x, y0 - y


def over(dst, lay, x, y, opacity=1.0, mode="normal"):
    """Composite RGBA layer onto frame at integer top-left (x, y), in place.
    mode: normal | add | screen | multiply"""
    r = _clip_rect(dst.shape, lay.shape, int(round(x)), int(round(y)))
    if r is None or opacity <= 0:
        return dst
    x0, y0, x1, y1, lx, ly = r
    src = lay[ly:ly + (y1 - y0), lx:lx + (x1 - x0)]
    a = src[..., 3:4] * opacity
    d = dst[y0:y1, x0:x1]
    c = src[..., :3]
    if mode == "normal":
        d += (c - d) * a
    elif mode == "add":
        d += c * a
    elif mode == "screen":
        d += (255 - d) * (c / 255.0) * a
    elif mode == "multiply":
        d += (d * c / 255.0 - d) * a
    return dst


def over_center(dst, lay, cx, cy, opacity=1.0, mode="normal"):
    h, w = lay.shape[:2]
    return over(dst, lay, cx - w / 2, cy - h / 2, opacity, mode)


def glow(lay_or_frame, sigma=20, strength=1.0):
    """Blurred copy (for additive bloom). Accepts layer (premultiplied out) or frame."""
    if lay_or_frame.shape[-1] == 4:
        src = lay_or_frame[..., :3] * lay_or_frame[..., 3:4]
    else:
        src = lay_or_frame
    return cv2.GaussianBlur(src, (0, 0), sigma) * strength


def add_glow(dst, lay, x, y, sigma=20, strength=1.0, pad=None):
    """Additively composite a bloom of `lay` at (x,y)."""
    pad = int(sigma * 3) if pad is None else pad
    h, w = lay.shape[:2]
    big = np.zeros((h + 2 * pad, w + 2 * pad, 4), np.float32)
    big[pad:pad + h, pad:pad + w] = premul(lay)
    g = cv2.GaussianBlur(big[..., :3], (0, 0), sigma) * strength
    gl = np.dstack([g, np.ones(g.shape[:2], np.float32)])
    return over(dst, gl, x - pad, y - pad, 1.0, "add")


def bloom(frame, threshold=180, sigma=25, strength=0.6):
    """Full-frame bloom on bright pixels (green glows especially)."""
    hi = np.clip(frame - threshold, 0, None)
    small = cv2.resize(hi, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), sigma / 4)
    return frame + cv2.resize(small, (frame.shape[1], frame.shape[0])) * strength


def warp_frame(frame, scale=1.0, angle=0.0, dx=0.0, dy=0.0, border=INK):
    """Camera move: scale/rotate about centre then translate (pixels)."""
    M = cv2.getRotationMatrix2D((W / 2, H / 2), angle, scale)
    M[0, 2] += dx
    M[1, 2] += dy
    bv = tuple(float(v) for v in np.asarray(border, np.float32))
    return cv2.warpAffine(frame, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=bv)


def shake(t, amp=12.0, freq=22.0, seed=0, decay_from=None, decay=6.0):
    """Deterministic camera-shake offsets (dx, dy, angle). If decay_from is set,
    amplitude decays exponentially after that time (use for impact shakes)."""
    if decay_from is not None:
        if t < decay_from:
            return 0.0, 0.0, 0.0
        amp = amp * math.exp(-(t - decay_from) * decay)
    s = seed * 13.37
    dx = amp * (math.sin(t * freq + s) * 0.6 + math.sin(t * freq * 2.3 + s * 2) * 0.4)
    dy = amp * (math.sin(t * freq * 1.3 + s * 3) * 0.6 + math.sin(t * freq * 2.9 + s) * 0.4)
    ang = amp * 0.04 * math.sin(t * freq * 0.7 + s)
    return dx, dy, ang


# ---------------------------------------------------------------- procedural textures
def _rng(seed):
    return np.random.default_rng(seed)


@lru_cache(maxsize=32)
def value_noise(w, h, scale=64, octaves=4, seed=0):
    """Fractal value noise in 0..1, shape (h, w)."""
    rng = _rng(seed)
    out = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    s = scale
    for _ in range(octaves):
        gw, gh = max(2, int(w / s) + 2), max(2, int(h / s) + 2)
        g = rng.random((gh, gw)).astype(np.float32)
        out += cv2.resize(g, (w, h), interpolation=cv2.INTER_CUBIC) * amp
        tot += amp
        amp *= 0.5
        s = max(s / 2, 1)
    out /= tot
    out -= out.min()
    out /= max(out.max(), 1e-6)
    return out


@lru_cache(maxsize=16)
def grunge(w=W, h=H, seed=1):
    """Gritty distress mask 0..1 (1 = clean, 0 = worn away). Mix of speckle
    noise, blotches and scratches — multiply into type alpha to get the worn
    concrete/print look of the brand posters."""
    rng = _rng(seed)
    blot = value_noise(w, h, 90, 5, seed)
    speck = rng.random((h, w)).astype(np.float32)
    fine = value_noise(w, h, 6, 2, seed + 7)
    m = np.ones((h, w), np.float32)
    m -= np.clip((blot - 0.62) * 4.0, 0, 1) * 0.85        # big worn blotches
    m -= (speck > 0.93).astype(np.float32) * 0.9         # pin holes
    m -= np.clip((fine - 0.7) * 3, 0, 1) * 0.6           # fine grit
    # scratches
    sc = np.zeros((h, w), np.uint8)
    for _ in range(int(w * h / 40000)):
        x0, y0 = rng.integers(0, w), rng.integers(0, h)
        ang = rng.normal(0.3, 0.6)
        L = rng.integers(20, 160)
        cv2.line(sc, (int(x0), int(y0)), (int(x0 + L * math.cos(ang)), int(y0 + L * math.sin(ang))), 255, 1, cv2.LINE_AA)
    m -= sc.astype(np.float32) / 255 * 0.8
    return np.clip(m, 0, 1)


def distress(lay, amount=1.0, seed=1, offset=(0, 0)):
    """Wear the alpha of a layer with the grunge mask (amount 0..1)."""
    h, w = lay.shape[:2]
    g = grunge(max(w, 64) + 64, max(h, 64) + 64, seed)
    ox, oy = offset[0] % 64, offset[1] % 64
    g = g[oy:oy + h, ox:ox + w]
    o = lay.copy()
    o[..., 3] *= 1 - (1 - g) * amount
    return o


@lru_cache(maxsize=16)
def halftone(w, h, cell=14, angle=45.0, seed=0, falloff="radial", cx=0.0, cy=0.0, gamma=1.0):
    """Halftone dot mask 0..1 (h, w).  Dot radius follows a gradient:
    falloff='radial' -> big dots at (cx, cy) (fractions of w,h) shrinking away;
    'linear' -> big at top-left fading to bottom-right; 'flat' -> uniform 0.5;
    'noise' -> driven by value noise."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    a = math.radians(angle)
    u = xx * math.cos(a) + yy * math.sin(a)
    v = -xx * math.sin(a) + yy * math.cos(a)
    fu = (u / cell) % 1 - 0.5
    fv = (v / cell) % 1 - 0.5
    d = np.sqrt(fu * fu + fv * fv)  # 0..0.707 distance to cell centre
    if falloff == "radial":
        g = 1 - np.clip(np.hypot(xx / w - cx, yy / h - cy) / 1.0, 0, 1)
    elif falloff == "linear":
        g = 1 - np.clip((xx / w + yy / h) / 2, 0, 1)
    elif falloff == "noise":
        g = value_noise(w, h, 160, 3, seed)
    else:
        g = np.full((h, w), 0.5, np.float32)
    g = g ** gamma
    r = g * 0.62
    m = np.clip((r - d) * cell * 0.9 + 0.5, 0, 1)
    return m.astype(np.float32)


def splatter(w, h, seed=0, density=1.0, drips=True, main_blob=True):
    """Spray-paint splatter mask 0..1 (h, w): a central blob, flecks and
    optional downward drips. Combine with solid_layer(mask, GREEN)."""
    rng = _rng(seed)
    m = np.zeros((h, w), np.float32)
    cx, cy = w / 2, h / 2
    if main_blob:
        n = value_noise(w, h, max(8, min(w, h) / 5), 3, seed)
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        rr = np.hypot((xx - cx) / (w * 0.32), (yy - cy) / (h * 0.32))
        m = np.clip((1.0 - rr + (n - 0.5) * 0.9) * 18, 0, 1)
    img = (m * 255).astype(np.uint8)
    for _ in range(int(120 * density)):
        ang = rng.random() * 2 * math.pi
        dist = abs(rng.normal(0, 0.28)) * min(w, h)
        x, y = int(cx + math.cos(ang) * dist), int(cy + math.sin(ang) * dist)
        r = max(1, int(abs(rng.normal(0, 1)) * min(w, h) * 0.012 + 1))
        cv2.circle(img, (x, y), r, 255, -1, cv2.LINE_AA)
    if drips:
        for _ in range(int(7 * density)):
            x = int(cx + rng.normal(0, w * 0.18))
            y0 = int(cy + rng.normal(0, h * 0.06))
            L = int(abs(rng.normal(0.25, 0.12)) * h)
            th = max(2, int(rng.integers(2, max(3, w // 60))))
            cv2.line(img, (x, y0), (x, min(h - 6, y0 + L)), 255, th, cv2.LINE_AA)
            cv2.circle(img, (x, min(h - 6, y0 + L)), int(th * 0.9) + 1, 255, -1, cv2.LINE_AA)
    return img.astype(np.float32) / 255.0


def drip_mask(w, h, t, seed=0, n=10, speed=1.0, max_len=0.8, width=(3, 9)):
    """Animated paint drips hanging from the top edge of a (w,h) box.
    t in seconds (0 = start running). Returns 0..1 mask."""
    rng = _rng(seed)
    img = np.zeros((h, w), np.uint8)
    for i in range(n):
        x = int(rng.random() * w)
        th = int(rng.integers(width[0], width[1] + 1))
        delay = rng.random() * 0.4
        L = h * max_len * (0.3 + 0.7 * rng.random())
        p = clamp((t - delay) * speed * (0.6 + rng.random() * 0.8))
        cur = int(L * ease_out_cubic(p))
        if cur > 1:
            cv2.line(img, (x, 0), (x, cur), 255, th, cv2.LINE_AA)
            cv2.circle(img, (x, cur), int(th * 0.75) + 1, 255, -1, cv2.LINE_AA)
    return img.astype(np.float32) / 255.0


def crack_mask(w, h, cx, cy, seed=0, branches=14, progress=1.0, thickness=2):
    """Radial glass/concrete crack lines from (cx, cy). progress 0..1 grows them."""
    rng = _rng(seed)
    img = np.zeros((h, w), np.uint8)
    for b in range(branches):
        ang = b / branches * 2 * math.pi + rng.normal(0, 0.18)
        x, y = float(cx), float(cy)
        L = (0.25 + rng.random() * 0.75) * math.hypot(w, h) * 0.5 * progress
        steps = 18
        for s in range(steps):
            seg = L / steps
            ang += rng.normal(0, 0.22)
            nx, ny = x + math.cos(ang) * seg, y + math.sin(ang) * seg
            th = max(1, int(thickness * (1 - s / steps) + 0.5))
            cv2.line(img, (int(x), int(y)), (int(nx), int(ny)), 255, th, cv2.LINE_AA)
            if rng.random() < 0.18:  # side branch
                ba = ang + rng.choice([-1, 1]) * rng.uniform(0.5, 1.1)
                bl = seg * rng.uniform(1.5, 4)
                cv2.line(img, (int(nx), int(ny)), (int(nx + math.cos(ba) * bl), int(ny + math.sin(ba) * bl)), 255, 1, cv2.LINE_AA)
            x, y = nx, ny
    return img.astype(np.float32) / 255.0


@lru_cache(maxsize=8)
def smoke_field(w=W, h=H, seed=3):
    """Large soft smoke texture 0..1, 2x frame size so it can be scrolled."""
    return value_noise(w * 2, h * 2, 420, 6, seed)


def smoke(t, speed=(30, -8), density=0.5, seed=3, color=(90, 110, 70)):
    """Drifting smoke/fog layer (full frame RGBA)."""
    f = smoke_field(W // 2, H // 2, seed)
    ox = int((t * speed[0] / 2) % (W // 2))
    oy = int((t * speed[1] / 2) % (H // 2))
    crop = np.roll(np.roll(f, -oy, 0), -ox, 1)[: H // 2, : W // 2]
    a = np.clip((crop - 0.45) * 2.2, 0, 1) * density
    a = cv2.resize(a, (W, H), interpolation=cv2.INTER_LINEAR)
    return solid_layer(a, color)


def scope_reticle(size, color=GREEN, thickness=4, seed=0, rough=True):
    """Hand-drawn style sniper crosshair (circle + cross + ticks) as RGBA layer,
    like the green reticle in the 'UM TIRO. UMA BAIXA.' poster."""
    rng = _rng(seed)
    img = np.zeros((size, size), np.uint8)
    c = size // 2
    R = int(size * 0.36)
    pts = []
    for i in range(181):
        a = i / 180 * 2 * math.pi
        rr = R + (rng.normal(0, 1.2) if rough else 0)
        pts.append((int(c + rr * math.cos(a)), int(c + rr * math.sin(a))))
    cv2.polylines(img, [np.array(pts, np.int32)], True, 255, thickness, cv2.LINE_AA)
    L = int(size * 0.5) - 4
    gap = int(size * 0.06)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        cv2.line(img, (c + dx * gap, c + dy * gap), (c + dx * L, c + dy * L), 255, thickness, cv2.LINE_AA)
        for k in range(1, 6):  # ticks
            p = int(R * k / 5.5)
            tl = int(size * 0.018) + (6 if k == 3 else 0)
            if dx:
                cv2.line(img, (c + dx * p, c - tl), (c + dx * p, c + tl), 255, max(2, thickness - 1), cv2.LINE_AA)
            else:
                cv2.line(img, (c - tl, c + dy * p), (c + tl, c + dy * p), 255, max(2, thickness - 1), cv2.LINE_AA)
    cv2.circle(img, (c, c), max(2, thickness), 255, -1, cv2.LINE_AA)
    return solid_layer(img.astype(np.float32) / 255.0, color)


# ---------------------------------------------------------------- glitch / fx
def chroma(frame, k=4):
    """Lateral chromatic aberration by k pixels."""
    k = int(round(k))
    if k <= 0:
        return frame
    o = frame.copy()
    o[:, k:, 0] = frame[:, :-k, 0]
    o[:, :-k, 2] = frame[:, k:, 2]
    return o


def glitch(frame, amount, seed):
    """Horizontal slice displacement + green/white colour blocks. amount 0..1.5.
    Deterministic per seed (use frame index)."""
    rng = _rng(seed)
    o = frame.copy()
    for _ in range(int(5 + amount * 18)):
        y = int(rng.integers(0, H - 12))
        h = int(rng.integers(3, int(14 + 70 * amount)))
        s = int(rng.normal(0, 110 * amount))
        o[y:y + h] = np.roll(frame[y:y + h], s, axis=1)
        r = rng.random()
        if r < 0.15:
            o[y:y + h] = o[y:y + h] * 0.4 + GREEN * 0.6
        elif r < 0.25:
            o[y:y + h] = 255 - o[y:y + h]
    return chroma(o, 4 + 14 * amount)


def flash(frame, amount, color=WHITE):
    return frame + (np.asarray(color, np.float32) - frame) * clamp(amount)


def tint_mono(frame, color=GREEN, amount=1.0):
    """Duotone: luminance mapped from INK to color."""
    lum = frame @ np.array([0.299, 0.587, 0.114], np.float32)
    duo = INK + (np.asarray(color, np.float32) - INK) * (lum[..., None] / 255.0)
    return frame + (duo - frame) * amount


def light_streak(frame, y, intensity=1.0, color=GREEN, thickness=3, length=1.0, cx=W / 2):
    """Horizontal anamorphic green light line (like the bottom of the poster)."""
    hw = int(W * 0.5 * length)
    lay = np.zeros((60, 2 * hw, 3), np.float32)
    xs = np.linspace(-1, 1, 2 * hw)
    prof = (1 - np.abs(xs) ** 1.5)[None, :]
    lay[30 - thickness // 2: 30 + thickness - thickness // 2] = np.asarray(color, np.float32) * 1.4 * prof[..., None]
    lay = lay + cv2.GaussianBlur(lay, (0, 0), 9) * 1.5
    full = np.dstack([lay, np.ones(lay.shape[:2], np.float32)])
    return over(frame, full, cx - hw, y - 30, intensity, "add")


def fit_box(lay, max_w, max_h):
    h, w = lay.shape[:2]
    s = min(max_w / w, max_h / h)
    return resize_layer(lay, s)
