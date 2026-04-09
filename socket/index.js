const { supabase, getSupabaseClient } = require('../config/supabase');
const { processMatchAchievements } = require('../services/achievements');
const { calculateLevelUp } = require('../utils/level');
const isProduction = process.env.NODE_ENV === 'production';
const log = (...args) => { if (!isProduction) console.log(...args); };
const connectedUsers = new Map();

// Strip sensitive fields before sending player data to clients
function sanitizePlayers(players) {
  return players.map(({ token, ...safe }) => safe);
}
// Matchmaking queue: userId -> player object
const matchQueue = new Map();
// Friend rooms: code -> host player object
const friendRooms = new Map();
const userHostedRooms = new Map(); // userId -> roomCode (For O(1) disconnect cleanup)

// Active games: roomId -> { players, board, currentTurn, turnStartTime }
const activeGames = new Map();
// Invite cooldowns: userId -> timestamp
const inviteCooldowns = new Map();
// Server-side token vault: roomId -> { p1Token, p2Token }
const gameTokens = new Map();

// === Socket auth token cache (separate from HTTP middleware) ===
const socketAuthCache = new Map();
const SOCKET_AUTH_TTL = 120 * 1000; // 2 minutes

// === Offline Database Write Buffer ===
const disconnectQueue = new Set();
let onlineCountChanged = false;

