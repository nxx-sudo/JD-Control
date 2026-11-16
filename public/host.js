'use strict';

const modal1 = document.getElementById('modal1');
const modal2 = document.getElementById('modal2');
const openMainBtn = document.getElementById('openMainBtn');
const btnOffline = document.getElementById('btnOffline');
const btnOnline = document.getElementById('btnOnline');
const btnOcultar = document.getElementById('btnOcultar');
const showCodeBtn = document.getElementById('showCodeBtn');
const codigoContainer = document.getElementById('codigoContainer');
const qrImg = document.getElementById('qrImg');
const urlText = document.getElementById('urlText');
const remoteText = document.getElementById('remoteText');
const gameDot = document.getElementById('gameDot');
const gameText = document.getElementById('gameText');
const playersDot = document.getElementById('playersDot');
const playersText = document.getElementById('playersText');
const playersList = document.getElementById('playersList');

let ws = null;
let lastQrUrl = '';

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/host`);

  ws.addEventListener('open', () => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'state?' }));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'state') render(msg.state);
  });

  ws.addEventListener('close', () => setTimeout(connect, 1500));
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function render(state) {
  const phones = state.phones || [];
  const connected = phones.filter((p) => p.connected);
  const playing = phones.filter((p) => p.sending);

  gameDot.className = 'dot' + (connected.length ? ' on' : '');
  gameText.textContent = connected.length
    ? `Juego: ${connected.length} móvil(es) enganchado(s)`
    : 'Juego: esperando conexión… (¿está abierto Legacy.exe?)';

  playersDot.className = 'dot' + (phones.length ? (playing.length ? ' on' : ' warn') : '');
  playersText.textContent = `Jugadores conectados: ${phones.length}`;

  playersList.innerHTML = '';
  phones.forEach((p, i) => {
    const chip = document.createElement('span');
    chip.className = 'player-chip' + (p.sending ? ' playing' : '');
    const estado = p.sending ? 'bailando' : p.connected ? 'en el menú' : 'conectando…';
    chip.textContent = `Jugador ${i + 1} · ${estado}`;
    playersList.appendChild(chip);
  });

  if (remoteText) {
    if (state.remote && state.remote.url) {
      remoteText.textContent = `Remoto: ${state.remote.url}/m`;
      remoteText.style.display = 'block';
    } else {
      remoteText.style.display = 'none';
    }
  }

  if (state.code) {
    codigoContainer.textContent = state.code;
    urlText.textContent = state.url;
    if (state.url !== lastQrUrl) {
      lastQrUrl = state.url;
      qrImg.src = `/api/qr?text=${encodeURIComponent(state.url)}`;
    }
    showCodeBtn.classList.remove('hidden');
  } else {
    codigoContainer.textContent = '-----';
    showCodeBtn.classList.add('hidden');
  }
}

openMainBtn.addEventListener('click', () => {
  modal1.classList.add('open');
});

btnOffline.addEventListener('click', () => {
  modal1.classList.remove('open');
  modal2.classList.remove('open');
  send({ type: 'close-room' });
});

btnOnline.addEventListener('click', () => {
  modal1.classList.remove('open');
  send({ type: 'create-room' });
  modal2.classList.add('open');
});

btnOcultar.addEventListener('click', () => {
  modal2.classList.remove('open');
});

showCodeBtn.addEventListener('click', () => {
  modal2.classList.add('open');
});

connect();
