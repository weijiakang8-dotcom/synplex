// Port of AgentHub GalaxyBackground: twinkle, orbit drift, pointer spring and
// layered stars. Rendering stays independent of React and the workbench state.
const gaussian=()=> (Math.random()+Math.random()+Math.random()-1.5)/1.5;
function makeStar(cluster,index){
 const bright=index%18===0;
 return {x:cluster?gaussian()*.5:Math.random(),y:cluster?gaussian()*.38:Math.random(),z:.45+Math.random()*.55,r:bright?1.2+Math.random():.35+Math.random()*.6,base:bright?.9:.2+Math.random()*.5,speed:.7+Math.random()*1.6,phase:Math.random()*Math.PI*2,orbitSpeed:.12+Math.random()*.32,curX:0,curY:0,velX:0,velY:0};
}
function moveStar(star,baseX,baseY,mouse,size,step){
 const dx=baseX-mouse.x,dy=baseY-mouse.y,distance=Math.hypot(dx,dy)||1,radius=size*.14;
 const push=Math.max(0,1-distance/radius)*(2+5*star.z);
 const spring=.0012+(1-Math.max(0,1-distance/(size*.36)))*.001;
 star.velX+=((dx/distance)*push-star.velX)*.07-star.curX*spring;
 star.velY+=((dy/distance)*push-star.velY)*.07-star.curY*spring;
 star.velX*=.82;star.velY*=.82;star.curX+=star.velX*step;star.curY+=star.velY*step;
 return [baseX+star.curX,baseY+star.curY];
}
function point(ctx,star,x,y,time,reduced){
 const twinkle=reduced?1:.72+.28*Math.sin(time*.001*star.speed+star.phase);
 ctx.globalAlpha=Math.min(1,star.base*twinkle);ctx.fillStyle=star.z>.72?'#f2f8ff':'#dceaff';ctx.beginPath();ctx.arc(x,y,star.r,0,Math.PI*2);ctx.fill();
}
function constellation(ctx,points,time,reduced,phase){
 ctx.globalAlpha=reduced?.65:.52+.18*Math.sin(time*.0004+phase);ctx.strokeStyle='#bdd2f5';ctx.lineWidth=1;ctx.beginPath();
 points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.stroke();
 for(const [x,y]of points){ctx.beginPath();ctx.arc(x,y,1.8,0,Math.PI*2);ctx.fillStyle='#edf4ff';ctx.fill();}
}
export function startGalaxy(canvas){
 const ctx=canvas?.getContext('2d');if(!ctx)return;
 const reduce=matchMedia('(prefers-reduced-motion: reduce)'),mouse={x:0,y:0,targetX:0,targetY:0},cluster={x:0,y:0};
 let width=0,height=0,background=[],stars=[],raf=0,last=0,visible=true,elapsed=0;
 function draw(time,step){
  const size=Math.min(width,height),reduced=reduce.matches;
  ctx.globalAlpha=1;ctx.clearRect(0,0,width,height);
  mouse.x+=(mouse.targetX-mouse.x)*.05;mouse.y+=(mouse.targetY-mouse.y)*.05;
  cluster.x+=(width*.78+(mouse.x-width*.5)*.08-cluster.x)*.04;
  cluster.y+=(Math.min(190,height*.2)+(mouse.y-height*.3)*.04-cluster.y)*.04;
  const angle=reduced?0:time*.00005,cos=Math.cos(angle),sin=Math.sin(angle);
  for(const star of stars){
   const drift=reduced?0:Math.sin(time*.00025*star.orbitSpeed+star.phase)*size*.015*star.z;
   const x=cluster.x+(star.x*cos-star.y*sin)*size*star.z+drift,y=cluster.y+(star.x*sin+star.y*cos)*size*star.z;
   const position=reduced?[x,y]:moveStar(star,x,y,mouse,size,step);point(ctx,star,...position,time,reduced);
  }
  for(const star of background)point(ctx,star,star.x*width,star.y*height,time,reduced);
  constellation(ctx,[[width*.10,72],[width*.125,54],[width*.152,72],[width*.125,72],[width*.112,108],[width*.137,108]],time,reduced,0);
  if(width>650)constellation(ctx,[[width*.86,607],[width*.885,555],[width*.91,599],[width*.927,542]],time,reduced,2);
  ctx.globalAlpha=1;
 }
 function tick(time){
  if(time-last>=32){const delta=Math.min(time-last,50);elapsed+=delta;draw(elapsed,delta/16.67);last=time;}
  raf=requestAnimationFrame(tick);
 }
 function sync(){cancelAnimationFrame(raf);raf=0;last=performance.now();if(!visible||document.hidden)return;if(reduce.matches)draw(0,0);else raf=requestAnimationFrame(tick);}
 function resize(){
  width=canvas.clientWidth;height=canvas.clientHeight;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.floor(width*dpr);canvas.height=Math.floor(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
  stars=Array.from({length:width<640?300:760},(_,i)=>makeStar(true,i));background=Array.from({length:width<640?45:120},(_,i)=>makeStar(false,i));
  cluster.x=width*.78;cluster.y=Math.min(190,height*.2);mouse.x=mouse.targetX=width*.5;mouse.y=mouse.targetY=height*.3;draw(elapsed,0);
 }
 const pointer=event=>{if(reduce.matches)return;const rect=canvas.getBoundingClientRect();mouse.targetX=event.clientX-rect.left;mouse.targetY=event.clientY-rect.top;};
 const observer=new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;sync();});observer.observe(canvas);
 addEventListener('resize',resize);addEventListener('pointermove',pointer,{passive:true});document.addEventListener('visibilitychange',sync);reduce.addEventListener('change',sync);resize();sync();
 return ()=>{cancelAnimationFrame(raf);observer.disconnect();removeEventListener('resize',resize);removeEventListener('pointermove',pointer);document.removeEventListener('visibilitychange',sync);reduce.removeEventListener('change',sync);};
}
