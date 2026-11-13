const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const DEFAULT_PORT = Number(process.env.PORT) || 3080;
let activePort = DEFAULT_PORT;

// Carregar os tabuleiros oficiais extraídos via REA do Zoodoku APK
const puzzlesPath = path.join(__dirname, 'public', 'data', 'puzzles.json');
const puzzlesByBucket = JSON.parse(fs.readFileSync(puzzlesPath, 'utf8'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let publicHttpsUrl = null;

// Healthcheck para Docker / VPS / Load Balancers
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    status: 'healthy',
    uptime: Math.floor(process.uptime())
  });
});

// Endpoint informativo sobre estatísticas REA, IPs locais e URL HTTPS pública
app.get('/api/info', (req, res) => {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  const bucketCounts = {};
  let totalSaved = 0;
  for (const [k, list] of Object.entries(puzzlesByBucket)) {
    bucketCounts[k] = list.length;
    totalSaved += list.length;
  }
  res.json({
    localIps: addresses,
    port: activePort,
    httpsUrl: process.env.PUBLIC_URL || publicHttpsUrl,
    totalUniqueExtractedFromApk: 58160,
    totalInFastPool: totalSaved,
    buckets: bucketCounts
  });
});

// Armazenamento de salas em memória
const rooms = new Map();

// Limpeza periódica de salas inativas para evitar acúmulo de memória em VPS
const ROOM_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const anyConnected = Array.from(room.players.values()).some(p => p.connected);
    if (!anyConnected && now - (room.lastActivityAt || 0) > ROOM_IDLE_TTL_MS) {
      rooms.delete(code);
    }
  }
}, 15 * 60 * 1000).unref();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function pickPuzzle(bucketKey, usedIndices) {
  const list = puzzlesByBucket[bucketKey] || puzzlesByBucket['6'];
  const available = [];
  for (let i = 0; i < list.length; i++) {
    if (!usedIndices.has(`${bucketKey}:${i}`)) available.push(i);
  }
  const idx = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : Math.floor(Math.random() * list.length);
  usedIndices.add(`${bucketKey}:${idx}`);
  return { ...list[idx], id: `${bucketKey}#${idx + 1}` };
}

function sanitizeRoomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status, // 'lobby' | 'countdown' | 'playing' | 'round_end'
    settings: room.settings,
    roundNumber: room.roundNumber,
    puzzle: room.currentPuzzle,
    roundStartTime: room.roundStartTime,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      socketId: p.socketId,
      name: p.name,
      avatar: p.avatar,
      roleTag: p.roleTag,
      connected: p.connected,
      ready: p.ready,
      // Estatísticas da rodada atual
      placedCount: p.placedCount,
      correctCount: p.correctCount,
      mistakes: p.mistakes,
      hearts: p.hearts,
      finished: p.finished,
      eliminated: p.eliminated,
      finishTimeMs: p.finishTimeMs,
      // Estatísticas gerais da sala (campeonato em família)
      roundsWon: p.roundsWon,
      totalPoints: p.totalPoints,
      bestTimeMs: p.bestTimeMs
    })),
    history: room.history.slice(-10)
  };
}

function checkRoundCompletion(room) {
  if (room.status !== 'playing') return;
  const activePlayers = Array.from(room.players.values()).filter(p => p.connected);
  if (activePlayers.length === 0) return;

  // Verifica se alguém já venceu no modo 'first_finish' ou se todos terminaram/foram eliminados
  const finishedPlayers = activePlayers.filter(p => p.finished);
  const allDone = activePlayers.every(p => p.finished || p.eliminated);

  if (room.settings.raceMode === 'instant_win' && finishedPlayers.length > 0) {
    finishRound(room);
  } else if (allDone) {
    finishRound(room);
  }
}

