/**
 * GroupCache - Main Entry Point
 *
 * Orchestrates all components of the distributed cache:
 * - Groups (cache namespaces)
 * - Transport (peer communication)
 * - Discovery (peer discovery)
 * - Consistent hashing (key distribution)
 */

import type {
  Logger,
  PeerInfo,
  InstanceStats,
  HealthStatus,
} from './types.js';
import { parseSize, noopLogger } from './types.js';
import { ConsistentHash } from './hash/consistent.js';
import type { Transport, TransportHandler } from './transport/interface.js';
import { HttpTransport } from './transport/http.js';
import { NotFoundError } from './transport/interface.js';
import type { PeerDiscovery } from './discovery/interface.js';
import { StaticPeerDiscovery } from './discovery/static.js';
import { Group, type GroupOptions } from './group.js';

/**
 * Options for creating a GroupCache instance
 */
export interface GroupCacheOptions {
  /** Address of this instance (e.g., "http://localhost:8080") */
  self: string;

  /** Transport for peer communication (default: HttpTransport) */
  transport?: Transport;

  /** Port to listen on (if using default transport) */
  port?: number;

  /** Peer discovery mechanism */
  discovery?: PeerDiscovery;

  /** Static peer list (alternative to discovery) */
  peers?: string[];

  /** Number of virtual nodes per peer for consistent hashing (default: 150) */
  hashReplicas?: number;

  /** Default TTL for cache entries in milliseconds (default: 0 = no expiration) */
  defaultTtl?: number;

  /** Default max size for groups (default: "64MB") */
  defaultMaxSize?: number | string;

  /** Logger instance */
  logger?: Logger;

  /** Whether to handle SIGTERM/SIGINT for graceful shutdown */
  handleSignals?: boolean;
}

/**
 * Main GroupCache class - creates a distributed cache instance
 */
export class GroupCache {
  private readonly selfAddress: string;
  private readonly transport: Transport;
  private readonly discovery: PeerDiscovery;
  private readonly hashRing: ConsistentHash;
  private readonly groups: Map<string, Group> = new Map();
  private readonly logger: Logger;
  private readonly defaultTtl: number;
  private readonly defaultMaxSize: number;
  private readonly startTime: number;

