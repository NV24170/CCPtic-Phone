const C = ['#a3d93b', '#fbbf24', '#fb923c', '#ef4444', '#3b82f6', '#22d3ee', '#14b8a6', '#4ade80', '#a8785a', '#ec4899', '#fb7185', '#8b5cf6'];
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const playerStorageKey = 'ccptic-player-id';
const playerNameKey = 'ccptic-player-name';
const socket = io();
const roomPath = location.pathname.match(/^\/room\/([a-z0-9-]+)/i);
const createPlayerId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let S = {
  view: 'home',
  name: sessionStorage.getItem(playerNameKey) || '',
  playerId: sessionStorage.getItem(playerStorageKey) || createPlayerId(),
  color: 0,
  priv: true,
  max: 8,
  bots: true,
  wt: 30,
  dt: 60,
  rand: false,
  mode: 'normal',
  players: [],
  chat: [],
  code: ''
};
let G = null;
let RV = { book: 0, step: 0 };
let pendingCode = roomPath?.[1]?.toUpperCase() || null;
let pen = { tool: 'pen', col: '#111', size: 6, history: [] };
sessionStorage.setItem(playerStorageKey, S.playerId);

const CL = className => `<svg viewBox="0 0 64 40" class="${className}"><path d="M16 38a12 12 0 0 1-1-24 15 15 0 0 1 28-4 13 13 0 0 1 8 25z" fill="#f1eef8"/></svg>`;
const toast = text => {
  const element = document.createElement('div');
  element.className = 'toast';
  element.textContent = text;
  document.body.append(element);
  setTimeout(() => element.remove(), 2400);
};
const blob = (color, large) => `<div class="blob ${large ? 'l' : ''}" style="background:${C[color] || C[0]}"></div>`;
const emitAck = (event, payload) => new Promise(resolve => {
  const callback = (error, response) => {
    if (error) resolve({ ok: false, error: 'The server did not respond. Check your connection and try again.' });
    else resolve(response || { ok: false, error: 'The server returned an empty response.' });
  };
  if (payload === undefined) socket.timeout(9000).emit(event, callback);
  else socket.timeout(9000).emit(event, payload, callback);
});
const displayError = response => {
  if (!response?.ok) toast(response?.error || 'Could not complete that action.');
  return Boolean(response?.ok);
};

function go(view) {
  S.view = view;
  render();
}

function render() {
  const app = $('#app');
  if (S.view === 'home') {
    app.innerHTML = `<div class="home"><div style="display:flex;justify-content:center">${CL('cloudbig')}</div><h1>CCPtic<small>PHONE</small></h1><div class="sub">Draw. Guess. Laugh.</div><div class="hw"><input class="in" id="nm" placeholder="Player" maxlength="16" value="${escapeHtml(S.name)}"><button class="btn" id="play" style="font-size:22px;padding:16px">» Play</button><div class="row"><button class="btn s" id="rooms">All rooms</button><button class="btn s" id="priv">Create a private game</button></div></div></div>`;
    $('#nm').addEventListener('input', event => {
      S.name = event.target.value.slice(0, 16);
      sessionStorage.setItem(playerNameKey, S.name);
    });
    $('#play').onclick = () => createRoom(false);
    $('#priv').onclick = () => createRoom(true);
    $('#rooms').onclick = showRooms;
  } else if (S.view === 'room') {
    roomView();
  } else if (S.view === 'play') {
    playView();
  } else if (S.view === 'reveal') {
    revealView();
  }
}

function getName() {
  const input = $('#nm');
  S.name = (input?.value || S.name || 'Player').trim().slice(0, 16) || 'Player';
  sessionStorage.setItem(playerNameKey, S.name);
  return S.name;
}

async function createRoom(isPrivate) {
  const response = await emitAck('room:create', {
    playerId: S.playerId,
    name: getName(),
    color: S.color,
    priv: isPrivate,
    max: S.max,
    bots: S.bots,
    wt: S.wt,
    dt: S.dt,
    rand: S.rand,
    mode: S.mode
  });
  if (!displayError(response)) return;
  applyRoom(response.room);
  history.replaceState({}, '', `/room/${S.code}`);
  go('room');
}

async function joinRoom(code) {
  const response = await emitAck('room:join', { code, playerId: S.playerId, name: getName(), color: S.color });
  if (!displayError(response)) return false;
  applyRoom(response.room);
  history.replaceState({}, '', `/room/${S.code}`);
  if (response.room.inGame && G?.books) go('reveal');
  else if (response.room.inGame) go('play');
  else go('room');
  return true;
}

