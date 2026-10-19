#!/usr/bin/env python3
"""Procedural soundtrack for the ARMY loading screen -> audio.wav

    python3 audio.py                  # write audio.wav (48 kHz, stereo, 16-bit PCM, exact video length)
    python3 audio.py --report DIR     # also write waveform / spectrogram PNGs and cue checks to DIR
    python3 audio.py --out other.wav

Only numpy + scipy (cv2 is used for the optional report images).

The timeline is read at run time from build.timeline() (scene starts + absolute
cue list built from every scene module's DUR / CUES). If that fails, each scene
module is imported on its own and any module that does not import falls back to
the duration / cues written in STORYBOARD.md (then to built-in defaults).
Nothing below hard-codes an absolute time: scene roles are found by name/order
(first = intro, *montage* = beat section, last = end card) and every SFX is
placed at its cue.

Layers
  SFX bus   one synthesized sound per cue kind (see SFX table at the bottom)
  Music bus dark detuned-saw drone with slow filter motion; tense 8th-note pulse
            building through the scenes between the intro and the montage; a hard
            150 BPM beat locked to the montage cuts (kick on every cut, clap on
            2/4, 16th hats, distorted 808); big chord stab + wide pad on the end
            card that fades to silence so the loop restarts cleanly.
  Master    music ducked under SFX, RMS bus compression, soft clip, look-ahead
            limiter, gain-matched to about -14 LUFS (BS.1770 K-weighting, gated),
            true peak <= -1 dBFS, DC removed, fades at both ends, TPDF dither.
"""
import argparse
import importlib
import os
import re
import sys
import time
import zlib
from functools import lru_cache

import numpy as np
from scipy import signal
from scipy.io import wavfile
from scipy.ndimage import maximum_filter1d, uniform_filter1d

ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

SR = 48000
TWO_PI = 2 * np.pi
BPM = 150.0
BEAT = 60.0 / BPM                  # 0.4 s = montage cut grid
TARGET_LUFS = -14.0
TP_CEIL_DB = -1.0                  # true-peak ceiling (dBFS)
LIMIT_DB = -1.3                    # limiter ceiling on the 4x-oversampled (true-peak) envelope

CUE_KINDS = ("impact", "sub_drop", "whoosh", "shot", "ricochet", "glitch", "riser",
             "spray", "click", "shell", "glass", "beep", "hum")

# last-resort timeline if neither the scene modules nor STORYBOARD.md can be read
DEFAULT_SCENES = [
    ("s1_ignite", 3.0, [(0.0, "hum"), (0.9, "glitch"), (2.3, "click"), (2.6, "shot")]),
    ("s2_bullet", 3.0, [(0.1, "whoosh"), (1.3, "ricochet"), (2.65, "glass"), (2.65, "impact")]),
    ("s3_slam", 4.5, [(0.3, "impact"), (1.2, "impact"), (2.0, "spray"), (3.4, "click"), (4.2, "whoosh")]),
    ("s4_crt", 5.0, [(0.0, "hum"), (1.0, "beep"), (2.2, "glitch"), (3.6, "riser"), (4.6, "whoosh")]),
    ("s5_montage", 4.0, [(round(0.4 * i, 3), "impact") for i in range(9)] + [(2.4, "shell"), (3.2, "click")]),
    ("s6_final", 7.5, [(0.2, "whoosh"), (0.6, "impact"), (0.8, "impact"), (1.0, "impact"), (1.2, "impact"),
                       (0.6, "sub_drop"), (2.2, "spray"), (6.8, "glitch")]),
]


# =============================================================== timeline
def _parse_cue_text(s, kinds):
    s = " ".join(s.split())
    cues = []

    def every(m):
        kind, body = m.group(1), m.group(2)
        nums = [float(v) for v in re.findall(r"\d+(?:\.\d+)?", body)]
        if ("…" in body or "..." in body) and len(nums) >= 3:
            step = nums[1] - nums[0]
            k = 0
            while step > 0 and nums[0] + k * step <= nums[-1] + 1e-6:
                cues.append((round(nums[0] + k * step, 3), kind))
                k += 1
        else:
            cues.extend((v, kind) for v in nums)
        return " "

    s = re.sub(r"([a-z_]+)\s+at\s+every\s+\w+\s*\(([^)]*)\)", every, s)
    for kind, v in re.findall(r"([a-z_]+)\s+(\d+(?:\.\d+)?)", s):
        cues.append((float(v), kind))
    return [(t, k) for t, k in cues if k in kinds]


def parse_storyboard(path, kinds=CUE_KINDS):
    """[(name, dur, [(t_local, kind)])] from the STORYBOARD.md table + CUES lines."""
    try:
        txt = open(path, encoding="utf-8").read()
    except OSError:
        return []
    order, info = [], {}
    for _, name, dur in re.findall(r"^\|\s*(\d+)\s*\|\s*([A-Za-z0-9_]+)\s*\|\s*([\d.]+)\s*\|", txt, re.M):
        order.append(name)
        info[name] = [float(dur), []]
    for sec in re.split(r"^###\s+", txt, flags=re.M)[1:]:
        m = re.match(r"\s*\d+\s*\S*\s*([A-Za-z0-9_]+)\s*\(([\d.]+)\s*s\)", sec)
        if not m:
            continue
        name = m.group(1)
        if name not in info:
            order.append(name)
            info[name] = [float(m.group(2)), []]
        cm = re.search(r"CUES:\s*(.*?)(?:\n\s*\n|\Z)", sec, re.S)
        if cm:
            info[name][1] = _parse_cue_text(cm.group(1), kinds)
    return [(n, info[n][0], info[n][1]) for n in order]


def load_timeline():
    """-> (tl [(name, start, dur)], cues [(t_abs, kind, scene)], total, fps, notes)."""
    notes, fps, kinds = [], 30, CUE_KINDS
    try:
        import lib
        fps, kinds = lib.FPS, tuple(lib.CUE_KINDS)
    except Exception as e:  # noqa: BLE001
        notes.append(f"lib import failed ({type(e).__name__}: {e}); fps=30")
    sb = parse_storyboard(os.path.join(ROOT, "STORYBOARD.md"), kinds) or DEFAULT_SCENES
    build = None
    try:
        import build as _build
        build = _build
        names = list(build.SCENES)
    except Exception as e:  # noqa: BLE001
        names = [s[0] for s in sb]
        notes.append(f"build import failed ({type(e).__name__}: {e}); scene list from STORYBOARD")
    if build is not None:
        try:
            tl, cues, total = build.timeline()
            tl = [(n, float(s), float(d)) for n, s, d in tl]
            cues = [(float(t), k, n) for t, k, n in cues]
            notes.insert(0, "timeline: build.timeline()")
            return tl, cues, float(total), fps, notes
        except Exception as e:  # noqa: BLE001
            notes.append(f"build.timeline() failed ({type(e).__name__}: {e}); per-scene fallback")
    sbd = {s[0]: s for s in sb}
    tl, cues, t = [], [], 0.0
    for i, name in enumerate(names):
        try:
            mod = importlib.import_module("scenes." + name)
            dur, sc, src = float(mod.DUR), list(getattr(mod, "CUES", [])), "module"
        except Exception as e:  # noqa: BLE001
            if name in sbd:
                _, dur, sc = sbd[name]
                src = "STORYBOARD"
            elif i < len(sb):
                _, dur, sc = sb[i]
                src = f"STORYBOARD row {i + 1} ({sb[i][0]})"
            else:
                _, dur, sc = DEFAULT_SCENES[min(i, len(DEFAULT_SCENES) - 1)]
                src = "built-in default"
            notes.append(f"{name}: import failed ({type(e).__name__}: {e}) -> {src}")
        tl.append((name, t, dur))
        for ct, kind in sc:
            cues.append((round(t + float(ct), 3), kind, name))
        t += dur
    notes.insert(0, "timeline: per-scene fallback")
    return tl, sorted(cues), t, fps, notes


# =============================================================== DSP helpers
def ns(sec):
    return max(1, int(round(sec * SR)))


def tvec(n):
    return np.arange(n) / SR


def peak(x):
    return float(np.max(np.abs(x))) + 1e-12


def db(x):
    return 20 * np.log10(np.maximum(x, 1e-12))


def undb(d):
    return 10.0 ** (np.asarray(d) / 20.0)


def att(t, a):
    """Smooth (sin^2) attack ramp of length a seconds."""
    if a <= 0:
        return np.ones_like(t)
    u = np.clip(t / a, 0, 1)
    return np.sin(u * np.pi / 2) ** 2


