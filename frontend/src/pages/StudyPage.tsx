import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../App';
import './StudyPage.css';

interface StudyStoreFile {
  id: string; name: string; type: string; size: number;
  data: string; uploadedBy?: string; uploadedAt?: number;
}

interface Props { ctx: AppContext; }

export default function StudyPage({ ctx }: Props) {
  const { session, deviceId } = ctx;
  const [files, setFiles] = useState<StudyStoreFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!session) return;
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'study_store_list', sessionId: session.id, deviceId, payload: {}, timestamp: Date.now() }));
    }
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'study_store_list') setFiles(msg.payload?.files || []);
      if (msg.type === 'session_joined' && msg.payload?.studyStore) setFiles(msg.payload.studyStore);
    };
    ws?.addEventListener('message', handler);
    return () => ws?.removeEventListener('message', handler);
  }, [session, deviceId]);

  const uploadFile = async (file: File) => {
    if (!session) return;
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setUploading(true);
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    const data = btoa(binary);
    ws.send(JSON.stringify({
      type: 'study_store_upload', sessionId: session.id, deviceId,
      payload: { file: { id: `study-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: file.name, type: file.type || 'application/octet-stream', size: file.size, data } },
      timestamp: Date.now(),
    }));
    setUploading(false);
  };

  const deleteFile = (fileId: string) => {
    if (!session) return;
    const ws = (window as any).appWebSocket as WebSocket | null;
    ws?.send(JSON.stringify({ type: 'study_store_delete', sessionId: session.id, deviceId, payload: { fileId }, timestamp: Date.now() }));
    setFiles(p => p.filter(f => f.id !== fileId));
  };

  const openInRoom = (file: StudyStoreFile) => {
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (session && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'study_sync', sessionId: session.id, deviceId, payload: { mode: 'open_pdf', value: file.id }, timestamp: Date.now() }));
    }
    sessionStorage.setItem('studyFileId', file.id);
    navigate('/study/room');
  };

  const downloadFile = (file: StudyStoreFile) => {
    const binary = atob(file.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes.buffer], { type: file.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  };

  return (
    <div className="study-page">
      {/* Header */}
      <div className="study-page-header card">
        <div className="sph-left">
          <div className="sph-icon sph-icon-svg" />
          <div>
            <div className="sph-title">Study Store</div>
            <div className="sph-sub">Upload documents to share with all session participants.</div>
          </div>
        </div>
        <div className="sph-actions">
          {session && (
            <button className="btn-secondary" onClick={() => navigate('/study/room')}>
              Open Study Room
            </button>
          )}
          <label className={`btn-primary${uploading ? ' disabled' : ''}`}>
            {uploading ? 'Uploading…' : '+ Upload Document'}
            <input
              type="file"
              accept=".pdf,.doc,.docx,.txt,.ppt,.pptx"
              hidden
              disabled={!session || uploading}
              onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.currentTarget.value = ''; }}
            />
          </label>
        </div>
      </div>

      {!session && (
        <div className="study-no-session card">
          <div className="sns-icon sns-icon-svg" />
          <div className="sns-title">No Active Session</div>
          <div className="sns-sub">Create or join a session from the Overview page to use the Study Store.</div>
          <button className="btn-primary" onClick={() => navigate('/')}>Go to Overview</button>
        </div>
      )}

      {session && files.length === 0 && (
        <div className="study-empty card">
          <div className="se-icon se-icon-svg" />
          <div className="se-title">No documents yet</div>
          <div className="se-sub">Upload a PDF, Word doc, or presentation to get started.</div>
        </div>
      )}

      {session && files.length > 0 && (
        <div className="study-files-grid">
          {files.map(file => (
            <div key={file.id} className="study-file-card card">
              <div className="sfc-icon sfc-icon-file" />
              <div className="sfc-info">
                <div className="sfc-name">{file.name}</div>
                <div className="sfc-meta">
                  {Math.max(1, Math.round(file.size / 1024))} KB
                  {file.uploadedBy && ` · by ${file.uploadedBy}`}
                </div>
              </div>
              <div className="sfc-actions">
                {file.type === 'application/pdf' && (
                  <button className="btn-primary sfc-btn" onClick={() => openInRoom(file)}>
                    Open in Room
                  </button>
                )}
                <button className="btn-secondary sfc-btn" onClick={() => downloadFile(file)}>
                  Download
                </button>
                {session.createdBy === deviceId && (
                  <button className="btn-danger sfc-btn" onClick={() => deleteFile(file.id)}>
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
