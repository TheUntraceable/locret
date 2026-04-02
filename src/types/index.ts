export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export interface Secret {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  sealedData: string;
  expiresAt?: string;
  createdAt: string;
}

export interface DecryptedSecret extends Secret {
  decryptedValue: string;
}

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpAccount {
  id: string;
  issuer: string;
  accountName: string;
  sealedSecret: string; // encrypted base32 secret
  algorithm: TotpAlgorithm; // SHA1, SHA256, or SHA512
  period: number; // typically 30
  digits: number; // typically 6
  createdAt: string;
}
