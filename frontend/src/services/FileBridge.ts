import WebRTCManager from './WebRTCManager';

/**
 * File Bridge
 * 
 * Handles file transfer between devices:
 * - Browse remote filesystem (sandboxed)
 * - Upload/download files
 * - Chunked transfer for large files
 * - Progress tracking
 * - Cancellation support
 */
export default class FileBridge {
  private webrtcManager: WebRTCManager;
  private activeTransfers: Map<string, FileTransfer> = new Map();
  private readonly CHUNK_SIZE = 64 * 1024; // 64KB chunks
  // Allow up to 4 MB unacked — the WS backpressure in WebRTCManager already
  // caps the actual network queue. The old 1 MB window was too tight and would
  // permanently stall when acks were delayed by even a few hundred ms on slower
  // connections (laptop → mobile / laptop → laptop).
  private readonly MAX_UNACKED_BYTES = 4 * 1024 * 1024; // 4MB in-flight window
  // If no ack arrives within this many milliseconds, stop waiting and continue
  // regardless. This prevents a permanent stall if an ack is lost in transit.
  private readonly ACK_TIMEOUT_MS = 10_000; // 10 seconds

  constructor(webrtcManager: WebRTCManager) {
    this.webrtcManager = webrtcManager;
  }

  /**
   * Send file to target device.
   * Progress is reported to the caller via incoming file_transfer_ack messages
   * (handled in DeviceTiles / MyDevicesPage), not by this method directly.
   * This avoids the "oscillating progress" bug where sender-queued bytes and
   * receiver-confirmed bytes would overwrite each other in the UI.
   */
  async sendFile(
    file: File,
    targetDeviceId: string
  ): Promise<void> {
    const transferId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const transfer: FileTransfer = {
      id: transferId,
      file,
      targetDeviceId,
      totalSize: file.size,
      transferred: 0,
      acknowledged: 0,
      cancelled: false,
      startedAt: Date.now(),
    };

    this.activeTransfers.set(transferId, transfer);

    // Announce transfer start first
    await this.webrtcManager.sendRawMessageViaWebSocket(JSON.stringify({
      type: 'file_transfer_start',
      payload: {
        transferId,
        fileName: file.name,
        fileType: file.type,
        totalBytes: file.size,
        targetDevice: targetDeviceId,
        sourceDevice: '',
      },
      timestamp: Date.now(),
    }));

    // Transfer file in chunks via WebRTC data channel
    await this.transferFileChunks(transfer);
  }

  /**
   * Transfer file in chunks
   */
  private async transferFileChunks(transfer: FileTransfer): Promise<void> {
    const reader = new FileReader();
    let offset = 0;
    let chunkIndex = 0;

    return new Promise((resolve, reject) => {
      reader.onload = async (e) => {
        if (transfer.cancelled) {
          reject(new Error('Transfer cancelled'));
          return;
        }

        const chunk = e.target?.result as ArrayBuffer;
        const chunkBytes = new Uint8Array(chunk);
        const chunkBase64 = this.bytesToBase64(chunkBytes);
        
        // Send chunk via WebRTC
        try {
          await this.waitForAckWindow(transfer);
          // Keep the UI thread and socket producer from overwhelming mobile receivers.
          if (chunkIndex > 0 && chunkIndex % 8 === 0) {
            await new Promise((resolve) => window.setTimeout(resolve, 1));
          }
          await this.sendChunk(transfer.id, chunkIndex, chunkBase64, transfer.targetDeviceId, transfer.file.name, transfer.file.type, transfer.totalSize);
          
          transfer.transferred += chunk.byteLength;
          // NOTE: We deliberately do NOT emit per-chunk progress here.
          // The sender's UI is driven entirely by incoming file_transfer_ack messages
          // (DeviceTiles case 'file_transfer_ack'), which reflect bytes the *receiver*
          // has actually confirmed.  Emitting from here too caused the "jumping progress"
          // bug: chunks pushed into the WS buffer raced ahead of receiver acks, so the
          // display would oscillate (e.g. 8 MB → 5 MB → 8 MB) as the two sources
          // alternated overwriting each other.

          offset += chunk.byteLength;
          chunkIndex++;

          if (offset < transfer.totalSize) {
            // Read next chunk
            const nextChunk = file.slice(offset, offset + this.CHUNK_SIZE);
            reader.readAsArrayBuffer(nextChunk);
          } else {
            // Transfer complete — the final file_transfer_complete message triggers
            // a 100% ack from the receiver which will update the UI on the sender side.
            await this.sendTransferComplete(transfer.id, transfer.targetDeviceId, transfer.file.name);
            this.activeTransfers.delete(transfer.id);
            resolve();
          }
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = () => {
        reject(new Error('Failed to read file chunk'));
      };

      // Start reading first chunk
      const file = transfer.file;
      const firstChunk = file.slice(0, this.CHUNK_SIZE);
      reader.readAsArrayBuffer(firstChunk);
    });
  }

  private async waitForAckWindow(transfer: FileTransfer): Promise<void> {
    if ((transfer.transferred - transfer.acknowledged) <= this.MAX_UNACKED_BYTES) return;

    // Wait for receiver acks, but never stall forever — if no ack arrives within
    // ACK_TIMEOUT_MS we continue anyway. This handles cases where the ack path is
    // lossy (e.g., laptop → mobile over a flaky WiFi connection).
    const deadline = Date.now() + this.ACK_TIMEOUT_MS;
    while (
      !transfer.cancelled &&
      (transfer.transferred - transfer.acknowledged) > this.MAX_UNACKED_BYTES &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 12));
    }
    if (transfer.cancelled) {
      throw new Error('Transfer cancelled');
    }
    // If we timed out, reset acknowledged to current transferred so the window
    // re-opens and the transfer can continue rather than freezing indefinitely.
    if ((transfer.transferred - transfer.acknowledged) > this.MAX_UNACKED_BYTES) {
      transfer.acknowledged = transfer.transferred;
    }
  }

