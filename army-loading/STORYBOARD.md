# ARMY — loading screen (FiveM PvP server)

1920x1080, 30 fps, ~27 s, loops (ends on black, starts on black).
Rendered procedurally in Python (numpy + OpenCV + Pillow): `lib.py` is the
shared toolkit, each scene lives in `scenes/<name>.py`, `build.py` stitches
them and applies the shared film finish (grain, vignette, slight chroma).

## Brief

The client's feedback on the first version: *"you just put the artworks on
screen and that's it — I want something with the AESTHETIC of the artworks"*.
So this is **original motion design**, not a slideshow. Static brand art may
appear only as a heavily animated plate where a scene below says so. The
sniper poster (`ref/1.webp`) is **style reference only and must never appear
in the video**.

## Visual language (from the brand art)

- Near-black backgrounds (`INK`), worn concrete / print grit, cracks.
- **Toxic green** `GREEN (155,230,70)` is the only accent. Casing green
  `GREEN_DK`. Off-white / bone `BONE` for distressed type, `WHITE` for logo.
- **Huge condensed distressed headline type** (Anton), bone coloured, eroded
  with grunge + halftone texture, filling the frame edge to edge — like
  "UM TIRO. UMA BAIXA." in the sniper poster.
- **Halftone dot fields** fading in from the frame corners.
- **Green spray paint**: graffiti tags with drips running down, splatter,
  speckle mist ("ARMY" tag, graffiti star).
- **Hand-drawn green sniper reticle** (rough circle + cross + ticks).
- Small all-caps captions in tight blocks (Oswald/Bebas), e.g.
  "PACIÊNCIA, / POSIÇÃO / E PRECISÃO." and "O SILÊNCIO / TAMBÉM / ELIMINA."
- The **ARMY wordmark** (A + bullet in motion) is the hero. Tagline:
  "SKILL IS THE ONLY ADVANTAGE" with ONLY in green.
- Thin green anamorphic light line along the bottom.
- Motion feel: heavy, punchy, military. Hard cuts, slams with camera shake
  that decays fast, short glitch bursts, slow drifts between hits. Nothing
  floaty or corporate. No rainbow colours, no purple/pink, no VHS timecodes.

## Timeline

| # | file | dur | content |
|---|------|-----|---------|
| 1 | s1_ignite  | 3.0 | Logo icon ignition |
| 2 | s2_bullet  | 3.0 | Bullet flight macro → screen cracks |
| 3 | s3_slam    | 4.5 | Kinetic headline "UM TIRO. / UMA BAIXA." + spray tag |
| 4 | s4_crt     | 5.0 | CRT room plate (client image) — push-in, dive into the screen |
| 5 | s5_montage | 4.0 | Rapid-cut kinetic word montage |
| 6 | s6_final   | 7.5 | ARMY wordmark assembly, hold, fade to black (loop) |

### 1 · s1_ignite (3.0 s)
Black. Faint halftone dots breathe in from the corners. The **logo_icon**
(A with bullet) flickers on like a neon sign failing to start: 2–3 stuttering
flickers (0.2–0.9 s) then holds lit, green bloom around the bullet, white A
slightly hot. Short glitch burst ~0.9 s. Slow push-in (scale 1.0→1.08). At
~2.3 s the bullet trembles (click), at 2.6 s it **fires out of the A to the
right**: muzzle flash bloom, green streaks smear, A shakes, cut on 3.0 s with
the frame mostly white-green flash so it hands off to scene 2.
CUES: hum 0.0, glitch 0.9, click 2.3, shot 2.6.

### 2 · s2_bullet (3.0 s)
Macro slow-motion bullet flight. The **logo_bullet** scaled big (≈900–1100 px
long) travels left→right across a dark smoky void, slight roll/wobble, long
green speed streaks + motion-blurred trail, conical shock rings rippling off
the tip, sparks/flecks, drifting smoke parted by its wake. Military stencil
HUD type (Black Ops One / Oswald) slides past at different parallax speeds:
".50 BMG", "853 M/S", "DIST 1.240 M", a ruler/tick scale. The camera tracks
then the bullet turns toward camera and **hits the lens at ~2.65 s**: white
flash, radial crack pattern (crack_mask) spreading over the frame, shards of
green light, heavy shake. Hold the cracked frame briefly then cut.
CUES: whoosh 0.1, ricochet 1.3, glass 2.65, impact 2.65.

