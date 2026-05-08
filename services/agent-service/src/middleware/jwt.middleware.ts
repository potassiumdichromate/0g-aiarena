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
