'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// In-memory game state
// ---------------------------------------------------------------------------
/**
 * rooms[code] = {
 *   code, hostSocket, mode: 'numbers'|'words',
 *   status: 'lobby'|'collecting'|'playing'|'ended',
 *   settings: { intervalSec, linesToWin, wordsPerPlayer, category },
 *   players: { [pid]: { pid, name, socketId, card:[[v]], won, lines, submittedWords:[] } },
 *   pool: [],           // all callable values
 *   callOrder: [],      // shuffled remaining
 *   called: [],         // called in order
 *   calledSet: Set,
 *   timer, winners: []
 * }
 */
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const FREE = '★';
// Official 75-ball bingo column ranges: B 1-15, I 16-30, N 31-45, G 46-60, O 61-75.
const COL_RANGES = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];

function makeNumberCard() {
  const cols = COL_RANGES.map(([lo, hi]) => {
    const nums = [];
    for (let n = lo; n <= hi; n++) nums.push(n);
    return shuffle(nums).slice(0, 5);
  });
  const card = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) row.push(cols[c][r]);
    card.push(row);
  }
  card[2][2] = FREE; // free center space, always marked
  return card;
}

function makeWordCard(pool) {
  const picked = shuffle(pool).slice(0, 25);
  const card = [];
  for (let r = 0; r < 5; r++) card.push(picked.slice(r * 5, r * 5 + 5));
  return card;
}

function makeCardForRoom(room) {
  return room.mode === 'numbers' ? makeNumberCard() : makeWordCard(room.pool);
}

function countLines(card, calledSet) {
  const marked = (v) => v === FREE || calledSet.has(v); // free center always counts
  let lines = 0;
  // rows
  for (let r = 0; r < 5; r++) {
    if (card[r].every(marked)) lines++;
  }
  // cols
  for (let c = 0; c < 5; c++) {
    let ok = true;
    for (let r = 0; r < 5; r++) if (!marked(card[r][c])) { ok = false; break; }
    if (ok) lines++;
  }
  // diagonals
  let d1 = true, d2 = true;
  for (let i = 0; i < 5; i++) {
    if (!marked(card[i][i])) d1 = false;
    if (!marked(card[i][4 - i])) d2 = false;
  }
  if (d1) lines++;
  if (d2) lines++;
  return lines;
}

function publicPlayers(room) {
  return Object.values(room.players).map((p) => ({
    pid: p.pid,
    name: p.name,
    lines: p.lines || 0,
    won: !!p.won,
    online: !!p.socketId,
    wordCount: (p.submittedWords || []).length,
  }));
}

function uniqueWordCount(room) {
  const set = new Set();
  for (const p of Object.values(room.players)) {
    for (const w of p.submittedWords || []) set.add(w);
  }
  return set.size;
}

function roomSummary(room) {
  return {
    code: room.code,
    mode: room.mode,
    status: room.status,
    settings: room.settings,
    called: room.called,
    poolSize: room.pool.length,
    uniqueWords: room.mode === 'words' ? uniqueWordCount(room) : null,
    players: publicPlayers(room),
    winners: room.winners,
  };
}

function broadcastRoom(room) {
  const summary = roomSummary(room);
  io.to('host:' + room.code).emit('room:update', summary);
  io.to('room:' + room.code).emit('room:update', summary);
}

function startCalling(room) {
  if (room.timer) clearInterval(room.timer);
  room.callOrder = shuffle(room.pool);
  const tick = () => {
    if (room.status !== 'playing') return;
    if (room.callOrder.length === 0) {
      endGame(room, 'pool-exhausted');
      return;
    }
    const value = room.callOrder.shift();
    room.called.push(value);
    room.calledSet.add(value);
    io.to('room:' + room.code).emit('game:call', { value, called: room.called });
    io.to('host:' + room.code).emit('game:call', { value, called: room.called });

    // recompute lines & winners
    const newWinners = [];
    for (const p of Object.values(room.players)) {
      p.lines = countLines(p.card, room.calledSet);
      if (!p.won && p.lines >= room.settings.linesToWin) {
        p.won = true;
        p.wonAtCall = room.called.length;
        newWinners.push({ pid: p.pid, name: p.name, lines: p.lines, atCall: p.wonAtCall });
      }
      if (p.socketId) {
        io.to(p.socketId).emit('player:state', { lines: p.lines, won: p.won, called: room.called });
      }
    }
    if (newWinners.length) {
      room.winners.push(...newWinners);
      io.to('room:' + room.code).emit('game:winners', room.winners);
      io.to('host:' + room.code).emit('game:winners', room.winners);
      endGame(room, 'winner');
    }
    broadcastRoom(room);
  };
  room.timer = setInterval(tick, Math.max(1, room.settings.intervalSec) * 1000);
  tick(); // call first immediately
}

