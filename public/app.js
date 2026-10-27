'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const isMobile = () => matchMedia('(max-width:820px)').matches;

// =====================================================  THEME
const THEMES = {
  'Dark': { bg: '#313338', panel: '#2b2d31', rail: '#1e1f22', text: '#dbdee1', msgbg: '#00000000', accent: '#5865f2' },
  'Light': { bg: '#ffffff', panel: '#f2f3f5', rail: '#e3e5e8', text: '#2e3338', msgbg: '#00000000', accent: '#5865f2' },
  'Midnight': { bg: '#0b0e17', panel: '#10141f', rail: '#070910', text: '#d6e2ff', msgbg: '#1a2238', accent: '#3d8bff' },
  'Forest': { bg: '#1f2a24', panel: '#18211c', rail: '#121a16', text: '#d9f2e3', msgbg: '#2b3d33', accent: '#3fb97a' },
  'Sunset': { bg: '#2b1d2f', panel: '#241628', rail: '#190f1c', text: '#ffe3d2', msgbg: '#4a2a3d', accent: '#ff7a59' },
  'Hot Pink': { bg: '#2a1020', panel: '#220c19', rail: '#170710', text: '#ffe0f0', msgbg: '#5a1c40', accent: '#ff3d9a' },
  'High Contrast': { bg: '#000000', panel: '#0a0a0a', rail: '#000000', text: '#ffffff', msgbg: '#222222', accent: '#ffff00' }
};
const FONTS = { 'System': 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif', 'Serif': 'Georgia,"Times New Roman",serif', 'Monospace': 'Consolas,"Courier New",monospace', 'Rounded': '"Trebuchet MS","Comic Sans MS",sans-serif', 'Cursive': '"Brush Script MT","Segoe Script",cursive' };
const DEFAULT_THEME = { ...THEMES.Dark, font: 'System', fs: 16, radius: 8, compact: false, chatimg: '', msgpad: 0, ownColor: '', members: true, sounds: true, desktopNotif: false, h24: false };
let theme = { ...DEFAULT_THEME, ...store.get('theme', {}) };
function applyTheme() {
  const r = document.documentElement.style;
  r.setProperty('--bg', theme.bg); r.setProperty('--panel', theme.panel); r.setProperty('--rail', theme.rail);
  r.setProperty('--text', theme.text); r.setProperty('--msgbg', theme.msgbg); r.setProperty('--accent', theme.accent);
  r.setProperty('--font', FONTS[theme.font] || FONTS.System); r.setProperty('--fs', theme.fs + 'px');
  r.setProperty('--radius', theme.radius + 'px'); r.setProperty('--bodypad', theme.msgpad + 'px ' + (theme.msgpad * 1.5) + 'px');
  r.setProperty('--chatimg', theme.chatimg ? `url("${theme.chatimg.replace(/"/g, '')}")` : 'none');
  document.body.classList.toggle('compact', !!theme.compact);
  store.set('theme', theme);
}
applyTheme();

// =====================================================  STATE / NETWORK
let token = store.get('token', null), socket, ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const S = { me: null, servers: {}, dms: {}, users: {}, msgs: {}, unread: {}, cur: { serverId: null, channelId: null }, voiceRooms: {}, typing: {}, reply: null, pending: [], search: '', last: {} };

const authForm = $('#authForm'); let registering = false;
$('#authSwitch').onclick = e => { e.preventDefault(); registering = !registering; $('#authBtn').textContent = registering ? 'Create account' : 'Log in'; $('#authSub').textContent = registering ? 'Create your free account.' : 'Welcome back! Sign in to continue.'; $('#authSwitch').textContent = registering ? 'Already have an account? Log in' : 'Need an account? Register'; };
authForm.onsubmit = async e => {
  e.preventDefault(); $('#authErr').textContent = '';
  try {
    const r = await fetch('/api/' + (registering ? 'register' : 'login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#aName').value, password: $('#aPass').value }) }).then(r => r.json());
    if (r.error) return $('#authErr').textContent = r.error;
    token = r.token; store.set('token', token); start();
  } catch { $('#authErr').textContent = 'Could not reach the server.'; }
};
const emit = (ev, data) => new Promise(res => socket.emit(ev, data || {}, r => res(r || {})));

async function start() {
  if (!token) return;
  try { const r = await fetch('/api/ice').then(r => r.json()); ICE = r.iceServers; } catch {}
  socket = io({ auth: { token }, transports: ['websocket', 'polling'] });
  socket.on('connect_error', err => { if (err.message === 'auth') { store.set('token', null); token = null; location.reload(); } });
  socket.on('disconnect', () => toast('Disconnected… reconnecting'));
  socket.on('ready', onReady);
  bindSocket();
}
function onReady(d) {
  S.me = d.me; S.users[d.me.id] = d.me;
  S.servers = {}; for (const s of d.servers) setServer(s);
  S.dms = {}; for (const x of d.dms) { S.dms[x.channelId] = x.user; S.users[x.user.id] = x.user; }
  S.voiceRooms = d.voiceRooms || {};
  $('#auth').hidden = true; $('#app').hidden = false;
  if (!S.ready) { S.ready = true; theme.members = theme.members && !isMobile(); const saved = store.get('cur', null); if (saved && (S.servers[saved.serverId] || S.dms[saved.channelId])) selectChannel(saved.serverId, saved.channelId, false); else selectHome(false); }
  else if (S.cur.channelId) loadHistory(S.cur.channelId);
  renderAll();
}
function setServer(s) { S.servers[s.id] = s; for (const m of s.members) { S.users[m.id] = { ...(S.users[m.id] || {}), ...m }; } }

function bindSocket() {
  socket.on('server:update', s => { setServer(s); renderAll(); });
  socket.on('server:removed', ({ serverId }) => { delete S.servers[serverId]; if (S.cur.serverId === serverId) selectHome(); renderAll(); });
  socket.on('presence', ({ userId, online }) => { for (const s of Object.values(S.servers)) { const m = s.members.find(m => m.id === userId); if (m) m.online = online; } if (S.dms) for (const u of Object.values(S.dms)) if (u.id === userId) u.online = online; renderSide(); renderMembers(); });
  socket.on('user:update', u => { S.users[u.id] = { ...(S.users[u.id] || {}), ...u }; if (u.id === S.me.id) S.me = { ...S.me, ...u }; for (const k in S.dms) if (S.dms[k].id === u.id) S.dms[k] = { ...S.dms[k], ...u }; renderAll(); renderMessages(); });
  socket.on('dm:added', ({ channelId, user }) => { S.dms[channelId] = user; S.users[user.id] = user; renderRail(); renderSide(); });
  socket.on('dm:ring', ({ channelId, from }) => {
    S.dms[channelId] = S.dms[channelId] || from; S.users[from.id] = from; renderSide();
    ring(); toast(`📞 ${from.name} is calling you`, { label: 'Answer', fn: () => { selectChannel(null, channelId); joinVoice(channelId); } }, 20000);
    notify(`${from.name} is calling`, 'Open Chatcord to answer');
  });
  socket.on('msg:new', ({ message: m, user }) => {
    S.users[user.id] = { ...(S.users[user.id] || {}), ...user };
    (S.msgs[m.channelId] = S.msgs[m.channelId] || []).push(m);
    delete (S.typing[m.channelId] || {})[m.userId];
    const viewing = S.cur.channelId === m.channelId && !document.hidden && !$('#chat').hidden;
    if (m.channelId === S.cur.channelId) { renderMessages(true); renderTyping(); }
    if (m.userId !== S.me.id && !viewing) {
      S.unread[m.channelId] = (S.unread[m.channelId] || 0) + 1; renderRail(); renderSide();
      const mention = mentionsMe(m);
      if (m.channelId.startsWith('dm:') || mention) notify(user.name, m.content || 'Sent an attachment');
      beep(660, .08);
    } else if (m.userId !== S.me.id) beep(660, .05);
    if (!S.dms[m.channelId] && m.channelId.startsWith('dm:')) { S.dms[m.channelId] = user; renderSide(); }
  });
  socket.on('msg:update', ({ channelId, message }) => { const a = S.msgs[channelId]; if (!a) return; const i = a.findIndex(x => x.id === message.id); if (i >= 0) a[i] = message; if (channelId === S.cur.channelId) renderMessages(); });
  socket.on('msg:delete', ({ channelId, id }) => { if (S.msgs[channelId]) S.msgs[channelId] = S.msgs[channelId].filter(x => x.id !== id); if (channelId === S.cur.channelId) renderMessages(); });
  socket.on('typing', ({ channelId, userId, name }) => {
    (S.typing[channelId] = S.typing[channelId] || {})[userId] = { name, t: Date.now() };
    renderTyping(); setTimeout(renderTyping, 3200);
  });
  socket.on('voice:update', ({ roomId, parts }) => {
    if (parts.length) S.voiceRooms[roomId] = parts; else delete S.voiceRooms[roomId];
    const was = V.parts.map(p => p.sid); V.parts = V.room === roomId ? parts : V.parts;
    if (V.room === roomId) {
      const gone = was.filter(s => !parts.find(p => p.sid === s) && s !== socket.id);
      for (const s of gone) closePeer(s);
      if (gone.length) beep(330, .1);
      if (parts.length > was.length) beep(880, .1);
      renderCall();
    }
    renderSide(); renderCallbar();
  });
  socket.on('signal', onSignal);
}

