import { hash, verify, Algorithm } from '@node-rs/argon2';
import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const passwordHash = (value: string) => hash(value, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const passwordVerify = (stored: string, value: string) => verify(stored, value);
export function equal(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class Problem extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function requireValue(condition: unknown, status: number, code: string, message: string, details?: unknown): asserts condition {
  if (!condition) throw new Problem(status, code, message, details);
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
