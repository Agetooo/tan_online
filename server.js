import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createDeck, shuffleDeck, canDefend, canAttack } from './src/gameLogic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// Serve static files from the React frontend build in production
app.use(express.static(path.join(__dirname, 'dist')));

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 5000,   // Send a ping message every 5 seconds to verify client health
  pingTimeout: 10000    // Consider client disconnected after 10 seconds of silence
});

const PORT = process.env.PORT || 3001;

// In-memory store for game rooms
// Key: roomId, Value: Room State Object
const rooms = new Map();

// Helper to log game events
function logGame(room, message) {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const logMsg = `[${time}] ${message}`;
  room.logs.unshift(logMsg);
  if (room.logs.length > 50) {
    room.logs.pop();
  }
}

// Get clean player representation (hide other players' cards to prevent cheating and optimize network payload)
function getCleanRoomState(room, requestSocketId) {
  const players = room.players.map(p => {
    const isSelf = p.socketId === requestSocketId;
    return {
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      isBot: p.isBot,
      isOnline: p.isBot ? true : (p.socketId !== null),
      handSize: p.hand.length,
      status: p.status,
      hand: isSelf ? p.hand : undefined
    };
  });

  return {
    id: room.id,
    status: room.status,
    players,
    deckSize: room.deck.length,
    trumpCard: room.trumpCard,
    trumpSuit: room.trumpSuit,
    tablePairs: room.tablePairs,
    discardPileSize: room.discardPile.length,
    attackerId: room.attackerId,
    defenderId: room.defenderId,
    logs: room.logs,
    passedPlayers: room.passedPlayers,
    defenderWantsToTake: room.defenderWantsToTake,
    winners: room.winners || [],
    lastWinners: room.lastWinners || [],
    takeTimerRemaining: room.takeTimerExpiresAt ? Math.max(0, Math.ceil((room.takeTimerExpiresAt - Date.now()) / 1000)) : null,
    swapRequest: room.swapRequest || null,
    maxPlayers: room.maxPlayers || 4,
    targetHandSize: room.targetHandSize || 8
  };
}

// Broadcast game state to all players in the room, optimized for each specific player
function broadcastRoomState(room) {
  room.players.forEach(p => {
    if (p.socketId) {
      io.to(p.socketId).emit('room-state', getCleanRoomState(room, p.socketId));
    }
  });
}

// Find next active player in clockwise order starting from a specific index
function getNextActivePlayerIndex(room, startIndex) {
  const count = room.players.length;
  for (let i = 1; i <= count; i++) {
    const idx = (startIndex + i) % count;
    const p = room.players[idx];
    if (p.status !== 'win' && p.status !== 'out') {
      return idx;
    }
  }
  return -1;
}

// Determine who starts the first turn of a new game.
// If there was a previous game and the winner is still in the room, they start.
// Otherwise, the player with the lowest trump card starts.
function determineFirstAttacker(room) {
  // If a player swapped the 2 of trump, they ALWAYS start first (overriding previous game winner!)
  if (room.twoOfTrumpStarterId) {
    const starter = room.players.find(p => p.id === room.twoOfTrumpStarterId);
    // Reset the starter ID
    room.twoOfTrumpStarterId = null;
    if (starter) {
      return starter;
    }
  }

  // If very first game of the room (no previous winner exists yet in this room),
  // randomize who attacks first (satisfies request: random ng bat dau tan, khong mac dinh chu phong)
  if (!room.lastWinnerId) {
    const activePlayers = room.players.filter(p => p.status !== 'win' && p.status !== 'out');
    if (activePlayers.length > 0) {
      const randomPlayer = activePlayers[Math.floor(Math.random() * activePlayers.length)];
      logGame(room, `🎲 Ván đầu tiên: Chọn ngẫu nhiên ${randomPlayer.name} tấn đầu.`);
      return randomPlayer;
    }
  }

  // Check if we have a winner from the previous game who is still active in this game
  if (room.lastWinnerId) {
    const prevWinner = room.players.find(p => p.id === room.lastWinnerId);
    if (prevWinner) {
      logGame(room, `👑 ${prevWinner.name} thắng ván trước nên được quyền tấn đầu tiên.`);
      return prevWinner;
    }
  }

  let firstAttacker = null;
  let lowestTrumpRank = 15; // Higher than Ace (14)

  room.players.forEach(player => {
    player.hand.forEach(card => {
      if (card.suit === room.trumpSuit && card.rank < lowestTrumpRank) {
        lowestTrumpRank = card.rank;
        firstAttacker = player;
      }
    });
  });

  // Fallback
  if (!firstAttacker) {
    firstAttacker = room.players.find(p => p.isHost && p.status !== 'win') || room.players[0];
  }

  return firstAttacker;
}

// Draw cards from the stock deck at the end of a round
function drawCardsForPlayers(room) {
  if (room.deck.length === 0) return;

  // Draw priority:
  // 1. Attacker (firstAttackerId)
  // 2. Clockwise other players (excluding defender)
  // 3. Defender (defenderId)
  const order = [];
  const attackerIdx = room.players.findIndex(p => p.id === room.firstAttackerId);
  const defenderIdx = room.players.findIndex(p => p.id === room.defenderId);

  if (attackerIdx !== -1) {
    order.push(room.players[attackerIdx]);
  }

  // Clockwise players excluding defender and attacker
  let nextIdx = (attackerIdx + 1) % room.players.length;
  while (nextIdx !== attackerIdx) {
    if (nextIdx !== defenderIdx) {
      order.push(room.players[nextIdx]);
    }
    nextIdx = (nextIdx + 1) % room.players.length;
  }

  if (defenderIdx !== -1) {
    order.push(room.players[defenderIdx]);
  }

  // Filter out won/out players
  const activeDrawers = order.filter(p => p.status !== 'win' && p.status !== 'out');

  // Draw until everyone has target cards or deck is empty
  let cardDrawn = false;
  const targetHandSize = room.targetHandSize || 8;
  activeDrawers.forEach(player => {
    while (player.hand.length < targetHandSize && room.deck.length > 0) {
      const drawnCard = room.deck.pop();
      player.hand.push(drawnCard);
      cardDrawn = true;
    }
  });

  if (cardDrawn) {
    logGame(room, `Các người chơi đã bốc thêm bài từ nọc.`);
  }
}

