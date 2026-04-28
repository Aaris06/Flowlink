import { useState } from 'react';
import './ReconnectButton.css';

interface Props {
  onReconnect: () => void;
  isConnected: boolean;
}

export default function ReconnectButton({ onReconnect, isConnected }: Props) {
  const [isReconnecting, setIsReconnecting] = useState(false);

  const handleReconnect = async () => {
    setIsReconnecting(true);
    try {
      await onReconnect();
    } finally {
      setTimeout(() => setIsReconnecting(false), 2000);
    }
  };

  if (isConnected) return null;

  return (
    <div className="reconnect-banner">
      <div className="reconnect-content">
        <span className="reconnect-icon">⚠️</span>
        <span className="reconnect-text">Connection lost</span>
        <button 
          className="reconnect-btn" 
          onClick={handleReconnect}
          disabled={isReconnecting}
        >
          {isReconnecting ? 'Reconnecting...' : 'Reconnect'}
        </button>
      </div>
    </div>
  );
}
