// Pure JS TOTP implementation (RFC 6238 / RFC 4226)
// Uses @noble/hashes for HMAC-based algorithms

import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import type { TotpAlgorithm } from '../types';

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(input: string): Uint8Array {
  const cleaned = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = '';
  for (const char of cleaned) {
    const val = BASE32_CHARS.indexOf(char);
    if (val === -1) throw new Error(`Invalid base32 character: ${char}`);
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

function getHashFunc(algorithm: TotpAlgorithm) {
  switch (algorithm) {
    case 'SHA256':
      return sha256;
    case 'SHA512':
      return sha512;
    case 'SHA1':
    default:
      return sha1;
  }
}

export function generateTOTP(
  base32Secret: string,
  period: number = 30,
  digits: number = 6,
  algorithm: TotpAlgorithm = 'SHA1',
  timestamp?: number
): string {
  const key = decodeBase32(base32Secret);
  const time = Math.floor((timestamp ?? Date.now()) / 1000 / period);

  // Convert time to 8-byte big-endian
  const timeBytes = new Uint8Array(8);
  const tv = new DataView(timeBytes.buffer);
  tv.setUint32(4, time, false);

  const hashFunc = getHashFunc(algorithm);
  const mac = new Uint8Array(hmac(hashFunc, key, timeBytes));

  // Dynamic truncation
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);

  return (code % Math.pow(10, digits)).toString().padStart(digits, '0');
}

export function getTimeRemaining(period: number = 30): number {
  return period - (Math.floor(Date.now() / 1000) % period);
}

export function isValidBase32(input: string): boolean {
  const cleaned = input.replace(/[\s=-]/g, '').toUpperCase();
  if (cleaned.length === 0) return false;
  return /^[A-Z2-7]+$/.test(cleaned);
}

export interface OtpAuthParams {
  issuer: string;
  accountName: string;
  secret: string;
  algorithm: TotpAlgorithm;
  period: number;
  digits: number;
}

function parseAlgorithm(value: string | null): TotpAlgorithm {
  if (!value) return 'SHA1';
  const upper = value.toUpperCase();
  if (upper === 'SHA256' || upper === 'SHA-256') return 'SHA256';
  if (upper === 'SHA512' || upper === 'SHA-512') return 'SHA512';
  return 'SHA1';
}

export function parseOtpAuthUri(uri: string): OtpAuthParams | null {
  try {
    if (!uri.startsWith('otpauth://totp/')) return null;

    const url = new URL(uri);
    const params = url.searchParams;
    const secret = params.get('secret');
    if (!secret || !isValidBase32(secret)) return null;

    // Label is path after /totp/ — can be "Issuer:account" or just "account"
    const label = decodeURIComponent(url.pathname.replace('/totp/', ''));
    let issuer = params.get('issuer') || '';
    let accountName = label;

    if (label.includes(':')) {
      const parts = label.split(':');
      if (!issuer) issuer = parts[0].trim();
      accountName = parts.slice(1).join(':').trim();
    }

    if (!issuer) issuer = 'Unknown';

    return {
      issuer,
      accountName,
      secret: secret.toUpperCase(),
      algorithm: parseAlgorithm(params.get('algorithm')),
      period: parseInt(params.get('period') || '30', 10),
      digits: parseInt(params.get('digits') || '6', 10),
    };
  } catch {
    return null;
  }
}