// =====================================================  NAVIGATION
function selectHome(persist = true) { S.cur = { serverId: null, channelId: null }; if (persist) store.set('cur', S.cur); renderAll(); renderMessages(); }
function selectChannel(serverId, channelId, persist = true) {
  S.cur = { serverId, channelId }; if (persist) store.set('cur', S.cur);
  S.unread[channelId] = 0; S.reply = null; S.pending = []; S.search = '';
  const ch = curChannel();
  if (ch && ch.type === 'voice') { showCallView(true); } else showCallView(false);
  if (ch && ch.type !== 'voice' || channelId?.startsWith('dm:')) loadHistory(channelId);
  $('#app').classList.add('inchat');
  renderAll(); if (!isMobile()) $('#input').focus();
}
const curServer = () => S.servers[S.cur.serverId];
const curChannel = () => { const s = curServer(); if (s) return s.channels.find(c => c.id === S.cur.channelId); if (S.cur.channelId?.startsWith('dm:')) return { id: S.cur.channelId, type: 'text', name: S.dms[S.cur.channelId]?.name || 'dm', dm: true }; return null; };
async function loadHistory(id) {
  if (S.msgs[id]) return renderMessages(true);
  const r = await emit('history', { channelId: id });
  if (r.error) return toast(r.error);
  for (const u of Object.values(r.users)) if (u) S.users[u.id] = { ...(S.users[u.id] || {}), ...u };
  S.msgs[id] = r.messages; S.more = S.more || {}; S.more[id] = r.more;
  if (S.cur.channelId === id) renderMessages(true);
}
function renderAll() { renderRail(); renderSide(); renderTop(); renderMembers(); renderComposer(); renderCallbar(); }

// =====================================================  RENDER: AVATARS
function avatarHTML(u, cls = '', dot) {
  u = u || { name: '?', color: '#888' };
  const st = u.avatar ? `background-image:url('${esc(u.avatar)}')` : `background:${esc(u.color || '#5865f2')}`;
  return `<div class="avatar ${cls}" style="${st}">${u.avatar ? '' : esc((u.name || '?')[0].toUpperCase())}${dot === undefined ? '' : `<span class="dot ${dot ? 'on' : ''}"></span>`}</div>`;
}
const userOf = id => S.users[id] || { name: 'Unknown', color: '#888' };

// =====================================================  RENDER: RAIL / SIDE
function renderRail() {
  const r = $('#rail'); r.innerHTML = '';
  const dmUnread = Object.entries(S.unread).filter(([k, v]) => k.startsWith('dm:') && v).reduce((a, [, v]) => a + v, 0);
  r.append(rb('💬', 'Direct messages', !S.cur.serverId, selectHome, dmUnread));
  const sep = document.createElement('div'); sep.className = 'rsep'; r.append(sep);
  for (const s of Object.values(S.servers)) {
    const un = s.channels.reduce((a, c) => a + (S.unread[c.id] || 0), 0);
    const b = rb(s.icon ? `<img src="${esc(s.icon)}">` : esc(s.name.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase()), s.name, S.cur.serverId === s.id, () => { const c = s.channels.find(c => c.type === 'text'); selectChannel(s.id, (S.cur.serverId === s.id ? S.cur.channelId : null) || c.id); }, un, true);
    if (!s.icon) b.style.background = S.cur.serverId === s.id ? '' : s.color;
    if (!s.icon && S.cur.serverId !== s.id) b.style.color = '#fff';
    r.append(b);
  }
  r.append(rb('＋', 'Create or join a server', false, serverDialog));
}
function rb(html, title, on, fn, badge, raw) {
  const b = document.createElement('button'); b.className = 'rbtn' + (on ? ' on' : ''); b.title = title; b.innerHTML = html + (badge ? `<span class="badge">${badge > 99 ? '99+' : badge}</span>` : ''); b.onclick = fn; return b;
}
function renderSide() {
  const head = $('#sideHead'), list = $('#chanlist'); list.innerHTML = '';
  const s = curServer();
  if (!s) {
    head.innerHTML = '<span>Direct Messages</span>';
    const f = document.createElement('div'); f.style.padding = '4px 4px 8px'; f.innerHTML = '<button class="btn" style="width:100%">Find or start a conversation</button>'; f.firstChild.onclick = dmDialog; list.append(f);
    for (const [cid, u] of Object.entries(S.dms)) {
      const d = document.createElement('div'); d.className = 'chan' + (S.cur.channelId === cid ? ' on' : '') + (S.unread[cid] ? ' unread' : '');
      d.innerHTML = `${avatarHTML(u, 'sm', u.online)}<span>${esc(u.name)}</span>${S.voiceRooms[cid] ? '<span title="In a call">🔊</span>' : ''}${S.unread[cid] ? `<span class="cnt">${S.unread[cid]}</span>` : ''}`;
      d.onclick = () => selectChannel(null, cid); list.append(d);
    }
    if (!Object.keys(S.dms).length) list.insertAdjacentHTML('beforeend', '<p class="muted small" style="padding:8px">No conversations yet. Search for someone by username to start chatting.</p>');
    return;
  }
  const owner = s.ownerId === S.me.id;
  head.innerHTML = `<span>${esc(s.name)}</span><button class="icon" title="Server settings">⚙</button>`;
  head.querySelector('button').onclick = serverSettings;
  for (const type of ['text', 'voice']) {
    const c = document.createElement('div'); c.className = 'cat'; c.innerHTML = `<span>${type === 'text' ? 'Text channels' : 'Voice channels'}</span>${owner ? '<button title="Create channel">＋</button>' : ''}`;
    if (owner) c.querySelector('button').onclick = () => channelDialog(type);
    list.append(c);
    for (const ch of s.channels.filter(c => c.type === type)) {
      const d = document.createElement('div'); d.className = 'chan' + (S.cur.channelId === ch.id ? ' on' : '') + (S.unread[ch.id] ? ' unread' : '');
      d.innerHTML = `<span>${type === 'text' ? '#' : '🔊'}</span><span>${esc(ch.name)}</span>${S.unread[ch.id] ? `<span class="cnt">${S.unread[ch.id]}</span>` : ''}${owner ? '<button class="x" title="Delete">✕</button>' : ''}`;
      d.onclick = () => { type === 'voice' ? (selectChannel(s.id, ch.id), joinVoice(ch.id)) : selectChannel(s.id, ch.id); };
      if (owner) d.querySelector('.x').onclick = async e => { e.stopPropagation(); if (confirm(`Delete #${ch.name} and its messages?`)) { const r = await emit('channel:delete', { serverId: s.id, channelId: ch.id }); if (r.error) toast(r.error); } };
      list.append(d);
      if (type === 'voice') for (const p of S.voiceRooms[ch.id] || []) {
        const u = userOf(p.userId); const v = document.createElement('div'); v.className = 'vpart';
        v.innerHTML = `${avatarHTML(u, 'sm')}<span>${esc(u.name)}</span><span style="margin-left:auto">${p.deafened ? '🔇' : p.muted ? '🎙️❌' : ''}${p.video ? '📹' : ''}${p.screen ? '🖥' : ''}</span>`; list.append(v);
      }
    }
  }
}
function renderTop() {
  const t = $('#topbar'), ch = curChannel(), s = curServer();
  if (!ch) { t.innerHTML = `<button class="icon" id="mobnav">☰</button><span>🏠 Welcome, ${esc(S.me.name)}</span>`; $('#mobnav').onclick = () => $('#app').classList.remove('inchat'); return; }
  const dmUser = ch.dm ? S.dms[ch.id] : null;
  t.innerHTML = `<button class="icon" id="mobnav" title="Back">☰</button><span>${ch.dm ? '@' + esc(dmUser?.name || '') : ch.type === 'voice' ? '🔊 ' + esc(ch.name) : '# ' + esc(ch.name)}</span><span class="sp"></span>
    ${ch.type !== 'voice' ? '<input id="search" placeholder="Search messages" value="' + esc(S.search) + '">' : ''}
    ${ch.dm ? '<button class="btn" id="dmCall" title="Start a voice/video call">📞 Call</button>' : ''}
    ${V.room && ch.type !== 'voice' && V.room === ch.id ? `<button class="btn" id="showCall">${$('#callview').classList.contains('active') ? '💬 Show chat' : '📞 Show call'}</button>` : ''}
    ${s ? '<button class="icon" id="memToggle" title="Member list">👥</button>' : ''}`;
  $('#mobnav').onclick = () => $('#app').classList.remove('inchat');
  const se = $('#search'); if (se) se.oninput = () => { S.search = se.value; renderMessages(); };
  const dc = $('#dmCall'); if (dc) dc.onclick = () => joinVoice(ch.id);
  const sc = $('#showCall'); if (sc) sc.onclick = () => showCallView(!$('#callview').classList.contains('active'));
  const mt = $('#memToggle'); if (mt) mt.onclick = () => { theme.members = !theme.members; applyTheme(); renderMembers(); };
}
function renderMembers() {
  const m = $('#members'), s = curServer();
  m.hidden = !s || !theme.members; if (m.hidden) return;
  const sorted = [...s.members].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  m.innerHTML = `<div class="cat">Online — ${sorted.filter(x => x.online).length}</div>`;
  let offHeader = false;
  for (const u of sorted) {
    if (!u.online && !offHeader) { offHeader = true; m.insertAdjacentHTML('beforeend', `<div class="cat">Offline — ${sorted.filter(x => !x.online).length}</div>`); }
    const d = document.createElement('div'); d.className = 'mem' + (u.online ? '' : ' off');
    d.innerHTML = `${avatarHTML(u, '', u.online)}<span style="color:${esc(u.color)}">${esc(u.name)}${u.id === s.ownerId ? ' 👑' : ''}</span>`;
    d.onclick = () => profileCard(u.id); m.append(d);
  }
}
function renderUserPanel() {
  const p = $('#userpanel'), me = S.me;
  p.innerHTML = `${avatarHTML(me, '', true)}<div class="nm">${esc(me.name)}<div class="muted small">Online</div></div>
   <button class="btn ${V.muted ? 'off' : ''}" id="upMute" title="Mute / unmute">${V.muted ? '🎙️❌' : '🎙️'}</button>
   <button class="btn ${V.deaf ? 'off' : ''}" id="upDeaf" title="Deafen / undeafen">${V.deaf ? '🔇' : '🎧'}</button>
   <button class="btn" id="upSet" title="User settings">⚙</button>`;
  $('#upMute').onclick = toggleMute; $('#upDeaf').onclick = toggleDeaf; $('#upSet').onclick = () => settings('appearance');
}
const _renderSide = renderSide; // keep user panel in sync
renderSide = function () { _renderSide(); renderUserPanel(); };

