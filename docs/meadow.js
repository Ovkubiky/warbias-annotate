/* Bottom strip: a meadow that grows with your work (plus ripples and a fake terminal). */
/* ---------- brainrot strip: a meadow that grows with your work ---------- */
const SCENES=[["meadow","Луг"],["ripples","Брижі"],["term","Термінал"]];
const cv=$("#cv"), ctx=cv.getContext("2d"), term=$("#term");
let sceneI=0, rotOn=true, raf, termTimer, scene=null, W=0, H=0, last=0;
const KEY="wb2-"; // new prefix: settings from earlier prototype versions are ignored, everyone starts with the meadow open
function store(k,v){ try{ if(v===undefined) return localStorage.getItem(KEY+k); localStorage.setItem(KEY+k,v);}catch(_){return null} }
let grown=0; // flowers grown = cards finished on this device; first visit starts with one per card already done
function initGrown(done){ grown = store("rot-n")===null ? done : (+store("rot-n")||0); }
let bouquet=(()=>{ try{ return JSON.parse(store("rot-bq")||"[]"); }catch(_){ return []; } })(); // picked flower kinds
const css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
let C={};
function readColors(){ C={yes:css("--fl-yes"),no:css("--fl-no"),grass:css("--fl-grass"),ink:css("--ink"),soft:css("--line"),ring:css("--muted")}; }
const kindColor=k=>k==="no"?C.no:C.yes;
function fit(){ const r=cv.getBoundingClientRect(), d=devicePixelRatio||1; W=r.width; H=r.height; cv.width=W*d; cv.height=H*d; ctx.setTransform(d,0,0,d,0,0); }
const rnd=(a,b)=>a+Math.random()*(b-a);
function updBadges(){
  const m=SCENES[sceneI][0]==="meadow";
  $("#rotCount").hidden=!m; $("#rotCount").textContent=`🌱 ${grown}`;
  $("#rotBq").hidden=!m; $("#rotBq").textContent=`💐 ${bouquet.length}`;
}

function drawFlower(g,x,y,s,kind,rot=0){
  if(kind==="no"){ // cornflower: thin spiky petals
    g.fillStyle=C.no;
    for(let i=0;i<8;i++){ const a=i/8*Math.PI*2+rot; g.beginPath(); g.ellipse(x+Math.cos(a)*3.8*s,y+Math.sin(a)*3.8*s,3*s,1.2*s,a,0,7); g.fill(); }
    g.fillStyle=C.ink; g.globalAlpha=.55; g.beginPath(); g.arc(x,y,1.3*s,0,7); g.fill(); g.globalAlpha=1;
  } else {          // sunflower: round petals, dark centre
    g.fillStyle=C.yes;
    for(let i=0;i<10;i++){ const a=i/10*Math.PI*2+rot; g.beginPath(); g.ellipse(x+Math.cos(a)*3.6*s,y+Math.sin(a)*3.6*s,2.6*s,1.4*s,a,0,7); g.fill(); }
    g.fillStyle="#5a3d12"; g.beginPath(); g.arc(x,y,2*s,0,7); g.fill();
  }
}