function setupSocket(io) {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    // Check socket auth cache first
    const cached = socketAuthCache.get(token);
    if (cached && Date.now() < cached.expiresAt) {
      socket.user = cached.user;
      return next();
    }

    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return next(new Error('Invalid token'));
      socketAuthCache.set(token, { user, expiresAt: Date.now() + SOCKET_AUTH_TTL });
      socket.user = user;
      next();
    } catch (err) {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    log(`User connected: ${userId}`);

    let profile = null;

    // Get user profile async — store promise so handlers can await it
    const profileReady = supabase
      .from('profiles')
      .select('username, equipped_avatar_url, level, rank')
      .eq('id', userId)
      .single()
      .then(async ({ data }) => {
        if (data) {
          profile = data;
          connectedUsers.set(socket.id, { userId, ...profile });
          socket.join(userId);
          
          if (disconnectQueue.has(userId)) {
            // Prevent marking offline if they quickly reconnected
            disconnectQueue.delete(userId);
          } else {
            // Only update DB if they were truly offline
            supabase.from('profiles').update({ online: true }).eq('id', userId).then(() => {});
          }
        }
        onlineCountChanged = true;
      })
      .catch(err => console.error('Profile fetch error:', err));

    // ===== WORLD CHAT =====
    socket.on('worldChat:send', async (message) => {
      if (!message || !message.trim()) return;
      const msg = message.trim().substring(0, 500);

      // Broadcast IMMEDIATELY, save to DB in background (instant feel)
      io.emit('worldChat:message', {
        id: Date.now(),
        user_id: userId,
        username: profile?.username || 'Unknown',
        equipped_avatar_url: profile?.equipped_avatar_url,
        level: profile?.level || 1,
        message: msg,
        created_at: new Date().toISOString()
      });

      // Fire-and-forget DB save
      supabase.from('world_chat').insert({ user_id: userId, message: msg }).then(() => {});
    });

    // ===== DIRECT MESSAGES =====
    socket.on('dm:send', async ({ receiverId, message }) => {
      if (!message || !message.trim() || !receiverId) return;
      const msg = message.trim().substring(0, 1000);

      const userClient = getSupabaseClient(socket.handshake.auth.token);
      const { data: dm, error } = await userClient.from('direct_messages')
        .insert({ sender_id: userId, receiver_id: receiverId, message: msg })
        .select()
        .single();
        
      if (error || !dm) return console.error('DM insert error:', error);

      // Send to sender & receiver simultaneously
      socket.emit('dm:message', { ...dm, sender: profile });
      io.to(receiverId).emit('dm:message', { ...dm, sender: profile });

      // Fire-and-forget: notification insert + push
      const notifMsg = (profile?.username || 'Someone') + ': ' + msg.substring(0, 80) + (msg.length > 80 ? '...' : '');
      userClient.from('notifications').insert({
        user_id: receiverId,
        type: 'message',
        title: '💬 New Message',
        message: notifMsg,
        read: false
      }).then(() => {});

      io.to(receiverId).emit('notification', {
        type: 'message',
        title: '💬 New Message',
        message: (profile?.username || 'Someone') + ' sent you a message'
      });
    });

    socket.on('dm:history', async ({ friendId }) => {
      const userClient = getSupabaseClient(socket.handshake.auth.token);
      const { data: messages } = await userClient
        .from('direct_messages')
        .select('*, sender:sender_id(username, equipped_avatar_url)')
        .or(`and(sender_id.eq.${userId},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${userId})`)
        .order('created_at', { ascending: true })
        .limit(100);

      socket.emit('dm:historyData', messages || []);
    });

    // ===== MATCHMAKING =====
    socket.on('matchmaking:join', async ({ mode }) => {
      await profileReady; // ensure profile is loaded before using it
      const player = {
        socketId: socket.id,
        userId,
        username: profile?.username || 'Unknown',
        avatarUrl: profile?.equipped_avatar_url,
        level: profile?.level || 1,
        rank: profile?.rank || 'Bronze',
        mode: mode || 'ranked',
        token: socket.handshake.auth.token
      };

      // Check if already in queue
      matchQueue.delete(userId);
      matchQueue.set(userId, player);
      
      socket.emit('matchmaking:searching');

      // Try to match
      tryMatch(io, player);
    });

    socket.on('matchmaking:cancel', () => {
      matchQueue.delete(userId);
      socket.emit('matchmaking:cancelled');
    });

    // ===== GAME JOIN (after page redirect) =====
    socket.on('game:join', ({ roomId }) => {
      const game = activeGames.get(roomId);
      if (!game) {
        log(`[Game Join] Failed: Game ${roomId} not found for user ${userId}`);
        return socket.emit('game:error', { message: 'Game not found' });
      }

      const playerIndex = game.players.findIndex(p => p.userId === userId);
      if (playerIndex === -1) {
        log(`[Game Join] Failed: User ${userId} is not in players array:`, game.players);
        return socket.emit('game:error', { message: 'Not a player in this game' });
      }

      // Update socketId (changed after page redirect)
      game.players[playerIndex].socketId = socket.id;

      // Join the socket room
      socket.join(roomId);
      log(`[Game Join] Success: Player ${userId} joined room ${roomId}`);

      // Send full game state to this player
      socket.emit('game:init', {
        roomId,
        players: sanitizePlayers(game.players),
        board: game.board,
        currentTurn: game.currentTurn,
        gameOver: game.gameOver || false,
        winner: game.winner !== undefined ? game.winner : null
      });
    });

    // ===== FRIENDS ROOM =====
    socket.on('create_friend_room', async () => {
      await profileReady;
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const host = {
        socketId: socket.id,
        userId,
        username: profile?.username || 'Unknown',
        avatarUrl: profile?.equipped_avatar_url,
        level: profile?.level || 1,
        rank: profile?.rank || 'Bronze',
        mode: 'friend',
        token: socket.handshake.auth.token
      };
      
      // Clean up past rooms by same user in O(1)
      const existingCode = userHostedRooms.get(userId);
      if (existingCode) friendRooms.delete(existingCode);
      
      friendRooms.set(code, host);
      userHostedRooms.set(userId, code);
      socket.emit('room_created', { code });
    });

    socket.on('join_friend_room', async (code) => {
      await profileReady;
      const roomCode = code?.toUpperCase();
      const host = friendRooms.get(roomCode);
      if (!host) {
        return socket.emit('join_error', { message: 'Invalid or expired room code' });
      }
      
      const guest = {
        socketId: socket.id,
        userId,
        username: profile?.username || 'Unknown',
        avatarUrl: profile?.equipped_avatar_url,
        level: profile?.level || 1,
        rank: profile?.rank || 'Bronze',
        mode: 'friend',
        token: socket.handshake.auth.token
      };

      if (host.userId === guest.userId) {
        return socket.emit('join_error', { message: 'Cannot join your own room' });
      }

      friendRooms.delete(roomCode);
      userHostedRooms.delete(host.userId);
      
      const roomId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const game = {
        players: [host, guest],
        board: Array(9).fill(null),
        currentTurn: 0,
        gameOver: false,
        mode: 'friend',
        startTime: Date.now()
      };

      activeGames.set(roomId, game);
      gameTokens.set(roomId, { p1Token: host.token, p2Token: guest.token });

      const socket1 = io.sockets.sockets.get(host.socketId);
      const socket2 = io.sockets.sockets.get(guest.socketId);
      if (socket1) socket1.join(roomId);
      if (socket2) socket2.join(roomId);

      io.to(roomId).emit('matchmaking:found', {
        roomId,
        players: sanitizePlayers(game.players),
        board: game.board,
        currentTurn: 0
      });
    });

    // ===== FRIEND INVITE =====
    socket.on('invite_friend', async (data) => {
      await profileReady;
      const { targetId, roomCode } = data || {};
      if (!targetId || !roomCode) return;

      // Check cooldown (10 seconds)
      const now = Date.now();
      const lastInvite = inviteCooldowns.get(userId) || 0;
      if (now - lastInvite < 10000) {
        return socket.emit('invite_error', { message: 'Please wait 10 seconds before inviting again' });
      }
      inviteCooldowns.set(userId, now);

      // Real-time popup
      io.to(targetId).emit('friend_invite', {
        from: profile?.username || 'Someone',
        fromId: userId,
        roomCode
      });

      // Fire-and-forget: persist notification
      const notifPromise = supabase.from('notifications').insert({
        user_id: targetId,
        type: 'match_invite',
        title: '🎮 Game Invite',
        message: (profile?.username || 'Someone') + ' invited you to play! Code: ' + roomCode,
        read: false
      }).select('id').single();

      // Push notification event immediately
      io.to(targetId).emit('notification', {
        type: 'match_invite',
        title: '🎮 Game Invite',
        message: (profile?.username || 'Someone') + ' invited you to play! Code: ' + roomCode
      });

      // Auto-expire invite notification after 10 seconds
      notifPromise.then(({ data: newNotif }) => {
        if (newNotif) {
          setTimeout(() => {
            supabase.from('notifications').delete().eq('id', newNotif.id).then(() => {});
          }, 10000);
        }
      }).catch(() => {});
    });

    // ===== GAME =====
    socket.on('game:move', ({ roomId, index }) => {
      const game = activeGames.get(roomId);
      if (!game) return;

      const playerIndex = game.players.findIndex(p => p.userId === userId);
      if (playerIndex === -1) return;
      if (game.currentTurn !== playerIndex) return;
      if (game.board[index] !== null) return;
      if (game.gameOver) return;

      game.board[index] = playerIndex === 0 ? 'X' : 'O';
      game.currentTurn = game.currentTurn === 0 ? 1 : 0;

      // Check winner
      const winner = checkWinner(game.board);
      if (winner) {
        game.gameOver = true;
        game.winner = winner === 'X' ? 0 : 1;
        finishGame(io, roomId, game);
      } else if (game.board.every(c => c !== null)) {
        game.gameOver = true;
        game.winner = -1; // draw
        finishGame(io, roomId, game);
      }

      io.to(roomId).emit('game:state', {
        board: game.board,
        currentTurn: game.currentTurn,
        gameOver: game.gameOver,
        winner: game.winner !== undefined ? game.winner : null
      });
    });

    socket.on('game:chat', ({ roomId, message }) => {
      io.to(roomId).emit('game:chatMessage', {
        userId,
        username: profile?.username || 'Unknown',
        avatarUrl: profile?.equipped_avatar_url,
        message
      });
    });

    socket.on('game:rematch', ({ roomId }) => {
      const game = activeGames.get(roomId);
      if (!game) return;

      if (!game.rematchVotes) game.rematchVotes = new Set();
      game.rematchVotes.add(userId);

      if (game.rematchVotes.size >= 2) {
        // Reset game
        game.board = Array(9).fill(null);
        game.currentTurn = 0;
        game.gameOver = false;
        game.winner = undefined;
        game.rematchVotes = new Set();
        game.startTime = Date.now();

        io.to(roomId).emit('game:rematchStart', {
          board: game.board,
          currentTurn: 0,
          players: sanitizePlayers(game.players)
        });
      } else {
        io.to(roomId).emit('game:rematchRequested', { userId });
      }
    });

    // ===== DISCONNECT =====
    socket.on('disconnect', async () => {
      connectedUsers.delete(socket.id);
      
      // Buffer DB updates to prevent network spam on flaky connections
      disconnectQueue.add(userId);

      // Remove from matchmaking queue O(1)
      matchQueue.delete(userId);

      // Remove hosted friend rooms O(1)
      const existingCode = userHostedRooms.get(userId);
      if (existingCode) {
        friendRooms.delete(existingCode);
        userHostedRooms.delete(userId);
      }

      // Check for active games and auto-forfeit if game not over yet
      for (const [roomId, game] of activeGames.entries()) {
        if (game.gameOver) continue;
        
        const playerIndex = game.players.findIndex(p => p.userId === userId);
        if (playerIndex !== -1) {
          game.gameOver = true;
          // The other player wins by default
          game.winner = playerIndex === 0 ? 1 : 0; 
          finishGame(io, roomId, game);
          log(`Game ${roomId} forfeited due to player ${userId} disconnect.`);
        }
      }

      onlineCountChanged = true;
    });
  });
}

