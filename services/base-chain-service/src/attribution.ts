/**
 * Re-export of the shared attribution helpers.
 *
 * The implementation moved to @ai-arena/a2a-protocol so evaluation-service can
 * use the same one. Kept as a thin re-export because existing imports in this
 * service point here.
 */
export { sendAttributed, withAttribution, attributionStatus } from '@ai-arena/a2a-protocol';
export type { AttributedTxResult } from '@ai-arena/a2a-protocol';
