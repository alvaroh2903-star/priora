import numpy as np, subprocess, sys, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter
IMG=sys.argv[1]; OUT=sys.argv[2]
W,H,FPS,DUR=1280,720,30,22.0
N=int(FPS*DUR); rng=np.random.default_rng(7)
G=(155,230,70)
def F(sz,b=True):
    return ImageFont.truetype("/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf" if b else "/usr/share/fonts/opentype/inter/Inter-SemiBoldItalic.otf",sz)
def fit(im,scale=1.0,dx=0,dy=0):
    s=max(W/im.width,H/im.height)*scale
    r=im.resize((int(im.width*s)+1,int(im.height*s)+1),Image.LANCZOS)
    x=(r.width-W)//2+int(dx); y=(r.height-H)//2+int(dy)
    return np.asarray(r.crop((x,y,x+W,y+H)).convert("RGB")).astype(np.float32)
a1=Image.open(f"{IMG}/1.webp").convert("RGB"); a3=Image.open(f"{IMG}/3.webp").convert("RGB")
a2=Image.open(f"{IMG}/2.png").convert("RGB")
icon=a2.crop((1700,440,1885,620)).resize((260,253),Image.LANCZOS)
mark=a2.crop((80,400,1490,680))
# icon mask (non-dark)
ia=np.asarray(icon).astype(np.float32); imask=(ia.max(2)>60).astype(np.float32)[...,None]
small=a2.crop((1700,440,1885,620)).resize((54,52),Image.LANCZOS)
# precomputed sequences of zoom for art
def chroma(f,k):
    if k<0.5: return f
    k=int(k); o=f.copy(); o[:,k:,0]=f[:,:-k,0]; o[:,:-k,2]=f[:,k:,2]; return o
def glitch(f,amt):
    o=f.copy()
    for _ in range(int(6+amt*14)):
        y=rng.integers(0,H-10); h=rng.integers(4,int(20+60*amt)); s=int(rng.normal(0,80*amt))
        o[y:y+h]=np.roll(f[y:y+h],s,axis=1)
        if rng.random()<0.3: o[y:y+h]*=np.array([0.6,1.2,0.6])
    return o
yy=np.linspace(-1,1,H)[:,None]; xx=np.linspace(-1,1,W)[None,:]
vign=np.clip(1-0.45*(xx**2+yy**2)**1.3,0,1)[...,None].astype(np.float32)
scan=(0.86+0.14*(np.arange(H)%3!=0))[:,None,None].astype(np.float32)
# HUD overlay
def hud_layer(t):
    L=Image.new("RGBA",(W,H)); d=ImageDraw.Draw(L)
    d.rectangle((28,640,190,694),outline=(235,235,235,220),width=2)
    d.rectangle((34,646,66,688),fill=(235,235,235,230)); d.text((41,647),"R",font=F(34),fill=(0,0,0,255))
    d.text((74,648),"RESTRICTED · PVP",font=F(11),fill=(235,235,235,220))
    d.text((74,664),"COMBAT READY",font=F(11),fill=(235,235,235,200))
    d.text((74,678),"ARMY ROLEPLAY",font=F(9),fill=(200,200,200,190))
    if int(t*2)%2==0: d.ellipse((W-200,40,W-188,52),fill=(230,40,40,230)); 
    d.text((W-180,36),"PLAY ▶",font=F(18),fill=(235,235,235,220))
    m=int(t)//60;s=int(t)%60;fr=int(t*30)%30
    d.text((40,34),f"SP  0:{m:02d}:{s:02d}:{fr:02d}",font=F(18),fill=(235,235,235,210))
    return L
smallmask=small.convert("L").point(lambda v:255 if v>60 else 0)
def title_card(t):  # t local seconds
    im=Image.new("RGB",(W,H),(12,13,14)); d=ImageDraw.Draw(im)
    # diagonal green/white stripes bottom left like the reference
    for i,c in enumerate([(155,230,70),(95,140,45),(230,230,230)]):
        off=i*26; p=min(1,t/0.8)
        d.polygon([(-40,H-60+off-int(300*p)),(int(700*p),H+300),(int(700*p)+24,H+300),(-40,H-36+off-int(300*p))],fill=c)
    mw=int(W*0.78); mh=int(mark.height*mw/mark.width)
    mk=mark.resize((mw,mh),Image.LANCZOS)
    reveal=min(1,max(0,(t-0.2)/0.5))
    x0=(W-mw)//2-20; y0=250
    if reveal>0:
        cw=int(mw*reveal); im.paste(mk.crop((0,0,cw,mh)),(x0,y0))
    ft=F(22); fs=F(12)
    tl=["SUPER VHS 26","FIVEM · PVP","SEASON 01","INSANE"]
    if t>0.6:
        xs=[x0+10,x0+250,x0+520,x0+mw-150]
        for x,s in zip(xs,tl): d.text((x,y0-50),s,font=ft,fill=(225,225,225))
        bl=["SKILL IS THE","ONLY","ADVANTAGE","CREW","ARMY · 2026"]
        xs=[x0+10,x0+215,x0+305,x0+520,x0+mw-170]
        for x,s in zip(xs,bl): d.text((x,y0+mh+22),s,font=ft,fill=G if s=="ONLY" else (225,225,225))
        d.text((x0+10,y0-22),"RECOMMENDED FOR SURVIVORS · NO MERCY",font=fs,fill=(150,150,150))
        d.text((x0+520,y0+mh+52),"CONECTANDO AO SERVIDOR...",font=fs,fill=(150,150,150))
    return np.asarray(im).astype(np.float32)
