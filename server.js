'use strict';
// تطبيق مشاهدة جماعية صغير: HTTP + Server-Sent Events بدون أي مكتبات خارجية.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const PORT = Number(process.env.PORT || 3000);
const publicDir = path.resolve(__dirname, 'public');
const clients = new Map();
const rooms = new Map();
const MAX_PEOPLE = 12;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const typeMap = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json' };

function send(res, status, json) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(json)); }
function push(id, event, data) {
  const client = clients.get(id);
  if (!client || client.res.destroyed) return;
  try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}
function toRoom(room, event, data, excludeId = null) {
  for (const memberId of room.members.keys()) if (memberId !== excludeId) push(memberId, event, data);
}
function roomCode() {
  for (let i=0;i<100;i++) {
    const code = [...randomBytes(6)].map(b => ALPHABET[b % ALPHABET.length]).join('');
    if (!rooms.has(code)) return code;
  }
  throw new Error('No room codes');
}
function safeName(v) { return String(v??'').trim().replace(/[\u0000-\u001f\u007f<>]/g,'').slice(0,24) || 'ضيف'; }
function safeTitle(v) { return String(v??'').trim().replace(/[\u0000-\u001f\u007f<>]/g,'').slice(0,44) || 'سهرة الأصدقاء'; }
function safeVideo(raw) {
  const str = String(raw??'').trim();
  if (str.length > 1500) return null;
  let u; try { u = new URL(str); } catch { return null; }
  if (!['https:','http:'].includes(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./,'').replace(/^m\./,'');
  let id = '';
  if (host === 'youtu.be') id = u.pathname.split('/')[1] || '';
  else if (['youtube.com', 'youtube-nocookie.com', 'music.youtube.com'].includes(host)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else if (/^\/(embed|shorts|live)\//.test(u.pathname)) id = u.pathname.split('/')[2] || '';
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(id)) return { type:'youtube', value:id };
  if (host === 'youtu.be' || host.endsWith('youtube.com')) return null;
  if (/\.(mp4|webm|ogg)$/i.test(u.pathname)) return { type:'video', value:u.toString() };
  return null;
}
function currentSeconds(room) {
  return Math.max(0, room.playback.position + (room.playback.playing ? (Date.now() - room.playback.updatedAt)/1000 : 0));
}
function roomState(room) {
  return { code:room.code, title:room.title, hostId:room.hostId,
    members:[...room.members.values()], video:room.video, screenOwnerId:room.screenOwnerId, micIds:[...room.micIds],
    playback:{ playing:room.playback.playing, position:currentSeconds(room), updatedAt:Date.now() },
    history:room.history.slice(-40) };
}
function sendMembers(room) { toRoom(room,'members',{ members:[...room.members.values()], hostId:room.hostId }); }
function leaveRoom(client) {
  const code = client.room;
  if (!code) return;
  client.room = null;
  const room = rooms.get(code);
  if (!room) return;
  const former = room.members.get(client.id);
  room.members.delete(client.id);
  if(room.screenOwnerId === client.id) { room.screenOwnerId = null; toRoom(room,'screen-owner',{id:null,name:null}); }
  if(room.micIds.delete(client.id)) toRoom(room,'voice-member',{id:client.id,active:false});
  if (former) toRoom(room,'system-message',{ text:`${former.name} غادر الغرفة` });
  if (room.hostId === client.id) room.hostId = room.members.keys().next().value || null;
  if (room.members.size) sendMembers(room);
  else {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => { if (rooms.get(code)===room && !room.members.size) rooms.delete(code); }, 5*60_000);
    room.cleanupTimer.unref?.();
  }
}
function joinRoom(client, room, nickname) {
  if (client.room === room.code) { push(client.id,'room-joined',roomState(room)); return {ok:true,code:room.code}; }
  if (room.members.size >= MAX_PEOPLE) return {ok:false,error:'الغرفة ممتلئة (12 شخص كحد أقصى)'};
  leaveRoom(client);
  clearTimeout(room.cleanupTimer); room.cleanupTimer=null;
  client.room = room.code;
  const name = safeName(nickname);
  room.members.set(client.id,{id:client.id,name});
  if (!room.hostId) room.hostId=client.id;
  push(client.id,'room-joined',roomState(room));
  toRoom(room,'system-message',{ text:`${name} دخل الغرفة` },client.id);
  sendMembers(room);
  return {ok:true,code:room.code};
}
function handleEvent(client,event,payload) {
  const room = rooms.get(client.room);
  switch(event) {
    case 'create-room': {
      if (rooms.size >= 300) return {ok:false,error:'عدد الغرف كبير حاليًا، حاول لاحقًا'};
      const code=roomCode();
      const newRoom={ code,title:safeTitle(payload?.title),hostId:null,members:new Map(),video:null,screenOwnerId:null,micIds:new Set(),
        playback:{playing:false,position:0,updatedAt:Date.now()},history:[],cleanupTimer:null };
      rooms.set(code,newRoom);
      return joinRoom(client,newRoom,payload?.name);
    }
    case 'join-room': {
      const code=String(payload?.code??'').replace(/[^A-Za-z0-9]/g,'').toUpperCase();
      const target=rooms.get(code);
      return target?joinRoom(client,target,payload?.name):{ok:false,error:'ما لقينا الغرفة. تأكد من الرمز أو اطلب رابطًا جديدًا'};
    }
    case 'leave-room': leaveRoom(client); return {ok:true};
    case 'set-video': {
      if (!room || !room.members.has(client.id)) return {ok:false,error:'ادخل الغرفة أولًا'};
      const video=safeVideo(payload?.url);
      if (!video) return {ok:false,error:'حط رابط يوتيوب أو رابط ملف فيديو مباشر MP4 / WebM'};
      room.video=video;
      room.playback={playing:false,position:0,updatedAt:Date.now()};
      toRoom(room,'video-changed',{video,playback:{playing:false,position:0,updatedAt:Date.now()},by:room.members.get(client.id).name});
      return {ok:true};
    }
    case 'playback': {
      if (!room || !room.video || !room.members.has(client.id)) return {ok:false};
      const position=Number(payload?.position);
      if (!Number.isFinite(position)||position<0||position>86400) return {ok:false};
      const playing=Boolean(payload?.playing);
      room.playback={position,playing,updatedAt:Date.now()};
      toRoom(room,'playback',{position,playing,updatedAt:Date.now(),actor:client.id},client.id);
      return {ok:true};
    }
    case 'request-sync': {
      if (room && room.members.has(client.id)) push(client.id,'sync',{
        video:room.video,playback:{playing:room.playback.playing,position:currentSeconds(room)} });
      return {ok:true};
    }
    case 'screen-start': {
      if (!room || !room.members.has(client.id)) return {ok:false,error:'ادخل الغرفة أولًا'};
      if (room.screenOwnerId && room.screenOwnerId!==client.id) return {ok:false,error:'في شخص حاليًا يشارك شاشته. اطلب منه إيقافها أولًا.'};
      room.screenOwnerId=client.id;
      toRoom(room,'screen-owner',{id:client.id,name:room.members.get(client.id).name});
      return {ok:true};
    }
    case 'screen-stop': {
      if (!room || room.screenOwnerId!==client.id) return {ok:false};
      room.screenOwnerId=null;
      toRoom(room,'screen-owner',{id:null,name:null});
      return {ok:true};
    }
    case 'voice-start': {
      if (!room || !room.members.has(client.id)) return {ok:false};
      room.micIds.add(client.id);
      toRoom(room,'voice-member',{id:client.id,active:true},client.id);
      return {ok:true};
    }
    case 'voice-stop': {
      if (!room || !room.members.has(client.id)) return {ok:false};
      room.micIds.delete(client.id);
      toRoom(room,'voice-member',{id:client.id,active:false},client.id);
      return {ok:true};
    }
    case 'rtc-request': {
      if (!room || !room.members.has(client.id)) return {ok:false};
      const kind=payload?.kind, ownerId=payload?.ownerId;
      if (!['screen','voice'].includes(kind) || typeof ownerId!=='string' || ownerId===client.id) return {ok:false};
      if ((kind==='screen' && room.screenOwnerId!==ownerId) || (kind==='voice' && !room.micIds.has(ownerId))) return {ok:false};
      if (!room.members.has(ownerId)) return {ok:false};
      push(ownerId,'rtc-request',{kind,from:client.id});
      return {ok:true};
    }
    case 'rtc-signal': {
      if (!room || !room.members.has(client.id)) return {ok:false};
      const {kind,ownerId,to,data}=payload||{};
      if (!['screen','voice'].includes(kind) || typeof to!=='string' || !room.members.has(to) || to===client.id) return {ok:false};
      if (!room.members.has(ownerId) || ![client.id,to].includes(ownerId)) return {ok:false};
      if ((kind==='screen' && room.screenOwnerId!==ownerId) || (kind==='voice' && !room.micIds.has(ownerId))) return {ok:false};
      if (!data || !['offer','answer','candidate'].includes(data.type)) return {ok:false};
      if (data.type==='candidate' && (typeof data.candidate!=='object' || JSON.stringify(data.candidate).length>3000)) return {ok:false};
      if (['offer','answer'].includes(data.type) && (typeof data.sdp!=='string' || data.sdp.length>50000)) return {ok:false};
      push(to,'rtc-signal',{kind,ownerId,from:client.id,data});
      return {ok:true};
    }
    case 'chat-message': {
      if (!room || !room.members.has(client.id)) return {ok:false};
      const now=Date.now(); if (now-(client.lastChat||0)<450) return {ok:false};
      client.lastChat=now;
      const content=String(payload?.text??'').trim().slice(0,350);
      if (!content) return {ok:false};
      const msg={ id:randomBytes(8).toString('hex'),sender:room.members.get(client.id).name,
        senderId:client.id,text:content,at:now };
      room.history.push(msg); if(room.history.length>40)room.history.shift();
      toRoom(room,'chat-message',msg); return {ok:true};
    }
    case 'typing': {
      if (room && room.members.has(client.id)) toRoom(room,'typing',{name:room.members.get(client.id).name},client.id);
      return {ok:true};
    }
    default: return {ok:false,error:'حدث غير مدعوم'};
  }
}
function serveFile(request,res,pathname) {
  let decoded; try { decoded=decodeURIComponent(pathname); } catch { return send(res,400,{error:'Bad path'}); }
  const requested = decoded === '/' ? '/index.html' : decoded;
  const file=path.resolve(publicDir,'.'+requested);
  if (file !== publicDir && !file.startsWith(publicDir+path.sep)) return send(res,403,{error:'Forbidden'});
  fs.stat(file,(err,stats)=>{
    if (err || !stats.isFile()) return send(res,404,{error:'Not found'});
    res.writeHead(200,{'Content-Type':typeMap[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});
    fs.createReadStream(file).pipe(res);
  });
}
const server=http.createServer((req,res)=>{
  let url; try { url=new URL(req.url,'http://localhost'); } catch { return send(res,400,{error:'Bad request'}); }
  if (req.method==='GET' && url.pathname==='/api/ice') {
    let configured=[];
    try { const value=JSON.parse(process.env.ICE_SERVERS_JSON||'[]'); if (Array.isArray(value)) configured=value; } catch {}
    return send(res,200,{iceServers:configured.length?configured:[{urls:'stun:stun.l.google.com:19302'}]});
  }
  if (req.method==='GET' && url.pathname==='/health') return send(res,200,{ok:true,rooms:rooms.size});
  if (req.method==='GET' && url.pathname==='/events') {
    const id=url.searchParams.get('clientId') || '';
    if (!/^[a-fA-F0-9-]{32,40}$/.test(id)) return send(res,400,{error:'Invalid client ID'});
    if (clients.size>=600 && !clients.has(id)) return send(res,503,{error:'Server full'});
    const existing=clients.get(id);
    if (existing) { leaveRoom(existing); existing.res.end(); clearInterval(existing.ping); }
    res.writeHead(200,{
      'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform',
      'Connection':'keep-alive','X-Accel-Buffering':'no', 'Access-Control-Allow-Origin':'same-origin'
    });
    res.write('retry: 1500\n: connected\n\n');
    const client={id,res,room:null,lastChat:0,ping:null};
    clients.set(id,client);
    client.ping=setInterval(()=>{ if (!res.destroyed) res.write(': ping\n\n'); },20_000);
    client.ping.unref?.();
    res.on('close',()=>{ if (clients.get(id)===client) { leaveRoom(client); clients.delete(id); clearInterval(client.ping); } });
    return;
  }
  if (req.method==='POST' && url.pathname==='/api/event') {
    // Same-origin browser requests only. Cross-site scripts can't POST JSON here.
    const origin=req.headers.origin;
    const host=req.headers.host;
    if (origin) { try { if(new URL(origin).host !== host) return send(res,403,{error:'Invalid origin'}); } catch{return send(res,403,{error:'Invalid origin'});} }
    if (!(req.headers['content-type']||'').startsWith('application/json')) return send(res,415,{error:'JSON required'});
    let body='';
    req.on('data',chunk=>{body+=chunk;if(body.length>90000)req.destroy();});
    req.on('end',()=>{
      let data;try { data=JSON.parse(body); } catch { return send(res,400,{error:'Invalid JSON'}); }
      const client=clients.get(data.clientId);
      if (!client) return send(res,409,{ok:false,error:'الاتصال انقطع. أعد المحاولة'});
      try { return send(res,200,handleEvent(client,data.event,data.payload)); }
      catch(err) { console.error('event-error',err);return send(res,500,{ok:false,error:'حصل خطأ داخلي'}); }
    });
    return;
  }
  if(req.method==='GET'||req.method==='HEAD') return serveFile(req,res,url.pathname);
  send(res,405,{error:'Method not allowed'});
});
if(require.main===module)server.listen(PORT,'0.0.0.0',()=>console.log(`سينما سوا: http://localhost:${PORT}`));
module.exports={server,rooms,clients,safeVideo};
