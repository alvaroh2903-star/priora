"""PLACEHOLDER — replaced once the client's CRT-room image is available."""
from lib import *

DUR = 5.0
CUES = [(0.0, "hum"), (1.0, "beep"), (2.2, "glitch"), (3.6, "riser"), (4.6, "whoosh")]


def render(t, ctx):
    f = blank()
    over_center(f, text_layer("CRT ROOM (PENDING IMAGE)", "oswald", 60, GREY), W / 2, H / 2)
    return f
