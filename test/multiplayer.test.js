const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { io: createClient } = require('socket.io-client');
const { createApplicationServer } = require('../server');

function waitFor(socket, event, predicate = () => true, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = value => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(value);
    };
    socket.on(event, listener);
  });
}

function request(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const callback = (error, result) => {
      if (error) reject(new Error(`${event}: ${error.message}`));
      else resolve(result);
    };
    if (Object.keys(payload).length) socket.timeout(5000).emit(event, payload, callback);
    else socket.timeout(5000).emit(event, callback);
  });
}

test('two clients share a room, chat, turns, and the final albums', async () => {
  const application = createApplicationServer();
  const sockets = [];
  await new Promise(resolve => application.httpServer.listen(0, '127.0.0.1', resolve));
  const address = application.httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal((await fetch(`${url}/`)).status, 200);
    assert.equal((await fetch(`${url}/room/TEST12`)).status, 200);
    assert.equal((await fetch(`${url}/client.js`)).status, 200);
    assert.equal((await fetch(`${url}/socket.io/socket.io.js`)).status, 200);

    const host = createClient(url, { transports: ['websocket'] });
    const guest = createClient(url, { transports: ['websocket'] });
    sockets.push(host, guest);
    await Promise.all([once(host, 'connect'), once(guest, 'connect')]);

    const created = await request(host, 'room:create', {
      playerId: 'test-host', name: 'Host', priv: false, max: 4, bots: false, wt: 15, dt: 30
    });
    assert.equal(created.ok, true);
    const sharedRoom = waitFor(host, 'room:state', room => room.players.length === 2);
    const joined = await request(guest, 'room:join', {
      code: created.room.code, playerId: 'test-guest', name: 'Guest'
    });
    assert.equal(joined.ok, true);
    assert.equal((await sharedRoom).players.length, 2);

    const sharedChat = waitFor(guest, 'room:state', room => room.chat.some(message => message.text === 'hello from host'));
    host.emit('room:chat', 'hello from host');
    assert.equal((await sharedChat).chat.at(-1).text, 'hello from host');

    const hostFirstTurn = waitFor(host, 'game:turn', turn => turn.round === 0);
    const guestFirstTurn = waitFor(guest, 'game:turn', turn => turn.round === 0);
    assert.equal((await request(host, 'game:start')).ok, true);
    const [hostTurn0, guestTurn0] = await Promise.all([hostFirstTurn, guestFirstTurn]);
    assert.equal(hostTurn0.kind, 'write');
    assert.equal(guestTurn0.kind, 'write');

    const hostDrawTurn = waitFor(host, 'game:turn', turn => turn.round === 1);
    const guestDrawTurn = waitFor(guest, 'game:turn', turn => turn.round === 1);
    await Promise.all([
      request(host, 'game:submit', { round: 0, value: 'a tiny blue house' }),
      request(guest, 'game:submit', { round: 0, value: 'a cat on a skateboard' })
    ]);
    const [hostTurn1, guestTurn1] = await Promise.all([hostDrawTurn, guestDrawTurn]);
    assert.equal(hostTurn1.kind, 'draw');
    assert.equal(guestTurn1.kind, 'draw');

    const hostReveal = waitFor(host, 'game:reveal');
    const guestReveal = waitFor(guest, 'game:reveal');
    const drawing = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/S5cAAAAASUVORK5CYII=';
    await Promise.all([
      request(host, 'game:submit', { round: 1, value: drawing }),
      request(guest, 'game:submit', { round: 1, value: drawing })
    ]);
    const [hostResult, guestResult] = await Promise.all([hostReveal, guestReveal]);
    assert.deepEqual(hostResult, guestResult);
    assert.equal(hostResult.books.length, 2);
    assert.equal(hostResult.books.every(book => book.steps.length === 2), true);

    const privateRoom = await request(host, 'room:create', {
      playerId: 'private-host', name: 'Private Host', priv: true, max: 4, bots: false
    });
    assert.equal(privateRoom.ok, true);
    const directory = await request(host, 'room:list');
    assert.equal(directory.rooms.some(room => room.code === privateRoom.room.code), false);
    const privateJoin = await request(guest, 'room:join', {
      code: privateRoom.room.code, playerId: 'private-guest', name: 'Private Guest'
    });
    assert.equal(privateJoin.ok, true);
    assert.equal(privateJoin.room.players.length, 2);
  } finally {
    sockets.forEach(socket => socket.disconnect());
    await new Promise(resolve => application.io.close(resolve));
  }
});
