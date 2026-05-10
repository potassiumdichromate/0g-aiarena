import { FastifyInstance } from 'fastify';
import { TrainingQueueService, TrainingJobParams } from '../services/training-queue.service';

const queue = new TrainingQueueService();

export async function trainingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', async (req, reply) => {
    const body = req.body as { agentId: string; type?: string; priority?: number; config?: Record<string, unknown> };
    const job = await queue.createJob({
      ...body,
      type: body.type as TrainingJobParams['type'],
    });
    return reply.status(201).send({ job });
  });

  app.get('/', async (req) => {
    const { agentId, status } = req.query as { agentId?: string; status?: string };
    return queue.listJobs(agentId, status);
  });

  app.get('/:jobId', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = await queue.getJob(jobId);
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    return { job };
  });

  app.delete('/:jobId', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    await queue.cancelJob(jobId);
    return { cancelled: true };
  });

  app.get('/agents/:agentId/eligibility', async (req) => {
    const { agentId } = req.params as { agentId: string };
    return queue.checkEligibility(agentId);
  });
}
