'use strict';

const $ = (id) => document.getElementById(id);

const screens = {
  code: $('scr-code'),
  ready: $('scr-ready'),
  pad: $('scr-pad'),
  lobby: $('scr-lobby'),
  score: $('scr-score'),
  popup: $('scr-popup'),
};

const codeInput = $('codeInput');
const codeErr = $('codeErr');
const readyErr = $('readyErr');
const connName = $('connName');
const playerAvatar = $('playerAvatar');
const gamePill = $('gamePill');
const roomLine = $('roomLine');
const stateBig = $('stateBig');
const coachStage = $('coachStage');
const coachNameplate = $('coachNameplate');
const lobbyName = $('lobbyName');
const lobbyAvatar = $('lobbyAvatar');
const danceAvatar = $('danceAvatar');

let ws = null;
let dancing = false;
let lastAccel = 0;
let wakeLock = null;
let coaches = [];
let coachSig = '';
let selectedCoach = 0;
let pendingContinue = null;
let moveLevel = 0;
let lastMag = 9.8;
let lastMovePaint = 0;
let playerName = '';
let roomCode = '';
let connecting = false;
let retrying = false;
let lastSeen = 0;
let reconnectTries = 0;

/* Identidad estable del móvil: al reconectar se reutiliza el mismo jugador. */
let devId = '';
try { devId = localStorage.getItem('jdDev') || ''; } catch { /* modo privado */ }
if (!devId) {
  devId = (self.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  try { localStorage.setItem('jdDev', devId); } catch { /* modo privado */ }
}

/* Servida desde el backend (Render): se intenta primero el PC en la red local */
const remoteMode = document.documentElement.dataset.remote === '1';

const params = new URLSearchParams(location.search);
if (params.get('code')) codeInput.value = params.get('code');

const I18N = {
  en: {
    codeNote: 'Type the 5-digit code shown on the PC.',
    btnConnect: 'CONNECT',
    brandReady: 'READY',
    readyNote: 'To score I need the phone accelerometer. Tap the button and keep the phone in your hand like in the game.',
    btnStart: 'ENABLE SENSORS',
    connecting: 'connecting...',
    gameLoading: 'game...',
    connected: 'connected',
    gameClosed: 'game closed',
    dancing: 'dancing',
    gameMenu: 'in the menu',
    ready: 'ready',
    movement: 'MOVEMENT',
    menu: 'MENU',
    danceDo: 'DANCE!',
    dance: 'DANCE!',
    danceReady: 'I AM READY',
    danceCancelReady: 'CANCEL READY',
    pickCoach: 'PICK YOUR COACH',
    back: 'BACK',
    pcontinue: 'CONTINUE',
    noSensors: 'NO SENSORS',
    roomTag: 'ROOM {code}',
    roomOnline: 'ONLINE ROOM',
    host: 'HOST',
    tagConnecting: 'CONNECTING',
    admin: 'ADMIN',
    inRoom: 'IN ROOM',
    readyCount: 'Ready {a}/{b}',
    errCode5: 'The code has 5 digits.',
    errSearching: 'Looking for the PC on your network...',
    errRetry: 'Connecting to the server... ({n}/3)',
    errLost: 'Connection lost. Join again.',
    errReconnecting: 'Connection lost. Reconnecting... ({n}/3)',
    errConnecting: 'Connecting to the server...',
    errNoConn: 'Could not connect. Check the code and the network.',
    errNoRoom: 'That code is not active. Open the room on the PC.',
    errRemote: 'The PC is not connected to the remote server.',
    coachesEmpty: 'The game has not sent the coaches yet',
    sensorDenied: 'Sensor permission denied.',
    sensorAskFail: 'Could not ask for sensor permission.',
    ariaUp: 'Up', ariaLeft: 'Left', ariaRight: 'Right', ariaDown: 'Down',
    ariaBack: 'Back', ariaPause: 'Pause', ariaSwitchRoom: 'Switch room',
  },
  es: {
    codeNote: 'Pide el código de 5 dígitos que aparece en el PC.',
    btnConnect: 'CONECTAR',
    brandReady: 'LISTO',
    readyNote: 'Para puntuar necesito el acelerómetro del móvil. Pulsa el botón y mantén el teléfono en la mano como en el juego.',
    btnStart: 'ACTIVAR SENSORES',
    connecting: 'conectando...',
    gameLoading: 'juego...',
    connected: 'conectado',
    gameClosed: 'juego cerrado',
    dancing: 'bailando',
    gameMenu: 'en el menú',
    ready: 'listo',
    movement: 'MOVIMIENTO',
    menu: 'MENU',
    danceDo: 'BAILA!',
    dance: 'BAILAR!',
    danceReady: 'ESTOY LISTO',
    danceCancelReady: 'CANCELAR LISTO',
    pickCoach: 'ELIGE TU COACH',
    back: 'ATRÁS',
    pcontinue: 'CONTINUAR',
    noSensors: 'SIN SENSORES',
    roomTag: 'SALA {code}',
    roomOnline: 'SALA ONLINE',
    host: 'ANFITRION',
    tagConnecting: 'CONECTANDO',
    admin: 'ADMIN',
    inRoom: 'EN SALA',
    readyCount: 'Listos {a}/{b}',
    errCode5: 'El código tiene 5 dígitos.',
    errSearching: 'Buscando el PC en la red...',
    errRetry: 'Conectando con el servidor... ({n}/3)',
    errLost: 'Se perdió la conexión. Vuelve a entrar.',
    errReconnecting: 'Se perdió la conexión. Reconectando... ({n}/3)',
    errConnecting: 'Conectando con el servidor...',
    errNoConn: 'No se pudo conectar. Revisa el código y la red.',
    errNoRoom: 'Ese código no está activo. Abre la sala en el PC.',
    errRemote: 'El PC no está conectado al servidor remoto.',
    coachesEmpty: 'El juego no envió coaches todavía',
    sensorDenied: 'Permiso de sensores denegado.',
    sensorAskFail: 'No se pudo pedir permiso de sensores.',
    ariaUp: 'Arriba', ariaLeft: 'Izquierda', ariaRight: 'Derecha', ariaDown: 'Abajo',
    ariaBack: 'Atrás', ariaPause: 'Pausa', ariaSwitchRoom: 'Cambiar de sala',
  },
  pt: {
    codeNote: 'Digite o código de 5 dígitos que aparece no PC.',
    btnConnect: 'CONECTAR',
    brandReady: 'PRONTO',
    readyNote: 'Para pontuar preciso do acelerômetro do celular. Toque no botão e mantenha o telefone na mão como no jogo.',
    btnStart: 'ATIVAR SENSORES',
    connecting: 'conectando...',
    gameLoading: 'jogo...',
    connected: 'conectado',
    gameClosed: 'jogo fechado',
    dancing: 'dançando',
    gameMenu: 'no menu',
    ready: 'pronto',
    movement: 'MOVIMENTO',
    menu: 'MENU',
    danceDo: 'DANCE!',
    dance: 'DANCE!',
    danceReady: 'ESTOU PRONTO',
    danceCancelReady: 'CANCELAR PRONTO',
    pickCoach: 'ESCOLHA SEU COACH',
    back: 'VOLTAR',
    pcontinue: 'CONTINUAR',
    noSensors: 'SEM SENSORES',
    roomTag: 'SALA {code}',
    roomOnline: 'SALA ONLINE',
    host: 'ANFITRIÃO',
    tagConnecting: 'CONECTANDO',
    admin: 'ADMIN',
    inRoom: 'NA SALA',
    readyCount: 'Prontos {a}/{b}',
    errCode5: 'O código tem 5 dígitos.',
    errSearching: 'Procurando o PC na rede...',
    errRetry: 'Conectando ao servidor... ({n}/3)',
    errLost: 'Conexão perdida. Entre de novo.',
    errReconnecting: 'Conexão perdida. Reconectando... ({n}/3)',
    errConnecting: 'Conectando ao servidor...',
    errNoConn: 'Não foi possível conectar. Confira o código e a rede.',
    errNoRoom: 'Esse código não está ativo. Abra a sala no PC.',
    errRemote: 'O PC não está conectado ao servidor remoto.',
    coachesEmpty: 'O jogo ainda não enviou os coaches',
    sensorDenied: 'Permissão dos sensores negada.',
    sensorAskFail: 'Não foi possível pedir permissão dos sensores.',
    ariaUp: 'Cima', ariaLeft: 'Esquerda', ariaRight: 'Direita', ariaDown: 'Baixo',
    ariaBack: 'Voltar', ariaPause: 'Pausa', ariaSwitchRoom: 'Trocar de sala',
  },
};

function pickLang() {
  const asked = String(params.get('lang') || '').toLowerCase();
  const sys = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
  const tag = asked || sys;
  if (tag.indexOf('pt') === 0) return 'pt';
  if (tag.indexOf('es') === 0) return 'es';
  if (tag.indexOf('en') === 0) return 'en';
  return 'en';
}

const LANG = pickLang();
const TEXT = I18N[LANG] || I18N.en;

function t(key, vars) {
  let s = TEXT[key];
  if (s == null) s = I18N.en[key];
  if (s == null) return key;
  if (vars) {
    Object.keys(vars).forEach((k) => { s = s.split('{' + k + '}').join(String(vars[k])); });
  }
  return s;
}

function applyStatic() {
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll('[data-tt]').forEach((el) => {
    const v = t(el.dataset.tt);
    el.setAttribute('title', v);
    el.setAttribute('aria-label', v);
  });
  connName.textContent = t('connecting');
  gamePill.textContent = t('gameLoading');
  stateBig.textContent = t('menu');
}

applyStatic();

function show(name) {
  Object.entries(screens).forEach(([key, el]) => el.classList.toggle('active', key === name));
}

const gameImg = (p) => {
  if (!p) return '';
  if (/^https?:/i.test(p)) return p;
  const rel = p.startsWith('/') ? p : '/' + p;
  // Remoto: las imagenes del juego las pide el backend al PC (cacheables)
  if (remoteMode && roomCode) return `/g/${roomCode}${rel}`;
  return '/game' + rel;
};

/** Nombre real del perfil que esta usando el juego (no "usuario 1").
    Si trae acentos, se usa Segoe: la DEMO de RBNo los dibuja como cajas. */
function jdName(el, text) {
  el.textContent = text;
  el.classList.toggle('jd-fallback', /[^\x20-\x7E]/.test(text));
}

function setName(n) {
  const v = String(n || '').trim();
  if (!v || v.indexOf('[icon:') === 0) return;
  playerName = v;
  jdName(connName, v);
}

/** Avatar del perfil, servido en local por el servidor. */
function setAvatar(url) {
  if (!url) return;
  if (playerAvatar.getAttribute('src') === url) return;
  playerAvatar.src = url;
  playerAvatar.style.display = 'block';
}

/** Linea discreta con el estado de la sala online del exe. */
function setOnline(on) {
  $('btnDance').textContent = on && on.requiresReady
    ? t(on.localReady ? 'danceCancelReady' : 'danceReady')
    : t('dance');
  if (!on || !on.role) {
    roomLine.textContent = '';
    roomLine.classList.remove('on');
    return;
  }

  let text = on.code ? t('roomTag', { code: on.code }) : t('roomOnline');
  if (on.role === 'host') text += ' · ' + t('host');
  else if (!on.connected) text += ' · ' + t('tagConnecting');
  else text += ' · ' + (on.admin ? t('admin') : t('inRoom'));

  if (on.hint) text += ` · ${on.hint}`;
  else if (on.role === 'member' && on.targetSong) text += ` · ${on.targetSong}`;
  if (on.localReady && on.totalCount)
    text += ' · ' + t('readyCount', { a: on.readyCount, b: on.totalCount });

  roomLine.textContent = text;
  roomLine.classList.add('on');
}

function goHome() {
  const socket = ws;
  ws = null;
  if (socket) {
    socket.jdManual = true;
    try { socket.close(); } catch {}
  }

  playerName = '';
  roomCode = '';
  connName.textContent = t('connecting');
  connName.classList.remove('jd-fallback');
  playerAvatar.removeAttribute('src');
  playerAvatar.style.display = 'none';
  lobbyName.textContent = '';
  lobbyAvatar.removeAttribute('src');
  lobbyAvatar.style.display = 'none';
  coachNameplate.classList.remove('on');
  coachStage.innerHTML = '';
  gamePill.textContent = t('gameLoading');
  gamePill.className = '';
  roomLine.textContent = '';
  roomLine.classList.remove('on');
  $('btnDance').textContent = t('dance');
  coaches = [];
  coachSig = '';
  selectedCoach = 0;
  pendingContinue = null;
  codeInput.value = '';
  codeErr.textContent = '';
  readyErr.textContent = '';

  try { history.replaceState(null, '', location.pathname); } catch {}
  setDancing(false);
  show('code');
}

/* ------------------------------------------------------------------ */
/*  Conexión                                                           */
/* ------------------------------------------------------------------ */
/**
 * Intenta hablar directo con el PC (misma wifi). Si la red o el
 * certificado no lo permiten, se sigue por el backend sin avisar.
 */
function probeHost(ip, port) {
  return new Promise((resolve) => {
    let socket = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!value && socket) { try { socket.close(); } catch { /* noop */ } }
      resolve(value ? { socket, ip, port } : null);
    };
    const timer = setTimeout(() => finish(null), 1400);

    try {
      socket = new WebSocket(
        `wss://${ip}:${port}/ws/phone?code=${roomCode}&dev=${encodeURIComponent(devId)}`
      );
    } catch {
      finish(null);
      return;
    }

    socket.addEventListener('open', () => finish(socket), { once: true });
    socket.addEventListener('error', () => finish(null), { once: true });
    socket.addEventListener('close', () => finish(null), { once: true });
  });
}

