'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const dgram = require('dgram');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const selfsigned = require('selfsigned');
const QRCode = require('qrcode');
const { GamePhone } = require('./src/gamephone');

const HTTPS_PORT = Number(process.env.JD_PORT || 8443);
const HTTP_PORT = Number(process.env.JD_HTTP_PORT || 8081);
const DISCOVERY_PORT = Number(process.env.JD_DISCOVERY_PORT || 8082);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'cert');
const LOG_DIR = path.join(__dirname, 'logs');
const AVATAR_DIR = path.join(__dirname, 'cache', 'avatars');
const GAME_HTTP = 'http://127.0.0.1:8080';

fs.rmSync(AVATAR_DIR, { recursive: true, force: true });
fs.mkdirSync(AVATAR_DIR, { recursive: true });

fs.mkdirSync(LOG_DIR, { recursive: true });
const UI_LOG = path.join(LOG_DIR, 'ui.jsonl');
try {
  if (fs.statSync(UI_LOG).size > 4 * 1024 * 1024) fs.writeFileSync(UI_LOG, '');
} catch {  }

function localIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      out.push({ name, address: net.address });
    }
  }
  return out;
}

function pickPrimaryIP(ips) {
  const rank = (ip) =>
    ip.startsWith('192.168.') ? 0 :
    ip.startsWith('10.37.') ? 1 :
    ip.startsWith('10.') ? 2 :
    ip.startsWith('172.') ? 3 : 9;
  const sorted = [...ips].sort((a, b) => rank(a.address) - rank(b.address));
  return sorted[0] ? sorted[0].address : '127.0.0.1';
}

function ensureCert(ips) {
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const metaFile = path.join(CERT_DIR, 'meta.json');
  const wanted = ips.map((i) => i.address).sort().join(',');

  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (meta.ips === wanted && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    }
  } catch {  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
  for (const ip of ips) altNames.push({ type: 7, ip: ip.address });

  const pems = selfsigned.generate([{ name: 'commonName', value: 'jd-sala-local' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(metaFile, JSON.stringify({ ips: wanted }, null, 2));
  return { key: pems.private, cert: pems.cert };
}

const IPS = localIPv4();
const PRIMARY_IP = pickPrimaryIP(IPS);
const TLS = ensureCert(IPS);

const room = {
  code: null,
  phones: new Map(),
};
let nextPhoneId = 1;

const online = {
  role: null,
  code: null,
  host: null,
  hostName: null,
  hostSong: null,
  hostPhase: null,
  hostPhone: false,
  pendingJoin: null,
  creatorProfile: null,
  creatorAvatar: null,
  requireIp: false,
  targetSong: null,
  hint: null,
  error: null,
  connected: false,
  admin: false,
  memberId: null,
  adminId: null,
  creatorMemberId: null,
  creatorSeenAt: 0,
  adminTimer: null,
  ws: null,
  reconnectTimer: null,
  memberSeq: 1,
  members: new Map(),
  lastSongSent: null,
  lastSending: false,
  lastMemberSig: '',
  startedAt: 0,
  localReadySong: null,
  hostReady: false,
  startPlan: null,
  remoteStart: null,
  startSeq: 0,
  clockOffset: null,
  clockRtt: Infinity,
  expectedStartUntil: 0,
  startFailed: false,
};

function randomCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

function normName(v) {
  return String(v || '').trim().toLowerCase();
}

function localEntry() {
  for (const entry of room.phones.values()) return entry;
  return null;
}

function clientIp(req) {
  const raw = String((req && req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (raw === '127.0.0.1' || raw === '::1') {
    const fwd = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '')
      .split(',')[0].trim().replace(/^::ffff:/, '');
    if (fwd) return fwd;
  }
  return raw || null;
}

function isLoopback(ip) {
  return !ip || ip === '::1' || /^127\./.test(ip);
}

function isPrivateIp(ip) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip || '');
}

function subnet24(ip) {
  const p = String(ip || '').split('.');
  return p.length === 4 ? p.slice(0, 3).join('.') : null;
}

function phoneOwners() {
  const owners = new Map();
  if (online.role !== 'host') return owners;

  const members = [...online.members.values()].filter((m) => m.connected && !isLoopback(m.ip));
  if (!members.length) return owners;

  const hostNets = new Set(IPS.map((i) => subnet24(i.address)));
  const local = localEntry();

  for (const entry of room.phones.values()) {
    if (entry === local || isLoopback(entry.ip)) continue;

    let hits = members.filter((m) => m.ip === entry.ip);
    if (!hits.length && isPrivateIp(entry.ip)) {
      const net = subnet24(entry.ip);
      if (net && !hostNets.has(net)) hits = members.filter((m) => subnet24(m.ip) === net);
    }
    if (hits.length === 1) owners.set(entry.id, hits[0].id);
  }
  return owners;
}

function memberHasPhone(m, owners) {
  if (m.phone) return true;
  for (const owner of owners.values()) if (owner === m.id) return true;
  return false;
}

function localSnapshot() {
  const entry = localEntry();
  if (!entry) {
    return { id: null, name: null, avatar: null, song: null, phase: 'offline', connected: false, phone: false };
  }

  const gs = entry.game.state();
  return {
    id: entry.id,
    name: gs.name || null,
    avatar: gs.avatar || null,
    song: gs.lobby || gs.sending ? (gs.song || null) : null,
    phase: !gs.connected ? 'offline' : gs.sending ? 'dancing' : gs.lobby ? 'lobby' : 'menu',
    connected: !!gs.connected,
    phone: true,
  };
}

function onlineState() {
  const rows = [];
  const owners = phoneOwners();

  if (online.role === 'member') {
    rows.push({
      id: 'host',
      name: online.hostName,
      song: online.hostSong,
      phase: online.hostPhase || (online.connected ? 'menu' : 'offline'),
      connected: online.connected,
      admin: true,
      host: true,
      pc: true,
      phone: !!online.hostPhone,
      ready: online.hostReady,
    });
  }

  for (const m of online.members.values()) {
    if (online.role === 'member' && m.id === online.memberId) continue;
    rows.push({
      id: m.id,
      name: m.name,
      song: m.song,
      phase: m.phase,
      connected: m.connected,
      admin: m.admin,
      host: false,
      pc: true,
      phone: online.role === 'host' ? memberHasPhone(m, owners) : !!m.phone,
      ready: online.role === 'host' ? !!m.readySong : !!m.ready,
    });
  }

  return {
    role: online.role,
    code: online.code,
    host: online.host,
    hostName: online.hostName,
    requireIp: online.requireIp,
    connected: online.role === 'host' ? true : online.connected,
    admin: online.role === 'host' ? true : online.admin,
    creatorProfile: online.creatorProfile,
    targetSong: online.targetSong,
    hint: online.hint,
    error: online.error,
    requiresReady: online.role === 'member' ||
      (online.role === 'host' && online.members.size > 0),
    localReady: !!online.localReadySong,
    readyCount: (online.role === 'host'
      ? Number(!!online.localReadySong)
      : Number(online.hostReady) + Number(!!online.localReadySong)) +
      rows.filter((m) => !m.host && m.ready).length,
    totalCount: online.role ? rows.length + 1 : 0,
    startAt: online.role === 'host'
      ? (online.startPlan && online.startPlan.at) || null
      : (online.remoteStart && online.remoteStart.at) || null,
    members: rows,
  };
}

function notifyPhonesOnline() {
  const data = { type: 'online', online: onlineState() };
  for (const entry of room.phones.values()) {
    if (entry.send) entry.send(data);
  }
}

const ADMIN_GRACE_MS = 45000;

function refreshAdmin() {
  if (online.role !== 'host') return;

  const now = Date.now();
  const creator = normName(online.creatorProfile);
  const creatorAvatar = online.creatorAvatar || '';
  const list = [...online.members.values()].filter((m) => m.connected);

  let pick = null;
  if (creator) {
    pick = list.find((m) => {
      if (normName(m.name) !== creator) return false;

      if (creatorAvatar && m.avatar) return m.avatar === creatorAvatar;
      return true;
    }) || null;
  }

  if (pick) {
    online.creatorMemberId = pick.id;
    online.creatorSeenAt = now;
  }

  let adminId = pick ? pick.id : null;
  let waiting = false;

  if (!pick && online.creatorMemberId) {
    const goneFor = now - (online.creatorSeenAt || 0);
    if (goneFor < ADMIN_GRACE_MS) {

      adminId = online.creatorMemberId;
      waiting = true;
    } else {
      online.creatorMemberId = null;
    }
  }

  online.adminId = adminId;

  for (const m of online.members.values()) m.admin = m.id === online.adminId;

  clearTimeout(online.adminTimer);
  online.adminTimer = null;
  if (waiting) {
    const rest = ADMIN_GRACE_MS - (now - (online.creatorSeenAt || 0)) + 200;
    online.adminTimer = setTimeout(() => { refreshAdmin(); broadcastOnlineRoom(); }, rest > 0 ? rest : 200);
  }
}

function onlineRoomPayload() {
  const snap = localSnapshot();
  if (snap.name) {
    online.hostName = snap.name;
    if (!online.creatorProfile) online.creatorProfile = snap.name;
    if (!online.creatorAvatar && snap.avatar) online.creatorAvatar = snap.avatar;
  }
  online.hostSong = snap.song;
  online.hostPhase = snap.phase;
  const owners = phoneOwners();

  return {
    type: 'room',
    code: online.code,
    host: { name: online.hostName, song: online.hostSong, phase: online.hostPhase,
      phone: snap.phone, ready: !!online.localReadySong },
    requireIp: online.requireIp,
    targetSong: online.targetSong,
    hint: online.hint,
    members: [...online.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      song: m.song,
      phase: m.phase,
      connected: m.connected,
      admin: m.admin,
      pc: true,
      phone: memberHasPhone(m, owners),
      ready: !!m.readySong,
    })),
  };
}

