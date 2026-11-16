'use strict';
const $ = id => document.getElementById(id);
const socket = io({ reconnection: true });
const qs = new URLSearchParams(location.search);
const initialCode = (qs.get('room') || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
let joinedCode = null, ownName = '', modalMode = 'create', currentVideo = null;
let yt = null, ytReady = false, htmlVideo = $('html-player');
let suppressUntil = 0, lastYoutubePos = null, lastYoutubeCheck = 0, lastYoutubeState = -1;
let remotePlayback = { position: 0, playing: false, updatedAt: Date.now() };
let duration = 0, dragging = false, wasConnected = false, lastSentPosition = -1;
let toastTimer, typingTimer, lastTypingSent = 0, ytApiReady = false;
const $modal = $('modal-overlay');
let $videoHolder = $('yt-player');

function showToast(s) { const el = $('toast'); el.textContent = s; el.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 2900); }
function showError(s) { $('modal-error').textContent = s; $('modal-error').classList.remove('hidden'); }
function fmtTime(s) { s = Math.max(0, Math.floor(Number(s)||0)); const m = Math.floor(s/60), sec = String(s%60).padStart(2,'0'); return m >= 60 ? `${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}:${sec}` : `${m}:${sec}`; }
function roomLink() { return `${location.origin}/?room=${encodeURIComponent(joinedCode)}`; }
function openModal(mode, code = '') {
  modalMode = mode;
  const join = mode === 'join';
  $('modal-title').textContent = join ? 'ادخل سهرة أصحابك 🍿' : 'اعمل غرفة جديدة 🎬';
  $('modal-description').textContent = join ? 'اكتب اسمك ورمز الغرفة اللي وصلك من صاحبك.' : 'اختار اسم إلك وللغرفة، وبعدها ابعت الرابط لأصحابك.';
  $('modal-tag').textContent = join ? 'انضم للسهرة' : 'ابدأ السهرة';
  $('modal-submit').textContent = join ? 'ادخل الغرفة' : 'أنشئ الغرفة';
  $('title-field').classList.toggle('hidden', join);
  $('code-field').classList.toggle('hidden', !join);
  $('join-code').value = code;
  $('nickname').value = localStorage.getItem('cinema-nickname') || '';
  $('modal-error').classList.add('hidden');
  $('modal-submit').disabled = false;
  $modal.classList.remove('hidden');
  setTimeout(() => (join && code ? $('nickname') : $('nickname')).focus(), 60);
}
function closeModal(){ $modal.classList.add('hidden'); }
$('create-button').addEventListener('click', () => openModal('create'));
$('join-button').addEventListener('click', () => openModal('join'));
$('modal-close').addEventListener('click', closeModal);
$modal.addEventListener('click', ev => { if (ev.target === $modal && !initialCode) closeModal(); });
$('room-form').addEventListener('submit', ev => {
  ev.preventDefault();
  if (!socket.connected) return showError('ما في اتصال بالخادم. حاول بعد شوي.');
  ownName = $('nickname').value.trim().slice(0, 24);
  if (!ownName) return showError('اكتب اسمك أولًا.');
  localStorage.setItem('cinema-nickname', ownName);
  const btn = $('modal-submit'); btn.disabled = true; $('modal-error').classList.add('hidden');
  const isJoin = modalMode === 'join';
  const payload = isJoin ? { name: ownName, code: $('join-code').value } : { name: ownName, title: $('new-title').value };
  socket.emit(isJoin ? 'join-room' : 'create-room', payload, result => {
    btn.disabled = false;
    if (!result?.ok) showError(result?.error || 'تعذّر دخول الغرفة، جرّب مرة ثانية.');
  });
  setTimeout(() => { btn.disabled = false; }, 7000);
});

