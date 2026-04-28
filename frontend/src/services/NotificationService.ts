import { NotificationAction } from '@shared/types';

export interface ToastNotification {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message: string;
  duration?: number;
  actions?: NotificationAction[];
  onAction?: (actionId: string) => void;
}

/**
 * Notification Service for Web
 * 
 * Handles toast notifications, session invitations, and nearby device notifications
 */
export default class NotificationService {
  private notifications: Map<string, ToastNotification> = new Map();
  private container: HTMLElement | null = null;
  private onActionCallback?: (notificationId: string, actionId: string) => void;

  constructor(onAction?: (notificationId: string, actionId: string) => void) {
    this.onActionCallback = onAction;
    this.createContainer();
  }

  private createContainer() {
    this.container = document.createElement('div');
    this.container.id = 'notification-container';
    this.container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 400px;
      pointer-events: none;
    `;
    document.body.appendChild(this.container);
  }

  /**
   * Show a toast notification
   * CRITICAL: Check if notifications permission is enabled before showing
   */
  showToast(notification: Omit<ToastNotification, 'id'>): string {
    // Check if notifications are enabled
    const permEngine = (window as any).permissionEngine;
    if (permEngine && !permEngine.hasSystemPermission('notifications')) {
      console.log('Notifications disabled - toast blocked:', notification.title);
      return ''; // Don't show notification if permission is disabled
    }

    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const toast: ToastNotification = {
      id,
      duration: 5000,
      ...notification,
    };

    this.notifications.set(id, toast);
    this.renderToast(toast);

    // Auto-dismiss after duration
    if (toast.duration && toast.duration > 0) {
      setTimeout(() => {
        this.dismissToast(id);
      }, toast.duration);
    }

    return id;
  }

  /**
   * Show session invitation notification
   */
  showSessionInvitation(data: {
    inviterUsername: string;
    inviterDeviceName: string;
    sessionCode: string;
    sessionId: string;
  }): string {
    return this.showToast({
      type: 'info',
      title: 'Session Invitation',
      message: `${data.inviterUsername} (${data.inviterDeviceName}) invited you to join their session`,
      duration: 0, // Don't auto-dismiss
      actions: [
        { id: 'accept', label: 'Accept', action: 'accept' },
        { id: 'reject', label: 'Reject', action: 'reject' },
      ],
      onAction: (actionId) => {
        this.onActionCallback?.(data.sessionId, actionId);
      },
    });
  }

  /**
   * Show nearby session notification
   */
  showNearbySession(data: {
    creatorUsername: string;
    creatorDeviceName: string;
    sessionCode: string;
    sessionId: string;
    deviceCount: number;
  }): string {
    return this.showToast({
      type: 'info',
      title: 'Nearby Session Found',
      message: `${data.creatorUsername} created a session with ${data.deviceCount} device(s). Would you like to join?`,
      duration: 10000, // 10 seconds
      actions: [
        { id: 'join', label: 'Join Session', action: 'join' },
        { id: 'dismiss', label: 'Dismiss', action: 'dismiss' },
      ],
      onAction: (actionId) => {
        this.onActionCallback?.(data.sessionId, actionId);
      },
    });
  }

  /**
   * Show device joined notification
   */
  showDeviceJoined(username: string, deviceName: string): string {
    return this.showToast({
      type: 'success',
      title: 'Device Joined',
      message: `${username} (${deviceName}) joined the session`,
      duration: 3000,
    });
  }

  /**
   * Show file received notification
   */
  showFileReceived(filename: string, senderUsername: string): string {
    return this.showToast({
      type: 'success',
      title: 'File Received',
      message: `Received "${filename}" from ${senderUsername}`,
      duration: 4000,
    });
  }

  /**
   * Dismiss a toast notification
   */
  dismissToast(id: string) {
    const notification = this.notifications.get(id);
    if (!notification) return;

    const element = document.getElementById(`toast-${id}`);
    if (element) {
      element.style.animation = 'toastSlideOut 0.3s ease-in forwards';
      setTimeout(() => {
        element.remove();
      }, 300);
    }

    this.notifications.delete(id);
  }

  /**
   * Clear all notifications
   */
  clearAll() {
    this.notifications.forEach((_, id) => {
      this.dismissToast(id);
    });
  }

  private renderToast(toast: ToastNotification) {
    if (!this.container) return;

    const element = document.createElement('div');
    element.id = `toast-${toast.id}`;
    element.style.cssText = `
      background: white;
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      border-left: 4px solid ${this.getTypeColor(toast.type)};
      pointer-events: auto;
      animation: toastSlideIn 0.3s ease-out;
      max-width: 100%;
    `;
    
    element.innerHTML = `
      <div style="display: flex; align-items: flex-start; gap: 12px;">
        <div style="flex: 1;">
          <div style="font-weight: 600; color: #333; margin-bottom: 4px; font-size: 14px;">
            ${toast.title}
          </div>
          <div style="color: #666; font-size: 13px; line-height: 1.4;">
            ${toast.message}
          </div>
          ${toast.actions && toast.actions.length > 0 ? `
            <div style="margin-top: 12px; display: flex; gap: 8px;">
              ${toast.actions.map(action => `
                <button 
                  onclick="window.handleToastAction('${toast.id}', '${action.id}')"
                  style="
                    background: ${action.action === 'accept' || action.action === 'join' ? '#007bff' : '#6c757d'};
                    color: white;
                    border: none;
                    padding: 6px 12px;
                    border-radius: 4px;
                    font-size: 12px;
                    cursor: pointer;
                    font-weight: 500;
                  "
                >
                  ${action.label}
                </button>
              `).join('')}
            </div>
          ` : ''}
        </div>
        <button 
          onclick="window.dismissToast('${toast.id}')"
          style="
            background: none;
            border: none;
            color: #999;
            cursor: pointer;
            font-size: 18px;
            line-height: 1;
            padding: 0;
            width: 20px;
            height: 20px;
          "
        >
          ×
        </button>
      </div>
    `;

    this.container.appendChild(element);

    // Add global handlers
    (window as any).dismissToast = (id: string) => this.dismissToast(id);
    (window as any).handleToastAction = (toastId: string, actionId: string) => {
      const notification = this.notifications.get(toastId);
      if (notification?.onAction) {
        notification.onAction(actionId);
      }
      this.dismissToast(toastId);
    };

    // Add CSS animations if not already added
    if (!document.getElementById('toast-animations')) {
      const style = document.createElement('style');
      style.id = 'toast-animations';
      style.textContent = `
        @keyframes toastSlideIn {
          from {
            opacity: 0;
            transform: translateX(100%);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        @keyframes toastSlideOut {
          from {
            opacity: 1;
            transform: translateX(0);
          }
          to {
            opacity: 0;
            transform: translateX(100%);
          }
        }
      `;
      document.head.appendChild(style);
    }
  }

  private getTypeColor(type: ToastNotification['type']): string {
    switch (type) {
      case 'success': return '#28a745';
      case 'error': return '#dc3545';
      case 'warning': return '#ffc107';
      case 'info': return '#007bff';
      default: return '#6c757d';
    }
  }
}