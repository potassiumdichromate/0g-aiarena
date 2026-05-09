/**
 * Auth routes
 *
 * POST /auth/privy       — Verify Privy access token, return our JWT
 * POST /auth/refresh     — Refresh JWT using refresh token
 * POST /auth/logout      — Invalidate session
 * GET  /auth/nonce       — Legacy SIWE nonce (kept for compatibility)
 * GET  /auth/me          — Current user profile (requires JWT)
 */

import { FastifyInstance } from 'fastify';
import { AuthService }     from '../services/auth.service';
import { prisma }          from '@ai-arena/db-client';

const authService = new AuthService();

export async function authRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /auth/privy ──────────────────────────────────────────────────────
  // Frontend calls this after Privy login, passing the Privy access token.
  // Returns our own JWT so all other API calls don't need Privy.
  app.post('/privy', async (req, reply) => {
    const { accessToken: privyToken } = req.body as { accessToken: string };
    if (!privyToken) {
      return reply.status(400).send({ error: 'accessToken required' });
    }

    try {
      const { userId, walletAddress, isNewUser, custodialSolanaAddress } =
        await authService.loginWithPrivy(privyToken);

      const accessToken = app.jwt.sign(
        { userId, walletAddress },
        { expiresIn: process.env.JWT_ACCESS_EXPIRY ?? '15m' },
      );
      const refreshToken = app.jwt.sign(
        { userId },
        {
          secret:    process.env.JWT_REFRESH_SECRET ?? 'refresh-secret',
          expiresIn: process.env.JWT_REFRESH_EXPIRY ?? '7d',
        },
      );

      return reply.send({
        accessToken,
        refreshToken,
        expiresIn: 900, // 15 min in seconds
        userId,
        walletAddress,
        custodialSolanaAddress,
        isNewUser,
      });
    } catch (err: any) {
      return reply.status(401).send({ error: err.message });
    }
  });

  // ── POST /auth/refresh ────────────────────────────────────────────────────
  app.post('/refresh', async (req, reply) => {
    const { refreshToken } = req.body as { refreshToken: string };
    if (!refreshToken) {
      return reply.status(400).send({ error: 'refreshToken required' });
    }
    try {
      const decoded = app.jwt.verify<{ userId: string }>(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET ?? 'refresh-secret',
      });

      const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
      if (!user || !user.isActive) {
        return reply.status(401).send({ error: 'User not found or inactive' });
      }

      const accessToken = app.jwt.sign(
        { userId: user.id, walletAddress: user.walletAddress },
        { expiresIn: process.env.JWT_ACCESS_EXPIRY ?? '15m' },
      );

      return reply.send({ accessToken, expiresIn: 900 });
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' });
    }
  });

  // ── POST /auth/logout ─────────────────────────────────────────────────────
  app.post('/logout', async (_req, reply) => {
    // JWTs are stateless — client drops the token.
    // TODO(Phase 2): add token to Redis blocklist for immediate revocation.
    return reply.send({ success: true });
  });

  // ── GET /auth/me ──────────────────────────────────────────────────────────
  app.get('/me', {
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const { userId } = req.user as { userId: string };
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id:                     true,
        walletAddress:          true,
        custodialSolanaAddress: true,
        username:               true,
        email:                  true,
        avatarUrl:              true,
        isActive:               true,
        createdAt:              true,
      },
    });
    if (!user) return reply.status(404).send({ error: 'User not found' });
    return reply.send({ user });
  });

  // ── GET /auth/nonce ───────────────────────────────────────────────────────
  // Legacy — kept for any non-Privy EVM signing clients
  app.get('/nonce', async (req, reply) => {
    const { address } = req.query as { address?: string };
    if (!address) return reply.status(400).send({ error: 'address required' });
    const nonce = await authService.getNonce(address);
    return reply.send({ nonce });
  });
}