function broadcastOnlineRoom() {
  if (online.role !== 'host') return;

  const snap = localSnapshot();
  if (snap.name) {
    online.hostName = snap.name;
    if (!online.creatorProfile) online.creatorProfile = snap.name;
    if (!online.creatorAvatar && snap.avatar) online.creatorAvatar = snap.avatar;
  }

  refreshAdmin();
  const payload = onlineRoomPayload();

  for (const m of online.members.values()) {
    if (!m.link || !m.link.isOpen()) continue;
    try {
      m.link.send({ ...payload, admin: m.id === online.adminId });
    } catch {  }
  }

  broadcastHost();
  notifyPhonesOnline();
}

function broadcastSync(action, extra) {
  if (online.role !== 'host') return;

  const snap = localSnapshot();
  const msg = {
    type: 'sync',
    action,
    song: extra && Object.prototype.hasOwnProperty.call(extra, 'song') ? extra.song : snap.song,
    at: Date.now(),
    id: extra && extra.id,
    startAt: extra && extra.startAt,
    from: online.hostName,
  };

  for (const m of online.members.values()) {
    if (m.link && m.link.isOpen()) {
      try { m.link.send(msg); } catch {  }
    }
  }
}

const START_LEAD_MS = 2500;

function canStartHere(song) {
  const entry = localEntry();
  const st = entry && entry.game.state();
  return !!(entry && entry.ready && st.connected && st.lobby && st.inputAllowed &&
    normName(st.song) === normName(song));
}

function cancelRemoteStart() {
  if (online.remoteStart) clearTimeout(online.remoteStart.timer);
  online.remoteStart = null;
}

function cancelStartPlan(reason) {
  const plan = online.startPlan;
  if (!plan || plan.dispatched) return;
  clearTimeout(plan.timer);
  online.startPlan = null;
  broadcastSync('cancel-start', { id: plan.id, song: plan.song });
  online.hint = reason || 'Inicio cancelado: vuelve a marcarte listo.';
}

function maybeScheduleStart() {
  if (online.role !== 'host') return;
  const snap = localSnapshot();
  const members = [...online.members.values()];
  if (!members.length) {
    cancelStartPlan('El otro PC salió de la sala.');
    online.localReadySong = null;
    return;
  }
  const song = snap.song;
  const plan = online.startPlan;
  const allReady = !!(song && snap.phase === 'lobby' && canStartHere(song) &&
    normName(online.localReadySong) === normName(song) &&
    members.every((m) => m.connected && normName(m.song) === normName(song) &&
      (m.phase === 'lobby' && normName(m.readySong) === normName(song) ||
       plan && !plan.dispatched && plan.memberIds.includes(m.id) &&
       Date.now() >= plan.at - 400 && m.phase === 'dancing')));

  if (plan) {
    if (!plan.dispatched && (!allReady || members.length !== plan.memberIds.length ||
        members.some((m) => !plan.memberIds.includes(m.id)))) {
      cancelStartPlan('Inicio cancelado: alguien salió del lobby o cambió de canción.');
    }
    return;
  }
  if (!allReady) return;

  const startAt = Date.now() + START_LEAD_MS;
  const next = {
    id: ++online.startSeq, song, at: startAt,
    memberIds: members.map((m) => m.id), dispatched: false, timer: null,
  };
  online.startPlan = next;
  online.startFailed = false;
  online.hint = 'Todos listos · comenzando...';
  broadcastSync('start-scheduled', { id: next.id, song, startAt });
  next.timer = setTimeout(() => {
    if (online.startPlan !== next) return;
    const now = localSnapshot();
    if (now.phase !== 'lobby' || normName(now.song) !== normName(next.song) ||
        !canStartHere(next.song)) {
      cancelStartPlan('No se pudo iniciar: el anfitrión ya no está en el lobby.');
    } else {
      next.dispatched = true;
      if (!localEntry().game.command('start')) {
        next.dispatched = false;
        cancelStartPlan('El juego del anfitrión rechazó el inicio.');
      } else {
        next.timer = setTimeout(() => {
          if (online.startPlan !== next || localSnapshot().phase === 'dancing') return;
          online.startPlan = null;
          online.localReadySong = null;
          online.hint = 'El juego no confirmó el inicio. Vuelve al lobby e inténtalo otra vez.';
          broadcastOnlineRoom();
        }, 10000);
      }
    }
    broadcastOnlineRoom();
  }, START_LEAD_MS);
}

function markReady(entry) {
  const snap = localSnapshot();
  if (entry !== localEntry() || !online.role || (online.role === 'member' && !online.connected)) {
    entry.send({ type: 'cmd-rejected', name: 'start',
      reason: 'Este control no puede iniciar la sala online.' });
    return;
  }
  if (online.role === 'host' && online.members.size === 0) {
    if (!entry.game.command('start'))
      entry.send({ type: 'cmd-rejected', name: 'start',
        reason: 'Espera a que el juego habilite Bailar.' });
    return;
  }
  if (online.startPlan && online.startPlan.dispatched) return;
  if (online.localReadySong) {
    online.localReadySong = null;
    cancelRemoteStart();
  } else {
    if (!snap.song || snap.phase !== 'lobby' || !canStartHere(snap.song) ||
        (online.role === 'member' && normName(snap.song) !== normName(online.targetSong))) {
      entry.send({ type: 'cmd-rejected', name: 'start',
        reason: 'Entra en la misma canción que el anfitrión y espera a la pantalla de bailarín.' });
      return;
    }
    online.localReadySong = snap.song;
  }
  if (online.role === 'host') {
    maybeScheduleStart();
    broadcastOnlineRoom();
  } else {
    sendMemberUpdate(snap);
    broadcastHost();
    notifyPhonesOnline();
  }
}