### 3 · s3_slam (4.5 s)
Opens on the cracked black frame (cracks faintly visible, fading).
"UM TIRO." **slams** in at 0.3 s — huge Anton bone type spanning ~90 % of
the width, distressed + halftone textured, scale 1.25→1.0 with a hard stop,
dust puff, decaying shake. "UMA BAIXA." slams under it at 1.2 s. Halftone
corners pulse on each hit. At 2.0 s a **green graffiti "ARMY" tag sprays on**
diagonally across the lower right of the headline (graffiti/marker font,
revealed by a moving spray front with mist, then drips run down 2.2–4.0 s).
Side caption blocks type in at 2.6–3.3 s: left "PACIÊNCIA, / POSIÇÃO / E
PRECISÃO.", right "O SILÊNCIO / TAMBÉM / ELIMINA." A hand-drawn green
reticle snaps onto the "O" of TIRO at 3.4 s (click) and tightens. Slow drift
push-in the whole time. 4.2–4.5 s: whip-pan/smear out to the right.
CUES: impact 0.3, impact 1.2, spray 2.0, click 3.4, whoosh 4.2.

### 4 · s4_crt (5.0 s) — waits on the client's CRT-room image
Client image: a dark bunker with stacked old CRT monitors showing the ARMY
logo, neon tube lights, a masked soldier in the background, all green-lit.
Animate it as a living plate: slow push-in with parallax, neon tube flicker,
CRT screens flicker + scanlines + the logo on the main screen re-rendered and
glitching, drifting smoke, then the camera **dives into the main screen**
(zoom to its rectangle, CRT curvature, white flash) to cut to scene 5.
CUES: hum 0.0, beep 1.0, glitch 2.2, riser 3.6, whoosh 4.6.

### 5 · s5_montage (4.0 s)
Rapid-cut kinetic montage on a beat grid of 0.4 s (10 hits). Each card is
full-frame and graphic, alternating backgrounds (black with halftone /
full-bleed green with black type / bone-grey concrete with black type):
"PVP" · "SEM REGRAS" · "SÓ SKILL" · "PACIÊNCIA." · "POSIÇÃO." · "PRECISÃO."
· ammo counter "30 → 0" with brass casings flying · kill-feed style strip
("ARMY ▸ ✕ ▸ ELIMINADO") · reticle lock · last card "O SILÊNCIO TAMBÉM
ELIMINA." typed letter by letter, then hard cut to black at 4.0 s.
Every card has its own micro-motion (scale punch, slide, shake, spray
splatter) — never a static card.
CUES: impact at every cut (0.0, 0.4, 0.8 … 3.2), shell 2.4, click 3.2.

### 6 · s6_final (7.5 s)
Hero end card on a living background: worn concrete black, halftone corners,
drifting green-tinted smoke, green spray splatters popping in, thin green
light line along the bottom. 0.2 s: the **bullet flies in from the left**
with streaks and lands in its spot in the A; letters **A R M Y slam in one by
one** (0.6, 0.8, 1.0, 1.2 s) each with dust burst + short shake; green glow
pulse. 1.8 s: "SKILL IS THE ONLY ADVANTAGE" reveals under it (ONLY in
green). 2.2 s: a green graffiti star with "ARMY" tag sprays on at top-right
with drips. Reticle sweeps in from off-screen, frames the logo, and fades.
Then an idle hold with subtle life (glow breathing, smoke, occasional tiny
glitch) and a small "CONECTANDO AO SERVIDOR" caption with an animated
progress bar at bottom. 6.8 s glitch, 6.9–7.5 s collapse/fade to pure black
so the loop restarts cleanly on scene 1's black.
CUES: whoosh 0.2, impact 0.6, impact 0.8, impact 1.0, impact 1.2,
sub_drop 0.6, spray 2.2, glitch 6.8.
