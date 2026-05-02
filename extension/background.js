/**
 * FlowLink Browser Extension - Background Service Worker
 * Handles WebSocket connection, clipboard monitoring, and message routing
 */

// Configuration wss://flowlink-1.onrender.com
const BACKEND_URL = 'wss://flowlink-1.onrender.com';
let ws = null;
let deviceId = null;
let username = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let connectionTimeout = null;
let isInitializing = false;
let lastClipboardFingerprint = null;
let lastClipboardSyncedAt = 0;
let lastMediaHandoffFingerprint = null;
let lastMediaHandoffAt = 0;
let lastClipboardSkipReason = null;
let lastClipboardSkipAt = 0;
let targetUsernames = [];
let targetStatuses = {};
const extensionTransfers = new Map();
const TRANSFER_CHUNK_SIZE = 128 * 1024;

function notifyExtensionTransferProgress(data) {
  try {
    chrome.runtime.sendMessage({
      type: 'extension_file_transfer_progress',
      data,
    });
  } catch (_err) {
    // popup likely closed
  }
}

function updateExtensionTransferFromAck(payload = {}) {
  const transferId = payload.transferId;
  if (!transferId || !extensionTransfers.has(transferId)) return;
  const current = extensionTransfers.get(transferId);
  const transferredBytes = Math.max(current.ackedBytes || 0, Number(payload.transferredBytes || 0));
  const totalBytes = Number(payload.totalBytes || current.totalBytes || 0);
  const startedAt = current.startedAt || Date.now();
  const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const speedBytesPerSec = transferredBytes / elapsed;
  const progress = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : Number(payload.progress || 0);
  const etaSeconds = payload.completed ? 0 : Math.max(0, Math.ceil((totalBytes - transferredBytes) / Math.max(1, speedBytesPerSec)));
  const next = {
    ...current,
    ackedBytes: transferredBytes,
    totalBytes,
    completed: Boolean(payload.completed),
  };
  extensionTransfers.set(transferId, next);
  notifyExtensionTransferProgress({
    transferId,
    fileName: current.fileName,
    transferredBytes,
    totalBytes,
    progress,
    speedBytesPerSec,
    etaSeconds,
  });
  if (payload.completed || progress >= 100) {
    setTimeout(() => extensionTransfers.delete(transferId), 1200);
  }
}

function normalizeTargetUsernames(value) {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const seen = new Set();
  return rawValues
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item && !seen.has(item) && seen.add(item));
}

function getLegacyTargetUsername() {
  return targetUsernames[0] || null;
}

function getTargetStatusSnapshot() {
  return { ...targetStatuses };
}

function setTargetStatusesPending(usernames) {
  const nextStatuses = {};
  for (const name of usernames) {
    const previous = targetStatuses[name];
    nextStatuses[name] = previous?.connected
      ? previous
      : { targetUsername: name, connected: false, pending: true };
  }
  targetStatuses = nextStatuses;
}

function persistTargetUsernames() {
  chrome.storage.local.set({
    targetUsernames,
    targetUsername: getLegacyTargetUsername()
  });
}

function sendTargetConnectionPings() {
  if (!username || !targetUsernames.length) {
    return;
  }

  setTargetStatusesPending(targetUsernames);
  for (const targetUsername of targetUsernames) {
    sendMessage({
      type: 'target_connection_ping',
      payload: {
        targetUsername,
        sourceUsername: username,
        sourceDeviceName: 'Browser Extension'
      }
    });
  }
}