def fade_tail(x, sec):
    m = min(ns(sec), x.shape[-1])
    x = np.array(x, dtype=float, copy=True)
    x[..., -m:] *= np.cos(np.linspace(0, np.pi / 2, m)) ** 2
    return x


def fade_head(x, sec):
    m = min(ns(sec), x.shape[-1])
    x = np.array(x, dtype=float, copy=True)
    x[..., :m] *= np.sin(np.linspace(0, np.pi / 2, m)) ** 2
    return x


def sat(x, drive):
    return np.tanh(drive * x) / np.tanh(drive)


def noise(n, rng, color="white", ch=None):
    shape = (n,) if ch is None else (ch, n)
    w = rng.standard_normal(shape)
    if color == "white":
        return w
    X = np.fft.rfft(w, axis=-1)
    f = np.fft.rfftfreq(n, 1 / SR)
    if color == "pink":
        X = X / np.sqrt(np.maximum(f, 20.0))
    else:  # brown, with the sub-25 Hz junk removed
        X = X / np.maximum(f, 25.0)
    X[..., 0] = 0
    y = np.fft.irfft(X, n, axis=-1)
    return y / (np.std(y, axis=-1, keepdims=True) + 1e-12)


@lru_cache(maxsize=None)
def _sos(btype, f, order):
    if isinstance(f, tuple):
        f = tuple(min(v, SR * 0.45) for v in f)
    else:
        f = min(f, SR * 0.45)
    return signal.butter(order, f, btype=btype, fs=SR, output="sos")


def lp(x, f, order=2):
    return signal.sosfilt(_sos("lowpass", float(f), order), x, axis=-1)


def hp(x, f, order=2):
    return signal.sosfilt(_sos("highpass", float(f), order), x, axis=-1)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(_sos("bandpass", (float(lo), float(hi)), order), x, axis=-1)


def osc_phase(f, n, ph0=0.0):
    f = np.broadcast_to(np.asarray(f, dtype=float), (n,))
    return ph0 + TWO_PI * np.cumsum(f) / SR


def saw(f, n, ph0=0.0):
    """Band-limited (polyBLEP) sawtooth, f scalar or per-sample array."""
    f = np.broadcast_to(np.asarray(f, dtype=float), (n,))
    dt = f / SR
    ph = (ph0 + np.cumsum(dt)) % 1.0
    y = 2 * ph - 1
    m = ph < dt
    u = ph[m] / dt[m]
    y[m] -= u + u - u * u - 1
    m = ph > 1 - dt
    u = (ph[m] - 1) / dt[m]
    y[m] -= u * u + u + u + 1
    return y


def pan(m, p=0.0):
    a = (np.clip(p, -1, 1) + 1) * np.pi / 4
    return np.stack([m * np.cos(a), m * np.sin(a)]) * np.sqrt(2)


def stereo(x):
    x = np.asarray(x, dtype=float)
    return x if x.ndim == 2 else np.stack([x, x])


def tv_filter(x, gain_fn, nper=1024):
    """Time-varying linear filter in the STFT domain: gain_fn(f[:,None], t[None,:])."""
    x = np.asarray(x, dtype=float)
    n = x.shape[-1]
    hop = nper // 4
    f, tt, Z = signal.stft(x, fs=SR, window="hann", nperseg=nper, noverlap=nper - hop,
                           boundary="zeros", padded=True, axis=-1)
    Z = Z * gain_fn(np.maximum(f, 1.0)[:, None], tt[None, :])
    _, y = signal.istft(Z, fs=SR, window="hann", nperseg=nper, noverlap=nper - hop,
                        boundary=True, time_axis=-1, freq_axis=-2)
    y = y[..., :n]
    if y.shape[-1] < n:
        y = np.pad(y, [(0, 0)] * (y.ndim - 1) + [(0, n - y.shape[-1])])
    return y


def g_lowpass(f, fc, order=2, res=0.0):
    r = f / fc
    g = 1 / np.sqrt(1 + r ** (2 * order))
    if res:
        g = g * (1 + res * np.exp(-np.log2(np.maximum(r, 1e-6)) ** 2 / (2 * 0.18 ** 2)))
    return g


def g_highpass(f, fc, order=2):
    r = fc / f
    return 1 / np.sqrt(1 + r ** (2 * order))


def g_bandpass(f, fc, q, order=1):
    return (1 / np.sqrt(1 + (q * (f / fc - fc / f)) ** 2)) ** order


def place(buf, t0, sig, gain=1.0, max_len=None):
    s = stereo(sig)
    if max_len is not None and s.shape[1] > max_len:
        s = fade_tail(s[:, :max_len], 0.006)
    i0 = int(round(t0 * SR))
    a, b = max(i0, 0), min(i0 + s.shape[1], buf.shape[1])
    if b > a:
        buf[:, a:b] += gain * s[:, a - i0:b - i0]


# =============================================================== reverbs
IR_PRESETS = {
    "room": dict(dur=0.7, rt_lo=0.5, rt_hi=0.25, pre=0.004, build=0.004, lpf=9000, seed=11),
    "dark": dict(dur=1.8, rt_lo=1.4, rt_hi=0.32, pre=0.010, build=0.012, lpf=3200, seed=12),
    "plate": dict(dur=1.4, rt_lo=1.0, rt_hi=0.8, pre=0.002, build=0.003, lpf=10000, seed=13),
    "hall": dict(dur=4.0, rt_lo=3.0, rt_hi=1.4, pre=0.025, build=0.05, lpf=6000, seed=14),
}


@lru_cache(maxsize=None)
def ir(name):
    if name == "outdoor":
        return _ir_outdoor()
    p = IR_PRESETS[name]
    rng = np.random.default_rng(p["seed"])
    n = ns(p["dur"])
    t = tvec(n)
    out = np.zeros((2, n))
    for i, (lo, hi) in enumerate([(30, 250), (250, 1000), (1000, 4000), (4000, 16000)]):
        rt = p["rt_lo"] * (p["rt_hi"] / p["rt_lo"]) ** (i / 3)
        out += bp(rng.standard_normal((2, n)), lo, hi, 2) * np.exp(-6.91 * t / rt)
    out *= np.clip((t - p["pre"]) / p["build"], 0, 1) ** 2
    out = fade_tail(lp(out, p["lpf"], 2), 0.1)
    return _ir_norm(out)


def _ir_norm(h):
    """Scale an IR so its mean power gain over 80 Hz..8 kHz (log-spaced) is 1, so 'wet' means the
    same thing for a dark rumble tail as for a bright room."""
    nf = 1 << int(np.ceil(np.log2(h.shape[1])))
    H = np.abs(np.fft.rfft(h, nf, axis=-1)) ** 2
    f = np.fft.rfftfreq(nf, 1 / SR)
    idx = np.searchsorted(f, np.geomspace(80, 8000, 400))
    g = np.mean(H[:, idx])
    return h / np.sqrt(g)


def _ir_outdoor():
    """Open terrain: delayed rolling rumble + a few distant slap echoes."""
    rng = np.random.default_rng(21)
    n = ns(4.5)
    t = tvec(n)
    d = noise(n, rng, "pink", ch=2)
    lo = lp(d, 380, 2) * np.clip((t - 0.035) / 0.30, 0, 1) ** 1.5 * np.exp(-np.maximum(t - 0.25, 0) / 0.9)
    hi = lp(d, 2500, 2) * np.clip((t - 0.03) / 0.12, 0, 1) ** 1.5 * np.exp(-np.maximum(t - 0.12, 0) / 0.40)
    out = lo / np.sqrt(np.sum(lo ** 2)) + 0.45 * hi / np.sqrt(np.sum(hi ** 2))
    for delay, g, p, cut in [(0.085, 0.55, -0.5, 4000), (0.19, 0.42, 0.6, 3000), (0.33, 0.45, -0.25, 2200),
                             (0.52, 0.32, 0.7, 1600), (0.81, 0.26, -0.6, 1200), (1.25, 0.17, 0.3, 900),
                             (1.80, 0.10, -0.2, 700)]:
        bl = ns(0.04)
        b = lp(rng.standard_normal(bl) * np.exp(-tvec(bl) / 0.007), cut, 2)
        b = pan(b / np.sqrt(np.sum(b ** 2)) * g, p)
        i = ns(delay)
        out[:, i:i + bl] += b[:, :max(0, min(bl, n - i))]
    out = fade_tail(out, 0.3)
    return _ir_norm(out)