function applyRoom(room) {
  S.code = room.code;
  S.priv = room.settings.priv;
  S.max = room.settings.max;
  S.bots = room.settings.bots;
  S.wt = room.settings.wt;
  S.dt = room.settings.dt;
  S.rand = room.settings.rand;
  S.mode = room.settings.mode;
  S.players = room.players;
  S.chat = room.chat;
}

socket.on('connect', async () => {
  if (pendingCode) {
    const code = pendingCode;
    pendingCode = null;
    await joinRoom(code);
  } else if (S.code) {
    const response = await emitAck('room:join', { code: S.code, playerId: S.playerId, name: getName(), color: S.color });
    if (response.ok) applyRoom(response.room);
    else {
      S.code = '';
      toast(response.error);
      if (S.view !== 'home') go('home');
    }
  }
});
socket.on('disconnect', () => toast('Connection lost. Reconnecting…'));
socket.on('connect_error', () => toast('Could not connect to the game server.'));
socket.on('room:state', room => {
  if (room.code !== S.code) return;
  applyRoom(room);
  if (S.view === 'room') roomView();
  if (!room.inGame && S.view === 'reveal') go('room');
});
socket.on('game:turn', turn => {
  G = { ...turn, sent: turn.submitted, N: turn.total };
  S.view = 'play';
  playView();
});
socket.on('game:tick', tick => {
  if (!G || tick.round !== G.round) return;
  G.left = tick.secondsLeft;
  const timer = $('#tm');
  if (timer) timer.textContent = G.left;
});
socket.on('game:progress', progress => {
  if (!G || progress.round !== G.round) return;
  G.players = progress.players;
  side();
});
socket.on('game:reveal', result => {
  G = { total: result.total, books: result.books };
  RV = { book: 0, step: 0 };
  go('reveal');
});
socket.on('room:error', message => toast(message));

async function showRooms() {
  const overlay = document.createElement('div');
  overlay.className = 'ov';
  overlay.innerHTML = '<div class="panel"><h3 style="margin-top:0">All rooms</h3><div id="rooms-list" class="wait">Loading rooms…</div><button class="btn s" id="cl">Close</button></div>';
  document.body.append(overlay);
  overlay.querySelector('#cl').onclick = () => overlay.remove();
  socket.emit('room:list', response => {
    if (!overlay.isConnected) return;
    const rooms = response?.rooms || [];
    const list = overlay.querySelector('#rooms-list');
    list.innerHTML = rooms.length
      ? rooms.map(room => `<div class="pl"><b style="flex:1">${escapeHtml(room.name)}</b><span class="wait">${room.count}/${room.max}</span><button class="btn s j" data-code="${escapeHtml(room.code)}">Join</button></div>`).join('')
      : '<div class="pl">No public rooms are open.</div>';
    list.querySelectorAll('.j').forEach(button => button.onclick = async () => {
      overlay.remove();
      await joinRoom(button.dataset.code);
    });
  });
}

const tg = (key, value) => `<div class="tg ${value ? 'on' : ''}" data-k="${key}" role="switch" aria-checked="${value}" tabindex="0"></div>`;

