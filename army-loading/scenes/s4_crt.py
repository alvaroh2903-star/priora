"""Scene 4 - CRT room plate (client image), brought alive.

The plate is split into three hand-masked depth layers (wall/soldier, monitors,
desk/keyboard/headset) that move with a real dolly-parallax model; the baked
logos are removed from the three CRTs and the screens are re-rendered every
frame through each glass quad's homography (crisp logo, scanlines, roll, tear,
phosphor glow, aperture grille when close).  Neon tubes flicker and drive the
room light, haze drifts through the green light, dust motes catch it, the
soldier's lenses ignite.  The camera finally dives into the main CRT
(screen-rectifying homography + barrel curvature) and ends on a green-white
flash that hands off to scene 5.

Beats (local s):
  0.00-0.30  whip-pan smear from scene 3 settles (content slides in from right, exposure still
             lifted, s3's green exit streaks carried through the first 3 frames)
  0.00-0.70  neon tubes stutter on (hum)
  0.00-1.00  CRTs out of vertical hold, rolling; lock on the beep at 1.0 (hit frame, hot retrace
             line, 2-frame jolt)
  2.20       glitch: neon cut, screens tear, side screens switch feed
  3.60       riser: dolly accelerates, screens heat up
  4.60-4.80  dive: bezel rushes past (radial zoom blur, full-frame barrel lens); the camera homes
             in on the bullet's hot front.  From 4.42 the main tube's scanline/grille pattern is
             applied full-frame after the zoom blur (uniformly crisp, green-dominant)
  4.80-4.87  inside the tube: giant phosphor letters + green bullet, fat scanlines + grille
  4.87-5.00  3-frame over-exposure ramp to a green/white flash -> scene 5
"""
import math
import os
from functools import lru_cache

import cv2
import numpy as np

from lib import *

DUR = 5.0
CUES = [(0.0, "hum"), (1.0, "beep"), (2.2, "glitch"), (3.6, "riser"), (4.6, "whoosh")]

PLATE = os.path.join(ASSETS, "crt_room.webp")
PW, PH = 1672, 941
S0 = W / PW                     # plate -> output base scale
U = 1.5                         # pre-upscale of plate layers (headroom for the push)
UW, UH = int(round(PW * U)), int(round(PH * U))
PC = np.float32([PW / 2, PH / 2])

# Measured CRT glass quads in plate px (TL, TR, BR, BL) - extrapolated corners
# of the rounded glass.
Q_MAIN = np.float32([(700, 182), (1209, 246), (1197, 632), (681, 592)])
Q_TOP = np.float32([(243, 88), (474, 131), (467, 307), (229, 258)])
Q_BOT = np.float32([(210, 334), (481, 384), (474, 552), (200, 528)])
F_MAIN = Q_MAIN.mean(0)         # dolly target (main screen centre)
RECT_W, RECT_H = 514.0, 398.0   # main glass size used when the camera squares up to it
TUBE_GROW = 1.025               # tube boundary vs measured quad at the edge midpoints (true glass)
PGS = 1.45                      # pages are stored as emission / PGS (uint8) so green can run hot
TINT = (198, 222, 204)          # white phosphor (P4-ish, slightly green)

# camera distance of each layer (main monitor = 1)
Z_BG, Z_MID, Z_FG = 1.65, 1.0, 0.62

# plate points
EYE = (1563, 300)               # soldier's green lens (centre of the goggle band)
LENS = [(1550, 301), (1578, 293)]   # hot spots along the goggle band
POST_CHROMA = 2                 # build.post's lateral chroma shift (px), see _DEFER use in render
LEDS_MID = [(1180, 708, 1.0), (452, 330, 0.8), (445, 592, 0.6)]   # power LEDs (x, y, size)
TUBE_C = (1157, 64)
TUBES = [((1045, 10), (1270, 118), 330.0), ((1600, 245), (1690, 222), 260.0)]

# ---------------------------------------------------------------- hand masks (plate px)
POLY_MID = [
    # small CRT stack + device under it
    [(92, 52), (205, 30), (232, 25), (500, 80), (516, 94), (522, 330), (528, 545), (548, 575),
     (548, 612), (420, 616), (300, 612), (215, 596), (165, 520), (150, 395), (92, 330)],
    # main CRT (body, bezel, front panel)
    [(496, 168), (540, 150), (668, 86), (1262, 225), (1270, 238), (1270, 560), (1268, 700),
     (1262, 750), (1100, 748), (690, 732), (640, 718), (600, 702), (560, 645), (522, 615), (496, 600)],
    # cases on the right behind keyboard / radio
    [(1266, 590), (1280, 582), (1328, 578), (1331, 565), (1400, 563), (1405, 578), (1520, 585),
     (1545, 600), (1600, 605), (1640, 612), (1648, 640), (1648, 770), (1266, 772)],
]
# loose region around the soldier (head, cap, headset, shoulders); the silhouette is keyed inside
POLY_SOLDIER = [(1440, 190), (1580, 185), (1672, 250), (1672, 600), (1300, 600), (1290, 420), (1360, 360),
                (1410, 330), (1430, 250)]
POLY_FG = [
    # left stacked cases
    [(0, 358), (100, 362), (152, 384), (160, 470), (166, 515), (212, 540), (222, 600),
     (218, 700), (160, 748), (0, 750)],
    # headset (+ boom mic)
    [(212, 655), (255, 606), (318, 588), (420, 584), (472, 598), (530, 618), (560, 640),
     (578, 668), (586, 700), (586, 742), (640, 760), (660, 790), (212, 800)],
    # keyboard + desk front + radio + bottom strip (incl. out-of-focus rounds bottom-left)
    [(0, 742), (212, 760), (640, 792), (668, 726), (700, 716), (900, 728), (1100, 744),
     (1300, 757), (1392, 766), (1392, 690), (1412, 682), (1550, 682), (1555, 481), (1577, 481),
     (1581, 686), (1672, 688), (1672, 941), (0, 941)],
]

_S = {}


# ---------------------------------------------------------------- helpers
def _T(tx, ty):
    return np.array([[1, 0, tx], [0, 1, ty], [0, 0, 1]], np.float64)


def _Sc(s, cx, cy):
    return np.array([[s, 0, cx * (1 - s)], [0, s, cy * (1 - s)], [0, 0, 1]], np.float64)


def _poly_mask(polys, feather=2.0):
    m = np.zeros((PH, PW), np.uint8)
    for p in polys:
        cv2.fillPoly(m, [np.int32(np.round(np.float32(p) * 4))], 255, cv2.LINE_AA, shift=2)
    m = m.astype(np.float32) / 255.0
    return cv2.GaussianBlur(m, (0, 0), feather) if feather > 0 else m


def _guided(I, p, r=4, eps=1.5e-3):
    k = (2 * r + 1, 2 * r + 1)
    box = lambda x: cv2.boxFilter(x, -1, k)
    mI, mp = box(I), box(p)
    a = (box(I * p) - mI * mp) / (box(I * I) - mI * mI + eps)
    b = mp - a * mI
    return np.clip(box(a) * I + box(b), 0, 1)


