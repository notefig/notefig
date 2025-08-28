import { Host } from './host.interface';
import { nixpacks } from './hosts/nixpacks.host';
import { vercel } from './hosts/vercel.host';
import { netlify } from './hosts/netlify.host';
import { s3 } from './hosts/s3.host';

export const hostHelpers: Record<string, Host> = {
  netlify,
  vercel,
  nixpacks,
  coolify: nixpacks,
  railway: nixpacks,
  s3,
};

export function getHostHelper(host: keyof typeof hostHelpers) {
  return hostHelpers[host];
}

export function getSupportedHosts() {
  return Object.keys(hostHelpers);
}