def reverb(x, name, wet, send_hp=None, send_lp=None, dry=1.0):
    xs = stereo(x)
    send = xs
    if send_hp:
        send = hp(send, send_hp, 2)
    if send_lp:
        send = lp(send, send_lp, 2)
    h = ir(name)
    n, m = xs.shape[1], h.shape[1]
    y = np.zeros((2, n + m - 1))
    y[:, :n] = dry * xs
    for c in range(2):
        y[c] += wet * signal.fftconvolve(send[c], h[c])
    return y


# =============================================================== SFX
def sfx_impact(rng, big=1.0, tail=1.0, pitch=1.0, sub=1.0):
    """Heavy slam: pitched sub thump + concrete knock + transient crack + debris + dark tail."""
    n = ns(0.45 + 0.9 * tail)
    t = tvec(n)
    f = (40 + 125 * np.exp(-t / 0.028)) * pitch
    thump = np.sin(osc_phase(f, n)) * att(t, 0.0012) * np.exp(-t / (0.10 + 0.12 * big * tail))
    thump = sat(1.6 * thump, 1.0)
    knock = bp(noise(n, rng, "pink"), 140 * pitch, 1100 * pitch, 2) * att(t, 0.0008) * np.exp(-t / 0.045)
    w = rng.standard_normal(n)
    crack = hp(w, 2200, 2) * np.exp(-t / 0.005) + 0.5 * bp(w, 700, 2600, 2) * np.exp(-t / 0.018)
    rum = lp(noise(n, rng, "brown"), 150, 2) * att(t, 0.015) * np.exp(-t / (0.10 + 0.32 * tail))
    grit = np.zeros(n)
    idx = (rng.exponential(0.09, rng.poisson(90 * tail + 20)) * SR).astype(int)
    idx = idx[idx < n]
    grit[idx] = rng.uniform(-1, 1, len(idx))
    grit = hp(grit, 3000, 2) * np.exp(-t / 0.15)
    dry = (1.0 * thump * sub + 0.55 * knock / peak(knock) + 0.5 * crack / peak(crack)
           + 0.32 * big * rum / peak(rum) + 0.07 * grit / peak(grit))
    dry = fade_tail(sat(dry / peak(dry) * 1.3, 1.0), 0.12)
    out = reverb(dry, "dark", wet=0.5 * tail, send_hp=180)
    return out / peak(out)


def sfx_sub_drop(rng):
    """Sine sweep ~80 -> 28 Hz, saturated so it reads on small speakers."""
    n = ns(2.8)
    t = tvec(n)
    f = 28 + 52 * np.exp(-t / 0.45)
    s = np.sin(osc_phase(f, n)) * att(t, 0.006) * np.exp(-t / 0.9)
    s = sat(2.2 * s, 1.0)
    s = s + 0.15 * s * s
    s = lp(hp(s, 22, 2), 520, 2)
    air = lp(noise(n, rng, "pink"), 280, 2) * att(t, 0.01) * np.exp(-t / 0.22)
    out = stereo(fade_tail(s / peak(s) + 0.12 * air / peak(air), 0.4))
    return out / peak(out)


def sfx_whoosh(rng, direction=1.0, peak_t=0.22, dur=0.62, bright=1.0):
    """Band-passed noise sweep, centre frequency peaks with the pass, pans across."""
    n = ns(dur)
    t = tvec(n)
    amp = np.where(t < peak_t, (t / peak_t) ** 2.4, np.exp(-(t - peak_t) / 0.085))

    def fc(tt):
        return 300 + 3300 * bright * np.exp(-((tt - peak_t) / 0.15) ** 2)

    y = tv_filter(noise(n, rng, "pink") * amp,
                  lambda f, tt: g_bandpass(f, fc(tt), 1.4) + 0.3 * g_lowpass(f, 260), nper=512)
    y2 = tv_filter(rng.standard_normal(n) * amp, lambda f, tt: g_bandpass(f, 1.8 * fc(tt), 5.0), nper=512)
    mono = y / peak(y) + 0.35 * y2 / peak(y2)
    out = pan(mono, direction * 0.85 * np.tanh((t - peak_t) / 0.1))
    out = reverb(fade_tail(out, 0.05), "room", 0.25)
    return out / peak(out)


def sfx_shot(rng):
    """Sniper: supersonic N-wave crack + muzzle blast boom + long outdoor tail."""
    n = ns(0.7)
    t = tvec(n)
    w = rng.standard_normal(n)
    crack = np.zeros(n)
    k = ns(0.0006)
    crack[:k] = np.linspace(1, -1, k)
    crack = hp(crack, 500, 2)
    crack = crack / peak(crack) + 0.6 * hp(w, 3000, 2) * np.exp(-t / 0.004) / 3
    f = 48 + 110 * np.exp(-t / 0.025)
    boom = sat(1.8 * np.sin(osc_phase(f, n)) * att(t, 0.001) * np.exp(-t / 0.16), 1.0)
    blast = lp(w, 1800, 2) * np.exp(-t / 0.035)
    body = bp(noise(n, rng, "pink"), 200, 2500, 2) * np.exp(-t / 0.06)
    dry = 0.9 * crack / peak(crack) + 1.0 * boom + 0.7 * blast / peak(blast) + 0.45 * body / peak(body)
    dry = fade_tail(sat(dry / peak(dry) * 1.8, 1.0), 0.2)
    out = reverb(dry, "outdoor", wet=0.16, send_lp=6000)
    out = fade_tail(out, 0.5)
    return out / peak(out)


def sfx_ricochet(rng, direction=-1.0):
    """Descending zing with growing vibrato, metallic tick at the start, pans across."""
    dur = 0.8
    n = ns(dur)
    t = tvec(n)
    fbase = 1250 + 3100 * np.exp(-t / 0.22)
    vib = 1 + 0.035 * np.sin(osc_phase(22 + 12 * t / dur, n)) * np.clip(t / 0.15, 0, 1)
    ff = fbase * vib
    ph = osc_phase(ff, n)
    tone = np.sin(ph) + 0.35 * np.sin(2 * ph + 0.3) + 0.12 * np.sin(3 * ph + 1.0)
    env = att(t, 0.004) * np.exp(-t / 0.3) * (0.6 + 0.4 * np.exp(-((t - 0.12) / 0.12) ** 2))
    tone = tone * env

    def fc(tt):
        return 1250 + 3100 * np.exp(-tt / 0.22)

    nz = tv_filter(rng.standard_normal(n) * env, lambda f, tt: g_bandpass(f, fc(tt), 6.0), nper=512)
    tick = np.zeros(n)
    for fr, a, dc in [(2900, 1.0, 0.012), (4400, 0.7, 0.009), (6100, 0.5, 0.006)]:
        tick += a * np.sin(TWO_PI * fr * t) * np.exp(-t / dc)
    tick += 0.6 * hp(rng.standard_normal(n), 3000, 2) * np.exp(-t / 0.002)
    mono = 0.7 * tone / peak(tone) + 0.4 * nz / peak(nz) + 0.45 * tick / peak(tick)
    out = pan(fade_tail(mono, 0.08), direction * np.linspace(-0.25, 0.9, n))
    out = reverb(out, "room", 0.3)
    return out / peak(out)


def _crush(x, bits, hold):
    if hold > 1:
        x = np.repeat(x[::hold], hold)[:len(x)]
    q = 2 ** (bits - 1)
    return np.round(x * q) / q


def sfx_glitch(rng, dur=0.4):
    """Bit-crushed, sample-held digital blips with stutter repeats and random panning."""
    n = ns(dur)
    out = np.zeros((2, n))
    pos, prev = 0, None
    while pos < n:
        L = ns(float(rng.choice([0.012, 0.018, 0.025, 0.035, 0.05])))
        kind = rng.choice(["tone", "noise", "stutter", "gap", "sweep"], p=[0.3, 0.25, 0.2, 0.1, 0.15])
        tt = tvec(L)
        if kind == "tone":
            fr = float(rng.choice([110, 220, 440, 660, 880, 1320, 1760, 2640]))
            seg = _crush(np.sign(np.sin(TWO_PI * fr * tt)) * 0.8, int(rng.integers(3, 6)), int(rng.integers(2, 9)))
        elif kind == "noise":
            seg = _crush(np.clip(rng.standard_normal(L) * 0.5, -1, 1), int(rng.integers(3, 6)),
                         int(rng.integers(4, 25)))
        elif kind == "sweep":
            fr = np.geomspace(float(rng.uniform(1500, 4000)), float(rng.uniform(100, 400)), L)
            seg = _crush(np.sin(osc_phase(fr, L)), 4, int(rng.integers(2, 6)))
        elif kind == "stutter" and prev is not None:
            reps = int(rng.integers(2, 5))
            seg = np.tile(prev, reps)
            L = len(seg)
        else:
            seg = np.zeros(L)
        seg = fade_tail(fade_head(seg * rng.uniform(0.4, 1.0), 0.0007), 0.0007)
        if kind != "gap":
            prev = seg[:ns(0.02)].copy()
        st = pan(seg, float(rng.uniform(-0.8, 0.8)))
        m = min(L, n - pos)
        out[:, pos:pos + m] += st[:, :m]
        pos += L
    t = tvec(n)
    th = ns(0.05)
    out[:, :th] += 0.7 * np.sign(np.sin(TWO_PI * 55 * t[:th])) * np.exp(-t[:th] / 0.015)
    out *= (1 - 0.5 * t / dur)
    out = fade_tail(lp(hp(out, 70, 2), 12000, 2), 0.01)
    return out / peak(out)


