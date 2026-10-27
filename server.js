const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ---------- storage (JSON file, debounced writes) ----------
let db = { users: {}, servers: {}, messages: {}, dms: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch {}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE + '.tmp', JSON.stringify(db), err => {
      if (!err) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {});
    });
  }, 400);
}
process.on('SIGTERM', () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch {} process.exit(0); });

const uid = () => crypto.randomBytes(8).toString('hex');
const tokenIndex = {};
for (const u of Object.values(db.users)) for (const t of u.tokens || []) tokenIndex[t] = u.id;
const userByName = n => Object.values(db.users).find(u => u.name.toLowerCase() === String(n).toLowerCase());

function hash(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }
function pub(u) { return u && { id: u.id, name: u.name, color: u.color, avatar: u.avatar || null, bio: u.bio || '' }; }

// ---------- http ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6, cors: { origin: true } });
app.use(express.json({ limit: '100kb' }));
app.disable('x-powered-by');

const attempts = {};
function limited(ip) {
  const now = Date.now();
  attempts[ip] = (attempts[ip] || []).filter(t => now - t < 60000);
  if (attempts[ip].length >= 15) return true;
  attempts[ip].push(now);
  return false;
}
const COLORS = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#3ba7ff', '#f47b67', '#9b59b6', '#1abc9c'];

function issueToken(u) {
  const t = crypto.randomBytes(24).toString('hex');
  u.tokens = [...(u.tokens || []).slice(-9), t];
  tokenIndex[t] = u.id;
  save();
  return t;
}

app.post('/api/register', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute.' });
  const { name, password } = req.body || {};
  if (!/^[\w .-]{2,24}$/.test(name || '')) return res.json({ error: 'Username must be 2-24 characters (letters, numbers, space . _ -).' });
  if (typeof password !== 'string' || password.length < 6) return res.json({ error: 'Password must be at least 6 characters.' });
  if (userByName(name)) return res.json({ error: 'That username is taken.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: uid(), name: name.trim(), salt, pw: hash(password, salt), color: COLORS[Math.floor(Math.random() * COLORS.length)], tokens: [], created: Date.now() };
  db.users[u.id] = u;
  res.json({ token: issueToken(u) });
});
app.post('/api/login', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute.' });
  const { name, password } = req.body || {};
  const u = userByName(name || '');
  if (!u || hash(String(password), u.salt) !== u.pw) return res.json({ error: 'Wrong username or password.' });
  res.json({ token: issueToken(u) });
});
app.get('/api/ice', (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URLS) iceServers.push({ urls: process.env.TURN_URLS.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  res.json({ iceServers });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, uid() + uid() + (path.extname(file.originalname).replace(/[^.\w]/g, '').slice(0, 10)))
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
}).single('file');
app.post('/api/upload', (req, res) => {
  if (!tokenIndex[req.headers['x-token']]) return res.status(401).json({ error: 'Not signed in' });
  upload(req, res, err => {
    if (err || !req.file) return res.json({ error: err ? err.message : 'No file' });
    const f = req.file;
    res.json({ url: '/uploads/' + f.filename, name: f.originalname.slice(0, 120), size: f.size, type: f.mimetype });
  });
});
const INLINE = /\.(png|jpe?g|gif|webp|mp4|webm|mov|mp3|ogg|wav|m4a)$/i;
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders: (res, p) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!INLINE.test(p)) res.setHeader('Content-Disposition', 'attachment');
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const onlineCount = {};          // userId -> socket count
const voice = new Map();         // roomId -> Map(sid -> state)

const dmKey = (a, b) => 'dm:' + [a, b].sort().join(':');
function findChannel(id) {
  for (const s of Object.values(db.servers)) { const c = s.channels.find(c => c.id === id); if (c) return { server: s, channel: c }; }
  return null;
}
function scopeOf(channelId) {   // -> { rooms:[...], allowed:(userId)=>bool, server? }
  if (channelId.startsWith('dm:')) {
    const [, a, b] = channelId.split(':');
    return { rooms: ['u:' + a, 'u:' + b], allowed: id => id === a || id === b, type: 'text' };
  }
  const f = findChannel(channelId);
  if (!f) return null;
  return { rooms: ['s:' + f.server.id], allowed: id => f.server.members.includes(id), server: f.server, type: f.channel.type };
}
function serializeServer(s) {
  return {
    id: s.id, name: s.name, ownerId: s.ownerId, invite: s.invite, color: s.color, icon: s.icon || null, channels: s.channels,
    members: s.members.map(id => ({ ...pub(db.users[id]), online: !!onlineCount[id] }))
  };
}
const userServers = id => Object.values(db.servers).filter(s => s.members.includes(id));
function broadcastVoice(roomId) {
  const sc = scopeOf(roomId); if (!sc) return;
  const m = voice.get(roomId);
  const parts = m ? [...m].map(([sid, st]) => ({ sid, ...st })) : [];
  io.to(sc.rooms).emit('voice:update', { roomId, parts });
}
function leaveVoice(socket) {
  const roomId = socket.voiceRoom; if (!roomId) return;
  socket.voiceRoom = null;
  socket.leave('v:' + roomId);
  const m = voice.get(roomId);
  if (m) { m.delete(socket.id); if (!m.size) voice.delete(roomId); }
  broadcastVoice(roomId);
}
function presence(userId, online) {
  for (const s of userServers(userId)) io.to('s:' + s.id).emit('presence', { userId, online });
}
const clean = (s, n) => String(s || '').trim().slice(0, n);