function tryMatch(io, player) {
  // Find another player in same mode
  let match = null;
  for (const [uid, p] of matchQueue.entries()) {
    if (uid !== player.userId && p.mode === player.mode) {
      match = p;
      break;
    }
  }
  
  if (!match) return;

  // Remove both from queue
  matchQueue.delete(player.userId);
  matchQueue.delete(match.userId);

  // Create game room
  const roomId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const game = {
    players: [
      { userId: player.userId, username: player.username, avatarUrl: player.avatarUrl, level: player.level, rank: player.rank, token: player.token },
      { userId: match.userId, username: match.username, avatarUrl: match.avatarUrl, level: match.level, rank: match.rank, token: match.token }
    ],
    board: Array(9).fill(null),
    currentTurn: 0,
    gameOver: false,
    mode: player.mode,
    startTime: Date.now()
  };

  activeGames.set(roomId, game);
  gameTokens.set(roomId, { p1Token: player.token, p2Token: match.token });

  // Join both sockets to room
  const socket1 = io.sockets.sockets.get(player.socketId);
  const socket2 = io.sockets.sockets.get(match.socketId);
  if (socket1) socket1.join(roomId);
  if (socket2) socket2.join(roomId);

  // Notify both players
  io.to(roomId).emit('matchmaking:found', {
    roomId,
    players: sanitizePlayers(game.players),
    board: game.board,
    currentTurn: 0
  });
}