function syncLocalToOnline() {
  if (!online.role) return;

  const snap = localSnapshot();
  if (online.localReadySong &&
      (snap.phase !== 'lobby' || normName(snap.song) !== normName(online.localReadySong))) {
    online.localReadySong = null;
    cancelRemoteStart();
  }

  if (online.role === 'host') {
    if (snap.song && snap.song !== online.lastSongSent) {
      online.lastSongSent = snap.song;
      online.targetSong = snap.song;
      online.hint = null;
      broadcastSync('song', { song: snap.song });
    } else if (!snap.song && online.lastSongSent) {
      online.lastSongSent = null;
      online.targetSong = null;
      broadcastSync('song', { song: null });
    }

    maybeScheduleStart();
    if (snap.phase === 'dancing' && !online.lastSending) {
      online.lastSending = true;
      online.startedAt = Date.now();
      if (!online.members.size) {
        online.hint = null;
      } else if (!online.startPlan || !online.startPlan.dispatched) {
        cancelStartPlan('Inicio no coordinado desde Legacy.exe; vuelve al lobby y usa BAILAR en el móvil.');
        online.hint = 'Inicio desde otro mando: no se puede cancelar en Legacy.exe. Vuelve al lobby.';
      } else if (online.startFailed) {
        online.hint = 'Un jugador no pudo iniciar; volved al lobby para sincronizar.';
      } else {
        online.hint = 'Bailando con la sala';
      }
      online.startPlan = null;
    } else if (snap.phase !== 'dancing' && online.lastSending) {
      online.lastSending = false;
      broadcastSync('stop', { song: online.lastSongSent });
    }

    broadcastOnlineRoom();
  } else if (online.role === 'member') {
    if (snap.phase === 'dancing' && Date.now() > online.expectedStartUntil) {
      online.hint = 'Inicio desde otro mando: no se puede cancelar. Vuelve al lobby.';
    }
    sendMemberUpdate(snap);
    notifyPhonesOnline();
  }
}

function sendMemberUpdate(snap) {
  if (!online.ws || online.ws.readyState !== 1) return;

  const sig = [snap.name || '', snap.song || '', snap.phase, snap.phone, online.localReadySong || ''].join('|');
  if (sig === online.lastMemberSig) return;
  online.lastMemberSig = sig;

  try {
    online.ws.send(JSON.stringify({
      type: 'member',
      name: snap.name,
      song: snap.song,
      phase: snap.phase,
      phone: snap.phone,
      readySong: online.localReadySong,
    }));
  } catch {  }
}

const ghosts = new Map();
const remoteCoach = new Map();
const ACCEL_BATCH_MS = 80;
let accelOut = [];
let accelTimer = null;

function remotePlayers() {
  const out = [];
  if (online.role === 'host') {

    for (const m of online.members.values()) if (m.connected && m.phone) out.push(m.id);
  } else if (online.role === 'member' && online.connected) {
    if (online.hostPhone) out.push('host');
    for (const m of online.members.values()) {
      if (m.id !== online.memberId && m.connected && m.phone) out.push(m.id);
    }
  }
  return out;
}

function reconcileGhosts() {
  const local = localEntry();
  const ready = !!(online.role && local && local.ready && local.game.connected);
  const want = new Set(ready ? remotePlayers() : []);

  for (const [id, gh] of ghosts) {
    if (want.has(id)) continue;
    gh.game.stop();
    ghosts.delete(id);
  }

  for (const id of want) {
    if (ghosts.has(id)) continue;
    const gh = { id, game: new GamePhone('online-' + id), coach: remoteCoach.has(id) ? remoteCoach.get(id) : null, applied: null };
    gh.game.on('state', () => applyGhostCoach(gh));
    ghosts.set(id, gh);
    gh.game.start();
  }
}

function applyGhostCoach(gh) {
  const g = gh.game;
  if (!g.lobby) { gh.applied = null; return; }
  if (gh.coach === null || gh.applied === gh.coach || !g.inputAllowed) return;
  if (g.command('coach', { index: gh.coach })) gh.applied = gh.coach;
}

function applyPlay(from, data) {

  if (data.lobby) remoteCoach.delete(from);
  if (Number.isInteger(data.coach)) remoteCoach.set(from, data.coach);
  const gh = ghosts.get(from);
  if (!gh) return;

  if (data.lobby) {
    gh.coach = null;
    gh.applied = null;
  }

  if (Number.isInteger(data.coach)) {
    gh.coach = data.coach;
    gh.applied = null;
    applyGhostCoach(gh);
  }
  if (Array.isArray(data.accel)) {
    for (const v of data.accel) gh.game.pushAccel(v[0], v[1], v[2]);
  }
}

function coachFromAction(command) {
  try {
    const o = typeof command === 'string' ? JSON.parse(command) : command;
    if (o && o.root && o.root.__class === 'JD_ChangeCoach_PhoneCommandData') {
      const c = Number(o.root.coachId) || 0;
      return Number.isInteger(c) && c >= 0 && c < 8 ? c : null;
    }
  } catch {  }
  return null;
}

function isStartAction(command) {
  try {
    const o = typeof command === 'string' ? JSON.parse(command) : command;
    return !!(o && o.root && o.root.__class === 'JD_StartGame_PhoneCommandData');
  } catch { return false; }
}

function cleanPlay(msg) {
  const out = {};
  const c = Number(msg && msg.coach);
  if (msg && msg.coach !== undefined && Number.isInteger(c) && c >= 0 && c < 8) out.coach = c;
  if (msg && msg.lobby === true) out.lobby = true;
  if (msg && Array.isArray(msg.accel)) {
    out.accel = msg.accel.slice(0, 400).filter((v) =>
      Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)));
  }
  return out;
}

function relayPlay(from, data) {
  const msg = { type: 'play', from, ...data };
  for (const m of online.members.values()) {
    if (m.id === from || !m.link || !m.link.isOpen()) continue;
    try { m.link.send(msg); } catch {  }
  }
  if (from !== 'host') applyPlay(from, data);
}

function sendPlay(data) {
  if (online.role === 'host') relayPlay('host', data);
  else if (online.role === 'member' && online.ws && online.ws.readyState === 1) {
    try { online.ws.send(JSON.stringify({ type: 'play', ...data })); } catch {  }
  }
}

function relayAccel(v) {
  accelOut.push([+(+v[0]).toFixed(2), +(+v[1]).toFixed(2), +(+v[2]).toFixed(2)]);
  if (accelOut.length > 300) accelOut.splice(0, accelOut.length - 300);
  if (accelTimer) return;
  accelTimer = setTimeout(() => {
    accelTimer = null;
    const batch = accelOut;
    accelOut = [];
    if (batch.length) sendPlay({ accel: batch });
  }, ACCEL_BATCH_MS);
}

function normalizeHost(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  const hadScheme = /^[a-z]+:\/\//i.test(s);
  if (!hadScheme) s = 'ws://' + s;

  try {
    const u = new URL(s);
    if (u.protocol === 'http:') u.protocol = 'ws:';
    if (u.protocol === 'https:') u.protocol = 'wss:';
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;

    if (u.protocol === 'ws:' && (u.port === '8443' || u.port === '443')) u.protocol = 'wss:';
    if (!u.hostname) return null;

    const esIp = /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname === 'localhost';

    if (!hadScheme && !esIp && !u.port) u.protocol = 'wss:';
    if (!u.port && esIp) u.port = u.protocol === 'wss:' ? '8443' : '8081';

    return u.protocol + '//' + u.hostname + (u.port ? ':' + u.port : '');
  } catch {
    return null;
  }
}

