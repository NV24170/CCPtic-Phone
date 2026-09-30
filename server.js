const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const htmlPath = path.join(__dirname, 'ccptic-phone.html');
const rooms = new Map();
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (pathname === '/' || pathname === '/ccptic-phone.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(htmlPath).pipe(res);
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});
const io = new Server(server, { maxHttpBufferSize: 1e6 });

function cleanText(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    players: room.players.length,
    max: room.settings.max,
  };
}

function broadcastRooms() {
  io.emit('rooms', [...rooms.values()].filter(room => !room.settings.priv).map(publicRoom));
}

function playerFor(room, socketId) {
  return room.players.find(player => player.socketId === socketId);
}

function roomState(room) {
  return {
    code: room.code,
    settings: room.settings,
    players: room.players.map(({ socketId, ...player }) => player),
    chat: room.chat,
    hostId: room.hostId,
    phase: room.game ? 'play' : 'room',
  };
}

function currentKind(game, settings) {
  if (settings.mode === 'sandwich') return game.round === 0 ? 'write' : 'draw';
  return game.round === 0 ? 'write' : game.round % 2 ? 'draw' : 'desc';
}

function bookIndex(playerIndex, round, count) {
  return (playerIndex - round + count * 2) % count;
}

function fallbackValue(kind) {
  return kind === 'draw'
    ? 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="100%" height="100%" fill="white"/><text x="320" y="215" text-anchor="middle" font-size="24" fill="#777">No drawing submitted</text></svg>')
    : 'No answer';
}

function gameFor(room, player) {
  const game = room.game;
  if (!game) return null;
  const index = game.players.findIndex(p => p.id === player.id);
  const book = game.books[bookIndex(index, game.round, game.players.length)];
  const finished = game.round >= game.players.length;
  return {
    round: game.round,
    total: game.players.length,
    players: game.players.map(({ socketId, ...p }) => p),
    kind: game.kind,
    left: Math.max(0, Math.ceil((game.deadline - Date.now()) / 1000)),
    submitted: game.submissions[player.id] !== undefined,
    submissions: game.players.map(p => game.submissions[p.id] !== undefined),
    previous: finished ? null : book?.steps.at(-1) || null,
    books: finished ? game.books : null,
  };
}

function syncRoom(room) {
  for (const player of room.players) {
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) socket.emit('roomState', roomState(room));
  }
  broadcastRooms();
}

function syncGame(room) {
  for (const player of room.players) {
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) socket.emit('gameState', gameFor(room, player));
  }
}

function startRound(room) {
  const game = room.game;
  if (!game || game.round >= game.players.length) {
    if (game) {
      game.round = game.players.length;
      syncGame(room);
    }
    return;
  }
  game.kind = currentKind(game, room.settings);
  game.submissions = Object.create(null);
  const duration = game.kind === 'draw' ? room.settings.dt : room.settings.wt;
  game.deadline = Date.now() + duration * 1000;
  syncGame(room);
  clearTimeout(game.timer);
  game.timer = setTimeout(() => finishRound(room), duration * 1000);
  for (const player of game.players.filter(p => p.bot || !io.sockets.sockets.has(p.socketId))) {
    setTimeout(() => {
      if (room.game !== game || game.round >= game.players.length || game.submissions[player.id] !== undefined) return;
      const choices = game.kind === 'write'
        ? ['a cat riding a skateboard', 'the moon eating a pizza', 'a sleepy hamburger']
        : game.kind === 'desc' ? ['some kind of weird animal', 'a party gone wrong', 'a very confused wizard'] : null;
      game.submissions[player.id] = { v: player.bot && choices ? choices[Math.random() * choices.length | 0] : fallbackValue(game.kind) };
      syncGame(room);
      if (Object.keys(game.submissions).length === game.players.length) finishRound(room);
    }, 1200 + Math.random() * 1800);
  }
}

function finishRound(room) {
  const game = room.game;
  if (!game) return;
  clearTimeout(game.timer);
  for (let i = 0; i < game.players.length; i++) {
    const player = game.players[i];
    const submission = game.submissions[player.id] || { v: fallbackValue(game.kind) };
    game.books[bookIndex(i, game.round, game.players.length)].steps.push({
      p: { id: player.id, name: player.name, color: player.color },
      k: game.kind,
      v: submission.v,
    });
  }
  game.round++;
  if (game.round < game.players.length) {
    startRound(room);
  } else {
    syncGame(room);
  }
}

function newCode() {
  let code;
  do code = randomBytes(3).toString('hex'); while (rooms.has(code));
  return code;
}