function sendTargetedMessages(type, payloadBuilder) {
  if (targetUsernames.length) {
    return targetUsernames.map((targetUsername) => sendMessage({
      type,
      payload: {
        ...payloadBuilder(targetUsername),
        targetUsername
      }
    }));
  }

  return [sendMessage({
    type,
    payload: payloadBuilder(null)
  })];
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function sendFileToTargets(fileName, fileType, arrayBuffer) {
  if (!targetUsernames.length) {
    throw new Error('Add at least one receiver username.');
  }
  if (!isConnected) {
    throw new Error('Backend WebSocket is not connected.');
  }

  const transferId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  extensionTransfers.set(transferId, { fileName, totalBytes: arrayBuffer.byteLength, transferredBytes: 0, ackedBytes: 0, startedAt: Date.now() });

  // Send start
  for (const targetUsername of targetUsernames) {
    sendMessage({
      type: 'file_transfer_start',
      payload: { transferId, fileName, fileType, totalBytes: arrayBuffer.byteLength, targetUsername }
    });
  }

  // Send chunks with small delay between each to avoid flooding the WebSocket
  let offset = 0;
  let chunkIndex = 0;
  while (offset < arrayBuffer.byteLength) {
    const nextOffset = Math.min(arrayBuffer.byteLength, offset + TRANSFER_CHUNK_SIZE);
    const chunk = arrayBuffer.slice(offset, nextOffset);
    const data = arrayBufferToBase64(chunk);

    for (const targetUsername of targetUsernames) {
      sendMessage({
        type: 'file_transfer_chunk',
        payload: { transferId, chunkIndex, data, fileName, fileType, totalBytes: arrayBuffer.byteLength, targetUsername }
      });
    }

    offset = nextOffset;
    chunkIndex += 1;

    // Update progress
    const currentTransfer = extensionTransfers.get(transferId) || {};
    extensionTransfers.set(transferId, {
      ...currentTransfer,
      fileName,
      totalBytes: arrayBuffer.byteLength,
      transferredBytes: offset,
      ackedBytes: currentTransfer.ackedBytes || 0,
      startedAt: currentTransfer.startedAt || Date.now(),
    });

    // Yield to event loop every 4 chunks to prevent WebSocket buffer overflow
    if (chunkIndex % 4 === 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  // Send complete
  for (const targetUsername of targetUsernames) {
    sendMessage({
      type: 'file_transfer_complete',
      payload: { transferId, fileName, targetUsername }
    });
  }

  extensionTransfers.delete(transferId);
}

function forwardTransferStart({ transferId, fileName, fileType, totalBytes }) {
  extensionTransfers.set(transferId, { fileName, totalBytes, transferredBytes: 0, ackedBytes: 0, startedAt: Date.now() });
  notifyExtensionTransferProgress({ transferId, fileName, progress: 0, transferredBytes: 0, totalBytes, speedBytesPerSec: 0, etaSeconds: 0 });
  for (const targetUsername of targetUsernames) {
    sendMessage({
      type: 'file_transfer_start',
      payload: {
        transferId,
        fileName,
        fileType,
        totalBytes,
        targetUsername
      }
    });
  }
}

function forwardTransferChunk({ transferId, chunkIndex, data, fileName, fileType, totalBytes }) {
  for (const targetUsername of targetUsernames) {
    sendMessage({
      type: 'file_transfer_chunk',
      payload: {
        transferId,
        chunkIndex,
        data,
        fileName,
        fileType,
        totalBytes,
        targetUsername
      }
    });
  }
}

function forwardTransferComplete({ transferId, fileName }) {
  for (const targetUsername of targetUsernames) {
    sendMessage({
      type: 'file_transfer_complete',
      payload: {
        transferId,
        fileName,
        targetUsername
      }
    });
  }
}

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('FlowLink extension installed');
  injectClipboardScriptIntoTabs();
  initializeExtension();
});

// Also connect on startup (when browser starts)
chrome.runtime.onStartup.addListener(() => {
  console.log('Browser started, initializing extension...');
  injectClipboardScriptIntoTabs();
  initializeExtension();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') {
    return;
  }

  if (!tab?.url || !isInjectableUrl(tab.url)) {
    return;
  }

  injectSupportedScripts(tabId, tab.url);
});

