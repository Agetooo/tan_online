import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Lobby from './components/Lobby';
import GameBoard from './components/GameBoard';

export default function App() {
  const [username, setUsername] = useState('');
  const [roomId, setRoomId] = useState(null);
  const [roomState, setRoomState] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const socketRef = useRef(null);

  useEffect(() => {
    // Connect to Socket.io server
    // Vite proxy handles routing '/socket.io' to 'http://localhost:3001' in dev
    // Relative URL works out of the box in production
    const socket = io({
      transports: ['websocket', 'polling'], // Connect directly via WebSocket for low latency on mobile
      reconnectionDelay: 500,               // Start reconnecting after 500ms instead of 1s
      reconnectionDelayMax: 2000,           // Retry every 2s max instead of 5s
      timeout: 10000                        // Timeout after 10s
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to server, socket ID:', socket.id);
      
      // If we already have a room ID and username, try to request sync (reconnect)
      const storedRoomId = sessionStorage.getItem('tan_room_id');
      const storedUsername = sessionStorage.getItem('tan_username');
      if (storedRoomId && storedUsername) {
        socket.emit('join-room', { roomId: storedRoomId, username: storedUsername });
      }
    });

    socket.on('room-created', (id) => {
      setRoomId(id);
      sessionStorage.setItem('tan_room_id', id);
    });

    socket.on('room-state', (state) => {
      setRoomState(state);
      if (state?.id) {
        setRoomId(state.id);
        sessionStorage.setItem('tan_room_id', state.id);
      }
    });

    socket.on('error', (msg) => {
      showError(msg);
      if (msg === 'Phòng không tồn tại.') {
        setRoomState(null);
        setRoomId(null);
        sessionStorage.removeItem('tan_room_id');
      }
    });

    socket.on('kicked', () => {
      showError('Bạn đã bị chủ phòng kích khỏi phòng chơi.');
      setRoomState(null);
      setRoomId(null);
      sessionStorage.removeItem('tan_room_id');
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const showError = (msg) => {
    setErrorMsg(msg);
    setTimeout(() => {
      setErrorMsg(null);
    }, 3000);
  };

  const handleCreateRoom = () => {
    if (!username.trim()) return;
    sessionStorage.setItem('tan_username', username);
    socketRef.current.emit('create-room', { username });
  };

  const handleJoinRoom = (targetRoomId) => {
    if (!username.trim() || !targetRoomId.trim()) return;
    sessionStorage.setItem('tan_username', username);
    socketRef.current.emit('join-room', { roomId: targetRoomId.toUpperCase(), username });
  };

  const handleStartGame = (customRoomId) => {
    const id = (customRoomId && typeof customRoomId === 'string') ? customRoomId : roomId;
    if (!id) return;
    socketRef.current.emit('start-game', { roomId: id });
  };

  const handleAddBot = () => {
    if (!roomId) return;
    socketRef.current.emit('add-bot', { roomId });
  };

  const handleKickPlayer = (playerId) => {
    if (!roomId) return;
    socketRef.current.emit('remove-player', { roomId, playerId });
  };

  const handleLeaveRoom = () => {
    // Reset session storage and reload page to do a hard reset of websocket connection
    sessionStorage.removeItem('tan_room_id');
    window.location.reload();
  };
  const handlePlayCard = (cardId, targetPairId) => {
    if (!roomId) return;
    socketRef.current.emit('play-card', { roomId, cardId, targetPairId });
  };

  const handlePlayCards = (cardIds) => {
    if (!roomId) return;
    socketRef.current.emit('play-cards', { roomId, cardIds });
  };

  const handlePass = () => {
    if (!roomId) return;
    socketRef.current.emit('pass', { roomId });
  };

  const handleTakeCards = () => {
    if (!roomId) return;
    socketRef.current.emit('take-cards', { roomId });
  };

  const handleShiftDefense = (fromPairId, toPairId) => {
    if (!roomId) return;
    socketRef.current.emit('shift-defense', { roomId, fromPairId, toPairId });
  };

  const handleTransferAttack = (cardId) => {
    if (!roomId) return;
    socketRef.current.emit('transfer-attack', { roomId, cardId });
  };



  return (
    <div className="app-container">
      {/* Toast Error Alert */}
      {errorMsg && (
        <div style={{
          position: 'absolute',
          top: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(231, 76, 60, 0.95)',
          color: '#fff',
          padding: '10px 20px',
          borderRadius: '10px',
          fontSize: '13px',
          fontWeight: '600',
          boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
          zIndex: 9999,
          textAlign: 'center',
          animation: 'float 0.3s ease-in-out',
          width: '90%',
          maxWidth: '300px'
        }}>
          ⚠️ {errorMsg}
        </div>
      )}

      {/* View routing based on roomState status */}
      {!roomState || roomState.status === 'lobby' ? (
        <Lobby
          roomState={roomState}
          username={username}
          setUsername={setUsername}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          onStartGame={handleStartGame}
          onAddBot={handleAddBot}
          onKickPlayer={handleKickPlayer}
          onLeaveRoom={handleLeaveRoom}
        />
      ) : (
        <GameBoard
          socket={socketRef.current}
          roomState={roomState}
          onPlayCard={handlePlayCard}
          onPlayCards={handlePlayCards}
          onPass={handlePass}
          onTakeCards={handleTakeCards}
          onShiftDefense={handleShiftDefense}
          onTransferAttack={handleTransferAttack}
          onLeaveRoom={handleLeaveRoom}
          onStartGame={handleStartGame}
        />
      )}
    </div>
  );
}