socket.on('connect', () => {
  $('connection-label').textContent = 'متّصلين وجاهزين';
  if (wasConnected && joinedCode && ownName) {
    socket.emit('join-room', { code: joinedCode, name: ownName }, result => {
      if (!result?.ok) { resetToHome(); showToast('الغرفة انتهت. افتح غرفة جديدة.'); }
      else showToast('رجع الاتصال بالغرفة ✓');
    });
  }
  wasConnected = true;
});
socket.on('disconnect', () => { $('connection-label').textContent = 'جاري إعادة الاتصال…'; });
socket.on('room-joined', room => {
  joinedCode = room.code;
  closeModal();
  $('home-view').classList.add('hidden');
  $('room-view').classList.remove('hidden');
  $('room-title').textContent = room.title;
  $('room-code').textContent = room.code;
  history.replaceState(null, '', `/?room=${encodeURIComponent(room.code)}`);
  updateMembers({ members: room.members, hostId: room.hostId });
  $('messages').replaceChildren();
  room.history.forEach(renderMessage);
  if (!room.video) clearVideo();
  else loadVideo(room.video, room.playback);
  if (!room.history.length) renderSystem('أهلًا في سهرتكم! 🍿 ابعت الرابط لأصحابك.');
});
socket.on('members', updateMembers);
socket.on('system-message', ev => { if (joinedCode) renderSystem(ev.text); });
socket.on('chat-message', msg => { if (joinedCode) renderMessage(msg); });
socket.on('typing', ev => {
  if (!joinedCode) return;
  $('typing').textContent = `${ev.name} بكتب...`;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => $('typing').textContent = '', 1800);
});
socket.on('video-changed', ev => {
  if (!joinedCode) return;
  loadVideo(ev.video, ev.playback);
  renderSystem(`${ev.by} اختار فيديو جديد 🎬`);
});
socket.on('playback', ev => {
  if (!joinedCode) return;
  applyPlayback(ev);
});
socket.on('sync', data => {
  if (!joinedCode) return;
  if (data.video && (!currentVideo || data.video.type !== currentVideo.type || data.video.value !== currentVideo.value)) loadVideo(data.video, data.playback);
  else applyPlayback(data.playback);
  showToast('تمّت المزامنة مع الغرفة ✓');
});

function updateMembers(data) {
  const list = $('member-list'); list.replaceChildren();
  $('member-count').textContent = `${data.members.length} ${data.members.length === 1 ? 'شخص' : 'أشخاص'}`;
  for (const m of data.members) {
    const el = document.createElement('span'); el.className = 'member'; el.dataset.userId = m.id;
    const av = document.createElement('span'); av.className = 'member-avatar'; av.textContent = (m.name || 'ض')[0];
    const txt = document.createElement('span'); txt.textContent = m.name + (m.id === socket.id ? ' (إنت)' : '');
    el.append(av, txt);
    if (m.id === data.hostId) { const crown = document.createElement('small'); crown.textContent = '👑'; el.append(crown); }
    list.append(el);
  }
}
function renderSystem(t) { const el = document.createElement('div'); el.className = 'message system'; const span = document.createElement('span'); span.textContent = t; el.append(span); $('messages').append(el); bottomChat(); }
function renderMessage(m) {
  const el = document.createElement('div'); el.className = 'message' + (m.senderId === socket.id ? ' self' : '');
  const meta = document.createElement('div'); meta.className = 'meta';
  const name = document.createElement('b'); name.textContent = m.sender;
  const time = document.createElement('span'); time.textContent = new Date(m.at).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  meta.append(name,time);
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = m.text;
  el.append(meta,bubble); $('messages').append(el); bottomChat();
}
function bottomChat() { const messages = $('messages'); messages.scrollTop = messages.scrollHeight; }
$('chat-form').addEventListener('submit', ev => { ev.preventDefault(); const input = $('chat-input'); const text = input.value.trim(); if (text && joinedCode) { socket.emit('chat-message', {text}); input.value = ''; } });
$('chat-input').addEventListener('input', () => { if (Date.now() - lastTypingSent > 1700 && joinedCode) { socket.emit('typing'); lastTypingSent = Date.now(); } });
$('share-button').addEventListener('click', async () => {
  if (!joinedCode) return;
  const url = roomLink();
  if (navigator.share) { try { await navigator.share({ title: 'تعال نحضر سوا 🍿', text: `ادخل غرفة سينما سوا: ${joinedCode}`, url }); return; } catch {} }
  try { await navigator.clipboard.writeText(url); showToast('نسخنا رابط الغرفة! ابعته لأصحابك 🔗'); }
  catch { window.prompt('انسخ الرابط وابعته لأصحابك:', url); }
});
$('leave-button').addEventListener('click', () => { socket.emit('leave-room'); resetToHome(); });
function resetToHome() { joinedCode = null; currentVideo = null; ytReady = false; if (yt && typeof yt.destroy === 'function') {try { yt.destroy(); } catch {} } yt = null; htmlVideo.pause(); htmlVideo.removeAttribute('src'); htmlVideo.load(); $('room-view').classList.add('hidden'); $('home-view').classList.remove('hidden'); history.replaceState(null, '', '/'); }

