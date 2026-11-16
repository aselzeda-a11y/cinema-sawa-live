// Transport for Cinema Sawa: native EventSource + fetch, without external dependencies.
(function () {
  const id = (self.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r=Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16); }));
  const listeners = new Map();
  const source = new EventSource('/events?clientId=' + encodeURIComponent(id));
  const socket = {
    id,
    connected: false,
    on(name, callback) {
      if(!listeners.has(name)) {
        listeners.set(name, []);
        if(name!=='connect' && name!=='disconnect')source.addEventListener(name, event=>{
          let payload;try{payload=JSON.parse(event.data);}catch{return;}
          for(const cb of listeners.get(name)||[]) cb(payload);
        });
      }
      listeners.get(name).push(callback);
      return socket;
    },
    emit(name, payload, ack) {
      if(typeof payload==='function'){ ack=payload; payload=null; }
      fetch('/api/event', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({clientId:id,event:name,payload})
      }).then(async res=>{ const data=await res.json(); if(ack)ack(data); })
        .catch(()=>{ if(ack)ack({ok:false,error:'انقطع الاتصال. حاول مرة ثانية.'}); });
    }
  };
  source.onopen = () => { socket.connected=true; for(const cb of listeners.get('connect')||[])cb(); };
  source.onerror = () => { if(socket.connected){ socket.connected=false; for(const cb of listeners.get('disconnect')||[])cb(); } };
  window.io = () => socket;
})();