function roomView() {
  const playerCount = S.players.length;
  const roomUrl = `${location.origin}/room/${S.code}`;
  $('#app').innerHTML = `<div class="game"><div class="col"><div class="logo">${CL('cloudsm')}CCP<b>tic PHONE</b></div><div class="panel"><div style="text-align:center;font-weight:700;color:var(--ac2);margin-bottom:8px">Share this game</div><div class="row"><input class="in" id="room-url" readonly style="flex:1;min-width:0" value="${escapeHtml(roomUrl)}"><button class="btn s" id="cp">⧉ Copy</button></div></div>
 <div class="panel" style="flex:1"><div style="text-align:center;font-weight:700;color:var(--ac2)">Chat</div><div class="chat" id="ch">${S.chat.map(message => message.sys ? `<div>${escapeHtml(message.text)}</div>` : `<div><b>${escapeHtml(message.name)}:</b> ${escapeHtml(message.text)}</div>`).join('')}</div><div class="row" style="flex-wrap:nowrap"><input class="in" id="cm" placeholder="Say something..." maxlength="300"><button class="btn s" id="sd">➤</button></div></div></div>
 <div class="col"><div class="stage"><div id="bl">${blob(S.color, true)}</div><div style="font-size:22px;font-weight:700">Select your player appearance:</div><div class="sw">${C.map((color, index) => `<i data-i="${index}" class="${index === S.color ? 'sel' : ''}" style="background:${color}" role="button" tabindex="0" aria-label="Player color ${index + 1}"></i>`).join('')}</div><button class="btn" id="st" style="font-size:18px">Start game →</button><div class="wait">Empty seats are filled with bots · min 4 players</div></div></div>
 <div class="col"><div class="top">Waiting for players...</div><div class="panel"><div style="display:flex;justify-content:space-between;font-weight:700;color:var(--ac2)">Players<span class="wait">${playerCount}/${S.max}</span></div><div style="margin-top:10px">${S.players.map(player => `<div class="pl">${blob(player.color)}<b>${escapeHtml(player.name)}</b>${player.host ? '<span class="tag h">♛</span>' : ''}${player.id === S.playerId ? '<span class="tag">You</span>' : ''}${player.online ? '' : '<span class="wait">offline</span>'}</div>`).join('')}</div></div>
 <div class="panel"><div style="text-align:center;font-weight:700;margin-bottom:6px">Game settings</div>
 <div class="set"><div>Game mode<small>Normal: write → draw → describe</small></div><select data-s="mode"><option value="normal">Normal</option><option value="sandwich">Draw only (Sandwich)</option><option value="secret">Secret prompt</option></select></div>
 <div class="set"><div>Maximum players<small>How many can join</small></div><select data-s="max">${[4, 6, 8, 10, 12].map(value => `<option ${value === S.max ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
 <div class="set"><div>Private room<small>Accessible via room URL only</small></div>${tg('priv', S.priv)}</div>
 <div class="set"><div>Allow bots to join <span class="tag">Beta</span><small>Bots fill empty seats</small></div>${tg('bots', S.bots)}</div>
 <div class="set"><div>Writing time<small>Seconds per write round</small></div><select data-s="wt">${[15, 30, 45, 60].map(value => `<option ${value === S.wt ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
 <div class="set"><div>Drawing time<small>Seconds per draw round</small></div><select data-s="dt">${[30, 60, 90, 120].map(value => `<option ${value === S.dt ? 'selected' : ''}>${value}</option>`).join('')}</select></div>
 <div class="set"><div>Randomize order<small>Shuffle who gets which book</small></div>${tg('rand', S.rand)}</div></div></div></div>`;
  $('[data-s="mode"]').value = S.mode;
  $('#cp').onclick = async () => {
    try {
      await navigator.clipboard.writeText(roomUrl);
    } catch {
      const input = $('#room-url');
      input.select();
      document.execCommand('copy');
    }
    toast('Link copied');
  };
  $('#ch').scrollTop = $('#ch').scrollHeight;
  const sendChat = () => {
    const input = $('#cm');
    const message = input.value.trim();
    if (!message) return;
    socket.emit('room:chat', message);
    input.value = '';
  };
  $('#sd').onclick = sendChat;
  $('#cm').onkeydown = event => {
    if (event.key === 'Enter') sendChat();
  };
  document.querySelectorAll('.sw i').forEach(swatch => {
    const choose = () => {
      S.color = Number(swatch.dataset.i);
      socket.emit('player:color', S.color);
      roomView();
    };
    swatch.onclick = choose;
    swatch.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') choose(); };
  });
  document.querySelectorAll('.tg').forEach(toggle => {
    const change = () => {
      const key = toggle.dataset.k;
      const value = !S[key];
      S[key] = value;
      socket.emit('room:settings', { [key]: value });
      roomView();
    };
    toggle.onclick = change;
    toggle.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') change(); };
  });
  document.querySelectorAll('[data-s]').forEach(select => {
    select.onchange = () => {
      const key = select.dataset.s;
      const value = Number.isNaN(Number(select.value)) ? select.value : Number(select.value);
      S[key] = value;
      socket.emit('room:settings', { [key]: value });
    };
  });
  $('#st').onclick = async () => displayError(await emitAck('game:start'));
}

function submitTurn() {
  if (!G || G.sent) return;
  const input = $('#tx');
  const canvas = $('#cv');
  const value = canvas ? canvas.toDataURL('image/png') : (input.value.trim() || 'A curious cat waits by the door.');
  const button = $('#ok');
  button.disabled = true;
  socket.timeout(9000).emit('game:submit', { round: G.round, value }, (error, response) => {
    if (error || !response?.ok) {
      button.disabled = false;
      toast(response?.error || 'Your answer could not be sent.');
      return;
    }
    G.sent = true;
    playView();
  });
}

function side() {
  const element = $('#pls');
  if (!element || !G) return;
  element.innerHTML = G.players.map(player => `<div class="pl">${blob(player.color)}<b style="flex:1">${escapeHtml(player.name)}</b>${player.done ? '<span class="done">✔ done</span>' : '<span class="wait">…</span>'}</div>`).join('');
}

function playView() {
  const previous = G.previous;
  const label = G.kind === 'write' ? 'Write a sentence for others to draw' : G.kind === 'draw' ? 'Draw this' : 'Describe this drawing';
  let body;
  if (G.sent) {
    body = '<div class="prompt">Waiting for others…</div>';
  } else if (G.kind === 'write') {
    body = `<div class="prompt">${label}</div><textarea class="in" id="tx" rows="3" maxlength="120" style="max-width:640px" placeholder="Type something weird..."></textarea>`;
  } else if (G.kind === 'describe') {
    body = `<div class="prompt">${label}</div><img src="${escapeHtml(previous?.value || '')}" style="width:100%;max-width:520px;border-radius:10px"><input class="in" id="tx" maxlength="120" style="max-width:640px" placeholder="What is this?">`;
  } else {
    const prompt = previous?.kind === 'draw' ? 'Improve this drawing' : previous ? (G.prompt ? `“${escapeHtml(G.prompt)}”` : '🤫 (secret prompt hidden)') : 'Draw anything!';
    body = `<div class="prompt">${label}: ${prompt}</div><canvas id="cv" width="640" height="420"></canvas><div class="tools"><button class="tb sel" data-t="pen" aria-label="Pen">✏️</button><button class="tb" data-t="eraser" aria-label="Eraser">🧽</button><button class="tb" data-t="fill" aria-label="Fill">🪣</button>${['#111', '#fff', '#ef4444', '#fb923c', '#fbbf24', '#4ade80', '#22d3ee', '#3b82f6', '#8b5cf6', '#ec4899', '#a8785a'].map(color => `<i data-c="${color}" style="background:${color}" role="button" tabindex="0" aria-label="${color}"></i>`).join('')}<input type="range" id="sz" min="2" max="40" value="${pen.size}" aria-label="Brush size"><button class="tb" id="un" aria-label="Undo">↶</button><button class="tb" id="clr" aria-label="Clear drawing">🗑</button></div>`;
  }
  $('#app').innerHTML = `<div class="game"><div class="col"><div class="logo">${CL('cloudsm')}CCP<b>tic PHONE</b></div><div class="top">Round ${G.round + 1}/${G.total}</div></div><div class="col"><div class="stage"><div class="big"><span id="tm">${G.left}</span>s</div>${body}${G.sent ? '' : '<button class="btn" id="ok">Done ✔</button>'}</div></div><div class="col"><div class="panel"><div style="font-weight:700;color:var(--ac2);margin-bottom:8px">Players</div><div id="pls"></div></div></div></div>`;
  side();
  if (G.sent) return;
  $('#ok').onclick = submitTurn;
  if (G.kind === 'draw') initCanvas();
}

function initCanvas() {
  const canvas = $('#cv');
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 640, 420);
  pen.history = [context.getImageData(0, 0, 640, 420)];
  context.lineCap = context.lineJoin = 'round';
  const position = event => {
    const rect = canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) * 640 / rect.width, (event.clientY - rect.top) * 420 / rect.height];
  };
  let drawing = false;
  canvas.onpointerdown = event => {
    const [canvasX, canvasY] = position(event);
    if (pen.tool === 'fill') {
      fillCanvas(context, canvasX | 0, canvasY | 0, pen.col);
      pen.history.push(context.getImageData(0, 0, 640, 420));
      return;
    }
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    context.strokeStyle = pen.tool === 'eraser' ? '#fff' : pen.col;
    context.lineWidth = pen.size;
    context.beginPath();
    context.moveTo(canvasX, canvasY);
    context.lineTo(canvasX + 0.1, canvasY);
    context.stroke();
  };
  canvas.onpointermove = event => {
    if (!drawing) return;
    const [canvasX, canvasY] = position(event);
    context.lineTo(canvasX, canvasY);
    context.stroke();
  };
  canvas.onpointerup = () => {
    if (!drawing) return;
    drawing = false;
    pen.history.push(context.getImageData(0, 0, 640, 420));
  };
  canvas.onpointercancel = () => { drawing = false; };
  document.querySelectorAll('[data-t]').forEach(button => button.onclick = () => {
    pen.tool = button.dataset.t;
    document.querySelectorAll('[data-t]').forEach(item => item.classList.toggle('sel', item === button));
  });
  document.querySelectorAll('[data-c]').forEach(swatch => swatch.onclick = () => {
    pen.col = swatch.dataset.c;
    pen.tool = 'pen';
    document.querySelectorAll('[data-c]').forEach(item => item.classList.toggle('sel', item === swatch));
  });
  $('#sz').oninput = event => { pen.size = Number(event.target.value); };
  $('#un').onclick = () => {
    if (pen.history.length > 1) pen.history.pop();
    context.putImageData(pen.history[pen.history.length - 1], 0, 0);
  };
  $('#clr').onclick = () => {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 640, 420);
    pen.history.push(context.getImageData(0, 0, 640, 420));
  };
}

