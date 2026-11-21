# JD CONTROL - Phone app (PWA)

Installable web version of the phone controller. It runs from a static site
(GitHub Pages) and connects to your PC through its Cloudflare tunnel, so it
works on Android, iPhone and any network without installing an app store
package.

```
PWA (GitHub Pages)  --1. code-->  matchmaking backend (Render)
        |                                   |
        |<---------- 2. tunnel URL ---------+
        |
        +--3. WSS + images-->  PC tunnel  -->  server.js  -->  Legacy.exe
```

The tunnel address changes every time the room opens. You never type it: the
app asks the matchmaking backend for the tunnel that the panel published for
your 5-digit code.

## What you get

- Enter the 5-digit code shown on the JD CONTROL panel.
- It pairs automatically after the fifth digit; there is no extra CONNECT step
  once the code is complete.
- It asks for motion permission inside that tap, as iOS requires.
- It opens the game WebSocket directly against the tunnel and loads the game
  images and avatars from there.
- If the room is not published yet or the backend is waking up, it retries
  instead of failing on the first attempt.
- If the connection drops during a song, it reconnects and keeps the same
  player instead of adding a second one.
- It can be installed on the home screen and opens full screen.

## Install on your phone

1. Open **https://nxx-sudo.github.io/JD-Control/** in Chrome (Android) or
   Safari (iPhone).
2. Open **JD CONTROL** on the PC and press **Open server**. The panel shows the
   room code and a QR.
3. On the phone, type the 5-digit code. The app connects and asks for motion
   access: allow it, otherwise the arrows still work but the game cannot score
   your moves.
4. Optional: use the browser menu and choose **Add to Home screen** / **Install
   app**. The icon then opens the controller directly.

The same page works for every player: each phone that joins takes one player in
the room.

## If the connection fails

- **The code is not found**: the room may still be opening. Wait a few seconds
  and try again; the panel publishes it automatically.
- **The first try is slow**: the free backend can be asleep and takes a moment
  to wake up. The app keeps retrying for a few seconds.
- **The screen turned off or you changed apps**: return to the app. It
  reconnects on its own within a few seconds and restores your player.
- **You closed the app**: open it again and type the code; if you come back
  quickly the same player is reused.
- **Motion does not work**: check that the page uses HTTPS (the GitHub Pages
  address does), allow motion access in the browser settings and reload. On
  iPhone the permission can only be requested by tapping the page.

## URL options

| Parameter | Use |
|---|---|
| `?code=12345` | Pre-fills the code |
| `?backend=https://...` | Uses another matchmaking backend (saved for next time) |
| `?host=https://something.trycloudflare.com` | Skips the backend and uses that tunnel directly (advanced/testing) |

The default backend is `https://jd-remote.onrender.com`.

## Privacy and security

- The backend only stores `code -> tunnel` for a few minutes. The room is
  removed when you close it or when the PC stops publishing it.
- Only `*.trycloudflare.com` tunnels are accepted, and the backend checks that
  the tunnel really answers for that code before publishing it.
- The game traffic, sensors and images go directly between the phone and your
  PC tunnel; they do not pass through the backend.
- There are no accounts, tokens or personal data in the app.

## Notes

- **iPhone/iPad**: motion permission is requested the first time you connect.
  If you deny it, the app explains how to enable it again.
- **Screen lock**: the app asks the browser to keep the screen awake, but the
  browser may ignore it. Keeping the app in the foreground gives the best
  result.
- **HTTPS**: motion sensors and installability require a secure origin. GitHub
  Pages and the tunnel already are; a plain local IP is not.
- **Offline**: the interface is cached so it opens without a connection, but
  joining a room still needs the PC online.

## Credits

- Typeface RBNo2.1 Black (DEMO), see `fonts/LICENSE-RBNo2.1.txt`.
- Icons are based on the JD CONTROL icon.
- GNU GPL v3, same as the rest of JD CONTROL.
