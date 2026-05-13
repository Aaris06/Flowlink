import { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { useNavigate } from 'react-router-dom';
import { AppContext } from '../App';
import './StudyRoomPage.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

interface StudyStoreFile { id: string; name: string; type: string; size: number; data: string; uploadedBy?: string; }
interface HighlightAnchor { id: string; page: number; xPercent: number; yPercent: number; widthPercent: number; heightPercent: number; text: string; sourceDevice?: string; }
interface SyncState { page?: number; scrollPx?: number; zoom?: number; highlight?: string; selectedFileId?: string; anchors?: HighlightAnchor[]; }

interface Props { ctx: AppContext; }

export default function StudyRoomPage({ ctx }: Props) {
  const { session, deviceId } = ctx;
  const navigate = useNavigate();

  const [files, setFiles] = useState<StudyStoreFile[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<string>(() => sessionStorage.getItem('studyFileId') || '');
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1.2);
  const [highlight, setHighlight] = useState('');
  const [anchors, setAnchors] = useState<HighlightAnchor[]>([]);
  const [pdfDataUrl, setPdfDataUrl] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [showSidebar, setShowSidebar] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const suppressScrollRef = useRef(false);
  const localInteractionRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);

  const sendSync = useCallback((mode: string, value: any) => {
    if (!session) return;
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'study_sync', sessionId: session.id, deviceId, payload: { mode, value }, timestamp: Date.now() }));
  }, [session, deviceId]);

  const applyState = useCallback((state: SyncState) => {
    if (state.page != null) setPage(Math.max(1, state.page));
    if (state.scrollPx != null) setScrollPx(Math.max(0, state.scrollPx));
    if (state.zoom != null) setZoom(Math.max(0.5, Math.min(3, state.zoom)));
    if (state.highlight != null) setHighlight(state.highlight);
    if (state.selectedFileId) setSelectedFileId(state.selectedFileId);
    if (state.anchors) setAnchors(state.anchors.slice(-200));
  }, []);

  const setScrollPx = (px: number) => {
    const el = scrollRef.current;
    if (!el) return;
    suppressScrollRef.current = true;
    el.scrollTop = px;
    setTimeout(() => { suppressScrollRef.current = false; }, 200);
  };

  // WebSocket setup
  useEffect(() => {
    if (!session) return;
    const ws = (window as any).appWebSocket as WebSocket | null;
    wsRef.current = ws;

    // Request file list
    ws?.send(JSON.stringify({ type: 'study_store_list', sessionId: session.id, deviceId, payload: {}, timestamp: Date.now() }));

    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'study_store_list':
          setFiles(msg.payload?.files || []);
          if (msg.payload?.state) applyState(msg.payload.state);
          break;
        case 'session_joined':
          if (msg.payload?.studyStore) setFiles(msg.payload.studyStore);
          if (msg.payload?.studyState) applyState(msg.payload.studyState);
          if (msg.payload?.devices) setParticipants(msg.payload.devices.map((d: any) => d.username || d.name));
          break;
        case 'device_connected':
          {
            const device = msg.payload?.device || msg.payload;
            const name = device?.username || device?.name || device?.deviceName;
            if (name) setParticipants(p => [...new Set([...p, name])]);
          }
          break;
        case 'device_disconnected':
          break;
        case 'study_sync': {
          const { mode, value, state } = msg.payload || {};
          if (state) { applyState(state); break; }
          const now = Date.now();
          const isRecentLocal = now - localInteractionRef.current < 500; // Ignore remote updates for 500ms after local action
          
          if (mode === 'open_pdf' && typeof value === 'string') {
            setSelectedFileId(value);
            sessionStorage.setItem('studyFileId', value);
          }
          if (mode === 'page' && typeof value === 'number' && !isRecentLocal) {
            setPage(Math.max(1, value));
          }
          if (mode === 'scroll_px' && typeof value === 'number' && !isRecentLocal) {
            setScrollPx(Math.max(0, value));
          }
          if (mode === 'zoom' && typeof value === 'number' && !isRecentLocal) {
            setZoom(Math.max(0.5, Math.min(3, value)));
          }
          if (mode === 'highlight' && typeof value === 'string') setHighlight(value);
          if (mode === 'highlight_anchor' && value?.id) {
            setAnchors(prev => { const next = prev.filter(a => a.id !== value.id); next.push(value); return next.slice(-200); });
          }
          break;
        }
      }
    };
    ws?.addEventListener('message', handler);
    return () => ws?.removeEventListener('message', handler);
  }, [session, deviceId, applyState]);

  // Load PDF when file changes
  const selectedFile = files.find(f => f.id === selectedFileId);
  useEffect(() => {
    if (!selectedFile || selectedFile.type !== 'application/pdf') { setPdfDataUrl(''); setPageCount(0); return; }
    const binary = atob(selectedFile.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes.buffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    setPdfDataUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile?.id]);

  // Render PDF pages
  useEffect(() => {
    if (!pdfDataUrl) return;
    const container = scrollRef.current;
    if (!container) return;
    let cancelled = false;

    const render = async () => {
      container.innerHTML = '';
      pageRefs.current.clear();
      const pdf = await pdfjsLib.getDocument(pdfDataUrl).promise;
      if (cancelled) return;
      setPageCount(pdf.numPages);

      for (let p = 1; p <= pdf.numPages; p++) {
        const pg = await pdf.getPage(p);
        if (cancelled) return;
        const vp = pg.getViewport({ scale: zoom });
        const wrapper = document.createElement('div');
        wrapper.className = 'srp-page-wrapper';
        wrapper.dataset.page = String(p);

        const canvas = document.createElement('canvas');
        const ctx2d = canvas.getContext('2d')!;
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await pg.render({ canvasContext: ctx2d, viewport: vp, canvas }).promise;
        if (cancelled) return;

        // Text layer for selection sync
        const textLayer = document.createElement('div');
        textLayer.className = 'srp-text-layer';
        textLayer.style.width = canvas.width + 'px';
        textLayer.style.height = canvas.height + 'px';

        // Click to add anchor
        canvas.addEventListener('mouseup', (evt) => {
          const sel = window.getSelection()?.toString().trim();
          const rect = canvas.getBoundingClientRect();
          const xPct = Math.max(0, Math.min(100, ((evt.clientX - rect.left) / rect.width) * 100));
          const yPct = Math.max(0, Math.min(100, ((evt.clientY - rect.top) / rect.height) * 100));
          const anchor: HighlightAnchor = {
            id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            page: p, xPercent: xPct, yPercent: yPct,
            widthPercent: 12, heightPercent: 2.5,
            text: sel || highlight || 'Highlight',
            sourceDevice: deviceId,
          };
          setAnchors(prev => [...prev, anchor].slice(-200));
          sendSync('highlight_anchor', anchor);
        });

        // Render existing anchors for this page
        anchors.filter(a => a.page === p).forEach(a => {
          const marker = document.createElement('div');
          marker.className = 'srp-anchor';
          marker.style.left = `${a.xPercent}%`;
          marker.style.top = `${a.yPercent}%`;
          marker.style.width = `${a.widthPercent}%`;
          marker.style.height = `${a.heightPercent}%`;
          marker.title = a.text;
          wrapper.appendChild(marker);
        });

        wrapper.appendChild(canvas);
        wrapper.appendChild(textLayer);
        container.appendChild(wrapper);
        pageRefs.current.set(p, wrapper);
      }
    };

    void render();
    return () => { cancelled = true; if (container) container.innerHTML = ''; pageRefs.current.clear(); };
  }, [pdfDataUrl, zoom, anchors, sendSync, highlight, deviceId]);

  // CRITICAL FIX #3: Improved scroll sync with debounce to prevent rollback
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let scrollTimer: number | null = null;
    const onScroll = () => {
      if (suppressScrollRef.current) return;
      
      // Don't sync scroll if we just did a local interaction (zoom, highlight, etc.)
      const timeSinceLocal = Date.now() - localInteractionRef.current;
      if (timeSinceLocal < 800) return; // Ignore scroll events for 800ms after local actions
      
      // Debounce scroll sync
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        const px = Math.round(el.scrollTop);
        sendSync('scroll_px', px);
        
        // Detect current page based on scroll position
        let closest = 1, minDist = Infinity;
        pageRefs.current.forEach((node, pg) => {
          const dist = Math.abs(node.offsetTop - el.scrollTop);
          if (dist < minDist) { minDist = dist; closest = pg; }
        });
        if (closest !== page) { 
          setPage(closest); 
          sendSync('page', closest); 
        }
      }, 500); // 500ms debounce
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (scrollTimer) clearTimeout(scrollTimer);
    };
  }, [page, sendSync]);

  // Text selection sync - mark as local interaction
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection()?.toString().trim();
      if (sel && sel !== highlight) {
        localInteractionRef.current = Date.now(); // Mark as local interaction
        setHighlight(sel);
        sendSync('highlight', sel);
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [highlight, sendSync]);

  const goToPage = (p: number) => {
    const target = pageRefs.current.get(p);
    const el = scrollRef.current;
    if (!target || !el) return;
    suppressScrollRef.current = true;
    el.scrollTop = target.offsetTop;
    setTimeout(() => { suppressScrollRef.current = false; }, 150);
    setPage(p);
    sendSync('page', p);
  };

  // CRITICAL FIX #3: Mark local interaction and prevent remote updates during zoom
  const changeZoom = (z: number) => {
    const clamped = Math.max(0.5, Math.min(3, z));
    localInteractionRef.current = Date.now(); // Mark as local interaction
    setZoom(clamped);
    // Delay sync to allow local render to complete first
    setTimeout(() => sendSync('zoom', clamped), 100);
  };

  return (
    <div className="study-room-page">
      {/* Toolbar */}
      <div className="srp-toolbar">
        <button className="srp-back-btn" onClick={() => navigate('/study')}>← Back to Store</button>
        <div className="srp-file-name">{selectedFile?.name || 'No file selected'}</div>
        <div className="srp-toolbar-controls">
          <button className="srp-ctrl-btn" onClick={() => goToPage(Math.max(1, page - 1))} disabled={page <= 1}>‹</button>
          <span className="srp-page-info">{page} / {pageCount || '—'}</span>
          <button className="srp-ctrl-btn" onClick={() => goToPage(Math.min(pageCount, page + 1))} disabled={page >= pageCount}>›</button>
          <div className="srp-divider" />
          <button className="srp-ctrl-btn" onClick={() => changeZoom(zoom - 0.1)}>−</button>
          <span className="srp-zoom-info">{Math.round(zoom * 100)}%</span>
          <button className="srp-ctrl-btn" onClick={() => changeZoom(zoom + 0.1)}>+</button>
          <div className="srp-divider" />
          <button className="srp-ctrl-btn" onClick={() => setShowSidebar(p => !p)} title="Toggle sidebar">
            {showSidebar ? '⊟' : '⊞'}
          </button>
        </div>
        <div className="srp-participants">
          {participants.slice(0, 4).map((p, i) => (
            <div key={i} className="srp-participant-dot" title={p}>{p[0]?.toUpperCase()}</div>
          ))}
          {participants.length === 0 && <span className="srp-alone">Only you</span>}
        </div>
      </div>

      <div className="srp-body">
        {/* File list sidebar */}
        {showSidebar && (
          <div className="srp-sidebar">
            <div className="srp-sidebar-title">Documents</div>
            {files.length === 0 && <div className="srp-sidebar-empty">No files uploaded yet.</div>}
            {files.map(f => (
              <div
                key={f.id}
                className={`srp-sidebar-file${f.id === selectedFileId ? ' active' : ''}`}
                onClick={() => {
                  setSelectedFileId(f.id);
                  sessionStorage.setItem('studyFileId', f.id);
                  sendSync('open_pdf', f.id);
                }}
              >
                <span className="srp-sf-icon">{f.type === 'application/pdf' ? '📄' : '📎'}</span>
                <div className="srp-sf-info">
                  <div className="srp-sf-name">{f.name}</div>
                  <div className="srp-sf-size">{Math.max(1, Math.round(f.size / 1024))} KB</div>
                </div>
              </div>
            ))}

            {/* Anchors */}
            {anchors.length > 0 && (
              <>
                <div className="srp-sidebar-title" style={{ marginTop: '1rem' }}>Highlights</div>
                <div className="srp-anchor-list">
                  {anchors.slice(-20).map(a => (
                    <button key={a.id} className="srp-anchor-btn" onClick={() => goToPage(a.page)}>
                      <span>P{a.page}</span> {a.text.slice(0, 30)}
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* Highlight input */}
            <div className="srp-sidebar-title" style={{ marginTop: '1rem' }}>Shared Note</div>
            <textarea
              className="srp-note-input"
              value={highlight}
              placeholder="Type a shared note or highlight…"
              onChange={e => { setHighlight(e.target.value); sendSync('highlight', e.target.value); }}
            />
          </div>
        )}

        {/* PDF Viewer */}
        <div className="srp-viewer">
          {!session && (
            <div className="srp-no-session">
            <div className="empty-icon empty-icon-lock" />
              <div>No active session. Go back and create one.</div>
              <button className="btn-primary" onClick={() => navigate('/')}>Go to Overview</button>
            </div>
          )}
          {session && !selectedFile && (
            <div className="srp-no-file">
            <div className="empty-icon empty-icon-folder" />
              <div>Select a document from the sidebar to open it here.</div>
              <div className="srp-nf-sub">Opening a file will sync it to all connected participants.</div>
            </div>
          )}
          {session && selectedFile && selectedFile.type !== 'application/pdf' && (
            <div className="srp-no-file">
              <div>📎</div>
              <div>{selectedFile.name}</div>
              <div className="srp-nf-sub">Only PDF files can be viewed in the Study Room.</div>
            </div>
          )}
          <div
            ref={scrollRef}
            className="srp-pdf-scroll"
            style={{ display: pdfDataUrl ? 'block' : 'none' }}
          />
        </div>
      </div>
    </div>
  );
}
