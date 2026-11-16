// Netflix is a manual watch-along coordinator: no DRM video capture or playback controls.
'use strict';
(function () {
  const el = id=>document.getElementById(id);
  const title=el('netflix-title');
  let cueAt=0;
  let interval=null;
  function display(data){
    const name=data?.title||'';
    el('netflix-current').textContent=name || 'لسه ما اخترنا إشي';
    cueAt=Number(data?.cueAt)||0;
    paintClock();
  }
  function paintClock(){
    if(interval){clearInterval(interval);interval=null;}
    const box=el('netflix-clock');
    if(!cueAt){box.textContent='جاهزين؟ اختاروا الفيلم واضغطوا العد التنازلي.';return;}
    const tick=()=>{
      const remaining=Math.ceil((cueAt-Date.now())/1000);
      if(remaining<=0){box.textContent='▶ بلّشوا الفيلم الآن! 🍿';clearInterval(interval);interval=null;return;}
      box.textContent=`⏳ ${remaining} ثوانٍ… جهّزوا تشغيل الفيلم`;
    };
    tick();if(cueAt>Date.now())interval=setInterval(tick,250);
  }
  socket.on('room-joined',room=>{display(room.netflix);});
  socket.on('netflix-updated',data=>{display(data);showToast('تم إرسال اسم الفيلم لكل الغرفة 🍿');});
  socket.on('netflix-cue',data=>{display(data);showToast('بلّش العد التنازلي لكل الغرفة!');});
  el('netflix-title-form').addEventListener('submit',event=>{
    event.preventDefault();
    if(!joinedCode)return showToast('ادخل غرفة أولًا');
    socket.emit('set-netflix',{title:title.value.trim()},result=>{
      if(!result?.ok)showToast(result?.error||'ما قدرنا نحدد الفيلم');
      else title.value='';
    });
  });
  el('netflix-countdown').addEventListener('click',()=>{
    if(!joinedCode)return showToast('ادخل غرفة أولًا');
    socket.emit('netflix-cue',{},result=>{if(!result?.ok)showToast(result?.error||'ما قدرنا نبدأ العد');});
  });
})();