function leaveOnline(keepError) {
  clearTimeout(online.reconnectTimer);
  online.reconnectTimer = null;

  if (online.ws) {
    try { online.ws.close(); } catch {  }
    online.ws = null;
  }

  online.role = null;
  online.code = null;
  online.host = null;
  online.hostName = null;
  online.hostSong = null;
  online.hostPhase = null;
  online.hostPhone = false;
  online.hostReady = false;
  online.localReadySong = null;
  online.expectedStartUntil = 0;
  cancelRemoteStart();
  if (online.startPlan) clearTimeout(online.startPlan.timer);
  online.startPlan = null;
  online.clockOffset = null;
  online.clockRtt = Infinity;
  online.startFailed = false;
  online.creatorAvatar = null;
  online.connected = false;
  online.admin = false;
  online.memberId = null;
  online.adminId = null;
  online.creatorMemberId = null;
  online.creatorSeenAt = 0;
  clearTimeout(online.adminTimer);
  online.adminTimer = null;
  online.members.clear();
  online.targetSong = null;
  online.hint = null;
  online.lastSongSent = null;
  online.lastSending = false;
  online.lastMemberSig = '';
  online.requireIp = false;
  if (!keepError) online.error = null;
  remoteCoach.clear();
  finishJoin(online.error || 'Se canceló la unión a la sala.');

  stopDiscovery();
  broadcastHost();
  notifyPhonesOnline();
}

function stopOnlineHost() {
  if (online.role !== 'host') { leaveOnline(); return; }
  cancelStartPlan();
  online.localReadySong = null;
  online.startPlan = null;

  for (const m of online.members.values()) {
    try {
      if (m.link && m.link.isOpen()) {
        m.link.send({ type: 'closed' });
        m.link.close();
      }
    } catch {  }
  }

  online.role = null;
  online.code = null;
  online.connected = false;
  online.creatorProfile = null;
  online.adminId = null;
  online.creatorMemberId = null;
  online.creatorSeenAt = 0;
  clearTimeout(online.adminTimer);
  online.adminTimer = null;
  online.members.clear();
  online.targetSong = null;
  online.hint = null;
  online.lastSongSent = null;
  online.lastSending = false;
  online.requireIp = false;
  online.error = null;
  online.expectedStartUntil = 0;
  online.startFailed = false;
  remoteCoach.clear();

  stopDiscovery();
  broadcastHost();
  notifyPhonesOnline();
}

function startOnlineHost() {
  if (online.role === 'member') leaveOnline();
  if (!room.code) room.code = randomCode();

  online.role = 'host';
  online.code = room.code;
  online.connected = true;
  online.error = null;
  online.hint = null;
  online.localReadySong = null;
  online.expectedStartUntil = 0;
  online.startFailed = false;

  const snap = localSnapshot();
  if (snap.name) online.creatorProfile = snap.name;
  if (snap.avatar) online.creatorAvatar = snap.avatar;

  startDiscovery();
  refreshAdmin();
  broadcastOnlineRoom();
}

function finishJoin(err) {
  const pending = online.pendingJoin;
  if (!pending) return;
  online.pendingJoin = null;
  clearTimeout(pending.timer);
  pending.cb(err || null);
}

function joinErrorText(err, host, done) {
  const msg = String((err && err.message) || '');
  const code = String((err && err.code) || '');
  const status = (msg.match(/Unexpected server response: (\d+)/) || [])[1];

  if (status === '403') return done('Código incorrecto, o ese PC no tiene la sala online abierta.');
  if (status === '401') return done('El servidor pidió autorización (¿URL equivocada?).');
  if (status === '404') {

    const httpBase = host.replace(/^ws/, 'http');
    const req = (httpBase.startsWith('https') ? https : http).get(
      httpBase + '/api/room?code=' + encodeURIComponent(online.code || ''),
      { rejectUnauthorized: false, timeout: 8000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(body); } catch {  }
          if (j && j.ok) {
            return done('El backend tiene la sala pero no acepta PCs (es una versión antigua). ' +
              'Vuelve a desplegar la carpeta remote/ en Render, o usa la IP o el túnel del anfitrión.');
          }
          if (j && j.error === 'no-room') {
            return done('Ese servidor no tiene ninguna sala con ese código. ' +
              'El anfitrión debe pulsar Abrir sala y tener el remoto conectado.');
          }
          done('Ese servidor no tiene sala online (404). Revisa la IP o URL del anfitrión.');
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => done('Ese servidor no tiene sala online (404). Revisa la IP o URL del anfitrión.'));
    return;
  }
  if (status) return done('El anfitrión respondió con un error ' + status + '.');
  if (code === 'ECONNREFUSED') return done('El anfitrión no responde en ' + host + ' (¿JD CONTROL cerrado o puerto bloqueado por el firewall?).');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return done('No se encuentra ese dominio: ' + host + '.');
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) return done('El anfitrión tardó demasiado en responder (' + host + ').');
  done('No se pudo conectar con el anfitrión' + (msg ? ': ' + msg : '.'));
}

function connectOnline() {
  if (online.role !== 'member' || !online.host) return;
  clearTimeout(online.reconnectTimer);

  if (online.ws) {
    try { online.ws.close(); } catch {  }
    online.ws = null;
  }

  const isIp = /\/\/(\d+\.\d+\.\d+\.\d+|localhost)(:|$)/.test(online.host);
  let ws;
  try {
    ws = new WebSocket(online.host + '/ws/online?code=' + encodeURIComponent(online.code || ''), {
      handshakeTimeout: isIp ? 8000 : 30000,
      rejectUnauthorized: false,
    });
  } catch (err) {
    online.error = err.message;
    finishJoin(online.error);
    online.reconnectTimer = setTimeout(connectOnline, 4000);
    return;
  }

  online.ws = ws;

  ws.on('open', () => {
    if (online.ws !== ws || online.role !== 'member') return;
    online.connected = true;
    online.error = null;
    online.lastMemberSig = '';
    online.localReadySong = null;
    online.clockOffset = null;
    online.clockRtt = Infinity;

    const snap = localSnapshot();
    try {
      ws.send(JSON.stringify({
        type: 'hello',
        code: online.code,
        name: snap.name,
        song: snap.song,
        phase: snap.phase,
        phone: snap.phone,
      }));
      ws.send(JSON.stringify({ type: 'clock', t0: Date.now() }));
    } catch {  }

    broadcastHost();
    notifyPhonesOnline();
  });

  ws.on('message', (raw) => {
    if (online.ws !== ws) return;
    handleOnlineMessage(raw);
  });

  ws.on('error', (err) => {
    if (online.ws !== ws) return;
    const host = online.host;
    joinErrorText(err, host, (text) => {
      if (online.host !== host) return;
      online.error = text;
      finishJoin(text);
      broadcastHost();
      notifyPhonesOnline();
    });
  });

  ws.on('close', () => {

    if (online.ws !== ws) return;

    online.ws = null;
    online.connected = false;
    online.localReadySong = null;
    cancelRemoteStart();
    online.hint = null;
    broadcastHost();
    notifyPhonesOnline();

    if (online.role === 'member' && !online.pendingJoin && online.memberId) {
      online.reconnectTimer = setTimeout(connectOnline, 4000);
    }
  });
}

let discoverySocket = null;

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);

  try {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const i of list || []) {
        if (!i || i.internal || i.family !== 'IPv4' || !i.netmask) continue;
        const ip = i.address.split('.').map(Number);
        const mask = i.netmask.split('.').map(Number);
        if (ip.length !== 4 || mask.length !== 4) continue;
        if (ip.some((n) => !Number.isFinite(n)) || mask.some((n) => !Number.isFinite(n))) continue;
        out.add(ip.map((n, k) => ((n & mask[k]) | (~mask[k] & 255))).join('.'));
      }
    }
  } catch {  }

  return [...out];
}

function startDiscovery() {
  if (discoverySocket) return;

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  discoverySocket = sock;

  sock.on('message', (buf, rinfo) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!msg || msg.jd !== 'discover') return;
    if (online.role !== 'host' || !online.code) return;
    if (String(msg.code) !== String(online.code)) return;

    const reply = Buffer.from(JSON.stringify({
      jd: 'room',
      code: online.code,
      name: online.hostName || null,
      requireIp: !!online.requireIp,
      httpPort: HTTP_PORT,
      httpsPort: HTTPS_PORT,
    }));

    try { sock.send(reply, rinfo.port, rinfo.address); } catch {  }
  });

  sock.on('error', () => {
    if (discoverySocket === sock) discoverySocket = null;
    try { sock.close(); } catch {  }
  });

  try {
    sock.bind(DISCOVERY_PORT, '0.0.0.0');
  } catch {
    discoverySocket = null;
    try { sock.close(); } catch {  }
  }
}

