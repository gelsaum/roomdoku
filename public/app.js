// Os 10 animais guardiões originais encontrados via REA no APK do Zoodoku
const ZOODOKU_ANIMALS = [
  { id: 'panda',   emoji: '🐼', name: 'Panda' },
  { id: 'cat',     emoji: '🐱', name: 'Gatinho' },
  { id: 'dog',     emoji: '🐶', name: 'Cachorro' },
  { id: 'rabbit',  emoji: '🐰', name: 'Coelho' },
  { id: 'otter',   emoji: '🦦', name: 'Lontra' },
  { id: 'penguin', emoji: '🐧', name: 'Pinguim' },
  { id: 'raccoon', emoji: '🦝', name: 'Guaxinim' },
  { id: 'monkey',  emoji: '🐵', name: 'Macaco' },
  { id: 'cow',     emoji: '🐮', name: 'Vaquinha' },
  { id: 'ragdoll', emoji: '🐈', name: 'Ragdoll' }
];

function getAnimalEmoji(id) {
  const found = ZOODOKU_ANIMALS.find(a => a.id === id);
  return found ? found.emoji : '🐼';
}

// Registrar Service Worker para permitir instalar como Aplicativo (PWA) no celular
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Bloquear zoom de duplo-toque e pinch-zoom nativo do iOS Safari
document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
let lastGlobalTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = performance.now();
  if (now - lastGlobalTouchEnd <= 350) {
    if (e.cancelable) e.preventDefault();
  }
  lastGlobalTouchEnd = now;
}, { passive: false });

// Sintetizador WebAudio para sons idênticos à sensação tátil do Zoodoku
class SoundFX {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }
  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }
  tone(freq, type, duration, vol = 0.12, delay = 0) {
    if (!this.enabled) return;
    try {
      this.init();
      if (!this.ctx) return;
      const t = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + duration);
    } catch (e) {}
  }
  cross() { this.tone(440, 'sine', 0.055, 0.08); }
  uncross() { this.tone(330, 'sine', 0.05, 0.06); }
  animalPlace() {
    this.tone(523.25, 'triangle', 0.12, 0.16, 0);
    this.tone(659.25, 'triangle', 0.16, 0.16, 0.06);
    this.tone(783.99, 'triangle', 0.22, 0.14, 0.12);
  }
  mistake() {
    this.tone(190, 'sawtooth', 0.18, 0.16, 0);
    this.tone(145, 'sawtooth', 0.26, 0.16, 0.12);
  }
  countdownTick(go = false) {
    if (go) {
      this.tone(880, 'triangle', 0.3, 0.2);
    } else {
      this.tone(440, 'sine', 0.14, 0.14);
    }
  }
  winFanfare() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((n, i) => this.tone(n, 'triangle', 0.26, 0.18, i * 0.09));
  }
}

const sfx = new SoundFX();
const socket = io();

// Estado Local do Jogador e da Partida
const state = {
  playerId: localStorage.getItem('zoodoku_pid') || ('p_' + Math.random().toString(36).slice(2, 10)),
  playerName: localStorage.getItem('zoodoku_name') || '',
  avatar: localStorage.getItem('zoodoku_avatar') || 'panda',
  isSolo: false,
  room: null,
  localPuzzlesCache: null,

  // Estado do Tabuleiro Atual
  puzzle: null,
  N: 6,
  regionsGrid: [],     // Matriz [r][c] com o ID da região (0 = buraco, 1..12 = região)
  solutionCols: [],    // Array [r] com a coluna correta do animal na linha r
  boardState: [],      // Matriz [r][c]: 'empty' | 'manual_x' | 'auto_x' | 'animal' | 'hole'
  undoStack: [],       // Histórico de jogadas de X manuais

  // Controle de Toque Unificado Original Zoodoku (1 toque = toggle X, arrastar = pintar X, 2 toques rápidos = Animal)
  activePointerId: null,
  isDragging: false,
  dragPaintState: null,      // 'manual_x' | 'empty'
  dragStartCell: null,       // { r, c, prevState }
  lastTapCell: null,         // { r, c, time, prevStateBeforeFirstTap }

  // Cronômetro e progresso da rodada
  roundActive: false,
  startTimeMs: 0,
  elapsedMs: 0,
  timerInterval: null,
  hearts: 3,
  maxHearts: 3,
  mistakes: 0,
  correctCount: 0
};

localStorage.setItem('zoodoku_pid', state.playerId);

// Elementos da UI
const screens = {
  home: document.getElementById('screenHome'),
  lobby: document.getElementById('screenLobby'),
  game: document.getElementById('screenGame')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function formatTime(ms) {
  if (ms === null || ms === undefined) return '--:--';
  const totalSec = Math.max(0, ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = (totalSec % 60).toFixed(1);
  return `${String(mins).padStart(2, '0')}:${secs.padStart(4, '0')}`;
}

// Instalação de App (PWA) no Android / iPhone
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

function triggerInstallApp() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(() => {
      deferredInstallPrompt = null;
    });
  } else {
    document.getElementById('installModal').classList.remove('hidden');
  }
}

