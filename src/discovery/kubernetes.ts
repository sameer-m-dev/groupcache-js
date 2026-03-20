/**
 * Kubernetes Peer Discovery
 *
 * Automatically discovers peer pods in a Kubernetes cluster using the
 * Kubernetes API. Watches for pod changes and updates the peer list
 * when pods are added, removed, or change state.
 *
 * Requirements:
 * - Service account with pods get/list/watch permissions
 * - POD_IP environment variable (usually set by Kubernetes)
 */

import type { PeerInfo } from '../types.js';
import { BasePeerDiscovery } from './interface.js';

/**
 * Options for Kubernetes peer discovery
 */
export interface KubernetesPeerDiscoveryOptions {
  /** Label selector for filtering pods (e.g., "app=myapp") */
  labelSelector: string;
  /** Namespace to watch (default: current namespace from service account) */
  namespace?: string;
  /** Port that groupcache is listening on */
  port: number;
  /** Protocol to use (default: "http") */
  protocol?: 'http' | 'https';
  /** Kubernetes API server URL (default: in-cluster) */
  apiServer?: string;
  /** Path to service account token (default: /var/run/secrets/kubernetes.io/serviceaccount/token) */
  tokenPath?: string;
  /** Path to namespace file (default: /var/run/secrets/kubernetes.io/serviceaccount/namespace) */
  namespacePath?: string;
  /** Path to CA certificate (default: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt) */
  caPath?: string;
  /** Resync interval in milliseconds (default: 30000) */
  resyncInterval?: number;
}

/**
 * Pod information from Kubernetes API
 */
interface KubernetesPod {
  metadata: {
    name: string;
    namespace: string;
    uid: string;
    labels?: Record<string, string>;
  };
  status: {
    phase: string;
    podIP?: string;
    conditions?: Array<{
      type: string;
      status: string;
    }>;
  };
}

/**
 * Kubernetes API response for pod list
 */
interface PodListResponse {
  kind: string;
  apiVersion: string;
  metadata: {
    resourceVersion: string;
  };
  items: KubernetesPod[];
}

/**
 * Kubernetes watch event
 */
interface WatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR';
  object: KubernetesPod;
}

/**
 * Kubernetes peer discovery using the Kubernetes API
 */
export class KubernetesPeerDiscovery extends BasePeerDiscovery {
  private readonly labelSelector: string;
  private readonly port: number;
  private readonly protocol: string;
  private readonly apiServer: string;
  private readonly tokenPath: string;
  private readonly namespacePath: string;
  private readonly resyncInterval: number;

  private namespace: string | null = null;
  private token: string | null = null;
  private abortController: AbortController | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;
  private resourceVersion: string | null = null;
  private pods: Map<string, KubernetesPod> = new Map();

  constructor(options: KubernetesPeerDiscoveryOptions) {
    super();

    this.labelSelector = options.labelSelector;
    this.port = options.port;
    this.protocol = options.protocol ?? 'http';
    this.apiServer = options.apiServer ?? 'https://kubernetes.default.svc';
    this.tokenPath = options.tokenPath ?? '/var/run/secrets/kubernetes.io/serviceaccount/token';
    this.namespacePath = options.namespacePath ?? '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
    // CA path reserved for future TLS support: options.caPath
    this.resyncInterval = options.resyncInterval ?? 30000;

    if (options.namespace) {
      this.namespace = options.namespace;
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      // Load namespace and token
      await this.loadCredentials();

      // Initial list of pods
      await this.listPods();

      // Start watching for changes
      this.startWatch();

      // Start resync timer
      this.resyncTimer = setInterval(() => {
        this.listPods().catch((error) => {
          this.emitError(new Error(`Resync failed: ${error}`));
        });
      }, this.resyncInterval);
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Stop watch
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Stop resync timer
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }

    this.pods.clear();
  }

  /**
   * Load Kubernetes credentials from service account
   */
  private async loadCredentials(): Promise<void> {
    const fs = await import('node:fs/promises');

    // Load namespace if not provided
    if (!this.namespace) {
      try {
        this.namespace = (await fs.readFile(this.namespacePath, 'utf-8')).trim();
      } catch (error) {
        throw new Error(
          `Failed to read namespace from ${this.namespacePath}. ` +
          `Are you running in a Kubernetes pod? Error: ${error}`
        );
      }
    }

    // Load token
    try {
      this.token = (await fs.readFile(this.tokenPath, 'utf-8')).trim();
    } catch (error) {
      throw new Error(
        `Failed to read token from ${this.tokenPath}. ` +
        `Are you running in a Kubernetes pod? Error: ${error}`
      );
    }
  }

