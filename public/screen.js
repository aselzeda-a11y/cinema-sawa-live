'use strict';
// شاشة واحدة لكل غرفة، ومحادثة صوتية صغيرة بأسلوب peer-to-peer / WebRTC.
// الغرفة على الخادم تحفظ معلومات الإشارة فقط؛ الخادم لا يستقبل ملفات الفيديو.
(function () {
  const el = id => document.getElementById(id);
  const stageVideo = el('screen-player');
  const screenOut = new Map(); // viewerId -> RTCPeerConnection
  const voiceOut = new Map(); // listenerId -> RTCPeerConnection
  const voiceIn = new Map(); // ownerId -> RTCPeerConnection
  let screenIn = null, screenInOwner = null;
  let screenStream = null, micStream = null;
  let screenOwner = null, screenOwnerName = null;
  let otherMics = new Set(), roomMembers = [];
  let lastRoom = null;
  let iceServers = [{urls:'stun:stun.l.google.com:19302'}];
  const queuedIce = new Map();
  const voiceAudio = new Map();
  let audioEnabled = false;

  fetch('/api/ice').then(r => r.ok ? r.json() : null).then(v => {
    if (v && Array.isArray(v.iceServers) && v.iceServers.length) iceServers = v.iceServers;
  }).catch(() => {});
  function updateStatus(t) { el('stream-status').textContent = t; }
  function paintMicBadges(){
    document.querySelectorAll('#member-list .member').forEach(item=>{
      const on=otherMics.has(item.dataset.userId) || (item.dataset.userId===socket.id && !!micStream);
      let tag=item.querySelector('.mic-badge');
      if(on&&!tag){tag=document.createElement('small');tag.className='mic-badge';tag.textContent='🎙️';item.append(tag);}
      if(!on&&tag)tag.remove();
    });
  }
  function setVisible(id, yes) { el(id).classList.toggle('hidden', !yes); }
  function showMode(mode) {
    const screen = mode === 'screen';
    const sync = mode === 'sync';
    const netflix = mode === 'netflix';
    setVisible('screen-section', screen);
    setVisible('sync-section', sync);
    setVisible('netflix-section', netflix);
    for (const [key, active] of [['screen', screen], ['sync', sync], ['netflix', netflix]]) {
      el('mode-'+key).classList.toggle('selected', active);
      el('mode-'+key).setAttribute('aria-selected', String(active));
    }
  }
  el('mode-screen').addEventListener('click', () => showMode('screen'));
  el('mode-sync').addEventListener('click', () => showMode('sync'));
  el('mode-netflix').addEventListener('click', () => showMode('netflix'));

  function signal(kind, ownerId, to, data) {
    if (joinedCode && socket.connected) socket.emit('rtc-signal', {kind, ownerId, to, data});
  }
  function dropPc(pc) { if (pc) { try { pc.onicecandidate = null; pc.ontrack = null; pc.close(); } catch {} } }
  function dropScreenPeers() {
    for (const pc of screenOut.values()) dropPc(pc);
    screenOut.clear();
    dropPc(screenIn); screenIn = null; screenInOwner = null;
    for (const key of [...queuedIce.keys()]) if (key.startsWith('screen:')) queuedIce.delete(key);
  }
  function dropVoicePeers() {
    for (const pc of voiceOut.values()) dropPc(pc); voiceOut.clear();
    for (const pc of voiceIn.values()) dropPc(pc); voiceIn.clear();
    for (const a of voiceAudio.values()) {a.pause();a.srcObject=null;a.remove();} voiceAudio.clear();
    for (const key of [...queuedIce.keys()]) if (key.startsWith('voice:')) queuedIce.delete(key);
  }
  function sourceKey(kind, ownerId, remoteId) {return `${kind}:${ownerId}:${remoteId}`;}
  function createPc(kind, ownerId, remoteId) {
    const pc = new RTCPeerConnection({iceServers, bundlePolicy:'max-bundle'});
    pc.onicecandidate = ev => {
      if (ev.candidate) signal(kind, ownerId, remoteId, {type:'candidate', candidate:ev.candidate.toJSON()});
    };
    pc.onconnectionstatechange = () => {
      if (kind==='screen' && pc===screenIn) {
        if (pc.connectionState==='connected') {
          setVisible('screen-buffering', false);
          updateStatus(`🟢 متصل ببث ${screenOwnerName||'صاحب الشاشة'} — اضغط تفعيل الصوت إذا ما سمعته.`);
        } else if (pc.connectionState==='failed') {
          updateStatus('تعذّر الاتصال المباشر. قد تحتاج شبكة مختلفة أو إعداد خادم TURN.');
          setVisible('screen-buffering', false);
        }
      }
    };
    pc.ontrack = ev => {
      const stream = ev.streams?.[0] || new MediaStream([ev.track]);
      if (kind==='screen' && ownerId===screenOwner && pc===screenIn) {
        if (stageVideo.srcObject !== stream) stageVideo.srcObject = stream;
        setVisible('screen-empty', false);
        setVisible('live-indicator', true);
        stageVideo.muted = !audioEnabled;
        stageVideo.play().catch(() => {
          stageVideo.muted = true;
          stageVideo.play().catch(() => {});
          updateStatus('الصورة وصلت. اضغط «تفعيل الصوت» حتى تسمع البث.');
        });
      }
      if (kind==='voice') {
        let audio = voiceAudio.get(ownerId);
        if (!audio) {
          audio = document.createElement('audio');
          audio.autoplay = true;
          audio.playsInline = true;
          audio.style.display='none';
          audio.dataset.voiceOwner=ownerId;
          document.body.append(audio);
          voiceAudio.set(ownerId, audio);
        }
        audio.srcObject = stream;
        audio.muted = !audioEnabled;
        audio.play().catch(() => updateStatus('🎙️ لتسمع أصحابك اضغط «تفعيل الصوت».'));
      }
    };
    return pc;
  }
  async function flushIce(kind, ownerId, remoteId, pc) {
    const key = sourceKey(kind, ownerId, remoteId);
    for (const candidate of queuedIce.get(key)||[]) {
      try { await pc.addIceCandidate(candidate); } catch(e) {console.debug('ICE skip',e);}
    }
    queuedIce.delete(key);
  }
  function storeCandidate(kind, ownerId, remoteId, candidate) {
    const key = sourceKey(kind, ownerId, remoteId);
    if (!queuedIce.has(key)) queuedIce.set(key,[]);
    const queue=queuedIce.get(key);
    if (queue.length<100) queue.push(candidate);
  }
  async function outgoing(kind, viewerId) {
    const ownerId=socket.id;
    const stream=kind==='screen' ? screenStream : micStream;
    const map=kind==='screen' ? screenOut : voiceOut;
    if (!stream || !joinedCode || viewerId===socket.id || !roomMembers.some(m=>m.id===viewerId)) return;
    dropPc(map.get(viewerId));
    const pc=createPc(kind,ownerId,viewerId);
    map.set(viewerId,pc);
    try {
      stream.getTracks().filter(t=>t.readyState==='live').forEach(t=>pc.addTrack(t,stream));
      const offer=await pc.createOffer();
      await pc.setLocalDescription(offer);
      signal(kind,ownerId,viewerId,{type:'offer',sdp:offer.sdp});
      await flushIce(kind,ownerId,viewerId,pc);
    } catch(e) { console.warn('Outgoing WebRTC',e); dropPc(pc);map.delete(viewerId); }
  }
  async function receiveSignal({kind,ownerId,from,data}) {
    if (!joinedCode || !['screen','voice'].includes(kind)) return;
    if (kind==='screen' && ownerId!==screenOwner) return;
    if (kind==='voice' && ownerId!==socket.id && !otherMics.has(ownerId)) return;
    const asOwner=ownerId===socket.id;
    let pc=asOwner ? (kind==='screen'?screenOut:voiceOut).get(from) : (kind==='screen'?screenIn:voiceIn.get(ownerId));
    try {
      if (data.type==='offer') {
        if(asOwner) return;
        if(kind==='screen') {
          dropPc(screenIn);
          screenIn=createPc(kind,ownerId,from);
          screenInOwner=ownerId;
          pc=screenIn;
        } else {
          dropPc(voiceIn.get(ownerId));
          pc=createPc(kind,ownerId,from);
          voiceIn.set(ownerId,pc);
        }
        await pc.setRemoteDescription({type:'offer',sdp:data.sdp});
        await flushIce(kind,ownerId,from,pc);
        const answer=await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal(kind,ownerId,from,{type:'answer',sdp:answer.sdp});
      } else if (data.type==='answer') {
        if(!asOwner||!pc) return;
        if(pc.signalingState==='have-local-offer') await pc.setRemoteDescription({type:'answer',sdp:data.sdp});
        await flushIce(kind,ownerId,from,pc);
      } else if(data.type==='candidate' && data.candidate) {
        if(!pc || !pc.remoteDescription) storeCandidate(kind,ownerId,from,data.candidate);
        else await pc.addIceCandidate(data.candidate);
      }
    } catch(e) {console.warn('WebRTC signal',kind,e);updateStatus('مشكلة اتصال مؤقتة مع أحد الأجهزة، جرّب إعادة الدخول.');}
  }
  socket.on('rtc-signal', receiveSignal);
  socket.on('rtc-request', ({kind,from})=>{
    if (kind==='screen' && screenStream && screenOwner===socket.id) outgoing('screen',from);
    if (kind==='voice' && micStream) outgoing('voice',from);
  });
  function requestMedia(kind, ownerId) {
    if (!ownerId || ownerId===socket.id || !joinedCode) return;
    socket.emit('rtc-request',{kind,ownerId});
  }
  function updateSharingUI() {
    const amOwner=screenOwner===socket.id && !!screenStream;
    setVisible('start-screen', !amOwner);
    setVisible('stop-screen', amOwner);
    if (screenOwner && !amOwner) {
      el('start-screen').disabled=true;
      el('start-screen').textContent='📺 الشاشة مشتركة الآن';
    } else {
      el('start-screen').disabled=false;
      el('start-screen').textContent='↗ مشاركة شاشتي';
    }
    if (screenOwner) {
      setVisible('live-indicator',true);
      el('broadcast-name').textContent=screenOwnerName || 'مشاركة الشاشة';
    } else setVisible('live-indicator',false);
  }
  function clearStage() {
    stageVideo.pause();stageVideo.srcObject=null;stageVideo.muted=true;
    setVisible('screen-empty',true);
    setVisible('screen-buffering',false);
  }
  function ownerUpdate({id,name}) {
    if (id!==screenOwner) dropScreenPeers();
    screenOwner=id;
    screenOwnerName=name;
    updateSharingUI();
    if (!id) {
      clearStage();updateStatus('ما في بث شغّال حاليًا. اختار «مشاركة شاشتي» للبدء.');
    } else if(id===socket.id && screenStream) {
      stageVideo.srcObject=screenStream; stageVideo.muted=true;
      stageVideo.play().catch(()=>{});
      setVisible('screen-empty',false);
      setVisible('screen-buffering',false);
      updateStatus('🟢 إنت عم تشارك شاشتك. أوقف البث من الزر الأحمر أو من إشعار المتصفح.');
    } else if (id!==socket.id) {
      clearStage();setVisible('screen-buffering',true);showMode('screen');
      updateStatus(`جاري استقبال مشاركة شاشة ${name||'صاحب الغرفة'}…`);
      requestMedia('screen',id);
    }
  }
  socket.on('screen-owner', ownerUpdate);
  socket.on('voice-member', ({id,active})=>{
    if(id===socket.id) return;
    if(active){otherMics.add(id);requestMedia('voice',id);}
    else {
      otherMics.delete(id);
      dropPc(voiceIn.get(id));voiceIn.delete(id);
      const a=voiceAudio.get(id);if(a){a.pause();a.srcObject=null;a.remove();voiceAudio.delete(id);}
    }
    paintMicBadges();
  });
  socket.on('members', ({members})=>{
    roomMembers=members;
    paintMicBadges();
    const ids=new Set(members.map(m=>m.id));
    for(const [id,pc] of screenOut) if(!ids.has(id)){dropPc(pc);screenOut.delete(id);}
    for(const [id,pc] of voiceOut) if(!ids.has(id)){dropPc(pc);voiceOut.delete(id);}
  });
  socket.on('room-joined', room => {
    if (lastRoom && room.code!==lastRoom) {hardStop();}
    lastRoom=room.code;
    roomMembers=room.members||[];
    otherMics=new Set((room.micIds||[]).filter(id=>id!==socket.id));
    paintMicBadges();
    ownerUpdate({id:room.screenOwnerId||null,name:room.members.find(m=>m.id===room.screenOwnerId)?.name||null});
    for(const id of otherMics)requestMedia('voice',id);
    // Return to the same room after an SSE reconnect, without asking for screen/mic permissions again.
    if(screenStream?.getVideoTracks().some(t=>t.readyState==='live')) {
      socket.emit('screen-start',{},reply=>{if(reply?.ok)ownerUpdate({id:socket.id,name:ownName});else stopCapture(false);});
    }
    if(micStream?.getAudioTracks().some(t=>t.readyState==='live'))socket.emit('voice-start');
    showMode('screen');
  });
  socket.on('disconnect',()=>{
    dropScreenPeers();dropVoicePeers();
    if(joinedCode)updateStatus('انقطع الاتصال، جاري المحاولة…');
  });

  async function startCapture() {
    if (!joinedCode) return showToast('ادخل الغرفة أولًا');
    if(screenOwner && screenOwner!==socket.id) return showToast('في شخص ثاني عم يشارك شاشته');
    if(!navigator.mediaDevices?.getDisplayMedia) {
      updateStatus('مشاركة الشاشة غير متاحة بهالمتصفح أو إصدار نظام الهاتف. جرّب Chrome / Edge على الكمبيوتر.');
      return showToast('هالجهاز ما بدعم مشاركة الشاشة من المتصفح');
    }
    const btn=el('start-screen');btn.disabled=true;
    let captured;
    try {
      captured=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:24},audio:true,systemAudio:'include',surfaceSwitching:'include'});
      if(!captured.getVideoTracks().length) throw new Error('No video track');
      screenStream=captured;
      const result=await new Promise(resolve=>socket.emit('screen-start',{},resolve));
      if(!result?.ok) throw new Error(result?.error||'لم تنجح مشاركة الشاشة');
      captured.getVideoTracks()[0].addEventListener('ended', ()=>stopCapture(),{once:true});
      ownerUpdate({id:socket.id,name:ownName});
      showMode('screen');
      if(!captured.getAudioTracks().length) showToast('الشاشة شغالة، بس الصوت مش مشارك. جرّب مشاركة تبويب مع صوت.');
      else showToast('البث شغّال بالصورة والصوت! 🎉');
    } catch(e) {
      if(captured)captured.getTracks().forEach(t=>t.stop());
      screenStream=null;
      if(e.name!=='NotAllowedError') showToast(e.message||'تعذّر بدء مشاركة الشاشة');
      else showToast('تم إلغاء إذن مشاركة الشاشة');
      if(screenOwner===socket.id)socket.emit('screen-stop');
      ownerUpdate({id:null,name:null});
    } finally {btn.disabled=false;}
  }
  function stopCapture(notify=true) {
    const had=!!screenStream;
    const stream=screenStream;screenStream=null;
    if(stream)stream.getTracks().forEach(t=>t.stop());
    if(screenOwner===socket.id){socket.emit('screen-stop');ownerUpdate({id:null,name:null});}
    if(had&&notify)showToast('توقف بث الشاشة');
  }
  el('start-screen').addEventListener('click',startCapture);
  el('stop-screen').addEventListener('click',()=>stopCapture());
  async function enableAudio() {
    audioEnabled=true;
    stageVideo.muted=screenOwner===socket.id;
    try { await stageVideo.play(); }catch{}
    for(const a of voiceAudio.values()) {a.muted=false;try{await a.play();}catch{}}
    showToast('الصوت مفعّل 🔊');
    el('listen-button').textContent='🔊 الصوت مفعّل';
  }
  el('listen-button').addEventListener('click',enableAudio);
  // iPhone Safari يسمح بملء شاشة عنصر الفيديو نفسه؛ CSS cinema-mode يعمل كبديل للواجهة.
  function leaveCinema(){document.body.classList.remove('cinema-mode');}
  el('cinema-close').addEventListener('click',leaveCinema);
  el('sync-cinema-close').addEventListener('click',leaveCinema);
  window.addEventListener('keydown', ev=>{if(ev.key==='Escape')leaveCinema();});
  async function enterCinema(stage, video) {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    if (document.body.classList.contains('cinema-mode')) {leaveCinema();return;}
    if (video && video.srcObject && typeof video.webkitEnterFullscreen==='function') {
      try {video.webkitEnterFullscreen();return;} catch {}
    }
    if (typeof stage.requestFullscreen==='function') {
      try {await stage.requestFullscreen();return;} catch {}
    }
    document.body.classList.add('cinema-mode');
    showToast('وضع السينما: ملأنا مساحة الصفحة. لإخفاء شريط Safari، أضف التطبيق للشاشة الرئيسية.');
  }
  el('fullscreen-button').addEventListener('click',()=>enterCinema(el('screen-stage'),stageVideo));
  el('sync-fullscreen').addEventListener('click',()=>{
    const video=el('html-player');
    // اليوتيوب نفسه قد يعرض زر الملء الأصلي؛ للـ iframe هنا نستعمل وضع السينما.
    enterCinema(el('player-wrap'),video.classList.contains('hidden') ? null : video);
  });
  async function toggleMic() {
    if(micStream){stopMic();return;}
    if(!joinedCode)return;
    if(!navigator.mediaDevices?.getUserMedia)return showToast('الميكروفون غير متاح هنا');
    const btn=el('mic-toggle');btn.disabled=true;
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      micStream=stream;
      stream.getAudioTracks()[0]?.addEventListener('ended',()=>stopMic(),{once:true});
      const ack=await new Promise(resolve=>socket.emit('voice-start',{},resolve));
      if(!ack?.ok)throw new Error('فشل تفعيل المايك');
      btn.textContent='🎙️ إيقاف المايك';btn.setAttribute('aria-pressed','true');
      showToast('المايك شغّال 🎙️');paintMicBadges();
    }catch(e){stopMic();showToast(e.name==='NotAllowedError'?'اسمح للمايك من إعدادات المتصفح':e.message||'تعذّر تشغيل المايك');}
    finally{btn.disabled=false;}
  }
  function stopMic(){
    const stream=micStream;micStream=null;
    if(stream)stream.getTracks().forEach(t=>t.stop());
    socket.emit('voice-stop');
    for(const pc of voiceOut.values())dropPc(pc);voiceOut.clear();
    el('mic-toggle').textContent='🎙️ تشغيل المايك';el('mic-toggle').setAttribute('aria-pressed','false');paintMicBadges();
  }
  el('mic-toggle').addEventListener('click',toggleMic);
  function hardStop(){stopCapture(false);stopMic();dropScreenPeers();dropVoicePeers();otherMics.clear();screenOwner=null;clearStage();}
  // Capture phase: stop local streams before the existing leave-room handler emits leave.
  el('leave-button').addEventListener('click',()=>{hardStop();lastRoom=null;},{capture:true});
  window.addEventListener('pagehide',()=>{if(screenStream)screenStream.getTracks().forEach(t=>t.stop());if(micStream)micStream.getTracks().forEach(t=>t.stop());});
  updateSharingUI();
})();