  private started = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: GroupCacheOptions) {
    this.selfAddress = options.self;
    this.logger = options.logger ?? noopLogger;
    this.defaultTtl = options.defaultTtl ?? 0;
    this.defaultMaxSize = parseSize(options.defaultMaxSize ?? '64MB');
    this.startTime = Date.now();

    // Initialize consistent hash ring
    this.hashRing = new ConsistentHash({
      replicas: options.hashReplicas ?? 150,
    });

    // Initialize transport
    if (options.transport) {
      this.transport = options.transport;
    } else {
      this.transport = new HttpTransport();
    }

    // Initialize discovery
    if (options.discovery) {
      this.discovery = options.discovery;
    } else if (options.peers) {
      this.discovery = new StaticPeerDiscovery(options.peers);
    } else {
      this.discovery = new StaticPeerDiscovery([this.selfAddress]);
    }

    // Set self on discovery
    this.discovery.setSelf(this.selfAddress);

    // Subscribe to peer changes
    this.discovery.onPeersChanged((peers) => {
      this.updatePeers(peers);
    });

    // Handle signals for graceful shutdown
    if (options.handleSignals) {
      this.setupSignalHandlers();
    }
  }

  /**
   * Start the cache (transport and discovery)
   */
  async start(port?: number): Promise<void> {
    if (this.started) {
      return;
    }

    this.logger.info('Starting GroupCache', { self: this.selfAddress });

    // Start transport server
    const listenPort = port ?? this.extractPort(this.selfAddress) ?? 8080;
    await this.transport.listen(listenPort, this.createHandler());

    this.logger.info('Transport listening', { address: this.transport.listenAddress });

    // Start peer discovery
    await this.discovery.start();

    this.started = true;
    this.logger.info('GroupCache started');
  }

  /**
   * Stop the cache gracefully
   */
  async shutdown(options: { timeout?: number } = {}): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.doShutdown(options.timeout ?? 30000);
    return this.shutdownPromise;
  }

  /**
   * Create a new cache group
   */
  newGroup<T>(options: Omit<GroupOptions<T>, 'logger'>): Group<T> {
    if (this.groups.has(options.name)) {
      throw new Error(`Group "${options.name}" already exists`);
    }

    const group = new Group<T>({
      ...options,
      maxSize: options.maxSize ?? this.defaultMaxSize,
      ttl: options.ttl ?? this.defaultTtl,
      logger: this.logger,
    });

    // Inject dependencies
    group.setDependencies({
      hashRing: this.hashRing,
      transport: this.transport,
      selfAddress: this.selfAddress,
      getPeers: () => this.discovery.getPeers(),
    });

    this.groups.set(options.name, group as Group);

    this.logger.info('Created group', { name: options.name });

    return group;
  }

  /**
   * Get an existing group
   */
  getGroup<T = unknown>(name: string): Group<T> | undefined {
    return this.groups.get(name) as Group<T> | undefined;
  }

  /**
   * Remove a group
   */
  removeGroup(name: string): boolean {
    const group = this.groups.get(name);
    if (!group) {
      return false;
    }

    group.clear();
    this.groups.delete(name);

    this.logger.info('Removed group', { name });

    return true;
  }

  /**
   * Get all group names
   */
  getGroupNames(): string[] {
    return [...this.groups.keys()];
  }

  /**
   * Get instance statistics
   */
  getStats(): InstanceStats {
    const groupStats = new Map<string, ReturnType<Group['getStats']>>();

    for (const [name, group] of this.groups) {
      groupStats.set(name, group.getStats());
    }

    return {
      groups: groupStats,
      peerCount: this.discovery.getPeers().length,
      uptime: Date.now() - this.startTime,
    };
  }

  /**
   * Get health status
   */
  getHealth(): HealthStatus {
    const peers = this.discovery.getPeers();
    const unhealthyPeers = peers.filter(
      (p) => p.metadata?.healthy === 'false'
    );

    const groups = [...this.groups.entries()].map(([name, group]) => {
      const stats = group.getStats();
      // Get maxSize from group options - for now use a reasonable estimate
      const maxSize = this.defaultMaxSize;
      return {
        name,
        cacheSize: stats.cacheSize,
        maxSize,
        utilizationPercent: Math.round((stats.cacheSize / maxSize) * 100),
      };
    });

    return {
      healthy: this.started && unhealthyPeers.length === 0,
      peers: {
        total: peers.length,
        healthy: peers.length - unhealthyPeers.length,
        unhealthy: unhealthyPeers.map((p) => p.address),
      },
      groups,
    };
  }

  /**
   * Get current peers
   */
  getPeers(): PeerInfo[] {
    return this.discovery.getPeers();
  }

  /**
   * Check if this instance is the owner of a key
   */
  isKeyOwner(_groupName: string, key: string): boolean {
    const owner = this.hashRing.get(key);
    return owner === this.selfAddress;
  }

  /**
   * Update peers in the hash ring
   */
  private updatePeers(peers: PeerInfo[]): void {
    // Clear and rebuild hash ring
    this.hashRing.clear();

    for (const peer of peers) {
      this.hashRing.add(peer.address);
    }

    this.logger.info('Updated peers', {
      count: peers.length,
      addresses: peers.map((p) => p.address),
    });
  }

  /**
   * Create transport handler
   */
  private createHandler(): TransportHandler {
    return {
      handleGet: async (ctx, req) => {
        const group = this.groups.get(req.group);
        if (!group) {
          throw new NotFoundError(req.group, req.key);
        }

        return group.handlePeerGet(ctx, req.key);
      },

      handleSet: async (_ctx, req) => {
        const group = this.groups.get(req.group);
        if (!group) {
          throw new NotFoundError(req.group, req.key);
        }

        group.handlePeerSet(req.key, req.value, req.ttl);
      },

      handleRemove: async (_ctx, req) => {
        const group = this.groups.get(req.group);
        if (!group) {
          return; // Ignore remove for non-existent group
        }

        group.handlePeerRemove(req.key);
      },

      handleRemoveMany: async (_ctx, req) => {
        const group = this.groups.get(req.group);
        if (!group) {
          return;
        }

        group.handlePeerRemoveMany(req.keys);
      },
    };
  }

  /**
   * Perform graceful shutdown
   */
  private async doShutdown(timeout: number): Promise<void> {
    this.logger.info('Shutting down GroupCache', { timeout });

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Shutdown timeout')), timeout);
    });

    try {
      await Promise.race([
        (async () => {
          // Stop accepting new requests
          await this.transport.close();

          // Stop discovery
          await this.discovery.stop();

          // Clear all groups
          for (const group of this.groups.values()) {
            group.clear();
          }

          this.started = false;
          this.logger.info('GroupCache shutdown complete');
        })(),
        timeoutPromise,
      ]);
    } catch (error) {
      this.logger.error('Shutdown error', { error: String(error) });
      throw error;
    }
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const handler = () => {
      this.shutdown().catch((error) => {
        this.logger.error('Shutdown failed', { error: String(error) });
        process.exit(1);
      });
    };

    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
  }

  /**
   * Extract port from address
   */
  private extractPort(address: string): number | undefined {
    try {
      const url = new URL(address);
      return url.port ? parseInt(url.port, 10) : undefined;
    } catch {
      return undefined;
    }
  }
}
