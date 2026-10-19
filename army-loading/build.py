"""Render the full ARMY loading-screen video.

    python3 build.py [out.mp4] [--fast]    # --fast: 960x540 draft encode

Scenes are concatenated in SCENES order; each owns its own in/out
transitions. Global post (grain, vignette, light chroma) is applied here so
every scene shares the same film finish. If audio.wav exists next to this
file it is muxed in.
"""
import importlib
import math
import os
import subprocess
import sys

import cv2
import numpy as np

import lib
from lib import FPS, H, W

SCENES = ["s1_ignite", "s2_bullet", "s3_slam", "s4_scope", "s5_montage", "s6_final"]


def load_scenes():
    return [importlib.import_module("scenes." + s) for s in SCENES]


def timeline():
    """[(name, start_seconds, dur)] and absolute cue list for the audio track."""
    t = 0.0
    tl, cues = [], []
    for name, mod in zip(SCENES, load_scenes()):
        tl.append((name, t, mod.DUR))
        for ct, kind in getattr(mod, "CUES", []):
            cues.append((round(t + ct, 3), kind, name))
        t += mod.DUR
    return tl, sorted(cues), t


_yy = np.linspace(-1, 1, H, dtype=np.float32)[:, None]
_xx = np.linspace(-1, 1, W, dtype=np.float32)[None, :]
VIGNETTE = np.clip(1 - 0.38 * ((_xx * 0.9) ** 2 + _yy ** 2) ** 1.4, 0, 1)[..., None]


def post(frame, gi):
    """Shared film finish. gi = global frame index (seeds the grain)."""
    rng = np.random.default_rng(1000 + gi)
    f = lib.chroma(frame, 2)
    f = f * VIGNETTE
    g = rng.normal(0, 1, (H // 2, W // 2)).astype(np.float32)
    g = cv2.resize(g, (W, H), interpolation=cv2.INTER_LINEAR)
    f = f + g[..., None] * 7.0
    # occasional dust specks
    if rng.random() < 0.35:
        for _ in range(rng.integers(1, 4)):
            x, y = int(rng.integers(0, W)), int(rng.integers(0, H))
            r = int(rng.integers(1, 3))
            v = 200 if rng.random() < 0.5 else -80
            cv2.circle(f, (x, y), r, (v, v, v) if v > 0 else (10, 10, 10), -1, cv2.LINE_AA)
    return np.clip(f, 0, 255)


def render_frame(mods, tl, gi):
    t = gi / FPS
    for (name, start, dur), mod in zip(tl, mods):
        if t < start + dur or mod is mods[-1]:
            lt = min(t - start, dur - 1e-6)
            ctx = {"frame": gi, "local_frame": int(round(lt * FPS)), "seed": gi, "global_t": t}
            return post(mod.render(lt, ctx).astype(np.float32), gi)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    fast = "--fast" in sys.argv
    out = args[0] if args else os.path.join(lib.ROOT, "army_loading.mp4")
    mods = load_scenes()
    tl, cues, total = timeline()
    n = int(round(total * FPS))
    ow, oh = (960, 540) if fast else (W, H)
    tmp = out + ".video.mp4"
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{ow}x{oh}", "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-preset", "medium" if fast else "slow", "-crf", "26" if fast else "20",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for gi in range(n):
        f = render_frame(mods, tl, gi)
        if fast:
            f = cv2.resize(f, (ow, oh), interpolation=cv2.INTER_AREA)
        p.stdin.write(f.astype(np.uint8).tobytes())
        if gi % 60 == 0:
            print(f"frame {gi}/{n}", flush=True)
    p.stdin.close()
    p.wait()
    wav = os.path.join(lib.ROOT, "audio.wav")
    if os.path.exists(wav):
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", tmp, "-i", wav, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                        "-shortest", out], check=True)
        os.remove(tmp)
    else:
        os.replace(tmp, out)
    print("wrote", out, f"{total:.2f}s")


if __name__ == "__main__":
    main()