// Initialize extension function
function initializeExtension() {
  if (isInitializing) {
    return;
  }

  isInitializing = true;

  // FIRST: Ensure deviceId exists
  chrome.storage.local.get(['deviceId'], (result) => {
    if (result.deviceId) {
      deviceId = result.deviceId;
      console.log('Using existing deviceId:', deviceId);
    } else {
      deviceId = generateDeviceId();
      chrome.storage.local.set({ deviceId });
      console.log('Generated new deviceId:', deviceId);
    }
    
    // THEN: Check for username and connect
    chrome.storage.local.get(['username', 'targetUsername', 'targetUsernames', 'settings'], (result) => {
      console.log('Loaded from storage:', result);
      targetUsernames = normalizeTargetUsernames(result.targetUsernames?.length ? result.targetUsernames : result.targetUsername);
      setTargetStatusesPending(targetUsernames);
      persistTargetUsernames();
      
      if (result.username) {
        username = result.username;
        console.log('Found existing user:', username);
        connectWebSocket();
      } else {
        console.log('⚠️ No username found. Please set username in popup.');
      }
      
      // Set default settings
      if (!result.settings) {
        chrome.storage.local.set({
          settings: {
            smartHandoff: true,
            universalClipboard: true,
            notifications: true
          }
        });
        console.log('Set default settings');
      }

      isInitializing = false;
    });
  });
}

// Generate unique device ID
function generateDeviceId() {
  return `ext-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

function isInjectableUrl(url) {
  return /^https?:\/\//.test(url);
}

function injectClipboardScript(tabId) {
  if (!chrome.scripting?.executeScript) {
    return;
  }

  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content-clipboard.js']
  }).catch(() => {
    // Ignore restricted tabs or transient navigation failures.
  });
}

function isMediaSupportedUrl(url) {
  return [
    'youtube.com',
    'netflix.com',
    'open.spotify.com',
    'instagram.com',
    'jiosaavn.com',
    'gaana.com',
    'isaidub',
    'moviesda',
    'web.whatsapp.com',
    'whatsapp.com',
    'twitch.tv',
    'vimeo.com',
    'dailymotion.com'
  ].some((host) => url.includes(host));
}

function injectMediaScript(tabId) {
  if (!chrome.scripting?.executeScript) {
    return;
  }

  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content-media.js']
  }).catch(() => {
    // Ignore restricted tabs or transient navigation failures.
  });
}

function injectSupportedScripts(tabId, url) {
  injectClipboardScript(tabId);
  injectMediaScript(tabId);
}

function injectClipboardScriptIntoTabs() {
  if (!chrome.tabs?.query) {
    return;
  }

  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id && tab.url && isInjectableUrl(tab.url)) {
        injectSupportedScripts(tab.id, tab.url);
      }
    }
  });
}

// WebSocket Connection
function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return;
  }

  console.log('Connecting to FlowLink backend:', BACKEND_URL);
  
  // Clear any existing timeout
  if (connectionTimeout) {
    clearTimeout(connectionTimeout);
  }
  
  try {
    ws = new WebSocket(BACKEND_URL);
    
    // Set connection timeout (30 seconds for Railway cold start)
    connectionTimeout = setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        console.error('⏱️ Connection timeout - backend not responding');
        ws.close();
      }
    }, 30000); // 30 second timeout for Railway

    ws.onopen = () => {
      clearTimeout(connectionTimeout);
      console.log('✅ Connected to FlowLink backend');
      console.log('📝 Username:', username);
      console.log('🆔 Device ID:', deviceId);
      isConnected = true;
      reconnectAttempts = 0;
      
      // Register device
      if (username) {
        const registerMsg = {
          type: 'device_register',
          payload: {
            deviceId,
            deviceName: 'Browser Extension',
            deviceType: 'browser',
            username
          }
        };
        console.log('📤 Sending registration:', registerMsg);
        sendMessage(registerMsg);

        if (targetUsernames.length) {
          setTimeout(() => {
            sendTargetConnectionPings();
          }, 500);
        }
      } else {
        console.warn('⚠️ No username set! Please open extension popup and set username.');
      }
      
      // Update popup
      try {
        chrome.runtime.sendMessage({ type: 'connection_status', connected: true });
      } catch (e) {
        // Popup might not be open
      }
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      handleMessage(message);
    };

    ws.onclose = (event) => {
      clearTimeout(connectionTimeout);
      console.log('❌ Disconnected from FlowLink backend');
      console.log('   Close code:', event.code);
      console.log('   Close reason:', event.reason || 'No reason provided');
      isConnected = false;
      ws = null;
      
      // Update popup
      try {
        chrome.runtime.sendMessage({ type: 'connection_status', connected: false });
      } catch (e) {
        // Popup might not be open
      }
      
      // Attempt reconnection with exponential backoff
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 30000); // Max 30s
        console.log(`🔄 Reconnecting in ${delay/1000}s... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(connectWebSocket, delay);
      } else {
        console.error('❌ Max reconnection attempts reached.');
        console.error('   Please reload the extension or check backend status.');
      }
    };

    ws.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
      console.error('   Backend URL:', BACKEND_URL);
      console.error('   Make sure Railway backend is running!');
    };
  } catch (error) {
    console.error('❌ Failed to create WebSocket:', error);
  }
}

