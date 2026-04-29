import { Group, Intent } from '@shared/types';

export class GroupService {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private deviceId: string | null = null;
  private groups: Map<string, Group> = new Map();
  private listeners: Set<(groups: Group[]) => void> = new Set();

  constructor() {}

  private storageKey(): string {
    return `flowlink_groups_${this.sessionId || 'none'}`;
  }

  private persist(): void {
    try {
      sessionStorage.setItem(this.storageKey(), JSON.stringify(this.getGroups()));
    } catch { /* ignore */ }
  }

  private loadFromStorage(): void {
    try {
      const stored = sessionStorage.getItem(this.storageKey());
      if (stored) {
        const groups: Group[] = JSON.parse(stored);
        groups.forEach(g => this.groups.set(g.id, g));
      }
    } catch { /* ignore */ }
  }

  initialize(ws: WebSocket, sessionId: string, deviceId: string) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.deviceId = deviceId;
    // Restore groups from sessionStorage on re-init (tab switch)
    this.loadFromStorage();
  }

  setGroups(groups: Group[]) {
    this.groups.clear();
    groups.forEach(group => this.groups.set(group.id, group));
    this.persist();
    this.notifyListeners();
  }

  addGroup(group: Group) {
    this.groups.set(group.id, group);
    this.persist();
    this.notifyListeners();
  }

  updateGroup(group: Group) {
    this.groups.set(group.id, group);
    this.persist();
    this.notifyListeners();
  }

  removeGroup(groupId: string) {
    this.groups.delete(groupId);
    this.persist();
    this.notifyListeners();
  }

  getGroups(): Group[] {
    return Array.from(this.groups.values());
  }

  getGroup(groupId: string): Group | undefined {
    return this.groups.get(groupId);
  }

  createGroup(name: string, deviceIds: string[], color?: string) {
    if (!this.ws || !this.sessionId || !this.deviceId) {
      console.error('GroupService not initialized');
      return;
    }

    this.ws.send(JSON.stringify({
      type: 'group_create',
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      payload: { name, deviceIds, color },
      timestamp: Date.now()
    }));
  }

  updateGroupDetails(groupId: string, updates: Partial<Group>) {
    if (!this.ws || !this.sessionId || !this.deviceId) {
      console.error('GroupService not initialized');
      return;
    }

    this.ws.send(JSON.stringify({
      type: 'group_update',
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      payload: { groupId, ...updates },
      timestamp: Date.now()
    }));
  }

  deleteGroup(groupId: string) {
    if (!this.ws || !this.sessionId || !this.deviceId) {
      console.error('GroupService not initialized');
      return;
    }

    this.ws.send(JSON.stringify({
      type: 'group_delete',
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      payload: { groupId },
      timestamp: Date.now()
    }));
  }

  broadcastToGroup(groupId: string, intent: Intent) {
    if (!this.ws || !this.sessionId || !this.deviceId) {
      console.error('GroupService not initialized');
      return;
    }

    console.log(`Broadcasting to group ${groupId}:`, intent);

    this.ws.send(JSON.stringify({
      type: 'group_broadcast',
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      payload: { groupId, intent },
      timestamp: Date.now()
    }));
  }

  subscribe(listener: (groups: Group[]) => void) {
    this.listeners.add(listener);
    listener(this.getGroups());
  }

  unsubscribe(listener: (groups: Group[]) => void) {
    this.listeners.delete(listener);
  }

  private notifyListeners() {
    const groups = this.getGroups();
    this.listeners.forEach(listener => listener(groups));
  }

  cleanup() {
    // Don't clear groups - persist them for when component remounts
    this.listeners.clear();
    this.ws = null;
    // Keep sessionId and deviceId so storageKey() still works
  }
}

export const groupService = new GroupService();
