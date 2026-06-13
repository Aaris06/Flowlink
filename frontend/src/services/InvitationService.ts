import { Intent } from '@shared/types';
import NotificationService from './NotificationService';

export interface InvitationData {
  sessionId: string;
  sessionCode: string;
  inviterUsername: string;
  inviterDeviceName: string;
  message?: string;
}

/**
 * Invitation Service for Web
 * 
 * Handles sending and receiving session invitations
 */
export default class InvitationService {
  private ws: WebSocket | null = null;
  private deviceId: string;
  private username: string;
  private deviceName: string;
  public notificationService: NotificationService;
  private onInvitationAccepted?: (sessionCode: string) => void;

  constructor(
    deviceId: string,
    username: string,
    deviceName: string,
    onInvitationAccepted?: (sessionCode: string) => void
  ) {
    this.deviceId = deviceId;
    this.username = username;
    this.deviceName = deviceName;
    this.onInvitationAccepted = onInvitationAccepted;
    
    this.notificationService = new NotificationService((sessionId, actionId) => {
      this.handleNotificationAction(sessionId, actionId);
    });
  }

  /**
   * Set WebSocket connection for sending invitations
   */
  setWebSocket(ws: WebSocket) {
    this.ws = ws;
    console.log('InvitationService: WebSocket set, readyState:', ws.readyState);
  }

  /**
   * Send invitation to a user (by username or device ID)
   */
  async sendInvitation(
    targetIdentifier: string, // username or device ID
    sessionId: string,
    sessionCode: string,
    message?: string
  ): Promise<void> {
    console.log('InvitationService: Attempting to send invitation');
    console.log('  WebSocket state:', this.ws?.readyState);
    console.log('  Target:', targetIdentifier);
    console.log('  Session:', sessionId);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('InvitationService: WebSocket not connected, trying global WebSocket');
      
      // Fallback to global WebSocket
      const globalWs = (window as any).appWebSocket;
      if (!globalWs || globalWs.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket not connected');
      }
      
      // Use global WebSocket
      this.ws = globalWs;
      console.log('InvitationService: Using global WebSocket');
    }

    const invitation: Intent = {
      intent_type: 'session_invitation',
      payload: {
        invitation: {
          sessionId,
          sessionCode,
          inviterUsername: this.username,
          inviterDeviceName: this.deviceName,
          message,
        },
      },
      target_device: targetIdentifier,
      source_device: this.deviceId,
      auto_open: false,
      timestamp: Date.now(),
    };

    console.log('InvitationService: Sending invitation message');
    this.ws!.send(JSON.stringify({
      type: 'session_invitation',
      sessionId,
      deviceId: this.deviceId,
      payload: {
        targetIdentifier,
        invitation: invitation.payload.invitation,
      },
      timestamp: Date.now(),
    }));

    console.log('InvitationService: Invitation sent successfully');
  }

  /**
   * Handle incoming invitation
   */
  handleIncomingInvitation(data: InvitationData) {
    this.notificationService.showSessionInvitation(data);
  }

  /**
   * Handle nearby session notification
   */
  handleNearbySession(data: {
    sessionId: string;
    sessionCode: string;
    creatorUsername: string;
    creatorDeviceName: string;
    deviceCount: number;
  }) {
    this.notificationService.showNearbySession(data);
  }

  /**
   * Handle notification actions (accept, reject, join, dismiss)
   */
  private handleNotificationAction(sessionId: string, actionId: string) {
    switch (actionId) {
      case 'accept':
        this.acceptInvitation(sessionId);
        break;
      case 'reject':
        this.rejectInvitation(sessionId);
        break;
      case 'join':
        this.joinNearbySession(sessionId);
        break;
      case 'dismiss':
        // Just dismiss the notification
        break;
    }
  }

  /**
   * Accept a session invitation
   */
  private acceptInvitation(sessionId: string) {
    if (!this.ws) return;

    // Send acceptance response
    this.ws.send(JSON.stringify({
      type: 'invitation_response',
      sessionId,
      deviceId: this.deviceId,
      payload: {
        accepted: true,
        inviteeUsername: this.username,
        inviteeDeviceName: this.deviceName,
      },
      timestamp: Date.now(),
    }));

    // Get session code from stored invitations or prompt user
    const sessionCode = this.getSessionCodeForInvitation(sessionId);
    if (sessionCode && this.onInvitationAccepted) {
      this.onInvitationAccepted(sessionCode);
    }
  }

  /**
   * Reject a session invitation
   */
  private rejectInvitation(sessionId: string) {
    if (!this.ws) return;

    this.ws.send(JSON.stringify({
      type: 'invitation_response',
      sessionId,
      deviceId: this.deviceId,
      payload: {
        accepted: false,
        inviteeUsername: this.username,
        inviteeDeviceName: this.deviceName,
      },
      timestamp: Date.now(),
    }));

    this.notificationService.showToast({
      type: 'info',
      title: 'Invitation Rejected',
      message: 'You rejected the session invitation',
      duration: 2000,
    });
  }

  /**
   * Join a nearby session
   */
  private joinNearbySession(sessionId: string) {
    const sessionCode = this.getSessionCodeForInvitation(sessionId);
    if (sessionCode && this.onInvitationAccepted) {
      this.onInvitationAccepted(sessionCode);
    }
  }

  /**
   * Get session code for invitation (stored temporarily)
   */
  private getSessionCodeForInvitation(sessionId: string): string | null {
    // In a real implementation, you'd store invitation data temporarily
    // For now, we'll use sessionStorage
    return sessionStorage.getItem(`invitation_${sessionId}`);
  }

  /**
   * Store invitation data temporarily
   */
  storeInvitationData(sessionId: string, sessionCode: string) {
    sessionStorage.setItem(`invitation_${sessionId}`, sessionCode);
    // Clean up after 10 minutes
    setTimeout(() => {
      sessionStorage.removeItem(`invitation_${sessionId}`);
    }, 10 * 60 * 1000);
  }

  /**
   * Show device joined notification
   */
  showDeviceJoined(username: string, deviceName: string) {
    this.notificationService.showDeviceJoined(username, deviceName);
  }

  /**
   * Show file received notification
   */
  showFileReceived(filename: string, senderUsername: string) {
    this.notificationService.showFileReceived(filename, senderUsername);
  }

  /**
   * Clear all notifications
   */
  clearNotifications() {
    this.notificationService.clearAll();
  }
}