/**
 * Static Peer Discovery
 *
 * Simple peer discovery that uses a manually configured list of peers.
 * Useful for development, testing, and simple deployments.
 */

import type { PeerInfo } from '../types.js';
import { BasePeerDiscovery } from './interface.js';

/**
 * Options for static peer discovery
 */
export interface StaticPeerDiscoveryOptions {
  /** List of peer addresses */
  peers: (string | PeerInfo)[];
  /** Refresh interval for health checks in milliseconds (0 = disabled) */
  healthCheckInterval?: number;
  /** Health check timeout in milliseconds */
  healthCheckTimeout?: number;
}

/**
 * Static peer discovery using a fixed list of peers
 */
export class StaticPeerDiscovery extends BasePeerDiscovery {
  private readonly initialPeers: PeerInfo[];
  private healthCheckIntervalId: NodeJS.Timeout | null = null;
  private readonly healthCheckInterval: number;
  private readonly healthCheckTimeout: number;

  constructor(options: StaticPeerDiscoveryOptions | (string | PeerInfo)[]) {
    super();

    // Handle array shorthand
    const opts = Array.isArray(options) ? { peers: options } : options;

    this.initialPeers = opts.peers.map((peer) => {
      if (typeof peer === 'string') {
        return { address: peer };
      }
      return peer;
    });

    this.healthCheckInterval = opts.healthCheckInterval ?? 0;
    this.healthCheckTimeout = opts.healthCheckTimeout ?? 2000;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Set initial peers
    this.setPeers(this.initialPeers);

    // Start health check interval if configured
    if (this.healthCheckInterval > 0) {
      this.healthCheckIntervalId = setInterval(
        () => this.performHealthChecks(),
        this.healthCheckInterval
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.healthCheckIntervalId) {
      clearInterval(this.healthCheckIntervalId);
      this.healthCheckIntervalId = null;
    }
  }

  /**
   * Update the peer list
   */
  updatePeers(peers: (string | PeerInfo)[]): void {
    const peerInfos = peers.map((peer) => {
      if (typeof peer === 'string') {
        return { address: peer };
      }
      return peer;
    });

    this.setPeers(peerInfos);
  }

  /**
   * Add a peer to the list
   */
  addPeer(peer: string | PeerInfo): void {
    const peerInfo = typeof peer === 'string' ? { address: peer } : peer;

    // Check if already exists
    if (this.peers.some((p) => p.address === peerInfo.address)) {
      return;
    }

    this.setPeers([...this.peers, peerInfo]);
  }

  /**
   * Remove a peer from the list
   */
  removePeer(address: string): void {
    const filtered = this.peers.filter((p) => p.address !== address);
    if (filtered.length !== this.peers.length) {
      this.setPeers(filtered);
    }
  }

  /**
   * Perform health checks on all peers
   */
  private async performHealthChecks(): Promise<void> {
    const results = await Promise.allSettled(
      this.peers.map(async (peer) => {
        const healthy = await this.checkPeerHealth(peer.address);
        return { ...peer, healthy };
      })
    );

    // Update peer metadata with health status
    const updatedPeers = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return {
          ...this.peers[index]!,
          metadata: {
            ...this.peers[index]!.metadata,
            healthy: result.value.healthy ? 'true' : 'false',
          },
        };
      }
      return {
        ...this.peers[index]!,
        metadata: {
          ...this.peers[index]!.metadata,
          healthy: 'false',
        },
      };
    });

    this.setPeers(updatedPeers);
  }

  /**
   * Check if a peer is healthy
   */
  private async checkPeerHealth(address: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.healthCheckTimeout);

      const url = new URL('/_groupcache/_health', address);
      const response = await fetch(url.toString(), {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }
}