p=subprocess.Popen(["ffmpeg","-y","-v","error","-f","rawvideo","-pix_fmt","rgb24","-s",f"{W}x{H}","-r",str(FPS),"-i","-",
  "-c:v","libx264","-preset","slow","-crf","18","-pix_fmt","yuv420p","-movflags","+faststart",OUT],stdin=subprocess.PIPE)
for i in range(N):
    t=i/FPS; g=0; ch=2
    if t<2.6:  # logo intro
        f=np.zeros((H,W,3),np.float32)
        a=min(1,t/0.8)*(0.75+0.25*rng.random()) * (1 if t<2.2 else max(0,1-(t-2.2)/0.4))
        sc=1+0.05*t; ic=icon.resize((int(260*sc),int(253*sc)))
        ia=np.asarray(ic).astype(np.float32); m=(ia.max(2)>60)[...,None]
        y=(H-ia.shape[0])//2;x=(W-ia.shape[1])//2
        glow=np.asarray(Image.fromarray((ia*m).astype(np.uint8)).filter(ImageFilter.GaussianBlur(18))).astype(np.float32)
        f[y:y+ia.shape[0],x:x+ia.shape[1]]=(ia*m)*a+glow*1.4*a
        ch=6+4*math.sin(t*9); g=0.3 if rng.random()<0.12 else 0
    elif t<3.4:  # CRT on
        u=(t-2.6)/0.8; f=np.zeros((H,W,3),np.float32)
        hh=int(4+ (H/2)*u**3); ww=int(W*min(1,u*3))
        f[H//2-hh:H//2+hh,(W-ww)//2:(W+ww)//2]=235
        f=np.asarray(Image.fromarray(f.astype(np.uint8)).filter(ImageFilter.GaussianBlur(6))).astype(np.float32)
        f[...,1]*=1.03; g=0.2
    elif t<8.0:
        u=t-3.4; f=fit(a3,1.06+0.025*u,dx=-20+8*u) *1.05; ch=3
        if u<0.25: f=f*(u/0.25)+235*(1-u/0.25)
        if t>7.6: g=(t-7.6)/0.4*1.5; ch=10
    elif t<12.6:
        u=t-8.0; f=fit(a1,1.12-0.02*u,dx=30-12*u,dy=-10); ch=3
        if u<0.35: g=1.2*(1-u/0.35); ch=10
        if t>12.2: g=(t-12.2)/0.4*1.5; ch=12
    elif t<20.6:
        u=t-12.6; f=title_card(u); ch=3
        if u<0.3: g=1.0*(1-u/0.3)
        if 4.5<u<4.7: g=0.8
        if t>20.0: f*=max(0,1-(t-20.0)/0.6)
    else:
        f=np.zeros((H,W,3),np.float32)
    if t>20.6 and t<21.4: # collapse line
        u=(t-20.6)/0.5
        if u<1: f[H//2-2:H//2+2,int(W*u/2):int(W-W*u/2)]=230
    if g>0: f=glitch(f,min(g,1.5))
    f=chroma(f,ch)
    # tracking band
    by=int((t*140)%(H+200))-100
    if 0<=by<H-30: f[by:by+30]=np.roll(f[by:by+30],int(6*math.sin(t*20)),axis=1)*1.08
    f=f*scan*vign
    f+=rng.normal(0,9,(H//2,W//2,1)).repeat(2,0).repeat(2,1)
    f*=0.97+0.03*rng.random()
    if 3.4<t<20.6:
        im=Image.fromarray(np.clip(f,0,255).astype(np.uint8)).convert("RGBA")
        im.alpha_composite(hud_layer(t))
        im.paste(small,(W-90,H-82),smallmask)
        f=np.asarray(im.convert("RGB")).astype(np.float32)
    p.stdin.write(np.clip(f,0,255).astype(np.uint8).tobytes())
p.stdin.close(); p.wait()