// Send message to backend
function sendMessage(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {

    const finalMessage = {
      type: message.type,
      deviceId: deviceId,
      sessionId: null,
      payload: message.payload || {},   // 🔥 ALWAYS ensure payload exists
      timestamp: Date.now()
    };

    console.log('📤 Sending to backend:', finalMessage);
    ws.send(JSON.stringify(finalMessage));
    return true;

  } else {
    return false;
  }
}

function logClipboardSkip(reason) {
  const now = Date.now();
  if (reason === lastClipboardSkipReason && now - lastClipboardSkipAt < 5000) {
    return;
  }

  lastClipboardSkipReason = reason;
  lastClipboardSkipAt = now;
  console.warn(reason);
}

function normalizeClipboardPayload(clipboard = {}) {
  const normalized = {
    text: typeof clipboard.text === 'string' ? clipboard.text : '',
    html: typeof clipboard.html === 'string' ? clipboard.html : '',
    url: typeof clipboard.url === 'string' ? clipboard.url : '',
    image: typeof clipboard.image === 'string' ? clipboard.image : '',
    mimeType: typeof clipboard.mimeType === 'string' ? clipboard.mimeType : '',
    sourceUrl: typeof clipboard.sourceUrl === 'string' ? clipboard.sourceUrl : '',
    pageTitle: typeof clipboard.pageTitle === 'string' ? clipboard.pageTitle : ''
  };

  if (!normalized.url && normalized.text) {
    try {
      const parsed = new URL(normalized.text);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        normalized.url = normalized.text;
      }
    } catch (_err) {
      // Not a URL, ignore.
    }
  }

  return normalized;
}

function getClipboardFingerprint(clipboard) {
  return JSON.stringify([
    clipboard.text || '',
    clipboard.url || '',
    clipboard.html || '',
    clipboard.image ? clipboard.image.slice(0, 96) : '',
    clipboard.mimeType || ''
  ]);
}

function shouldSkipClipboard(clipboard) {
  const fingerprint = getClipboardFingerprint(clipboard);
  const now = Date.now();

  if (fingerprint === lastClipboardFingerprint && now - lastClipboardSyncedAt < 2000) {
    return true;
  }

  lastClipboardFingerprint = fingerprint;
  lastClipboardSyncedAt = now;
  return false;
}

function buildTimestampedMediaUrl(url, timestamp) {
  if (!url || !timestamp || timestamp <= 0) {
    return url;
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtube.com') || parsed.hostname === 'youtu.be') {
      parsed.searchParams.set('t', Math.floor(timestamp).toString());
      return parsed.toString();
    }
  } catch (_err) {
    if (url.includes('youtube.com')) {
      return `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(timestamp)}`;
    }
  }

  return url;
}

function executeScriptAsync(target, func, args = []) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target, func, args }, (results) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(results || []);
    });
  });
}

