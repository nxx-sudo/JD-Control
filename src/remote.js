'use strict';

const WebSocket = require('ws');

const RETRY_MIN = 1500;
const RETRY_MAX = 15000;

function createRemoteLink(opts) {
  const backend = String(opts.backend || '').trim().replace(/^http/i, 'ws').replace(/\/+$/, '');
  if (!backend) return null;

  const token = String(opts.token || '').trim();
  const getInfo = opts.getInfo || (() => ({}));
  const onPhone = opts.onPhone || (() => {});
  const onOnline = opts.onOnline || null;
  const onFetch = opts.onFetch || ((p, cb) => cb({ error: 'sin proxy' }));
  const onReady = opts.onReady || (() => {});
  const log = opts.log || (() => {});

  const wsUrl = backend + '/ws/pc' + (token ? '?key=' + encodeURIComponent(token) : '');
  const httpBase = backend.replace(/^ws/, 'http');

  const phones = new Map();
  const members = new Map();
  let ws = null;
  let alive = false;
  let stopped = false;
  let retry = 0;
  let timer = null;
  let keepAlive = null;

  const send = (obj) => {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  };

  function hello() {
    const info = getInfo() || {};
    if (!info.code) {
      send({ t: 'idle' });
      return;
    }
    send({ t: 'hello', code: info.code, ips: info.ips || [], httpsPort: info.httpsPort || 8443 });
    log(`remoto: sala ${info.code} publicada en el backend`);
    onReady();
  }

  function openPhone(sid, ip) {
    const handlers = { msg: null, close: null };
    phones.set(sid, handlers);
    onPhone(sid, {
      remote: true,
      ip: ip || null,
      send: (obj) => { send({ t: 'to-phone', sid, data: JSON.stringify(obj) }); },
      onMessage: (fn) => { handlers.msg = fn; },
      onClose: (fn) => { handlers.close = fn; },
    });
  }

  function openMember(sid, ip) {
    if (!onOnline) {
      send({ t: 'close-online', sid });
      return;
    }
    const handlers = { msg: null, close: null };
    members.set(sid, handlers);
    onOnline(sid, {
      remote: true,
      ip: ip || null,
      isOpen: () => members.has(sid) && alive,
      send: (obj) => { send({ t: 'to-online', sid, data: JSON.stringify(obj) }); },
      close: () => {
        if (!members.delete(sid)) return;
        send({ t: 'close-online', sid });
        try { if (handlers.close) handlers.close(); } catch {}
      },
      onMessage: (fn) => { handlers.msg = fn; },
      onClose: (fn) => { handlers.close = fn; },
    });
  }

  function relayMsg(map, msg) {
    const h = map.get(msg.sid);
    if (!h || !h.msg) return;
    let data;
    try { data = JSON.parse(msg.data); } catch { return; }
    h.msg(data);
  }

  function relayClose(map, sid) {
    const h = map.get(sid);
    map.delete(sid);
    if (h && h.close) h.close();
  }

  function dropPhones() {
    for (const map of [phones, members]) {
      for (const [sid, h] of [...map]) {
        map.delete(sid);
        try { if (h.close) h.close(); } catch {}
      }
    }
  }

  function schedule() {
    if (stopped || timer) return;
    const wait = Math.min(RETRY_MAX, Math.round(RETRY_MIN * Math.pow(1.5, retry)));
    retry = Math.min(retry + 1, 8);
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, wait);
  }

  function connect() {
    if (stopped) return;

    let socket;
    try {
      socket = new WebSocket(wsUrl, { handshakeTimeout: 15000 });
    } catch {
      schedule();
      return;
    }
    ws = socket;

    socket.on('open', () => {
      alive = true;
      retry = 0;
      log('remoto: conectado al backend');
      hello();
      keepAlive = setInterval(() => send({ t: 'ping' }), 20000);
    });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.t === 'welcome') {
        log('remoto: backend listo');
      } else if (msg.t === 'phone-open') {
        openPhone(msg.sid, msg.ip);
      } else if (msg.t === 'phone-msg') {
        relayMsg(phones, msg);
      } else if (msg.t === 'phone-close') {
        relayClose(phones, msg.sid);
      } else if (msg.t === 'online-open') {
        openMember(msg.sid, msg.ip);
      } else if (msg.t === 'online-msg') {
        relayMsg(members, msg);
      } else if (msg.t === 'online-close') {
        relayClose(members, msg.sid);
      } else if (msg.t === 'fetch') {
        onFetch(String(msg.path || ''), (out) => {
          if (out && out.data) {
            send({ t: 'fetch', rid: msg.rid, mime: out.mime || 'application/octet-stream', data: out.data });
          } else {
            send({ t: 'fetch', rid: msg.rid, error: (out && out.error) || 'no' });
          }
        });
      }
    });

    const closed = () => {
      alive = false;
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
      if (ws === socket) ws = null;
      dropPhones();
      schedule();
    };

    socket.on('close', closed);
    socket.on('error', () => { try { socket.close(); } catch {} });
  }

  connect();

  return {
    url: httpBase,
    isConnected: () => alive,
    refresh: () => { if (alive) hello(); },
    pushAvatar: (id, ext, buf) => {
      const info = getInfo() || {};
      if (!info.code || !buf) return;
      send({ t: 'avatar', room: info.code, id, ext, data: Buffer.from(buf).toString('base64') });
    },
    avatarUrl: (id, version, ext) => {
      const info = getInfo() || {};
      if (!info.code) return null;
      return `${httpBase}/a/${info.code}/${id}${ext}?v=${version || 0}`;
    },
    close: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (keepAlive) clearInterval(keepAlive);
      if (ws) { try { ws.close(); } catch {} }
    },
  };
}

module.exports = { createRemoteLink };
