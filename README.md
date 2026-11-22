<h1 align="center">JD CONTROL</h1>

<p align="center">
  <a href="https://github.com/nxx-sudo/JD-Control/releases"><img alt="version" src="https://img.shields.io/badge/version-0.2%20BETA-blue"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  <a href="https://github.com/nxx-sudo/JD-Control/releases"><img alt="downloads" src="https://img.shields.io/github/downloads/nxx-sudo/JD-Control/total"></a>
  <a href="https://discord.gg/Bd2JGhfmFJ"><img alt="discord" src="https://img.shields.io/badge/discord-join-5865F2"></a>
</p>

<p align="center">
  Phone controller for <b>Just Dance Legacy</b> on PC: local room, multiplayer across PCs and a public tunnel to play from any network.
</p>

---

## What it is

JD CONTROL is a desktop mod that opens a **local room** on your PC and turns phones into controllers (arrows, OK, pause and the accelerometer for scoring). It does not patch the game: it talks to it through the interface `Legacy.exe` already exposes.

- **Several phones** at once, each one with its own player.
- **Room across PCs**: one PC hosts the room and the others join with the code.
- **Any network**: a `cloudflared` tunnel publishes your PC over HTTPS, so a phone on mobile data connects without opening ports.
- **3 languages**: English, Español and Portuguese (Brazil), on the panel and on the phone.

## Screenshots

| Room closed | Room created (online active) |
| :--: | :--: |
| <img src="docs/panel-closed.png" width="320"> | <img src="docs/panel-room.png" width="320"> |

| Joining a room from the PC | Settings |
| :--: | :--: |
| <img src="docs/panel-join.png" width="320"> | <img src="docs/panel-settings.png" width="320"> |

| Phone: code | Phone: ready to play |
| :--: | :--: |
| <img src="docs/mobile-code.png" width="240"> | <img src="docs/mobile-ready.png" width="240"> |

## How it works

```
  Phone (browser)               PC running JD CONTROL              Game
  ───────────────               ─────────────────────              ────
  /m  ─── HTTPS/WSS ───►  server.js  ─── local HTTP ───►  Legacy.exe
                                │
                                ├── .NET panel (JD CONTROL.exe): QR, code, players
                                ├── online room (/ws/online): other PCs with JD CONTROL
                                └── cloudflared tunnel: public URL https://…trycloudflare.com
```

1. `JD CONTROL.exe` starts `server.js` (Node) if it is not running yet.
2. The server creates the local certificate, serves the phone page (`/m`) and opens the public tunnel.
3. The panel shows the **5-digit code** and the **QR** with the link, already pointing at the room.
4. The phone opens the link, types the code, enables the sensors and sends the presses to the server; the server forwards them to the game.

All the state (player, song, phase, score) lives on the PC: the phone is only a controller.

## Requirements

- Windows 10/11.
- **Just Dance Legacy** installed on the PC.

That is all: JD CONTROL finds the running game on its own and connects to it, so you never type an address or a port. The zip also ships Node portable, so you do not need to install anything else.

To build from source you do need .NET Framework 4.x (`csc.exe`) and Node.js 18+.

## Install

