/**
 * Peer Discovery Interfaces
 *
 * Defines the contract for discovering peers in a groupcache cluster.
 * Implementations include static, Kubernetes, DNS, and Consul.
 */

import type { PeerInfo } from '../types.js';

/**
 * Event emitter interface for peer changes
 */
export interface PeerDiscoveryEvents {
  /** Emitted when peer list changes */
  peersChanged: (peers: PeerInfo[]) => void;
  /** Emitted on discovery errors */
  error: (error: Error) => void;
}

/**
 * Peer discovery interface
 */
export interface PeerDiscovery {
  /**
   * Start discovering peers
   */
  start(): Promise<void>;

  /**
   * Stop discovering peers
   */
  stop(): Promise<void>;

  /**
   * Get current list of peers
   */
  getPeers(): PeerInfo[];

  /**
   * Set the address of the current instance (self)
   */
  setSelf(address: string): void;

  /**
   * Register a callback for peer changes
   */
  onPeersChanged(callback: (peers: PeerInfo[]) => void): void;

  /**
   * Remove a callback for peer changes
   */
  offPeersChanged(callback: (peers: PeerInfo[]) => void): void;

  /**
   * Register a callback for errors
   */
  onError(callback: (error: Error) => void): void;
}

/**
 * Base class for peer discovery implementations
 */
export abstract class BasePeerDiscovery implements PeerDiscovery {
  protected peers: PeerInfo[] = [];
  protected selfAddress: string | undefined;
  protected changeCallbacks: Set<(peers: PeerInfo[]) => void> = new Set();
  protected errorCallbacks: Set<(error: Error) => void> = new Set();
  protected started = false;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  getPeers(): PeerInfo[] {
    return [...this.peers];
  }

  setSelf(address: string): void {
    this.selfAddress = address;
    // Update isSelf flag on existing peers
    this.updateSelfFlag();
  }

  onPeersChanged(callback: (peers: PeerInfo[]) => void): void {
    this.changeCallbacks.add(callback);
  }

  offPeersChanged(callback: (peers: PeerInfo[]) => void): void {
    this.changeCallbacks.delete(callback);
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.add(callback);
  }

  /**
   * Update the peer list and notify callbacks
   */
  protected setPeers(peers: PeerInfo[]): void {
    // Mark self
    this.peers = peers.map((peer) => ({
      ...peer,
      isSelf: this.selfAddress ? peer.address === this.selfAddress : false,
    }));

    // Notify callbacks
    for (const callback of this.changeCallbacks) {
      try {
        callback(this.getPeers());
      } catch (error) {
        console.error('Error in peer change callback:', error);
      }
    }
  }

  /**
   * Emit an error to registered callbacks
   */
  protected emitError(error: Error): void {
    for (const callback of this.errorCallbacks) {
      try {
        callback(error);
      } catch (e) {
        console.error('Error in error callback:', e);
      }
    }
  }

  /**
   * Update isSelf flag on existing peers
   */
  private updateSelfFlag(): void {
    if (!this.selfAddress) return;

    this.peers = this.peers.map((peer) => ({
      ...peer,
      isSelf: peer.address === this.selfAddress,
    }));

    // Notify callbacks of change
    for (const callback of this.changeCallbacks) {
      try {
        callback(this.getPeers());
      } catch (error) {
        console.error('Error in peer change callback:', error);
      }
    }
  }
}