$('video-form').addEventListener('submit', ev => {
  ev.preventDefault();
  const url = $('video-url').value.trim();
  if (!url || !joinedCode) return;
  socket.emit('set-video', { url }, res => { if (!res?.ok) showToast(res?.error || 'الرابط غير مدعوم'); else { $('video-url').value = ''; showToast('تم إرسال الفيديو للغرفة 🎬'); } });
});
function clearVideo() {
  currentVideo = null; ytReady = false; ytApiReady = !!(window.YT && YT.Player);
  if (yt && typeof yt.destroy === 'function') { try { yt.destroy(); } catch {} } yt = null;
  $videoHolder.classList.add('hidden'); htmlVideo.pause(); htmlVideo.removeAttribute('src'); htmlVideo.load(); htmlVideo.classList.add('hidden');
  $('video-placeholder').classList.remove('hidden'); $('player-status').classList.add('hidden');
  duration = 0; remotePlayback = { position:0, playing:false, updatedAt:Date.now() }; updateProgress(); updatePlayBtn();
}
function loadVideo(video, playback) {
  const same = currentVideo && video.type === currentVideo.type && video.value === currentVideo.value;
  currentVideo = video; remotePlayback = { ...playback, updatedAt: Date.now() };
  if (same) { applyPlayback(playback); return; }
  suppressUntil = Date.now() + 3500;
  duration = 0; lastYoutubePos = null; lastYoutubeState = -1;
  $('video-placeholder').classList.add('hidden');
  $('player-status').classList.remove('hidden');
  $('player-status').textContent = 'جاري تحميل الفيديو...';
  if (video.type === 'youtube') {
    htmlVideo.pause(); htmlVideo.removeAttribute('src'); htmlVideo.load(); htmlVideo.classList.add('hidden');
    if (yt && typeof yt.destroy === 'function') {try{yt.destroy();}catch{}} yt = null; ytReady = false;
    // API may arrive after the room's video has been received.
    if (!document.getElementById('yt-player')) { $videoHolder = document.createElement('div'); $videoHolder.id = 'yt-player'; $('player-wrap').append($videoHolder); }
    $videoHolder.classList.remove('hidden');
    createYoutubePlayer();
  } else {
    if (yt && typeof yt.destroy === 'function') {try{yt.destroy();}catch{}} yt = null; ytReady = false;
    $videoHolder.classList.add('hidden'); htmlVideo.classList.remove('hidden');
    htmlVideo.src = video.value; htmlVideo.load();
  }
  updateProgress(); updatePlayBtn();
}
function createYoutubePlayer() {
  if (!currentVideo || currentVideo.type !== 'youtube' || !(window.YT && YT.Player)) return;
  if (yt) return;
  const vid = currentVideo.value;
  // When the previous iframe was destroyed, insert a fresh target node.
  if (!document.getElementById('yt-player')) {
    $videoHolder = document.createElement('div');
    $videoHolder.id = 'yt-player';
    $('player-wrap').append($videoHolder);
  }
  yt = new YT.Player('yt-player', {
    width: '100%', height: '100%', videoId: vid,
    playerVars: { playsinline: 1, controls: 1, rel: 0, enablejsapi: 1, origin: location.origin },
    events: {
      onReady: () => {
        ytReady = true;
        $('player-status').classList.add('hidden');
        // Keep the video paused initially: mobile browsers generally need a user gesture.
        if (remotePlayback.position > 1) yt.seekTo(remotePlayback.position, true);
        if (remotePlayback.playing) tryPlayLocally();
      },
      onStateChange: e => {
        if (!joinedCode || !ytReady || currentVideo?.type !== 'youtube') return;
        if (Date.now() < suppressUntil) return;
        if (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.PAUSED) {
          lastYoutubeState = e.data;
          const playing = e.data === YT.PlayerState.PLAYING;
          broadcastPlayback(getPosition(), playing);
        }
      },
      onError: () => { $('player-status').textContent = 'هذا الفيديو غير متاح للمشاهدة هنا. جرّب رابطًا آخر.'; $('player-status').classList.remove('hidden'); }
    }
  });
}
window.onYouTubeIframeAPIReady = () => { ytApiReady = true; createYoutubePlayer(); };
function getPosition() { if (currentVideo?.type === 'youtube' && ytReady && yt?.getCurrentTime) return Number(yt.getCurrentTime()) || 0; if (currentVideo?.type === 'video') return Number(htmlVideo.currentTime) || 0; return remotePlayback.position || 0; }
function getDuration() { if (currentVideo?.type === 'youtube' && ytReady && yt?.getDuration) return Number(yt.getDuration()) || 0; if (currentVideo?.type === 'video') return Number(htmlVideo.duration) || 0; return duration; }
function isPlaying() { if (currentVideo?.type === 'youtube' && ytReady && yt?.getPlayerState) return yt.getPlayerState() === YT.PlayerState.PLAYING; if (currentVideo?.type === 'video') return !htmlVideo.paused && !htmlVideo.ended; return remotePlayback.playing; }
function tryPlayLocally() { if (currentVideo?.type === 'youtube') {if (ytReady) yt.playVideo();} else if (currentVideo?.type === 'video') htmlVideo.play().catch(() => showToast('اضغط تشغيل لبدء الفيديو على جهازك')); }
function pauseLocally() { if (currentVideo?.type === 'youtube') {if (ytReady) yt.pauseVideo();} else if (currentVideo?.type === 'video') htmlVideo.pause(); }
function seekLocally(position) { if (currentVideo?.type === 'youtube') {if (ytReady) yt.seekTo(Math.max(0,position), true);} else if (currentVideo?.type === 'video' && htmlVideo.readyState >= 1) htmlVideo.currentTime = Math.max(0, position); }
function broadcastPlayback(position, playing) {
  if (!joinedCode || !currentVideo) return;
  const data = { position: Math.max(0, position), playing: !!playing };
  remotePlayback = { ...data, updatedAt: Date.now() };
  socket.emit('playback', data);
  updatePlayBtn();
}
function applyPlayback(playback) {
  if (!currentVideo || !playback) return;
  remotePlayback = { position: Number(playback.position)||0, playing: !!playback.playing, updatedAt: Date.now() };
  suppressUntil = Date.now() + 1600;
  const delta = Math.abs(getPosition() - remotePlayback.position);
  if (delta > 1.3) seekLocally(remotePlayback.position);
  if (remotePlayback.playing) tryPlayLocally(); else pauseLocally();
  updatePlayBtn(); updateProgress();
}
function updatePlayBtn() { $('play-button').textContent = remotePlayback.playing ? '❚❚ إيقاف' : '▶ تشغيل'; }
function manualPlayback(playing, position = getPosition()) {
  if (!currentVideo) return showToast('اختار فيديو أولًا 🍿');
  suppressUntil = Date.now() + 1200;
  seekLocally(position);
  if (playing) tryPlayLocally(); else pauseLocally();
  broadcastPlayback(position, playing);
}
$('play-button').addEventListener('click', () => manualPlayback(!remotePlayback.playing));
$('back-button').addEventListener('click', () => manualPlayback(remotePlayback.playing, Math.max(0, getPosition() - 10)));
$('forward-button').addEventListener('click', () => manualPlayback(remotePlayback.playing, getPosition() + 10));
$('sync-button').addEventListener('click', () => { if (joinedCode) socket.emit('request-sync'); });
$('progress').addEventListener('pointerdown', () => dragging = true);
$('progress').addEventListener('input', () => { dragging = true; $('time-current').textContent = fmtTime(Number($('progress').value)); });
$('progress').addEventListener('change', () => { const pos = Number($('progress').value); dragging = false; manualPlayback(remotePlayback.playing, pos); });
$('progress').addEventListener('pointerup', () => setTimeout(() => dragging = false, 100));
function updateProgress() {
  if (!currentVideo) { $('time-current').textContent='0:00'; $('time-total').textContent='0:00'; $('progress').max='100'; $('progress').value='0'; return; }
  const d = getDuration() || duration;
  if (Number.isFinite(d) && d > 0) duration = d;
  const pos = getPosition();
  if (!dragging) { $('progress').max = String(Math.max(100, duration, pos)); $('progress').value = String(Math.max(0, pos)); $('time-current').textContent = fmtTime(pos); }
  $('time-total').textContent = duration > 0 ? fmtTime(duration) : '--:--';
}
htmlVideo.addEventListener('loadedmetadata', () => { $('player-status').classList.add('hidden'); duration = htmlVideo.duration || 0; if (remotePlayback.position > 1) seekLocally(remotePlayback.position); if (remotePlayback.playing) tryPlayLocally(); });
htmlVideo.addEventListener('error', () => { if (currentVideo?.type === 'video') { $('player-status').textContent = 'تعذّر فتح الفيديو. تأكد أن الرابط مباشر ومتاح للجميع.'; $('player-status').classList.remove('hidden'); } });
htmlVideo.addEventListener('play', () => { if (Date.now() >= suppressUntil) broadcastPlayback(getPosition(), true); });
htmlVideo.addEventListener('pause', () => { if (Date.now() >= suppressUntil && currentVideo?.type === 'video') broadcastPlayback(getPosition(), false); });
htmlVideo.addEventListener('seeked', () => { if (Date.now() >= suppressUntil && !dragging) broadcastPlayback(getPosition(), isPlaying()); });
htmlVideo.addEventListener('ended', () => { if (currentVideo?.type === 'video') broadcastPlayback(getPosition(), false); });
setInterval(() => {
  if (!joinedCode || !currentVideo) return;
  updateProgress();
  if (currentVideo.type === 'youtube' && ytReady) {
    const pos = getPosition(), now = Date.now(), playing = isPlaying();
    // YouTube scrubbing doesn't have a direct seek event; watch for unexpectedly large jumps.
    if (lastYoutubePos !== null && now > suppressUntil && !dragging) {
      const expected = lastYoutubePos + (lastYoutubeState === YT.PlayerState.PLAYING ? (now - lastYoutubeCheck)/1000 : 0);
      if (Math.abs(pos - expected) > 3) broadcastPlayback(pos, playing);
    }
    lastYoutubePos = pos; lastYoutubeCheck = now;
    lastYoutubeState = yt.getPlayerState();
  }
}, 450);

if (initialCode) openModal('join', initialCode);
