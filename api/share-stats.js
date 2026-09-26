// api/share-stats.js — share numbers for the admin page (password protected, since it lists buyer emails)
//
// Environment variable:
//   ADMIN_PASSWORD  the password you type on admin.html

import { Redis } from '@upstash/redis';
import { TRACKS } from './_lib.js';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  const pw = req.headers['x-admin-password'];
  if (!process.env.ADMIN_PASSWORD || pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false });
  }

  try {
    const codes = (await redis.smembers('share:codes')) || [];
    const who = (await redis.hgetall('share:who')) || {};
    const trackCounts = (await redis.hgetall('share:tracks')) || {};

    let sharers = [];
    if (codes.length) {
      const shares = await redis.mget(...codes.map((c) => `share:shares:${c}`));
      const opens = await redis.mget(...codes.map((c) => `share:opens:${c}`));
      const sales = await redis.mget(...codes.map((c) => `share:sales:${c}`));
      sharers = codes.map((c, i) => ({
        code: c,
        who: who[c] || (c.startsWith('g') && c.length > 8 ? 'Guest (not a buyer)' : 'Unknown'),
        shares: Number(shares[i] || 0),
        opens: Number(opens[i] || 0),
        sales: Number(sales[i] || 0),
      }));
      sharers.sort((a, b) => b.sales - a.sales || b.opens - a.opens || b.shares - a.shares);
    }

    const songs = Object.entries(trackCounts)
      .map(([slug, n]) => ({ song: TRACKS[slug]?.name || 'Whole album', shares: Number(n) }))
      .sort((a, b) => b.shares - a.shares);

    const [shares, opens, sales, legacy] = await redis.mget('share:shares:total', 'share:opens:total', 'share:sales:total', 'legacy:grants');

    res.status(200).json({
      ok: true,
      totals: {
        shares: Number(shares || 0),
        opens: Number(opens || 0),
        sales: Number(sales || 0),
        sharers: sharers.filter((s) => s.shares > 0).length,
        grandfathered: Number(legacy || 0),
      },
      sharers,
      songs,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
}
