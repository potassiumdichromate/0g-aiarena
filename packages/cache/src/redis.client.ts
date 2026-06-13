import Redis from 'ioredis';

export class RedisClient {
  private readonly redis: Redis;

  constructor(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    this.redis.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });
  }

  async connect(): Promise<void> {
    await this.redis.connect();
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  async set(key: string, value: string): Promise<void> {
    await this.redis.set(key, value);
  }

  async setJson<T>(key: string, value: T): Promise<void> {
    await this.redis.set(key, JSON.stringify(value));
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.redis.setex(key, ttlSeconds, value);
  }

  async setexJson<T>(key: string, ttlSeconds: number, value: T): Promise<void> {
    await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const count = await this.redis.exists(key);
    return count > 0;
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, ttlSeconds);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.redis.hget(key, field);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.redis.hset(key, field, value);
  }

  async hdel(key: string, ...fields: string[]): Promise<void> {
    await this.redis.hdel(key, ...fields);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(key);
  }

  async lpush(key: string, ...values: string[]): Promise<void> {
    await this.redis.lpush(key, ...values);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.redis.lrange(key, start, stop);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.redis.ltrim(key, start, stop);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.redis.zadd(key, score, member);
  }

  async zrange(key: string, start: number, stop: number, withScores = false): Promise<string[]> {
    if (withScores) {
      return this.redis.zrange(key, start, stop, 'WITHSCORES');
    }
    return this.redis.zrange(key, start, stop);
  }

  async zrevrange(key: string, start: number, stop: number, withScores = false): Promise<string[]> {
    if (withScores) {
      return this.redis.zrevrange(key, start, stop, 'WITHSCORES');
    }
    return this.redis.zrevrange(key, start, stop);
  }

  async zrank(key: string, member: string): Promise<number | null> {
    return this.redis.zrank(key, member);
  }

  async zrevrank(key: string, member: string): Promise<number | null> {
    return this.redis.zrevrank(key, member);
  }

  async zscore(key: string, member: string): Promise<string | null> {
    return this.redis.zscore(key, member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    return this.redis.zrem(key, ...members);
  }

  async zincrby(key: string, increment: number, member: string): Promise<number> {
    const result = await this.redis.zincrby(key, increment, member);
    return parseFloat(result);
  }

  async delPattern(pattern: string): Promise<number> {
    const keys = await this.redis.keys(pattern);
    if (keys.length === 0) return 0;
    return this.redis.del(...keys);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.redis.publish(channel, message);
  }

  async incr(key: string): Promise<number> {
    return this.redis.incr(key);
  }

  getClient(): Redis {
    return this.redis;
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}

let redisInstance: RedisClient | null = null;

export function getRedisClient(): RedisClient {
  if (!redisInstance) {
    redisInstance = new RedisClient();
  }
  return redisInstance;
}