function checkWinner(board) {
  const patterns = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of patterns) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

async function finishGame(io, roomId, game) {
  const duration = Math.floor((Date.now() - game.startTime) / 1000);
  const p1 = game.players[0];
  const p2 = game.players[1];

  let result, xpP1, xpP2, coinsP1, coinsP2, rpP1, rpP2;
  if (game.winner === 0) {
    result = 'player1';
    xpP1 = 120; xpP2 = 30; coinsP1 = 80; coinsP2 = 10; rpP1 = 15; rpP2 = -10;
  } else if (game.winner === 1) {
    result = 'player2';
    xpP1 = 30; xpP2 = 120; coinsP1 = 10; coinsP2 = 80; rpP1 = -10; rpP2 = 15;
  } else {
    result = 'draw';
    xpP1 = 60; xpP2 = 60; coinsP1 = 40; coinsP2 = 40; rpP1 = 5; rpP2 = 5;
  }

  if (game.mode !== 'ranked') { rpP1 = 0; rpP2 = 0; xpP1 = 0; xpP2 = 0; coinsP1 = 0; coinsP2 = 0; }

  // Retrieve tokens from server-side vault (never exposed to clients)
  const tokens = gameTokens.get(roomId) || {};
  const authClient = getSupabaseClient(tokens.p1Token || tokens.p2Token);

  // Save match + update profiles ALL IN PARALLEL
  const ops = [
    authClient.from('matches').insert({
      player1_id: p1.userId, player2_id: p2.userId,
      winner_id: game.winner >= 0 ? game.players[game.winner].userId : null,
      mode: game.mode, result, duration_seconds: duration,
      board_state: game.board,
      xp_player1: xpP1, xp_player2: xpP2,
      coins_player1: coinsP1, coins_player2: coinsP2,
      rank_points_player1: rpP1, rank_points_player2: rpP2
    })
  ];

  // Update player stats in PARALLEL for ranked matches
  if (game.mode === 'ranked') {
    const updatePlayer = async (player, playerToken, xp, coins, rp, isWinner) => {
      const pClient = getSupabaseClient(playerToken);
      const { data: prof, error: profErr } = await pClient.from('profiles').select('xp, xp_to_next, coins, score, wins, losses, draws, level').eq('id', player.userId).single();
      if (profErr || !prof) return;
      const { xp: newXp, level: newLevel, xp_to_next: newXpToNext } = calculateLevelUp(prof.xp, prof.level, prof.xp_to_next, xp);
      const updates = {
        xp: newXp,
        level: newLevel,
        xp_to_next: newXpToNext,
        coins: prof.coins + coins,
        score: Math.max(0, prof.score + rp)
      };
      if (isWinner) updates.wins = prof.wins + 1;
      else if (game.winner === -1) updates.draws = prof.draws + 1;
      else updates.losses = prof.losses + 1;

      await pClient.from('profiles').update(updates).eq('id', player.userId);
    };

    ops.push(updatePlayer(p1, tokens.p1Token, xpP1, coinsP1, rpP1, game.winner === 0));
    ops.push(updatePlayer(p2, tokens.p2Token, xpP2, coinsP2, rpP2, game.winner === 1));
  }

  // Execute match insert + player updates all at once
  await Promise.all(ops);

  // Clean up token vault
  gameTokens.delete(roomId);

  // Run achievements processor (don't await — fire and forget for speed)
  processMatchAchievements(game, p1, p2, io, roomId).catch(e => {
    console.error('[finishGame] Error processing achievements:', e);
  });

  // Emit game result IMMEDIATELY (don't wait for achievements)
  io.to(roomId).emit('game:result', {
    result, duration, players: sanitizePlayers(game.players),
    rewards: {
      player1: { xp: xpP1, coins: coinsP1, rankPoints: rpP1 },
      player2: { xp: xpP2, coins: coinsP2, rankPoints: rpP2 }
    }
  });
}