function queryTabsAsync(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

async function captureTabState(tab) {
  const baseState = {
    url: tab.url || '',
    title: tab.title || tab.url || 'Untitled Tab',
    favIconUrl: tab.favIconUrl || '',
    scrollX: 0,
    scrollY: 0,
    scrollProgress: 0,
    viewportHeight: 0,
    documentHeight: 0,
    mediaTimestamp: 0,
    mediaPaused: true,
    selectionText: '',
    capturedAt: Date.now()
  };

  if (!tab.id || !tab.url || !isInjectableUrl(tab.url)) {
    return baseState;
  }

  try {
    const results = await executeScriptAsync(
      { tabId: tab.id, allFrames: false },
      () => {
        const root = document.scrollingElement || document.documentElement || document.body;
        const scrollY = Math.max(window.scrollY || 0, root?.scrollTop || 0);
        const scrollX = Math.max(window.scrollX || 0, root?.scrollLeft || 0);
        const viewportHeight = window.innerHeight || 0;
        const documentHeight = Math.max(
          root?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0
        );
        const maxScrollable = Math.max(documentHeight - viewportHeight, 0);
        const selection = window.getSelection ? window.getSelection().toString().trim() : '';
        const media = Array.from(document.querySelectorAll('video, audio')).find((element) => {
          return element.currentSrc || element.src || !element.paused || element.readyState > 0;
        });

        return {
          scrollX,
          scrollY,
          scrollProgress: maxScrollable > 0 ? Math.min(scrollY / maxScrollable, 1) : 0,
          viewportHeight,
          documentHeight,
          mediaTimestamp: media && Number.isFinite(media.currentTime) ? Math.floor(media.currentTime) : 0,
          mediaPaused: media ? Boolean(media.paused) : true,
          selectionText: selection.slice(0, 280),
          pageTitle: document.title || ''
        };
      }
    );

    return {
      ...baseState,
      ...(results[0]?.result || {})
    };
  } catch (_err) {
    return baseState;
  }
}

async function collectWindowTabsForHandoff() {
  // Get the last focused normal browser window (not the popup window)
  const allWindows = await new Promise((resolve) => {
    chrome.windows.getAll({ populate: false, windowTypes: ['normal'] }, resolve);
  });
  const normalWindows = allWindows.filter(w => w.type === 'normal' && w.focused !== false);
  // Pick the most recently focused normal window
  const targetWindowId = normalWindows.length > 0
    ? normalWindows[normalWindows.length - 1].id
    : undefined;

  const queryInfo = targetWindowId
    ? { windowId: targetWindowId }
    : { currentWindow: true };

  const tabs = await queryTabsAsync(queryInfo);
  const validTabs = tabs
    .filter((tab) => tab.url && isInjectableUrl(tab.url))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const capturedTabs = [];
  for (const tab of validTabs) {
    capturedTabs.push(await captureTabState(tab));
  }

  const activeIndex = validTabs.findIndex((tab) => tab.active);
  return {
    tabs: capturedTabs,
    activeIndex: activeIndex >= 0 ? activeIndex : 0
  };
}

async function collectActiveTabForHandoff() {
  // Query the last focused normal window for the active tab (not the popup)
  const [activeTab] = await queryTabsAsync({ active: true, lastFocusedWindow: true });
  if (!activeTab || !activeTab.url || !isInjectableUrl(activeTab.url)) {
    // Fallback: get any active tab from normal windows
    const allTabs = await queryTabsAsync({ active: true });
    const normalTab = allTabs.find(t => t.url && isInjectableUrl(t.url));
    if (!normalTab) return { tabs: [], activeIndex: 0 };
    return { tabs: [await captureTabState(normalTab)], activeIndex: 0 };
  }
  return {
    tabs: [await captureTabState(activeTab)],
    activeIndex: 0
  };
}

async function sendTabHandoff(kind) {
  if (!username) {
    throw new Error('Set extension username first.');
  }

  if (!targetUsernames.length) {
    throw new Error('Add at least one receiver username.');
  }

  if (!isConnected) {
    connectWebSocket();
    throw new Error('Backend WebSocket is not connected yet. Try again in a moment.');
  }

  const snapshot = kind === 'collection'
    ? await collectWindowTabsForHandoff()
    : await collectActiveTabForHandoff();

  if (!snapshot.tabs.length) {
    throw new Error('No supported tabs found to send.');
  }

  const payloadBase = {
    tabs: snapshot.tabs,
    activeIndex: snapshot.activeIndex,
    sourceUsername: username,
    sourceDeviceName: 'Browser Extension',
    collectionTitle: kind === 'collection' ? `${snapshot.tabs.length} tabs from Chrome` : snapshot.tabs[0].title,
    sentAt: Date.now()
  };

  const sentResults = sendTargetedMessages('tab_handoff', (targetUsername) => ({
    ...payloadBase,
    targetUsername
  }));

  if (!sentResults.some(Boolean)) {
    throw new Error('Failed to send tab handoff to backend.');
  }

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: kind === 'collection' ? 'Tabs Sent' : 'Tab Sent',
    message: kind === 'collection'
      ? `${snapshot.tabs.length} tabs sent to ${targetUsernames.join(', ')}`
      : `${snapshot.tabs[0].title} sent to ${targetUsernames.join(', ')}`,
    priority: 0
  });

  return { success: true, tabCount: snapshot.tabs.length };
}