// Helper to update win statuses of players who have finished their cards
function updateWinStatuses(room) {
  if (!room.winners) room.winners = [];
  room.players.forEach(p => {
    if (p.status === 'win' || p.status === 'out') return;

    if (p.hand.length === 0 && room.deck.length === 0) {
      p.status = 'win';
      if (!room.winners.includes(p.id)) {
        room.winners.push(p.id);
      }
      logGame(room, `🎉 ${p.name} đã hết bài và giành chiến thắng!`);
    }
  });
}

// Check if players have won (finished cards when stock is empty)
// Returns true if game is over
function checkWinConditions(room) {
  updateWinStatuses(room);
  
  let activeCount = 0;
  let loser = null;

  room.players.forEach(p => {
    if (p.status !== 'win' && p.status !== 'out') {
      activeCount++;
      loser = p;
    }
  });

  // Game is over if only 1 active player remains, or 0 (all finished simultaneously)
  if (activeCount <= 1) {
    room.status = 'game_over';
    if (loser) {
      loser.status = 'out';
      if (!room.winners.includes(loser.id)) {
        room.winners.push(loser.id);
      }
    }
    // Append any remaining player who is not in winners array
    room.players.forEach(p => {
      if (!room.winners.includes(p.id)) {
        room.winners.push(p.id);
      }
    });
    // Store the final ranking results in lastWinners and lastWinnerId
    room.lastWinners = [...room.winners];
    room.lastWinnerId = room.winners[0];

    logGame(room, `🏁 Trò chơi kết thúc! Bảng xếp hạng: ${room.winners.map((id, i) => `${i+1}. ${room.players.find(p => p.id === id).name}`).join(', ')}`);
    return true;
  }
  return false;
}

// Start a new round of play
function startNewRound(room, nextAttackerId) {
  // Check win conditions first
  if (checkWinConditions(room)) {
    broadcastRoomState(room);
    return;
  }

  room.tablePairs = [];
  room.passedPlayers = [];
  room.roundActive = true;

  // Set next attacker
  const attackerIdx = room.players.findIndex(p => p.id === nextAttackerId);
  const attacker = room.players[attackerIdx];
  room.attackerId = nextAttackerId;
  room.firstAttackerId = nextAttackerId;

  // Defender is the next active player clockwise from the attacker
  const defenderIdx = getNextActivePlayerIndex(room, attackerIdx);
  const defender = room.players[defenderIdx];
  room.defenderId = defender.id;

  // Reset statuses for active players
  room.players.forEach(p => {
    if (p.status !== 'win' && p.status !== 'out') {
      if (p.id === attacker.id) {
        p.status = 'attacker';
      } else if (p.id === defender.id) {
        p.status = 'defender';
      } else {
        p.status = 'idle';
      }
    }
  });

  room.maxAttacks = defender.hand.length;

  logGame(room, `⚔️ Vòng mới bắt đầu! ${attacker.name} tấn công, ${defender.name} phòng thủ.`);
  broadcastRoomState(room);

  // Trigger bot AI if attacker is a bot
  triggerBotAction(room);
}

// AI Bot behavior logic
function triggerBotAction(room) {
  if (room.status !== 'playing') return;

  // Find all active bots
  const bots = room.players.filter(p => p.isBot && p.status !== 'win' && p.status !== 'out');
  if (bots.length === 0) return;

  // Evaluate action for each bot with a slight staggered delay to feel natural
  bots.forEach(bot => {
    const delay = 1000 + Math.random() * 1500; // 1s to 2.5s delay
    setTimeout(() => {
      // Re-fetch room in case state changed during delay
      const currentRoom = rooms.get(room.id);
      if (!currentRoom || currentRoom.status !== 'playing') return;

      const currentBot = currentRoom.players.find(p => p.id === bot.id);
      if (!currentBot || currentBot.status === 'win' || currentBot.status === 'out') return;

      handleBotDecision(currentRoom, currentBot);
    }, delay);
  });
}

