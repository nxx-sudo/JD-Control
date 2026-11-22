'use strict';

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

function sameSong(phase, song, target) {
  if (phase !== 'lobby' && phase !== 'dancing') return false;
  if (!target) return false;
  return norm(song) === norm(target);
}

function wantedPlayers(st) {
  const out = [];
  const song = st && st.song;
  if (!song) return out;

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
