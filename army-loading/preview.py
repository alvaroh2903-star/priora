"""Preview frames of one scene (with the global post applied).

    python3 preview.py s3_slam                      # 10 evenly spaced stills + contact sheet
    python3 preview.py s3_slam --times 0.2 0.5 1.4  # specific local times
    python3 preview.py s3_slam --strip 0.4 0.9 8    # 8 consecutive-ish frames 0.4..0.9 s (motion check)
    python3 preview.py s3_slam --mp4                # draft mp4 of the scene (960x540)

Outputs go to $PREVIEW_DIR (default ./previews)/<scene>/ ; it prints the paths.
Open the PNGs / sheet.jpg with an image viewer to judge the result.
"""
import importlib
import os
import subprocess
import sys
import time

import cv2
import numpy as np

import build
from lib import FPS, H, W

OUT = os.environ.get("PREVIEW_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "previews"))


def render(mod, t, gi_base=0):
    gi = gi_base + int(round(t * FPS))
    ctx = {"frame": gi, "local_frame": int(round(t * FPS)), "seed": gi, "global_t": t}
    return build.post(mod.render(min(t, mod.DUR - 1e-6), ctx).astype(np.float32), gi)


def sheet(paths, out, cols=5, w=576):
    ims = [cv2.imread(p) for p in paths]
    ims = [cv2.resize(i, (w, int(w * H / W))) for i in ims]
    for i, p in zip(ims, paths):
        cv2.putText(i, os.path.basename(p)[:-4], (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
    while len(ims) % cols:
        ims.append(np.zeros_like(ims[0]))
    rows = [np.hstack(ims[r * cols:(r + 1) * cols]) for r in range(len(ims) // cols)]
    cv2.imwrite(out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88])
    return out


def main():
    name = sys.argv[1]
    mod = importlib.import_module("scenes." + name)
    d = os.path.join(OUT, name)
    os.makedirs(d, exist_ok=True)
    args = sys.argv[2:]
    if "--mp4" in args:
        out = os.path.join(d, name + ".mp4")
        p = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "960x540", "-r", str(FPS),
                              "-i", "-", "-c:v", "libx264", "-crf", "24", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
        for i in range(int(round(mod.DUR * FPS))):
            f = cv2.resize(render(mod, i / FPS), (960, 540), interpolation=cv2.INTER_AREA)
            p.stdin.write(f.astype(np.uint8).tobytes())
        p.stdin.close()
        p.wait()
        print(out)
        return
    if "--times" in args:
        times = [float(x) for x in args[args.index("--times") + 1:] if not x.startswith("--")]
        tag = "t"
    elif "--strip" in args:
        i = args.index("--strip")
        a, b, n = float(args[i + 1]), float(args[i + 2]), int(args[i + 3])
        times = list(np.linspace(a, b, n))
        tag = "s"
    else:
        times = list(np.linspace(0.05, mod.DUR - 0.05, 10))
        tag = "t"
    paths = []
    t0 = time.time()
    for t in times:
        f = render(mod, t)
        p = os.path.join(d, f"{tag}_{t:06.3f}.png")
        cv2.imwrite(p, cv2.cvtColor(f.astype(np.uint8), cv2.COLOR_RGB2BGR))
        paths.append(p)
    print(f"rendered {len(times)} frames in {time.time() - t0:.1f}s ({(time.time() - t0) / len(times):.2f}s/frame)")
    for p in paths:
        print(p)
    print("sheet:", sheet(paths, os.path.join(d, f"sheet_{tag}.jpg")))


if __name__ == "__main__":
    main()