def _fill_holes(img, valid):
    """Push-pull fill: pixels where valid~0 get a smooth extension of the rest."""
    h0, w0 = img.shape[:2]
    valid = valid.astype(np.float32)
    im = cv2.resize(img * valid[..., None], (w0 // 2, h0 // 2), interpolation=cv2.INTER_AREA)
    m = cv2.resize(valid, (w0 // 2, h0 // 2), interpolation=cv2.INTER_AREA)
    levels = []
    while min(im.shape[:2]) > 6:
        levels.append((im, m))
        h, w = im.shape[:2]
        im = cv2.resize(im, (max(1, w // 2), max(1, h // 2)), interpolation=cv2.INTER_AREA)
        m = cv2.resize(m, (max(1, w // 2), max(1, h // 2)), interpolation=cv2.INTER_AREA)
    cur = im / np.maximum(m, 1e-4)[..., None]
    for im_l, m_l in reversed(levels):
        h, w = im_l.shape[:2]
        up = cv2.resize(cur, (w, h), interpolation=cv2.INTER_LINEAR)
        mm = np.clip(m_l * 1.6, 0, 1)[..., None]
        cur = im_l / np.maximum(m_l, 1e-4)[..., None] * mm + up * (1 - mm)
    up = cv2.resize(cur, (w0, h0), interpolation=cv2.INTER_LINEAR)
    vv = valid[..., None]
    return img * vv + up * (1 - vv)


def _quad_H(q):
    """Homography unit square (u,v) -> plate quad."""
    return cv2.getPerspectiveTransform(np.float32([(0, 0), (1, 0), (1, 1), (0, 1)]), np.float32(q))


def _upscale(img):
    """Plate-res float RGB -> U-times upscaled, unsharp-masked uint8."""
    up = cv2.resize(np.clip(img, 0, 255).astype(np.uint8), (UW, UH), interpolation=cv2.INTER_CUBIC)
    bl = cv2.GaussianBlur(up, (0, 0), 1.5)
    return cv2.addWeighted(up, 1.7, bl, -0.7, 0)


def _premul_u8(rgb8, alpha):
    """uint8 RGB + float alpha (plate res) -> premultiplied RGBA uint8 at U-res."""
    a8 = cv2.resize(np.clip(alpha * 255, 0, 255).astype(np.uint8), (UW, UH), interpolation=cv2.INTER_LINEAR)
    pm = cv2.multiply(rgb8, cv2.merge([a8, a8, a8]), scale=1 / 255.0)
    return cv2.merge([pm, a8])


def _mips(page):
    out = [page]
    while out[-1].shape[1] > 96:
        p = out[-1]
        out.append(cv2.resize(p, (p.shape[1] // 2, p.shape[0] // 2), interpolation=cv2.INTER_AREA))
    return out


def _quad_aspect(q):
    q = np.float32(q)
    w = (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / 2
    h = (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1])) / 2
    return float(w / h)


def _seg_dist(xx, yy, a, b):
    ax, ay = a
    bx, by = b
    vx, vy = bx - ax, by - ay
    L2 = vx * vx + vy * vy
    tt = np.clip(((xx - ax) * vx + (yy - ay) * vy) / L2, 0, 1)
    return np.hypot(xx - (ax + tt * vx), yy - (ay + tt * vy))


# ---------------------------------------------------------------- pages (screen content)
def _phosphor(rgb, tint=TINT):
    """Asset colours -> phosphor emission (HDR, can exceed 255).
    whites -> tint; bullet tip / streak greens -> 1.35x hot saturated green (the brightest
    coloured thing on screen); casing green stays ~0.8x (two-tone kept); the dark outline and
    the pale highlight stripe are left unsaturated."""
    R, G, B = rgb[..., 0:1], rgb[..., 1:2], rgb[..., 2:3]
    mn = np.minimum(np.minimum(R, G), B)
    white = np.clip((mn - 175) / 35, 0, 1)
    green = np.clip((G - np.maximum(R, B) - 16) / 22, 0, 1) * (1 - white)
    tip = np.clip((G - 150) / 60, 0, 1)
    pale = np.clip((mn - 120) / 50, 0, 1)                    # highlight stripe: keep it pale
    lum = rgb.mean(2, keepdims=True)
    sat = 1 + 0.22 * tip * (1 - pale)
    gcol = (lum + (rgb - lum) * sat) * (0.8 + 0.55 * tip)
    out = rgb * (1 - white - green) + np.float32(tint) * white + gcol * green
    return np.maximum(out, 0)


def _to_page(em):
    return cv2.convertScaleAbs(np.ascontiguousarray(em, np.float32), alpha=1.0 / PGS)   # >= 0 already


def _page_wordmark(pw, aspect, width=0.9, cy=0.5, tint=TINT):
    ph = int(round(pw / aspect))
    lay = load_layer("logo_wordmark")
    ys, xs = np.nonzero(lay[..., 3] > 0.02)
    lay = lay[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    tw = int(pw * width)
    lay = resize_layer(lay, size=(tw, int(round(lay.shape[0] * tw / lay.shape[1]))))
    em = _phosphor(lay[..., :3], tint) * lay[..., 3:4]
    page = np.zeros((ph, pw, 3), np.float32)
    h, w = em.shape[:2]
    x0, y0 = (pw - w) // 2, int(ph * cy - h / 2)
    page[y0:y0 + h, x0:x0 + w] = em
    return _to_page(page)


def _page_icon(pw, aspect):
    ph = int(round(pw / aspect))
    lay = load_layer("logo_icon")
    lay = resize_layer(lay, ph * 0.5 / lay.shape[0])
    em = _phosphor(lay[..., :3]) * lay[..., 3:4]
    page = np.zeros((ph, pw, 3), np.float32)
    h, w = em.shape[:2]
    page[(ph - h) // 2:(ph - h) // 2 + h, (pw - w) // 2:(pw - w) // 2 + w] = em
    return _to_page(page)


def _page_reticle(n):
    r = scope_reticle(n, GREEN * 1.2, thickness=max(3, n // 110), seed=5)
    return _to_page(r[..., :3] * r[..., 3:4])


def _page_tagline(pw, aspect):
    ph = int(round(pw / aspect))
    page = np.zeros((ph, pw, 3), np.float32)
    l1 = text_layer("SKILL IS THE", "inter_black", ph * 0.16, TINT)
    l2 = text_layer("ONLY", "inter_black", ph * 0.27, GREEN * 1.3)
    l3 = text_layer("ADVANTAGE", "inter_black", ph * 0.16, TINT)
    maxw = pw * 0.8
    ls = [fit_box(l, maxw, ph) if l.shape[1] > maxw else l for l in (l1, l2, l3)]
    gap = ph * 0.02
    tot = sum(l.shape[0] for l in ls) + 2 * gap
    y = (ph - tot) / 2
    for l in ls:
        over(page, l, (pw - l.shape[1]) / 2, y)
        y += l.shape[0] + gap
    return _to_page(page)


# ---------------------------------------------------------------- one-time prep
def _prep():
    if _S:
        return _S
    from PIL import Image as _Im
    plate = np.asarray(_Im.open(PLATE).convert("RGB"), np.float32)
    yy = np.arange(PH, dtype=np.float32)[:, None]
    xx = np.arange(PW, dtype=np.float32)[None, :]

    # --- remove the baked logos from the three screens
    p8 = np.clip(plate, 0, 255).astype(np.uint8)
    mn = plate.min(2)
    logo = ((mn > 150) | ((plate[..., 1] > 140) & (plate[..., 1] - plate[..., 2] > 70))).astype(np.uint8)
    glass = np.zeros((PH, PW), np.uint8)
    for q in (Q_MAIN, Q_TOP, Q_BOT):
        cv2.fillConvexPoly(glass, np.int32(np.round(q)), 1)
    logo &= glass
    n, lab, st, _ = cv2.connectedComponentsWithStats(logo, 8)
    keep = np.zeros(n, np.uint8)
    keep[1:] = st[1:, cv2.CC_STAT_AREA] > 40
    logo = keep[lab]
    logo = cv2.dilate(logo, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    clean = plate.copy()
    for q in (Q_MAIN, Q_TOP, Q_BOT):
        x0, y0 = np.floor(q.min(0)).astype(int) - 16
        x1, y1 = np.ceil(q.max(0)).astype(int) + 16
        clean[y0:y1, x0:x1] = cv2.inpaint(p8[y0:y1, x0:x1], logo[y0:y1, x0:x1] * 255, 3, cv2.INPAINT_TELEA)
    # kill the logo-shaped glow halo: re-light each glass from its logo-free parts
    halo = cv2.dilate(logo, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (51, 51)))
    for q in (Q_MAIN, Q_TOP, Q_BOT):
        x0, y0 = np.floor(q.min(0)).astype(int) - 12
        x1, y1 = np.ceil(q.max(0)).astype(int) + 12
        g = np.zeros((y1 - y0, x1 - x0), np.uint8)
        cv2.fillConvexPoly(g, np.int32(np.round(q - (x0, y0))), 1)
        g = cv2.erode(g, np.ones((5, 5), np.uint8)).astype(np.float32)
        c = clean[y0:y1, x0:x1]
        low = cv2.GaussianBlur(c, (0, 0), 6)
        valid = g * (1 - halo[y0:y1, x0:x1])
        lowf = _fill_holes(low, valid)
        hp = c - low
        hp *= 1 - 0.6 * cv2.GaussianBlur(logo[y0:y1, x0:x1].astype(np.float32), (0, 0), 2)[..., None]
        new = lowf * 0.9 + hp
        gm = cv2.GaussianBlur(g, (0, 0), 2.5)[..., None]
        clean[y0:y1, x0:x1] = c * (1 - gm) + new * gm
    clean = np.clip(clean, 0, 255)

    # --- depth masks (polygons snapped to image edges with a guided filter)
    gray = cv2.cvtColor(clean, cv2.COLOR_RGB2GRAY) / 255.0
    m_fg = _guided(gray, _poly_mask(POLY_FG, 1.2), 4, 2e-3)
    m_mid_full = _guided(gray, _poly_mask(POLY_MID, 1.2), 4, 2e-3)
    bg = _fill_holes(clean, np.clip(1 - (m_mid_full + m_fg) * 1.6, 0, 1))
    fgc = np.clip(m_fg * 1.6, 0, 1)
    mid = _fill_holes(clean, 1 - fgc)
    # where the foreground covers the monitors, the mid layer holds the hole-fill, not the plate's
    # keys / headset (otherwise they stay stuck to the monitor once the defocused fg slides off)
    wm = (m_mid_full * (1 - fgc))[..., None]
    mid = clean * wm + mid * (1 - wm)
    _S["L_bg"] = _upscale(bg)
    _S["L_mid"] = _premul_u8(_upscale(mid), m_mid_full)
    _S["L_fg"] = _premul_u8(_upscale(clean), m_fg)

    # --- light maps (plate space, quarter res for per-frame warps)
    q4 = (PW // 4, PH // 4)                 # quarter-res maps, in plate px coordinates
    qy = (np.arange(q4[1], dtype=np.float32)[:, None] + 0.5) * 4
    qx = (np.arange(q4[0], dtype=np.float32)[None, :] + 0.5) * 4
    gq = cv2.resize(glass.astype(np.float32), q4, interpolation=cv2.INTER_AREA)
    gsoft = cv2.GaussianBlur(gq, (0, 0), 1.5)
    tubes = [(1.0 / (1.0 + (_seg_dist(qx, qy, a, b) / R) ** 2) * (1 - gsoft)).astype(np.float32)
             for a, b, R in TUBES]                   # one light map per tube (independent flicker)
    neon = np.maximum(tubes[0], tubes[1])
    spill = cv2.GaussianBlur(gq * (qx > 600), (0, 0), 17.5)
    spill = spill / spill.max() * (1 - gsoft)
    _S["tube_q"], _S["spill_q"] = tubes, spill
    # haze volume: lit air in the right half / around the tubes, thin over the screens
    hv = np.clip(neon * 1.25, 0, 1) * (0.35 + 0.65 * np.clip((qx - 900) / 500, 0, 1))
    hv = np.maximum(hv, 0.25 * np.clip(1 - qy / 500, 0, 1))
    hv *= 1 - 0.7 * gsoft
    _S["haze_q"] = hv.astype(np.float32)
    _S["sold_q"] = np.exp(-(((qx - 1500) / 170) ** 2 + ((qy - 380) / 220) ** 2)).astype(np.float32)
    lq = cv2.resize(cv2.cvtColor(plate, cv2.COLOR_RGB2GRAY), q4, interpolation=cv2.INTER_AREA)
    lum = cv2.resize(cv2.GaussianBlur(lq, (0, 0), 6.25), (PW, PH), interpolation=cv2.INTER_LINEAR) / 255.0
    _S["lum"] = np.clip(lum / np.percentile(lq / 255.0, 99.5), 0, 1) ** 0.6

    # soldier rim: thin inner band of his (luminance-keyed, hole-filled) silhouette where the
    # air behind him is lit; cropped, plate px
    reg = _poly_mask([POLY_SOLDIER], 8.0)
    g1 = cv2.GaussianBlur(gray, (0, 0), 2.0)
    sil = np.clip((0.21 - g1) / 0.07, 0, 1) * reg
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    sil = cv2.morphologyEx(cv2.morphologyEx(sil, cv2.MORPH_OPEN, ker), cv2.MORPH_CLOSE, ker)
    bn = (sil > 0.5).astype(np.uint8)
    ff = np.pad(bn, 1)
    cv2.floodFill(ff, np.zeros((PH + 4, PW + 4), np.uint8), (0, 0), 2)
    holes = (ff[1:-1, 1:-1] == 0).astype(np.float32)                  # enclosed bright patches
    sil = np.maximum(sil, cv2.GaussianBlur(holes, (0, 0), 1.5))
    band = np.clip(sil - cv2.GaussianBlur(sil, (0, 0), 2.5), 0, 1)
    bgl = cv2.GaussianBlur(gray * (1 - sil), (0, 0), 6) / np.maximum(cv2.GaussianBlur(1 - sil, (0, 0), 6), 1e-3)
    rim = band * np.clip((bgl - 0.18) / 0.2, 0, 1) * reg * np.clip((548 - yy) / 30, 0, 1)
    rim *= 0.5 + 0.5 * np.clip((470 - yy) / 190, 0, 1)            # light from above: head/cap brightest
    rim *= 1 - np.clip((_poly_mask(POLY_FG, 1.2) + _poly_mask(POLY_MID, 1.2)) * 1.5, 0, 1)
    rim /= max(float(np.percentile(rim[rim > 0.01], 98)), 1e-3)
    ys_, xs_ = np.nonzero(rim > 0.01)
    rx0, ry0 = int(xs_.min()) - 4, int(ys_.min()) - 4
    rx1, ry1 = int(xs_.max()) + 5, int(ys_.max()) + 5
    _S["rim"] = (np.clip(rim[ry0:ry1, rx0:rx1], 0, 1.3).astype(np.float32), (rx0, ry0))

    # keyboard LEDs (FG emission), with a per-cluster flicker phase
    kb = ((plate[..., 1] > 110) & (plate[..., 1] - plate[..., 2] > 75) & (plate[..., 1] > plate[..., 0] * 1.1)
          & (yy > 760)).astype(np.float32)
    kb = cv2.GaussianBlur(kb, (0, 0), 1.2)
    _S["kb_led"] = cv2.resize(kb, (UW // 2, UH // 2), interpolation=cv2.INTER_AREA)

    # --- screens
    _S["H_main"], _S["H_top"], _S["H_bot"] = _quad_H(Q_MAIN), _quad_H(Q_TOP), _quad_H(Q_BOT)
    am, at, ab = _quad_aspect(Q_MAIN), _quad_aspect(Q_TOP), _quad_aspect(Q_BOT)
    _S["asp"] = (am, at, ab)
    _S["pg_main"] = _mips(_page_wordmark(2560, am, 0.87))
    _S["pg_top"] = _mips(_page_wordmark(1024, at, 0.80))
    _S["pg_bot"] = _mips(_page_wordmark(1024, ab, 0.78))
    _S["pg_icon"] = _mips(_page_icon(1024, at))
    _S["pg_ret"] = _mips(_page_reticle(1024))
    _S["pg_tag"] = _mips(_page_tagline(1024, ab))
    rng = np.random.default_rng(44)
    _S["snow"] = rng.random((360, 480)).astype(np.float32)

    # --- dust motes (plate space)
    N, NB = 200, 16                 # fine motes + a few near-lens bokeh discs (drift faster)
    near = np.arange(N + NB) >= N
    _S["dust"] = dict(x=rng.uniform(-80, PW + 80, N + NB), y=rng.uniform(-60, PH + 60, N + NB),
                      z=np.where(near, rng.uniform(0.70, 0.84, N + NB), rng.uniform(0.88, 1.7, N + NB)),
                      vx=np.where(near, rng.normal(-34, 10, N + NB), rng.normal(4, 5, N + NB)),
                      vy=np.where(near, rng.normal(-12, 7, N + NB), rng.normal(-5, 4, N + NB)),
                      ph=rng.uniform(0, 6.3, N + NB), fr=rng.uniform(0.8, 3.0, N + NB),
                      b=rng.uniform(0.35, 1.0, N + NB), near=near)
    return _S


# ---------------------------------------------------------------- timing curves
def _dolly(t):
    """Camera travel towards the main screen (layer scale = Z / (Z - D)).  The late term puts
    the main glass edges past the frame by ~4.80 s (s_mid ~3.3), ~4.6 at 4.87, ~8 at 4.93."""
    D = 0.024 * t
    if t > 3.6:
        x = (t - 3.6) / 1.4
        D += 0.85 * x ** 2.42
    return D


def _steps(t, seq, v0=1.0):
    n = v0
    for ts, v in seq:
        if t >= ts:
            n = v
    return n


_SEQ_BIG = [(0.00, 0.62), (0.05, 0.9), (0.09, 0.22), (0.17, 1.0), (0.23, 0.3), (0.27, 0.95),
            (0.43, 0.45), (0.47, 1.0), (0.66, 0.6), (0.69, 1.05), (1.0, 1.0),
            (2.20, 0.12), (2.27, 0.8), (2.31, 0.08), (2.43, 1.18), (3.20, 0.58), (3.237, 0.9), (3.27, 1.0)]
_SEQ_SMALL = [(0.00, 0.05), (0.08, 0.6), (0.12, 0.08), (0.24, 0.9), (0.34, 0.2), (0.38, 1.0),
              (0.55, 0.35), (0.6, 1.0), (1.0, 1.0),
              (1.60, 0.22), (1.633, 0.85), (1.667, 0.12), (1.70, 1.0),       # its own stutter
              (2.20, 0.06), (2.25, 0.55), (2.33, 0.04), (2.47, 1.15), (2.8, 1.0)]


def _neon(t, fi):
    """Levels of the (big top, small right) neon tubes; 1 = as in the plate.  Each has its own
    stutter; mains-hum shimmer (7 Hz + slow wander) instead of per-frame white noise."""
    out = []
    for k, seq in enumerate((_SEQ_BIG, _SEQ_SMALL)):
        n = _steps(t, seq)
        t_on = 2.43 if k == 0 else 2.47
        if t >= t_on:
            n = 1.0 + (0.18 if k == 0 else 0.12) * math.exp(-(t - t_on) * 5)
            if k == 0 and 3.20 <= t < 3.27:
                n = _steps(t, seq)
        if t >= 3.6:                                   # riser: the room surges, then recedes into the dive
            n = 1.0 + 0.2 * ease_in_cubic(prog(t, 3.6, 4.55))
        ph = 1.3 + 2.1 * k
        hum = (0.02 * math.sin(2 * math.pi * 7.0 * t + ph)
               + 0.018 * math.sin(2 * math.pi * 0.73 * t + 3 * ph) * math.sin(2 * math.pi * 1.9 * t + ph))
        out.append(n * (1 + hum))
    return out


def _smear(t):
    """Opening whip-pan settle (1 -> 0 over the first ~0.32 s)."""
    return (1 - prog(t, 0.0, 0.32)) ** 2.4


def _zb(t):
    """Radial zoom-blur amount on the dive: peaks as the bezel rushes past, eases inside."""
    return ease_in_cubic(prog(t, 4.42, 4.78)) * (1 - 0.6 * prog(t, 4.78, 4.85))


def _fl(t):
    """3-frame over-exposure ramp into scene 5 (1 on the last frame)."""
    return prog(t, 4.87, DUR - 1.0 / FPS)


def _camera(t):
    D = _dolly(t)
    tr = ease_in_out(prog(t, 0.0, 4.2))
    k = ease_in_out(prog(t, 3.85, 4.98))
    R = np.float32([(-RECT_W / 2, -RECT_H / 2), (RECT_W / 2, -RECT_H / 2), (RECT_W / 2, RECT_H / 2),
                    (-RECT_W / 2, RECT_H / 2)]) + F_MAIN
    Hs = cv2.getPerspectiveTransform(Q_MAIN, np.float32(Q_MAIN + (R - Q_MAIN) * k)).astype(np.float64)
    c = 0.3 * ease_in_out(prog(t, 0.0, 3.6)) + 0.7 * ease_in_out(prog(t, 3.5, 4.75))
    C = PC + (F_MAIN - PC) * c
    s_mid = Z_MID / max(Z_MID - D, 0.02)
    b = ease_in_out(prog(t, 4.5, 4.88))
    if b > 0:   # the dive homes in on the bullet's hot front: the last frames are the green bullet
        P = cv2.perspectiveTransform(np.float32([[_bullet_target()]]), Hs).reshape(2)
        C = C + b * (F_MAIN + s_mid * (P - F_MAIN) - C)
    zoom = 1.04
    sm = _smear(t)                                              # opening whip settle
    dx1, dy1, a1 = shake(t, 1.6, 2.1, seed=4)                   # handheld drift
    dx2, dy2, a2 = shake(t, 10, 41, seed=7, decay_from=2.2, decay=11)
    amp3 = 9 * ease_in_cubic(prog(t, 4.25, 5.0))
    dx3, dy3, a3 = shake(t, amp3, 33, seed=9)
    kx, ky = _KICK.get(int(round(t * FPS)), (0.0, 0.0))        # beep lock: 2-frame jolt
    dx, dy, ang = dx1 + dx2 + dx3 + kx, dy1 + dy2 + dy3 + ky, (a1 + a2 + a3) * 0.5
    Rr = np.vstack([cv2.getRotationMatrix2D((W / 2, H / 2), ang, 1.0), [0, 0, 1]])
    A = np.array([[S0 * zoom, 0, W / 2 - S0 * zoom * C[0] + dx], [0, S0 * zoom, H / 2 - S0 * zoom * C[1] + dy],
                  [0, 0, 1]], np.float64)
    mats, scales = {}, {}
    for name, Z, tx, ty, wm in (("bg", Z_BG, 12, -5, 0.8), ("mid", Z_MID, 0, 0, 1.0), ("fg", Z_FG, -26, 8, 1.35)):
        s = Z / max(Z - D, 0.02)
        mats[name] = _T(SLIDE * sm * wm, 0) @ Rr @ A @ _T(tx * tr, ty * tr) @ _Sc(s, *F_MAIN) @ Hs
        scales[name] = s
    kbar = 0.3 * ease_in_out(prog(t, 4.55, 4.90))            # full-frame barrel lens on the dive
    return dict(D=D, mats=mats, s=scales, smear=sm, Hs=Hs, A=_T(SLIDE * sm, 0) @ Rr @ A, tr=tr, kbar=kbar)


SLIDE = 660.0                                  # incoming whip slide (px), decays with _smear
_KICK = {30: (3.5, -2.5), 31: (-2.5, 1.5), 32: (1.0, -0.5)}


@lru_cache(maxsize=1)
def _bullet_target():
    """Plate point of the bullet's hot front on the main CRT (just behind the tip): wordmark
    pixel -> page uv -> tube coords (inverting the screen curvature) -> plate via H_main."""
    lay = load_layer("logo_wordmark")
    ys, xs = np.nonzero(lay[..., 3] > 0.02)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    asp = _quad_aspect(Q_MAIN)
    pw, width = 2560, 0.87                               # as _page_wordmark(2560, am, 0.87)
    ph = int(round(pw / asp))
    tw = int(pw * width)
    th = int(round((y1 - y0) * tw / (x1 - x0)))
    sc = tw / (x1 - x0)
    u = ((pw - tw) // 2 + (BULLET_PT[0] - x0) * sc) / pw
    v = (int(ph * 0.5 - th / 2) + (BULLET_PT[1] - y0) * sc) / ph
    c = np.array([2 * u - 1, 2 * v - 1])
    kb = 0.09                                           # main-tube curvature late in the dive
    s = c.copy()
    for _ in range(30):                                  # s * fac(|s|^2) = c
        s = c / ((1 + kb * (s @ s)) / ((1 + kb) * TUBE_GROW))
    return tuple(cv2.perspectiveTransform(np.float32([[(s + 1) / 2]]), _quad_H(Q_MAIN)).reshape(2))


BULLET_PT = (505, 190)                         # logo_wordmark px: bullet body just behind the tip


def _over_u8(f, lay, opacity=1.0, gain=1.0):
    """Composite a premultiplied uint8 RGBA layer over float frame f, in place (gain darkens)."""
    a = lay[..., 3].astype(np.float32)
    a *= opacity / 255.0
    f *= (1 - a)[..., None]
    if opacity * gain != 1:
        f += lay[..., :3].astype(np.float32) * (opacity * gain)
    else:
        f += lay[..., :3]


def _over8(base, lay, opacity=1.0):
    """uint8 'over' of a premultiplied RGBA layer onto an RGB base."""
    a, rgb = cv2.extractChannel(lay, 3), cv2.cvtColor(lay, cv2.COLOR_RGBA2RGB)
    if opacity < 1:
        a = cv2.convertScaleAbs(a, alpha=opacity)
        rgb = cv2.convertScaleAbs(rgb, alpha=opacity)
    inv = 255 - a
    return cv2.add(cv2.multiply(base, cv2.merge([inv, inv, inv]), scale=1 / 255.0), rgb)


def _warp(src, M, scale_src, border=cv2.BORDER_CONSTANT, out=1.0):
    Ms = np.diag([out, out, 1.0]) @ M @ np.diag([1.0 / scale_src, 1.0 / scale_src, 1.0])
    return cv2.warpPerspective(src, Ms, (int(W * out), int(H * out)), flags=cv2.INTER_LINEAR, borderMode=border)


def _warp_q(src, M, full=True):
    """Warp a quarter-res plate map to quarter-res output (optionally upsized to full res)."""
    Ms = np.diag([0.25, 0.25, 1.0]) @ M @ np.diag([4.0, 4.0, 1.0])
    q = cv2.warpPerspective(src, Ms, (W // 4, H // 4), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return cv2.resize(q, (W, H), interpolation=cv2.INTER_LINEAR) if full else q


# ---------------------------------------------------------------- CRT screen renderer
def _sample(mips, cu, cv, size_out_w, scale=1.0):
    """Sample a page pyramid at content coords (0..1) choosing the mip level (float32 * scale)."""
    pw = mips[0].shape[1]
    ratio = pw / max(size_out_w, 1.0)
    lvl = int(np.clip(math.floor(math.log2(max(ratio, 1.0)) - 0.3), 0, len(mips) - 1))
    tex = mips[lvl]
    th, tw = tex.shape[:2]
    mx = (cu * tw - 0.5).astype(np.float32)
    my = (cv * th - 0.5).astype(np.float32)
    r = cv2.remap(tex, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return np.multiply(r, np.float32(scale), dtype=np.float32)


@lru_cache(maxsize=256)
def _crt_tex(A, Ag, n=24):
    """One period of scanline (rows) x aperture-grille (cols) modulation, (n, n, 3).
    Three phosphor stripes per period separated by a dark matrix.  Green-dominant only (no
    per-primary hues): R and B dip deeper than G in the matrix and a little on the middle
    stripe, so the macro reads as mint stripes on a green-black grille, never cyan/yellow."""
    v = (np.arange(n, dtype=np.float32) + 0.5) / n
    scan = 1 - A * (0.5 + 0.5 * np.cos(v * 2 * math.pi))
    ph = v * 2 * math.pi
    m = 0.5 - 0.5 * np.cos(3 * ph)                          # 0 on stripe centres, 1 in the matrix
    wmid = 0.5 + 0.5 * np.cos(ph - 2.094)                    # the middle stripe of each triad
    lum = 1 - Ag * 0.6 * m
    a = Ag / 0.55
    gr = np.stack([lum * (1 - a * (0.03 + 0.26 * m + 0.05 * wmid)), lum,
                   lum * (1 - a * (0.05 + 0.29 * m + 0.05 * wmid))], -1)
    return (scan[:, None, None] * gr[None, :, :]).astype(np.float32)


def _blur_ds(img, sigma):
    """Gaussian blur, done on a downscaled copy when sigma is large."""
    if sigma <= 4:
        return cv2.GaussianBlur(img, (0, 0), sigma)
    sc = 4.0 / sigma
    h, w = img.shape[:2]
    small = cv2.resize(img, (max(2, int(w * sc)), max(2, int(h * sc))), interpolation=cv2.INTER_AREA)
    return cv2.resize(cv2.GaussianBlur(small, (0, 0), 4), (w, h), interpolation=cv2.INTER_LINEAR)


def _screen(f, Hq, M, asp, p, t, fi):
    """Render one CRT into frame f.  Hq: unit square -> plate; M: plate -> output.
    p: dict of per-frame parameters.  Returns the screen brightness."""
    Ho = M @ Hq
    cn = cv2.perspectiveTransform(np.float32([[[-0.03, -0.03]], [[1.03, -0.03]], [[1.03, 1.03]], [[-0.03, 1.03]]]),
                                  Ho).reshape(-1, 2)
    mid = cv2.perspectiveTransform(np.float32([[[0, .5]], [[1, .5]], [[.5, 0]], [[.5, 1]]]), Ho).reshape(-1, 2)
    sw = float(np.linalg.norm(mid[1] - mid[0]))              # tube size in output pixels
    sh = float(np.linalg.norm(mid[3] - mid[2]))
    gpad = int(10 + 0.12 * min(sh, 1000))
    x0, y0 = int(max(0, cn[:, 0].min() - gpad)), int(max(0, cn[:, 1].min() - gpad))
    x1, y1 = int(min(W, cn[:, 0].max() + gpad)), int(min(H, cn[:, 1].max() + gpad))
    bw, bh = x1 - x0, y1 - y0
    if bw < 4 or bh < 4:
        return 0.0
    # smooth maps on a coarse grid (step st px), upsampled (the mapping is smooth); content at full res
    st = 1 if bw * bh < 400000 else (2 if bw * bh < 1500000 else 3)
    ncw, nch = -(-bw // st), -(-bh // st)
    Hi = np.linalg.inv(Ho).astype(np.float32)
    X = (x0 + (np.arange(ncw, dtype=np.float32) + 0.5) * st - 0.5)[None, :]
    Y = (y0 + (np.arange(nch, dtype=np.float32) + 0.5) * st - 0.5)[:, None]
    den = Hi[2, 0] * X + Hi[2, 1] * Y + Hi[2, 2]
    cx = (Hi[0, 0] * X + Hi[0, 1] * Y + Hi[0, 2]) / den * 2 - 1
    cy = (Hi[1, 0] * X + Hi[1, 1] * Y + Hi[1, 2]) / den * 2 - 1
    r2 = cx * cx + cy * cy
    # CRT curvature, normalised so the tube boundary lands on the true glass edge (edge midpoints
    # at TUBE_GROW x the measured quad) instead of sitting inset inside it
    fac = (1 + p["kb"] * r2) * np.float32(1.0 / ((1 + p["kb"]) * TUBE_GROW))
    cx = cx * fac
    cy = cy * fac
    rr = 0.2                                                 # tube = rounded rect
    qx = np.abs(cx) * asp - (asp - rr)
    qy = np.abs(cy) - (1 - rr)
    d = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2) + np.minimum(np.maximum(qx, qy), 0) - rr
    pix = 2.0 / max(sh, 1.0)
    mask = np.clip(0.5 - d / (1.3 * pix), 0, 1)
    band = np.clip(0.5 - (d - 0.06) / (0.04 + 1.3 * pix), 0, 1) - mask    # leftover plate glass rim
    inner = np.clip(-d / 0.55, 0, 1)
    cv = (cy + 1) * 0.5
    db = np.mod(cv - p["bar_pos"] + 0.5, 1.0) - 0.5
    shade = (0.3 + 0.7 * (1 - (1 - inner) ** 2.2)) * (1 + np.exp(-(db / 0.085) ** 2) * p["bar"]) * p["bright"]
    basew = 0.35 + 1.4 * np.exp(-r2 * 1.3)
    if p["line"] > 0:   # lock flash: a thin hot retrace line across the tube (+ a soft skirt)
        dl = cv - 0.5
        basew = basew + p["line"] * (95.0 * np.exp(-(dl / (0.004 + 1.2 * pix)) ** 2)
                                     + 14.0 * np.exp(-(dl / 0.035) ** 2)) / max(p["base"][1], 1e-3)
    # what is left of the plate's own glass under the tube: darker towards the tube edge so the
    # plate's glass rim does not read as a second, inner border
    dim = 1 - mask * (1 - p["gdim"] * (0.4 + 0.6 * np.sqrt(inner))) - band * 0.5
    defer = p.get("defer", False)
    maps = [(cx + 1) * 0.5, cv, mask, shade, basew, dim]
    if defer:   # soft-edged mask for the deferred scanline/grille modulation (feathered inwards)
        maps.append(np.clip(-d / (pix * (1.3 + p["feather"])), 0, 1))
    mask_c = mask
    if st > 1:
        maps = [cv2.resize(m, (ncw * st, nch * st), interpolation=cv2.INTER_LINEAR)[:bh, :bw] for m in maps]
    cu, cv, mask, shade, basew, dim = maps[:6]
    # vertical roll + horizontal tearing / wobble
    cvr = np.mod(cv + p["roll"], 1.0) if p["roll"] else cv
    if p["tear"] > 0:
        rng = np.random.default_rng(p["seed"])
        nb = 26
        offs = (rng.normal(0, 1, nb) * (rng.random(nb) < 0.45)).astype(np.float32) * p["tear"]
        cu = cu + offs[np.clip((cvr * nb).astype(np.int32), 0, nb - 1)]
    if p["wob"] > 0:
        cu = cu + p["wob"] * np.sin(cvr * 37.0 + t * 23.0).astype(np.float32)
    # content pages (stored as emission / PGS)
    em = None
    for pg, gain, tf in p["pages"]:
        if gain <= 0:
            continue
        if tf is None:
            smp = _sample(pg, cu, cvr, sw, gain * PGS)
        else:  # square page placed/rotated in screen-height units
            ang, size = tf
            xs_ = (cu - 0.5) * asp
            ys_ = cvr - 0.5
            ca, sa = math.cos(ang), math.sin(ang)
            smp = _sample(pg, (xs_ * ca - ys_ * sa) / size + 0.5, (xs_ * sa + ys_ * ca) / size + 0.5, sh * size,
                          gain * PGS)
        em = smp if em is None else cv2.add(em, smp, dst=em)
    if em is None:
        em = np.zeros((bh, bw, 3), np.float32)
    # snow / static (cell size grows with the tube so it stays grain, not blobs, on the dive)
    sn = _S["snow"]
    rng = np.random.default_rng(7000 + fi * 3 + p["seed"] % 97)
    ox, oy = rng.integers(0, 480), rng.integers(0, 360)
    ks = np.float32(330 * max(1.0, sw / 900.0))
    snow = cv2.remap(sn, cu * ks + np.float32(ox), cvr * (ks / np.float32(asp)) + np.float32(oy),
                     cv2.INTER_NEAREST, borderMode=cv2.BORDER_WRAP)
    snow *= p["snow"] * 52
    if p["roll"]:  # blanking bar while out of hold
        bb = np.clip(np.abs(np.mod(cvr + 0.5, 1.0) - 0.5) / 0.04, 0, 1)
        shade *= 0.12 + 0.88 * bb
    shade *= mask
    em *= shade[..., None]                                   # content (logo pages)
    k = int(round(p["chroma"]))                              # green phosphor ghosting (no rainbow split)
    if k > 0:
        em = _ghost(em, k)
    # scanline / grille strength: as strong as the output pixel grid allows (grow on the dive)
    kt = p.get("tex_k", 1.0)
    A = 0.6 * clamp((sh / p["lines"] - 1.8) / 3.2) * kt
    Ag = 0.55 * clamp((sw / p["grille"] - 2.8) / 4.0) * kt
    # phosphor bleed (tight) + halo (wide), screen-blended: they light the dark glass around the
    # glyphs but do not over-drive the glyph cores (no flat clipped letter faces).  Both are
    # smooth, so for a big tube they are computed on the coarse grid and upsampled.
    gsig, hsig = min(max(1.2, 0.014 * sh), 22.0), min(0.08 * sh, 150.0)
    hk = (0.3 + 0.7 * mask_c) * np.float32(p["halo"])
    if st > 1:
        e = cv2.resize(em, (ncw, nch), interpolation=cv2.INTER_AREA)
        gsig, hsig = gsig / st, hsig / st
    else:
        e = em
    gl = _blur_ds(e, gsig)
    k3 = e * np.float32(-p["glow"] / 235.0)
    k3 += np.float32(p["glow"])
    np.maximum(k3, 0, out=k3)
    gl *= k3
    e2 = e + gl
    halo = _blur_ds(e2, hsig)
    k3 = e2 * np.float32(-1 / 250.0)
    k3 += 1
    np.maximum(k3, 0, out=k3)
    k3 *= hk[..., None]
    halo *= k3
    if st > 1:
        up = lambda x: cv2.resize(x, (ncw * st, nch * st), interpolation=cv2.INTER_LINEAR)[:bh, :bw]
        em += up(gl)
        halo = up(halo)
    else:
        em = e2
    # glass luminance (phosphor floor + static)
    basew *= np.float32(p["base"][1])
    basew += snow
    basew *= shade
    bv = np.float32(p["base"]) / max(p["base"][1], 1e-3)
    em += basew[..., None] * bv
    # scanlines (fixed on the tube) x aperture-grille triads, one periodic texture lookup, applied
    # AFTER the bleed so line structure shows inside bright glyphs.  On the dive it is deferred to
    # the full frame (applied after the radial zoom blur, see render) so it stays uniformly crisp.
    mod = None
    if A > 0.002 or Ag > 0.002:
        tex = _crt_tex(round(A, 3), round(Ag, 3))
        ty, tx = tex.shape[:2]
        mod = cv2.remap(tex, cu * np.float32(p["grille"] * tx), cv * np.float32(p["lines"] * ty),
                        cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
        if defer:
            mod -= 1
            mod *= maps[6][..., None]
            mod += 1
            _DEFER["mod"] = (y0, y1, x0, x1, mod)
        else:
            em *= mod
    if mod is not None and defer:   # the wide halo is added after the deferred modulation (as before)
        _DEFER["halo"] = (y0, y1, x0, x1, halo)
    else:
        em += halo
    reg = f[y0:y1, x0:x1]
    reg *= dim[..., None]
    reg += em
    return float(p["bright"])


_DEFER = {}


def _screen_params(t, fi, which):
    """Per-screen animation state."""
    lock = {"main": 1.0, "top": 1.07, "bot": 1.14}[which]
    seed = {"main": 11, "top": 23, "bot": 37}[which]
    main = which == "main"
    p = dict(kb=0.07, roll=0.0, tear=0.0, wob=0.0, bar=0.12, bar_pos=(t * 0.38 + seed * 0.1) % 1.0,
             lines=130 if main else 90, grille=240 if main else 200,
             bright=1.0, snow=0.16, base=(6, 11, 7), chroma=0, gdim=0.55, glow=0.5 if main else 0.6,
             halo=0.45 if main else 0.3, seed=seed * 1000 + fi, line=0.0)
    rng = np.random.default_rng(seed * 100 + fi)
    if t < lock:  # out of vertical hold, decelerating into lock
        x = lock - t
        p["roll"] = float((x ** 1.8) * (2.6 + 0.4 * (seed % 3)) + 0.13 * (seed % 5)) % 1.0
        if x < 0.03:
            p["roll"] = 0.0
        p["bright"] = (0.62 + 0.1 * rng.random()) * (1 + 0.5 * _smear(t))   # carry s3's bright exit
        p["snow"] = 0.55
        p["wob"] = 0.006 * min(1, x * 3)
        p["tear"] = 0.015 * (rng.random() < 0.4)
    else:  # lock pop on the beep: a glow surge more than a core over-drive
        x = t - lock
        pop = math.exp(-x * 9)
        p["bright"] = 1.0 + 0.3 * pop + 0.025 * rng.normal()
        p["halo"] += 0.9 * pop
        p["glow"] += 0.5 * pop
        p["roll"] = float(-0.035 * math.exp(-x * 14) * math.sin(x * 60)) % 1.0 if x < 0.3 else 0.0
        if abs(p["roll"] - 1.0) < 1e-6:
            p["roll"] = 0.0
        p["wob"] = 0.0025 * math.exp(-x * 10)
        if x < 1.0 / FPS:                                       # the lock frame itself: hard hit
            p["bright"] *= 1.5
        if x < 0.16:                                            # hot retrace line, gone in ~4 frames
            p["line"] = math.exp(-x * 22) * (1.0 if main else 0.6)
    # glitch at 2.2
    g = prog(t, 2.2, 2.45)
    if 0 < g < 1:
        burst = rng.random() < 0.8
        p["tear"] = 0.06 * burst
        p["chroma"] = 6 if main else 3
        p["bright"] *= 0.55 + 0.6 * rng.random()
        p["snow"] = 0.6
        if rng.random() < 0.35:
            p["roll"] = float(rng.uniform(0.05, 0.3))
    # micro-glitches (one-to-two frame tears)
    if (main and (1.62 <= t < 1.69 or 3.05 <= t < 3.1)) or \
            (which == "top" and (1.84 <= t < 1.9 or 3.9 <= t < 3.94)) or (which == "bot" and 3.28 <= t < 3.34):
        p["tear"] = 0.02
        p["chroma"] = 3
        p["bright"] *= 0.85
    # riser / dive heat
    h = ease_in_cubic(prog(t, 3.6, 5.0))
    if main:
        inside = ease_in_out(prog(t, 4.6, 4.82))               # camera about to pass the glass
        p["bright"] *= 1 + 0.06 * h
        p["bar"] = 0.12 + 0.3 * h
        p["bar_pos"] = (t * (0.38 + 1.6 * h) + 1.1) % 1.0
        p["kb"] = 0.07 + 0.03 * h                              # the lens bend is done full-frame
        hot = ease_in_cubic(prog(t, 4.8, 5.0))
        p["bright"] *= 1 + 0.35 * hot
        p["base"] = tuple(np.float32(p["base"]) + np.float32((30, 62, 22)) * (0.1 * h + 0.5 * inside + 1.2 * hot))
        p["glow"] = (0.5 + 0.15 * h) * (1 - 0.55 * inside)    # hard oversized phosphor shapes inside
        p["halo"] = (0.45 + 0.15 * h) * (1 - 0.7 * inside)
        p["chroma"] = max(p["chroma"], int(round(3 * h * (1 - inside))))
        p["gdim"] = (0.5 - 0.3 * h) * (1 - 0.85 * inside)
        p["snow"] += 0.25 * h
        if 4.0 <= t:
            p["tear"] = max(p["tear"], 0.012 * h * (rng.random() < 0.3))
        if t >= 4.42:   # scanlines/grille go full-frame (after the zoom blur); fade under the flash
            zb = _zb(t)
            p["defer"] = True
            p["feather"] = 70.0 * zb
            p["tex_k"] = (1 - 0.45 * zb) * (1 - hot) * (1 - _fl(t) ** 1.5)
    # pages
    S = _S
    if main:
        p["pages"] = [(S["pg_main"], 1.0, None)]
    elif which == "top":
        sw_ = prog(t, 2.32, 2.36)
        ang = -0.6 * (1 - ease_out_cubic(prog(t, 2.32, 3.2))) + 0.08 * math.sin(t * 2.0)
        size = 0.95 + 0.25 * (1 - ease_out_cubic(prog(t, 2.32, 2.9)))
        p["pages"] = [(S["pg_top"], 1 - sw_, None), (S["pg_icon"], sw_, None),
                      (S["pg_ret"], sw_ * 0.9, (ang, size))]
    else:
        sw_ = prog(t, 2.36, 2.40)
        p["pages"] = [(S["pg_bot"], 1 - sw_, None), (S["pg_tag"], sw_, None)]
    return p


# ---------------------------------------------------------------- render
def _bloom(f, thr=188.0, sigma=26.0, strength=0.62):
    """Cheap full-frame bloom (threshold at half res, blur at quarter res), in place."""
    half = cv2.resize(f, (W // 2, H // 2), interpolation=cv2.INTER_AREA)
    half -= thr
    np.maximum(half, 0, out=half)
    q = cv2.resize(half, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    q = cv2.GaussianBlur(q, (0, 0), sigma / 4) * strength
    f += cv2.resize(q, (W, H), interpolation=cv2.INTER_LINEAR)
    return f


_BAR = {}


def _barrel(f, k):
    """Full-frame barrel lens (centre magnified by 1+k, corners fixed: never samples outside)."""
    if not _BAR:
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        dx, dy = xx - (W - 1) / 2, yy - (H - 1) / 2
        _BAR.update(dx=dx, dy=dy, r2=(dx * dx + dy * dy) / np.float32((W / 2) ** 2 + (H / 2) ** 2))
    g = _BAR["r2"] * np.float32(k / (1 + k))
    g += np.float32(1 / (1 + k))
    mx = _BAR["dx"] * g
    mx += (W - 1) / 2
    g *= _BAR["dy"]
    g += (H - 1) / 2
    return cv2.remap(f, mx, g, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def _zoom_blur(f, a):
    """Radial zoom blur: 3 iterative 2-tap passes at doubling scale steps = 8 even taps."""
    for st in (a, 2 * a, 4 * a):
        Mz = cv2.getRotationMatrix2D((W / 2, H / 2), 0, 1 + st)
        g = cv2.warpAffine(f, Mz, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        f += g
        f *= 0.5
    return f


def render(t, ctx):
    t = float(t)
    S = _prep()
    fi = int(round(t * FPS))
    cam = _camera(t)
    Mb, Mm, Mf = cam["mats"]["bg"], cam["mats"]["mid"], cam["mats"]["fg"]
    n0, n1 = _neon(t, fi)
    nmix = 0.65 * n0 + 0.35 * n1
    hw, hh = W // 4, H // 4
    dive = ease_in_out(prog(t, 4.35, 4.8))           # the room recedes as the tube takes over
    _DEFER.clear()
    # soldier's lenses ignite when the light comes back after the glitch
    eye_on = 0.0
    if t >= 2.46:
        e = t - 2.46
        eye_on = (0.0 if 0.06 < e < 0.12 else 1.0) * (0.75 + 0.25 * math.sin(t * 7.3)) * min(1, e * 10)
    elif t < 2.2:
        eye_on = 0.18
    eye_on *= 1 - dive

    # --- plate layers: far (wall, tubes, soldier) + monitors
    bg8 = _warp(S["L_bg"], Mb, U, cv2.BORDER_REPLICATE)
    if dive > 0:
        bg8 = cv2.convertScaleAbs(bg8, alpha=1 - 0.6 * dive)
    # green rim on the soldier's silhouette (backlit by the tubes), emerging with the veil lift;
    # added to the far layer so the monitors / radio in front occlude it
    rk = eye_on * (0.55 * n0 + 0.45 * n1) * (0.3 + 0.7 * ease_out_cubic(prog(t, 2.3, 3.6)))
    if rk > 0.01:
        _rim(bg8, Mb, rk)
    mid8 = _warp(S["L_mid"], Mm, U)
    base8 = _over8(bg8, mid8)
    # foreground (desk, keyboard, headset): composited before the screens (no overlap with the
    # glass) except during the opening whip, where its larger smear offset could cover one, and
    # while it sweeps past the lens defocused (it may then pass in front of a screen)
    s_fg = cam["s"]["fg"]
    fga = 1 - prog(s_fg, 2.1, 3.4)
    fdef = clamp((s_fg - 1.18) / 0.9) ** 1.3                    # near-lens defocus + darkening
    fg_late = cam["smear"] > 0.01 or fdef > 0.02
    if fga > 0 and not fg_late:
        base8 = _over8(base8, _warp(S["L_fg"], Mf, U), fga)
    f = base8.astype(np.float32)

    # --- live CRT screens
    bmain = 1.0
    for which, Hq, asp in (("top", S["H_top"], S["asp"][1]), ("bot", S["H_bot"], S["asp"][2]),
                           ("main", S["H_main"], S["asp"][0])):
        b = _screen(f, Hq, Mm, asp, _screen_params(t, fi, which), t, fi)
        if which == "main":
            bmain = b

    if fga > 0 and fg_late:
        fgl = _warp(S["L_fg"], Mf, U)
        if fdef > 0.02:
            fgl = _blur_ds(fgl, 1.0 + 30.0 * fdef)
        _over_u8(f, fgl, fga, 1 - 0.5 * fdef)

    # --- room light (per-tube neon levels, screen spill), haze and light shafts: quarter-res maps
    L0 = _warp_q(S["tube_q"][0], Mb, full=False)
    L1 = _warp_q(S["tube_q"][1], Mb, full=False)
    mult = None
    for L, nn, ex in ((L0, n0, 0.5), (L1, n1, 1.4)):   # the small tube only lights its own corner
        m = 1 - (1 - nn) * 0.9 * (L ** ex) if nn < 1.0 else 1 + (nn - 1) * 0.9 * L
        mult = m if mult is None else mult * m
    np.maximum(mult, 0.04, out=mult)
    Lsp = _warp_q(S["spill_q"], Mm, full=False)
    mult *= 1 + Lsp * ((bmain - 1.0) * 0.55)
    fld = smoke_field(W // 2, H // 2, 3)          # 1080x1920 noise
    vol = _warp_q(S["haze_q"], Mb, full=False)
    sol = _warp_q(S["sold_q"], Mb, full=False)
    acc = np.zeros((hh, hw), np.float32)
    for sp, sc, ofs, wgt in (((-30, -8), 1.0, (700, 300), 0.7), ((-55, 5), 0.6, (300, 420), 0.55)):
        k = 2.0 * sc
        Mn = np.float32([[k, 0, ofs[0] + t * sp[0] * 0.5 / sc], [0, k, ofs[1] + t * sp[1] * 0.5 / sc]])
        crop = cv2.warpAffine(fld, Mn, (hw, hh), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                              borderMode=cv2.BORDER_REFLECT)
        acc += np.clip((crop - 0.38) * 2.0, 0, 1) * wgt
    sold_h = 1.05 - 0.9 * ease_out_cubic(prog(t, 2.3, 3.6))      # veil hiding the soldier lifts
    hz = acc * vol * (0.55 + 0.45 * min(nmix, 1.3)) + sol * (sold_h * (0.45 + 0.55 * acc))
    hz *= 1 - 0.85 * prog(t, 4.35, 4.8)
    mult *= 1 - 0.19 * hz
    add = hz[..., None] * (np.float32((92, 138, 52)) * 0.55)
    ga = 1 - prog(t, 4.3, 4.7)
    if ga > 0:  # shafts from the big tube: screen-space radial blur of the lit air
        fq = cv2.resize(f, (hw, hh), interpolation=cv2.INTER_AREA)
        src = np.clip(fq[..., 1] * mult + add[..., 1] - 75, 0, None) * L0 * (0.3 + acc * 0.9)
        c = cv2.perspectiveTransform(np.float32([[TUBE_C]]), Mb).reshape(2) / 4
        racc = src.copy()
        for i in range(1, 8):
            Mz = cv2.getRotationMatrix2D((float(c[0]), float(c[1])), 0, 1 + 0.07 * i)
            racc += cv2.warpAffine(src, Mz, (hw, hh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
        add += racc[..., None] * (np.float32((0.42, 0.75, 0.26)) * (0.55 / 8) * ga * min(n0, 1.3))
    f *= cv2.resize(mult, (W, H), interpolation=cv2.INTER_LINEAR)[..., None]
    # additive light at half res: haze + shafts, keyboard LED flicker, dust motes
    addh = cv2.resize(add, (W // 2, H // 2), interpolation=cv2.INTER_LINEAR)
    if fga > 0:
        led = _warp(S["kb_led"], Mf, U / 2, out=0.5)
        if fdef > 0.02:
            led = _blur_ds(led, 0.5 + 15.0 * fdef)
        rng = np.random.default_rng(300 + fi // 2)
        grid = cv2.resize(rng.random((3, 6)).astype(np.float32), (W // 2, H // 2), interpolation=cv2.INTER_LINEAR)
        grid *= 0.9
        grid += 0.35 - 0.55 if not (2.2 <= t < 2.42) else -0.45
        led *= grid
        led *= fga * (1 - 0.4 * fdef)
        addh += led[..., None] * np.float32((110, 200, 60))
    fine, bokeh = _dust(t, cam, 0.3 + 0.7 * min(nmix, 1.0))
    addh += fine[..., None] * np.float32((205, 235, 170))
    if bokeh is not None:   # near-lens discs: only where the air is lit, tinted by the neon
        lit = cv2.resize(vol, (W // 2, H // 2), interpolation=cv2.INTER_LINEAR)
        lit *= 1.8 * min(n0, 1.2)
        np.minimum(lit, 1.0, out=lit)
        bokeh *= lit
        addh += bokeh[..., None] * np.float32((120, 200, 70))
    f += cv2.resize(addh, (W, H), interpolation=cv2.INTER_LINEAR)

    # --- soldier's lenses ignite when the light comes back after the glitch
    if eye_on > 0:   # two lens cores along the goggle band + soft bloom + thin anamorphic glint
        ep = cv2.perspectiveTransform(np.float32([[EYE], [LENS[0]], [LENS[1]]]), Mb).reshape(-1, 2)
        sc = cam["s"]["bg"] * S0
        _sprite(f, ep[1, 0], ep[1, 1], 4.5 * sc, np.float32((150, 255, 90)) * 1.35 * eye_on)
        _sprite(f, ep[2, 0], ep[2, 1], 3.5 * sc, np.float32((150, 255, 90)) * 1.0 * eye_on)
        _sprite(f, ep[0, 0], ep[0, 1], 26 * sc, np.float32((70, 140, 30)) * 0.55 * eye_on)
        _sprite(f, ep[0, 0], ep[0, 1], 70 * sc, np.float32((90, 170, 50)) * 0.32 * eye_on ** 2, ry=1.3 * sc)
    # power LEDs on the monitors
    for i, (lx, ly, lsz) in enumerate(LEDS_MID):
        blink = 1.0 if ((fi + i * 7) // (9 + i * 4)) % 5 != 0 else 0.25
        if 2.2 <= t < 2.42:
            blink = 0.0
        lp = cv2.perspectiveTransform(np.float32([[(lx, ly)]]), Mm).reshape(2)
        _sprite(f, lp[0], lp[1], 9 * lsz * cam["s"]["mid"], np.float32((120, 230, 60)) * 0.9 * blink)

    # --- finish
    np.maximum(f, 0, out=f)
    inside = ease_in_out(prog(t, 4.6, 4.82))
    bstr = 0.6 * (1 - 0.65 * inside)
    dm = _DEFER.pop("mod", None)
    if dm is None:
        f = _bloom(_softclip(f), strength=bstr)

    sm = cam["smear"]                  # whip-pan settle: horizontal smear
    if sm > 0.01:
        f *= 1 + 0.75 * sm ** 1.5      # exposure still adapted to scene 3's bright exit
    if fi < 3:                         # carry scene 3's green exit streaks through the cut
        br = (1 - fi / 3.0) ** 1.5
        f += _bridge(-140.0 - 300.0 * fi)[..., None] * (GREEN * (1.25 * br))   # keeps travelling left
    if sm > 0.01:
        k = int(1 + 420 * sm)
        f = cv2.blur(f, (k, 1))
        f = cv2.blur(f, (max(1, k // 2), 1))

    # dive: radial zoom blur peaks while the bezel rushes past, eases once inside the tube so the
    # fat scanlines / triads read
    zb = _zb(t)
    if zb > 0.01:
        f = _zoom_blur(f, 0.0105 * zb)
    if dm is not None:   # main-tube scanlines/grille, applied after the zoom blur (uniformly crisp)
        # and before the highlight roll-off / bloom (the camera response sees the phosphor pattern)
        y0, y1, x0, x1, mod = dm
        if (y0, y1, x0, x1) == (0, H, 0, W):
            Mod = mod
        else:
            Mod = np.ones((H, W, 3), np.float32)
            Mod[y0:y1, x0:x1] = mod
        # pre-compensate build.post's lateral chroma (R +2 px, B -2 px) so the stripes stay
        # aligned across channels (no cyan/yellow fringes on the macro grille)
        Mod[:, :-POST_CHROMA, 0] = Mod[:, POST_CHROMA:, 0]
        Mod[:, POST_CHROMA:, 2] = Mod[:, :-POST_CHROMA, 2]
        f *= Mod
        y0, y1, x0, x1, halo = _DEFER.pop("halo")
        f[y0:y1, x0:x1] += halo
        f = _bloom(_softclip(f), strength=bstr)
    if cam["kbar"] > 0.002:
        f = _barrel(f, cam["kbar"])

    gseq = {66: 0.35, 67: 0.12, 69: 0.45, 70: 0.2, 72: 0.15}   # full-frame glitch burst
    if fi in gseq:
        f = _glitch(f, gseq[fi], 4400 + fi)
    f = _ceil(f)                       # disciplined highlights: only the final flash may blow out

    fl = _fl(t)                        # 3-frame over-exposure ramp into scene 5
    if fl > 0:
        f *= (1 + 5.5 * fl ** 2.2) * _FLASH_C
        f = _softclip(f, 200.0)
        wf = clamp((fl - 0.75) / 0.25)
        if wf > 0:                     # last frame: no residual grille / letter-block edges
            bl = _blur_ds(f, 40.0)
            bl -= f
            bl *= wf
            f += bl
        f = flash(f, 0.86 * fl ** 3, np.float32((226, 255, 200)))
    return np.clip(f, 0, 255, out=f)


def _ceil(f, knee=206.0, top=241.0):
    """Max-channel highlight roll-off to `top` (hue preserving), in place."""
    m = cv2.max(cv2.max(cv2.extractChannel(f, 0), cv2.extractChannel(f, 1)), cv2.extractChannel(f, 2))
    rows = np.nonzero(m.max(1) > knee)[0]
    if not len(rows):
        return f
    r0, r1 = rows[0], rows[-1] + 1
    m = m[r0:r1]
    x = m - knee
    np.maximum(x, 0, out=x)
    x *= 1.0 / (top - knee)
    k = np.tanh(x)
    k *= top - knee
    k += knee
    k /= np.maximum(m, knee)
    f[r0:r1] *= k[..., None]
    return f


_FLASH_C = np.float32((0.95, 1.0, 0.9))
_GH_A = np.float32((0.13, 0.19, 0.10))
_GH_B = np.float32((0.07, 0.09, 0.06))


def _ghost(img, k):
    """Offset green ghosts left/right of bright content (on-palette chroma)."""
    ch = list(cv2.split(img))
    for c in range(3):
        ker = np.zeros((1, 2 * k + 1), np.float32)
        ker[0, 0], ker[0, k], ker[0, 2 * k] = _GH_A[c], 0.78, _GH_B[c]
        ch[c] = cv2.filter2D(ch[c], -1, ker, borderType=cv2.BORDER_REPLICATE)
    return cv2.merge(ch)


def _softclip(f, knee=205.0):
    """Roll highlights off towards 255, hue preserving, in place.  The green channel is used
    as the max-channel proxy (it is the max everywhere in this palette)."""
    g = cv2.extractChannel(f, 1)
    rows = np.nonzero(g.max(1) > knee)[0]
    if not len(rows):
        return f
    r0, r1 = rows[0], rows[-1] + 1
    g = g[r0:r1]
    x = g - knee
    np.maximum(x, 0, out=x)
    x *= 1.0 / (255 - knee)
    k = np.tanh(x)
    k *= 255 - knee
    k += knee
    k /= np.maximum(g, knee)
    f[r0:r1] *= k[..., None]
    return f


def _glitch(f, amt, seed):
    """Slice displacement + green-tinted bands + chroma (no inverted/white slices)."""
    rng = np.random.default_rng(seed)
    o = f.copy()
    for _ in range(int(4 + amt * 14)):
        y = int(rng.integers(0, H - 8))
        h = int(rng.integers(2, int(10 + 60 * amt)))
        o[y:y + h] = np.roll(f[y:y + h], int(rng.normal(0, 90 * amt)), axis=1)
        if rng.random() < 0.2:
            o[y:y + h] = o[y:y + h] * 0.6 + GREEN * 0.22
    return _ghost(o, int(4 + 12 * amt))


_SPR = {}


def _rim(bg8, Mb, k):
    """Add the soldier's green rim light into the warped far layer (uint8, in place)."""
    rim, (rx0, ry0) = _S["rim"]
    rh, rw = rim.shape
    cn = cv2.perspectiveTransform(np.float32([[(rx0, ry0)], [(rx0 + rw, ry0)], [(rx0 + rw, ry0 + rh)],
                                              [(rx0, ry0 + rh)]]), Mb).reshape(-1, 2)
    x0, y0 = int(max(0, cn[:, 0].min() - 2)), int(max(0, cn[:, 1].min() - 2))
    x1, y1 = int(min(W, cn[:, 0].max() + 3)), int(min(H, cn[:, 1].max() + 3))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    Mc = _T(-x0, -y0) @ Mb @ _T(rx0, ry0)
    r = cv2.warpPerspective(rim, Mc, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR)
    r = r + 0.6 * cv2.GaussianBlur(r, (0, 0), 3.0)                  # thin core + a little wrap
    reg = bg8[y0:y1, x0:x1]
    cv2.add(reg, cv2.convertScaleAbs(r[..., None] * (GREEN * (0.8 * k))), dst=reg)


@lru_cache(maxsize=1)
def _bridge_base():
    """Half-res horizontal green streak field echoing scene 3's exit smear: (y, sigma_y, amp,
    x0, x1) per streak, soft-ended along x, brightest towards the left like s3's last frame."""
    h, w = H // 2, W // 2
    y = np.arange(h, dtype=np.float32)[:, None] * 2
    x = np.arange(w, dtype=np.float32)[None, :] * 2
    out = np.zeros((h, w), np.float32)
    for yc, sy, amp, xa, xb in ((238, 3.0, 1.0, 140, 1080), (424, 2.2, 0.45, 380, 980), (180, 2.0, 0.3, 600, 1300),
                                (715, 48, 0.5, -200, 1180), (860, 30, 0.38, -200, 760), (905, 2.5, 0.35, 500, 1250)):
        u = np.clip((x - xa) / (xb - xa), 0, 1)
        prof = np.maximum(np.sin(np.pi * u), 0) ** 0.7 * (1 - 0.5 * u)                 # soft ends, hotter at the left
        out += amp * np.exp(-((y - yc) / sy) ** 2) * prof
    return out


def _bridge(ofs):
    """Bridge streaks at full res, shifted horizontally by ofs px (negative = left)."""
    b = _bridge_base()
    k = int(round(ofs / 2))
    if k:
        b = np.roll(b, k, 1)
        if k > 0:
            b[:, :k] = 0
        else:
            b[:, k:] = 0
    return cv2.resize(b, (W, H), interpolation=cv2.INTER_LINEAR)


def _sprite(f, x, y, r, col, ry=None):
    """Additive soft glow dot (or horizontal ellipse / anamorphic streak when ry < r)."""
    r = max(1.0, float(r))
    ry = r if ry is None else max(0.7, float(ry))
    R, Ry = int(r * 3) + 1, int(ry * 3) + 1
    x0, y0 = int(x) - R, int(y) - Ry
    key = (R, Ry, round(x - int(x), 1), round(y - int(y), 1), round(r, 1), round(ry, 1))
    g = _SPR.get(key)
    if g is None:
        yy, xx = np.mgrid[0:2 * Ry + 1, 0:2 * R + 1].astype(np.float32)
        g = np.exp(-(xx - R - (x - int(x))) ** 2 / (2 * r * r) - (yy - Ry - (y - int(y))) ** 2 / (2 * ry * ry))
        if len(_SPR) < 500:
            _SPR[key] = g
    lay = np.dstack([g[..., None] * col[None, None, :], np.ones(g.shape, np.float32)])
    over(f, lay, x0, y0, 1.0, "add")


def _dust(t, cam, gain=1.0):
    """Dust motes catching the light: half-res additive intensity maps (fine motes, near-lens
    bokeh discs; the caller gates the bokeh by the lit-air volume)."""
    d = _S["dust"]
    D = cam["D"]
    z = d["z"]
    alive = z - D > 0.08
    s = z / np.maximum(z - D, 0.08)
    x = d["x"] + d["vx"] * t + 6 * np.sin(t * d["fr"] + d["ph"])
    y = d["y"] + d["vy"] * t + 5 * np.cos(t * d["fr"] * 0.7 + d["ph"])
    pts = np.stack([x, y], 1).astype(np.float32)[:, None, :]
    pts = cv2.perspectiveTransform(pts, cam["Hs"]).reshape(-1, 2)
    pts = F_MAIN + (pts - F_MAIN) * s[:, None]
    pts[:, 0] += (1.0 / z - 1.0) * -16 * cam["tr"]          # parallax truck vs the monitor plane
    o = cv2.perspectiveTransform(pts[:, None, :].astype(np.float32), cam["A"]).reshape(-1, 2) * 0.5
    lum = _S["lum"]
    light = lum[np.clip(y.astype(int), 0, PH - 1), np.clip(x.astype(int), 0, PW - 1)]
    tw = 0.55 + 0.45 * np.sin(t * d["fr"] * 2.1 + d["ph"] * 3)
    val = np.minimum(d["b"] * (0.25 + 2.4 * light) * tw * gain, 1.1)
    fine = np.zeros((H // 2, W // 2), np.float32)
    bokeh = None
    for i in np.nonzero(alive & (o[:, 0] > -60) & (o[:, 0] < W // 2 + 60) & (o[:, 1] > -60) & (o[:, 1] < H // 2 + 60))[0]:
        px, py = o[i]
        if d["near"][i]:  # near the lens: big, faint, out-of-focus disc
            if bokeh is None:
                bokeh = np.zeros((H // 2, W // 2), np.float32)
            r = min(16 + 14 * (s[i] - 1) + 60 * (0.84 - z[i]), 60) * 0.5
            cv2.circle(bokeh, (int(px * 16), int(py * 16)), int(r * 16), float(0.07 + 0.08 * d["b"][i] * tw[i]),
                       -1, cv2.LINE_AA, shift=4)
        else:
            r = (1.1 + 1.9 * (1.7 - z[i])) * s[i] * 0.5
            cv2.circle(fine, (int(px * 16), int(py * 16)), max(8, int(r * 16)), float(val[i]), -1, cv2.LINE_AA, shift=4)
    if bokeh is not None:
        bokeh = cv2.GaussianBlur(bokeh, (0, 0), 2.0)
    return fine, bokeh