// ---------- sockets ----------
io.use((socket, next) => {
  const id = tokenIndex[socket.handshake.auth && socket.handshake.auth.token];
  if (!id || !db.users[id]) return next(new Error('auth'));
  socket.user = db.users[id];
  next();
});

io.on('connection', socket => {
  const me = socket.user;
  socket.join('u:' + me.id);
  for (const s of userServers(me.id)) socket.join('s:' + s.id);
  onlineCount[me.id] = (onlineCount[me.id] || 0) + 1;
  if (onlineCount[me.id] === 1) presence(me.id, true);

  const dmList = (db.dms[me.id] || []).map(oid => ({ channelId: dmKey(me.id, oid), user: { ...pub(db.users[oid]), online: !!onlineCount[oid] } })).filter(d => d.user.id);
  const rooms = {};
  for (const [roomId, m] of voice) {
    const sc = scopeOf(roomId);
    if (sc && sc.allowed(me.id)) rooms[roomId] = [...m].map(([sid, st]) => ({ sid, ...st }));
  }
  socket.emit('ready', { me: pub(me), servers: userServers(me.id).map(serializeServer), dms: dmList, voiceRooms: rooms });

  const on = (ev, fn) => socket.on(ev, async (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    try { ack(await fn(data || {}) || {}); } catch (e) { console.error(ev, e); ack({ error: 'Server error' }); }
  });

  // ----- servers & channels
  on('server:create', ({ name }) => {
    name = clean(name, 50); if (!name) return { error: 'Name required' };
    const s = { id: uid(), name, ownerId: me.id, invite: crypto.randomBytes(4).toString('hex'), color: COLORS[Math.floor(Math.random() * COLORS.length)], members: [me.id],
      channels: [{ id: uid(), name: 'general', type: 'text' }, { id: uid(), name: 'General', type: 'voice' }] };
    db.servers[s.id] = s; save();
    socket.join('s:' + s.id);
    return { server: serializeServer(s) };
  });
  on('server:join', ({ code }) => {
    code = clean(code, 100).split('/').pop().toLowerCase();
    const s = Object.values(db.servers).find(s => s.invite === code);
    if (!s) return { error: 'Invalid invite code.' };
    if (!s.members.includes(me.id)) { s.members.push(me.id); save(); }
    io.in('u:' + me.id).socketsJoin('s:' + s.id);
    io.to('s:' + s.id).emit('server:update', serializeServer(s));
    return { server: serializeServer(s) };
  });
  const ownerOf = id => { const s = db.servers[id]; return s && s.ownerId === me.id ? s : null; };
  on('server:update', ({ serverId, name, icon, newInvite }) => {
    const s = ownerOf(serverId); if (!s) return { error: 'Only the owner can do that' };
    if (name) s.name = clean(name, 50) || s.name;
    if (icon !== undefined) s.icon = typeof icon === 'string' && icon.startsWith('/uploads/') ? icon : null;
    if (newInvite) s.invite = crypto.randomBytes(4).toString('hex');
    save(); io.to('s:' + s.id).emit('server:update', serializeServer(s));
  });
  on('server:delete', ({ serverId }) => {
    const s = ownerOf(serverId); if (!s) return { error: 'Only the owner can do that' };
    for (const c of s.channels) { delete db.messages[c.id]; voice.delete(c.id); }
    delete db.servers[s.id]; save();
    io.to('s:' + s.id).emit('server:removed', { serverId: s.id });
    io.in('s:' + s.id).socketsLeave('s:' + s.id);
  });
  on('server:leave', ({ serverId }) => {
    const s = db.servers[serverId]; if (!s || !s.members.includes(me.id)) return { error: 'Not a member' };
    if (s.ownerId === me.id) return { error: 'Owners must delete the server instead.' };
    s.members = s.members.filter(i => i !== me.id); save();
    io.in('u:' + me.id).socketsLeave('s:' + s.id);
    io.to('u:' + me.id).emit('server:removed', { serverId: s.id });
    io.to('s:' + s.id).emit('server:update', serializeServer(s));
  });
  on('server:kick', ({ serverId, userId }) => {
    const s = ownerOf(serverId); if (!s || userId === me.id) return { error: 'Not allowed' };
    s.members = s.members.filter(i => i !== userId); save();
    io.to('u:' + userId).emit('server:removed', { serverId: s.id });
    io.in('u:' + userId).socketsLeave('s:' + s.id);
    io.to('s:' + s.id).emit('server:update', serializeServer(s));
  });
  on('channel:create', ({ serverId, name, type }) => {
    const s = ownerOf(serverId); if (!s) return { error: 'Only the owner can do that' };
    name = clean(name, 40).toLowerCase().replace(/\s+/g, type === 'voice' ? ' ' : '-'); if (!name) return { error: 'Name required' };
    if (s.channels.length >= 50) return { error: 'Too many channels' };
    s.channels.push({ id: uid(), name, type: type === 'voice' ? 'voice' : 'text' }); save();
    io.to('s:' + s.id).emit('server:update', serializeServer(s));
  });
  on('channel:delete', ({ serverId, channelId }) => {
    const s = ownerOf(serverId); if (!s) return { error: 'Only the owner can do that' };
    if (s.channels.length <= 1) return { error: 'A server needs at least one channel.' };
    s.channels = s.channels.filter(c => c.id !== channelId); delete db.messages[channelId]; save();
    io.to('s:' + s.id).emit('server:update', serializeServer(s));
  });

  // ----- profile / DMs
  on('profile:update', ({ color, avatar, bio }) => {
    if (/^#[0-9a-f]{6}$/i.test(color || '')) me.color = color;
    if (avatar !== undefined) me.avatar = typeof avatar === 'string' && avatar.startsWith('/uploads/') ? avatar : null;
    if (bio !== undefined) me.bio = clean(bio, 160);
    save();
    const payload = pub(me);
    io.to('u:' + me.id).emit('user:update', payload);
    for (const s of userServers(me.id)) { io.to('s:' + s.id).emit('server:update', serializeServer(s)); }
    for (const oid of db.dms[me.id] || []) io.to('u:' + oid).emit('user:update', payload);
  });
  on('dm:open', ({ name, userId }) => {
    const other = userId ? db.users[userId] : userByName(clean(name, 30));
    if (!other) return { error: 'No user with that name.' };
    if (other.id === me.id) return { error: "You can't DM yourself." };
    for (const [a, b] of [[me.id, other.id], [other.id, me.id]]) { db.dms[a] = db.dms[a] || []; if (!db.dms[a].includes(b)) db.dms[a].push(b); }
    save();
    io.to('u:' + other.id).emit('dm:added', { channelId: dmKey(me.id, other.id), user: { ...pub(me), online: true } });
    return { channelId: dmKey(me.id, other.id), user: { ...pub(other), online: !!onlineCount[other.id] } };
  });
  on('users:search', ({ q }) => {
    q = clean(q, 30).toLowerCase(); if (q.length < 1) return { users: [] };
    return { users: Object.values(db.users).filter(u => u.id !== me.id && u.name.toLowerCase().includes(q)).slice(0, 8).map(pub) };
  });

  // ----- messages
  on('history', ({ channelId, before }) => {
    const sc = scopeOf(String(channelId)); if (!sc || !sc.allowed(me.id)) return { error: 'No access' };
    let list = db.messages[channelId] || [];
    if (before) list = list.filter(m => m.ts < before);
    const messages = list.slice(-60);
    const users = {};
    for (const m of messages) users[m.userId] = pub(db.users[m.userId]);
    return { messages, users, more: list.length > messages.length };
  });
  on('msg:send', ({ channelId, content, attachments, replyTo }) => {
    const sc = scopeOf(String(channelId)); if (!sc || !sc.allowed(me.id) || sc.type !== 'text') return { error: 'No access' };
    content = String(content || '').slice(0, 4000);
    attachments = (Array.isArray(attachments) ? attachments : []).slice(0, 10)
      .filter(a => a && typeof a.url === 'string' && a.url.startsWith('/uploads/') && !a.url.includes('..'))
      .map(a => ({ url: a.url, name: clean(a.name, 120), type: clean(a.type, 80), size: Number(a.size) || 0 }));
    if (!content.trim() && !attachments.length) return { error: 'Empty' };
    const m = { id: uid(), channelId, userId: me.id, content, attachments, ts: Date.now(), edited: false, replyTo: replyTo ? String(replyTo) : null, reactions: {} };
    const arr = (db.messages[channelId] = db.messages[channelId] || []);
    arr.push(m); if (arr.length > 3000) arr.splice(0, arr.length - 3000);
    if (channelId.startsWith('dm:')) { const [, a, b] = channelId.split(':'); for (const [x, y] of [[a, b], [b, a]]) { db.dms[x] = db.dms[x] || []; if (!db.dms[x].includes(y)) db.dms[x].push(y); } }
    save();
    io.to(sc.rooms).emit('msg:new', { message: m, user: pub(me) });
  });
  const ownMsg = (channelId, id) => {
    const sc = scopeOf(String(channelId)); if (!sc || !sc.allowed(me.id)) return {};
    const m = (db.messages[channelId] || []).find(m => m.id === id);
    return { sc, m };
  };
  on('msg:edit', ({ channelId, id, content }) => {
    const { sc, m } = ownMsg(channelId, id); if (!m || m.userId !== me.id) return { error: 'Not allowed' };
    content = String(content || '').slice(0, 4000); if (!content.trim()) return { error: 'Empty' };
    m.content = content; m.edited = true; save();
    io.to(sc.rooms).emit('msg:update', { channelId, message: m });
  });
  on('msg:delete', ({ channelId, id }) => {
    const { sc, m } = ownMsg(channelId, id); if (!m) return { error: 'Not found' };
    if (m.userId !== me.id && !(sc.server && sc.server.ownerId === me.id)) return { error: 'Not allowed' };
    db.messages[channelId] = db.messages[channelId].filter(x => x.id !== id); save();
    io.to(sc.rooms).emit('msg:delete', { channelId, id });
  });
  on('msg:react', ({ channelId, id, emoji }) => {
    const { sc, m } = ownMsg(channelId, id); if (!m) return { error: 'Not found' };
    emoji = clean(emoji, 16); if (!emoji) return;
    const list = (m.reactions[emoji] = m.reactions[emoji] || []);
    const i = list.indexOf(me.id);
    if (i >= 0) list.splice(i, 1); else if (Object.keys(m.reactions).length < 20) list.push(me.id);
    if (!list.length) delete m.reactions[emoji];
    save();
    io.to(sc.rooms).emit('msg:update', { channelId, message: m });
  });
  socket.on('typing', ({ channelId } = {}) => {
    const sc = scopeOf(String(channelId)); if (!sc || !sc.allowed(me.id)) return;
    socket.to(sc.rooms).emit('typing', { channelId, userId: me.id, name: me.name });
  });

  // ----- voice / video (signaling only; media is peer-to-peer WebRTC)
  on('voice:join', ({ roomId }) => {
    roomId = String(roomId);
    const sc = scopeOf(roomId); if (!sc || !sc.allowed(me.id)) return { error: 'No access' };
    if (sc.type !== 'voice' && !roomId.startsWith('dm:')) return { error: 'Not a voice channel' };
    leaveVoice(socket);
    let m = voice.get(roomId); const wasEmpty = !m || !m.size;
    if (!m) voice.set(roomId, (m = new Map()));
    if (m.size >= 12) return { error: 'This call is full (12 people max).' };
    const peers = [...m].map(([sid, st]) => ({ sid, ...st }));
    m.set(socket.id, { userId: me.id, muted: false, deafened: false, video: false, screen: false });
    socket.voiceRoom = roomId; socket.join('v:' + roomId);
    broadcastVoice(roomId);
    if (roomId.startsWith('dm:') && wasEmpty) {
      const [, a, b] = roomId.split(':');
      io.to('u:' + (a === me.id ? b : a)).emit('dm:ring', { channelId: roomId, from: pub(me) });
    }
    return { peers };
  });
  on('voice:leave', () => { leaveVoice(socket); });
  on('voice:state', st => {
    const m = voice.get(socket.voiceRoom); if (!m || !m.has(socket.id)) return;
    const cur = m.get(socket.id);
    for (const k of ['muted', 'deafened', 'video', 'screen']) if (typeof st[k] === 'boolean') cur[k] = st[k];
    broadcastVoice(socket.voiceRoom);
  });
  socket.on('signal', ({ to, data } = {}) => {
    const m = voice.get(socket.voiceRoom);
    if (m && m.has(to)) io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    leaveVoice(socket);
    onlineCount[me.id] = Math.max(0, (onlineCount[me.id] || 1) - 1);
    if (!onlineCount[me.id]) { delete onlineCount[me.id]; presence(me.id, false); }
  });
});

server.listen(PORT, () => console.log('Chatcord running on http://localhost:' + PORT));