io.on('connection', socket => {
  socket.emit('rooms', [...rooms.values()].filter(room => !room.settings.priv).map(publicRoom));

  socket.on('listRooms', () => {
    socket.emit('rooms', [...rooms.values()].filter(room => !room.settings.priv).map(publicRoom));
  });

  socket.on('createRoom', (data = {}, reply = () => {}) => {
    const name = cleanText(data.name, 16) || 'Player';
    const code = newCode();
    const player = { id: socket.id, socketId: socket.id, name, color: 0, host: true };
    const room = {
      code,
      name: `${name}'s room`,
      hostId: socket.id,
      players: [player],
      chat: [{ sys: 1, t: `${name} created the room.` }],
      settings: {
        mode: 'normal', max: 8, priv: Boolean(data.private),
        bots: Boolean(data.bots), wt: 30, dt: 60, rand: false,
      },
      game: null,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    reply({ ok: true, code });
    syncRoom(room);
  });

  socket.on('joinRoom', (data = {}, reply = () => {}) => {
    const code = cleanText(data.code, 12).toLowerCase();
    const room = rooms.get(code);
    if (!room) return reply({ ok: false, error: 'Room not found.' });
    if (room.game) return reply({ ok: false, error: 'This game has already started.' });
    if (room.players.length >= room.settings.max) return reply({ ok: false, error: 'This room is full.' });
    const player = {
      id: socket.id, socketId: socket.id, name: cleanText(data.name, 16) || 'Player',
      color: Math.max(0, Math.min(11, Number(data.color) || 0)), host: false,
    };
    room.players.push(player);
    room.chat.push({ sys: 1, t: `${player.name} joined the room.` });
    socket.join(code);
    socket.data.roomCode = code;
    reply({ ok: true });
    syncRoom(room);
  });

  socket.on('updateSettings', (settings = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.game) return;
    if (['normal', 'sandwich', 'secret'].includes(settings.mode)) room.settings.mode = settings.mode;
    if ([4, 6, 8, 10, 12].includes(Number(settings.max))) room.settings.max = Number(settings.max);
    for (const key of ['priv', 'bots', 'rand']) if (typeof settings[key] === 'boolean') room.settings[key] = settings[key];
    if ([15, 30, 45, 60].includes(Number(settings.wt))) room.settings.wt = Number(settings.wt);
    if ([30, 60, 90, 120].includes(Number(settings.dt))) room.settings.dt = Number(settings.dt);
    room.players = room.players.slice(0, room.settings.max);
    syncRoom(room);
  });

  socket.on('chat', value => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && playerFor(room, socket.id);
    const text = cleanText(value, 240);
    if (!player || !text) return;
    room.chat.push({ n: player.name, t: text });
    room.chat = room.chat.slice(-100);
    io.to(room.code).emit('chatMessage', room.chat.at(-1));
  });

  socket.on('setColor', color => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && playerFor(room, socket.id);
    if (!player || room.game) return;
    player.color = Math.max(0, Math.min(11, Number(color) || 0));
    syncRoom(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.game) return;
    if (!room.settings.bots && room.players.length < 4) return socket.emit('notice', 'At least 4 players are needed when bots are disabled.');
    const players = [...room.players];
    if (room.settings.bots) {
      const names = ['Pixel', 'Doodle', 'Sketchy', 'Blobby', 'Scribbles', 'Marker', 'Crayon', 'Inky', 'Squiggle', 'Pencil', 'Noodle'];
      while (players.length < Math.min(4, room.settings.max)) {
        const index = players.length - room.players.length;
        players.push({ id: `bot-${index}`, name: `${names[index % names.length]} Bot`, color: (index * 3 + 1) % 12, host: false, bot: true });
      }
    }
    if (room.settings.rand) players.sort(() => Math.random() - 0.5);
    room.game = {
      players,
      round: 0,
      kind: 'write',
      submissions: Object.create(null),
      books: players.map(player => ({ o: { id: player.id, name: player.name, color: player.color }, steps: [] })),
      deadline: 0,
      timer: null,
    };
    startRound(room);
  });

  socket.on('submit', value => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && playerFor(room, socket.id);
    const game = room && room.game;
    if (!player || !game || game.round >= game.players.length || game.submissions[player.id] !== undefined) return;
    const text = typeof value === 'string' ? value : '';
    if (text.length > 600000 || (game.kind !== 'draw' && !cleanText(text, 120))) return;
    game.submissions[player.id] = { v: game.kind === 'draw' ? text : cleanText(text, 120) };
    syncGame(room);
    if (Object.keys(game.submissions).length === game.players.length) finishRound(room);
  });

  socket.on('revealNext', (data = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || !room.game || room.game.round < room.game.players.length) return;
    io.to(room.code).emit('revealPosition', {
      book: Math.max(0, Math.min(room.game.books.length - 1, Number(data.book) || 0)),
      step: Math.max(0, Number(data.step) || 0),
    });
  });

  socket.on('backToRoom', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || !room.game || room.game.round < room.game.players.length) return;
    clearTimeout(room.game.timer);
    room.game = null;
    syncRoom(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const index = room.players.findIndex(player => player.socketId === socket.id);
    if (index < 0) return;
    const [player] = room.players.splice(index, 1);
    room.chat.push({ sys: 1, t: `${player.name} left the room.` });
    if (room.hostId === socket.id) {
      room.hostId = room.players[0]?.socketId || null;
      if (room.players[0]) room.players[0].host = true;
    }
    if (room.game) {
      const game = room.game;
      if (game.round < game.players.length && game.submissions[player.id] === undefined) {
        game.submissions[player.id] = { v: fallbackValue(game.kind) };
        if (Object.keys(game.submissions).length === game.players.length) finishRound(room);
      }
      syncGame(room);
    }
    if (!room.players.length) {
      clearTimeout(room.game?.timer);
      rooms.delete(room.code);
      broadcastRooms();
    } else {
      syncRoom(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`CCPtic Phone listening on ${PORT}`));