1. Download the zip from [Releases](https://github.com/nxx-sudo/JD-Control/releases) and extract it **whole** (the `.exe` is only the window; the server lives in the folder).
2. Run `JD CONTROL.exe` from that folder.
3. The first time it downloads `cloudflared.exe` if it is missing (the tunnel needs it).

## Usage

### 1. Open the room

<img src="docs/step-open-server.png" width="320">

Press **Open server**. The panel switches to `room created: online active` (in green) and shows the code and the QR.

### 2. Connect your phone

<img src="docs/step-connect.png" width="240"> <img src="docs/step-enable-sensors.png" width="240">

Scan the QR with the phone camera or open the link. Type the 5-digit code, press **CONNECT** and then **ENABLE SENSORS**. The phone page follows the phone language (English, Spanish or Portuguese). The accelerometer only works over HTTPS, and the tunnel link already is.

### 3. Several phones

The same QR works for everyone: each phone that joins takes one player. They show up under **PLAYERS IN ROOM** with their state (`In the game`, `Dancing`, …).

A phone keeps the same player if it reconnects. If it leaves the room, the panel removes it right away; if the same phone comes back within 45 seconds, it takes its old player again instead of creating a duplicate.

### 4. Phones together with Kinect or a controller

JD CONTROL only adds phone controllers; it does not open, block or replace the Kinect or the controllers. The game, however, chooses **one scoring mode** in the "How do you prefer to play?" screen:

- **Kinect / Legacy Sensor mode**: the Kinect scores. A phone can still join and move through the menus, but the game does not ask it for accelerometer data, so it does not score. Keep this in mind before mixing both.
- **Mobile device mode**: phones are the dancers and score normally. Use this for local or online rooms with several players.
- **Motion controllers**: DualShock/DualSense, Joy-Con, Wiimote and PS Move are detected as dancing devices. A standard Xbox-style gamepad usually only moves through the menus and does not score.

So the reliable setup is one phone (or the installable app) per player in **Mobile device** mode. Kinect can stay connected, but it will not add a second scoring dancer while the phone mode is selected. A mixed room where Kinect and phones score at the same time is not supported by the game itself.

### 5. Close the room

Press **Close server**: the room closes, the tunnel stops and the phones disconnect. The panel goes back to `LOCAL ROOM`.

### 6. Join a room from another PC

<img src="docs/step-join.png" width="320">

On the other PC: **Join room** → type the host IP (`192.168.1.20`) **or** its tunnel URL (`https://something.trycloudflare.com`) and the code.

- Same network: the IP is enough, or leave it empty (the room is found by code).
- Another network: paste the tunnel URL; you can paste the full QR link, only the domain is kept.

Each PC keeps using its own `Legacy.exe` and its own phones; the room syncs the song and the phase.

### 7. Play from another network

The tunnel opens together with the room. The `https://…trycloudflare.com` URL changes on every start: always use the QR on the panel.

### 8. Phone without the QR (PWA)

The phone controller also ships as an installable web app:

**https://nxx-sudo.github.io/JD-Control/**

Open it, type the 5-digit code and it pairs itself with the current tunnel: because that URL changes on every start, the app asks a small matchmaking backend for the address. Add it to the home screen to open it full screen. It works on Android and iOS; on iOS the motion permission is requested when you connect, and if you deny it the app still lets you enable the sensors by hand.

If the app was closed, the screen turned off or the connection dropped, it retries on its own and keeps your player for 45 seconds before giving up. The panel removes the phone as soon as it disconnects, so the list always shows who is really there.

While the room is open the PC publishes it every 45 s (and unpublishes it when you close it). Nothing else goes through that backend: the sensors talk directly to your tunnel.


## Settings

<img src="docs/panel-settings.png" width="320">

The settings button (sliders icon, top right) opens:

- **Language**: English, Español, Portuguese (Brazil). It detects the Windows language; anything other than Spanish or Portuguese starts in English.
- **Show available updates**: checks the releases of this repository when the panel opens and warns at the bottom if there is a newer version.
- **Send logs for analysis and bug fixes**: off by default. Uploads `server.log`, `ghost.log`, `score.log`, `panel.log` and `ui.jsonl` to the developer's Discord through a webhook. It sends once when you enable it and once on every start while it stays enabled. No video or audio is sent.

<img src="docs/panel-update.png" width="320">

If there is a newer version, the notice appears under the buttons and opens the download page when clicked. With the same version published nothing is shown.

It is stored in `settings.json`, next to the executable.

The Discord webhook is **not** in the code or the repository: open `webhook.txt` (next to the executable) with Notepad and paste the full `https://discord.com/api/webhooks/...` URL on its own line. Lines starting with `#` are comments. Without a URL nothing is sent and the option shows "Webhook not configured". If you share the ZIP with the webhook filled in, anyone who downloads it can read the URL: use a private channel and rotate the webhook if it starts receiving spam.

## Build

```bat
build.bat
```

Produces `JD CONTROL.exe` with `csc.exe`. For the distributable folder (with portable Node, dependencies and zip):

```bat
package.bat
```

## Structure

```
app/                 native C# panel (MainForm.cs, Lang.cs, AssemblyInfo.cs)
server.js            server: phone page, online room, tunnel and room publishing
src/                 bridge to the game (gamephone.js) and remote tunnel
public/              page the phone loads (mobile.html, mobile.js, fonts)
pwa/                 same controller as an installable web app (GitHub Pages)
remote/              matchmaking backend: code -> current tunnel (Go / Node)
build.bat            compiles the exe
package.bat          builds dist/ ready to share
```

## License

[GNU GPL v3](LICENSE). You can use, modify and redistribute it as long as it stays open source.