function probeDirect() {
  return fetch(`/api/room?code=${roomCode}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => new Promise((resolve) => {
      const list = info && Array.isArray(info.ips) ? info.ips.slice(0, 3) : [];
      if (!list.length) { resolve(null); return; }

      const port = info.httpsPort || 8443;
      let pending = list.length;
      let winner = null;

      list.forEach((ip) => {
        probeHost(ip, port).then((hit) => {
          if (!hit) {
            pending -= 1;
            if (!pending && !winner) resolve(null);
            return;
          }
          if (winner) { try { hit.socket.close(); } catch { /* noop */ } return; }
          winner = hit;
          resolve(hit);
        });
      });
    }))
    .catch(() => null);
}

async function connect() {
  const code = codeInput.value.replace(/\D/g, '');
  if (code.length !== 5) {
    codeErr.textContent = t('errCode5');
    return;
  }
  if (connecting || retrying || ws) return;

  connecting = true;
  codeErr.textContent = '';
  roomCode = code;

  let socket = null;
  if (remoteMode) {
    codeErr.textContent = t('errSearching');
    const hit = await probeDirect();

    // El PC respondio (misma wifi y certificado aceptado): todo va directo,
    // sin pasar por el backend ni para imagenes ni para los sensores.
    if (hit) {
      try { hit.socket.close(); } catch { /* noop */ }
      location.replace(`https://${hit.ip}:${hit.port}/m?code=${code}`);
      return;
    }
    codeErr.textContent = '';
  }

  connecting = false;
  startRelay(0);
}

