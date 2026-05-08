import { getRedisClient } from '@ai-arena/cache';

export interface Notification {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: 'BATTLE_RESULT' | 'TRAINING_COMPLETE' | 'MATCH_FOUND' | 'SYSTEM';
  read: boolean;
  createdAt: Date;
}

export class NotificationService {
  private readonly redis = getRedisClient();

  async send(userId: string, notification: Omit<Notification, 'id' | 'read' | 'createdAt'>): Promise<void> {
    const notif: Notification = {
      ...notification,
      id: `notif-${Date.now()}`,
      read: false,
      createdAt: new Date(),
    };

    const key = `notifications:${userId}`;
    await this.redis.lpush(key, JSON.stringify(notif));
    await this.redis.ltrim(key, 0, 99); // Keep last 100 notifications

    // Publish to WebSocket channel
    await this.redis.publish(`ws:user:${userId}`, JSON.stringify(notif));
  }

  async getNotifications(userId: string, limit = 20): Promise<Notification[]> {
    const key = `notifications:${userId}`;
    const raw = await this.redis.lrange(key, 0, limit - 1);
    return raw.map(r => JSON.parse(r) as Notification);
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    // In production: update the specific notification in Redis
    console.log(`Marking ${notificationId} as read for user ${userId}`);
  }
}