def sfx_riser(rng, dur=1.0):
    """Rising filtered noise + gliding detuned saws + accelerating tremolo, hard stop at the hit."""
    n = ns(dur)
    t = tvec(n)
    u = t / dur

    def fc(tt):
        return 250 * 40 ** (np.clip(tt / dur, 0, 1) ** 1.3)

    x = noise(n, rng, "pink", ch=2) * u ** 2.2
    nz = tv_filter(x, lambda f, tt: g_bandpass(f, fc(tt), 0.9), nper=1024)
    base = 146.83 * 2 ** (1.0 * u ** 2)
    tones = np.zeros((2, n))
    for cents, p in [(-12, -0.7), (-4, -0.2), (5, 0.25), (13, 0.7)]:
        tones += pan(saw(base * 2 ** (cents / 1200), n, rng.random()), p)
    tones += 0.5 * pan(saw(base * 2, n, rng.random()), 0.0)
    tones = tv_filter(tones * u ** 1.8, lambda f, tt: g_lowpass(f, 300 + 6000 * np.clip(tt / dur, 0, 1) ** 1.5, 2),
                      nper=1024)
    rate = 3 + 25 * u ** 2
    trem = 1 - 0.45 * u * (0.5 + 0.5 * np.sin(osc_phase(rate, n)))
    sub = np.sin(osc_phase(55 * 2 ** u, n)) * u ** 2.5
    out = (nz / peak(nz) + 0.55 * tones / peak(tones)) * trem + 0.25 * stereo(sub)
    out = fade_head(out, 0.05)
    out[:, -ns(0.004):] *= np.linspace(1, 0, ns(0.004))
    return out / peak(out)


def sfx_spray(rng, dur=1.45):
    """Spray-can hiss in puffs (nozzle presses), with a 'pssht' onset and droplet spit."""
    n = ns(dur + 0.1)
    t = tvec(n)
    m, s = rng.standard_normal(n), rng.standard_normal(n)
    x = np.stack([m + 0.35 * s, m - 0.35 * s])
    hiss = hp(x, 2000, 2)
    hiss = hiss + 0.8 * bp(x, 5000, 10000, 2)
    hiss = lp(hiss, 15000, 2)
    env = np.zeros(n)
    st = 0.0
    while st < dur - 0.1:
        en = min(st + rng.uniform(0.28, 0.55), dur)
        a = np.clip((t - st) / 0.012, 0, 1) * np.clip((en - t) / 0.035, 0, 1)
        a *= 1 + 0.35 * np.exp(-np.maximum(t - st, 0) / 0.05)
        env = np.maximum(env, a)
        st = en + rng.uniform(0.05, 0.11)
    flutter = lp(rng.standard_normal(n), 12, 2)
    env = env * (1 + 0.2 * flutter / peak(flutter))
    spit = np.zeros(n)
    k = rng.poisson(30 * dur)
    spit[rng.integers(0, n, k)] = rng.uniform(-1, 1, k)
    spit = hp(spit, 3000, 2) * env
    mono_spit = spit / peak(spit)
    out = hiss / peak(hiss) * env + 0.12 * stereo(mono_spit)
    p = np.linspace(-0.35, 0.35, n)
    a = (p + 1) * np.pi / 4
    out = np.stack([out[0] * np.cos(a), out[1] * np.sin(a)]) * np.sqrt(2)
    out = reverb(fade_tail(out, 0.03), "room", 0.12)
    return out / peak(out)


def sfx_click(rng):
    """Mechanical bolt click: two metal-resonator transients 38 ms apart + low knock."""
    n = ns(0.3)
    t = tvec(n)
    out = np.zeros(n)
    for t0, a, pt in [(0.0, 1.0, 1.0), (0.038, 0.7, 1.25)]:
        i = ns(t0) if t0 > 0 else 0
        tt = t[:n - i]
        e = np.zeros(n - i)
        for fr, aa, dc in [(1650, 0.8, 0.010), (2900, 1.0, 0.008), (4300, 0.7, 0.006),
                           (6800, 0.5, 0.004), (9100, 0.3, 0.003)]:
            e += aa * np.sin(TWO_PI * fr * pt * rng.uniform(0.97, 1.03) * tt + rng.random() * 6) * np.exp(-tt / dc)
        e += 0.8 * np.sin(TWO_PI * 160 * tt) * np.exp(-tt / 0.012)
        e += 0.9 * hp(rng.standard_normal(n - i), 3000, 2) * np.exp(-tt / 0.0015)
        out[i:] += a * e * att(tt, 0.0003)
    out = reverb(fade_tail(out, 0.05), "room", 0.12)
    return out / peak(out)


def _casing(rng, n, f0, bounces, p):
    t = tvec(n)
    ratios = np.array([1.0, 1.52, 2.17, 2.71, 3.46])
    amps = np.array([1.0, 0.7, 0.5, 0.35, 0.25])
    decs = np.array([0.22, 0.16, 0.11, 0.08, 0.05])
    out = np.zeros(n)
    for bt, ba, bd in bounces:
        i = ns(bt) if bt > 0 else 0
        if i >= n:
            continue
        tt = t[:n - i]
        e = 0.6 * hp(rng.standard_normal(n - i), 4000, 2) * np.exp(-tt / 0.002)
        for r, a, d in zip(ratios, amps * rng.uniform(0.5, 1.2, 5), decs * bd):
            e += a * np.sin(TWO_PI * f0 * r * tt + rng.random() * 6) * np.exp(-tt / d)
        out[i:] += ba * e * att(tt, 0.0002)
    return pan(out, p)


def sfx_shell(rng):
    """Brass casings: bright inharmonic partials, 3-5 bounces each, two casings."""
    n = ns(1.0)
    f0 = 3300 * (1 + 0.04 * rng.standard_normal())
    out = _casing(rng, n, f0, [(0, 1, 1), (0.19, 0.6, 0.8), (0.32, 0.38, 0.6), (0.40, 0.22, 0.5),
                               (0.45, 0.12, 0.4)], -0.25)
    off = ns(0.075)
    out[:, off:] += 0.6 * _casing(rng, n - off, f0 * 0.92, [(0, 1, 1), (0.16, 0.5, 0.7), (0.27, 0.25, 0.5)],
                                  0.35)
    out = reverb(fade_tail(out, 0.1), "room", 0.18)
    return out / peak(out)


def sfx_glass(rng):
    """Screen crack: crackle burst + low thunk + crystalline tinkles scattered in stereo."""
    n = ns(1.6)
    t = tvec(n)
    w = rng.standard_normal(n)
    crack = hp(w, 2500, 2) * np.exp(-t / 0.005)
    rate = 3000 * np.exp(-t / 0.05)
    imp = (rng.random(n) < rate / SR) * rng.uniform(-1, 1, n)
    crackle = lp(hp(imp, 1500, 2), 14000, 2)
    thunk = np.sin(TWO_PI * 140 * t) * np.exp(-t / 0.03)
    mono = crack / peak(crack) + 0.8 * crackle / peak(crackle) + 0.35 * thunk
    out = stereo(mono)
    shat = bp(rng.standard_normal((2, n)), 3000, 9000, 2) * np.exp(-t / 0.25) * att(t, 0.003)
    out += 0.25 * shat / peak(shat)
    times = np.sort(np.clip(rng.exponential(0.22, 55) + 0.02, 0, 1.3))
    for t0 in times:
        i = ns(t0)
        L = n - i
        tt = t[:L]
        e = np.zeros(L)
        for _ in range(int(rng.integers(2, 4))):
            e += np.sin(TWO_PI * rng.uniform(3000, 11000) * tt + rng.random() * 6) * np.exp(-tt / rng.uniform(0.015, 0.07))
        e *= 0.55 * np.exp(-t0 / 0.5) * rng.uniform(0.3, 1.0) * att(tt, 0.0004)
        out[:, i:] += pan(e, float(rng.uniform(-0.9, 0.9)))
    out = reverb(fade_tail(out, 0.1), "room", 0.25)
    return out / peak(out)


