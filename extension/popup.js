/**
 * FlowLink Browser Extension - Popup UI Script
 * Handles user interactions, settings, and connection status
 */

// DOM Elements
let setupScreen, mainScreen, statusDot, statusText;
let usernameInput, setupBtn;
let userName, smartHandoffToggle, clipboardToggle, notificationsToggle;
let activityList, openWebAppBtn, logoutBtn;
let receiverUsernameInput, saveReceiverBtn, receiverStatus, receiverList;
let sendActiveTabBtn, sendTabCollectionBtn;
let sendFileBtn, sendFileInput, sendFileStatus;
let transferProgressCard, transferFileName, transferPercent, transferProgressFill, transferProgressMeta;

// State
let isConnected = false;
let currentUsername = null;
let currentReceiverUsernames = [];
let targetStatuses = {};

function parseReceiverUsernames(value) {
  const seen = new Set();
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && !seen.has(item) && seen.add(item));
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Get DOM elements
  setupScreen = document.getElementById('setupScreen');
  mainScreen = document.getElementById('mainScreen');
  statusDot = document.getElementById('statusDot');
  statusText = document.getElementById('statusText');
  
  usernameInput = document.getElementById('usernameInput');
  setupBtn = document.getElementById('setupBtn');
  
  userName = document.getElementById('userName');
  smartHandoffToggle = document.getElementById('smartHandoffToggle');
  clipboardToggle = document.getElementById('clipboardToggle');
  notificationsToggle = document.getElementById('notificationsToggle');
  
  activityList = document.getElementById('activityList');
  openWebAppBtn = document.getElementById('openWebAppBtn');
  logoutBtn = document.getElementById('logoutBtn');
  receiverUsernameInput = document.getElementById('receiverUsernameInput');
  saveReceiverBtn = document.getElementById('saveReceiverBtn');
  receiverStatus = document.getElementById('receiverStatus');
  receiverList = document.getElementById('receiverList');
  sendActiveTabBtn = document.getElementById('sendActiveTabBtn');
  sendTabCollectionBtn = document.getElementById('sendTabCollectionBtn');
  sendFileBtn = document.getElementById('sendFileBtn');
  sendFileInput = document.getElementById('sendFileInput');
  sendFileStatus = document.getElementById('sendFileStatus');
  transferProgressCard = document.getElementById('transferProgressCard');
  transferFileName = document.getElementById('transferFileName');
  transferPercent = document.getElementById('transferPercent');
  transferProgressFill = document.getElementById('transferProgressFill');
  transferProgressMeta = document.getElementById('transferProgressMeta');
  
  // Load saved data
  loadUserData();
  
  // Set up event listeners
  setupBtn.addEventListener('click', handleSetup);
  usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSetup();
  });
  
  smartHandoffToggle.addEventListener('change', handleSettingChange);
  clipboardToggle.addEventListener('change', handleSettingChange);
  notificationsToggle.addEventListener('change', handleSettingChange);
  saveReceiverBtn.addEventListener('click', handleReceiverSave);
  receiverUsernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleReceiverSave();
  });
  
  openWebAppBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://flowlink-weld.vercel.app' });
  });
  
  logoutBtn.addEventListener('click', handleLogout);
  sendActiveTabBtn.addEventListener('click', () => handleTabSend('send_active_tab_handoff'));
  sendTabCollectionBtn.addEventListener('click', () => handleTabSend('send_tab_collection_handoff'));
  sendFileBtn.addEventListener('click', () => sendFileInput.click());
  sendFileInput.addEventListener('change', handleFileSend);
  
  // Listen for connection status updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'connection_status') {
      updateConnectionStatus(message.connected);
    } else if (message.type === 'target_connection_result') {
      const payload = message.data || null;
      if (payload?.targetUsername) {
        targetStatuses[payload.targetUsername] = payload;
      }
      updateReceiverUI();
    } else if (message.type === 'extension_file_transfer_progress') {
      const data = message.data || {};
      if (sendFileStatus) {
        sendFileStatus.textContent = `${data.fileName || 'File'}: ${data.progress || 0}%`;
      }
      renderTransferProgress(data);
    }
  });
  
  // Request current connection status
  chrome.runtime.sendMessage({ type: 'get_connection_status' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error getting connection status:', chrome.runtime.lastError.message);
      updateConnectionStatus(false);
      return;
    }
    
    if (response) {
      updateConnectionStatus(response.connected);
      if (response.username) {
        currentUsername = response.username;
        userName.textContent = response.username;
      }
      currentReceiverUsernames = Array.isArray(response.targetUsernames)
        ? response.targetUsernames
        : parseReceiverUsernames(response.targetUsername || '');
      targetStatuses = response.targetStatuses || {};
      updateReceiverUI();
    }
  });
});

