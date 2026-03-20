export {
  type PeerDiscovery,
  BasePeerDiscovery,
} from './interface.js';

export {
  StaticPeerDiscovery,
  type StaticPeerDiscoveryOptions,
} from './static.js';

export {
  KubernetesPeerDiscovery,
  type KubernetesPeerDiscoveryOptions,
  getPodIP,
  getCurrentNamespace,
} from './kubernetes.js';

export {
  DnsSrvPeerDiscovery,
  type DnsSrvPeerDiscoveryOptions,
} from './dns.js';
