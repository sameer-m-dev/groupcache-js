/**
 * DNS SRV Peer Discovery
 *
 * Discovers peers using DNS SRV records. This is useful for:
 * - Service meshes that publish SRV records
 * - Traditional DNS-based service discovery
 * - Consul DNS interface
 *
 * Example SRV record:
 *   _groupcache._tcp.myapp.local. 300 IN SRV 10 50 8080 pod1.myapp.local.
 */

import * as dns from 'node:dns/promises';
import type { PeerInfo } from '../types.js';
import { BasePeerDiscovery } from './interface.js';

/**
 * Options for DNS SRV peer discovery
 */
export interface DnsSrvPeerDiscoveryOptions {
  /** DNS SRV service name (e.g., "_groupcache._tcp.myapp.local") */
  service: string;
  /** Protocol to use for peer addresses (default: "http") */
  protocol?: 'http' | 'https';
  /** Refresh interval in milliseconds (default: 30000) */
  refreshInterval?: number;
  /** DNS lookup timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Whether to resolve SRV target hostnames to IPs (default: true) */
  resolveTargets?: boolean;
}

/**
 * DNS SRV record structure
 */
interface SrvRecord {
  priority: number;
  weight: number;
  port: number;
  name: string;
}

/**
 * DNS SRV peer discovery
 */
export class DnsSrvPeerDiscovery extends BasePeerDiscovery {
  private readonly service: string;
  private readonly protocol: string;
  private readonly refreshInterval: number;
  private readonly timeout: number;
  private readonly resolveTargets: boolean;

  private refreshTimer: NodeJS.Timeout | null = null;
  private lastRecords: SrvRecord[] = [];

  constructor(options: DnsSrvPeerDiscoveryOptions) {
    super();

    this.service = options.service;
    this.protocol = options.protocol ?? 'http';
    this.refreshInterval = options.refreshInterval ?? 30000;
    this.timeout = options.timeout ?? 5000;
    this.resolveTargets = options.resolveTargets ?? true;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Initial lookup
    await this.refresh();

    // Start refresh timer
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((error) => {
        this.emitError(new Error(`DNS refresh failed: ${error}`));
      });
    }, this.refreshInterval);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    this.lastRecords = [];
  }

  /**
   * Force a refresh of DNS records
   */
  async refresh(): Promise<void> {
    try {
      const records = await this.lookupSrv();
      this.lastRecords = records;

      const peers = await this.recordsToPeers(records);
      this.setPeers(peers);
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Perform DNS SRV lookup
   */
  private async lookupSrv(): Promise<SrvRecord[]> {
    const resolver = new dns.Resolver();
    resolver.setServers(dns.getServers());

    // Set timeout by using AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const records = await dns.resolveSrv(this.service);
      return records;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Convert SRV records to peer info
   */
  private async recordsToPeers(records: SrvRecord[]): Promise<PeerInfo[]> {
    // Sort by priority (lower is better), then by weight (higher is better)
    const sorted = [...records].sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return b.weight - a.weight;
    });

    const peers: PeerInfo[] = [];

    for (const record of sorted) {
      let host = record.name;

      // Remove trailing dot if present
      if (host.endsWith('.')) {
        host = host.slice(0, -1);
      }

      // Optionally resolve hostname to IP
      if (this.resolveTargets) {
        try {
          const addresses = await dns.resolve4(host);
          if (addresses.length > 0) {
            host = addresses[0]!;
          }
        } catch {
          // Keep hostname if resolution fails
        }
      }

      peers.push({
        address: `${this.protocol}://${host}:${record.port}`,
        weight: record.weight,
        metadata: {
          priority: String(record.priority),
          srvName: record.name,
        },
      });
    }

    return peers;
  }

  /**
   * Get the last resolved SRV records
   */
  getLastRecords(): SrvRecord[] {
    return [...this.lastRecords];
  }
}