function finishRound(room) {
  if (room.status === 'round_end') return;
  room.status = 'round_end';

  // Ordenar jogadores da rodada:
  // 1. Terminou com sucesso (menor tempo vence)
  // 2. Não terminou / eliminado (maior correctCount, depois menor erros)
  const playersArr = Array.from(room.players.values());
  playersArr.sort((a, b) => {
    if (a.finished && !b.finished) return -1;
    if (!a.finished && b.finished) return 1;
    if (a.finished && b.finished) return a.finishTimeMs - b.finishTimeMs;
    if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
    return a.mistakes - b.mistakes;
  });

  const pointsTable = [10, 6, 4, 2, 1];
  const rankings = playersArr.map((p, idx) => {
    let earnedPoints = 0;
    if (p.finished) {
      earnedPoints = pointsTable[idx] || 1;
      // Bônus de partida sem erros (Flawless como no Zoodoku original!)
      if (p.mistakes === 0) earnedPoints += 2;
    } else if (p.correctCount > 0) {
      earnedPoints = 1;
    }
    p.totalPoints += earnedPoints;
    if (idx === 0 && p.finished) {
      p.roundsWon += 1;
    }
    if (p.finished && (p.bestTimeMs === null || p.finishTimeMs < p.bestTimeMs)) {
      p.bestTimeMs = p.finishTimeMs;
    }
    return {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      roleTag: p.roleTag,
      rank: idx + 1,
      finished: p.finished,
      eliminated: p.eliminated,
      finishTimeMs: p.finishTimeMs,
      mistakes: p.mistakes,
      correctCount: p.correctCount,
      earnedPoints,
      flawless: p.finished && p.mistakes === 0
    };
  });

  const roundSummary = {
    roundNumber: room.roundNumber,
    puzzleId: room.currentPuzzle?.id,
    size: room.currentPuzzle?.n,
    winner: rankings[0]?.finished ? rankings[0] : null,
    rankings,
    endedAt: Date.now()
  };

  room.history.push(roundSummary);
  io.to(room.code).emit('round_ended', {
    summary: roundSummary,
    room: sanitizeRoomState(room)
  });
}

