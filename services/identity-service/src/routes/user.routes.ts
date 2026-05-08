import { FastifyInstance } from 'fastify';
import { UserService } from '../services/user.service';
import { jwtMiddleware } from '../middleware/jwt.middleware';

const userService = new UserService();

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', jwtMiddleware(app));

  app.get('/me', async (req, reply) => {
    const { userId } = req.user as { userId: string };
    const user = await userService.getById(userId);
    if (!user) return reply.status(404).send({ error: 'User not found' });
    return { user };
  });

  app.put('/me', async (req, reply) => {
    const { userId } = req.user as { userId: string };
    const body = req.body as { username?: string; email?: string; avatarUrl?: string };
    const updated = await userService.update(userId, body);
    return { user: updated };
  });

  app.post('/link-wallet', async (req, reply) => {
    const { userId } = req.user as { userId: string };
    const { walletAddress } = req.body as { walletAddress: string };
    await userService.linkWallet(userId, walletAddress);
    return { success: true };
  });
}
