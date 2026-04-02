import {
  AESEncryptionKey,
  AESSealedData,
  aesEncryptAsync,
  aesDecryptAsync,
  digestStringAsync,
  getRandomBytes,
  CryptoDigestAlgorithm,
  CryptoEncoding,
} from 'expo-crypto';

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export async function generateEncryptionKey(): Promise<string> {
  const key = await AESEncryptionKey.generate();
  return key.encoded('hex');
}

export async function encryptValue(
  value: string,
  keyHex: string
): Promise<{ sealed: string }> {
  const key = await AESEncryptionKey.import(keyHex, 'hex');
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(value);

  const sealedData = await aesEncryptAsync(plaintextBytes, key);

  const combinedBytes = await sealedData.combined('bytes');

  return { sealed: uint8ArrayToHex(combinedBytes) };
}

export async function decryptValue(
  sealedHex: string,
  keyHex: string
): Promise<string> {
  const key = await AESEncryptionKey.import(keyHex, 'hex');

  const combinedBytes = hexToUint8Array(sealedHex);
  const sealedData = AESSealedData.fromCombined(combinedBytes);

  const decryptedBytes = await aesDecryptAsync(sealedData, key, {
    output: 'bytes',
  });

  const decoder = new TextDecoder();
  return decoder.decode(decryptedBytes);
}

export async function hashPin(pin: string): Promise<string> {
  const saltBytes = getRandomBytes(16);
  const salt = uint8ArrayToHex(saltBytes);
  const hash = await digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    salt + pin,
    { encoding: CryptoEncoding.HEX }
  );
  return `${salt}:${hash}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const sep = stored.indexOf(':');
  if (sep === -1) return false;
  const salt = stored.slice(0, sep);
  const expectedHash = stored.slice(sep + 1);
  const actualHash = await digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    salt + pin,
    { encoding: CryptoEncoding.HEX }
  );
  return actualHash === expectedHash;
}
