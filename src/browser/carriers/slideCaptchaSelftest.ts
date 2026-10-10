import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { solveCargoSmartSlider } from './slideCaptcha';

/**
 * Priora — Self-test do resolvedor do captcha de arrastar (CargoSmart/OOCL).
 *
 * Roda num Chromium LOCAL uma página que imita o componente real (mesmos ids e
 * classes da captura de 10/10: #cs_captcha, #cs_captchaimgCanvas 330×160,
 * #cs_captchabockCanvas, .verify-move-block 38px numa barra de 332px): fundo
 * texturizado com o BURACO numa posição sorteada e a PEÇA transparente fora do
 * formato. A barra move a peça como o componente faz, e o "servidor" aceita
 * só se a peça parar a ±4px do buraco — o mesmo critério desses captchas.
 * Não prova que a CargoSmart aceita (isso é o teste ao vivo); prova que a
 * análise acha o encaixe e que o arrasto leva a peça até lá.
 *
 *   npm run slider:selftest
 */

const PAGE = (gapX: number, gapY: number) => `<!doctype html><html><body style="margin:40px">
<div class="capture-box" style="display:block"><div id="cs_captcha" style="position:relative">
 <div class="verify-img-out" style="height:165px"><div class="verify-img-panel" style="width:330px;height:160px;position:relative">
  <span class="verify-tips"></span>
  <canvas id="cs_captchaimgCanvas" width="330" height="160"></canvas>
  <canvas id="cs_captchabockCanvas" width="330" height="160" style="position:absolute;top:0;left:0;z-index:2"></canvas>
 </div></div>
 <div class="verify-bar-area" style="width:332px;height:40px;position:relative;background:#eee">
  <span id="slider-text">Please slide to verify</span>
  <div class="verify-left-bar" style="width:38px;height:38px;position:absolute;left:0;top:0">
   <span class="verify-msg"></span>
   <div class="verify-move-block" style="width:38px;height:38px;position:absolute;left:0;top:0;background:#fff;border:1px solid #999"></div>
  </div>
 </div>
</div></div>
<script>
const GX=${gapX}, GY=${gapY}, S=44;
function shape(ctx,x,y){ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+S/2-6,y);ctx.arc(x+S/2,y,6,Math.PI,0,false);ctx.lineTo(x+S,y);ctx.lineTo(x+S,y+S/2-6);ctx.arc(x+S,y+S/2,6,-Math.PI/2,Math.PI/2,false);ctx.lineTo(x+S,y+S);ctx.lineTo(x,y+S);ctx.closePath();}
// Fundo: textura com ruído e faixas (imagem "de verdade" tem muita borda falsa).
const bg=document.getElementById('cs_captchaimgCanvas').getContext('2d');
let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
for(let y=0;y<160;y+=4)for(let x=0;x<330;x+=4){const v=90+rnd()*120;bg.fillStyle='rgb('+(v*0.6|0)+','+(v*0.8|0)+','+(v|0)+')';bg.fillRect(x,y,4,4);}
for(let i=0;i<12;i++){bg.strokeStyle='rgba(255,255,255,0.5)';bg.lineWidth=2;bg.beginPath();bg.moveTo(rnd()*330,0);bg.lineTo(rnd()*330,160);bg.stroke();}
const tex=bg.getImageData(0,0,330,160);
// Buraco: escurece a área e contorna (como o fundo da CargoSmart).
shape(bg,GX,GY);bg.fillStyle='rgba(0,0,0,0.45)';bg.fill();bg.strokeStyle='rgba(255,255,255,0.9)';bg.lineWidth=1.5;bg.stroke();
// Peça: recorte da textura original no formato, desenhada em x=0.
const piece=document.createElement('canvas');piece.width=330;piece.height=160;const pc=piece.getContext('2d');
pc.putImageData(tex,0,0);pc.globalCompositeOperation='destination-in';shape(pc,GX,GY);pc.fill();
const bk=document.getElementById('cs_captchabockCanvas');const bkc=bk.getContext('2d');
let off=0;function draw(){bkc.clearRect(0,0,330,160);bkc.drawImage(piece,GX-2,0,S+14,160,off,0,S+14,160);}draw();
// Barra: arrastar move a peça na mesma proporção que o componente (barra→imagem).
const mb=document.querySelector('.verify-move-block');let down=false,sx=0,left=0;
const ratio=(330-S)/(332-38);
mb.addEventListener('mousedown',e=>{down=true;sx=e.clientX;});
window.addEventListener('mousemove',e=>{if(!down)return;left=Math.max(0,Math.min(332-38,e.clientX-sx));mb.style.left=left+'px';off=left*ratio;draw();});
window.addEventListener('mouseup',()=>{if(!down)return;down=false;const ok=Math.abs(off-GX)<=4;
 document.querySelector('.verify-msg').textContent=ok?'Validation successful':'Validation failed';
 if(ok){setTimeout(()=>{document.querySelector('.capture-box').style.display='none';},300);}
 else{setTimeout(()=>{mb.style.left='0px';off=0;draw();document.querySelector('.verify-msg').textContent='';},500);} });
</script></body></html>`;