io.on('connection', (socket) => {
  let currentRoomCode = null;
  let currentPlayerId = null;

  socket.on('create_room', (payload, cb) => {
    const code = generateRoomCode();
    const playerId = payload.playerId || socket.id;
    currentRoomCode = code;
    currentPlayerId = playerId;

    const room = {
      code,
      hostId: playerId,
      status: 'lobby',
      roundNumber: 0,
      currentPuzzle: null,
      roundStartTime: null,
      lastActivityAt: Date.now(),
      usedPuzzles: new Set(),
      history: [],
      settings: {
        bucket: payload.bucket || '6',       // '4'..'12', '7_hollow'..'10_hollow'
        maxHearts: payload.maxHearts ?? 3,   // 3 corações (0 = sem limite de vidas)
        raceMode: payload.raceMode || 'all_finish', // 'all_finish' (todos tentam terminar o tabuleiro para ver tempos) ou 'instant_win' (acabou no 1º que fechar)
        mistakePenaltySec: payload.mistakePenaltySec ?? 0
      },
      players: new Map()
    };

    room.players.set(playerId, {
      id: playerId,
      socketId: socket.id,
      name: (payload.name || 'Jogador').trim().slice(0, 20),
      avatar: payload.avatar || 'panda',
      roleTag: payload.roleTag || '',
      connected: true,
      ready: true,
      placedCount: 0,
      correctCount: 0,
      mistakes: 0,
      hearts: room.settings.maxHearts,
      finished: false,
      eliminated: false,
      finishTimeMs: null,
      roundsWon: 0,
      totalPoints: 0,
      bestTimeMs: null
    });

    rooms.set(code, room);
    socket.join(code);

    if (cb) cb({ ok: true, room: sanitizeRoomState(room) });
  });

  socket.on('join_room', (payload, cb) => {
    const code = (payload.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      if (cb) cb({ ok: false, error: 'Sala não encontrada! Verifique o código de 4 letras.' });
      return;
    }

    const playerId = payload.playerId || socket.id;
    currentRoomCode = code;
    currentPlayerId = playerId;

    let player = room.players.get(playerId);
    if (player) {
      player.socketId = socket.id;
      player.connected = true;
      if (payload.name) player.name = payload.name.trim().slice(0, 20);
      if (payload.avatar) player.avatar = payload.avatar;
      if (payload.roleTag !== undefined) player.roleTag = payload.roleTag;
    } else {
      player = {
        id: playerId,
        socketId: socket.id,
        name: (payload.name || 'Jogador').trim().slice(0, 20),
        avatar: payload.avatar || 'cat',
        roleTag: payload.roleTag || '',
        connected: true,
        ready: true,
        placedCount: 0,
        correctCount: 0,
        mistakes: 0,
        hearts: room.settings.maxHearts,
        finished: false,
        eliminated: false,
        finishTimeMs: null,
        roundsWon: 0,
        totalPoints: 0,
        bestTimeMs: null
      };
      room.players.set(playerId, player);
    }

    room.lastActivityAt = Date.now();
    socket.join(code);
    io.to(code).emit('room_updated', sanitizeRoomState(room));
    if (cb) cb({ ok: true, room: sanitizeRoomState(room) });
  });

  socket.on('update_settings', (newSettings) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== currentPlayerId) return;
    room.lastActivityAt = Date.now();

    if (newSettings.bucket && puzzlesByBucket[newSettings.bucket]) {
      room.settings.bucket = newSettings.bucket;
    }
    if (newSettings.maxHearts !== undefined) {
      room.settings.maxHearts = Number(newSettings.maxHearts);
    }
    if (newSettings.raceMode) {
      room.settings.raceMode = newSettings.raceMode;
    }
    if (newSettings.mistakePenaltySec !== undefined) {
      room.settings.mistakePenaltySec = Number(newSettings.mistakePenaltySec);
    }
    io.to(room.code).emit('room_updated', sanitizeRoomState(room));
  });

  socket.on('start_round', (customOptions) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    // Qualquer pessoa na sala ou o host pode puxar a próxima rodada quando está no lobby/round_end
    if (room.status === 'playing' && room.hostId !== currentPlayerId) return;

    if (customOptions && customOptions.bucket && puzzlesByBucket[customOptions.bucket]) {
      room.settings.bucket = customOptions.bucket;
    }

    room.roundNumber += 1;
    room.lastActivityAt = Date.now();
    room.currentPuzzle = pickPuzzle(room.settings.bucket, room.usedPuzzles);
    room.status = 'playing';
    room.roundStartTime = Date.now() + 3200; // 3.2s para contagem regressiva 3, 2, 1, JÁ!

    for (const p of room.players.values()) {
      p.placedCount = 0;
      p.correctCount = 0;
      p.mistakes = 0;
      p.hearts = room.settings.maxHearts;
      p.finished = false;
      p.eliminated = false;
      p.finishTimeMs = null;
    }

    io.to(room.code).emit('round_started', sanitizeRoomState(room));
  });

  socket.on('player_progress', (data) => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.status !== 'playing') return;
    const player = room.players.get(currentPlayerId);
    if (!player || player.finished || player.eliminated) return;
    room.lastActivityAt = Date.now();

    const N = room.currentPuzzle.n;
    player.placedCount = Math.min(N, Math.max(0, Number(data.placedCount) || 0));
    player.correctCount = Math.min(N, Math.max(0, Number(data.correctCount) || 0));

    if (data.mistakeMade) {
      player.mistakes += 1;
      if (room.settings.maxHearts > 0) {
        player.hearts = Math.max(0, player.hearts - 1);
        if (player.hearts === 0) {
          player.eliminated = true;
          io.to(room.code).emit('player_event', {
            type: 'eliminated',
            playerId: player.id,
            playerName: player.name,
            avatar: player.avatar
          });
        }
      }
      if (!player.eliminated) {
        io.to(room.code).emit('player_event', {
          type: 'mistake',
          playerId: player.id,
          playerName: player.name,
          avatar: player.avatar,
          heartsLeft: player.hearts
        });
      }
    }

    if (data.solved && player.correctCount === N && !player.eliminated) {
      player.finished = true;
      const rawElapsed = Math.max(500, Date.now() - room.roundStartTime);
      const penaltyMs = (room.settings.mistakePenaltySec || 0) * 1000 * player.mistakes;
      player.finishTimeMs = Number(data.elapsedMs) > 0
        ? Number(data.elapsedMs) + penaltyMs
        : rawElapsed + penaltyMs;

      io.to(room.code).emit('player_event', {
        type: 'finished',
        playerId: player.id,
        playerName: player.name,
        avatar: player.avatar,
        finishTimeMs: player.finishTimeMs,
        mistakes: player.mistakes
      });
    }

    io.to(room.code).emit('room_updated', sanitizeRoomState(room));
    checkRoundCompletion(room);
  });

  socket.on('send_reaction', (emoji) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.get(currentPlayerId);
    if (!player) return;
    io.to(room.code).emit('reaction', {
      playerId: player.id,
      playerName: player.name,
      avatar: player.avatar,
      emoji: String(emoji).slice(0, 8)
    });
  });

  socket.on('force_end_round', () => {
    const room = rooms.get(currentRoomCode);
    if (!room || room.hostId !== currentPlayerId) return;
    finishRound(room);
  });

  socket.on('return_to_lobby', () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.lastActivityAt = Date.now();
    room.status = 'lobby';
    io.to(room.code).emit('room_updated', sanitizeRoomState(room));
  });

  socket.on('disconnect', () => {
    if (!currentRoomCode || !currentPlayerId) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    room.lastActivityAt = Date.now();
    const player = room.players.get(currentPlayerId);
    if (player) {
      player.connected = false;
      // Se o host caiu, passa o host para outro jogador conectado
      if (room.hostId === currentPlayerId) {
        const nextHost = Array.from(room.players.values()).find(p => p.connected);
        if (nextHost) room.hostId = nextHost.id;
      }
      io.to(room.code).emit('room_updated', sanitizeRoomState(room));
      checkRoundCompletion(room);
    }
  });
});