document.getElementById('btnInstallApp').addEventListener('click', triggerInstallApp);
document.getElementById('btnInstallBanner').addEventListener('click', triggerInstallApp);
document.getElementById('btnCloseInstall').addEventListener('click', () => {
  document.getElementById('installModal').classList.add('hidden');
});
document.getElementById('btnGotItInstall').addEventListener('click', () => {
  document.getElementById('installModal').classList.add('hidden');
});

// Inicialização da Home e Seletor de Avatares
function initHomeUI() {
  const nameInput = document.getElementById('inputPlayerName');
  nameInput.value = state.playerName;
  nameInput.addEventListener('input', () => {
    state.playerName = nameInput.value.trim();
    localStorage.setItem('zoodoku_name', state.playerName);
  });

  const avatarPicker = document.getElementById('avatarPicker');
  avatarPicker.innerHTML = '';
  ZOODOKU_ANIMALS.forEach(anim => {
    const btn = document.createElement('div');
    btn.className = 'avatar-option' + (state.avatar === anim.id ? ' selected' : '');
    btn.innerHTML = `<span class="av-emoji">${anim.emoji}</span><span class="av-name">${anim.name}</span>`;
    btn.addEventListener('click', () => {
      state.avatar = anim.id;
      localStorage.setItem('zoodoku_avatar', anim.id);
      document.querySelectorAll('.avatar-option').forEach(el => el.classList.remove('selected'));
      btn.classList.add('selected');
      const hintIcon = document.getElementById('hintAnimalEmoji');
      if (hintIcon) hintIcon.textContent = anim.emoji;
    });
    avatarPicker.appendChild(btn);
  });

  const hintIcon = document.getElementById('hintAnimalEmoji');
  if (hintIcon) hintIcon.textContent = getAnimalEmoji(state.avatar);

  // Verificar se entrou via link de convite (?room=ABCD)
  const params = new URLSearchParams(window.location.search);
  const urlRoom = params.get('room');
  if (urlRoom) {
    document.getElementById('inputRoomCode').value = urlRoom.toUpperCase();
  }

  // Buscar informações do servidor (domínio atual no VPS ou IP local / túnel em dev)
  fetch('/api/info')
    .then(r => r.json())
    .then(info => {
      state.serverInfo = info;
      const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const ip = info.localIps && info.localIps[0] ? info.localIps[0] : window.location.hostname;
      const displayUrl = isLocal
        ? (info.httpsUrl || `http://${ip}:${info.port}`)
        : (info.httpsUrl || window.location.origin);
      const wifiEl = document.getElementById('wifiUrlText');
      if (wifiEl) {
        wifiEl.textContent = displayUrl;
      }
    })
    .catch(() => {
      const wifiEl = document.getElementById('wifiUrlText');
      if (wifiEl) {
        wifiEl.textContent = window.location.origin;
      }
    });
}

// Eventos de Botões da Home e Lobby
document.getElementById('btnCreateRoom').addEventListener('click', () => {
  const name = document.getElementById('inputPlayerName').value.trim();
  if (!name) {
    showToast('✏️ Digite seu nome antes de criar a sala!');
    document.getElementById('inputPlayerName').focus();
    return;
  }
  state.playerName = name;
  state.isSolo = false;
  localStorage.setItem('zoodoku_name', name);

  socket.emit('create_room', {
    playerId: state.playerId,
    name: state.playerName,
    avatar: state.avatar,
    roleTag: '',
    bucket: '6',
    maxHearts: 3
  }, (res) => {
    if (res && res.ok) {
      state.room = res.room;
      updateUrlRoomCode(res.room.code);
      renderLobby();
      showScreen('lobby');
    }
  });
});

document.getElementById('btnJoinRoom').addEventListener('click', () => {
  const name = document.getElementById('inputPlayerName').value.trim();
  if (!name) {
    showToast('✏️ Digite seu nome antes de entrar na sala!');
    document.getElementById('inputPlayerName').focus();
    return;
  }
  const code = document.getElementById('inputRoomCode').value.trim().toUpperCase();
  if (code.length < 4) {
    showToast('🔑 Digite os 4 caracteres do código da sala!');
    document.getElementById('inputRoomCode').focus();
    return;
  }
  state.playerName = name;
  state.isSolo = false;
  localStorage.setItem('zoodoku_name', name);

  socket.emit('join_room', {
    code,
    playerId: state.playerId,
    name: state.playerName,
    avatar: state.avatar,
    roleTag: ''
  }, (res) => {
    if (!res || !res.ok) {
      showToast(res?.error || 'Não foi possível entrar na sala.');
      return;
    }
    state.room = res.room;
    updateUrlRoomCode(res.room.code);
    if (res.room.status === 'playing' && res.room.puzzle) {
      startPuzzleRound(res.room);
    } else {
      renderLobby();
      showScreen('lobby');
    }
  });
});

