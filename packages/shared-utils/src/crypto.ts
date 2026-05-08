import { createHash, createHmac, randomBytes } from 'crypto';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Buffer(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function hmacSha256(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function generateNonce(length = 32): string {
  return randomBytes(length).toString('hex');
}

export function generateId(): string {
  return randomBytes(16).toString('hex');
}

export function hashObject(obj: unknown): string {
  return sha256(JSON.stringify(obj, Object.keys(obj as object).sort()));
}

export function verifyHmac(data: string, secret: string, expected: string): boolean {
  const actual = hmacSha256(data, secret);
  // Constant-time comparison to prevent timing attacks
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function base64Encode(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return buf.toString('base64');
}

export function base64Decode(data: string): Buffer {
  return Buffer.from(data, 'base64');
}
