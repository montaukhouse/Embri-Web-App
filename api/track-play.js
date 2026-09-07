import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const dedupKey = `played:${trackId}:${ip}`;

  const alreadyPlayed = await redis.get(dedupKey);
  if (alreadyPlayed) {
    const total = await redis.get(`plays:${trackId}`) || 0;
    return res.status(200).json({ trackId, total, counted: false });
  }

  // No expiry — one unique listen per IP per track, permanently
  await redis.set(dedupKey, 1);
  const total = await redis.incr(`plays:${trackId}`);
  await redis.incr('plays:total');

  res.status(200).json({ trackId, total, counted: true });
}
