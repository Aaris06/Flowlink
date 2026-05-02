/**
 * FriendService — manages friend requests, accepted friends, and SOS alerts.
 * All data is namespaced by username so different users on the same browser
 * see only their own friends, inbox, and sent requests.
 */

export interface Friend {
  username: string;
  deviceId?: string;
  addedAt: number;
}

export interface FriendRequest {
  id: string;
  fromUsername: string;
  fromDeviceId: string;
  toUsername: string;
  status: 'pending' | 'accepted' | 'rejected';
  sentAt: number;
}

export interface SosAlert {
  fromUsername: string;
  fromDeviceId: string;
  lat?: number;
  lng?: number;
  address?: string;
  sentAt: number;
}

type Listener<T> = (data: T) => void;

class FriendService {
  private listeners: Map<string, Listener<any>[]> = new Map();

  // ── Username-scoped key helpers ───────────────────────────────────────────
  private currentUser(): string {
    return (localStorage.getItem('flowlink_username') || '').toLowerCase().trim();
  }

  private key(suffix: string): string {
    const u = this.currentUser();
    return u ? `fl_${u}_${suffix}` : `fl_${suffix}`;
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  getFriends(): Friend[] {
    try { return JSON.parse(localStorage.getItem(this.key('friends')) || '[]'); } catch { return []; }
  }
  saveFriends(friends: Friend[]) {
    localStorage.setItem(this.key('friends'), JSON.stringify(friends));
    this.emit('friends_changed', friends);
  }

  getInbox(): FriendRequest[] {
    try { return JSON.parse(localStorage.getItem(this.key('inbox')) || '[]'); } catch { return []; }
  }
  saveInbox(inbox: FriendRequest[]) {
    localStorage.setItem(this.key('inbox'), JSON.stringify(inbox));
    this.emit('inbox_changed', inbox);
  }

  getSentRequests(): FriendRequest[] {
    try { return JSON.parse(localStorage.getItem(this.key('sent')) || '[]'); } catch { return []; }
  }
  saveSentRequests(sent: FriendRequest[]) {
    localStorage.setItem(this.key('sent'), JSON.stringify(sent));
    this.emit('sent_changed', sent);
  }

  isFriend(username: string): boolean {
    return this.getFriends().some(f => f.username.toLowerCase() === username.toLowerCase());
  }

  hasPendingSentRequest(toUsername: string): boolean {
    return this.getSentRequests().some(
      r => r.toUsername.toLowerCase() === toUsername.toLowerCase() && r.status === 'pending'
    );
  }

  // ── WebSocket actions ─────────────────────────────────────────────────────
  sendFriendRequest(myUsername: string, myDeviceId: string, toUsername: string, sessionId?: string) {
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const req: FriendRequest = {
      id: `fr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fromUsername: myUsername,
      fromDeviceId: myDeviceId,
      toUsername,
      status: 'pending',
      sentAt: Date.now(),
    };

    ws.send(JSON.stringify({
      type: 'friend_request',
      sessionId,
      deviceId: myDeviceId,
      payload: { toUsername, fromUsername: myUsername, fromDeviceId: myDeviceId, requestId: req.id },
      timestamp: Date.now(),
    }));

    const sent = this.getSentRequests();
    sent.push(req);
    this.saveSentRequests(sent);
  }

  respondToRequest(req: FriendRequest, accepted: boolean, myDeviceId: string, sessionId?: string) {
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      type: 'friend_request_response',
      sessionId,
      deviceId: myDeviceId,
      payload: {
        requestId: req.id,
        toUsername: req.fromUsername,
        toDeviceId: req.fromDeviceId,
        fromUsername: req.toUsername,
        accepted,
      },
      timestamp: Date.now(),
    }));

    const inbox = this.getInbox().map(r =>
      r.id === req.id
        ? { ...r, status: (accepted ? 'accepted' : 'rejected') as 'accepted' | 'rejected' }
        : r
    );
    this.saveInbox(inbox);

    if (accepted) {
      const friends = this.getFriends();
      if (!this.isFriend(req.fromUsername)) {
        friends.push({ username: req.fromUsername, deviceId: req.fromDeviceId, addedAt: Date.now() });
        this.saveFriends(friends);
      }
    }
  }

  sendSos(myUsername: string, myDeviceId: string, sessionId?: string) {
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const sendAlert = (lat?: number, lng?: number, address?: string) => {
      const friends = this.getFriends();
      friends.forEach(f => {
        ws.send(JSON.stringify({
          type: 'sos_alert',
          sessionId,
          deviceId: myDeviceId,
          payload: {
            fromUsername: myUsername, fromDeviceId: myDeviceId,
            toUsername: f.username, targetDeviceId: f.deviceId,
            lat, lng, address, sentAt: Date.now(),
          },
          timestamp: Date.now(),
        }));
      });
      if (sessionId) {
        ws.send(JSON.stringify({
          type: 'sos_alert',
          sessionId,
          deviceId: myDeviceId,
          payload: { fromUsername: myUsername, fromDeviceId: myDeviceId, lat, lng, address, sentAt: Date.now() },
          timestamp: Date.now(),
        }));
      }
    };

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => sendAlert(pos.coords.latitude, pos.coords.longitude),
        () => sendAlert(),
        { timeout: 5000 }
      );
    } else {
      sendAlert();
    }
  }

  // ── Incoming message handler ──────────────────────────────────────────────
  handleIncoming(message: any, myUsername: string, _myDeviceId: string) {
    if (message.type === 'friend_request') {
      const p = message.payload;
      if (!p?.fromUsername) return;
      const me = myUsername || localStorage.getItem('flowlink_username') || '';
      if (p.fromUsername.toLowerCase() === me.toLowerCase()) return;
      const inbox = this.getInbox();
      if (inbox.some(r =>
        r.fromUsername.toLowerCase() === p.fromUsername.toLowerCase() && r.status === 'pending'
      )) return;
      const req: FriendRequest = {
        id: p.requestId || `fr-${Date.now()}`,
        fromUsername: p.fromUsername,
        fromDeviceId: p.fromDeviceId || message.deviceId || '',
        toUsername: me,
        status: 'pending',
        sentAt: message.timestamp || Date.now(),
      };
      inbox.push(req);
      this.saveInbox(inbox);
      this.emit('friend_request_received', req);
    }

    if (message.type === 'friend_request_response') {
      const p = message.payload;
      if (p.accepted) {
        const friends = this.getFriends();
        if (!this.isFriend(p.fromUsername)) {
          friends.push({ username: p.fromUsername, deviceId: message.deviceId || '', addedAt: Date.now() });
          this.saveFriends(friends);
        }
        const sent = this.getSentRequests().map(r =>
          r.toUsername.toLowerCase() === p.fromUsername.toLowerCase()
            ? { ...r, status: 'accepted' as const } : r
        );
        this.saveSentRequests(sent);
        this.emit('friend_accepted', { username: p.fromUsername });
      } else {
        const sent = this.getSentRequests().map(r =>
          r.toUsername.toLowerCase() === p.fromUsername.toLowerCase()
            ? { ...r, status: 'rejected' as const } : r
        );
        this.saveSentRequests(sent);
        this.emit('friend_rejected', { username: p.fromUsername });
      }
    }

    if (message.type === 'sos_alert') {
      const p = message.payload;
      this.emit('sos_received', {
        fromUsername: p.fromUsername,
        fromDeviceId: p.fromDeviceId || message.deviceId || '',
        lat: p.lat, lng: p.lng, address: p.address,
        sentAt: p.sentAt || Date.now(),
      } as SosAlert);
    }
  }

  // ── Event emitter ─────────────────────────────────────────────────────────
  on<T>(event: string, listener: Listener<T>) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener);
    return () => this.off(event, listener);
  }

  off(event: string, listener: Listener<any>) {
    const arr = this.listeners.get(event) || [];
    this.listeners.set(event, arr.filter(l => l !== listener));
  }

  private emit(event: string, data: any) {
    (this.listeners.get(event) || []).forEach(l => l(data));
  }
}

export const friendService = new FriendService();