def sfx_beep(rng):
    """HUD double beep with a quiet ping-pong echo."""
    n = ns(0.75)
    t = tvec(n)
    mono = np.zeros(n)
    for t0, fr, d in [(0.0, 1760.0, 0.07), (0.1, 2349.3, 0.12)]:
        i = ns(t0) if t0 > 0 else 0
        L = ns(d)
        tt = t[:L]
        e = np.clip(tt / 0.002, 0, 1) * np.clip((d - tt) / 0.012, 0, 1)
        mono[i:i + L] += (np.sin(TWO_PI * fr * tt) + 0.18 * np.sin(3 * TWO_PI * fr * tt)) * e
    out = stereo(mono)
    for k, (dl, g) in enumerate([(0.15, 0.3), (0.30, 0.15)]):
        i = ns(dl)
        ch = k % 2
        out[ch, i:] += g * lp(mono[:n - i], 5000, 2)
    return out / peak(out)


def sfx_hum(rng, dur=3.0, flick=(0.15, 0.95)):
    """60 Hz neon / transformer hum with a failing-to-start flicker then a steady glow."""
    n = ns(dur)
    t = tvec(n)
    chans = []
    for c in range(2):
        h = np.zeros(n)
        for k in range(1, 31):
            a = (1.0 / k ** 0.9) * (1.4 if k % 2 else 1.0)
            h += a * np.sin(TWO_PI * 60 * k * t + rng.random() * 6 * (k > 3 or c == 0))
        chans.append(h)
    buzz = lp(np.stack(chans), 2600, 2)
    pulse = hp(np.abs(np.sin(TWO_PI * 60 * t)) ** 12, 300, 2)
    hum = 0.6 * buzz / peak(buzz) + 0.45 * stereo(pulse / peak(pulse)) + 0.25 * stereo(np.sin(TWO_PI * 60 * t))
    env = np.zeros(n)
    f0, f1 = flick
    pre = t < f0
    env[pre] = 0.12 * (t[pre] / max(f0, 1e-3))
    cur, on = f0, True
    zaps = []
    while cur < min(f1, dur):
        L = rng.uniform(0.03, 0.12) if on else rng.uniform(0.04, 0.14)
        m = (t >= cur) & (t < cur + L)
        env[m] = rng.uniform(0.6, 1.1) if on else rng.uniform(0.0, 0.1)
        if on:
            zaps.append(cur)
        cur += L
        on = not on
    rest = t >= cur
    drift = lp(rng.standard_normal(n), 0.6, 1)
    env[rest] = 0.72 * (1 + 0.12 * (drift / peak(drift))[rest])
    for _ in range(int(dur * 0.4)):
        d0 = rng.uniform(cur + 0.5, max(cur + 0.6, dur - 0.4))
        m = (t >= d0) & (t < d0 + rng.uniform(0.03, 0.07))
        env[m] *= 0.2
        zaps.append(d0 + 0.05)
    env = lp(env, 250, 1)
    out = hum * env
    for z in zaps:
        i = ns(z)
        L = min(ns(0.012), n - i)
        if L > 0:
            zp = hp(rng.standard_normal(L), 2000, 2) * np.exp(-tvec(L) / 0.003)
            out[:, i:i + L] += 0.5 * pan(zp, float(rng.uniform(-0.5, 0.5)))
    out = fade_tail(out, 0.25)
    return out / peak(out)


# =============================================================== music
D1, EB1, F1 = 36.71, 38.89, 43.65


def kick(rng):
    n = ns(0.45)
    t = tvec(n)
    f = 46 + 140 * np.exp(-t / 0.028)
    body = sat(1.6 * np.sin(osc_phase(f, n)) * att(t, 0.0008) * np.exp(-t / 0.17), 1.0)
    w = rng.standard_normal(n)
    clk = 0.4 * hp(w, 2500, 2) * np.exp(-t / 0.002) + 0.3 * bp(w, 1000, 4000, 2) * np.exp(-t / 0.008)
    return fade_tail(body + clk, 0.05)


def bass808(freq, dur):
    n = ns(dur)
    t = tvec(n)
    f = freq * (1 + 0.6 * np.exp(-t / 0.035))
    env = att(t, 0.003) * (0.3 + 0.7 * np.exp(-t / 0.16))
    s = sat(np.sin(osc_phase(f, n)) * env * 2.6, 1.0)
    s = lp(hp(s, 28, 2), 1100, 2)
    return fade_tail(s, min(0.015, dur * 0.3))


def snare(rng):
    n = ns(0.45)
    t = tvec(n)
    tone = 0.5 * np.sin(TWO_PI * 190 * t) * np.exp(-t / 0.05) + 0.3 * np.sin(TWO_PI * 330 * t) * np.exp(-t / 0.03)
    w = rng.standard_normal(n)
    nz = bp(w, 1200, 9000, 2) * np.exp(-t / 0.11)
    clap = np.zeros(n)
    for t0 in (0.0, 0.011, 0.023):
        i = ns(t0) if t0 > 0 else 0
        clap[i:] += np.exp(-t[:n - i] / 0.006)
    clap = bp(rng.standard_normal(n), 900, 5000, 2) * (clap + 0.5 * np.exp(-t / 0.09))
    s = tone + 0.8 * nz / peak(nz) + 0.7 * clap / peak(clap)
    out = reverb(fade_tail(s * att(t, 0.0005), 0.05), "plate", 0.3, send_hp=300)
    return out


def hat(rng, opn=False):
    n = ns(0.3 if opn else 0.07)
    t = tvec(n)
    m = np.zeros(n)
    for fr in (205.3, 304.4, 369.6, 522.7, 540.0, 800.0):
        m += np.sign(np.sin(TWO_PI * fr * t + rng.random() * 6))
    s = bp(m, 7000, 12000, 2) + 0.5 * hp(rng.standard_normal(n), 8000, 2)
    s *= np.exp(-t / (0.12 if opn else 0.018)) * att(t, 0.0003)
    return fade_tail(s / peak(s), 0.01)


def scene_roles(tl):
    names = [x[0] for x in tl]
    mi = next((i for i, n in enumerate(names) if "montage" in n), max(len(tl) - 2, 0))
    return 0, mi, len(tl) - 1


