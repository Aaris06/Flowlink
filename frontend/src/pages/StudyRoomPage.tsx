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
          const isRecentLocal = now - localInteractionRef.current < 500;
          
          if (mode === 'open_pdf') {
            const targetId = typeof value === 'string' ? value : value?.fileId || value?.id;
            if (!targetId || targetId === 'close') {
              setSelectedFileId('');
              sessionStorage.removeItem('studyFileId');
            } else if (targetId) {
              setSelectedFileId(targetId);
              sessionStorage.setItem('studyFileId', targetId);
            }
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

  // Helper to append a single anchor marker directly to the DOM page wrapper without wiping PDF canvas
  const renderAnchorToDOM = (anchor: HighlightAnchor) => {
    const wrapper = pageRefs.current.get(anchor.page);
    if (!wrapper) return;
    const existing = wrapper.querySelector(`[data-anchor-id="${anchor.id}"]`);
    if (existing) return;

    const marker = document.createElement('div');
    marker.className = 'srp-anchor';
    marker.dataset.anchorId = anchor.id;
    marker.style.left = `${anchor.xPercent}%`;
    marker.style.top = `${anchor.yPercent}%`;
    marker.style.width = `${anchor.widthPercent}%`;
    marker.style.height = `${anchor.heightPercent}%`;
    marker.title = anchor.text;
    wrapper.appendChild(marker);
  };

  // Update anchor DOM markers when anchors change
  useEffect(() => {
    anchors.forEach(renderAnchorToDOM);
  }, [anchors]);

  // Render PDF pages (DEPENDS ONLY ON pdfDataUrl AND zoom to prevent rollback on highlight/notes)
  useEffect(() => {
    if (!pdfDataUrl) return;
    const container = scrollRef.current;
    if (!container) return;
    let cancelled = false;
    const currentScrollBeforeRender = container.scrollTop;

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

        // Mouseup & dblclick to add anchor
        const addAnchor = (evt: MouseEvent) => {
          localInteractionRef.current = Date.now();
          const sel = window.getSelection()?.toString().trim();
          const rect = canvas.getBoundingClientRect();
          const xPct = Math.max(0, Math.min(100, ((evt.clientX - rect.left) / rect.width) * 100));
          const yPct = Math.max(0, Math.min(100, ((evt.clientY - rect.top) / rect.height) * 100));
          const newAnchor: HighlightAnchor = {
            id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            page: p,
            xPercent: xPct,
            yPercent: yPct,
            widthPercent: 14,
            heightPercent: 3,
            text: sel || highlight || `Page ${p} Note`,
            sourceDevice: deviceId,
          };
          setAnchors(prev => [...prev, newAnchor].slice(-200));
          sendSync('highlight_anchor', newAnchor);
        };

        canvas.addEventListener('mouseup', addAnchor);
        canvas.addEventListener('dblclick', addAnchor);

        wrapper.appendChild(canvas);
        wrapper.appendChild(textLayer);
        container.appendChild(wrapper);
        pageRefs.current.set(p, wrapper);
      }

      // Restore scroll position after render
      if (currentScrollBeforeRender > 0) {
        container.scrollTop = currentScrollBeforeRender;
      }
    };

    void render();
    return () => { cancelled = true; if (container) container.innerHTML = ''; pageRefs.current.clear(); };
  }, [pdfDataUrl, zoom]);

  // Scroll sync with debounce
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let scrollTimer: number | null = null;
    const onScroll = () => {
      if (suppressScrollRef.current) return;
      const timeSinceLocal = Date.now() - localInteractionRef.current;
      if (timeSinceLocal < 800) return;
      
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        const px = Math.round(el.scrollTop);
        sendSync('scroll_px', px);
        
        let closest = 1, minDist = Infinity;
        pageRefs.current.forEach((node, pg) => {
          const dist = Math.abs(node.offsetTop - el.scrollTop);
          if (dist < minDist) { minDist = dist; closest = pg; }
        });
        if (closest !== page) { 
          setPage(closest); 
          sendSync('page', closest); 
        }
      }, 400);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (scrollTimer) clearTimeout(scrollTimer);
    };
  }, [page, sendSync]);

  // Text selection sync
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection()?.toString().trim();
      if (sel && sel !== highlight) {
        localInteractionRef.current = Date.now();
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

  const changeZoom = (z: number) => {
    const clamped = Math.max(0.5, Math.min(3, z));
    localInteractionRef.current = Date.now();
    setZoom(clamped);
    setTimeout(() => sendSync('zoom', clamped), 100);
  };

  const openFileAndSync = (f: StudyStoreFile) => {
    localInteractionRef.current = Date.now();
    setSelectedFileId(f.id);
    sessionStorage.setItem('studyFileId', f.id);
    sendSync('open_pdf', { fileId: f.id, file: f });
  };

  const closeFileAndSync = () => {
    sendSync('open_pdf', 'close');
    setSelectedFileId('');
    sessionStorage.removeItem('studyFileId');
    navigate('/study');
  };

  return (
    <div className="study-room-page">
      {/* Toolbar */}
      <div className="srp-toolbar">
        <button className="srp-back-btn" onClick={closeFileAndSync}>← Back to Store</button>
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
                onClick={() => openFileAndSync(f)}
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

            {/* Shared Notes Input */}
            <div className="srp-sidebar-title" style={{ marginTop: '1rem' }}>Shared Note</div>
            <textarea
              className="srp-note-input"
              value={highlight}
              placeholder="Type a shared note or highlight…"
              onChange={e => {
                localInteractionRef.current = Date.now();
                setHighlight(e.target.value);
                sendSync('highlight', e.target.value);
              }}
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
