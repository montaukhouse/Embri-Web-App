import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const dedupKey = `visited:${ip}`;

  const alreadyVisited = await redis.get(dedupKey);
  if (alreadyVisited) {
    const total = await redis.get('visits:total') || 0;
    return res.status(200).json({ total, counted: false });
  }

  // No expiry — one unique visitor per IP, permanently
  await redis.set(dedupKey, 1);
  const total = await redis.incr('visits:total');

  res.status(200).json({ total, counted: true });
}