def music_bed(tl, cues, n):
    rng = np.random.default_rng(1234)
    t = tvec(n)
    end = n / SR
    i_intro, i_mont, i_fin = scene_roles(tl)
    intro = tl[i_intro]
    mont = tl[i_mont]
    fin = tl[i_fin]
    ms, me = mont[1], mont[1] + mont[2]
    fs = fin[1]
    pulse_s = tl[i_intro + 1][1] if i_intro + 1 < i_mont else ms
    fin_hits = sorted(c[0] for c in cues if c[2] == fin[0] and c[1] in ("impact", "sub_drop"))
    hit = fin_hits[0] if fin_hits else fs + 0.6
    out = np.zeros((2, n))

    # ---- drone: detuned saws, slow resonant low-pass motion
    drone = np.zeros((2, n))
    wob = lp(rng.standard_normal(n), 0.5, 1)
    wob = wob / peak(wob)
    for f, cents, p, a in [(D1, -6, -0.3, 0.28), (D1, 7, 0.3, 0.28), (2 * D1, -9, -0.65, 0.38),
                           (2 * D1, 10, 0.65, 0.38), (3 * D1, -4, -0.45, 0.22), (3 * D1, 5, 0.45, 0.22),
                           (4 * D1, -14, -0.8, 0.08), (4 * D1, 12, 0.8, 0.08)]:
        fr = f * 2 ** ((cents + 3 * wob) / 1200)
        drone += a * pan(saw(fr, n, rng.random()), p)

    def tension(tt):  # 0 in intro, ramps to 1 at the montage, steady after
        return np.clip((tt - pulse_s) / max(ms - pulse_s, 1e-3), 0, 1) ** 1.5

    def cutoff(tt):
        return 150 + 200 * (0.5 - 0.5 * np.cos(TWO_PI * tt / 11.0)) + 650 * tension(tt) * (tt < me) \
            + 500 * np.exp(-np.maximum(tt - hit, 0) / 0.8) * (tt >= hit)

    drone = tv_filter(drone, lambda f, tt: g_lowpass(f, cutoff(tt), 2, res=0.35), nper=4096)
    drone = hp(drone + 0.12 * stereo(np.sin(osc_phase(D1, n))), 30, 2)
    lvl = np.interp(t, [0, intro[1] + 0.2, min(intro[1] + 2.5, ms), pulse_s, ms - 0.01, ms, me - 0.01, me, hit,
                        hit + 0.3, end - 2.6, end - 0.5, end],
                    [0, 0, 0.75, 0.8, 1.0, 0.35, 0.35, 0.12, 0.12, 0.5, 0.45, 0.0, 0.0])
    drone *= lvl
    # ---- dark atmos (smoky void) through the pulse section
    atm = noise(n, rng, "pink", ch=2)
    atm = tv_filter(atm, lambda f, tt: g_bandpass(f, 380 + 220 * np.sin(TWO_PI * tt / 6.3), 0.9), nper=2048)
    atm *= np.interp(t, [pulse_s - 0.5, pulse_s + 1.0, ms - 0.4, ms], [0, 1, 1, 0])
    out += 0.18 * drone / peak(drone) + 0.03 * atm / peak(atm)

    # ---- tense pulse: 8ths locked to the montage grid, building into the montage
    pulse = np.zeros((2, n))
    eighth = BEAT / 2
    k0 = int(np.ceil((pulse_s - ms) / eighth))
    for k in range(k0, -1):  # stops one beat before the drop
        te = ms + k * eighth
        if te < pulse_s or te > ms - BEAT + 1e-6:
            continue
        u = (te - pulse_s) / max(ms - pulse_s, 1e-3)
        bar_pos = k % 8
        bar_no = (k // 8) % 4
        note = 2 * D1
        if bar_no == 3 and bar_pos >= 6:
            note = 2 * EB1
        L = ns(0.19)
        tt = tvec(L)
        v = saw(note, L, rng.random()) + saw(note * 1.006, L, rng.random()) + 0.6 * np.sin(osc_phase(note / 2, L))
        v = lp(v, 220 + 1500 * u ** 1.5, 2)
        v *= att(tt, 0.003) * np.exp(-tt / (0.06 + 0.06 * u))
        v = fade_tail(v, 0.02)
        acc = 1.0 if bar_pos % 2 == 0 else 0.68
        place(pulse, te, pan(v, 0.0), (0.25 + 0.75 * u) * acc)
        if u > 0.35:  # clock ticks on 16ths
            for sub in (0, 1):
                ts = te + sub * eighth / 2
                tl_ = ns(0.03)
                tk = bp(rng.standard_normal(tl_), 5000, 9000, 2) * np.exp(-tvec(tl_) / 0.004)
                place(pulse, ts, pan(tk, 0.35 if sub else -0.35), 0.5 * ((u - 0.35) / 0.65) ** 1.5 * (1.0 if sub == 0 else 0.6))
    out += 0.3 * pulse / peak(pulse)

    # ---- montage beat (150 BPM): kick on every cut, clap on 2/4, 16th hats, distorted 808
    beat = np.zeros((2, n))
    kicks = sorted(c[0] for c in cues if c[2] == mont[0] and c[1] == "impact")
    if not kicks:
        kicks = [ms + k * BEAT for k in range(int(mont[2] / BEAT + 1e-6))]
    duck = np.ones(n)
    pattern = [D1, D1, D1, D1, F1, F1, EB1, EB1]
    for j, tk in enumerate(kicks):
        k = int(round((tk - ms) / BEAT))
        place(beat, tk, kick(rng), 1.0)
        nxt = kicks[j + 1] if j + 1 < len(kicks) else me
        place(beat, tk, pan(bass808(pattern[k % len(pattern)], max(nxt - tk, 0.05)), 0.0), 0.3)
        if k % 2 == 1:
            place(beat, tk, snare(rng), 0.62)
        i = ns(tk)
        L = min(ns(0.35), n - i)
        if L > 0:
            duck[i:i + L] = np.minimum(duck[i:i + L], 1 - 0.65 * np.exp(-tvec(L) / 0.11) * att(tvec(L), 0.004))
    for j in range(int(mont[2] / (BEAT / 4) + 1e-6)):
        th = ms + j * BEAT / 4
        if th >= me - 0.02:
            break
        opn = j % 8 == 6
        vel = [1.0, 0.45, 0.75, 0.45][j % 4]
        place(beat, th, pan(hat(rng, opn), 0.25 if not opn else 0.15), (0.22 if opn else 0.16) * vel)
    gate = ((t >= ms - 0.002) & (t < me)).astype(float)
    gate = np.minimum(gate, np.clip((me - t) / 0.006, 0, 1))
    beat *= gate
    out *= duck
    out += 0.65 * beat

    # ---- end card: chord stab on the hit, then a wide pad that fades to silence
    pn = n - ns(hit)
    if pn > ns(0.5):
        tp = tvec(pn)
        dur_p = pn / SR
        pad = np.zeros((2, pn))
        for f, a, spread in [(2 * D1, 0.8, 0.2), (3 * D1, 0.6, 0.5), (4 * D1, 0.55, 0.7), (4 * 43.65 * 1.0, 0.45, 0.8),
                             (6 * D1, 0.35, 0.9), (329.63, 0.2, 0.95)]:
            for cents, side in [(-9, -1), (0, 0), (8, 1)]:
                pad += a * pan(saw(f * 2 ** (cents / 1200), pn, rng.random()), side * spread)

        def pcut(f, tt):
            fc = 900 + 3500 * np.exp(-tt / 0.3) + 300 * np.sin(TWO_PI * tt / 5.0)
            return g_lowpass(f, fc, 2, res=0.25)

        pad = tv_filter(pad, pcut, nper=2048)
        fade0, fade1 = max(dur_p - 2.8, 1.0), max(dur_p - 0.6, 1.2)
        fade = np.where(tp < fade0, 1.0, np.cos(np.clip((tp - fade0) / (fade1 - fade0), 0, 1) * np.pi / 2) ** 2)
        env = att(tp, 0.004) * (0.55 + 0.45 * np.exp(-tp / 0.5)) * (1 + 0.12 * np.sin(TWO_PI * 0.22 * tp)) * fade
        pad *= env
        sub = np.sin(osc_phase(D1, pn)) * att(tp, 0.01) * (0.4 + 0.6 * np.exp(-tp / 0.6)) * fade
        pad = hp(pad / peak(pad) + 0.15 * stereo(sub), 30, 2)
        pad = reverb(pad, "hall", 0.4, send_hp=150)[:, :pn]
        place(out, hit, 0.3 * pad / peak(pad))
    return out


# =============================================================== SFX bus
SFX_GAIN_DB = {
    "impact": -1.0, "sub_drop": -4.0, "whoosh": -8.0, "shot": 0.0, "ricochet": -10.0, "glitch": -11.0,
    "riser": -4.0, "spray": -9.0, "click": -7.0, "shell": -11.0, "glass": -4.0, "beep": -15.0, "hum": -19.0,
}


def sfx_bus(tl, cues, n):
    out = np.zeros((2, n))
    end = n / SR
    scene = {name: (s, d) for name, s, d in tl}
    _, i_mont, _ = scene_roles(tl)
    mont = tl[i_mont][0]
    hits = sorted(c[0] for c in cues if c[1] in ("impact", "shot"))
    subs = [c[0] for c in cues if c[1] == "sub_drop"]
    big_hits = [c[0] for c in cues if c[1] in ("impact", "shot", "glass", "sub_drop")]
    unknown = set()
    for t0, kind, sc in cues:
        rng = np.random.default_rng(zlib.crc32(f"{kind}@{t0:.3f}".encode()))
        s0, sd = scene.get(sc, (0.0, end))
        s_end = s0 + sd
        max_len = ns(s_end - t0) if sc == mont else None  # montage hard-cuts to black
        g = SFX_GAIN_DB.get(kind, -12.0)
        if kind == "impact":
            nxt = next((h for h in hits if h > t0 + 0.01), t0 + 10)
            pos, p = 0, t0
            while any(abs(h - (p - 0.2)) < 0.15 and h < p - 0.01 for h in hits) and pos < 6:
                p = max(h for h in hits if h < p - 0.01)
                pos += 1
            tail = float(np.clip((nxt - t0) / 1.0, 0.3, 1.0))
            big = 1.35 if any(abs(s - t0) < 0.03 for s in subs) else 1.0
            in_beat = sc == mont
            sub = 0.3 if in_beat else (1.0 if pos == 0 else 0.55)
            sig = sfx_impact(rng, big=big, tail=tail, pitch=2 ** (pos / 12), sub=sub)
            g += 1.0 if big > 1 else (-3.0 if in_beat else 0.0)
        elif kind == "sub_drop":
            sig = sfx_sub_drop(rng)
        elif kind == "whoosh":
            sig = sfx_whoosh(rng, direction=1.0)
        elif kind == "shot":
            sig = sfx_shot(rng)
        elif kind == "ricochet":
            sig = sfx_ricochet(rng, direction=-1.0)
        elif kind == "glitch":
            sig = sfx_glitch(rng, dur=float(np.clip(s_end - t0 - 0.05, 0.15, 0.4)))
        elif kind == "riser":
            nxt = next((h for h in sorted(big_hits) if h > t0 + 0.3), None)
            if nxt is None or nxt - t0 > 2.0:
                nxt = min(s_end, t0 + 1.2)
            sig = sfx_riser(rng, dur=float(np.clip(nxt - t0, 0.5, 2.0)))
        elif kind == "spray":
            sig = sfx_spray(rng, dur=float(np.clip(s_end - t0 - 0.2, 0.5, 1.15)))
        elif kind == "click":
            sig = sfx_click(rng)
        elif kind == "shell":
            sig = sfx_shell(rng)
        elif kind == "glass":
            sig = sfx_glass(rng)
        elif kind == "beep":
            sig = sfx_beep(rng)
        elif kind == "hum":
            sig = sfx_hum(rng, dur=float(np.clip(s_end - t0, 0.8, 8.0)))
        else:
            unknown.add(kind)
            continue
        place(out, t0, sig, undb(g), max_len=max_len)
    if unknown:
        print("warning: no SFX for cue kinds", sorted(unknown))
    return out


# =============================================================== master
def k_weight(x):
    b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285]
    a1 = [1.0, -1.69065929318241, 0.73248077421585]
    b2 = [1.0, -2.0, 1.0]
    a2 = [1.0, -1.99004745483398, 0.99007225036621]
    return signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=-1), axis=-1)