function stopDiscovery() {
  const sock = discoverySocket;
  discoverySocket = null;
  if (!sock) return;
  try { sock.close(); } catch {  }
}

function discoverRoom(code, done) {
  let finished = false;
  const sock = dgram.createSocket('udp4');

  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    try { sock.close(); } catch {  }
    done(result);
  };

  const timer = setTimeout(() => finish(null), 1600);

  sock.on('message', (buf, rinfo) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!msg || msg.jd !== 'room') return;
    if (String(msg.code) !== String(code)) return;

    finish({
      ip: rinfo.address,
      requireIp: !!msg.requireIp,
      httpPort: Number(msg.httpPort) || 8081,
      httpsPort: Number(msg.httpsPort) || 8443,
    });
  });

  sock.on('error', () => finish(null));

  try {
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch {  }
      const payload = Buffer.from(JSON.stringify({ jd: 'discover', code: String(code) }));
      for (const addr of broadcastAddresses()) {
        try { sock.send(payload, DISCOVERY_PORT, addr); } catch {  }
      }
    });
  } catch {
    finish(null);
  }
}

function joinOnline(hostInput, code, profileName, done) {
  const cb = typeof done === 'function' ? done : () => {};

  if (!/^\d{5}$/.test(String(code || ''))) {
    return cb('El código debe tener 5 dígitos.');
  }

  if (online.role === 'host' && String(code) === String(online.code)) {
    return cb('Ese es el código de la sala de este mismo PC. Para probar, únete desde otro PC.');
  }

  const rawHost = String(hostInput || '').trim();

  if (rawHost) {
    const base = normalizeHost(rawHost);
    if (!base) return cb('La IP o URL del anfitrión no es válida.');
    return applyJoin(base, code, profileName, cb);
  }

  discoverRoom(code, (found) => {
    if (!found) {
      return cb('No se encontró esa sala. Revisa el código o escribe la IP/URL del anfitrión.');
    }
    if (found.requireIp) {
      return cb('Esta sala requiere la IP del anfitrión.');
    }

    const base = normalizeHost(`ws://${found.ip}:${found.httpPort}`);
    if (!base) return cb('No se pudo resolver la IP de la sala.');

    applyJoin(base, code, profileName, cb);
  });
}

const JOIN_WAIT_MS = 40000;

function applyJoin(base, code, profileName, cb) {
  if (online.role === 'host') stopOnlineHost();
  else leaveOnline();
  if (!room.code) room.code = randomCode();

  online.pendingJoin = {
    cb: (err) => {

      if (err) leaveOnline(true);
      cb(err);
    },
    timer: setTimeout(() => {
      online.error = 'El anfitrión no respondió a tiempo.';
      finishJoin(online.error);
    }, JOIN_WAIT_MS),
  };

  online.role = 'member';
  online.code = String(code);
  online.host = base;
  online.connected = false;
  online.admin = false;
  online.error = null;
  online.hint = null;

  if (profileName) {

    online.hostName = null;
  }

  connectOnline();
  broadcastHost();
  notifyPhonesOnline();
}

function handleOnlineMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

  if (msg.type === 'play') {
    if (msg.from && msg.from !== online.memberId) applyPlay(String(msg.from), cleanPlay(msg));
    return;
  }
  if (msg.type === 'clock') {
    const rtt = Date.now() - Number(msg.t0);
    if (rtt >= 0 && rtt < 10000 && rtt < online.clockRtt) {
      online.clockRtt = rtt;
      online.clockOffset = Number(msg.hostAt) - (Number(msg.t0) + Date.now()) / 2;
    }
    return;
  }

  if (msg.type === 'welcome') {
    online.memberId = msg.memberId;
    online.admin = !!msg.admin;
    if (msg.hostName) online.hostName = msg.hostName;
    finishJoin(null);
  } else if (msg.type === 'room') {
    if (msg.host) {
      online.hostName = msg.host.name || online.hostName;
      online.hostSong = msg.host.song || null;
      online.hostPhase = msg.host.phase || null;
      online.hostPhone = !!msg.host.phone;
      online.hostReady = !!msg.host.ready;
    }
    online.targetSong = msg.targetSong || null;
    if (online.localReadySong && normName(online.localReadySong) !== normName(online.targetSong)) {
      online.localReadySong = null;
      cancelRemoteStart();
      sendMemberUpdate(localSnapshot());
    }
    online.hint = msg.hint || null;
    online.admin = !!msg.admin;
    online.requireIp = !!msg.requireIp;

    const snap = localSnapshot();
    const same = !!(online.targetSong && snap.song &&
      normName(snap.song) === normName(online.targetSong));

    if (msg.host && msg.host.phase === 'dancing' && same) {
      online.hint = snap.phase === 'dancing'
        ? 'Bailando con la sala'
        : 'El anfitrión ya está bailando';
    } else if (online.targetSong && !same) {
      online.hint = 'Elige «' + online.targetSong + '» para unirte';
    }

    const next = new Map();
    for (const m of msg.members || []) {
      if (!m || !m.id || m.id === online.memberId) continue;
      next.set(m.id, { ...m, link: null, joinedAt: 0 });
    }
    online.members = next;
  } else if (msg.type === 'sync') {
    handleMemberSync(msg);
  } else if (msg.type === 'closed') {
    online.error = 'El anfitrión cerró la sala';
    leaveOnline(true);
    return;
  }

  broadcastHost();
  notifyPhonesOnline();
}

function handleMemberSync(msg) {
  const snap = localSnapshot();

  if (msg.action === 'song') {
    online.targetSong = msg.song || null;
    if (online.localReadySong && normName(online.localReadySong) !== normName(online.targetSong)) {
      online.localReadySong = null;
      cancelRemoteStart();
      sendMemberUpdate(snap);
    }
    online.hint = online.targetSong
      ? 'El anfitrión eligió «' + online.targetSong + '»'
      : null;
  } else if (msg.action === 'start-scheduled') {
    cancelRemoteStart();
    if (snap.phase !== 'lobby' || normName(snap.song) !== normName(msg.song) ||
        normName(online.localReadySong) !== normName(msg.song) || !canStartHere(msg.song)) {
      online.hint = 'Inicio cancelado: no estabas listo en la misma canción.';
      if (online.ws && online.ws.readyState === 1)
        online.ws.send(JSON.stringify({ type: 'start-failed', id: msg.id }));
    } else {
      const offset = online.clockOffset;
      const wait = offset === null
        ? START_LEAD_MS - 100
        : Number(msg.startAt) - Date.now() - offset;
      if (!Number.isFinite(wait) || wait < -500) {
        online.hint = 'Inicio cancelado: reloj desfasado. Vuelve a pulsar listo.';
        if (online.ws && online.ws.readyState === 1)
          online.ws.send(JSON.stringify({ type: 'start-failed', id: msg.id }));
      } else {
        const plan = { id: msg.id, at: msg.startAt, timer: null };
        online.remoteStart = plan;
        online.hint = 'Todos listos · comenzando...';
        plan.timer = setTimeout(() => {
          if (online.remoteStart !== plan) return;
          cancelRemoteStart();
          if (online.role !== 'member' || !canStartHere(msg.song) ||
              normName(online.localReadySong) !== normName(msg.song) ||
              !localEntry().game.command('start')) {
            online.localReadySong = null;
            online.hint = 'El juego no aceptó el inicio; vuelve al lobby.';
            if (online.ws && online.ws.readyState === 1)
              online.ws.send(JSON.stringify({ type: 'start-failed', id: msg.id }));
            sendMemberUpdate(localSnapshot());
          } else {
            online.expectedStartUntil = Date.now() + 10000;
          }
          broadcastHost();
          notifyPhonesOnline();
        }, Math.max(0, wait));
      }
    }
  } else if (msg.action === 'cancel-start') {
    if (online.remoteStart && online.remoteStart.id === msg.id) cancelRemoteStart();
    online.hint = 'Inicio cancelado: alguien salió del lobby o cambió de canción.';
  } else if (msg.action === 'pause') {
    const entry = localEntry();
    if (entry && entry.game.sending) entry.game.command('pause');
    online.hint = 'Pausa de la sala';
  } else if (msg.action === 'stop') {
    online.hint = null;
  }

  broadcastHost();
  notifyPhonesOnline();
}

function isSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || '').toLowerCase();
  return proto.split(',')[0].trim() === 'https';
}

const TUNNEL_STATE = path.join(__dirname, 'cache', 'tunnel.json');
const CLOUDFLARED = path.join(__dirname, 'cloudflared.exe');
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let tunnelProc = null;
const tunnel = { url: '', state: 'idle', error: null };

function clearTunnelFile() {
  try { fs.unlinkSync(TUNNEL_STATE); } catch {  }
}

function setTunnel(state, error) {
  tunnel.state = state;
  tunnel.error = error || null;
  if (state !== 'ready') tunnel.url = '';
  try { broadcastHost(); } catch {  }
}

function startTunnel() {
  if (tunnelProc) return;

  if (!fs.existsSync(CLOUDFLARED)) {
    setTunnel('error', 'Falta cloudflared.exe junto al servidor.');
    return;
  }

  let proc;
  try {
    proc = spawn(CLOUDFLARED, ['tunnel', '--url', `http://127.0.0.1:${HTTP_PORT}`, '--no-autoupdate'], {
      cwd: __dirname,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    setTunnel('error', 'No se pudo lanzar cloudflared: ' + err.message);
    return;
  }

  tunnelProc = proc;
  tunnel.url = '';
  tunnel.error = null;
  tunnel.state = 'starting';
  broadcastHost();

  let buf = '';
  const onData = (chunk) => {
    if (tunnel.url) return;

    buf = (buf + chunk.toString()).slice(-4096);
    const m = buf.match(TUNNEL_URL_RE);
    if (!m) return;

    tunnel.url = m[0];
    tunnel.state = 'ready';
    tunnel.error = null;

    try {
      fs.mkdirSync(path.dirname(TUNNEL_STATE), { recursive: true });
      fs.writeFileSync(TUNNEL_STATE, JSON.stringify({ url: m[0], pid: proc.pid, at: Date.now() }, null, 2));
    } catch {  }

    console.log('  Tunel listo: ' + m[0] + '/m');
    broadcastHost();
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('error', (err) => {
    if (tunnelProc !== proc) return;
    tunnelProc = null;
    setTunnel('error', 'No se pudo lanzar cloudflared: ' + err.message);
  });

  proc.on('exit', () => {
    if (tunnelProc !== proc) return;
    tunnelProc = null;
    clearTunnelFile();
    setTunnel('idle', null);
  });

  setTimeout(() => {
    if (tunnelProc === proc && !tunnel.url && !tunnel.error) {
      tunnel.error = 'Cloudflare no respondió (revisa la red o el firewall).';
      broadcastHost();
    }
  }, 30000).unref();
}

function stopTunnel() {
  const proc = tunnelProc;
  tunnelProc = null;
  clearTunnelFile();
  setTunnel('idle', null);

  if (!proc) return;
  try { proc.kill(); } catch {  }
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!n || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function tunnelState() {
  if (tunnelProc || tunnel.state !== 'idle') {
    return { url: tunnel.url, active: !!tunnel.url, state: tunnel.state, error: tunnel.error };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(TUNNEL_STATE, 'utf8'));
    const url = String(raw.url || '').trim().replace(/\/+$/, '');
    const viejo = Date.now() - Number(raw.at || 0) > 12 * 3600 * 1000;
    if (url && pidAlive(raw.pid) && !viejo) {
      return { url, active: true, state: 'ready', error: null };
    }
    clearTunnelFile();
  } catch {  }

  return { url: '', active: false, state: 'idle', error: null };
}

try {
  const prev = JSON.parse(fs.readFileSync(TUNNEL_STATE, 'utf8'));
  if (prev && prev.pid && pidAlive(prev.pid)) {
    try { process.kill(Number(prev.pid)); } catch {  }
  }
} catch {  }
clearTunnelFile();

function roomState() {
  const suffix = room.code ? '?code=' + room.code : '';
  const owners = phoneOwners();
  return {
    pid: process.pid,
    code: room.code,
    ips: IPS,
    primaryIP: PRIMARY_IP,
    httpsPort: HTTPS_PORT,
    url: `https://${PRIMARY_IP}:${HTTPS_PORT}/m${suffix}`,
    urls: IPS.map((i) => ({ ip: i.address, name: i.name, url: `https://${i.address}:${HTTPS_PORT}/m${suffix}` })),
    phones: [...room.phones.values()].map((p) => phoneState(p, owners)),
    online: onlineState(),
    tunnel: tunnelState(),
  };
}

function phoneState(entry, owners) {
  const st = entry.game ? entry.game.state() : { id: entry.id };
  if (!st.lobby && !st.sending) st.song = null;
  st.avatarUrl = entry.avatarFile ? `/api/avatar/${entry.id}?v=${entry.avatarVersion}` : null;

  st.pc = entry === localEntry();
  st.phone = true;
  st.owner = (owners || phoneOwners()).get(entry.id) || null;

  st.online = onlineState();
  return st;
}

const wssHost = new WebSocketServer({ noServer: true });
const wssPhone = new WebSocketServer({ noServer: true });
const wssOnline = new WebSocketServer({ noServer: true });

function broadcastHost() {

  reconcileGhosts();
  const data = JSON.stringify({ type: 'state', state: roomState() });
  for (const client of wssHost.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function socketLink(socket, req) {
  return {
    ip: clientIp(req),
    isOpen: () => socket.readyState === 1,
    send: (obj) => { if (socket.readyState === 1) socket.send(JSON.stringify(obj)); },
    close: () => { try { socket.close(); } catch {  } },
    onMessage: (fn) => socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      fn(msg);
    }),
    onClose: (fn) => { socket.on('close', fn); socket.on('error', fn); },
  };
}

wssOnline.on('connection', (socket, req) => createOnlineMember(socketLink(socket, req)));

function createOnlineMember(link) {
  if (online.role !== 'host') {
    try { link.send({ type: 'closed' }); } catch {  }
    link.close();
    return;
  }

  const id = 'm' + (online.memberSeq++);
  const member = {
    id,
    link,
    ip: link.ip || null,
    via: link.remote ? 'remote' : 'direct',
    name: null,
    song: null,
    phase: 'menu',
    phone: false,
    readySong: null,
    connected: true,
    admin: false,
    joinedAt: Date.now(),
    lastSeen: Date.now(),
  };
  online.members.set(id, member);
  maybeScheduleStart();

  refreshAdmin();
  try {
    link.send({
      type: 'welcome',
      memberId: id,
      code: online.code,
      hostName: online.hostName,
      admin: member.id === online.adminId,
    });
  } catch {  }
  broadcastOnlineRoom();

  function applyMember(msg) {
    if (!msg) return;
    if (msg.name !== undefined) {
      const n = String(msg.name || '').trim();
      member.name = n ? n.slice(0, 40) : null;
    }
    if (msg.song !== undefined) {
      const s = String(msg.song || '').trim();
      member.song = s ? s.slice(0, 120) : null;
    }
    if (msg.phase !== undefined) {
      const p = String(msg.phase || '');
      member.phase = ['menu', 'lobby', 'dancing', 'offline'].includes(p) ? p : 'menu';
    }
    if (msg.phone !== undefined) member.phone = !!msg.phone;
    member.readySong = member.phase === 'lobby' &&
      normName(msg.readySong) === normName(member.song) ? member.song : null;
    if (member.phase === 'dancing' && (!online.startPlan || !online.startPlan.dispatched))
      online.hint = 'Un PC empezó desde otro mando; no se puede cancelar en Legacy.exe.';
    member.lastSeen = Date.now();
    maybeScheduleStart();
    refreshAdmin();
    broadcastOnlineRoom();
  }

  link.onMessage((msg) => {
    if (!msg) return;
    if (msg.type === 'hello' || msg.type === 'member') applyMember(msg);
    else if (msg.type === 'clock') {
      member.lastSeen = Date.now();
      link.send({ type: 'clock', t0: msg.t0, hostAt: Date.now() });
    } else if (msg.type === 'start-failed') {
      member.lastSeen = Date.now();
      if (online.startPlan && online.startPlan.id === msg.id) {
        if (online.startPlan.dispatched) {
          online.startFailed = true;
          online.hint = 'Un jugador no pudo iniciar; volved al lobby para sincronizar.';
        } else {
          cancelStartPlan('Un jugador no pudo iniciar; vuelve a marcarte listo.');
        }
      } else if (msg.id === online.startSeq && Date.now() - online.startedAt < 15000) {
        online.startFailed = true;
        online.hint = 'Un jugador no pudo iniciar; volved al lobby para sincronizar.';
      }
      broadcastOnlineRoom();
    }
    else if (msg.type === 'play') {
      member.lastSeen = Date.now();
      relayPlay(member.id, cleanPlay(msg));
    } else if (msg.type === 'ping') {
      member.lastSeen = Date.now();
      try { link.send({ type: 'pong' }); } catch {  }
    }
  });

  link.onClose(() => {
    if (online.members.get(id) !== member) return;
    online.members.delete(id);
    maybeScheduleStart();
    refreshAdmin();
    broadcastOnlineRoom();
  });
}

function cacheAvatar(entry, gamePath, done) {
  if (!gamePath || typeof gamePath !== 'string' || gamePath.charAt(0) !== '/') return;
  if (gamePath === entry.avatarSrc) return;
  entry.avatarSrc = gamePath;

  const ext = (path.extname(gamePath) || '.png').toLowerCase();
  if (!/^\.(png|jpg|jpeg|webp)$/.test(ext)) return;

  const target = path.join(AVATAR_DIR, entry.id + ext);
  const req = http.get(GAME_HTTP + gamePath, (up) => {
    if (up.statusCode !== 200) {
      up.resume();
      entry.avatarSrc = null;
      return;
    }
    const chunks = [];
    up.on('data', (c) => chunks.push(c));
    up.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length || buf.length > 2 * 1024 * 1024) return;
      fs.writeFile(target, buf, (err) => {
        if (err) return;
        entry.avatarFile = target;
        entry.avatarVersion = (entry.avatarVersion || 0) + 1;
        if (done) done();
      });
    });
  });
  req.on('error', () => { entry.avatarSrc = null; });
  req.setTimeout(4000, () => req.destroy());
}

