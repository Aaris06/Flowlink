import { Intent } from '@shared/types';

/**
 * WebRTC Manager
 * 
 * Handles WebRTC peer connections for P2P data transfer.
 * Falls back to WebSocket if WebRTC is not available.
 */
export default class WebRTCManager {
  private deviceId: string;
  private sessionId: string;
  private ws: WebSocket;
  private peers: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private readonly DEFAULT_MAX_BUFFERED = 4 * 1024 * 1024;
  // Allow up to 2 MB buffered for file chunks before applying WS backpressure.
  // The previous 512 KB limit was too conservative — it introduced artificial
  // pauses that compounded with the ack-window delay and caused stalls on
  // laptop → mobile / laptop → laptop transfers.
  private readonly FILE_CHUNK_MAX_BUFFERED = 2 * 1024 * 1024;

  constructor(ws: WebSocket, deviceId: string, sessionId: string) {
    this.deviceId = deviceId;
    this.sessionId = sessionId;
    this.ws = ws;

    // Listen for WebRTC signaling messages
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type.startsWith('webrtc_')) {
        this.handleSignaling(message);
      }
    });
  }

  /**
   * Send intent to target device
   */
  async sendIntent(intent: Intent): Promise<void> {
    const targetDeviceId = intent.target_device;

    // Try to use WebRTC data channel if available
    const dataChannel = this.dataChannels.get(targetDeviceId);
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify({
        type: 'intent',
        intent,
      }));
      return;
    }

    // Fallback to WebSocket
    console.log('Sending intent via WebSocket:', intent.intent_type, 'to:', targetDeviceId);
    this.ws.send(JSON.stringify({
      type: 'intent_send',
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      payload: {
        intent,
        targetDevice: targetDeviceId,
      },
      timestamp: Date.now(),
    }));
  }

  async sendRawMessage(message: unknown): Promise<void> {
    const serialized = typeof message === 'string' ? message : JSON.stringify(message);

    const targetDeviceId = (() => {
      try {
        const parsed = typeof message === 'string' ? JSON.parse(message) : message as any;
        return parsed?.payload?.targetDevice || parsed?.targetDevice || parsed?.target_device || '';
      } catch {
        return '';
      }
    })();

    const dataChannel = targetDeviceId ? this.dataChannels.get(targetDeviceId) : null;
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(serialized);
      return;
    }

    await this.sendViaWebSocketWithBackpressure(serialized);
  }

  async sendRawMessageViaWebSocket(message: string): Promise<void> {
    try {
      const parsed = JSON.parse(message);
      const maxBufferedAmount =
        parsed?.type === 'file_transfer_chunk'
          ? this.FILE_CHUNK_MAX_BUFFERED
          : this.DEFAULT_MAX_BUFFERED;
      await this.sendViaWebSocketWithBackpressure(JSON.stringify({
        ...parsed,
        sessionId: this.sessionId,
        deviceId: this.deviceId,
      }), maxBufferedAmount);
    } catch {
      await this.sendViaWebSocketWithBackpressure(message);
    }
  }

  private async sendViaWebSocketWithBackpressure(
    serialized: string,
    maxBufferedAmount = this.DEFAULT_MAX_BUFFERED
  ): Promise<void> {
    // Prevent huge buffered writes that can disconnect peers on large transfers.
    while (this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount > maxBufferedAmount) {
      await new Promise((resolve) => window.setTimeout(resolve, 16));
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.ws.send(serialized);
  }

  /**
   * Initiate WebRTC connection with target device
   */
  async connectToDevice(targetDeviceId: string): Promise<void> {
    if (this.peers.has(targetDeviceId)) {
      return; // Already connected
    }

    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        // In production, add TURN servers for NAT traversal
      ],
    });

    // Create data channel
    const dataChannel = peerConnection.createDataChannel('flowlink', {
      ordered: true,
    });

    dataChannel.onopen = () => {
      console.log(`Data channel opened with ${targetDeviceId}`);
      this.dataChannels.set(targetDeviceId, dataChannel);
    };

    dataChannel.onerror = (error) => {
      console.error('Data channel error:', error);
    };

    dataChannel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleDataChannelMessage(message, targetDeviceId);
      } catch (error) {
        console.error('Failed to parse data channel message:', error);
      }
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws.send(JSON.stringify({
          type: 'webrtc_ice_candidate',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          payload: {
            toDevice: targetDeviceId,
            data: event.candidate.toJSON(),
          },
          timestamp: Date.now(),
        }));
      }
    };

    // Create offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    // Send offer via WebSocket
    this.ws.send(JSON.stringify({
      type: 'webrtc_offer',
      sessionId: this.sessionId,
      deviceId: this.deviceId,
      payload: {
        toDevice: targetDeviceId,
        data: offer,
      },
      timestamp: Date.now(),
    }));

    this.peers.set(targetDeviceId, peerConnection);
  }

  /**
   * Handle incoming WebRTC signaling
   */
  private async handleSignaling(message: any): Promise<void> {
    const { fromDevice, toDevice, data } = message.payload;

    if (toDevice !== this.deviceId) {
      return; // Not for us
    }

    let peerConnection = this.peers.get(fromDevice);

    if (message.type === 'webrtc_offer') {
      // Create answer
      if (!peerConnection) {
        peerConnection = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
          ],
        });

        // Set up data channel receiver
        peerConnection.ondatachannel = (event) => {
          const channel = event.channel;
          channel.onopen = () => {
            console.log(`Data channel received from ${fromDevice}`);
            this.dataChannels.set(fromDevice, channel);
          };
          channel.onmessage = (event) => {
            try {
              const message = JSON.parse(event.data);
              this.handleDataChannelMessage(message, fromDevice);
            } catch (error) {
              console.error('Failed to parse data channel message:', error);
            }
          };
        };

        peerConnection.onicecandidate = (event) => {
          if (event.candidate) {
            this.ws.send(JSON.stringify({
              type: 'webrtc_ice_candidate',
              sessionId: this.sessionId,
              deviceId: this.deviceId,
              payload: {
                toDevice: fromDevice,
                data: event.candidate.toJSON(),
              },
              timestamp: Date.now(),
            }));
          }
        };

        this.peers.set(fromDevice, peerConnection);
      }

      await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      this.ws.send(JSON.stringify({
        type: 'webrtc_answer',
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        payload: {
          toDevice: fromDevice,
          data: answer,
        },
        timestamp: Date.now(),
      }));
    } else if (message.type === 'webrtc_answer') {
      if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
      }
    } else if (message.type === 'webrtc_ice_candidate') {
      if (peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data));
      }
    }
  }

  /**
   * Handle messages received via data channel
   */
  private handleDataChannelMessage(message: any, fromDevice: string): void {
    if (message.type === 'intent') {
      // Dispatch intent received event
      window.dispatchEvent(new CustomEvent('intent_received', {
        detail: {
          intent: message.intent,
          sourceDevice: fromDevice,
        },
      }));
    }
  }

  /**
   * Cleanup connections
   */
  cleanup(): void {
    for (const [_deviceId, peer] of this.peers.entries()) {
      peer.close();
    }
    this.peers.clear();
    this.dataChannels.clear();
  }
}

