"""Scene 2 · s2_bullet (3.0 s) — macro slow-motion bullet flight -> lens hit.

Beat sheet (local seconds):
  0.00  hand-off from s1's white-green whip flash: the streaky light wall keeps
        sliding off to the left while the camera whips in and "catches" the
        bullet (it enters from the right, heavy smear that resolves) — whoosh 0.1
  0.3+  macro slow-mo, 3/4 side view: the brand bullet (re-drawn in 3D as a
        solid of revolution: flat logo colours, logo highlight capsule, dark
        screen-space outline, soft cylinder shading, spinning rifling marks)
        drifts left->right with a slight precession. Mach-cone shock rings
        peel off the nose + faint bow-shock V, green speed streaks, the three
        logo streaks trailing the casing, green-lit smoke parted by the wake.
        Stencil HUD on 3D planes at different depths (".50 BMG" huge in the
        back, "VELOCIDADE 853 M/S" in front, "ENERGIA 18.000 J") + a
        screen-space range tape with the DIST readout counting up.
  1.30  ricochet zing: DIST locks on 1.240 M, the nose clips a mote -> spark
        burst, bright ring pop, glint sweeps the bullet, anamorphic flare, kick
  1.35  the camera swings round in front of the bullet (it turns to camera):
        type planes fold away (motion-blurred), streaks become a radial warp
        field, shock rings become concentric circles round the incoming nose
  2.1+  head-on, accelerating approach (slight focal ramp): cel-stepped nose
        with a knife-edge highlight on the tip, tick ring + "0.xxx M IMPACTO"
        countdown; the nose is steered onto the crack origin
  2.65  lens hit (first frame 80): white flash, crack network races out from
        (0.52 W, 0.47 H), shards of green light (rays + glinting crack edges),
        refraction per glass shard, heavy decaying shake — glass + impact
  2.8+  hold the cracked dark frame; it relaxes to exactly the crack_mask
        pattern scene 3 opens on (same seeds / centre), so the cut is seamless

Everything 3D lives in the bullet's co-moving frame (+X = flight direction,
+Y up); the camera orbits it.  Logo geometry measured from logo_bullet.png.
"""
from lib import *

DUR = 3.0
CUES = [(0.1, "whoosh"), (1.3, "ricochet"), (2.65, "glass"), (2.65, "impact")]

T_ZING = 1.3
T_SWING0, T_SWING1 = 1.35, 2.2
T_HIT = 2.65
F_HIT = 80                       # first frame after the hit (2.667 s)
FOC = 1400.0                     # focal length (px)
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
    og = S_FLAT + (BL - S_FLAT) * np.linspace(0, 1, 34) ** 0.8
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


def cam_state(t):
    """(theta, elev, dist, pivot(3), roll) in degrees / world units."""
    ia = ease_out_cubic(prog(t, 0.0, 0.55))
    sw = smooth(prog(t, T_SWING0, T_SWING1))
    th = 19.0 + 5.0 * prog(t, 0, T_SWING0) + (90.0 - 24.0) * sw
    el = 6.5 * (1 - sw) + 1.5 * math.sin(t * 0.8)
    u = prog(t, 1.3, T_HIT)
    D = (1380.0 - 60.0 * prog(t, 0, 1.3)) * (1 - u ** 1.8)
    D = max(D, 2.0)
    px = 230.0 - 330.0 * prog(t, 0, T_SWING0) - 1250.0 * (1 - ia)
    px = px + (500.0 - px) * smooth(prog(t, T_SWING0 - 0.05, T_SWING1 + 0.1))
    py = 18.0 * (1 - sw)
    if wobble_amt(t) < 1.0:                           # lock onto the real nose for the approach
        tip = (BL + S0) * bullet_axes(t)[0]
        k = smooth(prog(t, 1.85, 2.3))
        px = px + (tip[0] - px) * k
        py = py + (tip[1] - py) * k
    roll = 7.0 * math.sin(math.pi * prog(t, T_SWING0, T_SWING1 + 0.25)) + 14.0 * ease_in_cubic(prog(t, 2.1, T_HIT))
    return th, el, D, np.array([px, py, 0.0]), roll


def cam_shake(t):
    dx = dy = 0.0
    # zing kick
    sx, sy, _ = shake(t, amp=9, freq=40, seed=2, decay_from=T_ZING, decay=9)
    dx += sx; dy += sy
    # approach vibration
    k = ease_in_cubic(prog(t, 2.0, T_HIT)) * 9.0
    if k > 0:
        dx += k * (math.sin(t * 93) * 0.6 + math.sin(t * 151 + 1) * 0.4)
        dy += k * (math.sin(t * 117 + 2) * 0.6 + math.sin(t * 173) * 0.4)
    # whip-in drift (slight vertical bob)
    dy += 2.0 * math.sin(t * 2.1 + 0.5)
    # land the nose on the crack origin (shared with scene 3)
    k = smooth(prog(t, 1.9, 2.45))
    dx += (CRACK_C[0] - CX) * k
    dy += (CRACK_C[1] - CY) * k
    return dx, dy


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
        self.foc = FOC * (1 + 0.45 * ease_in_cubic(prog(t, 2.2, T_HIT)))
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
    return 1.0 - smooth(prog(t, 1.85, 2.3))


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


