import React, { useState, useEffect } from 'react';
import { canAttack, canDefend, SUIT_LABELS, SUIT_NAMES } from '../gameLogic';
import './GameBoard.css';
import './Card.css';

export default function GameBoard({ roomState, onPlayCard, onPass, onTakeCards, onShiftDefense, onTransferAttack, onLeaveRoom, onStartGame }) {
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [selectedTablePairId, setSelectedTablePairId] = useState(null);

  // Reset selected card if hand changes
  const localPlayer = roomState.players.find(p => p.hand !== undefined);
  const hand = localPlayer?.hand || [];
  const localPlayerId = localPlayer?.id;
  const isDefender = localPlayerId === roomState.defenderId;
  const isAttacker = localPlayerId === roomState.attackerId;
  const isMyTurn = isDefender || isAttacker || (roomState.tablePairs.length > 0 && localPlayer?.status !== 'win');

  useEffect(() => {
    setSelectedCardId(null);
    setSelectedTablePairId(null);
  }, [hand.length, roomState.tablePairs.length]);

  if (!localPlayer) return null;

  // Clockwise player slots assignment
  const localIdx = roomState.players.findIndex(p => p.id === localPlayerId);
  const otherPlayers = [];
  const totalPlayers = roomState.players.length;

  for (let i = 1; i < totalPlayers; i++) {
    const idx = (localIdx + i) % totalPlayers;
    otherPlayers.push(roomState.players[idx]);
  }

  // Assign screen positions depending on how many opponents we have
  const slots = {};
  if (otherPlayers.length === 1) {
    slots.top = otherPlayers[0];
  } else if (otherPlayers.length === 2) {
    slots.left = otherPlayers[0];
    slots.right = otherPlayers[1];
  } else if (otherPlayers.length === 3) {
    slots.left = otherPlayers[0];
    slots.top = otherPlayers[1];
    slots.right = otherPlayers[2];
  }

  // Get active turn player ID
  const isPlayerActive = (p) => {
    if (roomState.status !== 'playing') return false;
    // In Tấn, if table is empty, attacker is active.
    if (roomState.tablePairs.length === 0) {
      return p.id === roomState.attackerId;
    }
    // If table is not empty, defender is active if there are undefended cards.
    const hasUndefended = roomState.tablePairs.some(pair => !pair.defense);
    if (hasUndefended) {
      return p.id === roomState.defenderId;
    }
    // Otherwise, attackers can play matching cards.
    return p.id !== roomState.defenderId && p.status !== 'win' && p.status !== 'out';
  };

  // Card select/play handler
  const handleHandCardClick = (card) => {
    if (roomState.status !== 'playing') return;

    setSelectedTablePairId(null); // Clear table selection
    if (selectedCardId === card.id) {
      setSelectedCardId(null);
    } else {
      setSelectedCardId(card.id);
    }
  };

  const handleTablePairClick = (pair) => {
    if (!isDefender) return;

    if (pair.defense) {
      // Clicked on a defended pair: select it for shifting
      setSelectedCardId(null); // Clear hand selection
      if (selectedTablePairId === pair.id) {
        setSelectedTablePairId(null);
      } else {
        setSelectedTablePairId(pair.id);
      }
      return;
    }

    // Clicked on an undefended pair:
    if (selectedTablePairId) {
      // Shifting an already played defense card on the table
      const shiftingCard = roomState.tablePairs.find(p => p.id === selectedTablePairId)?.defense;
      if (shiftingCard && canDefend(pair.attack, shiftingCard, roomState.trumpSuit)) {
        onShiftDefense(selectedTablePairId, pair.id);
        setSelectedTablePairId(null);
      }
    } else if (selectedCardId) {
      // Play a card from hand to defend
      onPlayCard(selectedCardId, pair.id);
      setSelectedCardId(null);
    }
  };

  const N = hand.length;
  const isDoubleRow = N > 10;
  const half = Math.ceil(N / 2);

  const getCardStyle = (index) => {
    if (N === 0) return {};

    let rowIndex = index;
    let rowCount = N;
    let bottomOffset = 10;
    let zIndexOffset = 10;
    let scale = 1;

    if (isDoubleRow) {
      const isBackRow = index < half;
      rowIndex = isBackRow ? index : index - half;
      rowCount = isBackRow ? half : N - half;
      bottomOffset = isBackRow ? 45 : 5;
      zIndexOffset = isBackRow ? 10 : 30;
      scale = isBackRow ? 0.82 : 0.92;
    }

    const maxSpan = Math.min(260, rowCount * 22);
    const midIdx = (rowCount - 1) / 2;
    const offset = rowIndex - midIdx;
    
    const angleStep = Math.min(4.5, 45 / rowCount);
    const rotate = offset * angleStep;
    const translateX = offset * (maxSpan / rowCount);
    const translateY = Math.abs(offset) * 2;
    const zIndex = zIndexOffset + rowIndex;

    return {
      position: 'absolute',
      bottom: `${bottomOffset}px`,
      transform: `translateX(${translateX}px) rotate(${rotate}deg) translateY(${translateY}px) scale(${scale})`,
      transformOrigin: 'bottom center',
      zIndex,
      '--rotate': `${rotate}deg`
    };
  };

  const getSuitSymbol = (suit) => SUIT_LABELS[suit] || '';
  const getSuitClass = (suit) => (suit === 'hearts' || suit === 'diamonds') ? 'red-suit' : 'black-suit';

  const selectedCard = hand.find(c => c.id === selectedCardId);

  // Render player indicator node
  const renderPlayerSlot = (player, slotClass) => {
    if (!player) return null;
    const isTurn = isPlayerActive(player);
    const isOnline = player.isOnline;
    const hasPassed = roomState.passedPlayers.includes(player.id);
    
    return (
      <div className={`opponent-slot ${slotClass} ${isTurn ? 'active-turn' : ''}`} key={player.id}>
        <div className="opponent-avatar-wrapper">
          <span className="opponent-avatar">{player.isBot ? '🤖' : '👤'}</span>
          {!isOnline && <span style={{ position: 'absolute', top: 0, right: 0, fontSize: '8px', background: '#c0392b', color: '#fff', padding: '1px 3px', borderRadius: '4px' }}>OFF</span>}
          {hasPassed ? (
            <span className="opponent-badge action-badge badge-passed" style={{ background: '#7f8c8d', color: '#fff', fontSize: '9px' }}>👌 Hết</span>
          ) : (
            <>
              {player.status === 'win' && <span className="opponent-badge action-badge badge-win">Thắng</span>}
              {player.status === 'attacker' && <span className="opponent-badge action-badge badge-attacker">Tấn</span>}
              {player.status === 'defender' && (
                roomState.defenderWantsToTake ? 
                  <span className="opponent-badge action-badge badge-take" style={{ background: '#e67e22', color: '#fff' }}>Xin Ôm</span> :
                  <span className="opponent-badge action-badge badge-defender">Đỡ</span>
              )}
              {player.status === 'idle' && isTurn && <span className="opponent-badge action-badge badge-idle">Tấn thêm</span>}
            </>
          )}
        </div>
        <div className="opponent-info">
          <div className="opponent-name">{player.name}</div>
          {player.status !== 'win' && (
            <div className="opponent-cards-count">
              {Array.from({ length: player.handSize }).map((_, i) => (
                <div className="opponent-card-mini" key={i}></div>
              ))}
              <span style={{ fontSize: '10px', color: 'var(--text-secondary)', marginLeft: '4px', fontWeight: 700 }}>
                {player.handSize} lá
              </span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="game-board">
      {/* Header */}
      <div className="game-header">
        <div className="game-title-info">
          <span style={{ fontWeight: 800, color: 'var(--gold)' }}>Bài Tấn</span>
          <span style={{ fontSize: '12px', background: 'rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: '6px' }}>
            Phòng: {roomState.id}
          </span>
        </div>
        <button className="btn-exit" onClick={onLeaveRoom}>
          Rời bàn
        </button>
      </div>

      {/* Play Area */}
      <div className="play-area">
        {/* Opponents */}
        <div className="opponents-container">
          {renderPlayerSlot(slots.left, 'slot-left')}
          {renderPlayerSlot(slots.top, 'slot-top')}
          {renderPlayerSlot(slots.right, 'slot-right')}
        </div>

        {/* Center Table */}
        <div className="center-table">
          {/* Deck pile & Trump suit indicator */}
          <div className="deck-pile-container">
            <div className="trump-card-wrapper">
              {/* Trump card lies face-up rotated 90 degrees, only rendered if deckSize > 0 */}
              {roomState.deckSize > 0 && roomState.trumpCard && (
                <div className={`playing-card trump-card-rotated ${getSuitClass(roomState.trumpSuit)}`}>
                  <div className="card-corner top-left">
                    <span>{roomState.trumpCard.rank >= 11 ? 'JQKA'[roomState.trumpCard.rank-11] || roomState.trumpCard.rank : roomState.trumpCard.rank}</span>
                    <span>{getSuitSymbol(roomState.trumpCard.suit)}</span>
                  </div>
                  <div className="card-center-suit">{getSuitSymbol(roomState.trumpCard.suit)}</div>
                  <div className="card-corner bottom-right">
                    <span>{roomState.trumpCard.rank >= 11 ? 'JQKA'[roomState.trumpCard.rank-11] || roomState.trumpCard.rank : roomState.trumpCard.rank}</span>
                    <span>{getSuitSymbol(roomState.trumpCard.suit)}</span>
                  </div>
                </div>
              )}
              {/* Deck count stacked on top of trump card, only rendered if deckSize > 1 */}
              {roomState.deckSize > 1 && (
                <div className="playing-card face-down deck-stack"></div>
              )}
              {/* Deck count badge, rendered if deckSize > 0 */}
              {roomState.deckSize > 0 && (
                <div className="deck-count-badge">{roomState.deckSize}</div>
              )}
            </div>

            {roomState.trumpSuit && (
              <div className="trump-suit-indicator">
                <span style={{ fontSize: '8px', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>Trưởng</span>
                <span className={`trump-suit-icon ${getSuitClass(roomState.trumpSuit)}`}>
                  {getSuitSymbol(roomState.trumpSuit)} {SUIT_NAMES[roomState.trumpSuit]}
                </span>
              </div>
            )}
          </div>

          <div className={`table-pairs-container ${roomState.tablePairs.length > 8 ? 'many-pairs-dense' : roomState.tablePairs.length > 4 ? 'many-pairs' : ''}`}>
            {roomState.tablePairs.map((pair) => {
              const undefended = !pair.defense;
              
              let isHighlight = false;
              if (isDefender && undefended) {
                if (selectedTablePairId) {
                  const shiftingCard = roomState.tablePairs.find(p => p.id === selectedTablePairId)?.defense;
                  if (shiftingCard) {
                    isHighlight = canDefend(pair.attack, shiftingCard, roomState.trumpSuit);
                  }
                } else if (selectedCardId) {
                  isHighlight = canDefend(pair.attack, selectedCard, roomState.trumpSuit);
                }
              }

              return (
                <div
                  className={`card-pair ${undefended ? 'unblocked' : ''} ${isHighlight ? 'highlight-target' : ''}`}
                  key={pair.id}
                  onClick={() => handleTablePairClick(pair)}
                >
                  {/* Attack Card */}
                  <div className={`playing-card card-attack ${getSuitClass(pair.attack.suit)}`}>
                    <div className="card-corner top-left">
                      <span>{pair.attack.rank >= 11 ? 'JQKA'[pair.attack.rank-11] || pair.attack.rank : pair.attack.rank}</span>
                      <span>{getSuitSymbol(pair.attack.suit)}</span>
                    </div>
                    <div className="card-center-suit">{getSuitSymbol(pair.attack.suit)}</div>
                    <div className="card-corner bottom-right">
                      <span>{pair.attack.rank >= 11 ? 'JQKA'[pair.attack.rank-11] || pair.attack.rank : pair.attack.rank}</span>
                      <span>{getSuitSymbol(pair.attack.suit)}</span>
                    </div>
                  </div>

                  {/* Defense Card */}
                  {pair.defense && (
                    <div className={`playing-card card-defense ${getSuitClass(pair.defense.suit)} ${selectedTablePairId === pair.id ? 'selected' : ''}`}>
                      <div className="card-corner top-left">
                        <span>{pair.defense.rank >= 11 ? 'JQKA'[pair.defense.rank-11] || pair.defense.rank : pair.defense.rank}</span>
                        <span>{getSuitSymbol(pair.defense.suit)}</span>
                      </div>
                      <div className="card-center-suit">{getSuitSymbol(pair.defense.suit)}</div>
                      <div className="card-corner bottom-right">
                        <span>{pair.defense.rank >= 11 ? 'JQKA'[pair.defense.rank-11] || pair.defense.rank : pair.defense.rank}</span>
                        <span>{getSuitSymbol(pair.defense.suit)}</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {roomState.tablePairs.length === 0 && (
              <div style={{ gridColumn: 'span 4', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 500, alignSelf: 'center', textAlign: 'center' }}>
                Đang chờ lá bài tấn đầu tiên...
              </div>
            )}
          </div>
        </div>

        {/* Bottom Player Area */}
        <div className="player-area-bottom">
          <div className="player-header">
            <span style={{ fontWeight: 700, fontSize: '14px' }}>Bài của bạn</span>
            <div className="player-status-badge">
              {roomState.passedPlayers.includes(localPlayerId) ? (
                <span className="action-badge" style={{ background: '#7f8c8d' }}>👌 Bạn đã Hết cửa</span>
              ) : (
                <>
                  {localPlayer.status === 'win' && <span className="action-badge badge-win">Đã Thắng</span>}
                  {localPlayer.status === 'attacker' && <span className="action-badge badge-attacker">Tấn chính</span>}
                  {localPlayer.status === 'defender' && (
                    roomState.defenderWantsToTake ?
                      <span className="action-badge badge-take" style={{ background: 'linear-gradient(135deg, #e67e22 0%, #d35400 100%)', color: '#fff', boxShadow: '0 0 10px rgba(230, 126, 34, 0.5)' }}>Bạn xin ôm (Đợi tấn thêm)</span> :
                      <span className="action-badge badge-defender">Bạn đang Đỡ</span>
                  )}
                  {localPlayer.status === 'idle' && isMyTurn && <span className="action-badge badge-idle">Được tấn thêm</span>}
                  {localPlayer.status === 'idle' && !isMyTurn && <span className="action-badge" style={{ background: '#7f8c8d' }}>Đợi</span>}
                </>
              )}
            </div>
          </div>

          {/* Local player fanned hand cards */}
          <div className="hand-container">
            {localPlayer.status !== 'win' ? (
              <div className="fanned-hand">
                {hand.map((card, index) => {
                  const isPlayable = isDefender
                    ? (selectedCardId === card.id)
                    : canAttack(card, roomState.tablePairs, roomState.tablePairs.length === 0 && isAttacker);
                  
                  const isSelected = selectedCardId === card.id;

                  return (
                    <div
                      key={card.id}
                      className={`playing-card ${getSuitClass(card.suit)} ${isPlayable ? 'playable' : ''} ${isSelected ? 'selected' : ''}`}
                      style={getCardStyle(index)}
                      onClick={() => handleHandCardClick(card)}
                    >
                      <div className="card-corner top-left">
                        <span>{card.rank >= 11 ? 'JQKA'[card.rank-11] || card.rank : card.rank}</span>
                        <span>{getSuitSymbol(card.suit)}</span>
                      </div>
                      <div className="card-center-suit">{getSuitSymbol(card.suit)}</div>
                      <div className="card-corner bottom-right">
                        <span>{card.rank >= 11 ? 'JQKA'[card.rank-11] || card.rank : card.rank}</span>
                        <span>{getSuitSymbol(card.suit)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ color: 'var(--gold)', fontWeight: 700, fontSize: '15px' }}>
                🎉 Bạn đã hết bài và chiến thắng! Đang chờ những người khác...
              </div>
            )}
          </div>

          {/* Active play buttons */}
          {roomState.status === 'playing' && localPlayer.status !== 'win' && (
            <div className="player-actions-row">
              {/* Play / Defend confirm button */}
              {selectedCardId && (
                isDefender ? (
                  <>
                    {(() => {
                      const selectedCard = hand.find(c => c.id === selectedCardId);
                      // Find first undefended pair that this card can beat
                      const targetPair = roomState.tablePairs.find(p => !p.defense && canDefend(p.attack, selectedCard, roomState.trumpSuit));
                      return (
                        <button
                          className="btn-gold player-action-btn"
                          onClick={() => {
                            if (targetPair) {
                              onPlayCard(selectedCardId, targetPair.id);
                              setSelectedCardId(null);
                            }
                          }}
                          disabled={!targetPair}
                          style={{ background: 'linear-gradient(135deg, #2ecc71 0%, #27ae60 100%)', color: '#fff', boxShadow: '0 4px 15px rgba(46, 204, 113, 0.3)' }}
                        >
                          ⚡ Đỡ bài
                        </button>
                      );
                    })()}

                    {(() => {
                      const selectedCard = hand.find(c => c.id === selectedCardId);
                      const canTransfer = roomState.tablePairs.length > 0 && 
                                           roomState.tablePairs.every(p => !p.defense) && 
                                           roomState.tablePairs.every(p => p.attack.rank === selectedCard.rank);
                      if (!canTransfer) return null;
                      return (
                        <button
                          className="btn-gold player-action-btn"
                          onClick={() => {
                            onTransferAttack(selectedCardId);
                            setSelectedCardId(null);
                          }}
                          style={{ background: 'linear-gradient(135deg, #3498db 0%, #2980b9 100%)', color: '#fff', boxShadow: '0 4px 15px rgba(52, 152, 219, 0.3)' }}
                        >
                          🔄 Chuyền
                        </button>
                      );
                    })()}
                  </>
                ) : (
                  (() => {
                    const selectedCard = hand.find(c => c.id === selectedCardId);
                    const isInitial = roomState.tablePairs.length === 0;
                    const isValidAttack = selectedCard && canAttack(selectedCard, roomState.tablePairs, isInitial && isAttacker);
                    return (
                      <button
                        className="btn-gold player-action-btn"
                        onClick={() => {
                          if (isValidAttack) {
                            onPlayCard(selectedCardId, null);
                            setSelectedCardId(null);
                          }
                        }}
                        disabled={!isValidAttack}
                        style={{ background: 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)', color: '#fff', boxShadow: '0 4px 15px rgba(231, 76, 60, 0.3)' }}
                      >
                        ⚔️ Tấn bài
                      </button>
                    );
                  })()
                )
              )}

              {/* Defender: Take cards button */}
              {isDefender && (
                <button
                  className="btn-gold player-action-btn"
                  onClick={onTakeCards}
                  disabled={roomState.tablePairs.length === 0}
                  style={{ background: 'linear-gradient(135deg, #e67e22 0%, #d35400 100%)', color: '#fff', boxShadow: '0 4px 15px rgba(230, 126, 34, 0.3)' }}
                >
                  ✋ Ôm bài
                </button>
              )}

              {/* Attackers: Pass button */}
              {!isDefender && (
                <button
                  className="btn-gold player-action-btn"
                  onClick={onPass}
                  disabled={roomState.tablePairs.length === 0 || roomState.passedPlayers.includes(localPlayerId)}
                  style={{ background: 'linear-gradient(135deg, #7f8c8d 0%, #2c3e50 100%)', color: '#fff', boxShadow: '0 4px 15px rgba(127, 140, 141, 0.3)' }}
                >
                  👌 Hết cửa
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Game Over Leaderboard Overlay */}
      {roomState.status === 'game_over' && (
        <div className="game-over-overlay">
          <div className="game-over-title">TRẬN ĐẤU KẾT THÚC</div>
          <div className="game-over-subtitle">Bảng xếp hạng tổng hợp</div>

          <div className="results-table">
            {roomState.players
              .slice()
              // Sort based on their placement order in roomState.winners
              .sort((a, b) => {
                const idxA = roomState.winners ? roomState.winners.indexOf(a.id) : -1;
                const idxB = roomState.winners ? roomState.winners.indexOf(b.id) : -1;
                if (idxA !== -1 && idxB !== -1) return idxA - idxB;
                if (idxA !== -1) return -1;
                if (idxB !== -1) return 1;
                return 0;
              })
              .map((p, idx) => {
                const rankLabels = ['🏆 NHẤT', '🥈 NHÌ', '🥉 BA', '☠️ BÉT'];
                const rankLabel = rankLabels[idx] || `#${idx + 1}`;
                const isBét = idx === roomState.players.length - 1;
                const isWinner = !isBét;
                
                return (
                  <div className="result-row" key={p.id} style={{ borderLeft: isWinner ? '3px solid var(--gold)' : '3px solid #e74c3c' }}>
                    <span className="result-rank" style={{ color: isWinner ? 'var(--gold)' : '#e74c3c', fontWeight: 700 }}>
                      {rankLabel}
                    </span>
                    <span className="result-name">{p.name} {p.handSize > 0 && `(${p.handSize} lá)`}</span>
                    <span className="result-status" style={{ color: isWinner ? 'var(--gold)' : '#e74c3c' }}>
                      {isBét ? 'THUA CUỘC' : 'HOÀN THÀNH'}
                    </span>
                  </div>
                );
              })}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', maxWidth: '240px' }}>
            {localPlayer.isHost && (
              <button className="btn-gold" onClick={() => onStartGame(roomState.id)}>
                Chơi Ván Mới
              </button>
            )}
            <button className="btn-outline" onClick={onLeaveRoom}>
              Rời Phòng
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
