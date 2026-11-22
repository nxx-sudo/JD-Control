'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POLL_MS = 1000;
const PNP_EVERY = 8;
const EMIT_EVERY = 10;
const RESTART_MS = 5000;

const IS_WIN = process.platform === 'win32';
const OFF = process.env.JD_NO_DEVICES === '1';

const state = {
  started: false,
  ok: false,
  error: null,
  at: 0,
  devices: [],
  raw: null,
};

let child = null;
let buffer = '';
let restartTimer = null;
let stopped = false;
const listeners = new Set();

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class JdDev
{
    [StructLayout(LayoutKind.Sequential)]
    public struct XInputGamepad {
        public ushort wButtons;
        public byte bLeftTrigger;
        public byte bRightTrigger;
        public short sThumbLX;
        public short sThumbLY;
        public short sThumbRX;
        public short sThumbRY;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct XInputState {
        public uint dwPacketNumber;
        public XInputGamepad Gamepad;
    }

    [DllImport("xinput1_4.dll", EntryPoint = "XInputGetState")]
    private static extern uint XInput14(uint index, ref XInputState state);

    [DllImport("xinput9_1_0.dll", EntryPoint = "XInputGetState")]
    private static extern uint XInput910(uint index, ref XInputState state);

    public static uint Connected(uint index)
    {
        try {
            XInputState s = new XInputState();
            return XInput14(index, ref s);
        } catch {
            try {
                XInputState s = new XInputState();
                return XInput910(index, ref s);
            } catch { return 1167; }
        }
    }

    [DllImport("winmm.dll")]
    public static extern uint joyGetNumDevs();

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct JoyCaps
    {
        public ushort wMid;
        public ushort wPid;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szPname;
        public uint wXmin, wXmax, wYmin, wYmax, wZmin, wZmax;
        public uint wNumButtons, wPeriodMin, wPeriodMax;
        public uint wRmin, wRmax, wUmin, wUmax, wVmin, wVmax;
        public uint wCaps, wMaxAxes, wNumAxes, wMaxButtons, wNumButtons2;
    }

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    public static extern uint joyGetDevCapsW(IntPtr id, ref JoyCaps caps, uint cb);
}
'@

$pnpClasses = @('HIDClass', 'XnaComposite', 'Camera', 'Image', 'MEDIA', 'Kinect')

function Get-XInputIndexes {
    $hit = @()
    for ($i = 0; $i -lt 4; $i++) {
        $code = [JdDev]::Connected([uint32]$i)
        if ($code -eq 0) { $hit += $i }
    }
    return ,$hit
}

function Get-DirectInputPads {
    $hit = @()
    $n = [JdDev]::joyGetNumDevs()
    for ($i = 0; $i -lt $n; $i++) {
        $caps = New-Object JdDev+JoyCaps
        $size = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($caps)
        $ptr = [IntPtr]::new([int64]$i)
        $r = [JdDev]::joyGetDevCapsW($ptr, [ref]$caps, $size)
        if ($r -eq 0) {
            $hit += [pscustomobject]@{ index = $i; name = "$($caps.szPname)"; axes = [int]$caps.wNumAxes; buttons = [int]$caps.wNumButtons }
        }
    }
    return ,$hit
}

function Get-PnpDevices {
    $hit = @()
    foreach ($cls in $pnpClasses) {
        Get-PnpDevice -PresentOnly -Class $cls -ErrorAction SilentlyContinue | ForEach-Object {
            $hit += [pscustomobject]@{
                class = "$($_.Class)"
                name  = "$($_.FriendlyName)"
                id    = "$($_.InstanceId)"
                state = "$($_.Status)"
            }
        }
    }
    return ,$hit
}

$pnp = @()
$round = 0
$last = ''

while ($true) {
    $xinput = Get-XInputIndexes
    $direct = Get-DirectInputPads

    if (($round % ${PNP_EVERY}) -eq 0) { $pnp = Get-PnpDevices }

    $payload = [pscustomobject]@{
        at     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        xinput = @($xinput)
        direct = @($direct)
        pnp    = @($pnp)
    }

    $json = $payload | ConvertTo-Json -Compress -Depth 6
    if ($json -ne $last -or ($round % ${EMIT_EVERY}) -eq 0) {
        Write-Output $json
        [Console]::Out.Flush()
        $last = $json
    }

    $round++
    Start-Sleep -Milliseconds ${POLL_MS}
}
`;

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function kindFromName(name, cls) {
  const n = String(name || '');
  if (/kinect/i.test(n)) return 'kinect';
  if (/joy[-\s]?con/i.test(n)) return 'joycon';
  if (/wiimote|wii\s*remote|RVL-CNT|nintendo/i.test(n)) return 'wiimote';
  if (/ps\s*move|motion\s*controller/i.test(n)) return 'psmove';
  if (/dualshock|dualsense|wireless controller|ps4|ps5/i.test(n)) return 'ds4';
  if (/xbox|gamepad|controller|joystick/i.test(n)) return 'pad';
  if (/camera|webcam|capture|video/i.test(n)) return 'camera';
  if (String(cls).toLowerCase() === 'camera' || String(cls).toLowerCase() === 'image') return 'camera';
  return null;
}

function canDance(kind) {
  return kind === 'kinect' || kind === 'joycon' || kind === 'wiimote' ||
    kind === 'psmove' || kind === 'ds4' || kind === 'camera' || kind === 'phone';
}

function label(kind) {
  switch (kind) {
    case 'pad': return 'Mando';
    case 'joycon': return 'Joy-Con';
    case 'wiimote': return 'Wiimote';
    case 'psmove': return 'PS Move';
    case 'ds4': return 'DualShock';
    case 'kinect': return 'Kinect';
    case 'camera': return 'Camara';
    default: return 'Dispositivo';
  }
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return [];

  const xinput = asArray(raw.xinput).map(Number).filter(Number.isInteger);
  const direct = asArray(raw.direct).filter((d) => d && typeof d === 'object');
  const pnp = asArray(raw.pnp).filter((d) => d && typeof d === 'object');

  const list = [];
  const seen = new Set();

  const directNames = direct.map((d) => String(d.name || '')).filter(Boolean);
  const pnpPad = pnp.filter((d) => {
    const k = kindFromName(d.name, d.class);
    return k === 'pad' || k === 'ds4';
  });

  xinput.forEach((idx, i) => {
    const name = directNames[i] || (pnpPad[i] && String(pnpPad[i].name)) || 'Mando Xbox';
    const kind = kindFromName(name) === 'ds4' ? 'ds4' : 'pad';
    const id = 'xinput:' + idx;
    if (seen.has(id)) return;
    seen.add(id);
    list.push({
      id,
      kind,
      label: label(kind),
      name,
      bus: 'xinput',
      index: idx,
      dance: canDance(kind),
      note: kind === 'pad' ? 'Solo menus' : null,
    });
  });

  const remaining = new Map();
  for (const d of list) remaining.set(d.name, (remaining.get(d.name) || 0) + 1);

  direct.forEach((d, i) => {
    const name = String(d.name || '');
    if (!name) return;
    const pending = remaining.get(name) || 0;
    if (pending > 0) { remaining.set(name, pending - 1); return; }
    const kind = kindFromName(name) || 'pad';
    const id = 'direct:' + i;
    if (seen.has(id)) return;
    seen.add(id);
    list.push({
      id,
      kind,
      label: label(kind),
      name,
      bus: 'directinput',
      index: Number(d.index) || i,
      dance: canDance(kind),
      note: kind === 'pad' ? 'Solo menus' : null,
    });
  });

  for (const d of pnp) {
    const name = String(d.name || '');
    const kind = kindFromName(name, d.class);
    if (!kind) continue;

    if (kind === 'pad') continue;
    if (kind === 'ds4' && String(d.class).toLowerCase() !== 'hidclass') continue;

    const iid = String(d.id || name);
    const id = kind + ':' + iid;
    if (seen.has(id)) continue;

    const already = list.find((x) => x.kind === kind && kind === 'kinect');
    if (already) continue;

    seen.add(id);
    list.push({
      id,
      kind,
      label: label(kind),
      name,
      bus: 'pnp',
      index: null,
      dance: canDance(kind),
      note: kind === 'camera' ? 'Camara del juego' : null,
    });
  }

  return list;
}

function scriptPath() {
  const dir = path.join(__dirname, '..', 'cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const file = path.join(dir, 'devices.ps1');
  try {
    const prev = fs.readFileSync(file, 'utf8');
    if (prev !== PS_SCRIPT) fs.writeFileSync(file, PS_SCRIPT, 'utf8');
  } catch {
    try { fs.writeFileSync(file, PS_SCRIPT, 'utf8'); } catch {}
  }
  return file;
}

function emit() {
  const snapshot = snapshotState();
  for (const fn of listeners) {
    try { fn(snapshot); } catch {}
  }
}

function apply(raw) {
  const devices = normalize(raw);

  const before = state.devices.map((d) => d.id).sort().join('|');
  const after = devices.map((d) => d.id).sort().join('|');

  state.raw = raw;
  state.devices = devices;
  state.at = Number(raw.at) || Date.now();
  state.ok = true;
  state.error = null;

  if (before !== after) emit();
}

function start() {
  if (state.started || stopped) return;
  state.started = true;

  if (!IS_WIN) {
    state.ok = true;
    state.error = 'Solo Windows';
    return;
  }
  if (OFF) {
    state.ok = true;
    state.error = 'Desactivado';
    return;
  }

  launch();
}

function launch() {
  if (stopped) return;

  let file;
  try {
    file = scriptPath();
  } catch (err) {
    state.error = 'No se pudo escribir el sondeo: ' + err.message;
    return;
  }

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', file,
  ];

  let proc;
  try {
    proc = spawn('powershell.exe', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    state.error = 'No se pudo lanzar PowerShell: ' + err.message;
    scheduleRestart();
    return;
  }

  child = proc;
  buffer = '';

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line[0] !== '{') continue;
      let raw;
      try { raw = JSON.parse(line); } catch { continue; }
      apply(raw);
    }
    if (buffer.length > 4 * 1024 * 1024) buffer = '';
  });

  proc.on('error', (err) => {
    state.error = err.message;
  });

  proc.on('exit', () => {
    child = null;
    if (stopped) return;
    state.error = 'El sondeo se detuvo; reintentando.';
    scheduleRestart();
  });
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    launch();
  }, RESTART_MS);
  if (restartTimer.unref) restartTimer.unref();
}

function stop() {
  stopped = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  if (child) {
    try { child.kill(); } catch {}
    child = null;
  }
}

function snapshotState() {
  return {
    ok: state.ok,
    error: state.error,
    at: state.at || null,
    devices: state.devices.map((d) => ({ ...d })),
  };
}

function list() {
  return state.devices.map((d) => ({ ...d }));
}

function summary() {
  const devices = list();
  return {
    at: state.at || null,
    ok: state.ok,
    error: state.error,
    total: devices.length,
    dance: devices.filter((d) => d.dance).length,
    devices,
  };
}

function onChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { start, stop, list, summary, onChange, snapshotState, normalize };