  /**
   * Send a file chunk via WebRTC
   */
  private async sendChunk(
    _transferId: string,
    _chunkIndex: number,
    chunkBase64: string,
    targetDeviceId: string,
    fileName: string,
    fileType: string,
    totalSize: number
  ): Promise<void> {
    await this.webrtcManager.sendRawMessageViaWebSocket(JSON.stringify({
      type: 'file_transfer_chunk',
      payload: {
        transferId: _transferId,
        chunkIndex: _chunkIndex,
        data: chunkBase64,
        fileName,
        fileType,
        totalBytes: totalSize,
        targetDevice: targetDeviceId,
        sourceDevice: '',
      },
      timestamp: Date.now(),
    }));
  }

  /**
   * Send transfer complete notification
   */
  private async sendTransferComplete(
    _transferId: string,
    targetDeviceId: string,
    fileName: string
  ): Promise<void> {
    await this.webrtcManager.sendRawMessageViaWebSocket(JSON.stringify({
      type: 'file_transfer_complete',
      payload: {
        transferId: _transferId,
        fileName,
        targetDevice: targetDeviceId,
        sourceDevice: '',
      },
      timestamp: Date.now(),
    }));
  }

  private bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Cancel active transfer
   */
  cancelTransfer(transferId: string): void {
    const transfer = this.activeTransfers.get(transferId);
    if (transfer) {
      transfer.cancelled = true;
      this.activeTransfers.delete(transferId);
    }
  }

  handleTransferAck(transferId: string, transferredBytes: number, completed = false): void {
    const transfer = this.activeTransfers.get(transferId);
    if (!transfer) return;
    transfer.acknowledged = Math.max(transfer.acknowledged, transferredBytes);
    if (completed) {
      transfer.acknowledged = transfer.totalSize;
    }
  }

  async cancelAllActiveTransfers(reason = 'session_left'): Promise<void> {
    const transfers = Array.from(this.activeTransfers.values());
    for (const transfer of transfers) {
      transfer.cancelled = true;
      await this.webrtcManager.sendRawMessageViaWebSocket(JSON.stringify({
        type: 'file_transfer_cancel',
        payload: {
          transferId: transfer.id,
          targetDevice: transfer.targetDeviceId,
          reason,
        },
        timestamp: Date.now(),
      }));
      this.activeTransfers.delete(transfer.id);
    }
  }

  /**
   * Browse remote device filesystem (sandboxed)
   */
  async browseRemoteFilesystem(
    _targetDeviceId: string,
    _path: string = '/'
  ): Promise<FileSystemEntry[]> {
    // Request file listing from remote device
    // This would require a dedicated API on the device agent
    // For MVP, return empty array
    return [];
  }
}

interface FileTransfer {
  id: string;
  file: File;
  targetDeviceId: string;
  totalSize: number;
  transferred: number;
  acknowledged: number;
  cancelled: boolean;
  startedAt: number;
}

interface TransferStats {
  fileName: string;
  direction: 'sending' | 'receiving';
  progress: number;
  totalBytes: number;
  transferredBytes: number;
  speedBytesPerSec: number;
  etaSeconds: number;
  startedAt: number;
  completed: boolean;
}

interface FileSystemEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
}

