import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup as resolveHost } from 'node:dns/promises';
import { BlockList, isIP, Socket } from 'node:net';

const blocked = new BlockList();

blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('224.0.0.0', 4, 'ipv4');
blocked.addSubnet('240.0.0.0', 4, 'ipv4');
blocked.addAddress('0.0.0.0', 'ipv4');
blocked.addAddress('100.100.100.200', 'ipv4');
blocked.addAddress('192.0.0.192', 'ipv4');

blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('fd00:ec2::254', 'ipv6');

const BLOCKED_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal'
]);

type Allowlist = {
  hostnames: Set<string>;
  addresses: BlockList;
};

export class HostGuardError extends Error {
  constructor(
    message = 'This database host is not allowed.',
    readonly code: 'HOST_BLOCKED' | 'HOST_UNRESOLVED' = 'HOST_BLOCKED',
    readonly status = 400
  ) {
    super(message);
    this.name = 'HostGuardError';
  }
}

function normalizeHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.endsWith('.')) value = value.slice(0, -1);
  return value;
}

function normalizeAddress(address: string): { address: string; family: 4 | 6 } {
  const value = address.trim().toLowerCase();
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice(7);
    if (isIP(mapped) === 4) return { address: mapped, family: 4 };
    const parts = mapped.split(':');
    if (parts.length === 2 && parts.every(part => /^[0-9a-f]{1,4}$/.test(part))) {
      const high = Number.parseInt(parts[0], 16);
      const low = Number.parseInt(parts[1], 16);
      return {
        address: [high >> 8, high & 255, low >> 8, low & 255].join('.'),
        family: 4
      };
    }
  }
  const family = isIP(value);
  return { address: value, family: family === 6 ? 6 : 4 };
}

function parseAllowlist(): Allowlist | null {
  const raw = process.env.DB_ALLOWED_HOSTS?.trim();
  if (!raw) return null;

  const hostnames = new Set<string>();
  const addresses = new BlockList();

  for (const entry of raw.split(',').map(value => value.trim()).filter(Boolean)) {
    const value = normalizeHost(entry);
    const slash = value.lastIndexOf('/');
    if (slash === -1) {
      const family = isIP(value);
      if (family === 4 || family === 6) {
        addresses.addAddress(value, family === 6 ? 'ipv6' : 'ipv4');
      } else {
        hostnames.add(value);
      }
      continue;
    }

    const network = value.slice(0, slash);
    const prefix = Number(value.slice(slash + 1));
    const family = isIP(network);
    if (
      (family !== 4 && family !== 6) ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > (family === 6 ? 128 : 32)
    ) {
      throw new HostGuardError('DB_ALLOWED_HOSTS contains an invalid entry.', 'HOST_BLOCKED', 500);
    }
    addresses.addSubnet(network, prefix, family === 6 ? 'ipv6' : 'ipv4');
  }

  return { hostnames, addresses };
}

function isBlockedAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  return blocked.check(normalized.address, normalized.family === 6 ? 'ipv6' : 'ipv4');
}

function assertAddressAllowed(address: string, allowlist: Allowlist | null) {
  if (isBlockedAddress(address)) throw new HostGuardError();
  const normalized = normalizeAddress(address);
  if (
    allowlist &&
    !allowlist.addresses.check(normalized.address, normalized.family === 6 ? 'ipv6' : 'ipv4')
  ) {
    throw new HostGuardError('This database host is not in DB_ALLOWED_HOSTS.');
  }
}

function assertResolvedAllowed(hostname: string, addresses: LookupAddress[]) {
  const allowlist = parseAllowlist();
  const hostnameAllowed = allowlist?.hostnames.has(normalizeHost(hostname)) ?? false;
  if (addresses.length === 0) {
    throw new HostGuardError('The database host could not be resolved.', 'HOST_UNRESOLVED');
  }

  for (const item of addresses) {
    if (isBlockedAddress(item.address)) throw new HostGuardError();
    if (allowlist && !hostnameAllowed) {
      const normalized = normalizeAddress(item.address);
      if (
        !allowlist.addresses.check(
          normalized.address,
          normalized.family === 6 ? 'ipv6' : 'ipv4'
        )
      ) {
        throw new HostGuardError('This database host is not in DB_ALLOWED_HOSTS.');
      }
    }
  }
}

export async function assertHostAllowed(host: string) {
  const value = normalizeHost(host);
  if (!value || value.startsWith('/') || /\s/.test(value)) {
    throw new HostGuardError('Enter a valid database host or IP address.');
  }
  if (BLOCKED_HOSTNAMES.has(value)) throw new HostGuardError();

  const family = isIP(value);
  if (family === 4 || family === 6) {
    assertAddressAllowed(value, parseAllowlist());
    return;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await resolveHost(value, { all: true, verbatim: true });
  } catch {
    throw new HostGuardError('The database host could not be resolved.', 'HOST_UNRESOLVED');
  }
  assertResolvedAllowed(value, addresses);
}

export function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number } | number,
  callback: (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void
) {
  const lookupOptions = typeof options === 'number' ? { family: options } : options;
  dnsLookup(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
    if (error) return callback(error);
    try {
      assertResolvedAllowed(hostname, addresses);
    } catch (guardError) {
      return callback(guardError as NodeJS.ErrnoException);
    }

    if (lookupOptions.all) return callback(null, addresses);
    const first = addresses[0];
    if (!first) {
      return callback(
        Object.assign(new Error('The database host could not be resolved.'), {
          code: 'HOST_UNRESOLVED'
        })
      );
    }
    callback(null, first.address, first.family);
  });
}

export function createGuardedSocket(): Socket {
  const socket = new Socket();
  const originalConnect = socket.connect.bind(socket) as (...args: any[]) => Socket;

  socket.connect = ((portOrOptions: any, hostOrCallback?: any, maybeCallback?: any) => {
    if (typeof portOrOptions === 'string' && portOrOptions.startsWith('/')) {
      throw new HostGuardError('Unix socket paths are not allowed.');
    }
    if (typeof portOrOptions === 'object' && portOrOptions !== null) {
      const options = portOrOptions as Record<string, unknown>;
      const host = normalizeHost(String(options.host ?? ''));
      if (isIP(host) === 4 || isIP(host) === 6) assertAddressAllowed(host, parseAllowlist());
      return originalConnect({ ...options, host, lookup: guardedLookup }, hostOrCallback);
    }

    const host = normalizeHost(String(hostOrCallback ?? ''));
    if (isIP(host) === 4 || isIP(host) === 6) assertAddressAllowed(host, parseAllowlist());
    return originalConnect({ port: portOrOptions, host, lookup: guardedLookup }, maybeCallback);
  }) as typeof socket.connect;

  return socket;
}