// Handle incoming messages
function handleMessage(message) {
  console.log('📥 Received from backend:', message.type, message);
  
  switch (message.type) {
    case 'device_registered':
      console.log('✅ Device registered successfully!');
      console.log('   Username:', username);
      console.log('   Device ID:', deviceId);
      console.log('   Ready to send/receive notifications!');
      
      // Wait 2 seconds to ensure other devices are also registered
      setTimeout(() => {
        console.log('📤 Sending device connected notification to other devices...');
        sendMessage({
          type: 'device_connected_notification',
          payload: {
            deviceName: 'Browser Extension',
            deviceType: 'browser',
            username: username
          }
        });
      }, 2000);
      break;
      
    case 'media_handoff_offer':
      console.log('🎬 Media handoff offer received:', message.payload);
      handleMediaHandoffOffer(message.payload);
      break;
      
    case 'clipboard_sync':
      console.log('📋 Clipboard sync received:', message.payload);
      handleClipboardSync(message.payload);
      break;

    case 'target_connection_request':
      handleTargetConnectionRequest(message.payload);
      break;

    case 'target_connection_result':
      handleTargetConnectionResult(message.payload);
      break;

    case 'file_transfer_ack':
      updateExtensionTransferFromAck(message.payload || {});
      break;
      
    case 'session_invitation':
      console.log('📨 Session invitation received:', message.payload);
      // Forward to popup if open (safely)
      try {
        chrome.runtime.sendMessage({ type: 'session_invitation', data: message.payload });
      } catch (e) {
        // Popup not open, ignore
      }
      break;
      
    case 'pong':
      // Keepalive response - no action needed
      break;
      
    case 'error':
      console.error('❌ Backend error:', message.payload);
      if (message.payload && message.payload.message) {
        console.error('   Error message:', message.payload.message);
      }
      break;
      
    default:
      console.log('❓ Unknown message type:', message.type);
  }
}

// Handle media handoff offer from another device
function handleMediaHandoffOffer(payload) {
  chrome.storage.local.get(['settings'], (result) => {
    if (!result.settings?.smartHandoff) return;
    
    const { title, url, timestamp, platform } = payload;
    
    // Show notification
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Continue Watching?',
      message: `${title}\nFrom: ${platform}`,
      buttons: [
        { title: 'Continue' },
        { title: 'Dismiss' }
      ],
      requireInteraction: true
    }, (notificationId) => {
      // Store data for button click
      chrome.storage.local.set({
        [`handoff_${notificationId}`]: { url, timestamp }
      });
    });
  });
}

// Handle notification button clicks
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex === 0) { // Continue button
    chrome.storage.local.get([`handoff_${notificationId}`], (result) => {
      const data = result[`handoff_${notificationId}`];
      if (data) {
        const finalUrl = buildTimestampedMediaUrl(data.url, data.timestamp);
        chrome.tabs.create({ url: finalUrl });
        
        // Clean up
        chrome.storage.local.remove([`handoff_${notificationId}`]);
      }
    });
  }
  chrome.notifications.clear(notificationId);
});