// =====================================================  MESSAGES
function mentionsMe(m) { return new RegExp('@' + S.me.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\w)', 'i').test(m.content) || /@everyone\b/.test(m.content); }
function fmt(text) {
  let t = esc(text);
  const blocks = []; t = t.replace(/```([\s\S]*?)```/g, (_, c) => { blocks.push(c); return '\u0000' + (blocks.length - 1) + '\u0000'; });
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>').replace(/__([^_\n]+)__/g, '<u>$1</u>').replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/\|\|([^|\n]+)\|\|/g, '<span style="background:currentColor;border-radius:4px;cursor:pointer" onclick="this.style.background=\'none\'"><span>$1</span></span>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|\s)@(\w[\w .-]{0,23}\w|\w|everyone)/g, (m, a, n) => (n === 'everyone' || Object.values(S.users).some(u => u.name.toLowerCase() === n.toLowerCase())) ? `${a}<span class="mention-t">@${n}</span>` : m);
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre>${blocks[i].replace(/^\n/, '')}</pre>`);
}
const timeStr = ts => { const d = new Date(ts), today = new Date(); const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !theme.h24 }); return d.toDateString() === today.toDateString() ? t : d.toLocaleDateString() + ' ' + t; };
function attHTML(a) {
  const u = esc(a.url);
  if (/\.(png|jpe?g|gif|webp)$/i.test(a.url)) return `<img src="${u}" alt="${esc(a.name)}" loading="lazy" data-lb="${u}">`;
  if (/\.(mp4|webm|mov)$/i.test(a.url)) return `<video src="${u}" controls preload="metadata" playsinline></video>`;
  if (/\.(mp3|ogg|wav|m4a)$/i.test(a.url)) return `<audio src="${u}" controls></audio>`;
  return `<a class="file" href="${u}" download="${esc(a.name)}">📄 <span>${esc(a.name)}<br><small class="muted">${(a.size / 1024).toFixed(0)} KB</small></span></a>`;
}
function renderMessages(stick) {
  const box = $('#msgs'), ch = curChannel();
  if (!ch || ch.type === 'voice') { if (!ch) box.innerHTML = `<div class="empty"><h2>Welcome to Chatcord 👋</h2><p>Create a server with the ＋ button, join one with an invite code, or open Direct Messages to talk to a friend. Use ⚙ to customize colors, fonts and more.</p></div>`; return; }
  const near = stick || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let list = S.msgs[ch.id];
  if (!list) { box.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const q = S.search.toLowerCase(); if (q) list = list.filter(m => m.content.toLowerCase().includes(q) || m.attachments.some(a => a.name.toLowerCase().includes(q)));
  const owner = curServer()?.ownerId === S.me.id;
  let html = S.more?.[ch.id] ? '<div class="empty" style="padding:6px 16px"><button class="btn" id="older">Load older messages</button></div>' : '';
  if (!list.length) html += `<div class="empty">${q ? 'No matches.' : 'This is the start of the conversation. Say hi! 👋'}</div>`;
  let prev = null;
  for (const m of list) {
    const u = userOf(m.userId), head = !prev || prev.userId !== m.userId || m.ts - prev.ts > 300000 || m.replyTo; prev = m;
    const rep = m.replyTo && (S.msgs[ch.id] || []).find(x => x.id === m.replyTo);
    const rx = Object.entries(m.reactions || {}).map(([e, ids]) => `<button class="${ids.includes(S.me.id) ? 'me' : ''}" data-rx="${esc(e)}" title="${esc(ids.map(i => userOf(i).name).join(', '))}">${esc(e)} ${ids.length}</button>`).join('');
    const nameColor = m.userId === S.me.id && theme.ownColor ? theme.ownColor : u.color;
    html += `<div class="msg ${head ? 'head' : ''} ${mentionsMe(m) && m.userId !== S.me.id ? 'mention' : ''}" data-id="${m.id}">
      ${head ? `<div class="av">${avatarHTML(u)}</div>` : ''}
      ${m.replyTo ? `<div class="reply">↩ ${rep ? esc(userOf(rep.userId).name) + ': ' + esc(rep.content.slice(0, 80) || 'attachment') : 'original message'}</div>` : ''}
      ${head ? `<div class="meta"><span class="who" style="color:${esc(nameColor)}" data-u="${esc(u.id || '')}">${esc(u.name)}</span><span class="ts">${timeStr(m.ts)}</span></div>` : ''}
      <div class="body">${fmt(m.content)}</div>${m.edited ? '<span class="edited"> (edited)</span>' : ''}
      ${m.attachments.length ? `<div class="atts">${m.attachments.map(attHTML).join('')}</div>` : ''}
      ${rx ? `<div class="rx">${rx}</div>` : ''}
      <div class="tools"><button data-a="react" title="Add reaction">😊</button><button data-a="reply" title="Reply">↩</button>${m.userId === S.me.id ? '<button data-a="edit" title="Edit">✏️</button>' : ''}${m.userId === S.me.id || owner ? '<button data-a="del" title="Delete">🗑</button>' : ''}</div></div>`;
  }
  box.innerHTML = html;
  if (near) box.scrollTop = box.scrollHeight;
}
$('#msgs').addEventListener('click', async e => {
  const t = e.target, row = t.closest('.msg'), ch = curChannel();
  if (t.id === 'older') { const a = S.msgs[ch.id]; const r = await emit('history', { channelId: ch.id, before: a[0]?.ts }); for (const u of Object.values(r.users)) if (u) S.users[u.id] = u; S.msgs[ch.id] = [...r.messages, ...a]; S.more[ch.id] = r.more; return renderMessages(); }
  if (t.dataset.lb) { $('#lightbox').innerHTML = `<img src="${t.dataset.lb}">`; $('#lightbox').hidden = false; return; }
  if (t.dataset.u) return profileCard(t.dataset.u);
  if (!row) return;
  const id = row.dataset.id, m = S.msgs[ch.id].find(x => x.id === id);
  if (t.dataset.rx) return emit('msg:react', { channelId: ch.id, id, emoji: t.dataset.rx });
  const a = t.dataset.a;
  if (a === 'react') openPicker(t, em => emit('msg:react', { channelId: ch.id, id, emoji: em }));
  if (a === 'reply') { S.reply = m; renderComposer(); $('#input').focus(); }
  if (a === 'del' && confirm('Delete this message?')) emit('msg:delete', { channelId: ch.id, id });
  if (a === 'edit') {
    const body = row.querySelector('.body'); body.style.display = 'block'; body.innerHTML = `<textarea style="width:min(520px,80vw)">${esc(m.content)}</textarea><div class="muted small">Enter to save · Esc to cancel</div>`;
    const ta = body.querySelector('textarea'); ta.focus();
    ta.onkeydown = async ev => { if (ev.key === 'Escape') renderMessages(); if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); const r = await emit('msg:edit', { channelId: ch.id, id, content: ta.value }); if (r.error) toast(r.error); } };
  }
});
$('#lightbox').onclick = () => $('#lightbox').hidden = true;
function renderTyping() {
  const t = S.typing[S.cur.channelId] || {}, now = Date.now();
  const names = Object.entries(t).filter(([, v]) => now - v.t < 3000).map(([, v]) => v.name);
  $('#typing').textContent = names.length ? (names.length > 2 ? 'Several people are typing…' : names.join(' and ') + (names.length > 1 ? ' are' : ' is') + ' typing…') : '';
}

// =====================================================  COMPOSER
function renderComposer() {
  const ch = curChannel(), show = ch && ch.type === 'text';
  $('#composer').hidden = !show; $('#replybar').hidden = !S.reply || !show;
  $('#input').placeholder = ch ? (ch.dm ? 'Message @' + (S.dms[ch.id]?.name || '') : 'Message #' + ch.name) : '';
  if (S.reply) { $('#replybar').innerHTML = `Replying to <b>${esc(userOf(S.reply.userId).name)}</b>: ${esc(S.reply.content.slice(0, 60) || 'attachment')} <button class="btn" style="margin-left:auto;padding:2px 8px">✕</button>`; $('#replybar').querySelector('button').onclick = () => { S.reply = null; renderComposer(); }; }
  const p = $('#pending'); p.innerHTML = '';
  S.pending.forEach((a, i) => { const c = document.createElement('span'); c.className = 'chip'; c.innerHTML = `${a.uploading ? '⏳' : '📎'} ${esc(a.name)} <button>✕</button>`; c.querySelector('button').onclick = () => { S.pending.splice(i, 1); renderComposer(); }; p.append(c); });
  $('#chat').hidden = $('#callview').classList.contains('active') ? true : false;
  $('#msgs').style.display = ch && ch.type === 'voice' ? 'none' : '';
}
const input = $('#input'); let lastTyping = 0;
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; if (Date.now() - lastTyping > 2500 && S.cur.channelId) { lastTyping = Date.now(); socket.emit('typing', { channelId: S.cur.channelId }); } });
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#composer').onsubmit = async e => {
  e.preventDefault();
  if (S.pending.some(a => a.uploading)) return toast('Wait for the upload to finish…');
  const content = input.value, ch = curChannel(); if (!ch || (!content.trim() && !S.pending.length)) return;
  const r = await emit('msg:send', { channelId: ch.id, content, attachments: S.pending, replyTo: S.reply?.id });
  if (r.error) return toast(r.error);
  input.value = ''; input.style.height = 'auto'; S.pending = []; S.reply = null; renderComposer();
};
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = e => { uploadFiles([...e.target.files]); e.target.value = ''; };
$('#emojiBtn').onclick = e => openPicker(e.currentTarget, em => { const p = input.selectionStart ?? input.value.length; input.value = input.value.slice(0, p) + em + input.value.slice(input.selectionEnd ?? p); input.focus(); input.selectionStart = input.selectionEnd = p + em.length; }, true);
input.addEventListener('paste', e => { const f = [...e.clipboardData.files]; if (f.length) { e.preventDefault(); uploadFiles(f); } });
const chatEl = $('#main');
chatEl.addEventListener('dragover', e => e.preventDefault());
chatEl.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]); });
async function upload(file) {
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch('/api/upload', { method: 'POST', headers: { 'x-token': token }, body: fd }).then(r => r.json()).catch(() => ({ error: 'Upload failed' }));
  return r;
}
async function uploadFiles(files) {
  for (const f of files) {
    if (f.size > 50 * 1024 * 1024) { toast(`${f.name} is over the 50 MB limit`); continue; }
    const ph = { name: f.name, uploading: true }; S.pending.push(ph); renderComposer();
    const r = await upload(f);
    if (r.error) { S.pending.splice(S.pending.indexOf(ph), 1); toast(r.error); } else Object.assign(ph, r, { uploading: false });
    renderComposer();
  }
}

// =====================================================  EMOJI PICKER
const EMOJI = {
  '😀': '😀😃😄😁😆😅😂🤣🥲☺️😊😇🙂🙃😉😌😍🥰😘😗😙😚😋😛😝😜🤪🤨🧐🤓😎🥸🤩🥳😏😒😞😔😟😕🙁☹️😣😖😫😩🥺😢😭😤😠😡🤬🤯😳🥵🥶😱😨😰😥😓🤗🤔🤭🤫🤥😶😐😑😬🙄😯😦😧😮😲🥱😴🤤😪😵🤐🥴🤢🤮🤧😷🤒🤕🤑🤠😈👿👹👺🤡💩👻💀☠️👽👾🤖🎃😺😸😹😻😼😽🙀😿😾',
  '👋': '👋🤚🖐✋🖖👌🤌🤏✌️🤞🤟🤘🤙👈👉👆👇☝️👍👎✊👊🤛🤜👏🙌👐🤲🤝🙏✍️💅🤳💪🦾🦵🦶👂👃🧠👀👁👅👄💋🩸👶🧒👦👧🧑👨👩🧓👴👵🙍🙎🙅🙆💁🙋🧏🙇🤦🤷👮🕵💂👷🤴👸👰🤵🦸🦹🧙🧚🧛🧜🧝🧞🧟💆💇🚶🏃💃🕺👯🧘',
  '🐶': '🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐷🐸🐵🙈🙉🙊🐒🐔🐧🐦🐤🦆🦅🦉🦇🐺🐗🐴🦄🐝🐛🦋🐌🐞🐜🪲🦟🐢🐍🦎🐙🦑🦐🦀🐡🐠🐟🐬🐳🐋🦈🐊🐅🐆🦓🦍🐘🦛🦏🐪🐫🦒🦘🐃🐂🐄🐎🐖🐏🐑🐐🦌🐕🐩🐈🐓🦃🕊🐇🦝🦨🦔🌵🎄🌲🌳🌴🌱🌿☘️🍀🍁🍂🍃🌺🌻🌹🌷🌼🌸💐🍄🌍🌙⭐🌟✨⚡🔥🌈☀️⛅☁️❄️💧🌊',
  '🍕': '🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍈🍒🍑🥭🍍🥥🥝🍅🍆🥑🥦🥬🥒🌶🌽🥕🥔🍠🥐🍞🥖🧀🥚🍳🥞🧇🥓🥩🍗🍖🌭🍔🍟🍕🥪🌮🌯🥗🍝🍜🍲🍛🍣🍱🥟🍤🍙🍚🍘🍥🍦🍧🍨🍩🍪🎂🍰🧁🍫🍬🍭🍮🍯🍼🥛☕🍵🥤🍶🍺🍻🥂🍷🥃🍸🍹🧃🧋',
  '⚽': '⚽🏀🏈⚾🥎🎾🏐🏉🎱🏓🏸🥅🏒🏑🏏⛳🏹🎣🥊🥋🎽⛸🥌🛷🎿⛷🏂🏋🤼🤸⛹🤺🏇🧘🏄🏊🚣🧗🚴🏆🥇🥈🥉🏅🎖🎫🎟🎪🎭🎨🎬🎤🎧🎼🎹🥁🎷🎺🎸🎻🎲♟🎯🎳🎮🎰🧩🚗🚕🚙🚌🏎🚓🚑🚒🚚🚜🛵🏍🚲✈️🚀🛸🚁⛵🚤🚢🏠🏰🗽🗼🎡🎢',
  '❤️': '❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💘💝💟☮️✝️☪️🕉☸️✡️🔯☯️♈♉♊♋♌♍♎♏♐♑♒♓⚠️🚫❌⭕✅☑️✔️❓❗‼️💯🔔🔕📣💬💭🗯💤🔊🔇🎵🎶💡🔑🔒📱💻🖥⌨️🖱📷📹🎥📺📻⏰⌛💰💎🔧🔨⚙️🧲💣🎁🎈🎉🎊🏳️🏴🚩🏁'
};
let pickerCb = null;
function openPicker(anchor, cb, up) {
  const p = $('#picker'); if (!p.hidden && p._a === anchor) return closePicker();
  pickerCb = cb; p._a = anchor; p.hidden = false;
  const rc = anchor.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(innerWidth - 328, rc.right - 320)) + 'px';
  p.style.top = Math.max(8, Math.min(innerHeight - 348, rc.top - 346 > 8 && (up || rc.top > 360) ? rc.top - 346 : rc.bottom + 6)) + 'px';
  const cats = Object.keys(EMOJI); let cur = cats[0];
  const draw = () => {
    p.innerHTML = `<div class="cats">${cats.map(c => `<button class="${c === cur ? 'on' : ''}" data-c="${c}">${c}</button>`).join('')}</div><div class="eg">${Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(EMOJI[cur])).map(s => `<button>${s.segment}</button>`).join('')}</div>`;
    p.querySelectorAll('.cats button').forEach(b => b.onclick = () => { cur = b.dataset.c; draw(); });
    p.querySelectorAll('.eg button').forEach(b => b.onclick = () => { pickerCb(b.textContent); if (!up) closePicker(); });
  }; draw();
}
function closePicker() { $('#picker').hidden = true; $('#picker')._a = null; }
document.addEventListener('mousedown', e => { if (!$('#picker').hidden && !e.target.closest('#picker') && e.target !== $('#picker')._a && !$('#picker')._a?.contains(e.target)) closePicker(); document.querySelectorAll('.ctx').forEach(c => c.remove()); });

// =====================================================  MODALS
function modal(html, onMount) {
  const m = $('#modal'); m.innerHTML = `<div class="card">${html}</div>`; m.hidden = false;
  m.onmousedown = e => { if (e.target === m) closeModal(); };
  onMount && onMount(m.firstChild); return m.firstChild;
}
const closeModal = () => { $('#modal').hidden = true; $('#modal').innerHTML = ''; };
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); closePicker(); $('#lightbox').hidden = true; } });

function serverDialog() {
  modal(`<h2>Servers</h2><div class="form"><b>Join a server</b><input id="jc" placeholder="Paste an invite code or link"><button class="btn primary" id="jb">Join</button><hr style="width:100%;border:0;border-top:1px solid var(--line)"><b>Create your own</b><input id="cn" placeholder="Server name" maxlength="50"><button class="btn primary" id="cb">Create server</button></div><div class="err" id="me"></div>`, c => {
    c.querySelector('#jb').onclick = async () => { const r = await emit('server:join', { code: c.querySelector('#jc').value }); if (r.error) return c.querySelector('#me').textContent = r.error; setServer(r.server); closeModal(); selectChannel(r.server.id, r.server.channels.find(x => x.type === 'text').id); };
    c.querySelector('#cb').onclick = async () => { const r = await emit('server:create', { name: c.querySelector('#cn').value }); if (r.error) return c.querySelector('#me').textContent = r.error; setServer(r.server); closeModal(); selectChannel(r.server.id, r.server.channels[0].id); };
  });
}
function channelDialog(type) {
  modal(`<h2>Create ${type} channel</h2><input id="n" placeholder="${type === 'text' ? 'new-channel' : 'Lounge'}" maxlength="40"><div class="row"><button class="btn" id="x">Cancel</button><button class="btn primary" id="ok">Create</button></div>`, c => {
    c.querySelector('#x').onclick = closeModal; c.querySelector('#n').focus();
    c.querySelector('#ok').onclick = async () => { const r = await emit('channel:create', { serverId: S.cur.serverId, name: c.querySelector('#n').value, type }); if (r.error) toast(r.error); else closeModal(); };
  });
}
function dmDialog() {
  modal(`<h2>Start a conversation</h2><input id="q" placeholder="Search by username" autofocus><div id="res"></div>`, c => {
    const q = c.querySelector('#q'); let t;
    q.oninput = () => { clearTimeout(t); t = setTimeout(async () => { const r = await emit('users:search', { q: q.value }); c.querySelector('#res').innerHTML = ''; (r.users || []).forEach(u => { const d = document.createElement('div'); d.className = 'mem'; d.innerHTML = avatarHTML(u) + esc(u.name); d.onclick = () => openDM(u.id); c.querySelector('#res').append(d); }); if (!(r.users || []).length) c.querySelector('#res').innerHTML = '<p class="muted">No users found.</p>'; }, 200); };
  });
}
async function openDM(userId) {
  const r = await emit('dm:open', { userId }); if (r.error) return toast(r.error);
  S.dms[r.channelId] = r.user; S.users[r.user.id] = { ...(S.users[r.user.id] || {}), ...r.user }; closeModal(); selectChannel(null, r.channelId);
}
function profileCard(id) {
  const u = userOf(id); if (!u.id) return;
  modal(`<div style="display:flex;gap:14px;align-items:center">${avatarHTML(u).replace('class="avatar ', 'style="width:72px;height:72px;font-size:2em" class="avatar ')}<div><h2 style="color:${esc(u.color)}">${esc(u.name)}</h2><div class="muted">${esc(u.bio || '')}</div></div></div><div class="row">${id !== S.me.id ? '<button class="btn primary" id="dm">Message</button>' : ''}${curServer()?.ownerId === S.me.id && id !== S.me.id && curServer().members.some(m => m.id === id) ? '<button class="btn danger" id="kick">Kick from server</button>' : ''}</div>`, c => {
    const dm = c.querySelector('#dm'); if (dm) dm.onclick = () => openDM(id);
    const k = c.querySelector('#kick'); if (k) k.onclick = async () => { if (confirm(`Kick ${u.name}?`)) { await emit('server:kick', { serverId: S.cur.serverId, userId: id }); closeModal(); } };
  });
}
function serverSettings() {
  const s = curServer(), owner = s.ownerId === S.me.id;
  modal(`<h2>${esc(s.name)}</h2><label class="form full">Invite code (share this to let friends join)<div style="display:flex;gap:6px"><input id="inv" readonly value="${esc(s.invite)}"><button class="btn" id="cp">Copy</button></div></label>
    <label class="form full">Invite link<input readonly value="${esc(location.origin)}/?invite=${esc(s.invite)}"></label>
    ${owner ? `<label class="form full">Server name<input id="sn" value="${esc(s.name)}" maxlength="50"></label><label class="form full">Server icon<input type="file" id="si" accept="image/*"></label><div class="row"><button class="btn" id="ni">New invite code</button><button class="btn primary" id="sv">Save</button><button class="btn danger" id="dl">Delete server</button></div>` : '<div class="row"><button class="btn danger" id="lv">Leave server</button></div>'}`, c => {
    c.querySelector('#cp').onclick = () => { navigator.clipboard?.writeText(`${location.origin}/?invite=${s.invite}`); toast('Invite link copied!'); };
    const on = (id, fn) => { const e = c.querySelector(id); if (e) e.onclick = fn; };
    on('#sv', async () => { let icon; const f = c.querySelector('#si').files[0]; if (f) { const r = await upload(f); if (r.url) icon = r.url; } await emit('server:update', { serverId: s.id, name: c.querySelector('#sn').value, icon }); closeModal(); });
    on('#ni', async () => { await emit('server:update', { serverId: s.id, newInvite: true }); closeModal(); });
    on('#dl', async () => { if (confirm('Permanently delete this server and all its messages?')) { await emit('server:delete', { serverId: s.id }); closeModal(); } });
    on('#lv', async () => { if (confirm('Leave this server?')) { const r = await emit('server:leave', { serverId: s.id }); if (r.error) toast(r.error); closeModal(); } });
  });
}

// ---- Settings (profile, appearance, voice, notifications)
function settings(tab = 'appearance') {
  const tabs = { account: 'My Account', appearance: 'Appearance', voice: 'Voice & Video', notif: 'Notifications' };
  const c = modal('', c => {});
  const draw = async t => {
    let body = '';
    if (t === 'account') body = `<div class="form"><div style="display:flex;gap:12px;align-items:center">${avatarHTML(S.me).replace('class="avatar ', 'style="width:64px;height:64px;font-size:1.6em" class="avatar ')}<b>${esc(S.me.name)}</b></div>
      <label>Name / avatar color<input type="color" id="pc" value="${esc(S.me.color)}"></label><label class="full">Profile picture<input type="file" id="pa" accept="image/*"></label>
      <label class="full">About me<input id="pb" maxlength="160" value="${esc(S.me.bio || '')}"></label><div class="row"><button class="btn" id="rp">Remove picture</button><button class="btn primary" id="sp">Save</button><button class="btn danger" id="lo">Log out</button></div></div>`;
    if (t === 'appearance') body = `<div class="form"><b>Themes</b><div class="presets">${Object.entries(THEMES).map(([n, v]) => `<button data-p="${n}" style="background:${v.bg};color:${v.text};border-color:${v.accent}">${n}</button>`).join('')}</div>
      <label>Text color<input type="color" data-k="text" value="${theme.text}"></label>
      <label>Background color<input type="color" data-k="bg" value="${theme.bg}"></label>
      <label>Text background (behind messages)<span><input type="color" data-k="msgbg" value="${theme.msgbg.slice(0, 7)}"> <button class="btn" data-k2="msgbg">None</button></span></label>
      <label>Sidebar color<input type="color" data-k="panel" value="${theme.panel}"></label>
      <label>Server list / dark areas<input type="color" data-k="rail" value="${theme.rail}"></label>
      <label>Accent / button color<input type="color" data-k="accent" value="${theme.accent}"></label>
      <label>My username color<span><input type="color" data-k="ownColor" value="${theme.ownColor || S.me.color}"> <button class="btn" data-k2="ownColor">Default</button></span></label>
      <label>Font<select data-k="font">${Object.keys(FONTS).map(f => `<option ${f === theme.font ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      <label>Text size (${theme.fs}px)<input type="range" min="12" max="24" data-k="fs" value="${theme.fs}"></label>
      <label>Corner roundness (${theme.radius}px)<input type="range" min="0" max="20" data-k="radius" value="${theme.radius}"></label>
      <label>Message bubble padding (${theme.msgpad}px)<input type="range" min="0" max="14" data-k="msgpad" value="${theme.msgpad}"></label>
      <label class="full">Chat background image (URL)<input data-k="chatimg" placeholder="https://… or upload below" value="${esc(theme.chatimg)}"></label>
      <label class="full">…or upload a background image<input type="file" id="bgf" accept="image/*"></label>
      <label>Compact messages<input type="checkbox" data-k="compact" ${theme.compact ? 'checked' : ''}></label>
      <label>24-hour clock<input type="checkbox" data-k="h24" ${theme.h24 ? 'checked' : ''}></label>
      <div class="row"><button class="btn danger" id="rt">Reset to default</button></div></div>`;
    if (t === 'voice') {
      let devs = []; try { await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())); devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
      const opt = (kind, key) => `<select data-v="${key}"><option value="">Default</option>${devs.filter(d => d.kind === kind).map(d => `<option value="${esc(d.deviceId)}" ${store.get('dev_' + key) === d.deviceId ? 'selected' : ''}>${esc(d.label || d.kind)}</option>`).join('')}</select>`;
      body = `<div class="form"><label class="full">Microphone${opt('audioinput', 'mic')}</label><label class="full">Camera${opt('videoinput', 'cam')}</label>
        <label>Echo cancellation<input type="checkbox" data-av="echo" ${store.get('av_echo', true) ? 'checked' : ''}></label><label>Noise suppression<input type="checkbox" data-av="noise" ${store.get('av_noise', true) ? 'checked' : ''}></label>
        <p class="muted small">Device changes apply the next time you join a call.</p></div>`;
    }
    if (t === 'notif') body = `<div class="form"><label>Sound effects<input type="checkbox" data-k="sounds" ${theme.sounds ? 'checked' : ''}></label><label>Desktop notifications (DMs & mentions)<input type="checkbox" data-k="desktopNotif" ${theme.desktopNotif ? 'checked' : ''}></label></div>`;
    c.innerHTML = `<h2>Settings</h2><div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button data-t="${k}" class="${k === t ? 'on' : ''}">${v}</button>`).join('')}</div>${body}<div class="row"><button class="btn" id="cls">Close</button></div>`;
    c.querySelectorAll('[data-t]').forEach(b => b.onclick = () => draw(b.dataset.t)); c.querySelector('#cls').onclick = closeModal;
    c.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { Object.assign(theme, THEMES[b.dataset.p]); applyTheme(); draw('appearance'); });
    c.querySelectorAll('[data-k]').forEach(i => {
      i.oninput = i.onchange = async () => {
        const k = i.dataset.k; theme[k] = i.type === 'checkbox' ? i.checked : i.type === 'range' ? +i.value : i.value;
        if (k === 'msgbg') theme.msgbg = i.value + 'ff';
        if (k === 'desktopNotif' && i.checked && 'Notification' in window) { const p = await Notification.requestPermission(); if (p !== 'granted') { theme.desktopNotif = false; i.checked = false; toast('Notifications were blocked by the browser.'); } }
        applyTheme(); renderMessages(); renderMembers();
        if (i.type === 'range') { i.closest('label').firstChild.textContent = i.closest('label').firstChild.textContent.replace(/\(\d+px\)/, `(${i.value}px)`); }
      };
    });
    c.querySelectorAll('[data-k2]').forEach(b => b.onclick = () => { theme[b.dataset.k2] = b.dataset.k2 === 'msgbg' ? '#00000000' : ''; applyTheme(); renderMessages(); draw('appearance'); });
    const bg = c.querySelector('#bgf'); if (bg) bg.onchange = async () => { const r = await upload(bg.files[0]); if (r.url) { theme.chatimg = r.url; applyTheme(); draw('appearance'); } };
    const rt = c.querySelector('#rt'); if (rt) rt.onclick = () => { theme = { ...DEFAULT_THEME, members: theme.members }; applyTheme(); renderMessages(); draw('appearance'); };
    c.querySelectorAll('[data-v]').forEach(s => s.onchange = () => store.set('dev_' + s.dataset.v, s.value));
    c.querySelectorAll('[data-av]').forEach(s => s.onchange = () => store.set('av_' + s.dataset.av, s.checked));
    const sp = c.querySelector('#sp'); if (sp) sp.onclick = async () => { let avatar; const f = c.querySelector('#pa').files[0]; if (f) { const r = await upload(f); avatar = r.url; } await emit('profile:update', { color: c.querySelector('#pc').value, bio: c.querySelector('#pb').value, avatar }); toast('Profile saved'); closeModal(); };
    const rp = c.querySelector('#rp'); if (rp) rp.onclick = async () => { await emit('profile:update', { avatar: null }); closeModal(); };
    const lo = c.querySelector('#lo'); if (lo) lo.onclick = () => { store.set('token', null); location.reload(); };
  };
  draw(tab);
}

// =====================================================  TOASTS / SOUND / NOTIFY
function toast(text, action, ms = 4000) {
  const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = `<span>${esc(text)}</span>`;
  if (action) { const b = document.createElement('button'); b.className = 'btn primary'; b.textContent = action.label; b.onclick = () => { action.fn(); t.remove(); }; t.append(b); }
  $('#toasts').append(t); setTimeout(() => t.remove(), ms);
}
let actx; const audioCtx = () => actx || (actx = new (window.AudioContext || window.webkitAudioContext)());
function beep(freq = 600, dur = .1) { if (!theme.sounds) return; try { const c = audioCtx(), o = c.createOscillator(), g = c.createGain(); o.frequency.value = freq; g.gain.value = .05; o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + dur); } catch {} }
let ringT; function ring() { if (!theme.sounds) return; let n = 0; clearInterval(ringT); ringT = setInterval(() => { beep(n % 2 ? 520 : 700, .25); if (++n > 10) clearInterval(ringT); }, 450); }
function notify(title, body) { if (theme.desktopNotif && 'Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(title, { body }); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.cur.channelId) { S.unread[S.cur.channelId] = 0; renderRail(); renderSide(); } });

// =====================================================  VOICE & VIDEO (WebRTC mesh)
const V = { room: null, peers: {}, local: null, mic: null, cam: null, screen: null, muted: false, deaf: false, parts: [], tiles: {}, analysers: {} };

async function joinVoice(roomId) {
  if (V.room === roomId) return showCallView(true);
  if (V.room) await leaveVoice();
  let mic = null;
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: store.get('dev_mic') ? { exact: store.get('dev_mic') } : undefined, echoCancellation: store.get('av_echo', true), noiseSuppression: store.get('av_noise', true), autoGainControl: true } });
    mic = st.getAudioTracks()[0];
  } catch (e) { toast(window.isSecureContext ? 'No microphone available — joining listen-only.' : 'Microphone needs a secure (https) connection.'); }
  V.mic = mic; V.local = new MediaStream(); if (mic) V.local.addTrack(mic);
  V.muted = false; V.deaf = false; V.cam = null; V.screen = null;
  const r = await emit('voice:join', { roomId });
  if (r.error) { mic?.stop(); V.mic = null; return toast(r.error); }
  V.room = roomId; V.parts = S.voiceRooms[roomId] || [];
  for (const p of r.peers) connectPeer(p.sid, true);
  beep(880, .12);
  if (!(curChannel()?.id === roomId)) { const f = findChannelServer(roomId); if (f) selectChannel(f, roomId); else selectChannel(null, roomId); }
  showCallView(true); renderAll(); renderCall();
}
function findChannelServer(cid) { for (const s of Object.values(S.servers)) if (s.channels.some(c => c.id === cid)) return s.id; return null; }
async function leaveVoice() {
  if (!V.room) return;
  await emit('voice:leave');
  for (const sid of Object.keys(V.peers)) closePeer(sid);
  for (const t of [V.mic, V.cam, V.screen]) t?.stop();
  for (const k in V.analysers) { clearInterval(V.analysers[k].t); } V.analysers = {};
  Object.assign(V, { room: null, local: null, mic: null, cam: null, screen: null, muted: false, deaf: false, parts: [], tiles: {} });
  beep(330, .15); showCallView(false); renderAll();
}
function connectPeer(sid, initiator) {
  if (V.peers[sid]) return V.peers[sid];
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const p = V.peers[sid] = { pc, making: false, ignore: false, polite: socket.id > sid, remote: new MediaStream() };
  pc.onicecandidate = e => { if (e.candidate) socket.emit('signal', { to: sid, data: { candidate: e.candidate } }); };
  pc.onnegotiationneeded = async () => { try { p.making = true; await pc.setLocalDescription(); socket.emit('signal', { to: sid, data: { description: pc.localDescription } }); } catch (e) { console.warn(e); } finally { p.making = false; } };
  pc.ontrack = e => { p.remote = e.streams[0] || p.remote; if (!e.streams[0]) p.remote.addTrack(e.track); renderCall(); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce(); };
  if (initiator) { for (const k of ['audio', 'video']) pc.addTransceiver(k, { direction: 'sendrecv', streams: [V.local] }); syncSenders(p); }
  return p;
}
function syncSenders(p) {
  for (const t of p.pc.getTransceivers()) {
    if (t.stopped || !t.receiver.track) continue;
    const track = t.receiver.track.kind === 'audio' ? V.mic : (V.screen || V.cam);
    if (t.sender.track !== track) t.sender.replaceTrack(track || null).catch(() => {});
  }
}
function closePeer(sid) { const p = V.peers[sid]; if (!p) return; p.pc.close(); delete V.peers[sid]; const t = V.tiles[sid]; if (t) { t.el.remove(); delete V.tiles[sid]; } if (V.analysers[sid]) { clearInterval(V.analysers[sid].t); delete V.analysers[sid]; } }
async function onSignal({ from, data }) {
  if (!V.room) return;
  const p = connectPeer(from, false), pc = p.pc;
  try {
    if (data.description) {
      const d = data.description, collision = d.type === 'offer' && (p.making || pc.signalingState !== 'stable');
      p.ignore = !p.polite && collision; if (p.ignore) return;
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        for (const t of pc.getTransceivers()) { if (!t.stopped) { try { t.direction = 'sendrecv'; t.sender.setStreams?.(V.local); } catch {} } }
        syncSenders(p);
        await pc.setLocalDescription();
        socket.emit('signal', { to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) { try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignore) throw e; } }
  } catch (e) { console.warn('signal', e); }
}
function pushState() { socket.emit('voice:state', { muted: V.muted || !V.mic, deafened: V.deaf, video: !!V.cam, screen: !!V.screen }); }
function toggleMute() {
  if (!V.room) return toast('Join a voice channel first.');
  if (!V.mic) return toast('No microphone available.');
  V.muted = !V.muted; V.mic.enabled = !V.muted; if (!V.muted && V.deaf) toggleDeaf(true);
  pushState(); renderUserPanel(); renderCallbar(); renderCall();
}
function toggleDeaf(silent) {
  if (!V.room) return toast('Join a voice channel first.');
  V.deaf = !V.deaf; if (V.deaf && !V.muted && V.mic) { V.muted = true; V.mic.enabled = false; }
  applyDeaf(); pushState(); renderUserPanel(); renderCallbar(); renderCall();
}
function applyDeaf() { for (const [sid, t] of Object.entries(V.tiles)) t.video.muted = V.deaf || sid === socket.id; }
async function toggleCamera() {
  if (!V.room) return;
  if (V.cam) { V.cam.stop(); V.cam = null; }
  else {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: { deviceId: store.get('dev_cam') ? { exact: store.get('dev_cam') } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } } });
      V.cam = st.getVideoTracks()[0]; V.cam.onended = () => { V.cam = null; afterVideoChange(); };
    } catch (e) { return toast('Could not access the camera: ' + (e.message || e.name)); }
  }
  afterVideoChange();
}
async function toggleScreen() {
  if (!V.room) return;
  if (V.screen) { V.screen.stop(); V.screen = null; }
  else {
    if (!navigator.mediaDevices.getDisplayMedia) return toast('Screen sharing is not supported on this device.');
    try { const st = await navigator.mediaDevices.getDisplayMedia({ video: true }); V.screen = st.getVideoTracks()[0]; V.screen.onended = () => { V.screen = null; afterVideoChange(); }; }
    catch { return; }
  }
  afterVideoChange();
}
function afterVideoChange() {
  const vt = V.screen || V.cam;
  for (const t of V.local.getVideoTracks()) V.local.removeTrack(t);
  if (vt) V.local.addTrack(vt);
  for (const p of Object.values(V.peers)) syncSenders(p);
  pushState(); renderCall(); renderCallbar();
}

// ---- call UI
function showCallView(on) {
  const cv = $('#callview'); cv.hidden = !on; cv.classList.toggle('active', on);
  $('#chat').hidden = on; if (on) { cv.style.display = 'flex'; renderCall(); } else cv.style.display = '';
  renderTop();
}
function renderCall() {
  const cv = $('#callview'); if (cv.hidden) return;
  if (!V.room) {
    cv.innerHTML = `<div class="empty" style="margin:auto;text-align:center"><h2>🔊 ${esc(curChannel()?.name || '')}</h2><p>Nobody is here yet.</p><button class="btn primary" id="jv">Join voice</button></div>`;
    $('#jv').onclick = () => joinVoice(S.cur.channelId); return;
  }
  let grid = $('#grid');
  if (!grid) { cv.innerHTML = '<div id="grid"></div><div id="ctrls"></div>'; grid = $('#grid'); }
  const seen = new Set();
  for (const part of V.parts) {
    seen.add(part.sid); const self = part.sid === socket.id, u = userOf(part.userId);
    let t = V.tiles[part.sid];
    if (!t) {
      const el = document.createElement('div'); el.className = 'tile';
      el.innerHTML = `<video autoplay playsinline></video><div class="ph"></div><div class="label"></div>`;
      const video = el.querySelector('video'); video.muted = self || V.deaf; el.ondblclick = () => el.requestFullscreen?.();
      t = V.tiles[part.sid] = { el, video, ph: el.querySelector('.ph'), label: el.querySelector('.label') };
    }
    const stream = self ? V.local : V.peers[part.sid]?.remote;
    if (t.video.srcObject !== stream) { t.video.srcObject = stream || null; if (stream) watchSpeaking(part.sid, stream); }
    const showVideo = part.video || part.screen;
    t.video.style.display = showVideo ? '' : 'none'; t.el.classList.toggle('screen', !!part.screen);
    t.ph.innerHTML = showVideo ? '' : avatarHTML(u);
    t.label.innerHTML = `${esc(u.name)}${self ? ' (you)' : ''} ${part.deafened ? '🔇' : part.muted ? '🎙️❌' : ''}${part.screen ? ' 🖥' : ''}`;
    t.video.play?.().catch(() => {});
    if (t.el.parentNode !== grid) grid.append(t.el);
  }
  for (const sid of Object.keys(V.tiles)) if (!seen.has(sid)) { V.tiles[sid].el.remove(); delete V.tiles[sid]; }
  const n = V.parts.length; grid.style.gridTemplateColumns = `repeat(auto-fit,minmax(${n <= 2 ? 320 : n <= 4 ? 260 : 200}px,1fr))`;
  const me = V.parts.find(p => p.sid === socket.id) || {};
  $('#ctrls').innerHTML = `<button class="btn ${V.muted ? 'off' : ''}" data-c="mute">${V.muted ? '🎙️❌ Unmute' : '🎙️ Mute'}</button><button class="btn ${V.deaf ? 'off' : ''}" data-c="deaf">${V.deaf ? '🔇 Undeafen' : '🎧 Deafen'}</button>
    <button class="btn ${V.cam ? 'on' : ''}" data-c="cam">${V.cam ? '📹 Camera on' : '📷 Camera off'}</button><button class="btn ${V.screen ? 'on' : ''}" data-c="scr">🖥 ${V.screen ? 'Stop sharing' : 'Share screen'}</button><button class="btn off" data-c="leave">📞 Leave</button>`;
  $('#ctrls').onclick = e => { const c = e.target.closest('button')?.dataset.c; ({ mute: toggleMute, deaf: toggleDeaf, cam: toggleCamera, scr: toggleScreen, leave: leaveVoice })[c]?.(); };
  applyDeaf();
}
function watchSpeaking(sid, stream) {
  if (V.analysers[sid]) clearInterval(V.analysers[sid].t);
  if (!stream.getAudioTracks().length && sid !== socket.id) { /* tracks may arrive later */ }
  try {
    const c = audioCtx(), src = c.createMediaStreamSource(stream), an = c.createAnalyser(); an.fftSize = 256; src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    V.analysers[sid] = { t: setInterval(() => { an.getByteFrequencyData(buf); const lvl = buf.reduce((a, b) => a + b, 0) / buf.length; const tile = V.tiles[sid]; if (tile) tile.el.classList.toggle('speaking', lvl > 18 && !(sid === socket.id && V.muted)); }, 150) };
  } catch {}
}
function renderCallbar() {
  const b = $('#callbar'); b.hidden = !V.room; if (!V.room) return;
  const f = findChannelServer(V.room), name = f ? S.servers[f].channels.find(c => c.id === V.room)?.name : S.dms[V.room]?.name;
  b.innerHTML = `<div><b style="color:#23a55a">● Voice connected</b><div class="muted small" style="cursor:pointer" id="cbn">${esc(name || '')} — click to open</div></div>
    <div class="row"><button class="btn" data-c="cam" title="Camera">${V.cam ? '📹' : '📷'}</button><button class="btn" data-c="scr" title="Share screen">🖥</button><button class="btn" data-c="leave" title="Leave call">📞✕</button></div>`;
  $('#cbn').onclick = () => { if (S.cur.channelId !== V.room) selectChannel(f, V.room); showCallView(true); };
  b.querySelectorAll('[data-c]').forEach(x => x.onclick = () => ({ cam: toggleCamera, scr: toggleScreen, leave: leaveVoice })[x.dataset.c]());
}
// leaving the call view when selecting a text channel is handled in selectChannel via showCallView(false)

// =====================================================  BOOT
const inviteParam = new URLSearchParams(location.search).get('invite');
if (inviteParam) { store.set('pendingInvite', inviteParam); history.replaceState({}, '', location.pathname); }
const _onReady = onReady;
onReady = function (d) { _onReady(d); const inv = store.get('pendingInvite'); if (inv) { store.set('pendingInvite', null); emit('server:join', { code: inv }).then(r => { if (r.error) return toast(r.error); setServer(r.server); selectChannel(r.server.id, r.server.channels.find(c => c.type === 'text').id); toast('Joined ' + r.server.name + '!'); }); } };
setInterval(() => { if (S.cur.channelId) renderTyping(); }, 1000);
if (token) start();