// Modo ROTAÇÃO com as IMAGENS REAIS da OOCL (capturadas em 10/10): o fundo com
// o buraco redondo e o círculo girado. Encaixe conferido a olho: 171° (o logo
// "OOCL" fica legível e o navio emenda). A barra gira o círculo (curso inteiro =
// 360°), redesenhando o canvas OU por CSS, conforme `how`.
const img = (f: string) =>
  'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures', f)).toString('base64');
const ROT_PAGE = (how: 'canvas' | 'css' | 'css-anim') => `<!doctype html><html><body style="margin:40px">
<div class="capture-box" style="display:block"><div id="cs_captcha" style="position:relative">
 <div class="verify-img-out"><div class="verify-img-panel" style="width:330px;height:160px;position:relative">
  <canvas id="cs_captchaimgCanvas" width="330" height="160"></canvas>
  <canvas id="cs_captchabockCanvas" width="330" height="160" style="position:absolute;top:0;left:0;z-index:2;transform-origin:218px 72px;${how === 'css-anim' ? 'transition:transform .25s ease-out;' : ''}"></canvas>
 </div></div>
 <div class="verify-bar-area" style="width:332px;height:40px;position:relative;background:#eee">
  <span id="slider-text">Please slide to verify</span>
  <div class="verify-left-bar" style="width:38px;height:38px;position:absolute;left:0;top:0"><span class="verify-msg"></span>
   <div class="verify-move-block" style="width:38px;height:38px;position:absolute;left:0;top:0;background:#fff;border:1px solid #999"></div></div>
 </div></div></div>
<script>
const HOW='${how}', OK=171, CX=218, CY=72;
const ib=new Image(), ip=new Image(); let ang=0;
const bk=document.getElementById('cs_captchabockCanvas'), bc=bk.getContext('2d');
function draw(){ if(HOW!=='canvas'){ bk.style.transform='rotate('+ang+'deg)'; return; }
 bc.clearRect(0,0,330,160); bc.save(); bc.translate(CX,CY); bc.rotate(ang*Math.PI/180); bc.translate(-CX,-CY); bc.drawImage(ip,0,0); bc.restore(); }
ib.onload=()=>document.getElementById('cs_captchaimgCanvas').getContext('2d').drawImage(ib,0,0);
ip.onload=()=>{ bc.drawImage(ip,0,0); };
ib.src='${img('oocl-captcha-bg.png')}'; ip.src='${img('oocl-captcha-piece.png')}';
const mb=document.querySelector('.verify-move-block'); let down=false,sx=0;
mb.addEventListener('mousedown',e=>{down=true;sx=e.clientX;});
// Como a CargoSmart (visto ao vivo): o giro VISUAL usa 360°/largura da barra,
// mas o "servidor" confere pela posição do botão com 360° = curso (barra − botão).
let left=0;
window.addEventListener('mousemove',e=>{ if(!down)return; left=Math.max(0,Math.min(332-38,e.clientX-sx)); mb.style.left=left+'px'; ang=left*360/332; draw(); });
window.addEventListener('mouseup',()=>{ if(!down)return; down=false; const srv=left*360/(332-38); const d=Math.abs(((srv-OK)%360+540)%360-180); const ok=d<=6;
 document.querySelector('.verify-msg').textContent=ok?'Validation successful':'Validation failed';
 if(ok) setTimeout(()=>{document.querySelector('.capture-box').style.display='none';},300);
 else setTimeout(()=>{mb.style.left='0px';ang=0;left=0;draw();document.querySelector('.verify-msg').textContent='';},500); });
</script></body></html>`;

