const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const MAX_DRAWING_LENGTH = 850_000;
const NAME_LIMIT = 16;
const TEXT_LIMIT = 120;
const BOT_NAMES = ['Pixel', 'Doodle', 'Sketchy', 'Blobby', 'Scribbles', 'Marker', 'Crayon', 'Inky', 'Squiggle', 'Pencil', 'Noodle'];
const IDEAS = ['a cat riding a skateboard', 'a sad potato at a party', 'the moon eating a pizza', 'a shark in a tuxedo', 'grandma fighting a robot', 'a dinosaur doing taxes', 'a ghost stuck in traffic', 'a very tired unicorn', 'pirates at the dentist', 'a snowman on vacation'];
const DESCRIPTIONS = ['some kind of weird animal', 'a party gone wrong', 'my cousin on Monday', 'a very confused wizard', 'a fancy monster', 'a sleepy hamburger', 'two friends arguing', 'the world\'s worst chef'];
const COLORS = ['#a3d93b', '#fbbf24', '#fb923c', '#ef4444', '#3b82f6', '#22d3ee', '#14b8a6', '#4ade80', '#a8785a', '#ec4899', '#fb7185', '#8b5cf6'];

const cleanName = value => String(value || 'Player').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_LIMIT) || 'Player';
const randomItem = items => items[crypto.randomInt(items.length)];
const makeCode = () => crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
const makeId = () => crypto.randomUUID();
const safePlayerId = value => typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : makeId();

function createApplicationServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 1_000_000 });
  const rooms = new Map();

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/client.js', (_req, res) => res.sendFile(path.join(ROOT, 'client.js')));
  app.get(/^\/room\/[A-Za-z0-9-]+\/?$/, (_req, res) => res.sendFile(path.join(ROOT, 'ccptic-phone.html')));
  app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'ccptic-phone.html')));

  const roomSnapshot = room => ({
    code: room.code,
    settings: { ...room.settings },
    players: [...room.players.values()].map(player => ({
      id: player.id,
      name: player.name,
      color: player.color,
      host: player.id === room.hostId,
      online: Boolean(player.socketId)
    })),
    chat: room.chat.slice(-50),
    inGame: Boolean(room.game)
  });
  const publishRoom = room => io.to(room.code).emit('room:state', roomSnapshot(room));
  const acknowledge = (callback, value) => {
    if (typeof callback === 'function') callback(value);
  };
  const fail = (callback, message) => acknowledge(callback, { ok: false, error: message });

  function getSocketRoom(socket) {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.players.has(socket.data.playerId)) return null;
    return room;
  }

  function detachSocket(socket) {
    const room = getSocketRoom(socket);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (player.socketId === socket.id) player.socketId = null;
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    publishRoom(room);
  }

  function attachPlayer(socket, room, player) {
    detachSocket(socket);
    player.socketId = socket.id;
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    publishRoom(room);
  }

  function publicRooms() {
    return [...rooms.values()]
      .filter(room => !room.settings.priv && !room.game)
      .map(room => ({ code: room.code, name: `${room.players.values().next().value?.name || 'Player'}'s room`, count: room.players.size, max: room.settings.max }));
  }

  function emitPlayerTurn(room, participant, index) {
    const game = room.game;
    const round = game.round;
    if (!participant.socketId) return;
    const bookIndex = (index - round + game.players.length) % game.players.length;
    const previous = game.books[bookIndex].steps.at(-1) || null;
    const prompt = game.kind === 'draw' && previous && room.settings.mode === 'secret' && previous.kind !== 'draw'
      ? null
      : previous?.value || null;
    const visiblePrevious = previous && game.kind === 'draw' && room.settings.mode === 'secret' && previous.kind !== 'draw'
      ? { ...previous, value: null }
      : previous;
    io.to(participant.socketId).emit('game:turn', {
      round,
      total: game.players.length,
      kind: game.kind,
      secondsLeft: game.secondsLeft,
      timeLimit: game.timeLimit,
      prompt,
      previous: visiblePrevious,
      submitted: Boolean(game.submissions[index]),
      players: game.players.map((player, playerIndex) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        done: Boolean(game.submissions[playerIndex])
      }))
    });
  }

  function emitTurn(room) {
    room.game.players.forEach((participant, index) => emitPlayerTurn(room, participant, index));
  }

  function emitProgress(room) {
    const game = room.game;
    if (!game) return;
    io.to(room.code).emit('game:progress', {
      round: game.round,
      players: game.players.map((player, index) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        done: Boolean(game.submissions[index])
      }))
    });
  }

  function botDrawing() {
    const color = randomItem(COLORS);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420"><rect width="640" height="420" fill="white"/><path d="M80 260 Q180 70 280 250 T500 150 M120 330 Q300 180 520 300" fill="none" stroke="${color}" stroke-width="22" stroke-linecap="round"/><circle cx="320" cy="190" r="58" fill="${randomItem(COLORS)}"/><circle cx="300" cy="178" r="8" fill="white"/><circle cx="340" cy="178" r="8" fill="white"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function fallbackSubmission(kind) {
    if (kind === 'draw') return botDrawing();
    return kind === 'write' ? randomItem(IDEAS) : randomItem(DESCRIPTIONS);
  }

  function submitForIndex(room, index, kind, value) {
    const game = room.game;
    if (!game || game.submissions[index]) return;
    game.submissions[index] = { kind, value };
    emitProgress(room);
    if (game.submissions.filter(Boolean).length === game.players.length) finishRound(room);
  }

  function stopRoundTimers(game) {
    clearInterval(game.interval);
    game.botTimers.forEach(clearTimeout);
    game.botTimers = [];
  }

  function finishRound(room) {
    const game = room.game;
    if (!game || game.finishing) return;
    game.finishing = true;
    stopRoundTimers(game);
    game.players.forEach((player, index) => {
      const submission = game.submissions[index] || { kind: game.kind, value: fallbackSubmission(game.kind) };
      const bookIndex = (index - game.round + game.players.length) % game.players.length;
      game.books[bookIndex].steps.push({ player: { id: player.id, name: player.name, color: player.color }, ...submission });
    });

    if (game.round + 1 === game.players.length) {
      game.finished = true;
      io.to(room.code).emit('game:reveal', { total: game.players.length, books: game.books });
      return;
    }
    game.round += 1;
    setTimeout(() => beginRound(room), 800);
  }

  function beginRound(room) {
    const game = room.game;
    if (!game || game.finished) return;
    game.finishing = false;
    game.submissions = Array(game.players.length).fill(null);
    game.kind = room.settings.mode === 'sandwich'
      ? (game.round === 0 ? 'write' : 'draw')
      : (game.round === 0 ? 'write' : game.round % 2 ? 'draw' : 'describe');
    game.timeLimit = game.kind === 'draw' ? room.settings.dt : room.settings.wt;
    game.secondsLeft = game.timeLimit;
    emitTurn(room);
    game.botTimers = game.players.map((player, index) => {
      if (!player.bot) return null;
      return setTimeout(() => submitForIndex(room, index, game.kind, fallbackSubmission(game.kind)), 900 + crypto.randomInt(1800));
    }).filter(Boolean);
    game.interval = setInterval(() => {
      if (!room.game || room.game !== game) return;
      game.secondsLeft -= 1;
      io.to(room.code).emit('game:tick', { round: game.round, secondsLeft: game.secondsLeft });
      if (game.secondsLeft <= 0) finishRound(room);
    }, 1000);
  }

  io.on('connection', socket => {
    socket.data.roomCode = null;
    socket.data.playerId = null;

    socket.on('room:list', callback => acknowledge(callback, { ok: true, rooms: publicRooms() }));

    socket.on('room:create', (payload = {}, callback) => {
      let code = makeCode();
      while (rooms.has(code)) code = makeCode();
      const playerId = safePlayerId(payload.playerId);
      const settings = {
        priv: Boolean(payload.priv),
        max: [4, 6, 8, 10, 12].includes(Number(payload.max)) ? Number(payload.max) : 8,
        bots: payload.bots !== false,
        wt: [15, 30, 45, 60].includes(Number(payload.wt)) ? Number(payload.wt) : 30,
        dt: [30, 60, 90, 120].includes(Number(payload.dt)) ? Number(payload.dt) : 60,
        rand: Boolean(payload.rand),
        mode: ['normal', 'sandwich', 'secret'].includes(payload.mode) ? payload.mode : 'normal'
      };
      const player = { id: playerId, name: cleanName(payload.name), color: Number.isInteger(payload.color) ? Math.max(0, Math.min(11, payload.color)) : 0, socketId: null };
      const room = { code, hostId: playerId, settings, players: new Map([[playerId, player]]), chat: [{ sys: true, text: `${player.name} joined the room.` }], game: null };
      rooms.set(code, room);
      attachPlayer(socket, room, player);
      acknowledge(callback, { ok: true, room: roomSnapshot(room), playerId });
    });

    socket.on('room:join', (payload = {}, callback) => {
      const code = String(payload.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return fail(callback, 'That room does not exist or has expired.');
      if (room.game && !room.players.has(payload.playerId)) return fail(callback, 'This game has already started.');
      const playerId = safePlayerId(payload.playerId);
      let player = room.players.get(playerId);
      if (!player && room.players.size >= room.settings.max) return fail(callback, 'This room is full.');
      if (!player) {
        player = { id: playerId, name: cleanName(payload.name), color: Number.isInteger(payload.color) ? Math.max(0, Math.min(11, payload.color)) : 0, socketId: null };
        room.players.set(playerId, player);
        room.chat.push({ sys: true, text: `${player.name} joined the room.` });
      }
      attachPlayer(socket, room, player);
      if (room.game) {
        const index = room.game.players.findIndex(participant => participant.id === player.id);
        if (index >= 0) {
          room.game.players[index].socketId = socket.id;
          room.game.players[index].bot = false;
          if (room.game.finished) io.to(socket.id).emit('game:reveal', { total: room.game.players.length, books: room.game.books });
          else emitPlayerTurn(room, room.game.players[index], index);
        }
      }
      acknowledge(callback, { ok: true, room: roomSnapshot(room), playerId });
    });

    socket.on('room:settings', (patch = {}) => {
      const room = getSocketRoom(socket);
      if (!room || room.hostId !== socket.data.playerId || room.game) return;
      if (patch.mode !== undefined && ['normal', 'sandwich', 'secret'].includes(patch.mode)) room.settings.mode = patch.mode;
      if (patch.max !== undefined && [4, 6, 8, 10, 12].includes(Number(patch.max)) && Number(patch.max) >= room.players.size) room.settings.max = Number(patch.max);
      if (patch.priv !== undefined) room.settings.priv = Boolean(patch.priv);
      if (patch.bots !== undefined) room.settings.bots = Boolean(patch.bots);
      if (patch.rand !== undefined) room.settings.rand = Boolean(patch.rand);
      if (patch.wt !== undefined && [15, 30, 45, 60].includes(Number(patch.wt))) room.settings.wt = Number(patch.wt);
      if (patch.dt !== undefined && [30, 60, 90, 120].includes(Number(patch.dt))) room.settings.dt = Number(patch.dt);
      publishRoom(room);
    });

    socket.on('player:color', color => {
      const room = getSocketRoom(socket);
      const player = room?.players.get(socket.data.playerId);
      if (!player || !Number.isInteger(color) || color < 0 || color > 11) return;
      player.color = color;
      publishRoom(room);
    });

    socket.on('room:chat', text => {
      const room = getSocketRoom(socket);
      const player = room?.players.get(socket.data.playerId);
      const message = String(text || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 300);
      if (!room || !player || !message) return;
      room.chat.push({ name: player.name, text: message });
      room.chat = room.chat.slice(-50);
      publishRoom(room);
    });

    socket.on('game:start', callback => {
      const room = getSocketRoom(socket);
      if (!room || room.hostId !== socket.data.playerId) return fail(callback, 'Only the host can start the game.');
      if (room.game) return fail(callback, 'A game is already in progress.');
      if (room.players.size < 2 && !room.settings.bots) return fail(callback, 'Need at least 2 players (or allow bots).');
      const participants = [...room.players.values()].map(player => ({ id: player.id, name: player.name, color: player.color, socketId: player.socketId, bot: false }));
      const targetCount = room.settings.bots ? Math.max(4, Math.min(room.settings.max, participants.length + 3)) : participants.length;
      while (participants.length < targetCount) {
        const index = participants.length;
        participants.push({ id: `bot-${index}`, name: `${BOT_NAMES[(index - 1) % BOT_NAMES.length]} Bot`, color: (index * 3 + 1) % COLORS.length, socketId: null, bot: true });
      }
      if (room.settings.rand) participants.sort(() => Math.random() - 0.5);
      room.game = {
        players: participants,
        round: 0,
        kind: null,
        secondsLeft: 0,
        timeLimit: 0,
        submissions: [],
        books: participants.map(player => ({ owner: { id: player.id, name: player.name, color: player.color }, steps: [] })),
        botTimers: [],
        interval: null,
        finishing: false,
        finished: false
      };
      publishRoom(room);
      beginRound(room);
      acknowledge(callback, { ok: true });
    });

    socket.on('game:submit', (payload = {}, callback) => {
      const room = getSocketRoom(socket);
      const game = room?.game;
      if (!game || game.finished || Number(payload.round) !== game.round) return fail(callback, 'This turn has expired.');
      const index = game.players.findIndex(player => player.id === socket.data.playerId);
      if (index < 0 || game.submissions[index]) return fail(callback, 'Your turn was already submitted.');
      const kind = game.kind;
      const value = String(payload.value || '').trim();
      if (!value) return fail(callback, 'Add a response before submitting.');
      if (kind === 'draw') {
        if (value.length > MAX_DRAWING_LENGTH || !/^data:image\/(png|jpeg|webp);base64,/.test(value)) return fail(callback, 'Drawing could not be uploaded. Please try again.');
      } else if (value.length > TEXT_LIMIT) {
        return fail(callback, `Responses must be ${TEXT_LIMIT} characters or fewer.`);
      }
      submitForIndex(room, index, kind, value);
      acknowledge(callback, { ok: true });
    });

    socket.on('game:back', () => {
      const room = getSocketRoom(socket);
      if (!room?.game?.finished) return;
      room.game = null;
      publishRoom(room);
    });

    socket.on('room:leave', () => {
      const room = getSocketRoom(socket);
      if (!room) return;
      const player = room.players.get(socket.data.playerId);
      room.players.delete(player.id);
      if (room.hostId === player.id) room.hostId = [...room.players.values()].find(candidate => candidate.socketId)?.id || room.players.keys().next().value || null;
      if (!room.players.size) {
        if (room.game) stopRoundTimers(room.game);
        rooms.delete(room.code);
      } else {
        if (room.game && !room.game.finished) {
          const participantIndex = room.game.players.findIndex(item => item.id === player.id);
          if (participantIndex >= 0) {
            room.game.players[participantIndex].socketId = null;
            room.game.players[participantIndex].bot = true;
            if (!room.game.submissions[participantIndex]) submitForIndex(room, participantIndex, room.game.kind, fallbackSubmission(room.game.kind));
          }
        }
        publishRoom(room);
      }
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.playerId = null;
    });

    socket.on('disconnect', () => {
      const room = getSocketRoom(socket);
      if (!room) return;
      const player = room.players.get(socket.data.playerId);
      if (player.socketId === socket.id) player.socketId = null;
      if (room.game && !room.game.finished) {
        const participantIndex = room.game.players.findIndex(item => item.id === player.id);
        if (participantIndex >= 0) {
          room.game.players[participantIndex].socketId = null;
          room.game.players[participantIndex].bot = true;
          if (!room.game.submissions[participantIndex]) submitForIndex(room, participantIndex, room.game.kind, fallbackSubmission(room.game.kind));
        }
      }
      if (room.hostId === player.id) {
        room.hostId = [...room.players.values()].find(candidate => candidate.socketId)?.id || player.id;
      }
      publishRoom(room);
    });
  });

  return { app, httpServer, io, rooms };
}

if (require.main === module) {
  const { httpServer } = createApplicationServer();
  httpServer.listen(PORT, '0.0.0.0', () => console.log(`CCPtic Phone listening on ${PORT}`));
}

module.exports = { createApplicationServer };