def render_bullet(cam, t, zing_glint=0.0):
    """Returns (x0, y0, rgb, alpha, emission, tip_screen) or None.

    Painter's algorithm over consecutive slice pairs (far -> near) with one
    coverage canvas per material; the logo's dark outline is a screen-space
    stroke (distance transform) so it never turns into a 3D shell."""
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
    nphi = int(np.clip(rmax / 2.5, 32, 160))
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
    w, h = x1 - x0, y1 - y0
    ss = 3 if w * h < 450000 else 2 if w * h < 1100000 else 1

    def down(c):
        return cv2.resize(c, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) * (1 / 255.0)

    # view facing along the axis (for nose tone)
    vc = cam.C - ((S_FLAT + S0) * d)
    vc = vc / np.linalg.norm(vc)
    dv = float(np.dot(vc, d))
    side = clamp((math.sqrt(max(1 - dv * dv, 0)) - 0.3) / 0.35)

    head = clamp((dv - 0.8) / 0.12)
    pairs = []
    for k in ("cas", "gap", "pro"):
        s, r = st[k]
        for i in range(len(s) - 1):
            zz = cam.depth(((s[i] + s[i + 1]) / 2 + S0) * d)
            slope = (r[i] - r[i + 1]) / max(s[i + 1] - s[i], 1e-6)
            na = slope / math.sqrt(1 + slope * slope)
            tone = clamp(na * dv * 3.2) ** 0.6 if k == "pro" else 0.0
            tone = math.floor(tone * 3.0 + 0.15) / 3.0 * head   # cel steps (flat logo look), head-on only
            pairs.append((zz, k, i, tone))
    pairs.sort(key=lambda v: -v[0])
    cans = {k: np.zeros((h * ss, w * ss), np.uint8) for k in ("cas", "gap", "pro")}
    tcan = np.zeros((h * ss, w * ss), np.uint8)
    off = np.array([x0, y0])
    qq = {k: ((qs[k] - off) * ss * 16 - 8).astype(np.int32) for k in qs}
    for zz, k, i, tone in pairs:
        hull = cv2.convexHull(np.concatenate([qq[k][i], qq[k][i + 1]]))
        lt = cv2.LINE_8 if ss > 1 else cv2.LINE_AA
        for kk, c in cans.items():
            cv2.fillConvexPoly(c, hull, 255 if kk == k else 0, lt, 4)
        cv2.fillConvexPoly(tcan, hull, int(tone * 255), lt, 4)
    body_ss = np.maximum(np.maximum(cans["cas"], cans["gap"]), cans["pro"])
    dist = cv2.distanceTransform((body_ss < 128).astype(np.uint8), cv2.DIST_L2, 5)
    if ss > 1:
        a_out = down(((dist <= o_px * ss) * 255).astype(np.uint8))
    else:
        a_out = np.clip(o_px + 0.5 - dist, 0, 1).astype(np.float32)
        a_out = np.maximum(a_out, body_ss.astype(np.float32) / 255)
    m = {k: down(c) for k, c in cans.items()}
    tone = np.clip(down(tcan) / np.maximum(m["pro"], 1e-3), 0, 1)

    # light / shadow bands (cylinder shading), at 1x
    L = np.array([0.25, 1.0, -0.45])
    Lp = L - np.dot(L, d) * d
    Lp /= np.linalg.norm(Lp)
    sb = np.concatenate([pr["cas"][0], pr["pro"][0][1:]])
    rb = r_body(sb)
    sig = max(1.5, R_px * 0.22)
    fs = float(np.clip(6.0 / sig, 0.1, 1.0))                     # shading masks are soft: build them small
    ws, hs = max(4, int(w * fs)), max(4, int(h * fs))
    lc = np.zeros((hs, ws), np.uint8)
    sc = np.zeros((hs, ws), np.uint8)
    n2 = max(24, nphi // 2)
    ql = ring_pts(cam, d, e1, e2, sb, rb * 0.52, n2, shift=(0.40 * rb)[:, None] * Lp[None])
    qs_ = ring_pts(cam, d, e1, e2, sb, rb * 0.56, n2, shift=(-0.42 * rb)[:, None] * Lp[None])
    fill_union(lc, ql, x0, y0, fs)
    fill_union(sc, qs_, x0, y0, fs)
    light = cv2.resize(cv2.GaussianBlur(lc.astype(np.float32) / 255, (0, 0), sig * fs), (w, h), interpolation=cv2.INTER_LINEAR)
    shad = cv2.resize(cv2.GaussianBlur(sc.astype(np.float32) / 255, (0, 0), sig * fs), (w, h), interpolation=cv2.INTER_LINEAR)

    body = np.clip(m["cas"] + m["pro"], 0, 1)
    shade = 1.0 + (0.12 * light - (0.36 - 0.16 * dv * dv) * shad) * body
    # per-channel weight maps (composited per channel below: far cheaper than 3-ch broadcasts)
    f_pro = (1 - 0.2 * dv * dv) + (0.2 * dv * dv) * tone
    t_pro = tone * 0.85
    groove = None
    lw = max(1, int(round(R_px * 0.03 * ss)))
    if side > 0.02:
        gcan = np.zeros((h * ss, w * ss), np.uint8)
        spin = 2 * math.pi * 1.1 * t
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
                if v > 0.15:
                    c = int(255 * min(1.0, (v - 0.15) / 0.3))
                    cv2.line(gcan, tuple(qg[i]), tuple(qg[i + 1]), c, lw, cv2.LINE_AA, 4)
        groove = down(gcan) * (side * 0.4) * m["pro"]

    # highlight: logo capsule on the cylinder (side) -> arc on the nose (head-on)
    tc = cam.C - (S_FLAT + S0) * d
    tc /= np.linalg.norm(tc)
    vp = tc - np.dot(tc, d) * d
    up = YV - np.dot(YV, d) * d
    up /= np.linalg.norm(up)
    nh = 0.77 * vp + 0.64 * up
    nh /= np.linalg.norm(nh)
    ph = math.atan2(float(np.dot(nh, e2)), float(np.dot(nh, e1)))
    uu = np.linspace(0, 1, 30)
    s_u = lerp(lerp(600.0, 992.0, uu), lerp(365.0, 666.0, uu), side)
    if side <= 0.5:              # start the nose sliver at the silhouette (perspective can fold the path)
        sc_ = np.linspace(560.0, 992.0, 60)
        Pc = (sc_ + S0)[:, None] * d + (r_body(sc_) * 0.9)[:, None] * surf_dirs(e1, e2, np.full_like(sc_, ph))
        qc, _ = cam.proj(Pc)
        j = int(np.argmax(np.linalg.norm(qc - tip_q[0], axis=1)))
        s_u = lerp(sc_[j], 992.0, uu)
    P = (s_u + S0)[:, None] * d + (r_body(s_u) * 0.9)[:, None] * surf_dirs(e1, e2, np.full_like(uu, ph))
    q, _ = cam.proj(P)
    hcan = np.zeros((h * ss, w * ss), np.uint8)
    qh = (q - off) * ss
    if side > 0.5:                                     # logo capsule (round caps)
        th = max(2, int(round(R_px * 0.20 * ss)))
        cv2.polylines(hcan, [(qh * 16).astype(np.int32)], False, 255, th, cv2.LINE_AA, 4)
    else:                                              # knife-edge sliver converging on the tip
        tg = np.gradient(qh, axis=0)
        tg /= np.maximum(np.linalg.norm(tg, axis=1, keepdims=True), 1e-6)
        nrm = np.stack([-tg[:, 1], tg[:, 0]], 1)
        half = R_px * ss * 0.075 * (1 - uu) ** 0.9 * (0.35 + 0.65 * np.clip(uu * 6, 0, 1))
        poly = np.concatenate([qh + nrm * half[:, None], (qh - nrm * half[:, None])[::-1]])
        cv2.fillPoly(hcan, [(poly * 16).astype(np.int32)], 255, cv2.LINE_AA, 4)
    hl = down(hcan) * m["pro"]

    zg = None
    if zing_glint > 0:                                 # glint sweeping tail -> tip
        gy, gx = np.ogrid[0:h, 0:w]
        tail_q = cam.proj(np.array([S0 * d]))[0][0]
        ax = tip_q[0] - tail_q
        L2 = max(float(np.dot(ax, ax)), 1.0)
        u = (((gx + x0 - tail_q[0]) * ax[0]).astype(np.float32) + ((gy + y0 - tail_q[1]) * ax[1]).astype(np.float32)) / L2
        pos = -0.2 + 1.4 * zing_glint
        zg = np.exp(-((u - pos) / 0.05) ** 2) * body * 0.75

    chans = []
    mc, mg, mp = m["cas"], m["gap"], m["pro"]
    for c in range(3):
        o = float(C_OUT[c])
        v = o + (float(GREEN_DK[c]) * 1.02 - o) * mc + 3.0 * mg
        v += (float(GREEN[c]) * f_pro + float(GREEN_HOT[c] - GREEN[c]) * t_pro - o) * mp
        v *= shade
        if groove is not None:
            v += ((96, 150, 44)[c] - v) * groove
        v += (float(C_HL[c]) - v) * (hl * 0.95)
        if zg is not None:
            v += (252.0 - v) * zg
        chans.append(v)
    rgb = cv2.merge(chans)

    # tip glint (reads "pointed" when seen head-on), windowed
    tg = (1 - side) * clamp((dv - 0.5) * 3)
    if tg > 0.01:
        rr_ = max(2.0, R_px * 0.05)
        R4 = int(rr_ * 4) + 2
        cxl, cyl = int(round(tip_q[0, 0])) - x0, int(round(tip_q[0, 1])) - y0
        a0, a1 = max(cxl - R4, 0), min(cxl + R4, w)
        b0, b1 = max(cyl - R4, 0), min(cyl + R4, h)
        if a1 > a0 and b1 > b0:
            gy, gx = np.ogrid[b0:b1, a0:a1]
            dd = ((gx + x0 - tip_q[0, 0]) ** 2 + (gy + y0 - tip_q[0, 1]) ** 2).astype(np.float32)
            spot = np.exp(-dd / (2 * rr_ * rr_)) * mp[b0:b1, a0:a1] * (tg * 0.8)
            reg = rgb[b0:b1, a0:a1]
            reg += (np.float32(250) - reg) * spot[..., None]
    return x0, y0, rgb, a_out, (mp, mc, hl), tip_q[0]


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


def draw_streaks(cam, t, add_back, add_front, emis_s, zsplit, amt=1.0):
    x0, rho, phi, spd, br, ln = streak_parts()
    per = XMAX - XMIN
    X = XMIN + np.mod(x0 - V_STREAK * spd * t - XMIN, per)
    Y = rho * np.sin(phi)
    Z = rho * np.cos(phi)
    P0 = np.stack([X, Y, Z], -1)
    L = V_STREAK * spd * 0.075 * ln
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
            cv2.line(emis_s, (pa[0] // 4, pa[1] // 4), (pb[0] // 4, pb[1] // 4), tuple(float(v) * 0.9 for v in col),
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
    return x0, y, z, rad, var, rot, spd, op


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
    return 1.0 / (1.0 + (d / 520.0) ** 2)


SMK = 4                                              # smoke buffer downscale


def draw_smoke(cam, t, amt=1.0):
    h2, w2 = H // SMK, W // SMK
    dens = np.zeros((h2, w2), np.float32)
    col = np.zeros((h2, w2, 3), np.float32)
    sprs = smoke_sprites()
    x0, y, z, rad, var, rot, spd, op = smoke_parts()
    per = XMAX - XMIN
    X = XMIN + np.mod(x0 - V_AIR * spd * t - XMIN, per)
    items = []
    tipx = BL + S0
    for i in range(len(X)):
        Y, Z = y[i], z[i]
        rho = math.hypot(Y, Z)
        behind = tipx - X[i]
        if behind > 0 and rho < 1400:                     # parted by the bullet
            push = 420 * (1 - math.exp(-behind / 380)) * math.exp(-(rho / 700) ** 2)
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
            alpha = 0.4 * op[i]
            fe = clamp((P[0] - XMIN) / 900) * clamp((XMAX - P[0]) / 900)
            alpha *= fe
            spr = sprs[var[i]]
            ang = math.radians(rot[i] + 8 * t)
            vel = V_AIR * spd[i]
        else:
            R = 70 + 420 * age
            alpha = 0.30 * (1 - math.exp(-age * 10)) * math.exp(-age * 1.7)
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
        c = np.array([17, 20, 17], np.float32) + np.array([66, 122, 46], np.float32) * li
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
    if t >= T_ZING:                                   # the zing pop
        a = t - T_ZING
        if a < 1.2:
            out.append((a, 2.4, 1.45))
    return out


def ring_geom(a, cf=1.0):
    return BL + S0 + 20 - V_RING * a, 30 + C_RING * cf * a


def draw_rings(cam, t, add_back, add_front, emis_s, zsplit):
    nphi = 120
    ph = np.linspace(0, 2 * math.pi, nphi + 1)
    for a, inten, cf in ring_list(t):
        x, r = ring_geom(a, cf)
        al = inten * math.exp(-a * 3.6) * clamp(a / 0.05 + 0.15) * clamp((1.0 - a) / 0.25)
        if al < 0.01:
            continue
        P = np.stack([np.full(nphi + 1, x), r * np.sin(ph), r * np.cos(ph)], -1)
        q, z = cam.proj(P)
        if (z < 30).all():
            continue
        zm = max(float(np.median(z)), 1.0)
        thick = int(np.clip(cam.foc * 2.6 / zm, 1, 4))
        col = MINT * al * 0.6
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
                cv2.polylines(emis_s, [qs], False, tuple(float(v) for v in ADD_G * al * 0.45), 2, cv2.LINE_AA, 4)


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
        emis_s += sheet[..., None] * ADD_G * (0.05 * amt)


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
    n = 40
    ang = rng.normal(0, 0.55, n) + math.pi              # backwards cone
    elev = rng.uniform(0, 2 * math.pi, n)
    v = rng.uniform(500, 2200, n)
    life = rng.uniform(0.15, 0.5, n)
    vx = v * np.cos(ang)
    vr = v * np.abs(np.sin(ang)) + rng.uniform(80, 500, n)
    return vx, vr, elev, life


def draw_sparks(cam, t, add_front, emis_s):
    dt = t - T_ZING
    if dt < 0 or dt > 0.55:
        return
    vx, vr, elev, life = zing_sparks()
    tip = np.array([BL + S0 + 10, 0, 0])
    for i in range(len(vx)):
        if dt > life[i]:
            continue
        a = (1 - dt / life[i]) ** 1.5
        def pos(tt):
            x = tip[0] + (vx[i] - V_AIR * 0.5) * tt
            r = vr[i] * tt
            return np.array([x, 20 + r * math.sin(elev[i]) - 300 * tt * tt, r * math.cos(elev[i])])
        p1 = pos(dt)
        p0 = pos(max(dt - 0.03, 0))
        q, z = cam.proj(np.stack([p0, p1]))
        if (z < 50).any():
            continue
        c = tuple(float(v) * a for v in (MINT if i % 3 else GREEN_HOT))
        cv2.line(add_front, (int(q[0, 0] * 16), int(q[0, 1] * 16)), (int(q[1, 0] * 16), int(q[1, 1] * 16)), c, 2, cv2.LINE_AA, 4)
        if emis_s is not None:
            cv2.line(emis_s, (int(q[0, 0] * 4), int(q[0, 1] * 4)), (int(q[1, 0] * 4), int(q[1, 1] * 4)),
                     tuple(v * 2.0 for v in c), 2, cv2.LINE_AA, 4)


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


@lru_cache(maxsize=1)
def hud_layers():
    big = text_layer(".50 BMG", "stencil", 420, fill=BONE, pad=24)
    big = worn(big, 31, 0.95, 0.6, 13)
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
    return {"big": big, "vel": blk, "cal": cb}


T_REF = 0.8
# name, screen centre at T_REF, depth (from camera), screen height px, drift speed (-X, u/s), opacity
PLANES = (
    ("big", (930, 500), 2400.0, 340.0, 170.0, 0.2),
    ("vel", (560, 860), 900.0, 205.0, 420.0, 0.95),
    ("cal", (1560, 290), 1250.0, 96.0, 300.0, 0.85),
)


@lru_cache(maxsize=1)
def plane_defs():
    cam = Cam(T_REF, (0, 0))
    lays = hud_layers()
    out = []
    for name, (sx, sy), z, hs, spd, op in PLANES:
        lay = lays[name]
        lh, lw = lay.shape[:2]
        wpp = (hs / lh) * z / FOC                          # world units per layer px
        cxw = cam.C + z * cam.f + (sx - CX) * z / FOC * cam.r - (sy - CY) * z / FOC * cam.u
        out.append((name, cxw, cam.r.copy(), cam.u.copy(), wpp, lw, lh, spd, op))
    return out


@lru_cache(maxsize=4)
def premul_layer(name):
    return premul(hud_layers()[name])


def draw_planes(frame, t, names, amt=1.0, cams=()):
    lays = hud_layers()
    n = len(cams)
    for name, cw, pr_, pu, wpp, lw, lh, spd, op in plane_defs():
        if name not in names:
            continue
        o = op * amt
        if name == "cal":
            o *= ease_out_cubic(prog(t, 0.35, 0.7))
        if o < 0.01:
            continue
        pm = premul_layer(name)
        c = cw - XV * spd * (t - T_REF)
        hw, hh = lw * wpp / 2, lh * wpp / 2
        P = np.stack([c - pr_ * hw + pu * hh, c + pr_ * hw + pu * hh, c + pr_ * hw - pu * hh, c - pr_ * hw - pu * hh])
        src = np.float32([[0, 0], [lw, 0], [lw, lh], [0, lh]])
        for cm in cams:
            q, z = cm.proj(P)
            if (z < 120).any():
                continue
            x0 = int(max(math.floor(q[:, 0].min()), 0))
            y0 = int(max(math.floor(q[:, 1].min()), 0))
            x1 = int(min(math.ceil(q[:, 0].max()), W))
            y1 = int(min(math.ceil(q[:, 1].max()), H))
            if x1 - x0 < 2 or y1 - y0 < 2:
                continue
            Hm = cv2.getPerspectiveTransform(src, (q - [x0, y0]).astype(np.float32))
            wv = cv2.warpPerspective(pm, Hm, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
            reg = frame[y0:y1, x0:x1]
            reg += (wv[..., :3] - reg * wv[..., 3:4]) * (o / n)


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


# ---------------------------------------------------------------- background
@lru_cache(maxsize=1)
def bg_maps():
    """Void background + halftone corners; smooth parts built small then upscaled."""
    w4, h4 = W // 4, H // 4
    yq, xq = np.mgrid[0:h4, 0:w4].astype(np.float32) * 4 + 2
    n = value_noise(w4, h4, 65, 4, 61)
    g = np.exp(-(((xq - W * 0.52) / 900) ** 2 + ((yq - H * 0.52) / 420) ** 2))
    gg = np.zeros((h4, w4), np.float32)
    for cx, cy, s in ((0, 0, 1.0), (W, H, 0.95), (W, 0, 0.55), (0, H, 0.6)):
        r = np.hypot((xq - cx) / (W * 0.36), (yq - cy) / (H * 0.6))
        gg = np.maximum(gg, s * np.clip(1 - r, 0, 1) ** 1.2)
    gg *= 0.55 + 0.45 * value_noise(w4, h4, 38, 3, 62)
    base_q = (INK[None, None] * (0.85 + 0.25 * n[..., None])
              + (g * (0.6 + 0.4 * n))[..., None] * np.array([6, 13, 5], np.float32)).astype(np.float32)
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
    return base, ht


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
                extra.append((pts[j], pts[j + 1], 2 if R0 < 130 else 1, rng.uniform(0.55, 0.95)))
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
        cv2.line(ex, a0, a1, float(br * (0.5 + 0.5 * math.exp(-rr / 520))), th, cv2.LINE_AA, 4)
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
    lh = lab[::2, ::2]
    sd = np.cos(sdir).astype(np.float32)[lh] * (xh - cx) / 300 + np.sin(sdir).astype(np.float32)[lh] * (yh - cy) / 300
    sheen = up(np.clip(np.sin(sd * 2.5 + sph[lh]), 0, 1) ** 5 * son[lh] * np.exp(-(rh / 950) ** 2))
    tintm = up(tint[lh] * np.exp(-(rh / 1100) ** 2))
    gl = []
    tries = 0
    segs_all = [(a, b) for a, b in base_segs] + [(a, b) for a, b, _, _ in extra]
    while len(gl) < 14 and tries < 400:
        tries += 1
        p0, p1 = segs_all[int(rng.integers(0, len(segs_all)))]
        rd = rad_of(p0)
        if rd < 60 or rd > 900 or math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 18:
            continue
        gl.append((float(p0[0]), float(p0[1]), float(p1[0]), float(p1[1]), rng.uniform(0, 6.28), rd))
    # pre-combined lines (+ arrival radius) for the per-frame pass
    lines = np.maximum(base * falloff, ex)
    return {
        "base": base.astype(np.float32), "extra": ex.astype(np.float32), "falloff": falloff, "lines": lines,
        "shadow": shadow.astype(np.float32), "arr": arr, "frost": frost_c.astype(np.float32), "frost_at": (fcx - fr_, fcy - fr_),
        "tint": tintm, "sheen": sheen, "glints": gl,
    }


def crack_pass(frame, t):
    dt = t - (F_HIT / FPS)
    cm = crack_maps()
    grow = ease_out_expo(prog(dt, -0.01, 0.2))
    front = 40 + 1500 * grow
    reach = (cm["arr"] <= front).astype(np.float32) if front < 1500 else None
    settle = smooth(prog(t, 2.8, DUR - 1 / FPS))          # hand-off: relax to s3's opening look
    tf = clamp(grow) * (1 - settle)
    lit = 0.7 + 0.3 * math.exp(-dt * 9)
    if tf > 0.02:
        frame += (cm["tint"] * (3.0 * tf))[..., None] + cm["sheen"][..., None] * (ADD_G * (30 * tf * lit / 255.0))
        sh = cm["shadow"] if reach is None else cm["shadow"] * reach
        frame *= (1 - (0.65 * tf) * np.minimum(sh, 1))[..., None]
    k1 = 0.9 * lit * (1 - settle)
    k2 = 0.36 * settle
    k3 = 0.9 * lit * (1 - 0.85 * settle)
    a = np.maximum(cm["base"] * (cm["falloff"] * k1 + k2), cm["extra"] * k3)
    if reach is not None:
        a *= reach
    vis = a
    core = (BONE * 0.6 + MINT * 0.4) * (1 - settle) + BONE * settle
    frame += (core[None, None] - frame) * a[..., None]
    fx, fy = cm["frost_at"]
    fz = cm["frost"]
    reg = frame[fy:fy + fz.shape[0], fx:fx + fz.shape[1]]
    reg += (BONE - reg) * (fz * (0.5 * lit * clamp(grow) * (1 - 0.8 * settle)))[..., None]
    # light catching short crack edges ("shards of green light"), additive
    gb = np.zeros((H // 2, W // 2, 3), np.float32)
    lit = lit * (1 - settle)
    for (x0_, y0_, x1_, y1_, ph, rd) in cm["glints"]:
        if rd > front:
            continue
        tw = max(0.0, math.sin(t * 7.0 + ph)) ** 4 * 0.9 + 1.6 * math.exp(-max(dt - rd / 7000, 0) * 10)
        if tw < 0.03:
            continue
        c = tuple(float(v) * min(tw, 1.6) * lit for v in (ADD_G * 0.8 + MINT * 0.5))
        cv2.line(gb, (int(x0_ * 8), int(y0_ * 8)), (int(x1_ * 8), int(y1_ * 8)), c, 1, cv2.LINE_AA, 4)
    if gb.any():
        gb = gb + cv2.GaussianBlur(gb, (0, 0), 3) * 1.2
        frame += cv2.resize(gb, (W, H), interpolation=cv2.INTER_LINEAR)
    return frame, vis


# ---------------------------------------------------------------- whip-in from s1 + impact
@lru_cache(maxsize=1)
def flood_rows():
    h2 = H // 2
    rng = np.random.default_rng(322)
    fine = cv2.resize(rng.random((h2 // 3, 1)).astype(np.float32), (1, h2), interpolation=cv2.INTER_LINEAR)[:, 0]
    coarse = cv2.resize(rng.random((9, 1)).astype(np.float32), (1, h2), interpolation=cv2.INTER_CUBIC)[:, 0]
    return np.clip(0.6 * fine ** 2 + 0.25 * coarse, 0, 1).astype(np.float32)


def whip_in(frame, t):
    p = prog(t, 0.0, 0.34)
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


def render(t, ctx):
    t = float(t)
    fr = int(round(t * FPS))
    if abs(t * FPS - fr) < 1e-3:
        t = fr / FPS
    hit = fr >= F_HIT
    base, ht = bg_maps()
    breathe = 0.85 + 0.15 * math.sin(t * 2.4)
    frame = cv2.addWeighted(base, 1.0, ht, breathe, 0.0)
    if hit:
        frame = impact(frame, t)
        return np.clip(frame, 0, 255, out=frame)

    cam = Cam(t)
    cams = [cam]
    if T_SWING0 - 0.02 < t < 1.95:                  # motion-blur the type planes while the camera swings
        ref = plane_defs()[0][1]
        cp = Cam(t - 0.5 / FPS)
        disp = float(np.linalg.norm(cam.proj(ref[None])[0][0] - cp.proj(ref[None])[0][0]))
        n = int(np.clip(math.ceil(disp / 6.0), 1, 8))
        if n > 1:
            cams = [Cam(t - k * (0.5 / FPS) / (n - 1)) for k in range(n)]
    amt_planes = 1.0 - smooth(prog(t, T_SWING0 + 0.02, 1.78))

    draw_planes(frame, t, ("big",), amt_planes, cams)

    # smoke (half res)
    dens, smoke_col = draw_smoke(cam, t)
    oma = 1.0 - np.clip(dens, 0, 0.92)
    smoke_col *= np.minimum(1.0, 0.92 / np.maximum(dens, 1e-3))[..., None]
    oma3 = cv2.resize(np.repeat(oma[..., None], 3, axis=2), (W, H), interpolation=cv2.INTER_LINEAR)
    cv2.multiply(frame, oma3, dst=frame)

    zsplit = cam.depth(np.zeros(3))
    add_back, add_front = _bufs()
    add_back.fill(0)
    add_front.fill(0)
    emis_s = np.zeros((H // 4, W // 4, 3), np.float32)
    streak_amt = 0.8 + 0.7 * smooth(prog(t, T_SWING0, T_HIT))
    draw_streaks(cam, t, add_back, add_front, emis_s, zsplit, streak_amt)
    draw_rings(cam, t, add_back, add_front, emis_s, zsplit)
    draw_cone(cam, t, add_back, emis_s, 1.0)
    draw_trail(cam, t, add_back, emis_s, 1.0 - smooth(prog(t, 1.6, 2.1)))
    draw_sparks(cam, t, add_front, emis_s)

    zg = prog(t, T_ZING - 0.02, T_ZING + 0.14)
    B = render_bullet(cam, t, zg if 0 < zg < 1 else 0.0)
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
    g = cv2.GaussianBlur(emis_s, (0, 0), 2.0) * 0.6 + cv2.GaussianBlur(emis_s, (0, 0), 9) * 0.5 + wide * 0.17
    g += smoke_col                                     # smoke light + glow share one upscale
    cv2.add(frame, cv2.resize(g, (W, H), interpolation=cv2.INTER_LINEAR), dst=frame)
    cv2.add(frame, add_back, dst=frame)

    if B is not None:
        x0, y0, rgb, al, em, tipq = B
        h, w = al.shape
        reg = frame[y0:y0 + h, x0:x0 + w]
        reg += (rgb - reg) * al[..., None]

    if B is not None:                      # keep streaks from slicing across the hero
        x0, y0, rgb, al, em, tipq = B
        h, w = al.shape
        add_front[y0:y0 + h, x0:x0 + w] *= (1 - 0.8 * al)[..., None]
    cv2.add(frame, add_front, dst=frame)
    draw_planes(frame, t, ("vel", "cal"), amt_planes, cams)

    if B is not None:
        tipq = B[5]
        z = t - T_ZING
        fl = (1.6 * math.exp(-z * 10) if z >= 0 else 0.0) + 0.12 * (1 - smooth(prog(t, T_SWING0, 1.9)))
        ana_flare(frame, tipq[0], tipq[1], fl)

    draw_tape(frame, t, ease_out_cubic(prog(t, 0.25, 0.6)) * (1.0 - smooth(prog(t, T_SWING0 + 0.05, T_SWING0 + 0.45))))
    range_ring(frame, cam, t, 0.0 if B is None else 0.5 * max(B[3].shape), None if B is None else B[5])

    frame = qbloom(frame, 215, 4.5, 0.25)
    if t < 0.34:
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


def range_ring(frame, cam, t, nose_r=0.0, centre=None):
    """Head-on: thin tick ring around the incoming nose + DIST countdown."""
    k = ease_out_cubic(prog(t, 2.12, 2.3))
    if k <= 0:
        return
    rem = max(0.0, (T_HIT - t) / (T_HIT - 2.12))
    R = max(150.0, nose_r + 26)
    cx, cy = (CX + cam.ox, CY + cam.oy) if centre is None else (float(centre[0]), float(centre[1]))
    x0 = int(max(cx - R - 24, 0)); x1 = int(min(cx + R + 24, W))
    y0 = int(max(cy - R - 24, 0)); y1 = int(min(cy + R + 24, H))
    if x1 - x0 > 4 and y1 - y0 > 4:
        lay = np.zeros((y1 - y0, x1 - x0), np.float32)
        rot = t * 1.4
        for i in range(72):
            a = rot + i / 72 * 2 * math.pi
            L = 16 if i % 6 == 0 else 7
            p0 = (cx - x0 + R * math.cos(a), cy - y0 + R * math.sin(a))
            p1 = (cx - x0 + (R + L) * math.cos(a), cy - y0 + (R + L) * math.sin(a))
            cv2.line(lay, (int(p0[0] * 16), int(p0[1] * 16)), (int(p1[0] * 16), int(p1[1] * 16)), 1.0,
                     2 if i % 6 == 0 else 1, cv2.LINE_AA, 4)
        reg = frame[y0:y1, x0:x1]
        reg += (GREEN - reg) * (lay * 0.8 * k)[..., None]
    v = int(round(rem * 412))
    lab = label_layer(f"0.{v:03d} M", "stencil", 40, "green")
    over(frame, lab, cx - lab.shape[1] / 2, cy + R + 34, k)
    cap = label_layer("IMPACTO", "oswald", 22, "bone", 6)
    over(frame, cap, cx - cap.shape[1] / 2, cy + R + 84, 0.8 * k)


def impact(frame, t):
    dt = t - F_HIT / FPS
    # behind the glass: the void, dimmed, with a hot green core dying
    settle = smooth(prog(t, 2.8, DUR - 1 / FPS))
    frame = frame * lerp(0.6, 1.0, settle)
    frame += _core_glow() * ((0.9 * math.exp(-dt * 7) + 0.12) * (1 - settle))
    frame, vis = crack_pass(frame, t)
    # shards of green light: radial rays through the cracks
    if dt < 0.35:
        rays = _rays()
        frame += rays * (1.3 * math.exp(-dt * 9))
    # white flash (frame 80 full, then falls off fast with the cracks showing through)
    fl = 1.0 if dt < 0.5 / FPS else 0.5 * math.exp(-(dt - 1 / FPS) * 26)
    frame = flash(frame, fl, MINT * 0.4 + WHITE * 0.6 if fl >= 1 else MINT * 0.8 + GREEN * 0.2)
    if 0 < fl < 1:
        frame *= (1 - np.clip(vis, 0, 1) * 0.55 * fl)[..., None]
    frame = qbloom(frame, 170, 3.5, 0.45 * math.exp(-dt * 4) + 0.15)
    sx, sy, sa = shake(t, amp=46, freq=34, seed=9, decay_from=F_HIT / FPS, decay=9.0)
    fade = 1 - smooth(prog(t, 2.83, 2.95))
    sx, sy, sa = sx * fade, sy * fade, sa * fade
    M = cv2.getRotationMatrix2D((W / 2, H / 2), sa * 1.5, 1.0 + 0.05 * math.exp(-dt * 10))
    M[0, 2] += sx
    M[1, 2] += sy
    frame = cv2.warpAffine(frame, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
    return frame


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
