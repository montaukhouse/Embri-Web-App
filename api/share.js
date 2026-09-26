// api/share.js — records shares and link opens
//   { event: "share", code, track }  someone tapped Share on a song (or the album)
//   { event: "open",  code, track }  someone opened a shared link (counted once per person per sharer)

import { Redis } from '@upstash/redis';
import { TRACKS, clientIp } from './_lib.js';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { event } = req.body || {};
  const code = String(req.body?.code || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  const track = TRACKS[req.body?.track] ? req.body.track : 'album';
  if (!code || !['share', 'open'].includes(event)) return res.status(400).json({ ok: false });

  try {
    await redis.sadd('share:codes', code);

    if (event === 'share') {
      await redis.incr(`share:shares:${code}`);
      await redis.incr('share:shares:total');
      await redis.hincrby('share:tracks', track, 1);
      return res.status(200).json({ ok: true });
    }

    // Opens: one per person (IP) per sharer, no expiry — same approach as play counts
    const first = await redis.set(`share:opened:${code}:${clientIp(req)}`, 1, { nx: true });
    if (first) {
      await redis.incr(`share:opens:${code}`);
      await redis.incr('share:opens:total');
    }
    return res.status(200).json({ ok: true, counted: !!first });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false });
  }
}