function fillCanvas(context, startX, startY, color) {
  const image = context.getImageData(0, 0, 640, 420);
  const data = image.data;
  const hex = color.slice(1);
  const newColor = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const startIndex = (startY * 640 + startX) * 4;
  const target = [data[startIndex], data[startIndex + 1], data[startIndex + 2]];
  if (target.every((value, index) => value === newColor[index])) return;
  const stack = [[startX, startY]];
  const matches = index => Math.abs(data[index] - target[0]) + Math.abs(data[index + 1] - target[1]) + Math.abs(data[index + 2] - target[2]) < 40;
  while (stack.length) {
    const [canvasX, canvasY] = stack.pop();
    if (canvasX < 0 || canvasY < 0 || canvasX >= 640 || canvasY >= 420) continue;
    const index = (canvasY * 640 + canvasX) * 4;
    if (!matches(index)) continue;
    data[index] = newColor[0];
    data[index + 1] = newColor[1];
    data[index + 2] = newColor[2];
    data[index + 3] = 255;
    stack.push([canvasX + 1, canvasY], [canvasX - 1, canvasY], [canvasX, canvasY + 1], [canvasX, canvasY - 1]);
  }
  context.putImageData(image, 0, 0);
}

function revealView() {
  if (!G?.books?.length) return go('room');
  const book = G.books[RV.book];
  const shown = book.steps.slice(0, RV.step + 1);
  const lastStep = RV.step >= book.steps.length - 1;
  const lastBook = RV.book >= G.books.length - 1;
  $('#app').innerHTML = `<div class="game"><div class="col"><div class="logo">${CL('cloudsm')}CCP<b>tic PHONE</b></div><div class="top">Album ${RV.book + 1}/${G.books.length}<br><span class="wait">Started by ${escapeHtml(book.owner.name)}</span></div></div><div class="col"><div class="stage" style="justify-content:flex-start;max-height:80vh;overflow:auto">${shown.map(step => `<div class="step"><div style="display:flex;align-items:center;gap:8px">${blob(step.player.color)}<b>${escapeHtml(step.player.name)}</b><span class="wait">${step.kind === 'draw' ? 'drew' : step.kind === 'write' ? 'wrote' : 'described'}</span></div>${step.kind === 'draw' ? `<img src="${escapeHtml(step.value)}" style="width:100%;max-width:520px;border-radius:10px;background:#fff">` : `<div class="bub">${escapeHtml(step.value)}</div>`}</div>`).join('')}<div class="row"><button class="btn" id="nx">${lastStep ? (lastBook ? 'Finish' : 'Next album →') : 'Next ▸'}</button></div></div></div><div class="col"><div class="panel"><div style="font-weight:700;color:var(--ac2);margin-bottom:8px">Albums</div>${G.books.map((item, index) => `<div class="pl" style="${index === RV.book ? 'outline:2px solid var(--ac)' : ''}">${blob(item.owner.color)}<b>${escapeHtml(item.owner.name)}</b></div>`).join('')}</div></div></div>`;
  $('#nx').onclick = () => {
    if (!lastStep) RV.step += 1;
    else if (!lastBook) {
      RV.book += 1;
      RV.step = 0;
    } else {
      socket.emit('game:back');
      G = null;
      go('room');
      return;
    }
    revealView();
  };
}

function startRoomFromLink() {
  if (!pendingCode || !socket.connected) return;
  const code = pendingCode;
  pendingCode = null;
  joinRoom(code);
}

render();
if (pendingCode) startRoomFromLink();