// Cleanup stale games, cooldowns, and socket auth cache every 5 minutes
setInterval(() => {
  const now = Date.now();
  const STALE_GAME_MS = 30 * 60 * 1000; // 30 min
  
  for (const [id, game] of activeGames.entries()) {
    // Zombie room prevention: delete ANY game older than 30 mins even if not marked gameOver
    if (now - game.startTime > STALE_GAME_MS) {
       activeGames.delete(id);
       gameTokens.delete(id);
    }
  }
  for (const [uid, ts] of inviteCooldowns.entries()) {
    if (now - ts > 60000) inviteCooldowns.delete(uid);
  }
  // Clean socket auth cache
  for (const [token, cached] of socketAuthCache.entries()) {
    if (now > cached.expiresAt) socketAuthCache.delete(token);
  }
}, 5 * 60 * 1000);

// Flusher: Process debounced broadcasts and bulk offline DB updates every 5 seconds
setInterval(() => {
  // 1. Debounced Broadcast
  if (onlineCountChanged && global.__io) {
    global.__io.emit('onlineCount', connectedUsers.size);
    onlineCountChanged = false;
  }
  
  // 2. Buffered Disconnect DB Updates
  if (disconnectQueue.size > 0) {
    const offlineIds = Array.from(disconnectQueue);
    disconnectQueue.clear();
    
    // Instead of heavy N individual updates, we use an 'in' array operation if supported, 
    // but standard supabase doesn't support bulk .update() with .in() simply without a stored procedure.
    // So we'll map them, but bounded inside a Promise.all with low priority.
    Promise.all(offlineIds.map(uid => 
      supabase.from('profiles').update({ online: false, last_seen: new Date().toISOString() }).eq('id', uid)
    )).catch(e => console.error('Bulk offline update failed', e));
  }
}, 5000);

module.exports = { setupSocket };
