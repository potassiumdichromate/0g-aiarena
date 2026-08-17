/**
 * Deterministic job identifier.
 *
 * jobId = keccak256(abi.encode(creatorAgentId, requirementsHash, nonce))
 *
 * Derived rather than random so the same document always yields the same id,
 * which is what makes `postJob` idempotent: a retried posting collides with
 * the existing on-chain record and is rejected by `status != NONE` rather than
 * creating a duplicate job (threat T7).
 *
 * Uses abi.encode rather than string concatenation so field boundaries are
 * unambiguous — concatenating "ab"+"c" and "a"+"bc" would otherwise collide.
 */
import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';

export function computeJobId(params: {
  creatorAgentId: string;
  requirementsHash: string;
  nonce: string;
}): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32'],
      [
        keccak256(toUtf8Bytes(params.creatorAgentId)),
        params.requirementsHash,
        keccak256(toUtf8Bytes(params.nonce)),
      ],
    ),
  );
}
