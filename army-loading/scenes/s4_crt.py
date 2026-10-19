"""Scene 4 - CRT room plate (client image), alive: dolly push-in with parallax
layers, neon flicker, live CRT screens, haze, dust, then a dive into the main
screen ending on a white-green flash.

Beats (local s):
  0.00-0.28  whip-pan smear from scene 3 settles (content slides in from right)
  0.25-0.75  neon tubes stutter on (hum)
  0.00-1.00  CRTs out of vertical hold (rolling), lock on the beep at 1.0
  2.20       glitch: neon cut, screens tear, small screens change feed
  3.60       riser: dolly accelerates, screens heat up
  4.60-5.00  dive through the main screen glass -> white/green flash
"""
from lib import *

DUR = 5.0
CUES = [(0.0, "hum"), (1.0, "beep"), (2.2, "glitch"), (3.6, "riser"), (4.6, "whoosh")]

PLATE = os.path.join(ASSETS, "crt_room.webp")
PW, PH = 1672, 941
S0 = W / PW                     # plate -> output base scale
U = 1.5                         # pre-upscale of plate layers (quality headroom for the push)
UW, UH = int(round(PW * U)), int(round(PH * U))

# Measured CRT glass quads in plate px (TL, TR, BR, BL) - extrapolated corners
# of the rounded glass.
Q_MAIN = np.float32([(700, 182), (1209, 246), (1197, 632), (681, 592)])
Q_TOP = np.float32([(243, 88), (474, 131), (467, 307), (229, 258)])
Q_BOT = np.float32([(210, 334), (481, 384), (474, 552), (200, 528)])
F_MAIN = Q_MAIN.mean(0)         # dolly target (main screen centre)

# depth of each layer (camera-distance units, main monitor = 1)
Z_BG, Z_MID, Z_FG = 1.65, 1.0, 0.62

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


def _poly_mask(polys, feather=2.0):
    m = np.zeros((PH, PW), np.uint8)
    for p in polys:
        cv2.fillPoly(m, [np.int32(np.round(np.float32(p) * 4))], 255, cv2.LINE_AA, shift=2)
    m = m.astype(np.float32) / 255.0
    return cv2.GaussianBlur(m, (0, 0), feather) if feather > 0 else m


def _fill_holes(img, valid):
    """Push-pull fill: replace pixels where valid~0 by smooth extension of the rest."""
    levels = []
    im, m = img * valid[..., None], valid.copy()
    while min(im.shape[:2]) > 8:
        levels.append((im, m))
        h, w = im.shape[:2]
        im = cv2.resize(im, (max(1, w // 2), max(1, h // 2)), interpolation=cv2.INTER_AREA)
        m = cv2.resize(m, (max(1, w // 2), max(1, h // 2)), interpolation=cv2.INTER_AREA)
    cur = im / np.maximum(m, 1e-4)[..., None]
    for im_l, m_l in reversed(levels):
        h, w = im_l.shape[:2]
        up = cv2.resize(cur, (w, h), interpolation=cv2.INTER_LINEAR)
        mm = np.clip(m_l * 1.6, 0, 1)[..., None]
        cur = np.where(m_l[..., None] > 1e-4, im_l / np.maximum(m_l, 1e-4)[..., None], up) * mm + up * (1 - mm)
    return cur


def _quad_H(q):
    """Homography unit square (u,v) -> plate quad."""
    return cv2.getPerspectiveTransform(np.float32([(0, 0), (1, 0), (1, 1), (0, 1)]), np.float32(q))


def _upscale(img):
    up = cv2.resize(img, (UW, UH), interpolation=cv2.INTER_LANCZOS4)
    bl = cv2.GaussianBlur(up, (0, 0), 1.3)
    return up + (up - bl) * 0.55


def _prep():
    if _S:
        return _S
    from PIL import Image as _Im
    plate = np.asarray(_Im.open(PLATE).convert("RGB"), np.float32)
    # --- remove the baked logos from the three screens (keep the burn-in halo)
    p8 = np.clip(plate, 0, 255).astype(np.uint8)
    mn = plate.min(2)
    gch = plate[..., 1] - plate[..., 2]
    logo = ((mn > 150) | ((plate[..., 1] > 140) & (gch > 70))).astype(np.uint8)
    glass = np.zeros((PH, PW), np.uint8)
    for q in (Q_MAIN, Q_TOP, Q_BOT):
        cv2.fillConvexPoly(glass, np.int32(q), 1)
    logo &= glass
    n, lab, st, _ = cv2.connectedComponentsWithStats(logo, 8)
    keep = np.zeros(n, np.uint8)
    keep[1:] = st[1:, cv2.CC_STAT_AREA] > 40
    logo = keep[lab]
    logo = cv2.dilate(logo, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    clean = cv2.inpaint(p8, logo * 255, 6, cv2.INPAINT_TELEA).astype(np.float32)
    # soften the inpainted letter shapes a bit more (they read as faint burn-in)
    lm = cv2.GaussianBlur(logo.astype(np.float32), (0, 0), 3)[..., None]
    clean = clean * (1 - lm) + cv2.GaussianBlur(clean, (0, 0), 4) * lm
    _S["plate"] = plate
    _S["clean"] = clean
    _S["logo_mask"] = logo

    # --- depth masks
    m_fg = _poly_mask(POLY_FG, 1.6)
    m_mid = np.clip(_poly_mask(POLY_MID, 1.6) - m_fg, 0, 1)
    _S["m_fg"], _S["m_mid"] = m_fg, m_mid
    # back layers get the occluded areas filled (revealed by parallax)
    bg = _fill_holes(clean, np.clip(1 - (m_mid + m_fg) * 1.5, 0, 1))
    mid = _fill_holes(clean, np.clip(1 - m_fg * 1.5, 0, 1))
    mid = mid * (1 - m_fg[..., None]) + clean * m_fg[..., None] * 0  # fg area irrelevant
    _S["L_bg"] = _upscale(bg)
    a_mid = cv2.resize(_poly_mask(POLY_MID, 1.6) * (1 - 0 * m_fg), (UW, UH), interpolation=cv2.INTER_LINEAR)
    _S["L_mid"] = np.dstack([_upscale(mid) * a_mid[..., None], a_mid])
    a_fg = cv2.resize(m_fg, (UW, UH), interpolation=cv2.INTER_LINEAR)
    _S["L_fg"] = np.dstack([_upscale(clean) * a_fg[..., None], a_fg])
    _S["H_main"], _S["H_top"], _S["H_bot"] = _quad_H(Q_MAIN), _quad_H(Q_TOP), _quad_H(Q_BOT)
    return _S


def render(t, ctx):
    S = _prep()
    f = blank()
    M = np.float32([[S0 / U, 0, 0], [0, S0 / U, 0], [0, 0, 1]])
    bg = cv2.warpPerspective(S["L_bg"], M, (W, H), flags=cv2.INTER_LINEAR)
    mid = cv2.warpPerspective(S["L_mid"], M, (W, H), flags=cv2.INTER_LINEAR)
    fg = cv2.warpPerspective(S["L_fg"], M, (W, H), flags=cv2.INTER_LINEAR)
    f = bg * (1 - mid[..., 3:]) + mid[..., :3]
    f = f * (1 - fg[..., 3:]) + fg[..., :3]
    return f
