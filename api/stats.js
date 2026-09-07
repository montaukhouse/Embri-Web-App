import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const TRACKS = ['Wasting Time','Sushi & Soju','Damaged Goods','Like This','Please',
  'Black Hole','Honesty','Let It Go','Twisted','Pain','Tell Me','Got Your Back'];

export default async function handler(req, res) {
  const keys = TRACKS.map(t => `plays:${t}`);
  const values = await redis.mget(...keys);
  const stats = Object.fromEntries(TRACKS.map((t, i) => [t, values[i] || 0]));
  const total = await redis.get('plays:total') || 0;

  res.status(200).json({ stats, total });
}