wssHost.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'state', state: roomState() }));
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'create-room') {
      room.code = randomCode();
      broadcastHost();
      startTunnel();
    } else if (msg.type === 'close-room') {
      room.code = null;
      broadcastHost();
      stopTunnel();
    }
  });
});

function createPhoneSession(transport) {
  const clientId = nextPhoneId++;
  const game = new GamePhone(clientId);
  const send = (obj) => transport.send(obj);
  const entry = { id: clientId, game, send, remote: !!transport.remote, ip: transport.ip || null };
  room.phones.set(clientId, entry);

  game.on('state', (st) => {
    if (!st.connected) entry.ready = false;

    if (st.lobby && !entry.wasLobby && entry === localEntry() && online.role) sendPlay({ lobby: true });
    entry.wasLobby = !!st.lobby;

    send({ type: 'game-state', state: phoneState(entry) });
    broadcastHost();
    syncLocalToOnline();

    cacheAvatar(entry, st.avatar, () => {
      send({ type: 'game-state', state: phoneState(entry) });
      broadcastHost();
    });
  });
  game.on('ready', () => {
    entry.ready = true;
    send({ type: 'ready' });
    broadcastHost();
  });
  game.on('game', (msg) => {

    fs.appendFile(UI_LOG, JSON.stringify({ at: Date.now(), cls: msg.__class, msg }) + '\n', () => {});

    if (
      msg.__class === 'JD_PhoneUiSetupData' ||
      msg.__class === 'JD_ProfilePhoneUiData' ||
      msg.__class === 'JD_ClosePopup_ConsoleCommandData' ||
      msg.__class === 'JD_EnableAccelValuesSending_ConsoleCommandData' ||
      msg.__class === 'JD_DisableAccelValuesSending_ConsoleCommandData'
    ) {
      send({ type: 'game', msg });
    }
  });

  game.start();
  send({ type: 'joined', id: clientId });
  send({ type: 'game-state', state: phoneState(entry) });
  send({ type: 'online', online: onlineState() });
  broadcastHost();
  syncLocalToOnline();

  transport.onMessage((msg) => {
    const isLocal = entry === localEntry() && !!online.role;

    if (msg.type === 'accel') {
      const v = msg.v;
      if (Array.isArray(v) && v.length === 3) {
        game.pushAccel(v[0], v[1], v[2]);

        if (isLocal && game.sending && v.every((n) => Number.isFinite(+n))) relayAccel(v);
      }
    } else if (msg.type === 'action') {
      if (online.role && isStartAction(msg.command)) {
        markReady(entry);
        return;
      }
      const ok = game.sendRawAction(msg.command);
      if (!ok) send({ type: 'cmd-rejected', name: 'action' });
      const coach = coachFromAction(msg.command);
      if (ok && isLocal && coach !== null) sendPlay({ coach });
    } else if (msg.type === 'cmd') {
      if (online.role && msg.name === 'start') {
        markReady(entry);
        return;
      }
      const ok = game.command(msg.name, msg.payload || {});
      if (!ok && msg.name !== 'pause') send({ type: 'cmd-rejected', name: msg.name });
      if (ok && isLocal && msg.name === 'coach') {
        const c = Number((msg.payload || {}).index) || 0;
        if (Number.isInteger(c) && c >= 0 && c < 8) sendPlay({ coach: c });
      }

      if (msg.name === 'pause' && online.role === 'host' && localEntry() === entry) {
        broadcastSync('pause');
      }
    }
  });

  transport.onClose(() => {
    game.stop();
    room.phones.delete(clientId);
    broadcastHost();
    syncLocalToOnline();
  });

  return entry;
}

wssPhone.on('connection', (socket, req) => {
  createPhoneSession({
    ip: clientIp(req),
    send: (obj) => { if (socket.readyState === 1) socket.send(JSON.stringify(obj)); },
    onMessage: (fn) => socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      fn(msg);
    }),
    onClose: (fn) => socket.on('close', fn),
  });
});

const GAME_CACHE = new Map();

function fetchGameResource(gamePath, cb) {
  if (!gamePath || gamePath.charAt(0) !== '/' || gamePath.indexOf('..') !== -1) {
    cb({ error: 'ruta' });
    return;
  }

  const hit = GAME_CACHE.get(gamePath);
  if (hit && Date.now() - hit.at < 120000) {
    cb(hit);
    return;
  }

  const req = http.get(GAME_HTTP + gamePath, (up) => {
    if (up.statusCode !== 200) {
      up.resume();
      cb({ error: 'http' });
      return;
    }
    const chunks = [];
    let size = 0;
    up.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { up.destroy(); return; }
      chunks.push(c);
    });
    up.on('end', () => {
      if (!chunks.length) { cb({ error: 'vacio' }); return; }
      const buf = Buffer.concat(chunks);
      const out = {
        data: buf.toString('base64'),
        mime: String(up.headers['content-type'] || 'image/png').split(';')[0],
        at: Date.now(),
      };
      if (GAME_CACHE.size > 80) GAME_CACHE.clear();
      GAME_CACHE.set(gamePath, out);
      cb(out);
    });
  });
  req.on('error', () => cb({ error: 'red' }));
  req.setTimeout(6000, () => { req.destroy(); cb({ error: 'timeout' }); });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
};

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('403'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }
    const headers = { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' };

    if (/\.(html|js|css)$/i.test(full)) headers['Cache-Control'] = 'no-store, must-revalidate';
    res.writeHead(200, headers);
    res.end(buf);
  });
}