document.getElementById('btnSoloPlay').addEventListener('click', async () => {
  const name = document.getElementById('inputPlayerName').value.trim() || 'Jogador';
  state.playerName = name;
  state.isSolo = true;
  if (!state.localPuzzlesCache) {
    const res = await fetch('/data/puzzles.json');
    state.localPuzzlesCache = await res.json();
  }
  startSoloGame('6');
});

function updateUrlRoomCode(code) {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  window.history.replaceState({}, '', url);
}

// Renderização do Lobby
function renderLobby() {
  const room = state.room;
  if (!room) return;

  document.getElementById('lobbyRoomCode').textContent = room.code;
  const connectedCount = room.players.filter(p => p.connected).length;
  document.getElementById('lobbyPlayerCount').textContent = `${connectedCount} na sala`;

  const listEl = document.getElementById('lobbyPlayersList');
  listEl.innerHTML = '';

  const sortedPlayers = [...room.players].sort((a, b) => b.totalPoints - a.totalPoints);
  sortedPlayers.forEach(p => {
    const isMe = p.id === state.playerId;
    const isHost = p.id === room.hostId;
    const row = document.createElement('div');
    row.className = 'player-row' + (isMe ? ' is-me' : '');
    row.innerHTML = `
      <div class="player-info">
        <div class="player-avatar">${getAnimalEmoji(p.avatar)}</div>
        <div>
          <div class="player-name">
            ${escapeHtml(p.name)}
            ${isHost ? '<span class="role-pill">👑 Host</span>' : ''}
          </div>
          <div style="font-size:11.5px; color:#536b55; font-weight:700;">
            ${p.connected ? '🟢 Conectado' : '⚪ Reconectando...'}
          </div>
        </div>
      </div>
      <div class="player-stats-mini">
        <div>🏆 ${p.roundsWon} vitórias</div>
        <div>⭐ ${p.totalPoints} pts</div>
      </div>
    `;
    listEl.appendChild(row);
  });

  document.querySelectorAll('#bucketSelector .bucket-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.bucket === room.settings.bucket);
  });
  document.getElementById('selectHearts').value = String(room.settings.maxHearts);
  document.getElementById('selectRaceMode').value = room.settings.raceMode;
  document.getElementById('selectPenalty').value = String(room.settings.mistakePenaltySec || 0);

  const isHost = room.hostId === state.playerId;
  document.getElementById('hostStatusLabel').textContent = isHost ? '👑 Você escolhe' : 'Configurado pelo Host';
}

document.querySelectorAll('#bucketSelector .bucket-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const bucket = btn.dataset.bucket;
    document.querySelectorAll('#bucketSelector .bucket-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (state.room) {
      socket.emit('update_settings', { bucket });
    }
  });
});

['selectHearts', 'selectRaceMode', 'selectPenalty'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    if (!state.room) return;
    socket.emit('update_settings', {
      maxHearts: Number(document.getElementById('selectHearts').value),
      raceMode: document.getElementById('selectRaceMode').value,
      mistakePenaltySec: Number(document.getElementById('selectPenalty').value)
    });
  });
});

document.getElementById('btnStartRound').addEventListener('click', () => {
  if (!state.room) return;
  const activeBucketBtn = document.querySelector('#bucketSelector .bucket-btn.active');
  const bucket = activeBucketBtn ? activeBucketBtn.dataset.bucket : state.room.settings.bucket;
  socket.emit('start_round', { bucket });
});

document.getElementById('btnLeaveRoom').addEventListener('click', () => {
  updateUrlRoomCode(null);
  window.location.reload();
});

// Compartilhar no WhatsApp e Copiar Link
function getShareUrl() {
  const code = state.room?.code || '';
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const httpsBase = state.serverInfo?.httpsUrl;
  const wifiBase = document.getElementById('wifiUrlText')?.textContent || window.location.origin;

  let origin = window.location.origin;
  if (!isLocal) {
    if (window.location.protocol !== 'https:' && httpsBase) {
      origin = httpsBase;
    }
  } else {
    origin = httpsBase || (wifiBase.startsWith('http') ? wifiBase : window.location.origin);
  }
  return `${origin}/?room=${code}`;
}