// Handle clipboard sync from another device
function handleClipboardSync(payload) {
  chrome.storage.local.get(['settings'], (result) => {
    if (!result.settings?.universalClipboard) return;

    const clipboard = normalizeClipboardPayload(payload.clipboard);
    if (shouldSkipClipboard(clipboard)) {
      return;
    }

    const textToWrite = clipboard.text || clipboard.url;

    if (textToWrite) {
      // Write text to clipboard
      navigator.clipboard.writeText(textToWrite).then(() => {
        console.log('Clipboard synced:', textToWrite.substring(0, 50));
        
        // Show notification
        if (result.settings?.notifications) {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'Clipboard Synced',
            message: textToWrite.substring(0, 100) + (textToWrite.length > 100 ? '...' : ''),
            priority: 0
          });
        }
      }).catch(err => {
        console.error('Failed to write to clipboard:', err);
      });
    }
    
    if (clipboard.image && result.settings?.notifications) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Image Clipboard Synced',
        message: clipboard.pageTitle || clipboard.sourceUrl || 'Image copied from another device',
        priority: 0
      });
    }
  });
}

function handleTargetConnectionRequest(payload) {
  const sourceUsername = payload?.sourceUsername || 'Someone';
  const sourceDeviceName = payload?.sourceDeviceName || 'Browser Extension';

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'FlowLink Receiver Connected',
    message: `${sourceUsername} connected to ${sourceDeviceName}`,
    priority: 1
  });

  sendMessage({
    type: 'target_connection_ack',
    payload: {
      sourceDeviceId: payload?.sourceDeviceId,
      sourceUsername,
      targetUsername: username,
      targetDeviceName: 'Browser Extension'
    }
  });
}