  /**
   * List all pods matching the label selector
   */
  private async listPods(): Promise<void> {
    const url = this.buildApiUrl('');
    const response = await this.apiRequest<PodListResponse>(url);

    this.resourceVersion = response.metadata.resourceVersion;
    this.pods.clear();

    for (const pod of response.items) {
      if (this.isPodReady(pod)) {
        this.pods.set(pod.metadata.uid, pod);
      }
    }

    this.updatePeerList();
  }

  /**
   * Start watching for pod changes
   */
  private startWatch(): void {
    this.abortController = new AbortController();

    this.doWatch().catch((error) => {
      if (this.started && !this.abortController?.signal.aborted) {
        this.emitError(new Error(`Watch error: ${error}`));
        // Restart watch after a delay
        setTimeout(() => {
          if (this.started) {
            this.startWatch();
          }
        }, 5000);
      }
    });
  }

  /**
   * Execute the watch request
   */
  private async doWatch(): Promise<void> {
    const url = this.buildApiUrl(`&watch=true&resourceVersion=${this.resourceVersion}`);

    const fetchOptions: RequestInit = {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
    };

    if (this.abortController?.signal) {
      fetchOptions.signal = this.abortController.signal;
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`Watch request failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Watch response has no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete JSON objects
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line) {
          try {
            const event = JSON.parse(line) as WatchEvent;
            this.handleWatchEvent(event);
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  }

  /**
   * Handle a watch event
   */
  private handleWatchEvent(event: WatchEvent): void {
    const pod = event.object;
    const uid = pod.metadata.uid;

    switch (event.type) {
      case 'ADDED':
      case 'MODIFIED':
        if (this.isPodReady(pod)) {
          this.pods.set(uid, pod);
        } else {
          this.pods.delete(uid);
        }
        break;

      case 'DELETED':
        this.pods.delete(uid);
        break;

      case 'ERROR':
        this.emitError(new Error(`Watch error event: ${JSON.stringify(pod)}`));
        return;
    }

    this.updatePeerList();
  }

  /**
   * Check if a pod is ready
   */
  private isPodReady(pod: KubernetesPod): boolean {
    // Must be in Running phase
    if (pod.status.phase !== 'Running') {
      return false;
    }

    // Must have an IP
    if (!pod.status.podIP) {
      return false;
    }

    // Must have Ready condition
    const readyCondition = pod.status.conditions?.find((c) => c.type === 'Ready');
    if (!readyCondition || readyCondition.status !== 'True') {
      return false;
    }

    return true;
  }

  /**
   * Update the peer list from current pods
   */
  private updatePeerList(): void {
    const peers: PeerInfo[] = [];

    for (const pod of this.pods.values()) {
      if (pod.status.podIP) {
        peers.push({
          address: `${this.protocol}://${pod.status.podIP}:${this.port}`,
          metadata: {
            podName: pod.metadata.name,
            namespace: pod.metadata.namespace,
            uid: pod.metadata.uid,
          },
        });
      }
    }

    this.setPeers(peers);
  }

  /**
   * Build Kubernetes API URL
   */
  private buildApiUrl(suffix: string): string {
    const labelSelector = encodeURIComponent(this.labelSelector);
    return `${this.apiServer}/api/v1/namespaces/${this.namespace}/pods?labelSelector=${labelSelector}${suffix}`;
  }

  /**
   * Make an API request
   */
  private async apiRequest<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Kubernetes API error: ${response.status} ${response.statusText} - ${body}`);
    }

    return response.json() as Promise<T>;
  }
}

/**
 * Get the current pod's IP address from environment
 */
export function getPodIP(): string | undefined {
  return process.env['POD_IP'] ?? process.env['MY_POD_IP'];
}

/**
 * Get the current namespace from environment or service account
 */
export async function getCurrentNamespace(): Promise<string | undefined> {
  // Try environment variable first
  const envNamespace = process.env['POD_NAMESPACE'] ?? process.env['MY_POD_NAMESPACE'];
  if (envNamespace) {
    return envNamespace;
  }

  // Try service account file
  try {
    const fs = await import('node:fs/promises');
    return (await fs.readFile('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf-8')).trim();
  } catch {
    return undefined;
  }
}
