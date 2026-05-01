import React, { useState, useEffect } from 'react';
import { Device, FileTransferStatus, Intent } from '@shared/types';
import MediaDetector from '../services/MediaDetector';
import { friendService } from '../services/FriendService';
import './DeviceTile.css';

interface DeviceTileProps {
  device: Device;
  draggedItem: any;
  onDragStart: (e: React.DragEvent, item: any) => void;
  onDragEnd: () => void;
  onDrop: (intent: Intent) => void;
  transferStatus?: FileTransferStatus | null;
  myUsername?: string;
  myDeviceId?: string;
  sessionId?: string;
}

function DeviceTileComponent({
  device,
  transferStatus,
  onDrop,
  myUsername = '',
  myDeviceId = '',
  sessionId,
}: DeviceTileProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [clipboardText, setClipboardText] = useState('');
  const [friendState, setFriendState] = useState<'none' | 'pending' | 'friend'>(() => {
    const uname = device.username || device.name;
    if (friendService.isFriend(uname)) return 'friend';
    if (friendService.hasPendingSentRequest(uname)) return 'pending';
    return 'none';
  });

  useEffect(() => {
    const uname = device.username || device.name;
    const refresh = () => {
      if (friendService.isFriend(uname)) setFriendState('friend');
      else if (friendService.hasPendingSentRequest(uname)) setFriendState('pending');
      else setFriendState('none');
    };
    const unsub1 = friendService.on('friends_changed', refresh);
    const unsub2 = friendService.on('sent_changed', refresh);
    return () => { unsub1(); unsub2(); };
  }, [device.username, device.name]);

  const sendFriendRequest = (e: React.MouseEvent) => {
    e.stopPropagation();
    const uname = device.username || device.name;
    friendService.sendFriendRequest(myUsername, myDeviceId, uname, sessionId);
    setFriendState('pending');
  };

  const formatBytes = (value: number): string => {
    if (value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  };

  const formatDuration = (seconds: number): string => {
    const total = Math.max(0, Math.round(seconds));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const extractFilesFromEvent = (e: React.DragEvent): File[] => {
    const files: File[] = [];
    
    // Check dataTransfer.files first (most reliable for file drops)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      files.push(...Array.from(e.dataTransfer.files));
    }
    
    // Also check dataTransfer.items for additional files
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      for (const item of Array.from(e.dataTransfer.items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file && !files.some(f => f.name === file.name && f.size === file.size)) {
            files.push(file);
          }
        }
      }
    }
    
    return files;
  };

  const normalizeUrl = (text: string): string | null => {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    // Already has a protocol
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
      return trimmed;
    }

    // Common domains without scheme (e.g., youtube.com/foo)
    if (/^(www\.)?[a-z0-9.-]+\.[a-z]{2,}([/?].*)?$/i.test(trimmed)) {
      return `https://${trimmed}`;
    }

    return null;
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent parent from handling
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
    console.log('Drag over device tile:', device.name);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent parent from handling
    setIsDragOver(false);

    console.log('=== DROP EVENT ===');
    console.log('Drop event on device tile:', device.name);
    console.log('Files count:', e.dataTransfer.files.length);
    console.log('File types:', Array.from(e.dataTransfer.files).map(f => f.type));
    console.log('Text data:', e.dataTransfer.getData('text/plain'));
    console.log('HTML data:', e.dataTransfer.getData('text/html'));

    // Show immediate feedback for multiple files
    const fileCount = e.dataTransfer.files.length;
    if (fileCount > 1) {
      console.log(`📦 Multiple files detected: ${fileCount} files`);
    }

    try {
      const intent = await createIntentFromDrop(e);
      if (intent) {
        console.log('✅ Intent created successfully:', intent.intent_type);
        console.log('Intent payload:', JSON.stringify(intent.payload, null, 2));
        
        // If it's a media continuation (URL-based), try to get current playback state
        // Note: File-based media is sent as file_handoff, not media_continuation
        if (intent.intent_type === 'media_continuation' && intent.payload.media && !intent.payload.file) {
          try {
            const mediaDetector = new MediaDetector();
            const currentMedia = await mediaDetector.detectMediaFromPage();
            
            // Check if the dropped URL matches what's currently playing
            const droppedUrl = intent.payload.media.url;
            
            // Extract YouTube video IDs for comparison
            const getYouTubeVideoId = (url: string): string | null => {
              const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
              return match ? match[1] : null;
            };
            
            const droppedVideoId = getYouTubeVideoId(droppedUrl);
            const currentVideoId = currentMedia ? getYouTubeVideoId(currentMedia.url) : null;
            
            const isMatch = currentMedia && (
              currentMedia.url === droppedUrl ||
              droppedUrl.includes(currentMedia.url) ||
              currentMedia.url.includes(droppedUrl) ||
              // For YouTube, check if video IDs match
              (droppedVideoId && currentVideoId && droppedVideoId === currentVideoId) ||
              // For Spotify, check domain match
              (droppedUrl.includes('spotify.com') && currentMedia.url.includes('spotify.com'))
            );
            
            if (isMatch && currentMedia.timestamp > 0) {
              // Update with current timestamp and state
              intent.payload.media.timestamp = Math.floor(currentMedia.timestamp); // Round to seconds
              intent.payload.media.state = currentMedia.state;
              console.log(`✅ Media continuation: Resuming at ${intent.payload.media.timestamp}s`);
            } else if (currentMedia && currentMedia.timestamp > 0 && 
                       (droppedUrl.includes('youtube.com') || droppedUrl.includes('spotify.com'))) {
              // For YouTube/Spotify URLs, always use current timestamp if media is playing
              // (user wants to continue from where they are)
              intent.payload.media.timestamp = Math.floor(currentMedia.timestamp);
              intent.payload.media.state = currentMedia.state;
              console.log(`✅ Using current playback position: ${intent.payload.media.timestamp}s`);
            }
            mediaDetector.cleanup();
          } catch (err) {
            console.log('Could not detect media state:', err);
          }
        }
        
        console.log('Calling onDrop callback...');
        onDrop(intent);
        console.log('✅ onDrop callback completed');
      } else {
        console.warn('❌ No intent created from drop event');
        alert('Could not create intent from dropped item. Try dragging a file, URL, or text.');
      }
    } catch (error) {
      console.error('❌ Error in handleDrop:', error);
      alert('Error processing drop: ' + error);
    }
  };

  const createIntentFromDrop = async (e: React.DragEvent): Promise<Intent | null> => {
    console.log('createIntentFromDrop called');
    
    // Check for files (handle both single and multiple files)
    const droppedFiles = extractFilesFromEvent(e);
    if (droppedFiles.length > 0) {
      console.log(`${droppedFiles.length} file(s) detected:`, droppedFiles.map(f => f.name));
      
      // If single file, keep a runtime file reference and stream via chunk transfer later.
      if (droppedFiles.length === 1) {
        const file = droppedFiles[0];
        console.log('Single file detected:', file.name, file.type);

        return {
          intent_type: 'file_handoff',
          payload: {
            file: {
              name: file.name,
              size: file.size,
              type: file.type,
              localRef: file,
            },
          },
          target_device: device.id,
          source_device: '', // Will be set by IntentRouter
          auto_open: true,
          timestamp: Date.now(),
        };
      }
      
      // Multiple files - use batch file handoff
      console.log('Multiple files detected, creating batch transfer');
      const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const totalSize = droppedFiles.reduce((sum, file) => sum + file.size, 0);
      
      const processedFiles = droppedFiles.map((file, index) => ({
        id: `file_${index}_${Date.now()}`,
        name: file.name,
        size: file.size,
        type: file.type,
        localRef: file,
      }));
      
      return {
        intent_type: 'batch_file_handoff',
        payload: {
          files: {
            batchId,
            totalFiles: droppedFiles.length,
            totalSize,
            files: processedFiles,
          },
        },
        target_device: device.id,
        source_device: '', // Will be set by IntentRouter
        auto_open: true,
        timestamp: Date.now(),
      };
    }

    // Check for text/URL
    const text = e.dataTransfer.getData('text/plain');
    console.log('Text data:', text);
    if (text) {
      const normalized = normalizeUrl(text) || text;

      // Check if it's a URL
      try {
        const url = new URL(normalized);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          // Check if it's YouTube, Spotify, or other media streaming service
          const isYouTube = normalized.includes('youtube.com') || normalized.includes('youtu.be');
          const isSpotify = normalized.includes('spotify.com');
          const isMediaStream = isYouTube || isSpotify || normalized.match(/\.(mp4|mp3|webm|ogg|avi|mov|m4a|flac|wav)(\?|$)/i);
          
          if (isMediaStream) {
            // Always treat streaming URLs as media_continuation so we can add timestamp
            return {
              intent_type: 'media_continuation',
              payload: {
                media: {
                  url: normalized,
                  type: isYouTube || normalized.match(/\.(mp4|webm|avi|mov|mkv)(\?|$)/i) ? 'video' : 'audio',
                  timestamp: 0, // Will be populated by MediaDetector if available
                  state: 'play',
                },
              },
              target_device: device.id,
              source_device: '',
              auto_open: true,
              timestamp: Date.now(),
            };
          }
          
          return {
            intent_type: 'link_open',
            payload: {
              link: {
                  url: normalized,
              },
            },
            target_device: device.id,
            source_device: '',
            auto_open: true,
            timestamp: Date.now(),
          };
        }
      } catch {
        // Not a URL, treat as prompt or clipboard
        // Check if it looks like a media URL
        if (normalized.match(/\.(mp4|mp3|webm|ogg|avi|mov)(\?|$)/i) || normalized.includes('youtube.com') || normalized.includes('spotify.com')) {
          return {
            intent_type: 'media_continuation',
            payload: {
              media: {
                url: normalized,
                type: normalized.match(/\.(mp4|webm|avi|mov)(\?|$)/i) || normalized.includes('youtube.com') ? 'video' : 'audio',
                timestamp: 0,
                state: 'play',
              },
            },
            target_device: device.id,
            source_device: '',
            auto_open: true,
            timestamp: Date.now(),
          };
        }
        
        // Default: clipboard sync for plain text
        return {
          intent_type: 'clipboard_sync',
          payload: {
            clipboard: {
              text: text,
            },
          },
          target_device: device.id,
          source_device: '',
          auto_open: true,
          timestamp: Date.now(),
        };
      }
    }

    // Check for HTML (could be rich text)
    const html = e.dataTransfer.getData('text/html');
    if (html) {
      return {
        intent_type: 'clipboard_sync',
        payload: {
          clipboard: {
            text: text || '',
            html: html,
          },
        },
        target_device: device.id,
        source_device: '',
        auto_open: true,
        timestamp: Date.now(),
      };
    }

    return null;
  };

  const getDeviceIcon = () => {
    switch (device.type) {
      case 'phone':
        return '📱';
      case 'laptop':
        return '💻';
      case 'desktop':
        return '🖥️';
      case 'tablet':
        return '📱';
      default:
        return '📱';
    }
  };

  const getStatusColor = () => {
    return device.online ? '#4caf50' : '#999';
  };

  return (
    <div
      className={`device-tile ${isDragOver ? 'drag-over' : ''} ${!device.online ? 'offline' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ pointerEvents: 'auto' }}
    >
      <div className="device-tile-header">
        <div className="device-icon">{getDeviceIcon()}</div>
        <div className="device-info">
          <h3 className="device-name">{device.username || device.name}</h3>
          <p className="device-subtitle">{device.name}</p>
          <div className="device-status">
            <span
              className="status-dot"
              style={{ backgroundColor: getStatusColor() }}
            />
            <span className="status-text">
              {device.online ? 'Online' : 'Offline'}
            </span>
          </div>
        </div>
        {/* Friend request button */}
        {myUsername && (device.username || device.name) !== myUsername && (
          <button
            className={`dt-friend-btn${friendState === 'friend' ? ' friend' : friendState === 'pending' ? ' pending' : ''}`}
            onClick={friendState === 'none' ? sendFriendRequest : undefined}
            title={friendState === 'friend' ? 'Already friends' : friendState === 'pending' ? 'Request sent' : 'Send friend request'}
            disabled={friendState !== 'none'}
          >
            {friendState === 'friend' ? '✓' : friendState === 'pending' ? '⏳' : '+'}
          </button>
        )}
      </div>

      <div className="device-permissions">
        <div className="permission-label">Permissions:</div>
        <div className="permission-badges">
          {device.permissions.files && (
            <span className="permission-badge">Files</span>
          )}
          {device.permissions.media && (
            <span className="permission-badge">Media</span>
          )}
          {device.permissions.prompts && (
            <span className="permission-badge">Prompts</span>
          )}
          {device.permissions.clipboard && (
            <span className="permission-badge">Clipboard</span>
          )}
          {device.permissions.remote_browse && (
            <span className="permission-badge">Remote Access</span>
          )}
          {!device.permissions.files &&
            !device.permissions.media &&
            !device.permissions.prompts &&
            !device.permissions.clipboard &&
            !device.permissions.remote_browse && (
              <span className="permission-badge inactive">None</span>
            )}
        </div>
      </div>

      {transferStatus && (
        <div className={`transfer-status ${transferStatus.direction}`}>
          <div className="transfer-status-row">
            <span className="transfer-status-label">
              {transferStatus.direction === 'sending' ? 'Sending' : 'Receiving'} {transferStatus.fileName}
            </span>
            <span className="transfer-status-percent">{Math.max(0, Math.min(100, Math.round(transferStatus.progress)))}%</span>
          </div>
          <div className="transfer-progress-bar">
            <div
              className="transfer-progress-fill"
              style={{ width: `${Math.max(0, Math.min(100, transferStatus.progress))}%` }}
            />
          </div>
          <div className="transfer-meta">
            <span>{formatBytes(transferStatus.transferredBytes)} / {formatBytes(transferStatus.totalBytes)}</span>
            <span>{formatBytes(transferStatus.speedBytesPerSec)}/s</span>
            <span>{transferStatus.completed ? 'Done' : `ETA ${formatDuration(transferStatus.etaSeconds)}`}</span>
          </div>
        </div>
      )}

      <div className="device-remote-access">
        <label className="device-remote-access-toggle">
          <input
            type="checkbox"
            checked={device.permissions.remote_browse || false}
            onChange={(e) => {
              const intent: Intent = {
                intent_type: 'clipboard_sync', // Reuse clipboard_sync as a permission request
                payload: {
                  clipboard: {
                    text: e.target.checked ? 'ENABLE_REMOTE_ACCESS' : 'DISABLE_REMOTE_ACCESS',
                  },
                },
                target_device: device.id,
                source_device: '',
                auto_open: false,
                timestamp: Date.now(),
              };
              // This will trigger permission update
              onDrop(intent);
            }}
          />
          <span className="toggle-label">Enable Remote Access</span>
        </label>
        {device.permissions.remote_browse && (
          <button
            className="remote-access-button"
            onClick={async () => {
              // Get device ID from session storage or generate
              const viewerDeviceId = sessionStorage.getItem('deviceId') || 
                (() => {
                  const id = 'viewer-' + Date.now();
                  sessionStorage.setItem('deviceId', id);
                  return id;
                })();
              
              // Store session info for RemoteAccess component
              const sessionCode = sessionStorage.getItem('sessionCode');
              const sessionId = sessionStorage.getItem('sessionId');
              if (sessionCode) sessionStorage.setItem('sessionCode', sessionCode);
              if (sessionId) sessionStorage.setItem('sessionId', sessionId);
              
              // Send remote access request to source device
              const intent: Intent = {
                intent_type: 'remote_access_request',
                payload: {
                  request: {
                    viewerDeviceId: viewerDeviceId,
                    action: 'start_screen_share',
                  },
                },
                target_device: device.id,
                source_device: viewerDeviceId,
                auto_open: false,
                timestamp: Date.now(),
              };
              // Send request first
              onDrop(intent);
              // Then open remote view interface
              window.open(`/remote/${device.id}`, '_blank');
            }}
          >
            Open Remote View
          </button>
        )}
      </div>

      <div className="device-clipboard">
        <input
          type="text"
          className="device-clipboard-input"
          placeholder="Type or paste text to send to this device"
          value={clipboardText}
          onChange={(e) => setClipboardText(e.target.value)}
        />
        <button
          className="device-clipboard-button"
          onClick={() => {
            const text = clipboardText.trim();
            if (!text) return;

            const intent: Intent = {
              intent_type: 'clipboard_sync',
              payload: {
                clipboard: {
                  text,
                },
              },
              target_device: device.id,
              source_device: '',
              auto_open: true,
              timestamp: Date.now(),
            };

            onDrop(intent);
          }}
        >
          Send text
        </button>
      </div>

      {isDragOver && (
        <div className="drop-indicator">
          <div className="drop-message">Drop here to send</div>
        </div>
      )}
    </div>
  );
}

export default React.memo(DeviceTileComponent, (prev, next) => {
  const prevTransfer = prev.transferStatus;
  const nextTransfer = next.transferStatus;
  const transferEqual =
    (!prevTransfer && !nextTransfer) ||
    (Boolean(prevTransfer) &&
      Boolean(nextTransfer) &&
      prevTransfer!.progress === nextTransfer!.progress &&
      prevTransfer!.transferredBytes === nextTransfer!.transferredBytes &&
      prevTransfer!.completed === nextTransfer!.completed &&
      prevTransfer!.fileName === nextTransfer!.fileName &&
      prevTransfer!.direction === nextTransfer!.direction);

  return (
    prev.device.id === next.device.id &&
    prev.device.online === next.device.online &&
    prev.device.name === next.device.name &&
    prev.device.username === next.device.username &&
    JSON.stringify(prev.device.permissions) === JSON.stringify(next.device.permissions) &&
    transferEqual
  );
});

