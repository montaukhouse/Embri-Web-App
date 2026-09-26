// api/unlock.js — album access for buyers
//
//   { action: "check",   token }              -> is this unlock token real? returns the buyer's share code
//   { action: "session", session_id, ref }    -> right after Stripe checkout: confirms the album was paid for,
//                                                returns an unlock token, and credits the sharer (ref) with the sale
//   { action: "songs",   token }              -> gives a buyer the full song files
//   { action: "legacy" }                       -> grandfathers a browser that was unlocked before the update
//   { action: "restore", email }               -> if that email bought the album (per Stripe), emails them their link
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
import { TRACKS, makeToken, readToken, shareCode, clientIp } from './_lib.js';

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
  const link = `${SITE}/?unlock=${encodeURIComponent(makeToken(email))}#listen`;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Embri', email: process.env.ALBUM_EMAIL_SENDER },
      to: [{ email }],
      subject: 'Your Evil Innocence album link 🖤',
      htmlContent: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111">
          <h2 style="margin:0 0 12px">Here's your album 🖤</h2>
          <p>Tap the button below on any phone, tablet, or computer to listen to all 12 tracks of <b>Evil Innocence</b>.</p>
          <p style="margin:24px 0"><a href="${link}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Listen to the album</a></p>
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
          await redis.incr(`share:sales:${ref}`);
          await redis.incr('share:sales:total');
          await redis.sadd('share:codes', ref);
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
      // One request per email per 10 minutes, so nobody can flood someone's inbox
      const fresh = await redis.set(`restore:${email}`, 1, { nx: true, ex: 600 });
      if (fresh && (await emailBoughtAlbum(email))) await sendAlbumLink(email);
      // Same answer either way, so this can't be used to check who bought
      return res.status(200).json({ ok: true });
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