function proxyGame(req, res) {
  const sub = req.url.replace(/^\/game/, '') || '/';
  const target = new URL(sub, GAME_HTTP);
  const upstream = http.request(
    { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: 'GET' },
    (up) => {
      const headers = { ...up.headers };
      delete headers['content-security-policy'];
      res.writeHead(up.statusCode || 502, headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end('juego no disponible');
  });
  upstream.end();
}

function readJsonBody(req, done) {
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
    if (data.length > 64 * 1024) req.destroy();
  });
  req.on('end', () => {
    try { done(JSON.parse(data || '{}')); } catch { done({}); }
  });
  req.on('error', () => done({}));
}

function jsonResponse(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const secure = isSecure(req);

  if (p === '/host') return serveStatic(res, 'host.html');

  if (p === '/' || p === '/m' || p === '/mobile') {
    if (!secure) {
      const host = (req.headers.host || '').split(':')[0] || PRIMARY_IP;
      res.writeHead(302, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
      return res.end();
    }
    return serveStatic(res, 'mobile.html');
  }

  if (p === '/api/state') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    });
    const st = roomState();

    if (url.searchParams.get('debug') === '1') {
      st.phones = [
        { id: 1, name: 'usagi', avatar: null, avatarUrl: '/api/qr?text=usagi', song: 'DADDY', connected: true, sending: true, inputAllowed: true, samples: 100, error: null },
        { id: 2, name: 'jazzy', avatar: null, avatarUrl: null, song: null, connected: true, sending: false, inputAllowed: true, samples: 0, error: null },
        { id: 3, name: null, avatar: null, avatarUrl: null, song: null, connected: false, sending: false, inputAllowed: false, samples: 0, error: null },
      ];
    }
    return res.end(JSON.stringify(st));
  }

  const av = p.match(/^\/api\/avatar\/(\d+)$/);
  if (av) {
    const entry = room.phones.get(Number(av[1]));
    if (!entry || !entry.avatarFile) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('sin avatar');
    }
    return fs.readFile(entry.avatarFile, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('sin avatar');
      }
      const ext = path.extname(entry.avatarFile).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }

  if (p === '/api/room') {
    if (req.method === 'POST') {
      if (!room.code) room.code = randomCode();
      startOnlineHost();
      broadcastHost();
      startTunnel();
    } else if (req.method === 'DELETE') {
      if (online.role === 'member') {

        leaveOnline();
      } else {
        stopOnlineHost();
        room.code = null;
      }
      broadcastHost();
      stopTunnel();
    } else {
      res.writeHead(405).end();
      return;
    }
    return jsonResponse(res, roomState());
  }

  if (p === '/api/online' || p === '/api/online/join' || p === '/api/online/host' ||
      p === '/api/online/leave' || p === '/api/online/require-ip') {
    if (req.method === 'GET') return jsonResponse(res, onlineState());

    if (req.method === 'POST') {
      return readJsonBody(req, (body) => {
        if (p === '/api/online/host' || body.action === 'host') {
          startOnlineHost();
          return jsonResponse(res, { ok: true, online: onlineState() });
        }

        if (p === '/api/online/leave' || body.action === 'leave') {
          leaveOnline();
          return jsonResponse(res, { ok: true, online: onlineState() });
        }

        if (p === '/api/online/require-ip') {
          if (online.role !== 'host') {
            return jsonResponse(res, { ok: false, error: 'Solo el anfitrión puede cambiar esta opción.', online: onlineState() }, 400);
          }
          online.requireIp = !!body.enabled;
          broadcastOnlineRoom();
          return jsonResponse(res, { ok: true, online: onlineState() });
        }

        joinOnline(body.host, body.code, body.name, (err) => {
          if (err) return jsonResponse(res, { ok: false, error: err, online: onlineState() }, 400);
          return jsonResponse(res, { ok: true, online: onlineState() });
        });
      });
    }

    if (req.method === 'DELETE') {
      leaveOnline();
      return jsonResponse(res, { ok: true, online: onlineState() });
    }

    res.writeHead(405).end();
    return;
  }

  if (p === '/api/qr') {
    const text = url.searchParams.get('text') || `https://${PRIMARY_IP}:${HTTPS_PORT}/m`;
    try {
      const png = await QRCode.toBuffer(text, { margin: 1, width: 320 });
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(png);
    } catch {
      res.writeHead(500).end('qr error');
      return;
    }
  }

  if (p.startsWith('/game/')) return proxyGame(req, res);

  if (p.startsWith('/public/')) return serveStatic(res, p.slice('/public/'.length));

  const guess = p.slice(1);
  if (guess && fs.existsSync(path.join(PUBLIC_DIR, guess))) return serveStatic(res, guess);

  return serveStatic(res, 'mobile.html');
}

const server = https.createServer({ key: TLS.key, cert: TLS.cert }, handler);
const plainServer = http.createServer(handler);

server.on('upgrade', (req, socket, head) => routeUpgrade(req, socket, head, true));
plainServer.on('upgrade', (req, socket, head) => routeUpgrade(req, socket, head, false));

function routeUpgrade(req, socket, head, secure) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/ws/host') {
    wssHost.handleUpgrade(req, socket, head, (ws) => wssHost.emit('connection', ws, req));
    return;
  }

  if (url.pathname === '/ws/online') {
    const code = url.searchParams.get('code') || '';
    if (online.role !== 'host' || !online.code || code !== online.code) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wssOnline.handleUpgrade(req, socket, head, (ws) => wssOnline.emit('connection', ws, req));
    return;
  }

  if (url.pathname === '/ws/phone') {
    if (!secure && !isSecure(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\nAbre la version https\r\n');
      socket.destroy();
      return;
    }
    const code = url.searchParams.get('code') || '';
    if (!room.code || code !== room.code) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wssPhone.handleUpgrade(req, socket, head, (ws) => wssPhone.emit('connection', ws, req, code));
    return;
  }

  socket.destroy();
}

setInterval(() => {
  if (online.role === 'member' && online.ws && online.ws.readyState === 1) {
    try {
      online.ws.send(JSON.stringify({ type: 'ping' }));
      online.ws.send(JSON.stringify({ type: 'clock', t0: Date.now() }));
    } catch {  }
  }

  if (online.role !== 'host') return;

  const now = Date.now();
  let changed = false;
  for (const m of [...online.members.values()]) {
    if (now - m.lastSeen > 30000) {
      online.members.delete(m.id);
      try { m.link.close(); } catch {  }
      changed = true;
    }
  }
  if (changed) {
    maybeScheduleStart();
    refreshAdmin();
    broadcastOnlineRoom();
  }
}, 10000);

plainServer.listen(HTTP_PORT, '0.0.0.0');

server.listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Just Dance - Sala local');
  console.log('  -----------------------------');
  console.log(`  Panel del PC: http://localhost:${HTTP_PORT}/`);
  console.log(`  Movil:        https://${PRIMARY_IP}:${HTTPS_PORT}/m`);
  for (const ip of IPS) {
    if (ip.address !== PRIMARY_IP) {
      console.log(`  Alternativa:  https://${ip.address}:${HTTPS_PORT}/m  (${ip.name})`);
    }
  }
  if (tunnelState().active) {
    console.log(`  Tunel:        ${tunnelState().url}/m`);
  } else {
    console.log('  Tunel:        se abre al pulsar "Abrir servidor" en el panel');
  }
  console.log('');
  console.log('  (la primera vez el movil pedira aceptar el certificado)');
  console.log('');
});

function killTunnel() {
  const proc = tunnelProc;
  tunnelProc = null;
  if (!proc) return;
  try { proc.kill(); } catch {  }
}

process.on('exit', killTunnel);

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    killTunnel();
    process.exit(0);
  });
}
