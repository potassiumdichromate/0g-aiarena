/**
 * Auth routes
 *
 * POST /auth/privy       — Verify Privy access token, return our JWT
 * POST /auth/refresh     — Refresh JWT using refresh token
 * POST /auth/logout      — Invalidate session
 * GET  /auth/nonce       — Legacy SIWE nonce (kept for compatibility)
 * GET  /auth/me          — Current user profile (requires JWT)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto               from 'node:crypto';
import { AuthService }     from '../services/auth.service';
import { prisma }          from '@ai-arena/db-client';

// Tell TypeScript that FastifyInstance has an authenticate decorator
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

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
        { userId, type: 'refresh' },
        { expiresIn: process.env.JWT_REFRESH_EXPIRY ?? '7d' },
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
      const decoded = app.jwt.verify<{ userId: string }>(refreshToken);

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

  // ── POST /auth/dev-login ──────────────────────────────────────────────────
  // DEV ONLY — bypasses Privy, creates/upserts a dev user, returns JWT.
  // Disabled in production via NODE_ENV check.
  app.post('/dev-login', async (req, reply) => {
    if (process.env.NODE_ENV === 'production') {
      return reply.status(403).send({ error: 'Dev login disabled in production' });
    }

    const { username } = (req.body as { username?: string }) ?? {};
    const devWallet = `0xdev-${(username ?? 'player').toLowerCase().replace(/\s+/g, '-')}-local`;

    try {
      // Upsert dev user
      const user = await prisma.user.upsert({
        where:  { walletAddress: devWallet },
        update: { username: username ?? 'DevPlayer' },
        create: {
          walletAddress:          devWallet,
          username:               username ?? 'DevPlayer',
          custodialSolanaAddress: `DevSolana${Date.now()}`,
        },
      });

      const accessToken = app.jwt.sign(
        { userId: user.id, walletAddress: user.walletAddress },
        { expiresIn: '24h' },
      );
      const refreshToken = app.jwt.sign(
        { userId: user.id, type: 'refresh' },
        { expiresIn: '7d' },
      );

      return reply.send({
        accessToken,
        refreshToken,
        expiresIn:              86400,
        userId:                 user.id,
        walletAddress:          user.walletAddress,
        custodialSolanaAddress: user.custodialSolanaAddress ?? '',
        isNewUser:              false,
        isDev:                  true,
      });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // ── POST /auth/bot-register ───────────────────────────────────────────────
  // Internal only. Mints a fresh throwaway account (randomly generated
  // wallet address, not a real EVM key) for the agent-bot-service's
  // scheduled agent creation. Unlike /dev-login this is NOT gated by
  // NODE_ENV -- it must keep working in production -- so it's gated by a
  // shared secret instead. Fails closed (503) if the secret isn't
  // configured, so this can never accidentally be left open.
  app.post('/bot-register', async (req, reply) => {
    const expected = process.env.BOT_REGISTRATION_SECRET;
    if (!expected) {
      return reply.status(503).send({ error: 'Bot registration not configured' });
    }

    const provided = req.headers['x-bot-secret'];
    const providedBuf = Buffer.from(typeof provided === 'string' ? provided : '');
    const expectedBuf = Buffer.from(expected);
    const valid = providedBuf.length === expectedBuf.length
      && crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid bot secret' });
    }

    const { label } = (req.body as { label?: string }) ?? {};
    const walletAddress = `0x${crypto.randomBytes(20).toString('hex')}`;

    try {
      const user = await prisma.user.create({
        data: {
          walletAddress,
          username:               `bot-${walletAddress.slice(2, 10)}`,
          custodialSolanaAddress: `BotSolana${Date.now()}${crypto.randomBytes(4).toString('hex')}`,
        },
      });

      const accessToken = app.jwt.sign(
        { userId: user.id, walletAddress: user.walletAddress },
        { expiresIn: '10m' },
      );

      return reply.send({
        accessToken,
        userId:        user.id,
        walletAddress: user.walletAddress,
        label:         label ?? null,
      });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });
}
