// api/unlock.js — album access for buyers
//
//   { action: "check",   token }              -> is this unlock token real? returns the buyer's share code
//   { action: "session", session_id, ref }    -> right after Stripe checkout: confirms the album was paid for,
//                                                returns an unlock token, and credits the sharer (ref) with the sale
//   { action: "songs",   token }              -> gives a buyer the full song files
//   { action: "legacy" }                       -> grandfathers a browser that was unlocked before the update
//   { action: "restore", email, pair }         -> if that email bought the album (per Stripe), emails them their link.
//                                                "pair" = a locked Embri app waiting to be unlocked
//   { action: "approve", token }               -> buyer tapped their email link: unlock any of their apps that are waiting
//   { action: "poll", pair }                   -> the waiting app checks whether it has been unlocked yet
//   { action: "claim", email, device }         -> unlock right away by confirming the purchase email (up to 5 devices per email)
//
// Also needed for "Email me my album link":
//   BREVO_API_KEY       same Brevo key as the Printful-Order-Webhook project
//   ALBUM_EMAIL_SENDER  verified Brevo sender, e.g. hello@embriofficial.com
//
// Environment variables (Vercel > Settings > Environment Variables):
//   UNLOCK_SECRET      same value as in the Printful-Order-Webhook project
//   STRIPE_SECRET_KEY  Stripe secret key (sk_live_...)
//   (Upstash Redis variables are already set up for play tracking)

import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import { TRACKS, makeToken, readToken, shareCode, clientIp, REWARDS, notifyReward } from './_lib.js';

// Buyers who unlocked before the update keep access, with no deadline: the first time their
// browser visits, it's switched to a permanent token. (Optional: set GRANDFATHER_UNTIL to a date to stop this.)
const GRANDFATHER_UNTIL = process.env.GRANDFATHER_UNTIL ? new Date(process.env.GRANDFATHER_UNTIL) : null;
const SITE = process.env.SITE_URL || 'https://embriofficial.com';

const redis = Redis.fromEnv();

async function rememberSharer(email) {
  const code = shareCode(email);
  await redis.hset('share:who', { [code]: email });
  return code;
}

async function getStripeSession(id) {
  const r = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}?expand[]=line_items`,
    { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
  );
  if (!r.ok) return null;
  return r.json();
}

// Did this email buy the album? Checks Stripe's completed checkouts.
async function emailBoughtAlbum(email) {
  const auth = { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } };
  const matches = (s) => s.payment_status === 'paid' && isAlbum(s) &&
    (s.customer_details?.email || '').toLowerCase() === email;
  // Fast path: ask Stripe for this customer's email directly
  const q = new URLSearchParams({ 'customer_details[email]': email, status: 'complete', limit: '100' });
  q.append('expand[]', 'data.line_items');
  let r = await fetch(`https://api.stripe.com/v1/checkout/sessions?${q}`, auth);
  if (r.ok) {
    const list = await r.json();
    if (list.data.some(matches)) return true;
  }
  // Fallback: scan recent completed checkouts (covers different capitalization of the email)
  let after = '';
  for (let page = 0; page < 5; page++) {
    const q2 = new URLSearchParams({ status: 'complete', limit: '100' });
    q2.append('expand[]', 'data.line_items');
    if (after) q2.set('starting_after', after);
    r = await fetch(`https://api.stripe.com/v1/checkout/sessions?${q2}`, auth);
    if (!r.ok) return false;
    const list = await r.json();
    if (list.data.some(matches)) return true;
    if (!list.has_more || !list.data.length) return false;
    after = list.data[list.data.length - 1].id;
  }
  return false;
}

