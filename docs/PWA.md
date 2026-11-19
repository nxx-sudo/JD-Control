# JD CONTROL - PWA del móvil

Versión web instalable del controlador. Se sirve como sitio estático (GitHub
Pages) y se conecta al PC por el túnel de Cloudflare, así que funciona en
Android, iPhone y en cualquier red sin instalar nada.

```
PWA (GitHub Pages)  --1. código-->  backend de emparejamiento (Render)
        |                                   |
        |<---------- 2. URL del túnel -------+
        |
        +--3. WSS + imágenes-->  túnel del PC  -->  server.js  -->  Legacy.exe
```

La URL del túnel cambia en cada sesión. La PWA nunca la escribe el usuario: pide
el código de 5 dígitos al backend y este le devuelve el túnel que el panel
publicó para esa sala.

## Qué hace

- Pide el código de 5 dígitos que muestra el panel.
- Al escribir el quinto dígito se empareja sola (no hace falta pulsar CONECTAR).
- Pide el permiso de sensores dentro de ese gesto, como exige iOS.
- Conecta el WebSocket directo al túnel (`wss://<túnel>/ws/phone?code=...`).
- Pide las imágenes del juego y los avatares al túnel.
- Si el túnel falla, vuelve a preguntar al backend y reintenta.
- Se puede instalar en la pantalla de inicio (manifest + service worker).

## Archivos

| Archivo | Para qué |
|---|---|
| `index.html` | Interfaz (la misma del móvil del túnel, con rutas relativas) |
| `mobile.js` | Emparejamiento, WebSocket, sensores, imágenes y textos ES/EN/PT |
| `manifest.webmanifest` | Nombre, iconos y modo `standalone` |
| `sw.js` | Caché de la interfaz para abrirla sin conexión |
| `icon-*.png`, `apple-touch-icon.png`, `favicon-32.png` | Iconos |
| `fonts/` | RBNo2.1 Black (DEMO) y su licencia |

El service worker solo cachea archivos del mismo origen. El backend y el túnel
son otro origen y nunca se interceptan.

## Parámetros de la URL

| Parámetro | Uso |
|---|---|
| `?code=12345` | Rellena el código; se empareja al pulsar CONECTAR |
| `?backend=https://...` | Cambia el backend de emparejamiento (se guarda en `localStorage`) |
| `?host=https://algo.trycloudflare.com` | Se salta el backend y usa ese túnel (pruebas) |

Por defecto el backend es `https://jd-remote.onrender.com`.

## Publicar en GitHub Pages

El repositorio `nxx-sudo/JD-Control` sirve la carpeta `docs/`:

1. Copia el contenido de esta carpeta a `JD-Control/docs/` **sin borrar** las
   capturas que ya hay ahí.
2. En GitHub: **Settings -> Pages -> Source: Deploy from a branch**, rama
   `main` y carpeta `/docs`. Guarda.
3. Espera al despliegue y abre `https://nxx-sudo.github.io/JD-Control/`.

Todas las rutas son relativas (`./`), así que funciona tanto en la raíz del
sitio como en un subdirectorio. Si cambias archivos, sube la versión de
`VERSION` en `sw.js` para que los móviles descarten la caché vieja.

## Probar en local

Cualquier servidor estático vale; el service worker necesita `http://localhost`
o HTTPS:

```bash
npx serve pwa
# o
python -m http.server 8092 --directory pwa
```

Abre `http://localhost:8092/?code=<código del panel>`. En escritorio Chromium
el acelerómetro no existe o se deniega: es normal, el pad solo se usa en el
móvil. Para verlo en el PC se puede llamar `startSensors('granted')` desde la
consola.

## Límites que conviene conocer

- **iOS**: el permiso de movimiento (`DeviceMotionEvent.requestPermission()`)
  solo se puede pedir dentro de un gesto del usuario. Por eso se pide al pulsar
  CONECTAR o al escribir el quinto dígito. Si se deniega, la PWA muestra la
  pantalla LISTO con el aviso y deja activarlo a mano.
- **Pantalla encendida**: `navigator.wakeLock` existe desde iOS 16.4 y puede
  fallar; nunca bloquea la entrada al pad.
- **HTTPS**: los sensores y el service worker exigen un origen seguro. Pages y
  el túnel ya lo son; una IP local por HTTP no.
- **Suspensión**: si el móvil bloquea la pestaña, el WebSocket se corta y la PWA
  vuelve a la pantalla del código.
- **Backend dormido**: el plan gratuito de Render tarda en despertar. La PWA
  reintenta la consulta dos veces antes de dar error.

## Seguridad

- El backend solo acepta túneles `*.trycloudflare.com` y comprueba que el túnel
  responde `GET /api/room?code=<código>` antes de publicarlo (prueba de
  propiedad). No hay tokens en la PWA.
- Un código es válido mientras el panel lo publica (latido cada 45 s, caduca a
  los 3 min). Al cerrar la sala el panel lo despublica.
- La PWA no habla con el backend para los sensores: solo para resolver el
  código. El tráfico del juego va directo al túnel.

## Créditos

- Tipografía RBNo2.1 Black (DEMO), ver `fonts/LICENSE-RBNo2.1.txt`.
- Los iconos salen del icono de JD CONTROL.
- Proyecto bajo GNU GPL v3, igual que el resto de JD CONTROL.
