'use strict';

/* ------------------------------------------------------------------ */
/*  Puerta por cancion                                                */
/* ------------------------------------------------------------------ */
/* El juego no tiene online de verdad: este PC mete "fantasmas" (moviles
   virtuales) en su Legacy.exe para que los jugadores de otros PCs bailen
   aqui. Antes se metian en cuanto el otro PC tenia movil, aunque cada uno
   estuviera en una cancion distinta. Ahora solo entran cuando los dos
   estan en la MISMA cancion; en menus no entra nadie.

   Modulo aparte para poder probarlo sin levantar servidores.
*/

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

/** El jugador esta en una cancion (lobby o bailando) y es la misma. */
function sameSong(phase, song, target) {
  if (phase !== 'lobby' && phase !== 'dancing') return false;
  if (!target) return false;
  return norm(song) === norm(target);
}

/**
 * Jugadores remotos que deben existir como fantasma en este PC.
 * @param {object} st
 * @param {string} st.role        'host' | 'member' | ''
 * @param {boolean} st.connected  la sala online esta conectada
 * @param {string|null} st.song   cancion abierta en este PC (null = menus)
 * @param {string|null} st.selfId id de este PC dentro de la sala
 * @param {Array} st.members      otros PCs de la sala
 * @param {object} st.host        { song, phase, phone } del anfitrion
 */
function wantedPlayers(st) {
  const out = [];
  const song = st && st.song;
  if (!song) return out; // en menus no se inyecta a nadie

  for (const m of (st.members || [])) {
    if (st.selfId && m.id === st.selfId) continue;
    if (m.connected && m.phone && sameSong(m.phase, m.song, song)) out.push(m.id);
  }

  if (st.role === 'member' && st.connected && st.host && st.host.phone &&
      sameSong(st.host.phase, st.host.song, song)) {
    out.unshift('host');
  }

  return out;
}

module.exports = { norm, sameSong, wantedPlayers };
