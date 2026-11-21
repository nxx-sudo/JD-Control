'use strict';

/**
 * Un "GamePhone" emula a la app oficial de Just Dance contra Legacy.exe.
 *
 * Protocolo (v1):
 *   ws://127.0.0.1:8080/smartphone   subprotocolo v1.phonescoring.jd.ubisoft.com
 *   -> JD_PhoneDataCmdHandshakeHello { accelAcquisitionFreqHz, accelAcquisitionLatency, accelMaxRange }
 *   <- JD_PhoneDataCmdHandshakeContinue { phoneID }
 *   -> JD_PhoneDataCmdSync { phoneID }
 *   <- JD_PhoneDataCmdSyncEnd { phoneID }
 *   -> JD_PhoneDataCmdSyncEnd { phoneID }
 *   <- JD_EnableAccelValuesSending_ConsoleCommandData   (empieza el baile)
 *   -> JD_PhoneScoringData { accelData: [[x,y,z],...], timeStamp }
 */

const EventEmitter = require('events');

const GAME_URL = process.env.JD_GAME_URL || 'ws://127.0.0.1:8080/smartphone';
const SUBPROTOCOL = 'v1.phonescoring.jd.ubisoft.com';
const FLUSH_MS = 15;
const MAX_PER_MESSAGE = 10;

// Comandos de entrada (identificadores del protocolo)
const INPUT = {
  up: 3690595578,
  right: 1099935642,
  down: 2467711647,
  left: 3652315484,
  ok: 1084313942,
};

/** La imagen del lobby identifica el mapa, no la posicion del carrusel. */
function songImageKey(image, type) {
  const file = String(image || '').split('?')[0].split('/').pop().toLowerCase();
  const suffix = type === 'cover'
    ? /_cover(?:_phone)?\.[a-z0-9]+$/
    : /_coach_\d+(?:_phone)?\.[a-z0-9]+$/;
  return suffix.test(file) ? file.replace(suffix, '') : null;
}

