import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Doc section 4, "Rede e execução": "Allowlist explícita de hosts/portas, HTTPS e validação de
 * redirects/IP resolvido; bloquear destinos internos/metadata." The vendor supplies the endpoint
 * URL at /evaluations time; by the time dispatch happens, that URL's hostname could resolve to a
 * private or link-local address (loopback, RFC1918, or a cloud metadata endpoint like
 * 169.254.169.254) -- a classic SSRF vector, not a hypothetical one. This resolves the hostname
 * and rejects any private/loopback/link-local result BEFORE the real fetch, rather than trusting
 * the URL string alone.
 */
export async function assertPublicHttpsEndpoint(url: URL): Promise<void> {
  if (url.protocol !== 'https:') {
    throw new NetworkGuardError(`endpoint must use https, got ${url.protocol}`);
  }
  const { address, family } = await lookup(url.hostname);
  if (isPrivateOrReserved(address, family)) {
    throw new NetworkGuardError(`endpoint resolves to a private/reserved address (${address}), refusing to dispatch`);
  }
}

export class NetworkGuardError extends Error {}

function isPrivateOrReserved(address: string, family: number): boolean {
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata (169.254.169.254)
    if (a === 0) return true; // "this network"
    return false;
  }
  // IPv6
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true; // loopback
  if (normalized.startsWith('fe80:')) return true; // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local (fc00::/7)
  if (normalized.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 — re-check the embedded IPv4 address.
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isPrivateOrReserved(mapped, 4);
  }
  return false;
}
