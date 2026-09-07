import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const TRACKS = ['Wasting Time','Sushi & Soju','Damaged Goods','Like This','Please',
  'Black Hole','Honesty','Let It Go','Twisted','Pain','Tell Me','Got Your Back'];

export default async function handler(req, res) {
  const keys = TRACKS.map(t => `plays:${t}`);
  const values = await redis.mget(...keys);

  const rows = TRACKS.map((title, i) => `"${title}",${values[i] || 0}`);
  const csv = ['Track,Plays', ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="embri-play-stats.csv"');
  res.status(200).send(csv);
}