const Scenes={
  meadow:{
    init(){
      this.t=0; this.gust=0; this.hx=null; this.ht=0; this.fly=[];
      this.blades=Array.from({length:Math.ceil(W/5)},(_,i)=>({x:i*5+rnd(-2,2),h:rnd(8,24)}));
      const n=Math.max(0,Math.min(grown-bouquet.length,40));
      this.f=Array.from({length:n},()=>({x:rnd(.04,.96)*W,h:rnd(26,H*.62),g:1,k:Math.random()<.8?"yes":"no"}));
    },
    on(dir){ grown++; store("rot-n",grown); this.gust=1;
      this.f.push({x:rnd(.04,.96)*W,h:rnd(26,H*.62),g:0,k:dir==="yes"?"yes":"no"}); if(this.f.length>60) this.f.shift(); updBadges(); },
    head(o,still){ const e=1-Math.pow(1-o.g,3); return {x:o.x+this.sway(o.x,still)*1.6, y:H-6-o.h*e}; },
    sway(x,still){ const hx=this.hx, ht=still?0:this.ht;
      return Math.sin(this.t*1.8+x*.025)*(3+this.gust*7) + (ht&&hx!=null ? Math.sign(x-hx)*Math.exp(-((x-hx)**2)/900)*14*ht : 0); },
    tap(x,y){ // pick the flower under the finger into the bouquet
      let best=null, bd=28*28;
      this.f.forEach(o=>{ if(o.g<.9) return; const h=this.head(o,true), d=(h.x-x)**2+(h.y-y)**2; if(d<bd){bd=d;best=o;} });
      if(!best){ this.hx=x; this.ht=1; return; }
      const h=this.head(best), r=$("#rotBq").getBoundingClientRect(), c=cv.getBoundingClientRect();
      this.f.splice(this.f.indexOf(best),1);
      this.fly.push({x:h.x,y:h.y,tx:r.left-c.left+r.width/2,ty:r.top-c.top+r.height/2,p:0,k:best.k});
    },
    move(x,y){ // flowers lean away from the pointer, but not when it is right on a flower head (so you can pick it)
      if(y!=null&&this.f.some(o=>{const h=this.head(o,true);return (h.x-x)**2+(h.y-y)**2<28*28;})) return;
      this.hx=x; this.ht=1; },
    step(dt){
      this.t+=dt; this.gust=Math.max(0,this.gust-dt*.8); this.ht=Math.max(0,this.ht-dt*1.5);
      this.f.forEach(o=>o.g=Math.min(1,o.g+dt*1.6));
      this.fly.forEach(o=>{ o.p+=dt*2.2; if(o.p>=1&&!o.done){ o.done=1; bouquet.push(o.k); store("rot-bq",JSON.stringify(bouquet)); updBadges(); } });
      this.fly=this.fly.filter(o=>!o.done);
    },
    draw(){
      const base=H-6;
      ctx.strokeStyle=C.grass; ctx.lineWidth=1.2;
      this.blades.forEach(b=>{ ctx.beginPath(); ctx.moveTo(b.x,base); ctx.quadraticCurveTo(b.x,base-b.h*.6,b.x+this.sway(b.x),base-b.h); ctx.stroke(); });
      this.f.forEach(o=>{
        const h=this.head(o);
        ctx.strokeStyle=C.grass; ctx.lineWidth=1.3; ctx.beginPath(); ctx.moveTo(o.x,base); ctx.quadraticCurveTo(o.x,(base+h.y)/2,h.x,h.y); ctx.stroke();
        if(o.g>.6) drawFlower(ctx,h.x,h.y,(o.g-.6)/.4,o.k,this.t*.1);
      });
      this.fly.forEach(o=>{ const e=o.p*o.p*(3-2*o.p); drawFlower(ctx,o.x+(o.tx-o.x)*e, o.y+(o.ty-o.y)*e-Math.sin(e*Math.PI)*20, 1-e*.4, o.k, o.p*4); });
      ctx.fillStyle=C.soft; ctx.fillRect(0,base,W,6);
    }
  },
  ripples:{
    init(){ this.r=[]; this.next=.5; this.specks=Array.from({length:14},()=>({x:rnd(0,W),y:rnd(0,H),v:rnd(3,7)})); },
    ring(x,y,c,a){ this.r.push({x,y,r:0,max:rnd(60,110),c,a}); },
    tap(x,y){ const c=Math.random()<.5?C.yes:C.no; this.ring(x,y,c,.9); setTimeout(()=>this.ring(x,y,c,.5),200); },
    move(x,y,down){ if(down&&Math.random()<.25) this.ring(x,y,C.no,.5); },
    on(dir){ grown++; store("rot-n",grown); const x=rnd(.15,.85)*W, y=rnd(.25,.75)*H, c=dir==="yes"?C.yes:C.no; this.ring(x,y,c,1); setTimeout(()=>this.ring(x,y,c,.6),200); setTimeout(()=>this.ring(x,y,c,.35),400); },
    step(dt){
      this.next-=dt; if(this.next<=0){ this.next=rnd(.8,1.6); this.ring(rnd(0,W),rnd(0,H),C.ring,.25); }
      this.r.forEach(o=>o.r+=dt*65); this.r=this.r.filter(o=>o.r<o.max);
      this.specks.forEach(s=>{ s.x+=dt*s.v*3; if(s.x>W+4) s.x=-4; });
    },
    draw(){
      ctx.fillStyle=C.soft; this.specks.forEach(s=>{ ctx.beginPath(); ctx.arc(s.x,s.y+Math.sin(s.x*.05)*3,1.6,0,7); ctx.fill(); });
      this.r.forEach(o=>{ ctx.globalAlpha=o.a*(1-o.r/o.max); ctx.strokeStyle=o.c; ctx.lineWidth=1.5; ctx.beginPath(); ctx.ellipse(o.x,o.y,o.r,o.r*.42,0,0,7); ctx.stroke(); });
      ctx.globalAlpha=1;
    }
  }
};
const TERM=[["c","> проаннотуй решту WarBias"],["","⏺ Read(WarBias/uk/unassigned.jsonl)"],["d","  ⎿  Read 1059 lines"],["","⏺ Перевіряю, чи C справді заперечує S…"],["","⏺ Update(review_queue.csv)"],["g","  ⎿  3 additions, 1 removal"],["d","✻ Роздумую над контрстереотипами… (12s · esc to interrupt)"],["","⏺ Bash(python compute_alpha.py)"],["g","  ⎿  α = 0.71"],["","⏺ Готово. Але людина все одно має перевірити."]];
function runTerm(){
  term.innerHTML=""; let li=0, ci=0, cur=null;
  termTimer=setInterval(()=>{
    if(!cur){ if(li>=TERM.length){term.innerHTML="";li=0;} cur=document.createElement("div"); cur.className=TERM[li][0]; term.appendChild(cur); ci=0; }
    const line=TERM[li][1]; cur.textContent=line.slice(0,++ci); if(ci>=line.length){cur=null;li++;}
    while(term.scrollHeight>term.clientHeight&&term.firstChild) term.firstChild.remove();
  },20);
}
function loop(ts){
  const dt=Math.min(.05,(ts-(last||ts))/1000); last=ts;
  ctx.clearRect(0,0,W,H); scene.step(dt); scene.draw();
  raf=requestAnimationFrame(loop);
}
function rotUndo(){
  grown=Math.max(0,grown-1); store("rot-n",grown);
  if(scene===Scenes.meadow&&scene.f.length) scene.f.pop();
  updBadges();
}
function rotEvent(dir){
  if(rotOn&&scene){ scene.on(dir); return; }
  grown++; store("rot-n",grown); // keep growing even when the strip is hidden
}
function stopRot(){ cancelAnimationFrame(raf); clearInterval(termTimer); last=0; }
function playRot(){
  stopRot(); readColors(); const id=SCENES[sceneI][0];
  $("#rotName").textContent=SCENES[sceneI][1]; updBadges();
  term.hidden=id!=="term"; cv.hidden=id==="term";
  if(id==="term"){ scene=null; runTerm(); return; }
  fit(); scene=Scenes[id]; scene.init(); raf=requestAnimationFrame(loop);
}
let rotDown=false;
const rotXY=e=>{ const r=cv.getBoundingClientRect(); return [e.clientX-r.left,e.clientY-r.top]; };
cv.addEventListener("pointerdown",e=>{ rotDown=true; try{cv.setPointerCapture(e.pointerId)}catch(_){} const [x,y]=rotXY(e); scene&&scene.tap&&scene.tap(x,y); });
cv.addEventListener("pointermove",e=>{ const [x,y]=rotXY(e); scene&&scene.move&&scene.move(x,y,rotDown); });
cv.addEventListener("pointerup",()=>rotDown=false); cv.addEventListener("pointercancel",()=>rotDown=false);
// swiping a card also stirs the grass
addEventListener("pointermove",e=>{ if(scene===Scenes.meadow&&dragged){ const c=cv.getBoundingClientRect(); scene.move(e.clientX-c.left); } });
const TAPLINES=["> ще одну трійку, будь ласка","⏺ Відчуваю стереотип у реченні U…","✻ Медитую над контрстереотипом… (3s)","⏺ Read(твої_думки.txt)","  ⎿  α підвищилось на 0.01"];
term.addEventListener("pointerdown",()=>{ const d=document.createElement("div"); d.className="c"; d.textContent=TAPLINES[Math.random()*TAPLINES.length|0]; term.appendChild(d); while(term.scrollHeight>term.clientHeight&&term.firstChild) term.firstChild.remove(); });