def _block_power(y, win, hop):
    cs = np.concatenate([np.zeros((y.shape[0], 1)), np.cumsum(y ** 2, axis=-1)], axis=-1)
    starts = np.arange(0, y.shape[1] - win + 1, hop)
    return np.sum((cs[:, starts + win] - cs[:, starts]) / win, axis=0), starts


def lufs_integrated(x):
    y = k_weight(stereo(x))
    if y.shape[1] < ns(0.4):
        return -120.0
    z, _ = _block_power(y, ns(0.4), ns(0.1))
    lk = -0.691 + 10 * np.log10(z + 1e-20)
    z = z[lk > -70]
    if not len(z):
        return -120.0
    rel = -0.691 + 10 * np.log10(np.mean(z)) - 10
    z = z[-0.691 + 10 * np.log10(z) > rel]
    return float(-0.691 + 10 * np.log10(np.mean(z)))


def lufs_max(x, win):
    y = k_weight(stereo(x))
    if y.shape[1] < ns(win):
        win = y.shape[1] / SR
    z, _ = _block_power(y, ns(win), ns(0.05))
    return float(-0.691 + 10 * np.log10(np.max(z) + 1e-20))


def true_peak(x):
    return peak(signal.resample_poly(stereo(x), 4, 1, axis=-1))


def bus_compress(x, thr_db, ratio=2.0, tau=0.05):
    p = np.mean(hp(x, 90, 2) ** 2, axis=0)
    a = np.exp(-1 / (tau * SR))
    env = signal.lfilter([1 - a], [1, -a], p)
    gr = np.maximum(0, 10 * np.log10(env + 1e-12) - thr_db) * (1 - 1 / ratio)
    gr = uniform_filter1d(maximum_filter1d(gr, ns(0.01)), ns(0.03))
    return x * undb(-gr), gr


def soft_clip(x, ceil, knee=0.7):
    a = knee * ceil
    ax = np.abs(x)
    y = np.where(ax <= a, ax, a + (ceil - a) * np.tanh((ax - a) / (ceil - a)))
    return np.sign(x) * y


def tp_envelope(x):
    """Per-sample peak including 4x-oversampled inter-sample peaks."""
    up = np.max(np.abs(signal.resample_poly(x, 4, 1, axis=-1)), axis=0)
    m = x.shape[1]
    pk = up[:4 * m].reshape(m, 4).max(axis=1)
    return np.maximum(pk, np.max(np.abs(x), axis=0))


def limiter(x, ceil, look=0.0025, rel_db_s=30.0):
    pk = tp_envelope(x)
    need = np.maximum(0, db(pk) - db(ceil))
    i = np.arange(len(need))
    d = rel_db_s / SR
    held = np.maximum.accumulate(need + i * d) - i * d
    w = 2 * ns(look) + 1
    held = uniform_filter1d(maximum_filter1d(held, w), w)
    y = x * undb(-held)
    return np.clip(y, -ceil, ceil), held


def master(music, sfx, n):
    t = tvec(n)
    end = n / SR
    # duck the bed under the SFX
    se = np.max(np.abs(sfx), axis=0)
    se = maximum_filter1d(se, ns(0.02))
    a = np.exp(-1 / (0.12 * SR))
    se = signal.lfilter([1 - a], [1, -a], se)
    sdb = db(se / (peak(sfx)))
    duck = undb(-np.clip((sdb + 24) * 0.35, 0, 6.0))
    mix = music * duck + sfx
    mix = hp(mix, 18, 2)
    mix -= np.mean(mix, axis=-1, keepdims=True)
    pre = float(undb(-20 - lufs_integrated(mix)))
    mix *= pre
    mix, gr = bus_compress(mix, thr_db=-23.0)
    fin = np.clip(t / 0.2, 0, 1)
    fin = (fin * fin * (3 - 2 * fin)) ** 1.5
    fo = np.cos(np.clip((t - (end - 0.75)) / 0.45, 0, 1) * np.pi / 2) ** 2
    fades = fin * fo
    g = TARGET_LUFS - lufs_integrated(mix * fades)
    ceil = undb(LIMIT_DB)
    for _ in range(8):
        y = soft_clip(mix * undb(g), undb(LIMIT_DB + 0.8), knee=0.72)
        y, held = limiter(y, ceil)
        y = y * fades
        L = lufs_integrated(y)
        if abs(L - TARGET_LUFS) < 0.1:
            break
        g += TARGET_LUFS - L
    tp = true_peak(y)
    if db(tp) > TP_CEIL_DB:
        y *= undb(TP_CEIL_DB - 0.05 - db(tp))
    y -= np.mean(y, axis=-1, keepdims=True) * fades
    return y, dict(comp_gr_max=float(np.max(gr)), lim_gr_max=float(np.max(held)), gain_db=float(g),
                   duck=duck, fades=fades, pre=pre)


def to_int16(y, fades, rng):
    d = (rng.random(y.shape) - rng.random(y.shape)) * (fades > 0)
    q = np.round(y * 32767 + d)
    return np.clip(q, -32768, 32767).astype(np.int16)


# =============================================================== report
def env_ms(x):
    """RMS envelope (5 ms window, >150 Hz so sub tails don't hide transients) sampled every 1 ms."""
    p = uniform_filter1d(np.mean(hp(stereo(x), 150, 2) ** 2, axis=0), ns(0.005))
    return np.sqrt(p[::48] + 1e-14)


GRADUAL = ("whoosh", "riser", "hum", "spray")
AMBIENT = ("hum",)  # starts under other sounds by design: reported, not flagged


def cue_check(mix, sfx, cues):
    em, es = env_ms(mix), env_ms(sfx)
    rows = []
    for t0, kind, sc in cues:
        i = int(round(t0 * 1000))
        r = []
        for e in (em, es):
            pre = np.median(e[max(i - 60, 0):max(i - 8, 1)]) if i > 10 else 1e-7
            post = np.max(e[i:i + 500]) if kind in GRADUAL else np.max(e[max(i - 2, 0):i + 60])
            r.append(20 * np.log10(post / max(pre, 1e-7)))
        a = max(i - 20, 0)
        seg = 20 * np.log10(es[a:i + 100])
        pre_db = 20 * np.log10(max(np.median(es[max(i - 60, 0):max(i - 8, 1)]), 1e-7)) if i > 10 else -140
        thr = pre_db + 0.5 * (np.max(seg) - pre_db)
        off = int(np.argmax(seg >= thr)) - (i - a)
        rows.append((t0, kind, sc, r[0], r[1], off))
    return rows


