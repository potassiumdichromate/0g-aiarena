import { FastifyInstance } from 'fastify';
import { AuthService } from '../services/auth.service';

const authService = new AuthService();

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/nonce', async (req, reply) => {
    const { address } = req.query as { address: string };
    if (!address) return reply.status(400).send({ error: 'address required' });
    const nonce = await authService.getNonce(address);
    return { nonce };
  });

  app.post('/login', async (req, reply) => {
    const { message, signature, walletAddress } = req.body as {
      message: string;
      signature: string;
      walletAddress: string;
    };
    try {
      const result = await authService.login(message, signature, walletAddress);
      const accessToken = app.jwt.sign({ userId: result.userId, walletAddress });
      const refreshToken = app.jwt.sign(
        { userId: result.userId },
        { secret: process.env.JWT_REFRESH_SECRET ?? 'refresh-secret', expiresIn: '7d' }
      );
      return { accessToken, refreshToken, expiresIn: 3600, userId: result.userId };
    } catch (err: any) {
      return reply.status(401).send({ error: err.message });
    }
  });

  app.post('/refresh', async (req, reply) => {
    const { refreshToken } = req.body as { refreshToken: string };
    try {
      const decoded = app.jwt.verify<{ userId: string }>(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'refresh-secret',
      });
      const accessToken = app.jwt.sign({ userId: decoded.userId });
      return { accessToken, expiresIn: 3600 };
    } catch {
      return reply.status(401).send({ error: 'Invalid refresh token' });
    }
  });

  app.post('/logout', async (_req, reply) => {
    return reply.send({ success: true });
  });
}
