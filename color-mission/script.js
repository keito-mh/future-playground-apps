(function(){
  var cv=document.getElementById('game'),ctx=cv.getContext('2d');
  var lvEl=document.getElementById('lv'),tierEl=document.getElementById('tier'),totalEl=document.getElementById('total'),livesEl=document.getElementById('lives');
  var swatch=document.getElementById('swatch'),mname=document.getElementById('mname'),remainEl=document.getElementById('remain');
  var hint=document.getElementById('hint'),banner=document.getElementById('banner'),bannerText=document.getElementById('bannerText');
  var comboEl=document.getElementById('combo'),comboText=document.getElementById('comboText');
  var bonusEl=document.getElementById('bonus'),bonusBar=document.getElementById('bonusBar');
  var overEl=document.getElementById('over'),overStats=document.getElementById('overStats'),restartBtn=document.getElementById('restart');
  var dpr=Math.min(window.devicePixelRatio||1,2),W,H;
  function resize(){var r=cv.getBoundingClientRect();W=r.width;H=r.height;cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);}
  window.addEventListener('resize',resize);window.addEventListener('orientationchange',function(){setTimeout(resize,200);});

  var COLORS=[
    {n:'レッド',h:0},{n:'オレンジ',h:30},{n:'イエロー',h:52},{n:'グリーン',h:140},
    {n:'シアン',h:185},{n:'ブルー',h:220},{n:'パープル',h:278},{n:'ピンク',h:330}
  ];
  var MAXLIFE=3;
  var HEART='<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.7-10-9.3C.4 8.6 1.8 5 5.2 5 7.3 5 8.8 6.3 12 9c3.2-2.7 4.7-4 6.8-4 3.4 0 4.8 3.6 3.2 6.7C19.5 16.3 12 21 12 21z" fill="COL"/></svg>';

  var objs,parts,rings,shocks,stars,floats,path;
  var drawing,moved,downPos,pathLen;
  var level,total,mColor,mNeed,mGot,combo,lastCap,shake,flash,flashHue,hinted,lives,gameOver,spawnT,bonusActive,bonusEnd;
  var TIERS=['ブルーム','花火','ネオン','レインボー'];
  var BONUS_MS=5000;
  function eff(l){return l>=4?3:(l-1);}

  function reset(){
    objs=[];parts=[];rings=[];shocks=[];stars=[];floats=[];path=[];
    drawing=false;moved=false;downPos=null;pathLen=0;
    level=1;total=0;mGot=0;combo=0;lastCap=0;shake=0;flash=0;flashHue=0;lives=MAXLIFE;gameOver=false;spawnT=0;mColor=-1;bonusActive=false;bonusEnd=0;
    bonusEl.style.display='none';
    for(var s=0;s<60;s++) stars.push({x:Math.random(),y:Math.random(),r:Math.random()*1.4+0.3,p:Math.random()*6.28,sp:0.5+Math.random()*1.5,h:Math.random()*360});
    lvEl.textContent=1; tierEl.textContent=TIERS[0]; totalEl.textContent=0;
    overEl.style.display='none';
    updateLives(); newMission();
    for(var i=0;i<5;i++) spawn();
  }

  function updateLives(){
    var s='';
    for(var i=0;i<MAXLIFE;i++) s+=HEART.replace('COL', i<lives?'#E24B4A':'rgba(255,255,255,0.18)');
    livesEl.innerHTML=s;
  }

  function newMission(){
    var prev=mColor;
    do{ mColor=Math.floor(Math.random()*COLORS.length); }while(COLORS.length>1 && mColor===prev);
    mNeed=4+level; mGot=0;
    var c=COLORS[mColor];
    swatch.style.background='hsl('+c.h+',90%,60%)'; swatch.style.boxShadow='0 0 10px hsl('+c.h+',90%,60%)';
    mname.textContent=c.n; remainEl.textContent=mNeed;
  }

  function spawn(){
    if(objs.length>=(bonusActive?28:7+level*2)) return;
    var ci = (bonusActive||Math.random()>=0.5) ? Math.floor(Math.random()*COLORS.length) : mColor;
    var c=COLORS[ci];
    var side=Math.floor(Math.random()*4),x,y,vx,vy,sp=0.6+level*0.13,m=40;
    if(side===0){x=Math.random()*W;y=-m;vx=(Math.random()-0.5)*sp;vy=sp*(0.6+Math.random()*0.8);}
    else if(side===1){x=W+m;y=Math.random()*H;vx=-sp*(0.6+Math.random()*0.8);vy=(Math.random()-0.5)*sp;}
    else if(side===2){x=Math.random()*W;y=H+m;vx=(Math.random()-0.5)*sp;vy=-sp*(0.6+Math.random()*0.8);}
    else{x=-m;y=Math.random()*H;vx=sp*(0.6+Math.random()*0.8);vy=(Math.random()-0.5)*sp;}
    objs.push({x:x,y:y,vx:vx,vy:vy,r:11+Math.random()*9,ci:ci,h:c.h,inside:false,pulse:Math.random()*6.28});
  }

  function inPoly(x,y,p){
    if(p.length<3) return false;
    var ins=false;
    for(var i=0,j=p.length-1;i<p.length;j=i++){
      var xi=p[i].x,yi=p[i].y,xj=p[j].x,yj=p[j].y;
      if(((yi>y)!=(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi)) ins=!ins;
    }
    return ins;
  }

  function floatText(x,y,txt,col){ floats.push({x:x,y:y,txt:txt,col:col,life:50,max:50}); }

  function burst(x,y,h,e,power,target){
    shocks.push({x:x,y:y,r:6,max:(target?160:90)*Math.min(power,2.5),hue:h,w:target?5:3});
    if(e===3){ burst(x,y,h,0,power,false);burst(x,y,(h+130)%360,1,power,false);burst(x,y,(h+250)%360,2,power,false); }
    else if(e===0){
      for(var i=0;i<Math.round(10*power);i++){var a=Math.random()*6.28,r=Math.random()*10;parts.push({x:x+Math.cos(a)*r,y:y+Math.sin(a)*r,vx:Math.cos(a)*0.7,vy:Math.sin(a)*0.7,sz:22+Math.random()*26,life:60+Math.random()*36,max:96,hue:h,g:0,tr:false});}
    } else if(e===1){
      for(var j=0;j<Math.round(20*power);j++){var aa=Math.random()*6.28,sp=2.5+Math.random()*5;parts.push({x:x,y:y,vx:Math.cos(aa)*sp,vy:Math.sin(aa)*sp,sz:9+Math.random()*9,life:55+Math.random()*45,max:100,hue:h+(Math.random()*30-15),g:0.08,tr:true});}
    } else {
      for(var k=0;k<Math.round(16*power);k++){var ak=Math.random()*6.28,spk=4+Math.random()*6;parts.push({x:x,y:y,vx:Math.cos(ak)*spk,vy:Math.sin(ak)*spk,sz:7+Math.random()*7,life:42,max:42,hue:h,g:0,tr:true});}
    }
    for(var t=0;t<Math.round(6*power);t++){var ta=Math.random()*6.28,ts=1+Math.random()*5;parts.push({x:x,y:y,vx:Math.cos(ta)*ts,vy:Math.sin(ta)*ts,sz:2+Math.random()*3,life:30+Math.random()*30,max:60,hue:h,g:0,tr:false,spark:true});}
  }

  function missEffect(x,y){
    shocks.push({x:x,y:y,r:6,max:120,hue:0,w:5});
    for(var i=0;i<14;i++){var a=Math.random()*6.28,sp=1+Math.random()*3;parts.push({x:x,y:y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp+0.5,sz:6+Math.random()*6,life:35,max:35,hue:0,sat:30,g:0.12,tr:false});}
  }

  function loseLife(n){
    lives=Math.max(0,lives-n); updateLives();
    flash=Math.max(flash,0.45); flashHue=0; shake=Math.max(shake,16);
    if(lives<=0) endGame();
  }

  function endGame(){
    gameOver=true;
    overStats.innerHTML='到達 LEVEL '+level+' ／ SCORE '+total;
    overEl.style.display='flex';
  }

  function doCapture(caught,clickPt){
    if(caught.length===0){
      if(clickPt){ for(var t=0;t<5;t++){var a=Math.random()*6.28;parts.push({x:clickPt.x,y:clickPt.y,vx:Math.cos(a)*1.5,vy:Math.sin(a)*1.5,sz:5,life:18,max:18,hue:0,sat:0,spark:true});} }
      return;
    }
    var now=performance.now();

    if(bonusActive){
      combo=(now-lastCap<1600)?combo+1:1; lastCap=now;
      var bpow=1+Math.min(combo*0.2,2.5)+(caught.length-1)*0.25, be=eff(level), bg=0;
      caught.forEach(function(o){ burst(o.x,o.y,o.h,be,bpow,true); bg+=20; });
      var bmult=(combo>1?combo:1), badd=bg*bmult*2;
      total+=badd; totalEl.textContent=total;
      floatText(caught[0].x,caught[0].y-caught[0].r-6,'+'+badd,'hsl('+caught[0].h+',90%,70%)');
      shake=Math.max(shake,Math.min(22,5+caught.length*2.2+combo)); flash=Math.max(flash,Math.min(0.6,0.15+caught.length*0.06+combo*0.03)); flashHue=caught[0].h;
      if(combo>=2){ comboText.textContent=combo+' COMBO!'; comboText.style.color='hsl('+((combo*40)%360)+',90%,68%)';
        comboEl.style.transition='none'; comboEl.style.opacity='1'; comboEl.style.transform='scale(1.2)';
        requestAnimationFrame(function(){comboEl.style.transition='opacity .9s, transform .9s';comboEl.style.opacity='0';comboEl.style.transform='scale(1)';}); }
      objs=objs.filter(function(o){return caught.indexOf(o)<0;});
      return;
    }

    var targets=caught.filter(function(o){return o.ci===mColor;});
    var wrongs=caught.filter(function(o){return o.ci!==mColor;});

    if(targets.length>0){
      combo = (wrongs.length===0 && now-lastCap<1600)? combo+1 : (wrongs.length===0?1:0);
      if(wrongs.length===0) lastCap=now;
      var power=1+Math.min(combo*0.2,2.5)+(targets.length-1)*0.25;
      var e=eff(level), gained=0;
      targets.forEach(function(o){ burst(o.x,o.y,o.h,e,power,true); gained+=15; });
      var mult=(combo>1 && wrongs.length===0)?combo:1;
      var add=gained*mult; total+=add; totalEl.textContent=total;
      floatText(targets[0].x,targets[0].y-targets[0].r-6,'+'+add,'hsl('+targets[0].h+',90%,70%)');
      mGot+=targets.length; remainEl.textContent=Math.max(0,mNeed-mGot);
      shake=Math.max(shake,Math.min(20,4+targets.length*2.2+combo*0.8));
      flash=Math.max(flash,Math.min(0.55,0.12+targets.length*0.06+combo*0.03)); if(wrongs.length===0) flashHue=targets[0].h;
      if(combo>=2 && wrongs.length===0){
        comboText.textContent=combo+' COMBO!'; comboText.style.color='hsl('+((combo*40)%360)+',90%,68%)';
        comboEl.style.transition='none'; comboEl.style.opacity='1'; comboEl.style.transform='scale(1.2)';
        requestAnimationFrame(function(){comboEl.style.transition='opacity .9s, transform .9s';comboEl.style.opacity='0';comboEl.style.transform='scale(1)';});
      }
    }
    if(wrongs.length>0){
      combo=0;
      wrongs.forEach(function(o){ missEffect(o.x,o.y); });
      floatText(wrongs[0].x,wrongs[0].y-wrongs[0].r-6,'-'+wrongs.length+'♥','#E24B4A');
      loseLife(wrongs.length);
    }
    objs=objs.filter(function(o){return caught.indexOf(o)<0;});
    if(!gameOver && mGot>=mNeed) levelUp();
  }

  function levelUp(){
    level++; lvEl.textContent=level; tierEl.textContent=TIERS[Math.min(eff(level),3)];
    var e=eff(level);
    flash=0.75; flashHue=(level*55)%360; shake=26;
    lives=MAXLIFE; updateLives();
    floatText(W/2,H/2+44,'体力 全回復 ♥','#3DDC84');
    var clearScore=0;
    objs.forEach(function(o,idx){
      setTimeout((function(ob){return function(){ if(gameOver) return; burst(ob.x,ob.y,ob.h,e,1.5,true); shake=Math.max(shake,10); };})(o), Math.min(idx*45,500));
      clearScore+=8;
    });
    if(objs.length>0){ total+=clearScore; totalEl.textContent=total; }
    objs=[];
    for(var sw=0;sw<3;sw++) shocks.push({x:W/2,y:H/2,r:6,max:Math.max(W,H)*1.1,hue:(level*55+sw*60)%360,w:6});
    for(var st=0;st<18;st++) stars.push({x:Math.random(),y:Math.random(),r:Math.random()*1.6+0.4,p:Math.random()*6.28,sp:0.6+Math.random()*1.8,h:Math.random()*360});
    bannerText.textContent='LEVEL '+level+' — '+TIERS[Math.min(e,3)];
    bannerText.style.color='hsl('+((level*55)%360)+',90%,70%)';
    banner.style.transition='none'; banner.style.opacity='1'; banner.style.transform='translateY(-50%) scale(1.18)';
    requestAnimationFrame(function(){banner.style.transition='opacity 1.1s, transform 1.1s';banner.style.opacity='0';banner.style.transform='translateY(-50%) scale(1)';});
    startBonus();
  }

  function startBonus(){
    bonusActive=true; bonusEnd=performance.now()+BONUS_MS; combo=0; lastCap=0;
    bonusEl.style.display='block'; bonusBar.style.width='100%';
    mname.textContent='囲い放題!'; remainEl.textContent='∞';
    swatch.style.background='conic-gradient(from 0deg,#f44,#fd3,#3d8,#39f,#a3f,#f44)'; swatch.style.boxShadow='0 0 10px rgba(255,255,255,0.6)';
    for(var i=0;i<6;i++) spawn();
  }

  function endBonus(){
    bonusActive=false; combo=0; bonusEl.style.display='none';
    swatch.style.boxShadow='0 0 10px currentColor';
    newMission();
  }

  function pos(e){var r=cv.getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top};}
  function hideHint(){ if(hinted){hinted=false;hint.style.opacity='0';} }

  cv.addEventListener('pointerdown',function(e){if(gameOver)return;drawing=true;moved=false;pathLen=0;downPos=pos(e);path=[downPos];hideHint();try{cv.setPointerCapture(e.pointerId);}catch(_){}});
  cv.addEventListener('pointermove',function(e){
    if(!drawing||gameOver) return;
    var p=pos(e),lp=path[path.length-1],d=Math.hypot(p.x-lp.x,p.y-lp.y);
    if(d>4){ pathLen+=d; path.push(p); if(path.length>400) path.shift(); }
    if(pathLen>12) moved=true;
    if(moved) for(var i=0;i<objs.length;i++) objs[i].inside=inPoly(objs[i].x,objs[i].y,path);
  });
  function endDraw(){
    if(!drawing) return; drawing=false;
    if(gameOver){ for(var k=0;k<objs.length;k++) objs[k].inside=false; path=[]; return; }
    if(!moved){
      var best=null,bd=1e9;
      for(var i=0;i<objs.length;i++){var o=objs[i],dd=Math.hypot(o.x-downPos.x,o.y-downPos.y);if(dd<o.r+14&&dd<bd){bd=dd;best=o;}}
      doCapture(best?[best]:[],downPos);
    } else doCapture(objs.filter(function(o){return o.inside;}),null);
    for(var z=0;z<objs.length;z++) objs[z].inside=false; path=[];
  }
  cv.addEventListener('pointerup',endDraw);
  cv.addEventListener('pointercancel',endDraw);
  restartBtn.addEventListener('click',reset);
  document.addEventListener('gesturestart',function(e){e.preventDefault();});

  function frame(ts){
    var ox=0,oy=0;
    if(shake>0.3){ox=(Math.random()-0.5)*shake;oy=(Math.random()-0.5)*shake;shake*=0.86;}else shake=0;

    ctx.globalCompositeOperation='source-over';
    ctx.fillStyle='rgba(5,5,11,'+Math.max(0.1,0.24-level*0.018)+')';
    ctx.fillRect(-30,-30,W+60,H+60);

    ctx.save(); ctx.translate(ox,oy); ctx.globalCompositeOperation='lighter';

    var nb=ts*0.0005, nbN=Math.min(2+level,7);
    for(var b=0;b<nbN;b++){
      var bx=W*0.5+Math.cos(nb+b*1.6)*W*0.4, by=H*0.5+Math.sin(nb*1.25+b*2.0)*H*0.42;
      var bg=ctx.createRadialGradient(bx,by,0,bx,by,150+level*8);
      var nh=((level*40)+b*45)%360;
      bg.addColorStop(0,'hsla('+nh+',85%,55%,'+(0.04+level*0.006)+')');
      bg.addColorStop(1,'hsla('+nh+',85%,55%,0)');
      ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    }

    for(var si=0;si<stars.length;si++){
      var st=stars[si]; st.p+=0.05*st.sp; var tw=(Math.sin(st.p)*0.5+0.5);
      ctx.fillStyle='hsla('+st.h+',80%,80%,'+(0.2+tw*0.7)+')';
      ctx.beginPath(); ctx.arc(st.x*W,st.y*H,st.r*(0.6+tw*0.8),0,6.2832); ctx.fill();
    }

    for(var sh=shocks.length-1;sh>=0;sh--){
      var sk=shocks[sh]; sk.r+=7; var sl=1-sk.r/sk.max;
      if(sl<=0){shocks.splice(sh,1);continue;}
      ctx.strokeStyle='hsla('+sk.hue+',95%,68%,'+(sl*0.9)+')'; ctx.lineWidth=sk.w*sl+0.5;
      ctx.beginPath(); ctx.arc(sk.x,sk.y,sk.r,0,6.2832); ctx.stroke();
    }

    for(var i=parts.length-1;i>=0;i--){
      var p=parts[i]; p.life--; var px=p.x,py=p.y; p.x+=p.vx; p.y+=p.vy; p.vx*=0.96; p.vy*=0.96; p.vy+=p.g||0;
      if(p.life<=0){parts.splice(i,1);continue;}
      var tt=p.life/p.max, sat=(p.sat!==undefined?p.sat:92);
      if(p.spark){ ctx.fillStyle='hsla('+p.hue+','+sat+'%,82%,'+tt+')'; ctx.beginPath(); ctx.arc(p.x,p.y,p.sz*(0.5+tt*0.8),0,6.2832); ctx.fill(); continue; }
      if(p.tr){ ctx.strokeStyle='hsla('+p.hue+','+sat+'%,64%,'+(tt*0.7)+')'; ctx.lineWidth=p.sz*tt*0.5+0.5; ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(p.x,p.y); ctx.stroke(); }
      var rad=Math.max(p.sz*tt,1), gr=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,rad), c='hsla('+p.hue+','+sat+'%,62%,';
      gr.addColorStop(0,c+(0.6*tt)+')'); gr.addColorStop(1,c+'0)');
      ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(p.x,p.y,rad,0,6.2832); ctx.fill();
    }

    for(var o=0;o<objs.length;o++){
      var ob=objs[o]; if(!gameOver){ob.x+=ob.vx; ob.y+=ob.vy;} ob.pulse+=0.08;
      var isT=ob.ci===mColor;
      var pr=ob.r*(ob.inside?1.5:1)+(ob.inside?Math.sin(ob.pulse*2)*2:0)+(isT?Math.sin(ob.pulse)*1.5:0);
      ctx.globalCompositeOperation='lighter';
      var og=ctx.createRadialGradient(ob.x,ob.y,0,ob.x,ob.y,pr*(isT?3:2.4));
      og.addColorStop(0,'hsla('+ob.h+',92%,60%,'+(ob.inside?1:(isT?0.7:0.42))+')');
      og.addColorStop(1,'hsla('+ob.h+',92%,60%,0)');
      ctx.fillStyle=og; ctx.beginPath(); ctx.arc(ob.x,ob.y,pr*(isT?3:2.4),0,6.2832); ctx.fill();
      ctx.globalCompositeOperation='source-over';
      ctx.fillStyle='hsl('+ob.h+',88%,'+(ob.inside?80:62)+'%)';
      ctx.beginPath(); ctx.arc(ob.x,ob.y,pr,0,6.2832); ctx.fill();
      if(isT){ ctx.strokeStyle='rgba(255,255,255,'+(0.5+Math.sin(ob.pulse)*0.4)+')'; ctx.lineWidth=2.5; ctx.beginPath(); ctx.arc(ob.x,ob.y,pr+4,0,6.2832); ctx.stroke(); }
      if(ob.inside){ ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(ob.x,ob.y,pr+3,0,6.2832); ctx.stroke(); }
    }
    objs=objs.filter(function(o){return o.x>-60&&o.x<W+60&&o.y>-60&&o.y<H+60;});

    if(moved && path.length>1){
      ctx.globalCompositeOperation='lighter'; var ph=(level*55)%360;
      if(path.length>2){ ctx.fillStyle='hsla('+ph+',92%,60%,0.12)'; ctx.beginPath(); ctx.moveTo(path[0].x,path[0].y); for(var q=1;q<path.length;q++) ctx.lineTo(path[q].x,path[q].y); ctx.closePath(); ctx.fill(); }
      ctx.strokeStyle='hsla('+ph+',95%,72%,0.95)'; ctx.lineWidth=3; ctx.lineJoin='round'; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(path[0].x,path[0].y); for(var zz=1;zz<path.length;zz++) ctx.lineTo(path[zz].x,path[zz].y); ctx.stroke();
    }

    ctx.globalCompositeOperation='source-over';
    for(var f=floats.length-1;f>=0;f--){
      var ft=floats[f]; ft.life--; ft.y-=0.6; if(ft.life<=0){floats.splice(f,1);continue;}
      ctx.globalAlpha=Math.min(1,ft.life/20); ctx.fillStyle=ft.col; ctx.font='600 16px sans-serif'; ctx.textAlign='center';
      ctx.fillText(ft.txt,ft.x,ft.y); ctx.globalAlpha=1;
    }

    ctx.restore();

    if(flash>0.01){ ctx.globalCompositeOperation='lighter'; ctx.fillStyle='hsla('+flashHue+',90%,60%,'+flash+')'; ctx.fillRect(0,0,W,H); flash*=0.85; }

    if(bonusActive){
      var rem=bonusEnd-ts;
      if(rem<=0) endBonus();
      else bonusBar.style.width=Math.max(0,Math.min(100,rem/BONUS_MS*100))+'%';
    }

    if(!gameOver){ spawnT++; if(spawnT>=(bonusActive?6:Math.max(20,56-level*4))){ spawnT=0; spawn(); } }
    requestAnimationFrame(frame);
  }

  resize();
  reset();
  requestAnimationFrame(frame);
  setTimeout(function(){ if(hinted) hint.style.opacity='0'; },7000);
})();
