# Local Secrets

A secure, offline-first secrets manager for mobile. Store and encrypt your secrets locally with biometric authentication.

## Features

- **AES-256-GCM encryption** — all secret values are encrypted at rest
- **Hardware-backed key storage** — encryption keys stored in SecureStore (iOS Keychain / Android Keystore)
- **Biometric authentication** — Face ID / Touch ID / fingerprint to access secrets
- **PIN fallback** — set a PIN for when biometrics aren't available
- **Projects** — organize secrets into named projects
- **Decrypt All** — reveal all secrets in a project with confirmation + biometric check

## Tech Stack

- **Expo** (SDK 55) with Expo Router
- **HeroUI Native** — UI components
- **expo-crypto** — AES-256-GCM encryption
- **expo-secure-store** — hardware-backed key storage
- **expo-local-authentication** — biometric auth
- **@react-native-async-storage/async-storage** — encrypted data storage

## Get Started

```bash
npm install
npx expo start
```

## Security Model

| What | Where | Why |
|------|-------|-----|
| Encryption key | SecureStore | Hardware-backed, OS-level protection |
| Encrypted values | AsyncStorage | Unreadable without the key |
| PIN hash | SecureStore | SHA-256 hash, never stored in plaintext |
| Project/secret metadata | AsyncStorage | Names and descriptions (no sensitive data) |