def _scene_marks(img, t0, t1, tl, cues, x0, w, y0, y1, label=True):
    import cv2
    cols = {"impact": (60, 255, 60), "sub_drop": (40, 160, 40), "whoosh": (255, 200, 80), "shot": (60, 60, 255),
            "ricochet": (200, 120, 255), "glitch": (255, 80, 255), "riser": (80, 220, 255), "spray": (180, 255, 180),
            "click": (255, 255, 255), "shell": (60, 200, 255), "glass": (255, 255, 160), "beep": (160, 160, 255),
            "hum": (120, 120, 120)}

    def X(tt):
        return int(x0 + (tt - t0) / (t1 - t0) * w)

    for name, s, d in tl:
        if t0 <= s <= t1:
            cv2.line(img, (X(s), y0), (X(s), y1), (230, 230, 230), 1)
            if label:
                cv2.putText(img, name, (X(s) + 4, y0 + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (230, 230, 230), 1)
    for k, (tc, kind, _) in enumerate(cues):
        if t0 <= tc <= t1:
            c = cols.get(kind, (200, 200, 200))
            cv2.line(img, (X(tc), y0 + 22), (X(tc), y1), c, 1)
            if label:
                cv2.putText(img, kind, (X(tc) + 2, y0 + 34 + 13 * (k % 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, c, 1)


def render_panel(y, sfx, music, tl, cues, t0, t1, path, width=2400):
    import cv2
    i0, i1 = int(t0 * SR), int(t1 * SR)
    seg = y[:, i0:i1]
    wh, sh, lh = 360, 520, 200
    img = np.full((wh + sh + lh, width, 3), 16, np.uint8)
    cols = np.linspace(0, seg.shape[1], width + 1).astype(int)[:-1]
    for ch in range(2):
        mx = np.maximum.reduceat(seg[ch], cols)
        mn = np.minimum.reduceat(seg[ch], cols)
        rms = np.sqrt(np.add.reduceat(seg[ch] ** 2, cols) / np.diff(np.append(cols, seg.shape[1])))
        cy = ch * wh // 2 + wh // 4
        hh = wh // 4 - 4
        for x in range(width):
            cv2.line(img, (x, int(cy - mx[x] * hh)), (x, int(cy - mn[x] * hh)), (90, 200, 120), 1)
            cv2.line(img, (x, int(cy - rms[x] * hh)), (x, int(cy + rms[x] * hh)), (150, 255, 190), 1)
        for lv in (undb(-1.0), -undb(-1.0)):
            cv2.line(img, (0, int(cy - lv * hh)), (width, int(cy - lv * hh)), (60, 60, 200), 1)
    mono = np.mean(seg, axis=0)
    f, tt, S = signal.spectrogram(mono, fs=SR, nperseg=2048, noverlap=2048 - 256, mode="magnitude")
    fq = np.geomspace(25, 20000, sh)
    idx = np.clip(np.searchsorted(f, fq), 0, len(f) - 1)
    Sd = 20 * np.log10(S[idx] + 1e-9)
    Sd = np.clip((Sd - (Sd.max() - 90)) / 90, 0, 1)
    spec = cv2.resize((Sd[::-1] * 255).astype(np.uint8), (width, sh), interpolation=cv2.INTER_AREA)
    img[wh:wh + sh] = cv2.applyColorMap(spec, cv2.COLORMAP_INFERNO)
    for fr in (50, 100, 500, 1000, 5000, 10000):
        yy = wh + sh - 1 - int(np.searchsorted(fq, fr))
        cv2.putText(img, f"{fr}", (4, yy), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (200, 200, 200), 1)
    # level lanes: sfx (green) vs music (blue), dBFS, 20 ms windows
    yb = wh + sh
    for st_, c in ((music, (255, 150, 60)), (sfx, (80, 255, 80))):
        s = st_[:, i0:i1]
        r = np.sqrt(np.add.reduceat(np.mean(s ** 2, axis=0), cols) / np.diff(np.append(cols, s.shape[1])))
        lv = np.clip((db(r) + 60) / 60, 0, 1)
        pts = np.stack([np.arange(width), (yb + lh - 4 - lv * (lh - 8)).astype(int)], 1)
        cv2.polylines(img, [pts.astype(np.int32)], False, c, 1)
    for d in (-12, -24, -36, -48):
        yy = int(yb + lh - 4 - (d + 60) / 60 * (lh - 8))
        cv2.line(img, (0, yy), (width, yy), (50, 50, 50), 1)
        cv2.putText(img, f"{d}", (4, yy - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (150, 150, 150), 1)
    _scene_marks(img, t0, t1, tl, cues, 0, width, 0, wh + sh + lh)
    cv2.imwrite(path, img)


def report(y, sfx, music, tl, cues, info, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    n = y.shape[1]
    print("\nscene            start   dur   peak dBFS   TP dBFS   RMS dBFS   maxST LUFS   maxM LUFS")
    for name, s, d in tl:
        a, b = ns(s), min(ns(s + d), n)
        seg = y[:, a:b]
        print(f"{name:15s} {s:6.2f} {d:5.2f}   {db(peak(seg)):9.2f} {db(true_peak(seg)):9.2f}"
              f"   {db(np.sqrt(np.mean(seg ** 2))):8.2f}   {lufs_max(seg, 3.0):10.2f}  {lufs_max(seg, 0.4):10.2f}")
    print(f"\nintegrated {lufs_integrated(y):.2f} LUFS | sample peak {db(peak(y)):.2f} dBFS | true peak "
          f"{db(true_peak(y)):.2f} dBTP | DC L/R {np.mean(y[0]):+.1e} {np.mean(y[1]):+.1e}")
    print(f"first 0.1 s RMS {db(np.sqrt(np.mean(y[:, :ns(0.1)] ** 2))):.1f} dBFS | last 0.3 s RMS "
          f"{db(np.sqrt(np.mean(y[:, -ns(0.3):] ** 2))):.1f} dBFS | edge samples {y[:, 0]} {y[:, -1]}")
    print(f"bus comp max GR {info['comp_gr_max']:.1f} dB | limiter max GR {info['lim_gr_max']:.1f} dB | "
          f"make-up {info['gain_db']:+.1f} dB | bed ducking max {-db(np.min(info['duck'])):.1f} dB")
    print("\ncue check (rise = level jump at cue vs just before; onset = steepest rise vs cue, ms)")
    print("   t     kind      scene          mix dB  sfx dB  onset")
    bad = 0
    for t0, kind, sc, rm, rs, off in cue_check(y, sfx, cues):
        flag = ""
        if kind not in AMBIENT and (rs < 3 or (kind not in GRADUAL and abs(off) > 15)):
            flag = "  <-- check"
            bad += 1
        print(f"{t0:6.2f}  {kind:9s} {sc:14s} {rm:6.1f}  {rs:6.1f}  {off:+5d}{flag}")
    print(f"{len(cues) - bad}/{len(cues)} cues OK")
    end = n / SR
    render_panel(y, sfx, music, tl, cues, 0, end, os.path.join(out_dir, "overview.png"))
    for k, (name, s, d) in enumerate(tl):
        render_panel(y, sfx, music, tl, cues, max(s - 0.15, 0), min(s + d + 0.15, end),
                     os.path.join(out_dir, f"scene{k + 1}_{name}.png"), width=1800)
    print("images in", out_dir)


# =============================================================== main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "audio.wav"))
    ap.add_argument("--report", default=None, help="directory for waveform/spectrogram PNGs + checks")
    args = ap.parse_args()
    t_start = time.time()
    tl, cues, total, fps, notes = load_timeline()
    for m in notes:
        print(m)
    n_frames = int(round(total * fps))
    n = int(round(n_frames * SR / fps))
    print(f"{len(tl)} scenes, {len(cues)} cues, {total:.3f} s -> {n_frames} frames @ {fps} fps = {n} samples")
    sfx = sfx_bus(tl, cues, n)
    music = music_bed(tl, cues, n)
    y, info = master(music, sfx, n)
    pcm = to_int16(y, info["fades"], np.random.default_rng(99))
    wavfile.write(args.out, SR, pcm.T.copy())
    print(f"wrote {args.out}  ({n / SR:.3f} s, {time.time() - t_start:.1f} s)")
    if args.report:
        g = undb(info["gain_db"]) * info["pre"]
        yq = pcm.astype(np.float64) / 32767
        report(yq, sfx * g * info["fades"], music * info["duck"] * g * info["fades"], tl, cues, info, args.report)


if __name__ == "__main__":
    main()