/** WebSocket contra el backend (o el PC, si la web se sirve desde él). */
function startRelay(attempt) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  attachSocket(new WebSocket(
    `${proto}://${location.host}/ws/phone?code=${roomCode}&dev=${encodeURIComponent(devId)}`
  ), attempt);
}

function attachSocket(socket, attempt) {
  ws = socket;
  let opened = false;
  lastSeen = Date.now();

  // El socket directo puede llegar ya abierto desde probeHost
  if (socket.readyState === 1) {
    opened = true;
    show('ready');
  } else {
    socket.addEventListener('open', () => {
      opened = true;
      retrying = false;
      reconnectTries = 0;
      codeErr.textContent = '';
      show('ready');
    });
  }

  // Latido: si el PC no contesta en 40 s el socket está muerto aunque el
  // móvil aún lo crea abierto (pantalla bloqueada, cambio de red).
  const pingTimer = setInterval(() => {
    if (socket.readyState !== 1) return;
    if (Date.now() - lastSeen > 40000) {
      try { socket.close(); } catch { /* noop */ }
      return;
    }
    try { socket.send(JSON.stringify({ type: 'ping' })); } catch { /* noop */ }
  }, 12000);

  socket.addEventListener('close', () => {
    clearInterval(pingTimer);
    if (ws === socket) ws = null;
    if (socket.jdManual) return;

    const inPad = screens.pad.classList.contains('active') ||
      screens.lobby.classList.contains('active');

    // Render duerme el servicio: los primeros intentos pueden tardar en despertar
    if (!opened && remoteMode && !socket.jdNoRetry && attempt < 2) {
      retrying = true;
      codeErr.textContent = t('errRetry', { n: attempt + 2 });
      setTimeout(() => {
        retrying = false;
        if (!ws) startRelay(attempt + 1);
      }, 2200);
      return;
    }

    // Ya estaba dentro: el servidor guarda al jugador unos segundos, así que
    // se reconecta sin volver a la pantalla del código.
    if (opened && inPad && reconnectTries < 3) {
      reconnectTries += 1;
      codeErr.textContent = t('errReconnecting', { n: reconnectTries });
      setTimeout(() => {
        if (ws) return;
        startRelay(0);
      }, 1200 + reconnectTries * 1200);
      return;
    }

    if (inPad || screens.ready.classList.contains('active')) {
      setTimeout(() => {
        if (ws) return; // ya hay otra conexion en marcha
        show('code');
        codeErr.textContent = t('errLost');
      }, 800);
    }
  });

  socket.addEventListener('error', () => {
    if (!opened) {
      codeErr.textContent = remoteMode ? t('errConnecting') : t('errNoConn');
    }
  });

  socket.addEventListener('message', (ev) => {
    lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'pong') return;
    if (msg.type === 'error') {
      socket.jdNoRetry = true;
      codeErr.textContent = msg.error === 'no-room' ? t('errNoRoom') : t('errRemote');
    } else if (msg.type === 'joined') {
      if (!playerName) connName.textContent = t('connected');
    } else if (msg.type === 'online') {
      setOnline(msg.online);
    } else if (msg.type === 'game-state') {
      const st = msg.state;
      if (st.name) setName(st.name);
      if (st.avatarUrl) setAvatar(st.avatarUrl);
      if (st.online) setOnline(st.online);

      if (!st.connected) {
        gamePill.textContent = t('gameClosed');
        gamePill.className = '';
      } else if (st.sending) {
        gamePill.textContent = t('dancing');
        gamePill.className = 'dance';
      } else {
        gamePill.textContent = t('gameMenu');
        gamePill.className = '';
      }
    } else if (msg.type === 'ready') {
      gamePill.textContent = t('ready');
      gamePill.className = '';
    } else if (msg.type === 'cmd-rejected' && msg.reason) {
      roomLine.textContent = msg.reason;
      roomLine.classList.add('on');
    } else if (msg.type === 'game') {
      handleGame(msg.msg);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Estados que manda el juego                                         */
/* ------------------------------------------------------------------ */
function handleGame(m) {
  if (!m) return;

  if (m.__class === 'JD_EnableAccelValuesSending_ConsoleCommandData') {
    setDancing(true);
    show('pad');
    return;
  }
  if (m.__class === 'JD_DisableAccelValuesSending_ConsoleCommandData') {
    setDancing(false);
    return;
  }
  if (m.__class === 'JD_ClosePopup_ConsoleCommandData') {
    show('pad');
    return;
  }
  if (m.__class === 'JD_ProfilePhoneUiData') {
    setName(m.name);
    return;
  }
  if (m.__class !== 'JD_PhoneUiSetupData') return;

  const sd = m.setupData;
  if (!sd) return;

  // Popup del juego (tutorial, avisos). Solo si hay UNA opción clara:
  // los avisos de "si/no" no funcionan bien desde el movil, asi que se ignoran.
  if (m.isPopup === 1 && sd.mainCarousel) {
    const items = visibleItems(sd.mainCarousel);
    if (items.length === 1) {
      renderPopup(items[0]);
      return;
    }
  }

  // Selección de coach
  if (sd.lobbySetup) {
    setDancing(false);
    const prof = sd.lobbySetup.changeProfile;
    if (prof) {
      setName(prof.title);
      setLobbyProfile(prof.title, prof.image || prof.icon);
    } else {
      setLobbyProfile(playerName, null);
    }
    renderCoaches(sd.lobbySetup.coaches || sd.lobbySetup.lobbyData || []);
    show('lobby');
    requestAnimationFrame(layoutCoaches);
    return;
  }

  // Comienza la canción
  if (sd.gameplaySetup) {
    const img = sd.gameplaySetup.coachImage || sd.gameplaySetup.image;
    if (img) danceAvatar.src = gameImg(img);
    setDancing(true);
    stateBig.textContent = t('danceDo');
    show('pad');
    return;
  }

  // Resultado
  if (sd.recapSetup) {
    setDancing(false);
    const recap = sd.recapSetup.recapData || {};

    // El boton "Continuar" del recap trae su propio comando literal
    pendingContinue = null;
    const cont = visibleItems(sd.mainCarousel).find((i) => /continuar|continue|ok/i.test(i.title || ''));
    if (cont) pendingContinue = actionOf(cont);

    renderScore(recap.songScore || 0, recap.stars);
    show('score');
    return;
  }

  // Menú / carrusel / pausa
  if (sd.mainCarousel) {
    setDancing(false);
    stateBig.textContent = t('menu');
    stateBig.classList.remove('on');
    show('pad');
    return;
  }

  if (!dancing) {
    setDancing(false);
    stateBig.textContent = t('menu');
    show('pad');
  }
}

/* ------------------------------------------------------------------ */
/*  Popups del juego (una sola opcion)                                 */
/* ------------------------------------------------------------------ */
function visibleItems(carousel) {
  const rows = (carousel && carousel.rows) || [];
  return rows
    .flatMap((r) => r.items || [])
    .filter((i) => i && i.isEnabled !== 0 && i.isLocked !== 1);
}

function itemImage(it) {
  return gameImg(it.image || it.icon || '');
}

function actionOf(it) {
  const a = (it.actions || [])[0];
  return a && typeof a.command === 'string' ? a.command : null;
}

function runItem(it) {
  const command = actionOf(it);
  if (!command) return false;
  send({ type: 'action', command });
  if (navigator.vibrate) navigator.vibrate(30);
  return true;
}

function renderPopup(item) {
  setDancing(false);

  const img = itemImage(item);
  const pic = $('popupImg');
  pic.style.display = img ? 'block' : 'none';
  if (img) pic.src = img;

  const title = $('popupTitle');
  title.textContent = '';
  title.style.display = 'none';

  // La tarjeta solo aparece si el juego manda una ilustracion real
  const card = pic.parentElement;
  card.style.display = img ? 'flex' : 'none';

  const box = $('popupButtons');
  box.innerHTML = '';

  const b = document.createElement('button');
  b.className = 'btn-main';
  b.textContent = (item.title || t('pcontinue')).toUpperCase();
  b.addEventListener('click', () => {
    runItem(item);
    show('pad');
  });
  box.appendChild(b);

  show('popup');
}

function setDancing(on) {
  dancing = on;
  document.body.classList.toggle('dancing', on);
  stateBig.classList.toggle('on', on);
  if (on) stateBig.textContent = t('danceDo');
}

/* ------------------------------------------------------------------ */
/*  Coaches                                                            */
/* ------------------------------------------------------------------ */
/** Placa con el nombre del jugador, debajo de los personajes. */
function setLobbyProfile(name, image) {
  const n = String(name || '').trim();
  const label = n && n.indexOf('[icon:') !== 0 ? n : '';
  jdName(lobbyName, label);
  const img = gameImg(image || '');
  if (img) {
    if (lobbyAvatar.getAttribute('src') !== img) lobbyAvatar.src = img;
    lobbyAvatar.style.display = 'block';
  } else {
    lobbyAvatar.removeAttribute('src');
    lobbyAvatar.style.display = 'none';
  }
  coachNameplate.classList.toggle('on', !!label);
}

function selectCoach(i) {
  if (i === selectedCoach) return;
  selectedCoach = i;
  [...coachStage.children].forEach((el, j) => {
    if (el.classList.contains('coach')) el.classList.toggle('sel', j === i);
  });
  if (navigator.vibrate) navigator.vibrate(25);
  cmd('coach', { index: i });
}

/* ------------------------------------------------------------------ */
/*  Figuras de los coaches                                             */
/* ------------------------------------------------------------------ */
/* Los PNG del juego traen margenes transparentes. Se mide el recorte
   real (caja alfa) para que la figura ocupe toda la altura disponible
   y no quede pequeña dentro de un rectangulo. */
function measureFigure(img) {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) return null;

  const full = { x0: 0, y0: 0, x1: nw, y1: nh, nw, nh };

  try {
    const k = Math.min(1, 220 / Math.max(nw, nh));
    const cw = Math.max(1, Math.round(nw * k));
    const ch = Math.max(1, Math.round(nh * k));

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, cw, ch);

    const data = ctx.getImageData(0, 0, cw, ch).data;
    let x0 = cw, y0 = ch, x1 = -1, y1 = -1;

    for (let y = 0; y < ch; y += 1) {
      const row = y * cw * 4;
      for (let x = 0; x < cw; x += 1) {
        if (data[row + x * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }

    if (x1 < x0 || y1 < y0) return full;

    const inv = 1 / k;
    return {
      x0: x0 * inv,
      y0: y0 * inv,
      x1: (x1 + 1) * inv,
      y1: (y1 + 1) * inv,
      nw,
      nh,
    };
  } catch {
    return full;
  }
}

/** Coloca la imagen dentro del boton para que la caja alfa llene width x height. */
function placeFigure(img, box, width, height) {
  const b = box || { x0: 0, y0: 0, x1: img.naturalWidth, y1: img.naturalHeight, nw: img.naturalWidth, nh: img.naturalHeight };
  const bw = Math.max(1, b.x1 - b.x0);
  const bh = Math.max(1, b.y1 - b.y0);
  const s = height / bh;

  img.style.width = Math.round(b.nw * s) + 'px';
  img.style.height = Math.round(b.nh * s) + 'px';
  img.style.left = Math.round(width / 2 - ((b.x0 + b.x1) / 2) * s) + 'px';
  img.style.bottom = Math.round(-(b.nh - b.y1) * s) + 'px';
}

/** Reparte las figuras: altura comun, solapamiento justo y sin salirse del ancho. */
function layoutCoaches() {
  const stage = coachStage;
  const btns = [...stage.querySelectorAll('.coach')];
  if (!btns.length) return;

  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (!sw || !sh) return;

  const imgs = btns.map((b) => b.querySelector('img'));
  const aspects = imgs.map((img) => {
    const b = img && img._bbox;
    if (!b) return 0.5;
    return Math.max(0.18, (b.x1 - b.x0) / Math.max(1, b.y1 - b.y0));
  });

  const avail = Math.max(120, sw - 10);
  const n = btns.length;
  const scales = btns.map((b) => (b.classList.contains('sel') ? 1.12 : 0.76));

  // Altura base: el elegido (x1.12) cabe entero en la pista
  let h = Math.min(sh * 0.88, 460);
  let ov = 0;

  for (let pass = 0; pass < 5; pass += 1) {
    const vis = aspects.map((a, i) => a * h * scales[i]);
    const total = vis.reduce((s, w) => s + w, 0);
    const minVis = Math.min(...vis);
    ov = n > 1 ? Math.min(minVis * 0.16, Math.max(0, (total - avail) / (n - 1))) : 0;

    const used = total - ov * (n - 1);
    if (used <= avail) break;
    h *= Math.max(0.6, avail / used);
  }

  btns.forEach((btn, i) => {
    const w = aspects[i] * h;
    btn.style.width = Math.round(w) + 'px';
    btn.style.height = Math.round(h) + 'px';
    btn.style.setProperty('--ov', i === 0 ? '0px' : Math.round(ov) + 'px');
    if (imgs[i]) placeFigure(imgs[i], imgs[i]._bbox, w, h);
  });
}

function renderCoaches(list) {
  const next = Array.isArray(list) ? list : [];
  const idx = next.findIndex((c) => c && (c.selectedOnEnter === 1 || c.isSelected === 1));
  coaches = next;
  if (idx >= 0) selectedCoach = idx;
  else if (selectedCoach >= coaches.length) selectedCoach = 0;

  const sig = coaches.map((c) => gameImg(c.image || c.imageUrl || c.coachImage)).join('|');
  $('lobbyCount').textContent = coaches.length ? `${coaches.length} coach${coaches.length === 1 ? '' : 's'}` : '';

  // Mismo reparto de coaches: solo se refresca la seleccion (sin reiniciar la animacion)
  if (coaches.length && sig === coachSig) {
    [...coachStage.children].forEach((el, j) => {
      if (el.classList.contains('coach')) el.classList.toggle('sel', j === selectedCoach);
    });
    layoutCoaches();
    return;
  }
  coachSig = sig;

  coachStage.innerHTML = '';
  coachStage.dataset.count = String(Math.min(Math.max(coaches.length, 1), 4));

  if (!coaches.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = t('coachesEmpty');
    coachStage.appendChild(empty);
    return;
  }

  coaches.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'coach' + (i === selectedCoach ? ' sel' : '');
    btn.setAttribute('aria-label', `Coach ${i + 1}`);
    btn.setAttribute('aria-pressed', i === selectedCoach ? 'true' : 'false');

    const fig = document.createElement('div');
    fig.className = 'fig';
    btn.appendChild(fig);

    const img = gameImg(c.image || c.imageUrl || c.coachImage);
    if (img) {
      const el = document.createElement('img');
      el.src = img;
      el.alt = '';
      el.draggable = false;
      fig.appendChild(el);

      const prepare = () => {
        const box = measureFigure(el);
        if (box) el._bbox = box;
        layoutCoaches();
      };
      if (el.complete && el.naturalWidth) prepare();
      else el.addEventListener('load', prepare, { once: true });
      el.addEventListener('error', () => el.remove(), { once: true });
    }

    btn.addEventListener('click', () => selectCoach(i));
    coachStage.appendChild(btn);
  });

  requestAnimationFrame(layoutCoaches);
}

/* ------------------------------------------------------------------ */
/*  Puntaje                                                            */
/* ------------------------------------------------------------------ */
function renderScore(score, realStars) {
  let stars = typeof realStars === 'number' ? realStars : 0;
  const color = '#e9e9ef';
  let rank = 'JUST DANCER';

  if (score >= 12000) { rank = 'MEGASTAR'; }
  else if (score >= 11000) { rank = 'SUPERSTAR'; }
  else if (score >= 10000) { stars = Math.max(stars, 5); }
  else if (score >= 8000) { stars = Math.max(stars, 4); }
  else if (score >= 6000) { stars = Math.max(stars, 3); }
  else if (score >= 4000) { stars = Math.max(stars, 2); }
  else if (score >= 2000) { stars = Math.max(stars, 1); }

  $('scoreVal').textContent = score;
  $('scoreVal').style.color = color;
  $('scoreRank').textContent = rank;
  $('scoreRank').style.color = color;
  $('scoreRank').style.textShadow = 'none';

  const el = $('scoreStars');
  el.innerHTML = '';
  for (let i = 0; i < 5; i += 1) {
    const s = document.createElement('span');
    s.textContent = '★';
    s.style.opacity = i < stars ? '1' : '0.22';
    el.appendChild(s);
  }
  el.style.color = color;
}

/* ------------------------------------------------------------------ */
/*  Acelerómetro                                                       */
/* ------------------------------------------------------------------ */
function onMotion(e) {
  if (!dancing) return;
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;

  // Medidor de movimiento real (dato del propio telefono, no del juego)
  const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  const delta = Math.min(Math.abs(mag - lastMag), 18);
  lastMag = mag;
  moveLevel = moveLevel * 0.82 + (delta / 18) * 0.18;

  const now = performance.now();
  if (now - lastMovePaint > 60) {
    lastMovePaint = now;
    const fill = $('moveFill');
    if (fill) fill.style.width = Math.round(Math.min(moveLevel * 260, 100)) + '%';
  }

  if (now - lastAccel < 8) return;
  lastAccel = now;
  send({ type: 'accel', v: [a.x || 0, a.y || 0, a.z || 0] });
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function cmd(name, payload) {
  send({ type: 'cmd', name, payload });
}

/* ------------------------------------------------------------------ */
/*  UI                                                                 */
/* ------------------------------------------------------------------ */
$('btnConnect').addEventListener('click', connect);
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

$('btnStart').addEventListener('click', async () => {
  readyErr.textContent = '';
  try {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== 'granted') {
        readyErr.textContent = t('sensorDenied');
        return;
      }
    }
  } catch {
    readyErr.textContent = t('sensorAskFail');
  }

  window.addEventListener('devicemotion', onMotion);

  try { await document.documentElement.requestFullscreen(); } catch {}
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}

  show('pad');
  setDancing(false);
  stateBig.textContent = t('menu');

  let got = false;
  const probe = (e) => { if (e.accelerationIncludingGravity) got = true; };
  window.addEventListener('devicemotion', probe);
  setTimeout(() => {
    window.removeEventListener('devicemotion', probe);
    if (!got) {
      stateBig.textContent = t('noSensors');
      stateBig.classList.remove('on');
    }
  }, 2000);
});

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (!wakeLock) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  // Al volver de segundo plano el socket puede haber muerto: se reconecta
  // sin pasar por la pantalla del código.
  if (roomCode && !ws && !connecting && !retrying &&
      (screens.pad.classList.contains('active') ||
       screens.lobby.classList.contains('active') ||
       screens.ready.classList.contains('active'))) {
    reconnectTries = 0;
    startRelay(0);
  }
});

// Al cerrar o cambiar de app se avisa al PC para que quite al jugador ya,
// sin esperar al latido (el móvil puede no cerrar el socket por su cuenta).
window.addEventListener('pagehide', () => {
  const s = ws;
  if (!s) return;
  ws = null;
  s.jdManual = true;
  try { s.send(JSON.stringify({ type: 'bye' })); } catch {}
  try { s.close(1000); } catch {}
});

window.addEventListener('resize', () => {
  if (screens.lobby.classList.contains('active')) layoutCoaches();
});

document.querySelectorAll('[data-cmd]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (navigator.vibrate) navigator.vibrate(18);
    cmd(btn.dataset.cmd);
  });
});

$('btnDance').addEventListener('click', () => {
  if (navigator.vibrate) navigator.vibrate(80);
  cmd('start');
});
$('btnLobbyBack').addEventListener('click', () => cmd('back'));
$('btnHome').addEventListener('click', goHome);
$('btnContinue').addEventListener('click', () => {
  if (pendingContinue) {
    send({ type: 'action', command: pendingContinue });
    pendingContinue = null;
  } else {
    cmd('ok');
  }
});

$('btnPauseMenu').addEventListener('click', () => cmd('pause'));
