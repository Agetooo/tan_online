import React, { useState, useEffect, useRef } from 'react';
import { canAttack, canDefend, SUIT_LABELS, SUIT_NAMES } from '../gameLogic';
import './GameBoard.css';
import './Card.css';

export default function GameBoard({ socket, roomState, onPlayCard, onPlayCards, onPass, onTakeCards, onShiftDefense, onTransferAttack, onLeaveRoom, onStartGame }) {
  const [selectedCardIds, setSelectedCardIds] = useState([]);
  const [selectedTablePairId, setSelectedTablePairId] = useState(null);
  const [localTimer, setLocalTimer] = useState(0);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isMicOn, setIsMicOn] = useState(false);

  const peerConnections = useRef({});
  const localStreamRef = useRef(null);

  // Helper functions defined at the top to avoid TDZ errors
  const playRemoteAudio = (peerId, stream) => {
    let audio = document.getElementById(`audio-peer-${peerId}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-peer-${peerId}`;
      audio.autoplay = true;
      audio.style.display = 'none';
      // Set default volume slightly below 1.0 to prevent acoustic feedback coupling on mobile speakers
      audio.volume = 0.8;
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    audio.muted = !isSpeakerOn;
  };

  const cleanupPeer = (peerId) => {
    if (peerConnections.current[peerId]) {
      peerConnections.current[peerId].close();
      delete peerConnections.current[peerId];
    }
    const audio = document.getElementById(`audio-peer-${peerId}`);
    if (audio) audio.remove();
  };

  const initiatePeerConnection = async (peerId, stream = null) => {
    if (peerConnections.current[peerId]) return;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
    peerConnections.current[peerId] = pc;

    if (stream) {
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
    } else {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    pc.onicecandidate = event => {
      if (event.candidate) {
        socket.emit('voice-signal', {
          roomId: roomState.id,
          targetId: peerId,
          signal: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    pc.ontrack = event => {
      playRemoteAudio(peerId, event.streams[0]);
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('voice-signal', {
        roomId: roomState.id,
        targetId: peerId,
        signal: { type: 'offer', sdp: pc.localDescription }
      });
    } catch (err) {
      console.error('Error creating WebRTC offer:', err);
    }
  };

  const toggleMic = async () => {
    if (isMicOn) {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
      }
      setIsMicOn(false);
      socket.emit('voice-leave', { roomId: roomState.id });
      
      // Remove local tracks from all connections
      Object.keys(peerConnections.current).forEach(peerId => {
        const pc = peerConnections.current[peerId];
        pc.getSenders().forEach(sender => pc.removeTrack(sender));
      });
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        localStreamRef.current = stream;
        setIsMicOn(true);
        socket.emit('voice-join', { roomId: roomState.id });

        // Add tracks and renegotiate with all active peers
        Object.keys(peerConnections.current).forEach(peerId => {
          const pc = peerConnections.current[peerId];
          stream.getTracks().forEach(track => pc.addTrack(track, stream));
          pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
              socket.emit('voice-signal', {
                roomId: roomState.id,
                targetId: peerId,
                signal: { type: 'offer', sdp: pc.localDescription }
              });
            });
        });
      } catch (err) {
        alert('Không thể truy cập Microphone của bạn. Vui lòng cấp quyền micro trong cài đặt trình duyệt.');
        setIsMicOn(false);
        console.error('Mic access error:', err);
      }
    }
  };

  // Reset selected card if hand changes
  const localPlayer = roomState.players.find(p => p.hand !== undefined);
  const hand = localPlayer?.hand || [];
  const localPlayerId = localPlayer?.id;
  const isDefender = localPlayerId === roomState.defenderId;
  const isAttacker = localPlayerId === roomState.attackerId;
  const isMyTurn = isDefender || isAttacker || (roomState.tablePairs.length > 0 && localPlayer?.status !== 'win');

  useEffect(() => {
    setSelectedCardIds([]);
    setSelectedTablePairId(null);
  }, [hand.length, roomState.tablePairs.length]);

  useEffect(() => {
    if (!socket) return;

    const handleVoiceSignal = async ({ senderId, signal }) => {
      let pc = peerConnections.current[senderId];

      if (signal.type === 'offer') {
        if (pc) pc.close();

        pc = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        });
        peerConnections.current[senderId] = pc;

        if (localStreamRef.current) {
          localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current));
        }

        pc.onicecandidate = event => {
          if (event.candidate) {
            socket.emit('voice-signal', {
              roomId: roomState.id,
              targetId: senderId,
              signal: { type: 'candidate', candidate: event.candidate }
            });
          }
        };

        pc.ontrack = event => {
          playRemoteAudio(senderId, event.streams[0]);
        };

        try {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('voice-signal', {
            roomId: roomState.id,
            targetId: senderId,
            signal: { type: 'answer', sdp: pc.localDescription }
          });
        } catch (err) {
          console.error('Error handling WebRTC offer:', err);
        }
      } 
      else if (signal.type === 'answer') {
        if (pc) {
          pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
            .catch(err => console.error('Error setting remote description for answer:', err));
        }
      } 
      else if (signal.type === 'candidate') {
        if (pc) {
          pc.addIceCandidate(new RTCIceCandidate(signal.candidate))
            .catch(err => console.error('Error adding remote ICE candidate:', err));
        }
      }
    };

    socket.on('voice-signal', handleVoiceSignal);

    return () => {
      socket.off('voice-signal', handleVoiceSignal);
      
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
      Object.keys(peerConnections.current).forEach(peerId => {
        cleanupPeer(peerId);
      });
    };
  }, [socket, roomState?.id]);

  // Autoconnect to all other active human players regardless of microphone state
  useEffect(() => {
    if (!socket || !localPlayerId) return;

    roomState.players.forEach(p => {
      if (p.id !== localPlayerId && !p.isBot && p.isOnline) {
        if (!peerConnections.current[p.id]) {
          initiatePeerConnection(p.id, localStreamRef.current);
        }
      } else {
        if (peerConnections.current[p.id]) {
          cleanupPeer(p.id);
        }
      }
    });
  }, [roomState.players, socket, localPlayerId]);


  useEffect(() => {
    if (!roomState.defenderWantsToTake || !roomState.takeTimerRemaining) {
      setLocalTimer(0);
      return;
    }

    setLocalTimer(roomState.takeTimerRemaining);

    const interval = setInterval(() => {
      setLocalTimer(prev => Math.max(0, prev - 1));
    }, 1000);

    return () => clearInterval(interval);
  }, [roomState.defenderWantsToTake, roomState.takeTimerRemaining]);

  useEffect(() => {
    // Update mute state on all active peer audio elements
    roomState.players.forEach(p => {
      const audio = document.getElementById(`audio-peer-${p.id}`);
      if (audio) {
        audio.muted = !isSpeakerOn;
      }
    });
  }, [isSpeakerOn, roomState.players]);

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
    
    if (isDefender) {
      // Defender can only select one card to defend at a time
      if (selectedCardIds.includes(card.id)) {
        setSelectedCardIds([]);
      } else {
        setSelectedCardIds([card.id]);
      }
    } else {
      // Attackers can select multiple cards of matching rank
      if (selectedCardIds.includes(card.id)) {
        setSelectedCardIds(prev => prev.filter(id => id !== card.id));
      } else {
        if (selectedCardIds.length === 0) {
          setSelectedCardIds([card.id]);
        } else {
          const selectedCards = hand.filter(c => selectedCardIds.includes(c.id));
          if (selectedCards.length > 0 && selectedCards[0].rank === card.rank) {
            setSelectedCardIds(prev => [...prev, card.id]);
          } else {
            setSelectedCardIds([card.id]);
          }
        }
      }
    }
  };

  const handleTablePairClick = (pair) => {
    if (!isDefender) return;

    if (pair.defense) {
      // Clicked on a defended pair: select it for shifting
      setSelectedCardIds([]); // Clear hand selection
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
    } else if (selectedCardIds.length > 0) {
      // Play a card from hand to defend
      const defenseCard = hand.find(c => selectedCardIds.includes(c.id));
      if (defenseCard) {
        onPlayCard(defenseCard.id, pair.id);
        setSelectedCardIds([]);
      }
    }
  };

  const N = hand.length;
  const isDoubleRow = N > 10;
  const half = Math.ceil(N / 2);

  const getCardStyle = (index, isSelected = false) => {
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
    let zIndex = zIndexOffset + rowIndex;

    // Apply selected lift, separate-out, scale, and zIndex offset
    let liftOffset = 0;
    let horizontalOffset = 0;
    
    if (isSelected) {
      liftOffset = -35; // Lift up by 35px from normal hand row
      scale = scale * 1.08;
      zIndex = zIndex + 200;
      horizontalOffset = offset * 4; // Spreads selected cards wider to prevent overlapping
    }

    return {
      position: 'absolute',
      bottom: `${bottomOffset + liftOffset}px`,
      transform: `translateX(${translateX + horizontalOffset}px) rotate(${rotate}deg) translateY(${translateY}px) scale(${scale})`,
      transformOrigin: 'bottom center',
      zIndex,
      '--rotate': `${rotate}deg`,
      transition: 'all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.15)'
    };
  };

  const getSuitSymbol = (suit) => SUIT_LABELS[suit] || '';
  const getSuitClass = (suit) => (suit === 'hearts' || suit === 'diamonds') ? 'red-suit' : 'black-suit';

  const selectedCard = hand.find(c => selectedCardIds.includes(c.id));

  // Render player indicator node
  const renderPlayerSlot = (player, slotClass) => {
    if (!player) return null;
    const isTurn = isPlayerActive(player);
    const isOnline = player.isOnline;
    const hasPassed = roomState.passedPlayers.includes(player.id);
    
    // Circular SVG Progress Ring (Timer) around avatar
    const showProgressRing = player.id === roomState.defenderId && roomState.defenderWantsToTake && localTimer > 0;
    const strokeDashoffset = 144 - (144 * localTimer) / 10;
    
    return (
      <div className={`opponent-slot ${slotClass} ${isTurn ? 'active-turn' : ''}`} key={player.id}>
        <div className="opponent-avatar-wrapper">
          {showProgressRing && (
            <svg className="avatar-timer-svg" viewBox="0 0 50 50">
              <circle cx="25" cy="25" r="23" stroke="rgba(255,255,255,0.15)" strokeWidth="3.5" fill="none" />
              <circle cx="25" cy="25" r="23" stroke="#2ecc71" strokeWidth="3.5" fill="none"
                strokeDasharray="144"
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                transform="rotate(-90 25 25)"
                style={{ transition: 'stroke-dashoffset 1s linear' }}
              />
            </svg>
          )}
          <span className="opponent-avatar">{player.isBot ? '🤖' : '👤'}</span>
          {!isOnline && <span style={{ position: 'absolute', top: 0, right: 0, fontSize: '8px', background: '#c0392b', color: '#fff', padding: '1px 3px', borderRadius: '4px' }}>OFF</span>}
          {hasPassed ? (
            <span className="opponent-badge action-badge badge-passed" style={{ background: '#7f8c8d', color: '#fff', fontSize: '9px' }}>👌 Thôi</span>
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
          <div className="opponent-name" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
            {player.name}
            {player.voiceActive && <span style={{ color: '#2ecc71', fontSize: '10px' }}>🎙️</span>}
          </div>
          {player.status !== 'win' && (
            <div className="opponent-cards-count">
              {Array.from({ length: player.handSize }).map((_, i) => {
                const animClass = slotClass.includes('left') ? 'deal-anim-left' : slotClass.includes('right') ? 'deal-anim-right' : 'deal-anim-top';
                return (
                  <div 
                    key={i} 
                    className={`opponent-card-mini ${animClass}`} 
                    style={{ animationDelay: `${i * 60}ms` }}
                  />
                );
              })}
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
      {/* Countdown timer alert for 3s or less */}
      {localTimer > 0 && localTimer <= 3 && (
        <div className="timer-alert-overlay" style={{
          position: 'absolute',
          top: '30%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(231, 76, 60, 0.95)',
          color: '#fff',
          padding: '12px 24px',
          borderRadius: '8px',
          fontSize: '14px',
          fontWeight: '700',
          zIndex: 1000,
          boxShadow: '0 4px 20px rgba(231, 76, 60, 0.5)',
          border: '2px solid #f1c40f',
          textAlign: 'center',
          animation: 'pulse-timer 0.5s infinite alternate'
        }}>
          ⚠️ Sắp hết giờ tấn thêm! Còn {localTimer} giây...
        </div>
      )}

      {/* Header */}
      <div className="game-header">
        <div className="game-title-info" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', background: 'rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: '6px', fontWeight: 700 }}>
              Phòng: {roomState.id}
            </span>
          </div>
          {roomState.lastWinners && roomState.lastWinners.length > 0 && (
            <div className="last-winners-ticker" style={{ fontSize: '9px', color: 'var(--text-secondary)', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginTop: '2px' }}>
              <span style={{ color: 'var(--gold)', fontWeight: 600 }}>Trước:</span>
              {roomState.lastWinners.map((pid, idx) => {
                const p = roomState.players.find(pl => pl.id === pid);
                if (!p) return null;
                const emoji = idx === 0 ? '🏆' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '☠️';
                return (
                  <span key={pid} style={{ display: 'inline-flex', alignItems: 'center', gap: '1px' }}>
                    {emoji}{p.name}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button 
            className="btn-mic" 
            onClick={toggleMic}
            title={isMicOn ? 'Tắt Microphone' : 'Bật Microphone'}
            style={{
              background: isMicOn ? 'linear-gradient(135deg, #2ecc71 0%, #27ae60 100%)' : 'linear-gradient(135deg, #7f8c8d 0%, #34495e 100%)',
              color: '#fff',
              border: 'none',
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              fontSize: '14px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
              transition: 'all 0.2s ease',
              padding: 0
            }}
          >
            {isMicOn ? '🎙️' : '🔇'}
          </button>
          
          <button 
            className="btn-speaker" 
            onClick={() => setIsSpeakerOn(prev => !prev)}
            title={isSpeakerOn ? 'Tắt Loa' : 'Bật Loa'}
            style={{
              background: isSpeakerOn ? 'linear-gradient(135deg, #3498db 0%, #2980b9 100%)' : 'linear-gradient(135deg, #7f8c8d 0%, #34495e 100%)',
              color: '#fff',
              border: 'none',
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              fontSize: '14px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
              transition: 'all 0.2s ease',
              padding: 0
            }}
          >
            {isSpeakerOn ? '🔊' : '🔇'}
          </button>

          <button 
            className="btn-exit" 
            onClick={onLeaveRoom}
            style={{
              fontSize: '11px',
              padding: '6px 10px',
              marginLeft: '4px'
            }}
          >
            Rời bàn
          </button>
        </div>
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
                } else if (selectedCardIds.length > 0) {
                  const defenseCard = hand.find(c => selectedCardIds.includes(c.id));
                  if (defenseCard) {
                    isHighlight = canDefend(pair.attack, defenseCard, roomState.trumpSuit);
                  }
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
            <span style={{ fontWeight: 700, fontSize: '14px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              Bài của bạn
              {localPlayer.voiceActive && <span style={{ color: '#2ecc71', fontSize: '12px' }}>🎙️</span>}
              {localPlayer.id === roomState.defenderId && roomState.defenderWantsToTake && localTimer > 0 && (
                <svg style={{ width: '16px', height: '16px', marginLeft: '4px' }} viewBox="0 0 50 50">
                  <circle cx="25" cy="25" r="23" stroke="rgba(255,255,255,0.15)" strokeWidth="4.5" fill="none" />
                  <circle cx="25" cy="25" r="23" stroke="#2ecc71" strokeWidth="4.5" fill="none"
                    strokeDasharray="144"
                    strokeDashoffset={144 - (144 * localTimer) / 10}
                    strokeLinecap="round"
                    transform="rotate(-90 25 25)"
                  />
                </svg>
              )}
            </span>
            <div className="player-status-badge">
              {roomState.passedPlayers.includes(localPlayerId) ? (
                <span className="action-badge" style={{ background: '#7f8c8d' }}>👌 Bạn thôi lượt</span>
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
                    ? (selectedCardIds.includes(card.id))
                    : canAttack(card, roomState.tablePairs, roomState.tablePairs.length === 0 && isAttacker);
                  
                  const isSelected = selectedCardIds.includes(card.id);

                  return (
                    <div
                      key={card.id}
                      className={`playing-card ${getSuitClass(card.suit)} ${isPlayable ? 'playable' : ''} ${isSelected ? 'selected' : ''} deal-anim-bottom`}
                      style={{
                        ...getCardStyle(index, isSelected),
                        animationDelay: `${index * 80}ms`
                      }}
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
              {selectedCardIds.length > 0 && (
                isDefender ? (
                  <>
                    {(() => {
                      const selectedCard = hand.find(c => selectedCardIds.includes(c.id));
                      // Find first undefended pair that this card can beat
                      const targetPair = roomState.tablePairs.find(p => !p.defense && selectedCard && canDefend(p.attack, selectedCard, roomState.trumpSuit));
                      return (
                        <button
                          className="btn-gold player-action-btn"
                          onClick={() => {
                            if (selectedCard && targetPair) {
                              onPlayCard(selectedCard.id, targetPair.id);
                              setSelectedCardIds([]);
                            }
                          }}
                          disabled={!targetPair}
                          style={{ background: 'linear-gradient(135deg, #2ecc71 0%, #27ae60 100%)', color: '#fff', boxShadow: '0 4px 15px rgba(46, 204, 113, 0.3)' }}
                        >
                          🛡️ Chặn bài
                        </button>
                      );
                    })()}

                    {(() => {
                      const selectedCard = hand.find(c => selectedCardIds.includes(c.id));
                      const canTransfer = selectedCard &&
                                           roomState.tablePairs.length > 0 && 
                                           roomState.tablePairs.every(p => !p.defense) && 
                                           roomState.tablePairs.every(p => p.attack.rank === selectedCard.rank);
                      if (!canTransfer) return null;
                      return (
                        <button
                          className="btn-gold player-action-btn"
                          onClick={() => {
                            if (selectedCard) {
                              onTransferAttack(selectedCard.id);
                              setSelectedCardIds([]);
                            }
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
                    const isInitial = roomState.tablePairs.length === 0;
                    const selectedCards = hand.filter(c => selectedCardIds.includes(c.id));
                    const hasSelected = selectedCards.length > 0;
                    const isValidAttack = hasSelected && selectedCards.every(c => canAttack(c, roomState.tablePairs, isInitial && isAttacker));
                    return (
                      <button
                        className="btn-gold player-action-btn"
                        onClick={() => {
                          if (isValidAttack) {
                            if (selectedCards.length > 1) {
                              onPlayCards(selectedCardIds);
                            } else {
                              onPlayCard(selectedCardIds[0], null);
                            }
                            setSelectedCardIds([]);
                          }
                        }}
                        disabled={!isValidAttack}
                        style={{ background: 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)', color: '#fff', boxShadow: '0 4px 15px rgba(231, 76, 60, 0.3)' }}
                      >
                        {selectedCards.length > 1 ? `⚔️ Tấn ${selectedCards.length} lá` : '⚔️ Tấn bài'}
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
                  👌 Thôi lượt
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

          {/* Seat Swap (Đổi Phong Thủy) Section */}
          <div className="seat-swap-panel" style={{
            width: '100%',
            maxWidth: '240px',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '10px',
            padding: '10px',
            marginBottom: '15px',
            textAlign: 'center'
          }}>
            <div style={{ fontSize: '11px', fontWeight: '700', color: 'var(--gold)', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
              🔄 Đổi chỗ (Đổi Phong Thủy)
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {roomState.players
                .filter(p => p.id !== localPlayerId)
                .map(p => (
                  <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.2)', padding: '5px 8px', borderRadius: '6px' }}>
                    <span style={{ fontSize: '10px', fontWeight: '600', maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.name} {p.isBot ? '(BOT)' : ''}
                    </span>
                    <button
                      onClick={() => socket.emit('swap-request', { roomId: roomState.id, targetId: p.id })}
                      disabled={roomState.swapRequest !== null}
                      style={{
                        padding: '3px 8px',
                        background: 'linear-gradient(135deg, #3498db 0%, #2980b9 100%)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '4px',
                        fontSize: '9px',
                        fontWeight: '700',
                        cursor: 'pointer'
                      }}
                    >
                      🔄 Đổi
                    </button>
                  </div>
                ))}
            </div>
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

      {/* Swap Request Popups */}
      {roomState.swapRequest && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0,0,0,0.75)',
          zIndex: 9999,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          backdropFilter: 'blur(5px)'
        }}>
          <div style={{
            background: '#14281e',
            border: '2px solid var(--gold)',
            borderRadius: '12px',
            padding: '20px 16px',
            width: '85%',
            maxWidth: '280px',
            textAlign: 'center',
            boxShadow: '0 8px 30px rgba(0,0,0,0.6)'
          }}>
            {roomState.swapRequest.requesterId === localPlayerId ? (
              // Requester view
              <>
                <div style={{ fontSize: '28px', marginBottom: '8px' }}>⏳</div>
                <h3 style={{ color: '#fff', fontSize: '14px', fontWeight: '700', margin: '0 0 8px 0' }}>Đang đợi phản hồi</h3>
                <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '0 0 15px 0' }}>
                  Yêu cầu đổi chỗ đã được gửi tới <strong>{roomState.players.find(p => p.id === roomState.swapRequest.targetId)?.name}</strong>.
                </p>
                <button
                  onClick={() => socket.emit('swap-cancel', { roomId: roomState.id })}
                  style={{
                    width: '100%',
                    padding: '8px 16px',
                    background: 'linear-gradient(135deg, #7f8c8d 0%, #34495e 100%)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '6px',
                    fontWeight: '700',
                    fontSize: '11px',
                    cursor: 'pointer'
                  }}
                >
                  Hủy yêu cầu
                </button>
              </>
            ) : roomState.swapRequest.targetId === localPlayerId ? (
              // Target view
              <>
                <div style={{ fontSize: '28px', marginBottom: '8px' }}>🔔</div>
                <h3 style={{ color: 'var(--gold)', fontSize: '14px', fontWeight: '800', margin: '0 0 8px 0' }}>Yêu Cầu Đổi Chỗ</h3>
                <p style={{ fontSize: '12px', color: '#fff', margin: '0 0 15px 0', lineHeight: '1.4' }}>
                  <strong>{roomState.players.find(p => p.id === roomState.swapRequest.requesterId)?.name}</strong> muốn đổi chỗ ngồi (phong thủy) với bạn. Bạn có đồng ý không?
                </p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => socket.emit('swap-accept', { roomId: roomState.id, requesterId: roomState.swapRequest.requesterId })}
                    style={{
                      flex: 1,
                      padding: '8px',
                      background: 'linear-gradient(135deg, #2ecc71 0%, #27ae60 100%)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      fontWeight: '700',
                      fontSize: '11px',
                      cursor: 'pointer'
                    }}
                  >
                    Đồng ý
                  </button>
                  <button
                    onClick={() => socket.emit('swap-decline', { roomId: roomState.id, requesterId: roomState.swapRequest.requesterId })}
                    style={{
                      flex: 1,
                      padding: '8px',
                      background: 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      fontWeight: '700',
                      fontSize: '11px',
                      cursor: 'pointer'
                    }}
                  >
                    Từ chối
                  </button>
                </div>
              </>
            ) : (
              // Other players view
              <>
                <div style={{ fontSize: '28px', marginBottom: '8px' }}>🔄</div>
                <h3 style={{ color: 'var(--gold)', fontSize: '14px', fontWeight: '800', margin: '0 0 8px 0' }}>Đang đổi chỗ</h3>
                <p style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '0 0 0 0' }}>
                  <strong>{roomState.players.find(p => p.id === roomState.swapRequest.requesterId)?.name}</strong> đang yêu cầu đổi chỗ với <strong>{roomState.players.find(p => p.id === roomState.swapRequest.targetId)?.name}</strong>...
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