document.getElementById('btnShareWhatsapp').addEventListener('click', () => {
  if (!state.room) return;
  const url = getShareUrl();
  const text = `🐼 Vamos jogar Roomdoku! Entre na sala (Código: *${state.room.code}*): ${url}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
});

document.getElementById('btnCopyLink').addEventListener('click', () => {
  const url = getShareUrl();
  navigator.clipboard.writeText(url).then(() => {
    showToast('🔗 Link da sala copiado!');
  });
});

document.querySelectorAll('.emoji-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    socket.emit('send_reaction', btn.dataset.emoji);
  });
});

// ====================================================
// LÓGICA DO TABULEIRO ZOODOKU & JOGABILIDADE UNIFICADA
// ====================================================
function decodePuzzleDigit(ch) {
  return parseInt(ch, 36);
}

function startSoloGame(bucketKey = '6') {
  const list = state.localPuzzlesCache[bucketKey] || state.localPuzzlesCache['6'];
  const p = list[Math.floor(Math.random() * list.length)];
  const fakeRoom = {
    code: 'SOLO',
    roundNumber: (state.room?.roundNumber || 0) + 1,
    settings: { bucket: bucketKey, maxHearts: 3, raceMode: 'all_finish', mistakePenaltySec: 0 },
    puzzle: { ...p, id: `SOLO-${bucketKey}` },
    roundStartTime: Date.now() + 1800,
    players: [{
      id: state.playerId,
      name: state.playerName || 'Jogador',
      avatar: state.avatar,
      roleTag: '',
      connected: true,
      placedCount: 0,
      correctCount: 0,
      mistakes: 0,
      hearts: 3,
      finished: false,
      eliminated: false,
      roundsWon: state.room?.players?.[0]?.roundsWon || 0,
      totalPoints: state.room?.players?.[0]?.totalPoints || 0
    }]
  };
  state.room = fakeRoom;
  startPuzzleRound(fakeRoom);
}

function startPuzzleRound(roomData) {
  document.getElementById('roundResultModal').classList.add('hidden');
  state.room = roomData;
  state.puzzle = roomData.puzzle;
  state.N = state.puzzle.n;
  state.maxHearts = roomData.settings.maxHearts ?? 3;
  state.hearts = state.maxHearts;
  state.mistakes = 0;
  state.correctCount = 0;
  state.undoStack = [];
  state.roundActive = false;
  state.lastTapCell = null;
  state.activePointerId = null;
  state.isDragging = false;

  const hintIcon = document.getElementById('hintAnimalEmoji');
  if (hintIcon) hintIcon.textContent = getAnimalEmoji(state.avatar);

  // Decodificar Matriz de Regiões (N x N) e Vetor Solução (N)
  const N = state.N;
  const gStr = state.puzzle.g;
  const sStr = state.puzzle.s;

  state.regionsGrid = [];
  state.boardState = [];
  for (let r = 0; r < N; r++) {
    const rowReg = [];
    const rowState = [];
    for (let c = 0; c < N; c++) {
      const ch = gStr[r * N + c];
      const regId = decodePuzzleDigit(ch); // 0 = buraco
      rowReg.push(regId);
      rowState.push(regId === 0 ? 'hole' : 'empty');
    }
    state.regionsGrid.push(rowReg);
    state.boardState.push(rowState);
  }

  state.solutionCols = [];
  for (let r = 0; r < N; r++) {
    state.solutionCols.push(decodePuzzleDigit(sStr[r]));
  }

  showScreen('game');
  renderBoard();
  updateGameHUD();
  renderLiveRaceStrip();

  runCountdown(roomData.roundStartTime || (Date.now() + 2500));
}

function runCountdown(targetStartMs) {
  const overlay = document.getElementById('countdownOverlay');
  const numEl = document.getElementById('countdownNumber');
  const subEl = document.getElementById('countdownSubText');
  overlay.classList.remove('hidden');

  subEl.textContent = `Rodada ${state.room.roundNumber} • Tabuleiro ${state.N}×${state.N}`;
  let lastShown = null;

  const check = () => {
    const remaining = targetStartMs - Date.now();
    if (remaining <= 0) {
      overlay.classList.add('hidden');
      sfx.countdownTick(true);
      beginRoundTimer();
      return;
    }
    const sec = Math.ceil(remaining / 1000);
    if (sec !== lastShown) {
      lastShown = sec;
      numEl.textContent = sec > 0 ? String(sec) : 'JÁ!';
      sfx.countdownTick(false);
    }
    requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

function beginRoundTimer() {
  state.roundActive = true;
  state.startTimeMs = performance.now();
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    if (!state.roundActive) return;
    state.elapsedMs = Math.floor(performance.now() - state.startTimeMs);
    const penaltyMs = (state.room?.settings?.mistakePenaltySec || 0) * 1000 * state.mistakes;
    document.getElementById('hudTimer').textContent = formatTime(state.elapsedMs + penaltyMs);
  }, 100);
}

function renderBoard() {
  const boardEl = document.getElementById('zoodokuBoard');
  const N = state.N;
  document.getElementById('boardContainer').classList.toggle('board-large', N > 12);
  boardEl.style.setProperty('--board-size', N);
  boardEl.style.gridTemplateColumns = `repeat(${N}, minmax(0, 1fr))`;
  boardEl.style.gridTemplateRows = `repeat(${N}, minmax(0, 1fr))`;
  boardEl.innerHTML = '';

  const animalEmoji = getAnimalEmoji(state.avatar);

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const reg = state.regionsGrid[r][c];
      const cellState = state.boardState[r][c];
      const cell = document.createElement('div');
      cell.dataset.r = r;
      cell.dataset.c = c;

      if (reg === 0) {
        cell.className = 'zoo-cell cell-hole';
      } else {
        const classes = ['zoo-cell', `region-${reg}`];

        // Quando marcada com X (manual ou automático), escurece o fundo e destaca o X!
        if (cellState === 'manual_x' || cellState === 'auto_x') {
          classes.push('is-crossed');
        } else if (cellState === 'animal') {
          classes.push('has-animal');
        }

        // Bordas mais grossas entre regiões diferentes
        if (r === 0 || state.regionsGrid[r - 1][c] !== reg) classes.push('b-top');
        if (r === N - 1 || state.regionsGrid[r + 1][c] !== reg) classes.push('b-bottom');
        if (c === 0 || state.regionsGrid[r][c - 1] !== reg) classes.push('b-left');
        if (c === N - 1 || state.regionsGrid[r][c + 1] !== reg) classes.push('b-right');

        cell.className = classes.join(' ');

        if (cellState === 'manual_x') {
          cell.innerHTML = `<span class="cell-cross">✖</span>`;
        } else if (cellState === 'auto_x') {
          cell.innerHTML = `<span class="cell-cross auto-cross">✖</span>`;
        } else if (cellState === 'animal') {
          cell.innerHTML = `<span class="cell-animal">${animalEmoji}</span>`;
        }
      }

      boardEl.appendChild(cell);
    }
  }
}

// ============================================================================
// CONTROLE DE TOQUE E ARRASTE UNIFICADO (IGUAL AO ZOODOKU ORIGINAL):
// 1. Tocar 1 vez em quadrado vazio -> Aparece X
// 2. Tocar 1 vez em quadrado com X -> Some o X (volta a ficar vazio)
// 3. Arrastar o dedo pelo tabuleiro -> Vai marcando com X (ou limpando X) direto!
// 4. Apertar 2 vezes rápido (double-tap <= 340ms) no mesmo quadrado -> Confirma Animal!
// ============================================================================
const boardEl = document.getElementById('zoodokuBoard');
const DOUBLE_TAP_MS = 340;

boardEl.addEventListener('pointerdown', (e) => {
  if (e.cancelable) e.preventDefault();
  if (!state.roundActive) return;

  const cell = e.target.closest('.zoo-cell');
  if (!cell || cell.classList.contains('cell-hole')) return;

  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);
  const cur = state.boardState[r][c];

  // Se já tem um animal ou é bloqueio automático de outro animal, ignora
  if (cur === 'animal' || cur === 'auto_x' || cur === 'hole') return;

  const now = performance.now();

  // Verificar se é um Duplo-Toque Rápido (2 cliques rápidos no mesmo quadrado!)
  if (
    state.lastTapCell &&
    state.lastTapCell.r === r &&
    state.lastTapCell.c === c &&
    (now - state.lastTapCell.time) <= DOUBLE_TAP_MS
  ) {
    state.lastTapCell = null;
    state.activePointerId = null;
    state.isDragging = false;
    attemptPlaceAnimal(r, c);
    return;
  }

  // É o 1º toque (ou início de um arraste):
  // Se estava vazio -> coloca X ('manual_x')
  // Se já tinha X ('manual_x') -> tira o X ('empty')
  const nextState = cur === 'empty' ? 'manual_x' : 'empty';
  applyManualCrossChange(r, c, nextState);

  state.lastTapCell = { r, c, time: now };
  state.activePointerId = e.pointerId;
  state.isDragging = false;
  // Quando arrasta para outras casas, sempre marca com X (ou limpa se começou limpando)
  state.dragPaintState = nextState;
  state.dragStartCell = { r, c };
}, { passive: false });

boardEl.addEventListener('pointermove', (e) => {
  if (state.activePointerId !== e.pointerId || !state.roundActive) return;
  if (e.cancelable) e.preventDefault();

  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el) return;
  const cell = el.closest('.zoo-cell');
  if (!cell || cell.classList.contains('cell-hole')) return;

  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);

  // Se moveu para outro quadrado diferente do quadrado inicial, entra em modo arraste de X!
  if (!state.dragStartCell || (r === state.dragStartCell.r && c === state.dragStartCell.c)) {
    return;
  }

  state.isDragging = true;
  state.lastTapCell = null; // Como está arrastando, cancela janela de duplo-toque

  const cur = state.boardState[r][c];
  // No arraste, marca com X os quadrados vazios (ou limpa se começou tirando X)
  if (state.dragPaintState === 'manual_x' && cur === 'empty') {
    applyManualCrossChange(r, c, 'manual_x');
  } else if (state.dragPaintState === 'empty' && cur === 'manual_x') {
    applyManualCrossChange(r, c, 'empty');
  }
}, { passive: false });

function endPointerGesture(e) {
  if (state.activePointerId === e.pointerId) {
    state.activePointerId = null;
    state.isDragging = false;
    state.dragStartCell = null;
  }
}

window.addEventListener('pointerup', endPointerGesture);
window.addEventListener('pointercancel', endPointerGesture);

function applyManualCrossChange(r, c, targetState) {
  const prev = state.boardState[r][c];
  if (prev === targetState) return;
  state.undoStack.push({ r, c, prev });
  state.boardState[r][c] = targetState;
  if (targetState === 'manual_x') sfx.cross();
  else sfx.uncross();
  renderBoard();
}

function attemptPlaceAnimal(r, c) {
  const isCorrect = state.solutionCols[r] === c;

  if (!isCorrect) {
    // Jogada incorreta! Perde 1 coração e pisca em vermelho como no Zoodoku original
    sfx.mistake();
    state.mistakes += 1;
    if (state.maxHearts > 0) {
      state.hearts = Math.max(0, state.hearts - 1);
    }
    state.boardState[r][c] = 'manual_x';
    renderBoard();

    const updatedCell = boardEl.querySelector(`.zoo-cell[data-r="${r}"][data-c="${c}"]`);
    if (updatedCell) {
      updatedCell.classList.add('cell-error');
      setTimeout(() => updatedCell.classList.remove('cell-error'), 450);
    }

    updateGameHUD();
    syncProgressWithServer(true, false);

    if (state.maxHearts > 0 && state.hearts === 0) {
      state.roundActive = false;
      showToast('💔 Você perdeu as 3 vidas nesta rodada!');
      if (state.isSolo) {
        setTimeout(() => showSoloResult(false), 700);
      }
    }
    return;
  }

  // Jogada Correta! Posiciona o animal e faz Auto-X na linha, coluna, região e diagonais!
  sfx.animalPlace();
  state.boardState[r][c] = 'animal';
  state.correctCount += 1;
  applyAutoCrossesForAnimal(r, c);
  renderBoard();
  updateGameHUD();

  const solvedAll = state.correctCount === state.N;
  if (solvedAll) {
    state.roundActive = false;
    state.elapsedMs = Math.floor(performance.now() - state.startTimeMs);
    clearInterval(state.timerInterval);
    sfx.winFanfare();
  }

  syncProgressWithServer(false, solvedAll);

  if (solvedAll && state.isSolo) {
    setTimeout(() => showSoloResult(true), 500);
  }
}

function applyAutoCrossesForAnimal(ar, ac) {
  const N = state.N;
  const targetRegion = state.regionsGrid[ar][ac];

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (r === ar && c === ac) continue;
      if (state.boardState[r][c] === 'animal' || state.boardState[r][c] === 'hole') continue;

      const sameRow = r === ar;
      const sameCol = c === ac;
      const sameRegion = state.regionsGrid[r][c] === targetRegion;
      const adjacentDiagOrOrtho = Math.abs(r - ar) <= 1 && Math.abs(c - ac) <= 1;

      if (sameRow || sameCol || sameRegion || adjacentDiagOrOrtho) {
        state.boardState[r][c] = 'auto_x';
      }
    }
  }
}

function syncProgressWithServer(mistakeMade, solved) {
  if (state.isSolo) {
    const me = state.room.players[0];
    me.placedCount = state.correctCount;
    me.correctCount = state.correctCount;
    me.mistakes = state.mistakes;
    me.hearts = state.hearts;
    me.finished = solved;
    me.finishTimeMs = solved ? state.elapsedMs : null;
    renderLiveRaceStrip();
    return;
  }

  socket.emit('player_progress', {
    placedCount: state.correctCount,
    correctCount: state.correctCount,
    mistakeMade,
    solved,
    elapsedMs: state.elapsedMs
  });
}

function updateGameHUD() {
  const N = state.N;
  document.getElementById('hudRoundInfo').textContent = `R${state.room?.roundNumber || 1} • ${N}×${N}`;
  if (state.maxHearts > 0) {
    const full = '❤️'.repeat(Math.max(0, state.hearts));
    const empty = '🖤'.repeat(Math.max(0, state.maxHearts - state.hearts));
    document.getElementById('hudHearts').textContent = full + empty;
  } else {
    document.getElementById('hudHearts').textContent = `♾️ (${state.mistakes} erros)`;
  }
  document.getElementById('hudPlacedCount').textContent = `${getAnimalEmoji(state.avatar)} ${state.correctCount}/${N}`;
}

function renderLiveRaceStrip() {
  const strip = document.getElementById('liveRaceStrip');
  if (!state.room || !state.room.players) return;
  const N = state.N || 6;

  strip.innerHTML = '';
  state.room.players.forEach(p => {
    const pct = Math.round(((p.correctCount || 0) / N) * 100);
    const isMe = p.id === state.playerId;
    const card = document.createElement('div');
    let cls = 'racer-card';
    if (isMe) cls += ' is-me';
    if (p.finished) cls += ' finished';
    if (p.eliminated) cls += ' eliminated';
    card.className = cls;

    let statusRight = `${p.correctCount || 0}/${N}`;
    if (p.finished) statusRight = `🏁 ${formatTime(p.finishTimeMs)}`;
    else if (p.eliminated) statusRight = '💔';

    card.innerHTML = `
      <div class="racer-top">
        <div class="racer-ident">
          <span>${getAnimalEmoji(p.avatar)}</span>
          <span>${escapeHtml(p.name)}</span>
        </div>
        <span>${statusRight}</span>
      </div>
      <div class="racer-bar-bg">
        <div class="racer-bar-fill" style="width:${pct}%"></div>
      </div>
      <div class="racer-sub">
        <span>${state.room.settings.maxHearts > 0 ? '❤️'.repeat(Math.max(0, p.hearts ?? 3)) : `Erros: ${p.mistakes || 0}`}</span>
        <span>🏆 ${p.roundsWon || 0}v</span>
      </div>
    `;
    strip.appendChild(card);
  });
}

document.getElementById('btnUndo').addEventListener('click', () => {
  if (!state.roundActive || state.undoStack.length === 0) return;
  const last = state.undoStack.pop();
  if (state.boardState[last.r][last.c] === 'manual_x' || state.boardState[last.r][last.c] === 'empty') {
    state.boardState[last.r][last.c] = last.prev;
    renderBoard();
  }
});

document.getElementById('btnClearCrosses').addEventListener('click', () => {
  if (!state.roundActive) return;
  for (let r = 0; r < state.N; r++) {
    for (let c = 0; c < state.N; c++) {
      if (state.boardState[r][c] === 'manual_x') {
        state.boardState[r][c] = 'empty';
      }
    }
  }
  state.undoStack = [];
  renderBoard();
});

document.getElementById('btnGiveUpRound').addEventListener('click', () => {
  state.roundActive = false;
  clearInterval(state.timerInterval);
  if (state.isSolo) {
    showScreen('home');
  } else {
    socket.emit('return_to_lobby');
  }
});

// Resultados do Modo Solo
function showSoloResult(won) {
  const summary = {
    roundNumber: state.room.roundNumber,
    size: state.N,
    winner: won ? { name: state.playerName || 'Jogador', avatar: state.avatar, finishTimeMs: state.elapsedMs } : null,
    rankings: [{
      id: state.playerId,
      name: state.playerName || 'Jogador',
      avatar: state.avatar,
      rank: 1,
      finished: won,
      eliminated: !won,
      finishTimeMs: state.elapsedMs,
      mistakes: state.mistakes,
      correctCount: state.correctCount,
      earnedPoints: won ? (state.mistakes === 0 ? 12 : 10) : 1,
      flawless: won && state.mistakes === 0
    }]
  };
  renderRoundResultModal(summary, state.room);
}

// Renderizar Modal de Fim de Rodada / Pódio
function renderRoundResultModal(summary, room) {
  state.roundActive = false;
  clearInterval(state.timerInterval);

  const modal = document.getElementById('roundResultModal');
  const titleEl = document.getElementById('resultTitle');
  const subEl = document.getElementById('resultSubtitle');
  const trophyEl = document.getElementById('resultTrophyIcon');

  if (summary.winner) {
    trophyEl.textContent = getAnimalEmoji(summary.winner.avatar);
    titleEl.textContent = `${summary.winner.name} venceu a Rodada ${summary.roundNumber}! 🎉`;
    subEl.textContent = `Resolvido em ${formatTime(summary.winner.finishTimeMs)} no tabuleiro ${summary.size}×${summary.size}!`;
  } else {
    trophyEl.textContent = '😅';
    titleEl.textContent = `Rodada ${summary.roundNumber} Encerrada!`;
    subEl.textContent = 'Esse cercado estava difícil! Vamos tentar mais uma rodada?';
  }

  const rankingsEl = document.getElementById('resultRankingsList');
  rankingsEl.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉', '4º', '5º', '6º'];

  summary.rankings.forEach((r, idx) => {
    const item = document.createElement('div');
    item.className = 'rank-item' + (idx === 0 && r.finished ? ' rank-1' : '');
    const statusText = r.finished
      ? `⏱️ ${formatTime(r.finishTimeMs)} • ${r.mistakes === 0 ? 'Sem erros!' : `${r.mistakes} erro(s)`}`
      : `💔 Não concluiu (${r.correctCount}/${summary.size})`;

    item.innerHTML = `
      <div class="rank-left">
        <div class="rank-medal">${medals[idx] || `${idx + 1}º`}</div>
        <div style="font-size:24px;">${getAnimalEmoji(r.avatar)}</div>
        <div>
          <div style="font-weight:900; font-size:14.5px;">
            ${escapeHtml(r.name)}
            ${r.flawless ? '<span class="flawless-badge">PERFEITO +2</span>' : ''}
          </div>
          <div style="font-size:12px; color:#536b55; font-weight:700;">${statusText}</div>
        </div>
      </div>
      <div class="rank-right">
        +${r.earnedPoints} pts
      </div>
    `;
    rankingsEl.appendChild(item);
  });

  // Placar Geral Acumulado
  const overallEl = document.getElementById('overallStandingsList');
  overallEl.innerHTML = '';
  const sortedOverall = [...(room.players || [])].sort((a, b) => {
    if (b.roundsWon !== a.roundsWon) return b.roundsWon - a.roundsWon;
    return b.totalPoints - a.totalPoints;
  });

  sortedOverall.forEach((p, idx) => {
    const sRow = document.createElement('div');
    sRow.className = 'standing-row';
    sRow.innerHTML = `
      <span>${idx + 1}. ${getAnimalEmoji(p.avatar)} ${escapeHtml(p.name)}</span>
      <span>🏆 ${p.roundsWon}v • ⭐ ${p.totalPoints} pts ${p.bestTimeMs ? `(${formatTime(p.bestTimeMs)})` : ''}</span>
    `;
    overallEl.appendChild(sRow);
  });

  modal.classList.remove('hidden');
}

document.getElementById('btnNextRoundQuick').addEventListener('click', () => {
  if (state.isSolo) {
    startSoloGame(state.room?.settings?.bucket || '6');
  } else {
    socket.emit('start_round', {});
  }
});

document.getElementById('btnBackToLobby').addEventListener('click', () => {
  document.getElementById('roundResultModal').classList.add('hidden');
  if (state.isSolo) {
    showScreen('home');
  } else {
    socket.emit('return_to_lobby');
  }
});

// Eventos Socket.IO em Tempo Real
socket.on('room_updated', (room) => {
  state.room = room;
  if (room.status === 'lobby') {
    document.getElementById('roundResultModal').classList.add('hidden');
    renderLobby();
    showScreen('lobby');
  } else if (room.status === 'playing') {
    renderLiveRaceStrip();
  }
});

socket.on('round_started', (room) => {
  startPuzzleRound(room);
});

socket.on('player_event', (ev) => {
  if (ev.playerId === state.playerId) return;
  if (ev.type === 'finished') {
    showToast(`🏁 ${ev.playerName} terminou em ${formatTime(ev.finishTimeMs)}!`);
  } else if (ev.type === 'eliminated') {
    showToast(`💔 ${ev.playerName} perdeu as 3 vidas!`);
  }
});

socket.on('round_ended', ({ summary, room }) => {
  state.room = room;
  renderLiveRaceStrip();
  renderRoundResultModal(summary, room);
});

socket.on('reaction', ({ playerName, emoji }) => {
  const container = document.getElementById('floatingReactions');
  const el = document.createElement('div');
  el.className = 'fly-reaction';
  el.style.right = `${20 + Math.random() * 60}px`;
  el.textContent = `${emoji}`;
  container.appendChild(el);
  showToast(`${playerName}: ${emoji}`);
  setTimeout(() => el.remove(), 2100);
});

// Controles de Topo: Regras, Som e Voltar ao Início
document.getElementById('btnRules').addEventListener('click', () => {
  document.getElementById('rulesModal').classList.remove('hidden');
});
document.getElementById('btnCloseRules').addEventListener('click', () => {
  document.getElementById('rulesModal').classList.add('hidden');
});
document.getElementById('btnGotItRules').addEventListener('click', () => {
  document.getElementById('rulesModal').classList.add('hidden');
});

document.getElementById('btnSound').addEventListener('click', (e) => {
  sfx.enabled = !sfx.enabled;
  e.currentTarget.textContent = sfx.enabled ? '🔊' : '🔇';
});

document.getElementById('btnHomeLogo').addEventListener('click', () => {
  if (state.isSolo) {
    state.roundActive = false;
    clearInterval(state.timerInterval);
    showScreen('home');
  }
});

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

initHomeUI();
