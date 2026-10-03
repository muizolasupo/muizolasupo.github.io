const menu=document.querySelector('.menu'),links=document.querySelector('.links');
if(menu&&links){menu.setAttribute('aria-expanded','false');menu.addEventListener('click',()=>{const open=links.classList.toggle('open');menu.setAttribute('aria-expanded',String(open))});links.addEventListener('click',()=>{links.classList.remove('open');menu.setAttribute('aria-expanded','false')})}
document.querySelectorAll('[data-year]').forEach(el=>el.textContent=new Date().getFullYear());
document.querySelectorAll('[data-carousel]').forEach(carousel=>{
 const slides=[...carousel.querySelectorAll('.slide')],dots=[...carousel.querySelectorAll('.carousel-dot')],play=carousel.querySelector('[data-play]'),status=carousel.querySelector('[data-slide-status]');let current=0,startX=null,startY=null,timer=null;
 const stop=()=>{clearInterval(timer);timer=null;if(play){play.textContent='Play slides';play.setAttribute('aria-pressed','false')}};
 const show=i=>{current=(i+slides.length)%slides.length;slides.forEach((s,n)=>{s.hidden=n!==current;s.classList.toggle('active',n===current);s.setAttribute('aria-hidden',String(n!==current))});dots.forEach((d,n)=>{d.classList.toggle('active',n===current);d.setAttribute('aria-pressed',String(n===current))});if(status)status.textContent='Slide '+(current+1)+' of '+slides.length+': '+dots[current].textContent.trim()};
 const manual=i=>{stop();show(i)};
 carousel.querySelector('.prev').addEventListener('click',()=>manual(current-1));carousel.querySelector('.next').addEventListener('click',()=>manual(current+1));
 dots.forEach((d,i)=>d.addEventListener('click',()=>manual(i)));
 if(play)play.addEventListener('click',()=>{if(timer){stop();return}play.textContent='Pause slides';play.setAttribute('aria-pressed','true');timer=setInterval(()=>show(current+1),9000)});
 carousel.addEventListener('keydown',e=>{if(e.target.closest('[data-preview]'))return;if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();manual(current+(e.key==='ArrowRight'?1:-1))}});
 carousel.addEventListener('touchstart',e=>{startX=e.changedTouches[0].clientX;startY=e.changedTouches[0].clientY},{passive:true});
 carousel.addEventListener('touchend',e=>{const delta=e.changedTouches[0].clientX-startX,dy=e.changedTouches[0].clientY-startY;if(startX!==null&&Math.abs(delta)>60&&Math.abs(delta)>Math.abs(dy))manual(current+(delta<0?1:-1));startX=null},{passive:true});
 carousel.addEventListener('focusin',e=>{if(e.target!==play)stop()});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stop()});
 show(0);
});
document.querySelectorAll('[data-preview]').forEach(preview=>{
 const buttons=[...preview.querySelectorAll('[data-preview-step]')],panels=[...preview.querySelectorAll('[data-preview-panel]')];
 buttons.forEach((button,i)=>button.addEventListener('click',()=>{buttons.forEach((b,j)=>b.setAttribute('aria-pressed',String(i===j)));panels.forEach((p,j)=>p.hidden=i!==j)}));
});