class GamePhone extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.ws = null;
    this.connected = false;
    this.sending = false;
    this.inputAllowed = false;
    this.name = null;
    this.avatar = null;
    this.song = null;
    this.catalogSongs = new Map();
    this.lobby = false;
    this.timeStamp = 0;
    this.buffer = [];
    this.samplesSent = 0;
    this.lastError = null;
    this.closed = false;
    this._retry = null;
    this._timer = null;
  }

  start() {
    this._connect();
    this._timer = setInterval(() => this._flush(), FLUSH_MS);
  }

  stop() {
    this.closed = true;
    clearInterval(this._timer);
    clearTimeout(this._retry);
    this._closeSocket();
  }

  state() {
    return {
      id: this.id,
      name: this.name,
      avatar: this.avatar,
      song: this.song,
      lobby: this.lobby,
      connected: this.connected,
      sending: this.sending,
      inputAllowed: this.inputAllowed,
      samples: this.samplesSent,
      error: this.lastError,
    };
  }

  _emitState() {
    this.emit('state', this.state());
  }

  _closeSocket() {
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
    this.connected = false;
    this.sending = false;
    this.inputAllowed = false;
    this.lobby = false;
  }

  _connect() {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(GAME_URL, [SUBPROTOCOL]);
    } catch (err) {
      this.lastError = err.message;
      this._scheduleRetry();
      return;
    }

    this.ws = ws;
    this.lastError = null;

    ws.addEventListener('open', () => {
      this.connected = true;
      this._emitState();
      this._send('JD_PhoneDataCmdHandshakeHello', {
        accelAcquisitionFreqHz: 200.0,
        accelAcquisitionLatency: 0.0,
        accelMaxRange: 8.0,
      });
    });

    ws.addEventListener('message', (ev) => this._onMessage(ev.data));

    ws.addEventListener('error', () => {
      this.lastError = 'no se pudo conectar al juego (¿está abierto?)';
    });

    ws.addEventListener('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.sending = false;
      this.inputAllowed = false;
      this.lobby = false;
      this.buffer = [];
      this.ws = null;
      if (wasConnected) this._emitState();
      this._scheduleRetry();
    });
  }

  _scheduleRetry() {
    if (this.closed) return;
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this._connect(), 1500);
  }

  _send(cls, data = {}) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify({ root: { __class: cls, ...data } }));
      return true;
    } catch {
      return false;
    }
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    const cls = msg.__class;
    if (!cls) return;

    switch (cls) {
      case 'JD_PhoneDataCmdHandshakeContinue':
        this._send('JD_PhoneDataCmdSync', { phoneID: msg.phoneID });
        break;

      case 'JD_PhoneDataCmdSyncEnd':
        this._send('JD_PhoneDataCmdSyncEnd', { phoneID: msg.phoneID });
        this.emit('ready', this.id);
        break;

      case 'JD_EnableAccelValuesSending_ConsoleCommandData':
        this.sending = true;
        this.lobby = false;
        this.timeStamp = 0;
        this.buffer = [];
        this._emitState();
        break;

      case 'JD_DisableAccelValuesSending_ConsoleCommandData':
        this.sending = false;
        this.lobby = false;
        this.buffer = [];
        this._emitState();
        break;

      // --- Permisos de entrada ---
      case 'InputSetup_ConsoleCommandData':
      case 'EnableCarousel_ConsoleCommandData':
      case 'ShortcutSetup_ConsoleCommandData':
      case 'JD_EnableLobbyStartbutton_ConsoleCommandData':
        this.inputAllowed = msg.isEnabled === 1;
        this._emitState();
        break;

      case 'JD_PhoneUiSetupData': {
        const before = this.name + '|' + this.song + '|' + this.lobby + '|' + this.inputAllowed;

        if (msg.isPopup === 1) {
          this.inputAllowed = true;
        } else {
          this.inputAllowed = !!(msg.inputSetup && msg.inputSetup.isEnabled === 1);
        }

        const sd = msg.setupData || {};

        // El nombre real del perfil viene en el lobby
        if (sd.lobbySetup && sd.lobbySetup.changeProfile) {
          const nm = String(sd.lobbySetup.changeProfile.title || '').trim();
          if (nm && nm.indexOf('[icon:') !== 0) this.name = nm;
        }

        if (sd.lobbySetup) {
          this.lobby = true;
          const coaches = sd.lobbySetup.coaches || sd.lobbySetup.lobbyData || [];
          this.song = (Array.isArray(coaches) ? coaches : [])
            .map((c) => this.catalogSongs.get(songImageKey(c && c.image, 'coach')))
            .find(Boolean) || null;
        } else if (sd.recapSetup) {
          this.lobby = false;
        } else if (sd.mainCarousel && msg.isPopup !== 1) {
          this.lobby = false;
          this.song = null;
          for (const row of sd.mainCarousel.rows || []) {
            for (const item of row.items || []) {
              const key = songImageKey(item && (item.image || item.icon), 'cover');
              const title = String((item && item.title) || '').trim();
              if (key && title && title.indexOf('[icon:') !== 0)
                this.catalogSongs.set(key, title);
            }
          }
        }

        if (before !== this.name + '|' + this.song + '|' +
            this.lobby + '|' + this.inputAllowed) this._emitState();
        break;
      }

      case 'JD_PhoneUiShortcutData': {
        const list = (msg.shortcuts || [])
          .filter((s) => s && s.__class === 'JD_PhoneAction_Shortcut')
          .map((s) => s.shortcutType);
        this.shortcuts = list;
        this._emitState();
        break;
      }

      case 'JD_ProfilePhoneUiData': {
        const changed = (msg.name && msg.name !== this.name) || (msg.image && msg.image !== this.avatar);
        if (msg.name) this.name = msg.name;
        if (msg.image) this.avatar = msg.image;
        if (changed) this._emitState();
        break;
      }

      default:
        break;
    }

    // El movil tambien quiere enterarse de lo que pasa en el juego
    this.emit('game', msg);
  }

  /** Muestra de acelerometro ya normalizada a G y con los ejes del juego. */
  pushAccel(x, y, z) {
    if (!this.sending) return;
    this.buffer.push([x / 9.8, z / 9.8, y / 9.8]);
  }

  _flush() {
    if (!this.sending || this.buffer.length === 0) return;
    let guard = 0;
    while (this.buffer.length > 0 && guard < 8) {
      const chunk = this.buffer.splice(0, MAX_PER_MESSAGE);
      this._send('JD_PhoneScoringData', { accelData: chunk, timeStamp: this.timeStamp });
      this.timeStamp += chunk.length;
      this.samplesSent += chunk.length;
      guard += 1;
    }
  }

  /** Comando literal que el propio juego pone dentro de un item/shortcut. */
  sendRawAction(command) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return false;

    let obj;
    try {
      obj = typeof command === 'string' ? JSON.parse(command) : command;
    } catch {
      return false;
    }
    if (!obj || !obj.root || !obj.root.__class) return false;

    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  /** Comandos desde el movil: ok, back, up, down, left, right, pause, coach */
  command(name, payload = {}) {
    if (!this.connected) return false;

    if (this.sending) {
      // Durante el baile solo tiene sentido la pausa
      if (name !== 'pause') return false;
      return this._send('JD_Pause_PhoneCommandData');
    }

    if (!this.inputAllowed) return false;

    if (name === 'pause') return this._send('JD_Pause_PhoneCommandData');
    if (name === 'back') return this._send('JD_Custom_PhoneCommandData', { identifier: 'SHORTCUT_BACK' });
    if (name === 'coach') return this._send('JD_ChangeCoach_PhoneCommandData', { coachId: payload.index || 0 });
    if (name === 'start') return this._send('JD_StartGame_PhoneCommandData');
    if (INPUT[name] !== undefined) return this._send('JD_Input_PhoneCommandData', { input: INPUT[name] });
    return false;
  }
}

module.exports = { GamePhone, INPUT };