/* bouquet */
function drawBouquet(c,list){
  const d=devicePixelRatio||1, w=c.clientWidth, h=c.clientHeight; c.width=w*d; c.height=h*d;
  const g=c.getContext("2d"); g.setTransform(d,0,0,d,0,0);
  const bx=w/2, by=h-30, n=list.length;
  g.strokeStyle=C.grass; g.lineWidth=1.4;
  const heads=list.map((k,i)=>{ const a=(n<2?0:(i/(n-1)-.5))*Math.min(1.1,.25*n) + rnd(-.06,.06), len=rnd(h*.5,h*.66); return {k,x:bx+Math.sin(a)*len,y:by-Math.cos(a)*len}; });
  heads.forEach(p=>{ g.beginPath(); g.moveTo(bx+rnd(-3,3),by+18); g.quadraticCurveTo(bx,by-10,p.x,p.y); g.stroke(); });
  heads.sort((a,b)=>b.y-a.y).forEach(p=>drawFlower(g,p.x,p.y,2.6,p.k,rnd(0,6)));
  g.fillStyle=css("--accent"); g.beginPath(); g.moveTo(bx-14,by-4); g.lineTo(bx+14,by-4); g.lineTo(bx+9,by+10); g.lineTo(bx-9,by+10); g.closePath(); g.fill();
}
const plural=(n,one,few,many)=>{ const m10=n%10, m100=n%100; return n+" "+(m10===1&&m100!==11?one:(m10>=2&&m10<=4&&(m100<10||m100>=20)?few:many)); };
$("#rotBq").onclick=()=>{
  const nYes=bouquet.filter(k=>k==="yes").length, nNo=bouquet.length-nYes;
  if(!bouquet.length){ toast("Торкніться квітки на лузі, щоб зірвати її в букет"); return; }
  sheet(`<h3>Ваш букет</h3>
    <canvas id="bqCanvas" style="width:100%;height:260px;display:block"></canvas>
    <p>${plural(bouquet.length,"квітка","квітки","квітів")}: ${plural(nYes,"соняшник","соняшники","соняшників")} (прийняті картки) і ${plural(nNo,"волошка","волошки","волошок")} (знайдені проблеми). Кожна квітка — одна перевірена картка.</p>
    <button class="btn" data-close>Закрити</button>`,
  sh=>{ readColors(); drawBouquet(sh.querySelector("#bqCanvas"),bouquet);
  });
};

$("#rotShuffle").onclick=()=>{ sceneI=(sceneI+1)%SCENES.length; store("rot-ch",sceneI); playRot(); };
$("#rotX").onclick=()=>{ rotOn=false; store("rot-on","0"); applyRot(); };
$("#rotBtn").onclick=()=>{ rotOn=!rotOn; store("rot-on",rotOn?"1":"0"); applyRot(); };
function applyRot(){ $("#rotBtn").setAttribute("aria-pressed",rotOn); $("#rot").hidden=!rotOn; rotOn?playRot():stopRot(); }
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change",()=>rotOn&&playRot());


function startRot(done){
  initGrown(done);
  sceneI=Math.min(SCENES.length-1,+(store("rot-ch")||0)||0);
  rotOn=store("rot-on")!=="0";
  applyRot();
  addEventListener("resize",()=>{ if(rotOn) playRot(); });
}
