import { useState, useEffect } from 'react';
import { AppContext } from '../App';
import './FilesPage.css';

interface StoreFile { id: string; name: string; type: string; size: number; data: string; uploadedBy?: string; uploadedAt?: number; }
interface Props { ctx: AppContext; }

export default function FilesPage({ ctx }: Props) {
  const { session, deviceId } = ctx;
  const [files, setFiles] = useState<StoreFile[]>([]);
  const [uploading, setUploading] = useState(false);

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
    let bin = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    ws.send(JSON.stringify({
      type: 'study_store_upload', sessionId: session.id, deviceId,
      payload: { file: { id: `study-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: file.name, type: file.type || 'application/octet-stream', size: file.size, data: btoa(bin), uploadedBy: ctx.username, uploadedAt: Date.now() } },
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

  const downloadFile = (file: StoreFile) => {
    const bin = atob(file.data); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes.buffer], { type: file.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  };

  const fileIcon = (type: string) => {
    if (type === 'application/pdf') return '📄';
    if (type.includes('word') || type.includes('doc')) return '📝';
    if (type.includes('presentation') || type.includes('ppt')) return '📊';
    if (type.includes('text')) return '📃';
    if (type.startsWith('image/')) return '🖼️';
    return '📎';
  };

  return (
    <div className="files-page">
      <div className="files-header card">
        <div className="fh-left">
          <div className="fh-icon fh-icon-svg" />
          <div>
            <div className="fh-title">Shared Files</div>
            <div className="fh-sub">All files uploaded to the session store. Available to all participants.</div>
          </div>
        </div>
        <label className={`btn-primary${uploading ? ' disabled' : ''}`} style={{ cursor: 'pointer' }}>
          {uploading ? 'Uploading…' : '+ Upload File'}
          <input type="file" hidden disabled={!session || uploading} onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.currentTarget.value = ''; }} />
        </label>
      </div>

      {!session && <div className="files-empty card"><div className="empty-icon empty-icon-lock" /><div>Join a session to see shared files.</div></div>}
      {session && files.length === 0 && <div className="files-empty card"><div className="empty-icon empty-icon-folder" /><div>No files uploaded yet. Upload one to share with all participants.</div></div>}

      {session && files.length > 0 && (
        <div className="files-grid">
          {files.map(file => (
            <div key={file.id} className="file-card card">
              <div className="fc-icon fc-icon-file" />
              <div className="fc-info">
                <div className="fc-name">{file.name}</div>
                <div className="fc-meta">
                  {Math.max(1, Math.round(file.size / 1024))} KB
                  {file.uploadedBy && ` · ${file.uploadedBy}`}
                  {file.uploadedAt && ` · ${new Date(file.uploadedAt).toLocaleDateString()}`}
                </div>
              </div>
              <div className="fc-actions">
                <button className="btn-secondary fc-btn" onClick={() => downloadFile(file)}>Download</button>
                {session.createdBy === deviceId && (
                  <button className="btn-danger fc-btn" onClick={() => deleteFile(file.id)}>Delete</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