async function sendAlbumLink(email) {
  const appLink = `${SITE}/?unlock=${encodeURIComponent(makeToken(email))}&install=1#listen`;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Embri', email: process.env.ALBUM_EMAIL_SENDER },
      to: [{ email }],
      subject: 'Your Evil Innocence album 🖤',
      htmlContent: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111">
          <h2 style="margin:0 0 12px">Here's your album 🖤</h2>
          <p>Tap the button below to open all 12 tracks of <b>Evil Innocence</b> and keep them on your phone with the Embri app, even offline.</p>
          <p style="margin:24px 0"><a href="${appLink}" style="display:inline-block;background:#1f8f4e;color:#fff;padding:14px 26px;border-radius:6px;text-decoration:none;font-weight:bold;letter-spacing:1px">Download album</a></p>
          <p style="font-size:13px;color:#666">It's your personal link, so save this email. Questions? Reply to hello@embriofficial.com.</p>
          <p style="font-size:13px;color:#666">— Embri</p>
        </div>`,
    }),
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
}

function isAlbum(session) {
  return (session.line_items?.data || []).some((item) => {
    const name = (item.description || '').toLowerCase().trim();
    return name.includes('album') || name === 'evil innocence';
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};

  try {
    if (body.action === 'check') {
      const email = readToken(body.token);
      if (!email) return res.status(200).json({ ok: false });
      return res.status(200).json({ ok: true, code: await rememberSharer(email) });
    }

    if (body.action === 'session') {
      const id = String(body.session_id || '');
      if (!id.startsWith('cs_')) return res.status(200).json({ ok: false });
      const s = await getStripeSession(id);
      const email = s?.customer_details?.email;
      if (!s || s.payment_status !== 'paid' || !isAlbum(s) || !email) {
        return res.status(200).json({ ok: false });
      }
      const code = await rememberSharer(email);

      // Credit the person whose share link brought this buyer in (once per purchase, never yourself)
      const ref = String(body.ref || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
      if (ref && ref !== code) {
        const first = await redis.set(`share:sale:${id}`, ref, { nx: true });
        if (first) {
          const sales = await redis.incr(`share:sales:${ref}`);
          await redis.incr('share:sales:total');
          await redis.sadd('share:codes', ref);
          if (sales === REWARDS.bagSales) await notifyReward(redis, ref, 'bag');
        }
      }
      return res.status(200).json({ ok: true, token: makeToken(email), code });
    }

    if (body.action === 'legacy') {
      if (GRANDFATHER_UNTIL && Date.now() > GRANDFATHER_UNTIL.getTime()) return res.status(200).json({ ok: false });
      // Same person/network asking again gets the same pass, so the count stays honest
      const ipKey = `legacy:ip:${clientIp(req)}`;
      let id = await redis.get(ipKey);
      if (!id) {
        id = 'early-buyer-' + crypto.randomBytes(5).toString('hex');
        await redis.set(ipKey, id);
        await redis.incr('legacy:grants');
      }
      const code = shareCode(id);
      await redis.hset('share:who', { [code]: 'Early buyer (grandfathered)' });
      return res.status(200).json({ ok: true, token: makeToken(id), code });
    }

    if (body.action === 'restore') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email' });
      // A locked Embri app is waiting: remember it, so tapping ANY album link for this email unlocks it
      const pair = String(body.pair || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
      if (pair.length >= 16) {
        await redis.set(`pair:${pair}`, 'pending', { ex: 1800 });
        await redis.sadd(`pairs:${email}`, pair);
        await redis.expire(`pairs:${email}`, 1800);
      }
      // One email every 2 minutes per address, so nobody can flood someone's inbox
      const fresh = await redis.set(`restore:${email}`, 1, { nx: true, ex: 120 });
      if (fresh && (await emailBoughtAlbum(email))) await sendAlbumLink(email);
      // Same answer either way, so this can't be used to check who bought
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'approve') {
      const email = readToken(body.token);
      if (!email) return res.status(200).json({ ok: false });
      const pairs = (await redis.smembers(`pairs:${email}`)) || [];
      let approved = 0;
      for (const p of pairs) {
        if ((await redis.get(`pair:${p}`)) === 'pending') {
          await redis.set(`pair:${p}`, body.token, { ex: 1800 });
          approved++;
        }
      }
      await redis.del(`pairs:${email}`);
      return res.status(200).json({ ok: true, approved });
    }

    if (body.action === 'poll') {
      const pair = String(body.pair || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
      const v = pair ? await redis.get(`pair:${pair}`) : null;
      const email = v && v !== 'pending' ? readToken(v) : null;
      if (!email) return res.status(200).json({ ok: false });
      await redis.del(`pair:${pair}`);
      return res.status(200).json({ ok: true, token: v, code: await rememberSharer(email) });
    }

    if (body.action === 'claim') {
      const email = String(body.email || '').trim().toLowerCase();
      const device = String(body.device || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(200).json({ ok: false, error: 'Enter a valid email' });
      // Slow down guessing: 15 tries per hour per network
      const ipKey = `claimtries:${clientIp(req)}`;
      const tries = await redis.incr(ipKey);
      if (tries === 1) await redis.expire(ipKey, 3600);
      if (tries > 15) return res.status(200).json({ ok: false, error: 'Too many tries. Please wait a bit and try again.' });
      if (!(await emailBoughtAlbum(email))) {
        return res.status(200).json({ ok: false, error: 'We couldn\u2019t find an album purchase for that email. Use the email you paid with.' });
      }
      // Each buyer's email can unlock up to 5 devices this way (their emailed link always works)
      if (device.length >= 16) {
        const devKey = `devices:${email}`;
        const known = await redis.sismember(devKey, device);
        if (!known) {
          const count = await redis.scard(devKey);
          if (count >= 5) return res.status(200).json({ ok: false, error: 'This email is already unlocked on 5 devices. Use the Download album link in your purchase email.' });
          await redis.sadd(devKey, device);
        }
      }
      return res.status(200).json({ ok: true, token: makeToken(email), code: await rememberSharer(email) });
    }

    if (body.action === 'songs') {
      if (!readToken(body.token)) return res.status(403).json({ ok: false });
      const urls = Object.fromEntries(Object.entries(TRACKS).map(([slug, t]) => [slug, t.url]));
      return res.status(200).json({ ok: true, urls });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false });
  }
}