function handleTargetConnectionResult(payload) {
  if (payload?.targetUsername) {
    targetStatuses[payload.targetUsername] = payload;
  }

  try {
    chrome.runtime.sendMessage({
      type: 'target_connection_result',
      data: payload
    });
  } catch (_err) {
    // Popup may be closed.
  }

  if (payload?.connected) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Receiver Available',
      message: `${payload.targetUsername} is connected on ${payload.targetDeviceName || 'a device'}`,
      priority: 0
    });
  }
}

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('📨 Received message from content script:', request.type);
  
  try {
    switch (request.type) {
      case 'media_state_changed':
        handleMediaStateChanged(request.data, sender.tab);
        sendResponse({ success: true });
        break;
        
      case 'clipboard_changed':
        handleClipboardChanged(request.data);
        sendResponse({ success: true });
        break;
        
      case 'get_connection_status':
        sendResponse({
          connected: isConnected,
          username,
          targetUsername: getLegacyTargetUsername(),
          targetUsernames: [...targetUsernames],
          targetStatuses: getTargetStatusSnapshot()
        });
        break;
        
      case 'set_username':
        username = request.username;
        chrome.storage.local.set({ username });
        if (isConnected) {
          // Re-register with new username
          sendMessage({
            type: 'device_register',
            payload: {
              deviceId,
              deviceName: 'Browser Extension',
              deviceType: 'browser',
              username
            }
          });
        } else {
          connectWebSocket();
        }
        sendResponse({ success: true });
        break;

      case 'set_target_username':
      case 'set_target_usernames': {
        targetUsernames = normalizeTargetUsernames(
          request.type === 'set_target_usernames' ? request.targetUsernames : request.targetUsername
        );
        setTargetStatusesPending(targetUsernames);
        persistTargetUsernames();

        if (!targetUsernames.length) {
          sendResponse({
            success: true,
            targetUsername: null,
            targetUsernames: [],
            targetStatuses: {}
          });
          break;
        }

        if (!isConnected) {
          connectWebSocket();
        }

        sendTargetConnectionPings();

        sendResponse({
          success: true,
          targetUsername: getLegacyTargetUsername(),
          targetUsernames: [...targetUsernames],
          targetStatuses: getTargetStatusSnapshot()
        });
        break;
      }

      case 'send_active_tab_handoff':
      case 'send_active_tab':
        sendTabHandoff('single')
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        break;

      case 'send_tab_collection_handoff':
      case 'send_window_tabs_handoff':
      case 'send_tab_collection':
        sendTabHandoff('collection')
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        break;

      case 'send_file_transfer':
        sendFileToTargets(request.fileName, request.fileType || 'application/octet-stream', request.arrayBuffer)
          .then(() => sendResponse({ success: true }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        break;
      case 'extension_file_transfer_start':
        forwardTransferStart(request);
        sendResponse({ success: true });
        break;
      case 'extension_file_transfer_chunk':
        forwardTransferChunk(request);
        sendResponse({ success: true });
        break;
      case 'extension_file_transfer_complete':
        forwardTransferComplete(request);
        sendResponse({ success: true });
        break;
        
      case 'disconnect':
        if (ws) {
          ws.close();
        }
        sendResponse({ success: true });
        break;
        
      default:
        console.warn('Unknown message type:', request.type);
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  } catch (error) {
    console.error('Error handling message:', error);
    sendResponse({ success: false, error: error.message });
  }
  
  return true; // Keep channel open for async response
});

// Handle media state changes from content scripts
function handleMediaStateChanged(data, tab) {
  console.log('🎬 Media state changed:', data);
  
  chrome.storage.local.get(['settings'], (result) => {
    if (!result.settings?.smartHandoff) {
      console.log('⚠️ Smart Handoff is disabled in settings');
      return;
    }
    
    const { state, title, url, timestamp, platform } = data;
    
    if (state === 'paused') {
      const mediaFingerprint = JSON.stringify([url || '', Math.floor(timestamp || 0), state]);
      if (mediaFingerprint === lastMediaHandoffFingerprint && Date.now() - lastMediaHandoffAt < 8000) {
        return;
      }

      lastMediaHandoffFingerprint = mediaFingerprint;
      lastMediaHandoffAt = Date.now();

      console.log('⏸️ Media paused:', title);
      console.log('   Platform:', platform);
      console.log('   Timestamp:', timestamp);
      console.log('   URL:', url);
      
      // Send to backend
      const msg = {
        type: 'media_handoff'
      };
      console.log('📤 Sending media handoff to backend...');
      sendTargetedMessages(msg.type, (targetUsername) => ({
        action: 'paused',
        title,
        url,
        timestamp,
        platform,
        tabId: tab.id,
        targetUsername
      }));
    }
  });
}

// Handle clipboard changes from content scripts
function handleClipboardChanged(data) {
  const clipboard = normalizeClipboardPayload(data);
  if (shouldSkipClipboard(clipboard)) {
    return;
  }

  if (!username) {
    logClipboardSkip('⚠️ Clipboard skipped: set extension username first.');
    return;
  }

  if (!isConnected) {
    logClipboardSkip('⚠️ Clipboard skipped: backend WebSocket is not connected.');
    connectWebSocket();
    return;
  }

  console.log('📋 Clipboard changed:', {
    hasText: Boolean(clipboard.text),
    hasHtml: Boolean(clipboard.html),
    hasImage: Boolean(clipboard.image),
    url: clipboard.url || null
  });
  
  chrome.storage.local.get(['settings'], (result) => {
    if (!result.settings?.universalClipboard) {
      console.log('⚠️ Universal Clipboard is disabled in settings');
      return;
    }
    
    console.log('📤 Sending clipboard to backend...');

    const sentResults = sendTargetedMessages('clipboard_broadcast', (targetUsername) => ({
      clipboard,
      targetUsername
    }));

    if (!sentResults.some(Boolean)) {
      logClipboardSkip('⚠️ Clipboard skipped: backend WebSocket is not connected.');
    }
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (changes.username?.newValue && changes.username.newValue !== username) {
    username = changes.username.newValue;
    reconnectAttempts = 0;
    connectWebSocket();
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'targetUsernames') || Object.prototype.hasOwnProperty.call(changes, 'targetUsername')) {
    targetUsernames = normalizeTargetUsernames(
      changes.targetUsernames?.newValue?.length ? changes.targetUsernames.newValue : changes.targetUsername?.newValue
    );
    setTargetStatusesPending(targetUsernames);
  }
});

// Keep service worker alive
if (chrome.alarms) {
  chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepAlive') {
      // Ping to keep alive
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendMessage({ type: 'ping' });
      }
    }
  });
} else {
  console.warn('chrome.alarms API not available');
}

console.log('FlowLink background service worker loaded');
initializeExtension();