function startServer(port, attemptsLeft = 20) {
  function attachListenHandlers(targetPort, remaining) {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && remaining > 0) {
        const nextPort = targetPort + 1;
        console.log(`Porta ${targetPort} já está em uso. Tentando porta ${nextPort}...`);
        server.listen(nextPort, '0.0.0.0');
        attachListenHandlers(nextPort, remaining - 1);
      } else if (err.code === 'EADDRINUSE') {
        console.log('Selecionando uma porta livre automaticamente...');
        server.listen(0, '0.0.0.0');
        attachListenHandlers(0, 0);
      } else {
        throw err;
      }
    });
  }

  server.once('listening', () => {
    const addr = server.address();
    activePort = addr && typeof addr === 'object' ? addr.port : port;
    console.log(`Roomdoku rodando em http://0.0.0.0:${activePort}`);
    const cfBinary = path.join(__dirname, 'cloudflared.exe');
    const shouldStartTunnel =
      process.platform === 'win32' &&
      process.env.NODE_ENV !== 'production' &&
      process.env.ENABLE_LOCAL_TUNNEL !== 'false' &&
      fs.existsSync(cfBinary);
    if (shouldStartTunnel) {
      startCloudflareTunnel(cfBinary, activePort);
    }
  });

  attachListenHandlers(port, attemptsLeft);
  server.listen(port, '0.0.0.0');
}

startServer(DEFAULT_PORT);

function startCloudflareTunnel(cfBinary, port) {
  const { spawn } = require('child_process');
  try {
    const cf = spawn(cfBinary, ['tunnel', '--url', `http://localhost:${port}`]);
    cf.stderr.on('data', (d) => {
      const text = d.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        publicHttpsUrl = match[0];
        console.log(`\n======================================================`);
        console.log(`🎉 LINK HTTPS SEGURO E INSTALÁVEL (PWA CLOUDFLARE):`);
        console.log(`👉 ${publicHttpsUrl}`);
        console.log(`======================================================\n`);
      }
    });
    cf.on('close', () => {
      setTimeout(() => startCloudflareTunnel(cfBinary, port), 4000);
    });
  } catch (err) {
    console.log('Erro ao iniciar túnel Cloudflare:', err.message);
  }
}

function gracefulShutdown(signal) {
  console.log(`Recebido ${signal}, encerrando Roomdoku...`);
  io.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