function handleBotDecision(room, bot) {
  const defender = room.players.find(p => p.id === room.defenderId);
  if (!defender) return;

  // 1. Bot is the Defender
  if (bot.status === 'defender') {
    // Check if we can "Chuyền Tấn" (Transfer)
    const canTransferTable = room.tablePairs.length > 0 && room.tablePairs.every(p => !p.defense);
    if (canTransferTable) {
      const tableRank = room.tablePairs[0].attack.rank;
      const allSameRank = room.tablePairs.every(p => p.attack.rank === tableRank);
      if (allSameRank) {
        const matchingCard = bot.hand.find(c => c.rank === tableRank);
        if (matchingCard) {
          const currentIdx = room.players.findIndex(p => p.id === bot.id);
          const nextIdx = getNextActivePlayerIndex(room, currentIdx);
          const nextPlayer = room.players[nextIdx];
          if (nextPlayer) {
            // Bot chooses to Chuyền Tấn!
            bot.hand = bot.hand.filter(c => c.id !== matchingCard.id);
            room.tablePairs.push({
              id: `pair_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
              attack: matchingCard
            });
            
            logGame(room, `🔄 Bot ${bot.name} đã chuyền tấn bằng quân ${matchingCard.rank} cho ${nextPlayer.name}!`);
            
            room.defenderId = nextPlayer.id;
            room.passedPlayers = [];
            room.players.forEach(p => {
              if (p.status !== 'win' && p.status !== 'out') {
                if (p.id === room.defenderId) {
                  p.status = 'defender';
                } else if (p.id === room.attackerId) {
                  p.status = 'attacker';
                } else {
                  p.status = 'idle';
                }
              }
            });
            room.maxAttacks = nextPlayer.hand.length;
            
            broadcastRoomState(room);
            if (checkWinConditions(room)) {
              broadcastRoomState(room);
              return;
            }
            triggerBotAction(room);
            return;
          }
        }
      }
    }

    // Find all undefended cards
    const undefendedPairs = room.tablePairs.filter(p => !p.defense);
    if (undefendedPairs.length === 0) return; // Nothing to defend right now

    // Try to defend the first undefended card
    const targetPair = undefendedPairs[0];
    const attackCard = targetPair.attack;

    // Find all valid cards in hand that can beat this attack card
    const validDefenses = bot.hand.filter(c => canDefend(attackCard, c, room.trumpSuit));

    if (validDefenses.length > 0) {
      // Choose the lowest card among valid defenses to save high cards
      // Prioritize non-trump, then trump
      validDefenses.sort((a, b) => {
        const aIsTrump = a.suit === room.trumpSuit;
        const bIsTrump = b.suit === room.trumpSuit;
        if (aIsTrump && !bIsTrump) return 1;
        if (!aIsTrump && bIsTrump) return -1;
        return a.rank - b.rank;
      });

      const chosenCard = validDefenses[0];
      
      // Play the card as defense
      bot.hand = bot.hand.filter(c => c.id !== chosenCard.id);
      targetPair.defense = chosenCard;
      room.passedPlayers = []; // Reset passes since state changed

      logGame(room, `🛡️ Bot ${bot.name} đỡ lá ${attackCard.rank} ${attackCard.suit} bằng ${chosenCard.rank} ${chosenCard.suit}`);
      if (bot.hand.length === 0 && room.deck.length === 0) {
        logGame(room, `📣 Bot ${bot.name} đã hết bài! Các người chơi khác có 10 giây để chạy bài (theo bài)...`);
      }
      broadcastRoomState(room);
      if (checkWinConditions(room)) {
        broadcastRoomState(room);
        return;
      }
      checkRoundResolution(room);

      // Trigger next actions (other bots might attack, or defender might defend more)
      triggerBotAction(room);
    } else {
      // Cannot defend! If this undefended card has been sitting for a bit (or we just choose to take cards)
      // For simplicity, if a bot cannot defend, it will immediately "Ôm" (take) the cards.
      botTakeCards(room, bot);
    }
  }

  // 2. Bot is an Attacker (either main or secondary)
  else {
    // Cannot attack if the defender has won/out
    const isInitialAttack = room.tablePairs.length === 0;

    // If initial attack, bot must be the primary attacker
    if (isInitialAttack) {
      if (bot.status === 'attacker') {
        // Choose lowest card to start, preferably non-trump
        const playableCards = [...bot.hand];
        playableCards.sort((a, b) => {
          const aIsTrump = a.suit === room.trumpSuit;
          const bIsTrump = b.suit === room.trumpSuit;
          if (aIsTrump && !bIsTrump) return 1;
          if (!aIsTrump && bIsTrump) return -1;
          return a.rank - b.rank;
        });

        const chosenCard = playableCards[0];
        bot.hand = bot.hand.filter(c => c.id !== chosenCard.id);
        room.tablePairs.push({
          id: `pair_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          attack: chosenCard
        });
        room.passedPlayers = [];

        logGame(room, `⚔️ Bot ${bot.name} tấn công đầu bằng ${chosenCard.rank} ${chosenCard.suit}`);
        if (bot.hand.length === 0 && room.deck.length === 0) {
          logGame(room, `📣 Bot ${bot.name} đã hết bài! Các người chơi khác có 10 giây để chạy bài (theo bài)...`);
        }
        broadcastRoomState(room);
        if (checkWinConditions(room)) {
          broadcastRoomState(room);
          return;
        }
        checkRoundResolution(room);

        triggerBotAction(room);
      }
    } 
    // Not initial attack: can attack with matching ranks
    else {
      // Find if we have already passed
      if (room.passedPlayers.includes(bot.id)) return;

      // Find playable cards that match table ranks
      const playableCards = bot.hand.filter(c => canAttack(c, room.tablePairs, false));

      if (playableCards.length > 0) {
        // Play one matching card (preferably lowest rank, non-trump)
        playableCards.sort((a, b) => {
          const aIsTrump = a.suit === room.trumpSuit;
          const bIsTrump = b.suit === room.trumpSuit;
          if (aIsTrump && !bIsTrump) return 1;
          if (!aIsTrump && bIsTrump) return -1;
          return a.rank - b.rank;
        });

        const chosenCard = playableCards[0];
        
        bot.hand = bot.hand.filter(c => c.id !== chosenCard.id);
        room.tablePairs.push({
          id: `pair_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          attack: chosenCard
        });
        room.passedPlayers = [];

        // Reset take timer if active
        if (room.defenderWantsToTake) {
          room.takeTimerExpiresAt = Date.now() + 10000;
          if (room.takeTimeoutId) clearTimeout(room.takeTimeoutId);
          room.takeTimeoutId = setTimeout(() => {
            const defender = room.players.find(p => p.id === room.defenderId);
            if (defender && room.defenderWantsToTake) {
              logGame(room, `⏱️ Hết thời gian tấn thêm, tự động ôm bài.`);
              executeTakeCards(room, defender);
              broadcastRoomState(room);
            }
          }, 10000);
        }

        logGame(room, `⚔️ Bot ${bot.name} tấn thêm lá ${chosenCard.rank} ${chosenCard.suit}`);
        if (bot.hand.length === 0 && room.deck.length === 0) {
          logGame(room, `📣 Bot ${bot.name} đã hết bài! Các người chơi khác có 10 giây để chạy bài (theo bài)...`);
        }
        broadcastRoomState(room);
        if (checkWinConditions(room)) {
          broadcastRoomState(room);
          return;
        }
        checkRoundResolution(room);

        triggerBotAction(room);
      } else {
        // No cards to play, pass
        botPass(room, bot);
      }
    }
  }
}

function botPass(room, bot) {
  if (room.passedPlayers.includes(bot.id)) return;
  room.passedPlayers.push(bot.id);
  // Log pass silently to avoid cluttering unless it's critical, or log it
  // logGame(room, `${bot.name} qua lượt.`);
  
  checkRoundResolution(room);
}

// Helper to find attackers who haven't passed yet in the current round
function getUnpassedAttackers(room) {
  const activeAttackers = room.players.filter(p => 
    p.id !== room.defenderId && 
    p.status !== 'win' && 
    p.status !== 'out'
  );
  return activeAttackers.filter(p => !room.passedPlayers.includes(p.id));
}

// Perform the actual action of the defender taking all cards on the table
function executeTakeCards(room, player) {
  logGame(room, `✋ ${player.name} ôm toàn bộ bài trên bàn.`);

  // Collect all table cards
  const allTableCards = [];
  room.tablePairs.forEach(pair => {
    if (pair.attack) allTableCards.push(pair.attack);
    if (pair.defense) allTableCards.push(pair.defense);
  });

  player.hand.push(...allTableCards);
  room.tablePairs = [];
  room.defenderWantsToTake = false;
  room.takeTimerExpiresAt = null;
  if (room.takeTimeoutId) {
    clearTimeout(room.takeTimeoutId);
    room.takeTimeoutId = null;
  }

  // Draw cards for players
  drawCardsForPlayers(room);

  // Update win statuses before finding the next attacker
  updateWinStatuses(room);

  // Check if game is over
  if (checkWinConditions(room)) {
    broadcastRoomState(room);
    return;
  }

  // Defender fails, so the next active player clockwise from defender becomes the new attacker
  const defenderIdx = room.players.findIndex(p => p.id === player.id);
  const nextAttackerIdx = getNextActivePlayerIndex(room, defenderIdx);
  const nextAttacker = room.players[nextAttackerIdx];

  startNewRound(room, nextAttacker.id);
}

function botTakeCards(room, bot) {
  const unpassed = getUnpassedAttackers(room);
  if (unpassed.length > 0) {
    room.defenderWantsToTake = true;
    room.takeTimerExpiresAt = Date.now() + 10000;

    if (room.takeTimeoutId) clearTimeout(room.takeTimeoutId);
    room.takeTimeoutId = setTimeout(() => {
      const defender = room.players.find(p => p.id === room.defenderId);
      if (defender && room.defenderWantsToTake) {
        logGame(room, `⏱️ Hết thời gian tấn thêm, tự động ôm bài.`);
        executeTakeCards(room, defender);
        broadcastRoomState(room);
      }
    }, 10000);

    logGame(room, `✋ Bot ${bot.name} xin ôm bài! Hãy tấn thêm nếu muốn.`);
    broadcastRoomState(room);
    triggerBotAction(room);
  } else {
    executeTakeCards(room, bot);
  }
}

// Check if all players have passed, meaning the round ends in defense success
function checkRoundResolution(room) {
  const defender = room.players.find(p => p.id === room.defenderId);
  if (defender) {
    const hasUndefended = room.tablePairs.some(p => !p.defense);
    if (defender.hand.length === 0 && hasUndefended) {
      if (room.deck.length > 0) {
        let drawnCount = 0;
        const targetHandSize = room.targetHandSize || 8;
        while (defender.hand.length < targetHandSize && room.deck.length > 0) {
          defender.hand.push(room.deck.pop());
          drawnCount++;
        }
        logGame(room, `🔄 ${defender.name} hết bài nhưng còn bài dự phòng, đã bốc thêm ${drawnCount} lá để đỡ tiếp.`);
        broadcastRoomState(room);
        triggerBotAction(room);
        return;
      }
      // If deck is empty and defender has 0 cards, we do NOT resolve immediately.
      // We let the round continue so other players can "theo bài" (chạy bài).
    }
  }

  // Count active players (excluding defender and already won/out players)
  const activeAttackers = room.players.filter(p => 
    p.id !== room.defenderId && 
    p.status !== 'win' && 
    p.status !== 'out' &&
    !p.isBot // Real players or bot players
  );
  
  const botAttackers = room.players.filter(p => 
    p.id !== room.defenderId && 
    p.status !== 'win' && 
    p.status !== 'out' &&
    p.isBot
  );

  const totalAttackers = [...activeAttackers, ...botAttackers];
  const allPassed = totalAttackers.every(p => room.passedPlayers.includes(p.id));

  // Special case: defender runs out of cards and deck is empty (they win!)
  // We resolve the round when all attackers pass (click Hết cửa), allowing them to "theo bài" (chạy bài) first
  if (allPassed && room.deck.length === 0 && defender && defender.hand.length === 0) {
    logGame(room, `🎉 ${defender.name} đã thắng ván đấu do hết bài trên tay và hết nọc!`);
    defender.status = 'win';
    if (!room.winners) room.winners = [];
    if (!room.winners.includes(defender.id)) {
      room.winners.push(defender.id);
    }
    
    // Draw cards for remaining players
    drawCardsForPlayers(room);
    
    if (checkWinConditions(room)) {
      broadcastRoomState(room);
      return;
    }
    
    const defenderIdx = room.players.findIndex(p => p.id === defender.id);
    const nextAttackerIdx = getNextActivePlayerIndex(room, defenderIdx);
    const nextAttacker = room.players[nextAttackerIdx];
    startNewRound(room, nextAttacker.id);
    return;
  }

  // If defender wants to take cards, we resolve when all attackers passed
  if (room.defenderWantsToTake && allPassed) {
    const defender = room.players.find(p => p.id === room.defenderId);
    if (defender) {
      executeTakeCards(room, defender);
    }
    return;
  }

  // Round resolved if:
  // 1. All attackers passed.
  // 2. All cards on the table are successfully defended.
  const allDefended = room.tablePairs.length > 0 && room.tablePairs.every(p => p.defense);

  if (allPassed && allDefended) {
    logGame(room, `✅ Đỡ thành công! Toàn bộ bài trên bàn được úp bỏ.`);

    // Move cards to discard pile
    room.tablePairs.forEach(pair => {
      if (pair.attack) room.discardPile.push(pair.attack);
      if (pair.defense) room.discardPile.push(pair.defense);
    });

    // Draw cards for everyone
    drawCardsForPlayers(room);

    // Update win statuses before choosing the next attacker
    updateWinStatuses(room);

    // Check if game is over
    if (checkWinConditions(room)) {
      broadcastRoomState(room);
      return;
    }

    // Defender defended successfully, so they become the new attacker!
    let nextAttackerId = room.defenderId;
    const defender = room.players.find(p => p.id === room.defenderId);
    if (defender.status === 'win' || defender.status === 'out') {
      const defenderIdx = room.players.findIndex(p => p.id === room.defenderId);
      const nextActiveIdx = getNextActivePlayerIndex(room, defenderIdx);
      nextAttackerId = room.players[nextActiveIdx].id;
    }

    startNewRound(room, nextAttackerId);
  }
}


// Socket.io Events handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // 1. Create Room
  socket.on('create-room', ({ username, maxPlayers }) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const playersLimit = maxPlayers === 5 ? 5 : 4;
    const initialHandSize = playersLimit === 5 ? 6 : 8;
    const newRoom = {
      id: roomId,
      status: 'lobby',
      players: [
        {
          id: `player_${socket.id}`,
          name: username || 'Player',
          socketId: socket.id,
          isHost: true,
          isBot: false,
          hand: [],
          status: 'idle'
        }
      ],
      deck: [],
      trumpCard: null,
      trumpSuit: null,
      tablePairs: [],
      discardPile: [],
      attackerId: null,
      defenderId: null,
      firstAttackerId: null,
      logs: [],
      maxAttacks: initialHandSize,
      maxPlayers: playersLimit,
      targetHandSize: initialHandSize,
      passedPlayers: [],
      roundActive: false
    };

    rooms.set(roomId, newRoom);
    socket.join(roomId);
    
    logGame(newRoom, `🏠 Phòng được tạo bởi ${username}. Mã phòng: ${roomId}`);
    
    socket.emit('room-created', roomId);
    broadcastRoomState(newRoom);
  });

  // 2. Join Room
  socket.on('join-room', ({ roomId, username }) => {
    const room = rooms.get(roomId?.toUpperCase());
    if (!room) {
      socket.emit('error', 'Phòng không tồn tại.');
      return;
    }

    if (room.status !== 'lobby') {
      // Allow re-connection if username/socket matches, but for new player block if playing
      const existingPlayer = room.players.find(p => p.name === username && p.socketId === null);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        socket.join(roomId);
        logGame(room, `🔌 ${username} đã kết nối lại phòng.`);
        broadcastRoomState(room);
        return;
      }
      socket.emit('error', 'Trò chơi đã bắt đầu.');
      return;
    }

    const maxPlayers = room.maxPlayers || 4;
    if (room.players.length >= maxPlayers) {
      socket.emit('error', `Phòng đã đầy (tối đa ${maxPlayers} người).`);
      return;
    }

    const newPlayer = {
      id: `player_${socket.id}`,
      name: username || `Player ${room.players.length + 1}`,
      socketId: socket.id,
      isHost: false,
      isBot: false,
      hand: [],
      status: 'idle'
    };

    room.players.push(newPlayer);
    socket.join(roomId);

    logGame(room, `👥 ${newPlayer.name} đã tham gia phòng.`);
    broadcastRoomState(room);
  });

  // 3. Add Bot
  socket.on('add-bot', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const maxPlayers = room.maxPlayers || 4;
    if (room.players.length >= maxPlayers) {
      socket.emit('error', 'Phòng đã đầy.');
      return;
    }

    const botNames = ['Minh', 'Linh', 'Quân', 'Thảo', 'Đức', 'Trang', 'Hải', 'Lan'];
    // Filter out names already in the room
    const usedNames = room.players.map(p => p.name);
    const availableNames = botNames.filter(name => !usedNames.includes(`Bot ${name}`));
    const botName = availableNames.length > 0 ? `Bot ${availableNames[Math.floor(Math.random() * availableNames.length)]}` : `Bot ${room.players.length + 1}`;

    const botPlayer = {
      id: `bot_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: botName,
      socketId: null,
      isHost: false,
      isBot: true,
      hand: [],
      status: 'idle'
    };

    room.players.push(botPlayer);
    logGame(room, `🤖 Đã thêm robot ${botName} vào phòng.`);
    broadcastRoomState(room);
  });

  // 4. Remove Player / Bot
  socket.on('remove-player', ({ roomId, playerId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Check if requester is host
    const requester = room.players.find(p => p.socketId === socket.id);
    if (!requester || !requester.isHost) {
      socket.emit('error', 'Chỉ có chủ phòng mới kích được người chơi.');
      return;
    }

    const targetIndex = room.players.findIndex(p => p.id === playerId);
    if (targetIndex !== -1) {
      const target = room.players[targetIndex];
      logGame(room, `👋 ${target.name} đã bị mời ra khỏi phòng.`);
      
      if (target.socketId) {
        io.to(target.socketId).emit('kicked');
        const targetSocket = io.sockets.sockets.get(target.socketId);
        if (targetSocket) targetSocket.leave(roomId);
      }
      
      room.players.splice(targetIndex, 1);
      broadcastRoomState(room);
    }
  });

  // 5. Start Game
  socket.on('start-game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Verify host
    const requester = room.players.find(p => p.socketId === socket.id);
    if (!requester || !requester.isHost) return;

    if (room.players.length < 2) {
      socket.emit('error', 'Cần tối thiểu 2 người chơi để bắt đầu.');
      return;
    }

    // Initialize Game state
    room.status = 'playing';
    room.deck = shuffleDeck(createDeck());
    room.discardPile = [];
    room.tablePairs = [];
    room.winners = [];
    room.takeTimerExpiresAt = null;
    room.swapRequest = null; // Reset swap request
    if (room.takeTimeoutId) {
      clearTimeout(room.takeTimeoutId);
      room.takeTimeoutId = null;
    }

    // Deal cards to each player
    const targetHandSize = room.targetHandSize || 8;
    room.players.forEach(p => {
      p.hand = [];
      p.status = 'idle';
      for (let i = 0; i < targetHandSize; i++) {
        p.hand.push(room.deck.pop());
      }
    });

    // Save the previous trump suit to avoid repeating it
    const prevTrumpSuit = room.trumpSuit;
    room.lastTrumpSuit = prevTrumpSuit;

    // Determine Trump Suit (chất trưởng)
    // Draw 1 card, lật ngửa, ensuring rank < 10 and suit is different from previous game
    let trumpCard = null;
    let attempts = 0;
    while (attempts < 100) {
      const card = room.deck.pop();
      const isValidRank = card.rank < 10;
      const isValidSuit = !prevTrumpSuit || card.suit !== prevTrumpSuit;

      if (isValidRank && isValidSuit) {
        trumpCard = card;
        break;
      } else {
        // Put it back to the bottom of the deck and draw another
        room.deck.unshift(card);
        attempts++;
      }
    }

    // Fallback if loop didn't find (highly unlikely)
    if (!trumpCard) {
      trumpCard = room.deck.pop();
    }

    room.trumpCard = trumpCard;
    room.trumpSuit = trumpCard.suit;

    // Put it back to the bottom of the deck (first to be drawn last)
    room.deck.unshift(trumpCard);

    // Check if any player has the 2 of Trump (2_trumpSuit) to exchange it for the face-up card
    room.twoOfTrumpStarterId = null;
    let swapPlayer = null;
    let cardIdx = -1;
    room.players.forEach(p => {
      const idx = p.hand.findIndex(c => c.id === `2_${room.trumpSuit}`);
      if (idx !== -1) {
        swapPlayer = p;
        cardIdx = idx;
      }
    });

    if (swapPlayer) {
      const playerTwoCard = swapPlayer.hand[cardIdx];
      const deckTrumpCard = room.trumpCard;

      // Swap: player gets the face-up card, bottom of deck gets the 2 of trump
      swapPlayer.hand[cardIdx] = deckTrumpCard;
      room.deck[0] = playerTwoCard;
      room.trumpCard = playerTwoCard;
      room.twoOfTrumpStarterId = swapPlayer.id;

      logGame(room, `📣 Do ${swapPlayer.name} sở hữu 2 Trưởng nên được tự động đổi lấy quân lật ${deckTrumpCard.rank} ${deckTrumpCard.suit} và giành quyền tấn đầu tiên!`);
    }

    logGame(room, `🃏 Bắt đầu chơi! Chất trưởng là: ${room.trumpSuit.toUpperCase()} (${trumpCard.rank} ${trumpCard.suit}).`);

    // Determine first attacker
    const firstAttacker = determineFirstAttacker(room);
    
    startNewRound(room, firstAttacker.id);
  });

  // 6. Play Card (Attack or Defend)
  socket.on('play-card', ({ roomId, cardId, targetPairId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.status === 'win' || player.status === 'out') return;

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;

    const card = player.hand[cardIndex];

    // Case A: Player is Defender
    if (player.status === 'defender') {
      if (room.defenderWantsToTake) {
        socket.emit('error', 'Bạn đã xin ôm bài, không thể đỡ tiếp.');
        return;
      }
      if (!targetPairId) {
        socket.emit('error', 'Cần chọn lá bài tấn để đỡ.');
        return;
      }

      const pair = room.tablePairs.find(p => p.id === targetPairId);
      if (!pair || pair.defense) {
        socket.emit('error', 'Lá bài này đã được đỡ hoặc không tồn tại.');
        return;
      }

      // Check validation
      if (canDefend(pair.attack, card, room.trumpSuit)) {
        // Play card
        player.hand.splice(cardIndex, 1);
        pair.defense = card;
        room.passedPlayers = []; // Reset passes since there is action

        logGame(room, `🛡️ ${player.name} đỡ lá ${pair.attack.rank} ${pair.attack.suit} bằng lá ${card.rank} ${card.suit}`);
        if (player.hand.length === 0 && room.deck.length === 0) {
          logGame(room, `📣 ${player.name} đã hết bài! Các người chơi khác có 10 giây để chạy bài (theo bài)...`);
        }
        broadcastRoomState(room);
        if (checkWinConditions(room)) {
          broadcastRoomState(room);
          return;
        }
        checkRoundResolution(room);

        // Check if bots need to respond
        triggerBotAction(room);
      } else {
        socket.emit('error', 'Lá bài đỡ không hợp lệ (phải cùng chất lớn hơn hoặc là chất trưởng).');
      }
    } 
    // Case B: Player is Attacker (main or side)
    else {
      // If initial attack (table is empty), only main attacker can play
      const isInitial = room.tablePairs.length === 0;
      if (isInitial && player.id !== room.attackerId) {
        socket.emit('error', 'Đợi người tấn công chính ra lá bài đầu tiên.');
        return;
      }

      // Check validation
      if (canAttack(card, room.tablePairs, isInitial)) {
        player.hand.splice(cardIndex, 1);
        
        const newPair = {
          id: `pair_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          attack: card
        };
        room.tablePairs.push(newPair);
        room.passedPlayers = []; // Reset passes since game state changed

        // Reset take timer if active
        if (room.defenderWantsToTake) {
          room.takeTimerExpiresAt = Date.now() + 15000;
          if (room.takeTimeoutId) clearTimeout(room.takeTimeoutId);
          room.takeTimeoutId = setTimeout(() => {
            const defender = room.players.find(p => p.id === room.defenderId);
            if (defender && room.defenderWantsToTake) {
              logGame(room, `⏱️ Hết thời gian tấn thêm, tự động ôm bài.`);
              executeTakeCards(room, defender);
              broadcastRoomState(room);
            }
          }, 15000);
        }

        logGame(room, `⚔️ ${player.name} tấn công bằng lá ${card.rank} ${card.suit}`);
        if (player.hand.length === 0 && room.deck.length === 0) {
          logGame(room, `📣 ${player.name} đã hết bài! Các người chơi khác có 10 giây để chạy bài (theo bài)...`);
        }
        broadcastRoomState(room);
        if (checkWinConditions(room)) {
          broadcastRoomState(room);
          return;
        }
        checkRoundResolution(room);

        // Check if bots need to respond
        triggerBotAction(room);
      } else {
        socket.emit('error', 'Lá bài tấn phải cùng số (rank) với các lá đang có trên bàn.');
      }
    }
  });

  // 6.5. Play Multiple Cards (Tấn nhiều lá cùng lúc)
  socket.on('play-cards', ({ roomId, cardIds }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;

    if (player.status === 'defender') {
      socket.emit('error', 'Chỉ người tấn mới có thể đánh nhiều lá cùng lúc.');
      return;
    }

    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      socket.emit('error', 'Danh sách quân bài không hợp lệ.');
      return;
    }

    // Find cards in player's hand
    const cards = [];
    for (const cid of cardIds) {
      const card = player.hand.find(c => c.id === cid);
      if (!card) {
        socket.emit('error', 'Một số quân bài không có trên tay.');
        return;
      }
      cards.push(card);
    }

    // Check that all played cards share the same rank
    const firstRank = cards[0].rank;
    const sameRank = cards.every(c => c.rank === firstRank);
    if (!sameRank) {
      socket.emit('error', 'Các lá bài tấn công cùng lúc phải có cùng số (rank).');
      return;
    }

    const isInitial = room.tablePairs.length === 0;
    if (isInitial && player.id !== room.attackerId) {
      socket.emit('error', 'Đợi người tấn công chính ra lá bài đầu tiên.');
      return;
    }

    // Check if these cards can be played as attacks
    const tableCards = [];
    room.tablePairs.forEach(p => {
      if (p.attack) tableCards.push(p.attack);
      if (p.defense) tableCards.push(p.defense);
    });

    if (!isInitial) {
      const tableRanks = tableCards.map(c => c.rank);
      if (!tableRanks.includes(firstRank)) {
        socket.emit('error', 'Lá bài tấn phải cùng số (rank) với các lá đang có trên bàn.');
        return;
      }
    }

    // Remove cards from player's hand and push to tablePairs
    cards.forEach(card => {
      const idx = player.hand.findIndex(c => c.id === card.id);
      if (idx !== -1) {
        player.hand.splice(idx, 1);
      }
      room.tablePairs.push({
        id: `pair_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        attack: card,
        defense: null
      });
    });

    room.passedPlayers = []; // Reset passes since state changed

    // Reset take timer if active
    if (room.defenderWantsToTake) {
      room.takeTimerExpiresAt = Date.now() + 10000;
      if (room.takeTimeoutId) clearTimeout(room.takeTimeoutId);
      room.takeTimeoutId = setTimeout(() => {
        const defender = room.players.find(p => p.id === room.defenderId);
        if (defender && room.defenderWantsToTake) {
          logGame(room, `⏱️ Hết thời gian tấn thêm, tự động ôm bài.`);
          executeTakeCards(room, defender);
          broadcastRoomState(room);
        }
      }, 10000);
    }

    logGame(room, `⚔️ ${player.name} tấn công bằng ${cards.length} lá ${firstRank}`);
    if (player.hand.length === 0 && room.deck.length === 0) {
      logGame(room, `📣 ${player.name} đã hết bài! Các người chơi khác có 10 giây để chạy bài (theo bài)...`);
    }

    broadcastRoomState(room);
    if (checkWinConditions(room)) {
      broadcastRoomState(room);
      return;
    }
    checkRoundResolution(room);

    // Trigger bot action to respond to the new attacks
    triggerBotAction(room);
  });

  // 7. Pass Turn (For Attackers)
  socket.on('pass', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.status === 'defender' || player.status === 'win' || player.status === 'out') return;

    if (room.passedPlayers.includes(player.id)) return;

    room.passedPlayers.push(player.id);
    logGame(room, `👌 ${player.name} báo không tấn thêm.`);
    broadcastRoomState(room);

    // Check if this triggers round resolution
    checkRoundResolution(room);

    // Bots might respond
    triggerBotAction(room);
  });

  // 8. Take Cards (Defender choosing to "Ôm")
  socket.on('take-cards', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.status !== 'defender') return;

    const unpassed = getUnpassedAttackers(room);
    if (unpassed.length > 0) {
      room.defenderWantsToTake = true;
      room.takeTimerExpiresAt = Date.now() + 10000;

      // Set server timeout to auto-pass and take after 10s
      if (room.takeTimeoutId) clearTimeout(room.takeTimeoutId);
      room.takeTimeoutId = setTimeout(() => {
        const defender = room.players.find(p => p.id === room.defenderId);
        if (defender && room.defenderWantsToTake) {
          logGame(room, `⏱️ Hết thời gian tấn thêm, tự động ôm bài.`);
          executeTakeCards(room, defender);
          broadcastRoomState(room);
        }
      }, 10000);

      logGame(room, `⚠️ ${player.name} xin ôm bài! Hãy tấn thêm nếu muốn.`);
      broadcastRoomState(room);
      triggerBotAction(room);
    } else {
      executeTakeCards(room, player);
    }
  });

  // 8.5. Shift/Reassign Defense Card (For Defender)
  socket.on('shift-defense', ({ roomId, fromPairId, toPairId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.status !== 'defender') return;

    const fromPair = room.tablePairs.find(p => p.id === fromPairId);
    const toPair = room.tablePairs.find(p => p.id === toPairId);

    if (!fromPair || !fromPair.defense || !toPair || toPair.defense) {
      socket.emit('error', 'Di chuyển quân bài đỡ không hợp lệ.');
      return;
    }

    // Validate that the defense card can beat the target attack card
    const card = fromPair.defense;
    if (canDefend(toPair.attack, card, room.trumpSuit)) {
      fromPair.defense = undefined;
      toPair.defense = card;
      room.passedPlayers = []; // Reset passes since the defender updated their cards

      logGame(room, `🔄 ${player.name} chuyển lá đỡ ${card.rank} ${card.suit} sang chặn lá ${toPair.attack.rank} ${toPair.attack.suit}`);
      broadcastRoomState(room);

      // Trigger bots to re-evaluate in case they want to respond to the newly undefended card
      triggerBotAction(room);
    } else {
      socket.emit('error', 'Quân bài đỡ không hợp lệ cho lá bài tấn mới.');
    }
  });

  // 8.6. Chuyền Tấn (Transfer Attack)
  socket.on('transfer-attack', ({ roomId, cardId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.status !== 'defender') return;

    const card = player.hand.find(c => c.id === cardId);
    if (!card) return;

    const canTransferTable = room.tablePairs.length > 0 && room.tablePairs.every(p => !p.defense);
    if (!canTransferTable) {
      socket.emit('error', 'Chỉ có thể chuyền tấn khi chưa đỡ lá bài nào.');
      return;
    }

    const tableRank = room.tablePairs[0].attack.rank;
    const allSameRank = room.tablePairs.every(p => p.attack.rank === tableRank);
    if (!allSameRank || card.rank !== tableRank) {
      socket.emit('error', 'Lá bài chuyền tấn phải có cùng số với các lá đang bị tấn.');
      return;
    }

    const currentIdx = room.players.findIndex(p => p.id === player.id);
    const nextIdx = getNextActivePlayerIndex(room, currentIdx);
    const nextPlayer = room.players[nextIdx];

    if (!nextPlayer) return;

    player.hand = player.hand.filter(c => c.id !== cardId);
    room.tablePairs.push({
      id: `pair_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      attack: card,
      defense: null
    });

    logGame(room, `🔄 ${player.name} đã chuyền tấn bằng quân ${card.rank} cho ${nextPlayer.name}!`);

    room.defenderId = nextPlayer.id;
    room.passedPlayers = [];
    room.players.forEach(p => {
      if (p.status !== 'win' && p.status !== 'out') {
        if (p.id === room.defenderId) {
          p.status = 'defender';
        } else if (p.id === room.attackerId) {
          p.status = 'attacker';
        } else {
          p.status = 'idle';
        }
      }
    });

    room.maxAttacks = nextPlayer.hand.length;

    broadcastRoomState(room);
    if (checkWinConditions(room)) {
      broadcastRoomState(room);
      return;
    }
    triggerBotAction(room);
  });

  // 9. Reconnect / Sync State Request
  socket.on('request-sync', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      socket.emit('room-state', getCleanRoomState(room, socket.id));
    }
  });

  // 9.5. Signaling for Voice Chat
  socket.on('voice-join', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    
    player.voiceActive = true;
    logGame(room, `🎙️ ${player.name} đã bật Voice Chat.`);
    broadcastRoomState(room);
    
    // Notify other players in the room to initiate connection
    socket.to(roomId).emit('voice-peer-joined', { peerId: player.id });
  });

  socket.on('voice-leave', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;
    
    player.voiceActive = false;
    logGame(room, `🔇 ${player.name} đã tắt Voice Chat.`);
    broadcastRoomState(room);
    
    socket.to(roomId).emit('voice-peer-left', { peerId: player.id });
  });

  socket.on('voice-signal', ({ roomId, targetId, signal }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    const targetPlayer = room.players.find(p => p.id === targetId);
    if (targetPlayer && targetPlayer.socketId) {
      const sender = room.players.find(p => p.socketId === socket.id);
      if (sender) {
        io.to(targetPlayer.socketId).emit('voice-signal', {
          senderId: sender.id,
          signal
        });
      }
    }
  });

  // 9.5. Seat Swap (Đổi phong thủy)
  socket.on('swap-request', ({ roomId, targetId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'game_over') return;

    const requester = room.players.find(p => p.socketId === socket.id);
    const target = room.players.find(p => p.id === targetId);
    if (!requester || !target || requester.id === targetId) return;

    if (target.isBot) {
      // Swapping with a bot is approved instantly
      const idxA = room.players.findIndex(p => p.id === requester.id);
      const idxB = room.players.findIndex(p => p.id === target.id);
      if (idxA !== -1 && idxB !== -1) {
        const temp = room.players[idxA];
        room.players[idxA] = room.players[idxB];
        room.players[idxB] = temp;
        logGame(room, `🔄 ${requester.name} đã đổi chỗ ngồi với Bot ${target.name} để đổi phong thủy.`);
      }
      room.swapRequest = null;
      broadcastRoomState(room);
    } else {
      // Send request to human player
      room.swapRequest = {
        requesterId: requester.id,
        targetId: target.id
      };
      broadcastRoomState(room);
    }
  });

  socket.on('swap-accept', ({ roomId, requesterId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'game_over') return;

    if (!room.swapRequest || room.swapRequest.requesterId !== requesterId) return;

    const requester = room.players.find(p => p.id === requesterId);
    const target = room.players.find(p => p.socketId === socket.id);
    if (!requester || !target) return;

    const idxA = room.players.findIndex(p => p.id === requester.id);
    const idxB = room.players.findIndex(p => p.id === target.id);
    if (idxA !== -1 && idxB !== -1) {
      const temp = room.players[idxA];
      room.players[idxA] = room.players[idxB];
      room.players[idxB] = temp;
      logGame(room, `📣 ${requester.name} và ${target.name} đã đồng ý đổi chỗ ngồi cho nhau để đổi phong thủy!`);
    }

    room.swapRequest = null;
    broadcastRoomState(room);
  });

  socket.on('swap-decline', ({ roomId, requesterId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (room.swapRequest && room.swapRequest.requesterId === requesterId) {
      const target = room.players.find(p => p.socketId === socket.id);
      const requester = room.players.find(p => p.id === requesterId);
      if (requester && target) {
        logGame(room, `❌ ${target.name} từ chối đổi chỗ ngồi với ${requester.name}.`);
      }
      room.swapRequest = null;
      broadcastRoomState(room);
    }
  });

  socket.on('swap-cancel', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const requester = room.players.find(p => p.socketId === socket.id);
    if (requester && room.swapRequest && room.swapRequest.requesterId === requester.id) {
      room.swapRequest = null;
      broadcastRoomState(room);
    }
  });

  // 10. Disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    // Find room with this socket
    rooms.forEach((room, roomId) => {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
      if (playerIndex !== -1) {
        const player = room.players[playerIndex];
        player.voiceActive = false; // Reset voice state on disconnect
        socket.to(roomId).emit('voice-peer-left', { peerId: player.id });
        
        // Reset swap request if player was involved
        if (room.swapRequest && (room.swapRequest.requesterId === player.id || room.swapRequest.targetId === player.id)) {
          room.swapRequest = null;
        }

        if (room.status === 'lobby') {
          // If in lobby, simply remove the player
          room.players.splice(playerIndex, 1);
          logGame(room, `👋 ${player.name} đã rời phòng.`);
          
          // If host leaves, assign a new host, or close room if empty
          if (player.isHost && room.players.length > 0) {
            // Find first human player to make host
            const newHost = room.players.find(p => !p.isBot);
            if (newHost) {
              newHost.isHost = true;
              logGame(room, `👑 ${newHost.name} đã trở thành chủ phòng mới.`);
            }
          }
          
          if (room.players.filter(p => !p.isBot).length === 0) {
            rooms.delete(roomId);
            console.log(`Room ${roomId} closed as all human players left.`);
            return;
          }
          
          broadcastRoomState(room);
        } else {
          // If in game, keep the player but mark as offline (socketId = null)
          player.socketId = null;
          logGame(room, `🔌 ${player.name} bị mất kết nối.`);
          
          // If all human players are offline, clean up room
          const anyHumanOnline = room.players.some(p => !p.isBot && p.socketId !== null);
          if (!anyHumanOnline) {
            rooms.delete(roomId);
            console.log(`Room ${roomId} closed as all human players disconnected.`);
            return;
          }
          
          broadcastRoomState(room);
        }
      }
    });
  });
});

// React app routing fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