let failures = 0;
function check(label: string, cond: boolean, got?: unknown): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${got !== undefined ? ` (obteve: ${JSON.stringify(got)})` : ''}`);
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    console.log('[selftest] captcha de arrastar (imitação do componente da CargoSmart)');
    for (const [gx, gy] of [
      [190, 60],
      [120, 30],
      [255, 90],
    ]) {
      const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
      await page.setContent(PAGE(gx, gy));
      const r = await solveCargoSmartSlider(page, { maxAttempts: 3 });
      const a = r.attempts[r.attempts.length - 1];
      console.log(`    buraco x=${gx}: alvo achado=${a?.targetX} (score ${a?.score} × 2º ${a?.second}), folga final=${a?.finalGap}px, ${r.attempts.length} tentativa(s), ${r.ms} ms → ${a?.result}`);
      check(`buraco em x=${gx}: análise acha o encaixe (±3px)`, Math.abs((r.attempts[0]?.targetX ?? -99) - gx) <= 3, r.attempts[0]?.targetX);
      check(`buraco em x=${gx}: arrasto aceito pelo "servidor"`, r.solved, r.attempts.map((x) => x.result));
      await page.close();
    }
    console.log('[selftest] modo ROTAÇÃO com as imagens REAIS da OOCL (encaixe = 171°)');
    // css-anim: giro com transição de 0,25 s — medir no meio dela fazia o arrasto
    // passar do ponto ao vivo (10/10).
    for (const how of ['canvas', 'css', 'css-anim'] as const) {
      const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
      await page.setContent(ROT_PAGE(how));
      await page.waitForTimeout(300);
      const r = await solveCargoSmartSlider(page, { maxAttempts: 3 });
      const a = r.attempts[r.attempts.length - 1];
      console.log(`    giro por ${how}: ângulo achado=${a?.targetX}° (custo ${a?.score} × 2º ${a?.second}), modo=${a?.mode}, sobra=${a?.finalGap}°, ${r.attempts.length} tentativa(s), ${r.ms} ms → ${a?.result}`);
      check(`giro por ${how}: análise acha 171° (±4°)`, Math.abs((r.attempts[0]?.targetX ?? -99) - 171) <= 4, r.attempts[0]?.targetX);
      check(`giro por ${how}: arrasto aceito pelo "servidor" (±6°)`, r.solved, r.attempts.map((x) => x.result));
      await page.close();
    }
    console.log('[selftest] sem captcha na tela → não faz nada');
    const p2 = await browser.newPage();
    await p2.setContent('<html><body>Resultado</body></html>');
    const none = await solveCargoSmartSlider(p2);
    check('found=false e nenhuma tentativa', !none.found && none.attempts.length === 0);
  } finally {
    await browser.close();
  }
  if (failures === 0) console.log('\n[selftest] ✅ resolvedor do captcha de arrastar: lógica OK');
  else {
    console.log(`\n[selftest] ❌ ${failures} verificação(ões) falharam`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
