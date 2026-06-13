import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export function jwtMiddleware(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await req.jwtVerify();
    } catch {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  };
}

// ── Optional JWT: reads req.user if token present, doesn't reject if absent ──
export function optionalJwt(app: FastifyInstance) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    try { await req.jwtVerify(); } catch { /* unauthenticated — ok for public reads */ }
  };
}
