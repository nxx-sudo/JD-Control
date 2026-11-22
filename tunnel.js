'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const DIR = __dirname;
const BIN = path.join(DIR, 'cloudflared.exe');
const STATE = path.join(DIR, 'cache', 'tunnel.json');
const PORT = Number(process.env.JD_HTTP_PORT || 8081);
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const DOWNLOAD = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

function log(msg) {
  console.log(msg);
}

function download(url, dest, redirects, done) {
  if (redirects > 5) {
    done(new Error('demasiadas redirecciones'));
    return;
  }

  https.get(url, { headers: { 'User-Agent': 'jd-control' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      download(res.headers.location, dest, redirects + 1, done);
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      done(new Error('HTTP ' + res.statusCode));
      return;
    }

    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    let size = 0;
    res.on('data', (c) => { size += c.length; });
    res.pipe(out);
    out.on('finish', () => {
      out.close(() => {
        try {
          fs.renameSync(tmp, dest);
          log(`  cloudflared descargado (${Math.round(size / 1048576)} MB)`);
          done(null);
        } catch (e) {
          done(e);
        }
      });
    });
    out.on('error', done);
  }).on('error', done);
}

function ensureBinary(done) {
  if (fs.existsSync(BIN)) {
    done(null);
    return;
  }
  log('  Descargando cloudflared (solo la primera vez)...');
  download(DOWNLOAD, BIN, 0, done);
}

function clearState() {
  try { fs.unlinkSync(STATE); } catch {}
}

function start() {
  const args = ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'];
  const proc = spawn(BIN, args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });

  let published = false;

  const onData = (buf) => {
    const text = buf.toString();
    process.stdout.write(text);

    if (published) return;
    const m = text.match(URL_RE);
    if (!m) return;

    published = true;
    try {
      fs.mkdirSync(path.dirname(STATE), { recursive: true });
      fs.writeFileSync(STATE, JSON.stringify({ url: m[0], pid: proc.pid, at: Date.now() }, null, 2));
    } catch {}

    log('');
    log('  ==========================================');
    log('   TUNEL LISTO (deja esta ventana abierta)');
    log('   ' + m[0] + '/m');
    log('   El panel ya muestra el QR con esta URL.');
    log('  ==========================================');
    log('');
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  const bye = () => {
    clearState();
    log('  Tunel cerrado.');
  };

  proc.on('exit', (code) => {
    bye();
    process.exit(code || 0);
  });
  proc.on('error', (e) => {
    bye();
    console.error('  No se pudo lanzar cloudflared: ' + e.message);
    process.exit(1);
  });

  process.on('SIGINT', () => { try { proc.kill(); } catch {} });
  process.on('SIGTERM', () => { try { proc.kill(); } catch {} });
}

try {
  const prev = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  if (prev && prev.pid) {
    process.kill(prev.pid, 0);
    console.log('  Ya hay un tunel abierto: ' + prev.url + '/m');
    console.log('  Cierra esa ventana para abrir otro.');
    process.exit(0);
  }
} catch {}

clearState();

ensureBinary((err) => {
  if (err) {
    console.error('  No se pudo preparar cloudflared: ' + err.message);
    console.error('  Descargalo a mano: ' + DOWNLOAD);
    process.exit(1);
  }
  start();
});