function endGame(room, reason) {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
  room.status = 'ended';
  io.to('room:' + room.code).emit('game:end', { reason, winners: room.winners });
  io.to('host:' + room.code).emit('game:end', { reason, winners: room.winners });
  broadcastRoom(room);
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // ---- HOST ----
  socket.on('host:create', (cfg, cb) => {
    const code = genCode();
    const mode = cfg && cfg.mode === 'words' ? 'words' : 'numbers';
    const room = {
      code,
      hostSocket: socket.id,
      mode,
      status: mode === 'words' ? 'collecting' : 'lobby',
      settings: {
        intervalSec: Math.min(60, Math.max(1, parseInt(cfg.intervalSec, 10) || 4)),
        linesToWin: Math.min(12, Math.max(1, parseInt(cfg.linesToWin, 10) || 3)),
        wordsPerPlayer: Math.min(10, Math.max(1, parseInt(cfg.wordsPerPlayer, 10) || 3)),
        category: (cfg.category || '').toString().slice(0, 60),
      },
      players: {},
      pool: mode === 'numbers' ? Array.from({ length: 75 }, (_, i) => i + 1) : [],
      callOrder: [],
      called: [],
      calledSet: new Set(),
      timer: null,
      winners: [],
    };
    rooms[code] = room;
    socket.join('host:' + code);
    socket.data.hostCode = code;
    if (cb) cb({ ok: true, room: roomSummary(room) });
  });

  socket.on('host:rejoin', (code, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: 'no-room' });
    room.hostSocket = socket.id;
    socket.join('host:' + code);
    socket.data.hostCode = code;
    if (cb) cb({ ok: true, room: roomSummary(room) });
  });

  socket.on('host:start', (cb) => {
    const code = socket.data.hostCode;
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: 'no-room' });

    if (room.mode === 'words') {
      // build pool from unique submitted words
      const set = new Set();
      for (const p of Object.values(room.players)) {
        for (const w of p.submittedWords || []) set.add(w);
      }
      room.pool = Array.from(set);
      if (room.pool.length < 25) {
        return cb && cb({ ok: false, error: 'need-words', have: room.pool.length, need: 25 });
      }
    }
    if (Object.keys(room.players).length === 0) {
      return cb && cb({ ok: false, error: 'no-players' });
    }
    // (re)generate cards for everyone now that pool is final
    for (const p of Object.values(room.players)) {
      p.card = makeCardForRoom(room);
      p.lines = 0;
      p.won = false;
      if (p.socketId) io.to(p.socketId).emit('player:card', { card: p.card, mode: room.mode });
    }
    room.status = 'playing';
    room.called = [];
    room.calledSet = new Set();
    room.winners = [];
    startCalling(room);
    broadcastRoom(room);
    if (cb) cb({ ok: true });
  });

  socket.on('host:reset', (cb) => {
    const code = socket.data.hostCode;
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false });
    if (room.timer) { clearInterval(room.timer); room.timer = null; }
    room.status = room.mode === 'words' ? 'collecting' : 'lobby';
    room.called = [];
    room.calledSet = new Set();
    room.winners = [];
    for (const p of Object.values(room.players)) { p.won = false; p.lines = 0; }
    io.to('room:' + code).emit('game:reset');
    broadcastRoom(room);
    if (cb) cb({ ok: true });
  });

  // ---- PLAYER ----
  socket.on('player:join', (data, cb) => {
    const code = (data.code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: 'no-room' });

    const pid = data.pid && room.players[data.pid] ? data.pid
      : (data.pid || Math.random().toString(36).slice(2, 10));

    let player = room.players[pid];
    if (!player) {
      if (room.status === 'playing' || room.status === 'ended') {
        return cb && cb({ ok: false, error: 'in-progress' });
      }
      player = {
        pid,
        name: (data.name || 'Player').toString().slice(0, 20),
        socketId: socket.id,
        card: room.status === 'playing' ? makeCardForRoom(room) : null,
        won: false,
        lines: 0,
        submittedWords: [],
      };
      room.players[pid] = player;
    } else {
      player.socketId = socket.id;
      if (data.name) player.name = data.name.toString().slice(0, 20);
    }
    socket.join('room:' + code);
    socket.data.roomCode = code;
    socket.data.pid = pid;

    broadcastRoom(room);
    if (cb) cb({
      ok: true,
      pid,
      mode: room.mode,
      status: room.status,
      settings: room.settings,
      card: player.card,
      called: room.called,
      lines: player.lines,
      won: player.won,
      submittedWords: player.submittedWords,
      winners: room.winners,
    });
  });

  socket.on('player:words', (words, cb) => {
    const code = socket.data.roomCode;
    const pid = socket.data.pid;
    const room = rooms[code];
    if (!room || !room.players[pid]) return cb && cb({ ok: false });
    if (room.status !== 'collecting') return cb && cb({ ok: false, error: 'closed' });
    const clean = (Array.isArray(words) ? words : [])
      .map((w) => (w || '').toString().trim())
      .filter(Boolean)
      .map((w) => w.slice(0, 30))
      .slice(0, room.settings.wordsPerPlayer);
    room.players[pid].submittedWords = clean;
    broadcastRoom(room);
    if (cb) cb({ ok: true, submittedWords: clean });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const pid = socket.data.pid;
    if (code && rooms[code] && rooms[code].players[pid]) {
      rooms[code].players[pid].socketId = null; // keep player for reconnect
      broadcastRoom(rooms[code]);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🎉 Bingo Party server running`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Host:    http://localhost:${PORT}/host.html\n`);
});