// Load user data from storage
function loadUserData() {
  chrome.storage.local.get(['username', 'auth_token', 'targetUsername', 'targetUsernames', 'settings'], (result) => {
    if (result.auth_token && result.username) {
      // Logged in with real credentials
      currentUsername = result.username;
      userName.textContent = result.username;
      showMainScreen();
    } else if (result.username) {
      // Legacy username-only mode - show auth screen to upgrade
      showAuthScreen();
    } else {
      showAuthScreen();
    }

    currentReceiverUsernames = Array.isArray(result.targetUsernames)
      ? result.targetUsernames
      : parseReceiverUsernames(result.targetUsername || '');
    updateReceiverUI();
    
    if (result.settings) {
      smartHandoffToggle.checked = result.settings.smartHandoff !== false;
      clipboardToggle.checked = result.settings.universalClipboard !== false;
      notificationsToggle.checked = result.settings.notifications !== false;
    }
  });
}

function handleFileSend() {
  const file = sendFileInput.files?.[0];
  if (!file) return;
  if (!currentReceiverUsernames.length) {
    alert('Add at least one receiver username first.');
    return;
  }

  const transferId = `popup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chunkSize = 128 * 1024;
  let offset = 0;
  let chunkIndex = 0;

  sendFileStatus.textContent = `Starting ${file.name}... 0%`;
  renderTransferProgress({ fileName: file.name, progress: 0, transferredBytes: 0, totalBytes: file.size, speedBytesPerSec: 0, etaSeconds: 0 });
  chrome.runtime.sendMessage({
    type: 'extension_file_transfer_start',
    transferId,
    fileName: file.name,
    fileType: file.type || 'application/octet-stream',
    totalBytes: file.size
  }, async (startResponse) => {
    if (chrome.runtime.lastError || !startResponse?.success) {
      sendFileStatus.textContent = `Failed to start ${file.name}`;
      return;
    }
    while (offset < file.size) {
      const next = Math.min(file.size, offset + chunkSize);
      const chunkBuffer = await file.slice(offset, next).arrayBuffer();
      const chunkBytes = new Uint8Array(chunkBuffer);
      let binary = '';
      for (let i = 0; i < chunkBytes.length; i += 1) binary += String.fromCharCode(chunkBytes[i]);
      const base64 = btoa(binary);
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'extension_file_transfer_chunk',
          transferId,
          chunkIndex,
          data: base64,
          fileName: file.name,
          fileType: file.type || 'application/octet-stream',
          totalBytes: file.size
        }, resolve);
      });
      if (chrome.runtime.lastError || !response?.success) {
        sendFileStatus.textContent = `Failed at ${Math.round((offset / file.size) * 100)}%`;
        return;
      }
      offset = next;
      chunkIndex += 1;
      sendFileStatus.textContent = `${file.name}: ${Math.round((offset / file.size) * 100)}%`;
    }
    chrome.runtime.sendMessage({
      type: 'extension_file_transfer_complete',
      transferId,
      fileName: file.name
    }, (endResponse) => {
      if (chrome.runtime.lastError || !endResponse?.success) {
        sendFileStatus.textContent = `Failed to finish ${file.name}`;
        return;
      }
      sendFileStatus.textContent = `Sent ${file.name} (100%)`;
      addActivity('tab', `File sent: ${file.name}`);
    });
  });
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

function formatEta(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function renderTransferProgress(data) {
  if (!transferProgressCard) return;
  const progress = Math.max(0, Math.min(100, Number(data.progress || 0)));
  transferProgressCard.hidden = false;
  transferFileName.textContent = data.fileName || 'File transfer';
  transferPercent.textContent = `${progress}%`;
  transferProgressFill.style.width = `${progress}%`;
  transferProgressMeta.textContent = `${formatBytes(data.transferredBytes)} / ${formatBytes(data.totalBytes)} · ${formatBytes(data.speedBytesPerSec)}/s · ETA ${progress >= 100 ? '00:00' : formatEta(data.etaSeconds)}`;
  if (progress >= 100) {
    window.setTimeout(() => {
      if (transferProgressCard) transferProgressCard.hidden = true;
      if (sendFileStatus) sendFileStatus.textContent = `Sent ${data.fileName || 'file'}`;
    }, 1400);
  }
}

// Extension auth tab switcher (global for onclick)
window.extSwitchTab = function(tab) {
  const isSignup = tab === 'signup';
  document.getElementById('extTabLogin').className = 'ext-tab' + (isSignup ? '' : ' active');
  document.getElementById('extTabSignup').className = 'ext-tab' + (isSignup ? ' active' : '');
  document.getElementById('extEmailGroup').style.display = isSignup ? 'block' : 'none';
  document.getElementById('extConfirmGroup').style.display = isSignup ? 'block' : 'none';
  document.getElementById('extIdentifierLabel').textContent = isSignup ? 'Username' : 'Username or Email';
  document.getElementById('extAuthBtn').textContent = isSignup ? 'Create Account' : 'Sign In';
  document.getElementById('extAuthError').style.display = 'none';
  window._extAuthMode = tab;
};
window._extAuthMode = 'login';

async function handleExtAuth() {
  const identifier = document.getElementById('extIdentifier').value.trim();
  const password = document.getElementById('extPassword').value;
  const errorEl = document.getElementById('extAuthError');
  const btn = document.getElementById('extAuthBtn');
  const isSignup = window._extAuthMode === 'signup';

  errorEl.style.display = 'none';
  if (!identifier || !password) { showExtError('All fields are required'); return; }

  btn.textContent = 'Please wait…'; btn.disabled = true;

  try {
    const BACKEND = 'https://flowlink-1.onrender.com';
    let res, data;

    if (isSignup) {
      const email = document.getElementById('extEmail').value.trim();
      const confirm = document.getElementById('extConfirmPassword').value;
      if (password !== confirm) { showExtError('Passwords do not match'); return; }
      if (password.length < 6) { showExtError('Password must be at least 6 characters'); return; }
      res = await fetch(`${BACKEND}/auth/signup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: identifier, email, password })
      });
    } else {
      res = await fetch(`${BACKEND}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: identifier, password, deviceType: 'extension', force: window._extForceLogin || false })
      });
    }

    data = await res.json();
    if (!res.ok) {
      if (data.alreadyLoggedIn) {
        window._extForceLogin = true;
        showExtError(data.error + '\n\nClick Sign In again to force login.');
      } else {
        showExtError(data.error || 'Authentication failed');
      }
      return;
    }

    // Save auth
    chrome.storage.local.set({ username: data.username, auth_token: data.token, user_role: data.role || 'user' });
    currentUsername = data.username;
    userName.textContent = data.username;

    // Tell background to use this token
    chrome.runtime.sendMessage({ type: 'set_username', username: data.username, token: data.token });
    showMainScreen();
  } catch (e) {
    showExtError('Connection failed. Check your internet.');
  } finally {
    btn.textContent = isSignup ? 'Create Account' : 'Sign In';
    btn.disabled = false;
  }
}

function showExtError(msg) {
  const el = document.getElementById('extAuthError');
  el.textContent = msg; el.style.display = 'block';
}

// Handle setup/login
function handleSetup() {
  const username = usernameInput.value.trim();
  
  if (!username) {
    alert('Please enter a username');
    return;
  }
  
  if (username.length < 3) {
    alert('Username must be at least 3 characters');
    return;
  }
  
  // Save username and connect
  chrome.runtime.sendMessage({ 
    type: 'set_username', 
    username 
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error setting username:', chrome.runtime.lastError.message);
      alert('Failed to connect. Please reload the extension and try again.');
      return;
    }
    
    if (response && response.success) {
      currentUsername = username;
      userName.textContent = username;
      showMainScreen();
    } else {
      alert('Failed to connect. Please try again.');
    }
  });
}

// Handle logout
function handleLogout() {
  if (confirm('Are you sure you want to logout?')) {
    chrome.runtime.sendMessage({ type: 'disconnect' }, () => {});
    chrome.storage.local.remove(['username', 'auth_token', 'user_role', 'deviceId', 'targetUsername', 'targetUsernames'], () => {
      currentUsername = null;
      currentReceiverUsernames = [];
      targetStatuses = {};
      usernameInput.value = '';
      showAuthScreen();
    });
  }
}

function handleReceiverSave() {
  const targetUsernames = parseReceiverUsernames(receiverUsernameInput.value);

  chrome.runtime.sendMessage({ type: 'set_target_usernames', targetUsernames }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error saving receiver usernames:', chrome.runtime.lastError.message);
      alert('Failed to save receiver usernames.');
      return;
    }

    if (!response?.success) {
      alert(response?.error || 'Failed to save receiver usernames.');
      return;
    }

    currentReceiverUsernames = Array.isArray(response.targetUsernames) ? response.targetUsernames : [];
    targetStatuses = response.targetStatuses || {};
    updateReceiverUI();
  });
}

function updateReceiverUI() {
  if (!receiverUsernameInput || !receiverStatus || !receiverList) return;

  receiverUsernameInput.value = currentReceiverUsernames.join(', ');
  receiverList.innerHTML = '';

  if (!currentReceiverUsernames.length) {
    receiverStatus.textContent = 'No receivers selected';
    return;
  }

  let connectedCount = 0;
  let pendingCount = 0;

  for (const targetUsername of currentReceiverUsernames) {
    const status = targetStatuses[targetUsername] || { targetUsername, pending: true, connected: false };
    const chip = document.createElement('div');
    let className = 'pending';
    let label = 'Checking';

    if (status.connected) {
      connectedCount += 1;
      className = 'connected';
      label = status.targetDeviceName || 'Connected';
    } else if (status.pending) {
      pendingCount += 1;
    } else {
      className = 'disconnected';
      label = 'Sending';
    }

    chip.className = `receiver-chip ${className}`;
    chip.textContent = `${targetUsername} - ${label}`;
    receiverList.appendChild(chip);
  }

  if (connectedCount === currentReceiverUsernames.length) {
    receiverStatus.textContent = `All ${connectedCount} receivers connected`;
  } else if (connectedCount > 0) {
    receiverStatus.textContent = `${connectedCount}/${currentReceiverUsernames.length} receivers connected`;
  } else if (pendingCount > 0) {
    receiverStatus.textContent = `Checking ${pendingCount} receiver${pendingCount === 1 ? '' : 's'}...`;
  } else {
    receiverStatus.textContent = `Sending to ${currentReceiverUsernames.length} receiver${currentReceiverUsernames.length === 1 ? '' : 's'}`;
  }
}

function handleTabSend(type) {
  if (!currentReceiverUsernames.length) {
    alert('Add at least one receiver username first.');
    return;
  }

  chrome.runtime.sendMessage({ type }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Error sending tab handoff:', chrome.runtime.lastError.message);
      alert('Failed to send tab handoff.');
      return;
    }

    if (!response?.success) {
      alert(response?.error || 'Failed to send tab handoff.');
      return;
    }

    const label = type === 'send_active_tab_handoff' ? 'Active tab sent' : `${response.tabCount || 0} tabs sent`;
    addActivity('tab', `${label} to ${currentReceiverUsernames.join(', ')}`);
  });
}

// Handle setting changes
function handleSettingChange() {
  const settings = {
    smartHandoff: smartHandoffToggle.checked,
    universalClipboard: clipboardToggle.checked,
    notifications: notificationsToggle.checked
  };
  
  chrome.storage.local.set({ settings }, () => {
    console.log('Settings saved:', settings);
  });
}

// Update connection status
function updateConnectionStatus(connected) {
  isConnected = connected;
  
  if (connected) {
    statusDot.className = 'status-dot connected';
    statusText.textContent = 'Connected';
    console.log('✅ Extension connected to backend');
    if (currentUsername) {
      console.log('👤 Username:', currentUsername);
    }
  } else {
    statusDot.className = 'status-dot disconnected';
    statusText.textContent = 'Disconnected';
    console.log('❌ Extension disconnected from backend');
  }
}

// Show auth screen (login/signup)
function showAuthScreen() {
  const authScreen = document.getElementById('authScreen');
  setupScreen.style.display = 'none';
  mainScreen.style.display = 'none';
  if (authScreen) {
    authScreen.style.display = 'block';
    // Wire up auth button
    const btn = document.getElementById('extAuthBtn');
    if (btn && !btn._wired) {
      btn._wired = true;
      btn.addEventListener('click', handleExtAuth);
      document.getElementById('extIdentifier').addEventListener('keypress', e => { if (e.key === 'Enter') handleExtAuth(); });
      document.getElementById('extPassword').addEventListener('keypress', e => { if (e.key === 'Enter') handleExtAuth(); });
    }
  } else {
    showSetupScreen();
  }
}

// Show setup screen
function showSetupScreen() {
  setupScreen.style.display = 'block';
  mainScreen.style.display = 'none';
  usernameInput.focus();
}

// Show main screen
function showMainScreen() {
  setupScreen.style.display = 'none';
  mainScreen.style.display = 'block';
}

// Add activity item (for future use)
function addActivity(type, message) {
  const empty = activityList.querySelector('.activity-empty');
  if (empty) {
    empty.remove();
  }
  
  const item = document.createElement('div');
  item.className = 'activity-item';
  
  const icon = document.createElement('div');
  icon.className = 'activity-icon';
  icon.textContent = type === 'media' ? '🎬' : type === 'tab' ? '🪟' : '📋';
  
  const text = document.createElement('div');
  text.className = 'activity-text';
  text.textContent = message;
  
  const time = document.createElement('div');
  time.className = 'activity-time';
  time.textContent = 'Just now';
  
  item.appendChild(icon);
  item.appendChild(text);
  item.appendChild(time);
  
  activityList.insertBefore(item, activityList.firstChild);
  
  // Keep only last 5 items
  while (activityList.children.length > 5) {
    activityList.removeChild(activityList.lastChild);
  }
}
