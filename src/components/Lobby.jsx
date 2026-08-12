import React, { useState, useEffect } from 'react';
import './Lobby.css';

export default function Lobby({
  roomState,
  username,
  setUsername,
  onCreateRoom,
  onJoinRoom,
  onStartGame,
  onAddBot,
  onKickPlayer,
  onLeaveRoom
}) {
  const [inputRoomId, setInputRoomId] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState(4);

  // Load username from localStorage on mount
  useEffect(() => {
    const savedName = localStorage.getItem('tan_username');
    if (savedName) {
      setUsername(savedName);
    }
  }, [setUsername]);

  const handleUsernameChange = (e) => {
    const val = e.target.value;
    setUsername(val);
    localStorage.setItem('tan_username', val);
  };

  const handleCopyCode = () => {
    if (!roomState?.id) return;
    navigator.clipboard.writeText(roomState.id);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  // 1. If not in a room, show the Join/Create screen
  if (!roomState) {
    return (
      <div className="lobby-container">
        <div className="lobby-header">
          <h1 className="lobby-logo">
            🎴 BÀI TẤN <span>Multiplayer</span>
          </h1>
          <p className="lobby-subtitle">Trò chơi đánh bài Tấn truyền thống cực hấp dẫn</p>
        </div>

        <div className="lobby-panel glass-panel">
          <div className="china-firewall-notice" style={{
            background: 'rgba(230, 126, 34, 0.12)',
            border: '1px solid rgba(230, 126, 34, 0.25)',
            borderRadius: '8px',
            padding: '10px 14px',
            marginBottom: '16px',
            fontSize: '11px',
            color: '#e67e22',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '8px',
            lineHeight: '1.4',
            textAlign: 'left'
          }}>
            <span style={{ fontSize: '14px' }}>📢</span>
            <div>
              <strong>Lưu ý kết nối:</strong> Người chơi từ Trung Quốc có thể bị chặn kết nối Voice Chat do tường lửa. Bạn có thể sử dụng tính năng <strong>Chat tay</strong> trong bàn để trò chuyện thay thế.(Ở cổ nhuế thì dùng mọi thứ oke còn ở hải phòng t kbt)
            </div>
          </div>

          <div className="lobby-section">
            <label style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-secondary)' }}>
              TÊN NGƯỜI CHƠI
            </label>
            <input
              type="text"
              className="custom-input"
              placeholder="Nhập tên của bạn..."
              value={username}
              onChange={handleUsernameChange}
              maxLength={15}
            />
          </div>

          <div className="lobby-section" style={{ marginTop: '16px' }}>
            <label style={{ fontSize: '14px', fontWeight: '600', color: 'var(--text-secondary)' }}>
              CHẾ ĐỘ CHƠI
            </label>
            <div className="game-mode-selector" style={{ display: 'flex', gap: '10px' }}>
              <div
                className={`mode-option ${maxPlayers === 4 ? 'active' : ''}`}
                onClick={() => setMaxPlayers(4)}
                style={{
                  flex: 1,
                  padding: '12px',
                  borderRadius: '12px',
                  background: maxPlayers === 4 ? 'rgba(212, 175, 55, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                  border: maxPlayers === 4 ? '2px solid var(--gold)' : '2px solid rgba(255, 255, 255, 0.1)',
                  cursor: 'pointer',
                  textAlign: 'center',
                  transition: 'all 0.2s ease',
                  boxShadow: maxPlayers === 4 ? '0 0 10px rgba(212, 175, 55, 0.3)' : 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  minHeight: '68px'
                }}
              >
                <div style={{ fontSize: '16px', fontWeight: 'bold' }}>👥 4 Người</div>
              </div>
              <div
                className={`mode-option ${maxPlayers === 5 ? 'active' : ''}`}
                onClick={() => setMaxPlayers(5)}
                style={{
                  flex: 1,
                  padding: '12px',
                  borderRadius: '12px',
                  background: maxPlayers === 5 ? 'rgba(212, 175, 55, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                  border: maxPlayers === 5 ? '2px solid var(--gold)' : '2px solid rgba(255, 255, 255, 0.1)',
                  cursor: 'pointer',
                  textAlign: 'center',
                  transition: 'all 0.2s ease',
                  boxShadow: maxPlayers === 5 ? '0 0 10px rgba(212, 175, 55, 0.3)' : 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  minHeight: '68px'
                }}
              >
                <div style={{ fontSize: '16px', marginBottom: '4px', fontWeight: 'bold' }}>👥 5 Người</div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>cho phong chơi với</div>
              </div>
            </div>
          </div>

          <div className="lobby-divider" style={{ margin: '24px 0' }}></div>

          <div className="lobby-section" style={{ gap: '14px' }}>
            <button
              className="btn-gold"
              onClick={() => onCreateRoom(maxPlayers)}
              disabled={!username.trim()}
              style={{ width: '100%' }}
            >
              Tạo Phòng Mới
            </button>

            <div className="lobby-divider">HOẶC GIA NHẬP</div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                className="custom-input"
                placeholder="Nhập Mã Phòng..."
                value={inputRoomId}
                onChange={(e) => setInputRoomId(e.target.value.toUpperCase())}
                style={{ flex: 1, textTransform: 'uppercase', letterSpacing: '1px' }}
                maxLength={6}
              />
              <button
                className="btn-outline"
                onClick={() => onJoinRoom(inputRoomId)}
                disabled={!username.trim() || inputRoomId.trim().length !== 6}
                style={{ padding: '0 20px' }}
              >
                Vào
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 2. If in a room lobby, show the waiting room
  const localPlayer = roomState.players.find(p => p.hand !== undefined); // Hand is populated for local player
  const isHost = localPlayer?.isHost;

  return (
    <div className="lobby-container">
      <div className="lobby-header">
        <h1 className="lobby-logo" style={{ fontSize: '28px' }}>
          🎴 PHÒNG CHỜ
        </h1>
        <p className="lobby-subtitle">Đang đợi đủ người chơi để bắt đầu...</p>
      </div>

      <div className="lobby-panel glass-panel">
        <div className="lobby-room-info">
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>
            MÃ PHÒNG CHƠI
          </span>
          <div className="lobby-room-code-wrapper">
            <span className="lobby-room-code">{roomState.id}</span>
            <button className="btn-copy" onClick={handleCopyCode}>
              {copyFeedback ? 'Đã sao chép!' : 'Sao chép'}
            </button>
          </div>
        </div>

        <div className="lobby-divider" style={{ margin: '16px 0' }}>
          NGƯỜI CHƠI ({roomState.players.length}/{roomState.maxPlayers || 4})
        </div>

        <div className="lobby-players-list">
          {roomState.players.map((p) => {
            const isSelf = p.hand !== undefined;
            return (
              <div className="lobby-player-row" key={p.id}>
                <div className="player-info-name">
                  <span>{p.name}</span>
                  {isSelf && <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>(Bạn)</span>}
                  {p.isHost && <span className="badge-host-crown" title="Chủ phòng">👑</span>}
                  {p.isBot && <span className="badge-bot">BOT</span>}
                </div>

                {isHost && !isSelf && (
                  <button className="btn-kick" onClick={() => onKickPlayer(p.id)}>
                    Kích
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="lobby-actions">
          {isHost && (
            <>
              <button
                className="btn-gold"
                onClick={() => onStartGame()}
                disabled={roomState.players.length < 2}
                style={{ width: '100%' }}
              >
                Bắt đầu chơi
              </button>

              <button
                className="btn-outline"
                onClick={onAddBot}
                disabled={roomState.players.length >= (roomState.maxPlayers || 4)}
                style={{ width: '100%' }}
              >
                🤖 Thêm Robot
              </button>
            </>
          )}

          {!isHost && (
            <div style={{ textAlign: 'center', padding: '10px 0', color: 'var(--text-secondary)', fontSize: '14px', fontWeight: 500 }}>
              Đang chờ chủ phòng bắt đầu trận đấu...
            </div>
          )}

          <button
            className="btn-outline"
            onClick={onLeaveRoom}
            style={{ width: '100%', borderColor: 'rgba(231, 76, 60, 0.3)', color: '#e74c3c' }}
          >
            Rời Phòng
          </button>
        </div>
      </div>
    </div>
  );
}
