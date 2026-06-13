import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { LeaguePredictionValidationError } from '@ai-arena/shared-utils';
import { NotFoundError, ForbiddenError, ConflictError, BadRequestError } from './errors';
import { NoActiveSeasonError } from './season';
import { EscrowLockError } from './internal';

/** Central mapping from domain errors thrown by services to HTTP responses. */
export function leagueErrorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof NotFoundError) return void reply.status(404).send({ error: err.message });
  if (err instanceof ForbiddenError) return void reply.status(403).send({ error: err.message });
  if (err instanceof ConflictError) return void reply.status(409).send({ error: err.message });
  if (err instanceof BadRequestError) return void reply.status(400).send({ error: err.message });
  if (err instanceof LeaguePredictionValidationError) return void reply.status(400).send({ error: err.message });
  if (err instanceof EscrowLockError) return void reply.status(400).send({ error: err.message });
  if (err instanceof NoActiveSeasonError) return void reply.status(503).send({ error: err.message });

  const statusCode = (err as FastifyError).statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return void reply.status(statusCode).send({ error: err.message });
  }

  req.log.error(err);
  reply.status(500).send({ error: 'internal server error' });
}
