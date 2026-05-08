import { getRedisClient } from '@ai-arena/cache';

export interface ValidationResult {
  valid: boolean;
  violations: string[];
  riskScore: number;
}

export class ActionValidator {
  private readonly redis = getRedisClient();

  async validateAction(params: {
    agentId: string;
    actionType: string;
    parameters: Record<string, unknown>;
    timestamp: number;
    battleId: string;
  }): Promise<ValidationResult> {
    const violations: string[] = [];
    let riskScore = 0;

    // Check for impossible action timing (< 16ms)
    const lastActionKey = `anticheat:lastAction:${params.agentId}:${params.battleId}`;
    const lastTs = await this.redis.get(lastActionKey);
    if (lastTs) {
      const timeSince = params.timestamp - parseInt(lastTs, 10);
      if (timeSince < 16) {
        violations.push('ACTION_TOO_FAST');
        riskScore += 30;
      }
    }
    await this.redis.setex(lastActionKey, 60, params.timestamp.toString());

    // Check action rate per minute
    const rateKey = `anticheat:rate:${params.agentId}:${params.battleId}`;
    const count = await this.redis.incr(rateKey);
    await this.redis.expire(rateKey, 60);
    if (count > 300) { // > 5 actions/second average
      violations.push('ACTION_RATE_EXCEEDED');
      riskScore += 50;
    }

    return { valid: violations.length === 0, violations, riskScore };
  }

  async validateBattleOutcome(battleId: string, result: Record<string, unknown>): Promise<ValidationResult> {
    // Deterministic replay verification would happen here
    return { valid: true, violations: [], riskScore: 0 };
  }
}
