// api/rewards.js — share rewards
//
//   { action: "status", token, guest, key }        -> progress + any rewards unlocked
//   { action: "claim",  token, guest, key, ship }   -> ships the goodie bag through Printful (once per person)
//
// Who is asking is proven by either:
//   token        a buyer's unlock token (their share code comes from their email), or
//   guest + key  a guest's share code plus the private key only their browser has
//                (the share code is public in their links, so the key is what stops friends claiming their rewards)
//
// Environment variables (Vercel > Settings > Environment Variables):
//   STRIPE_SECRET_KEY, BREVO_API_KEY, ALBUM_EMAIL_SENDER   already set
//   PRINTFUL_API_KEY   NEW: same value as in the Printful-Order-Webhook project

import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import { readToken, shareCode, REWARDS, BONUS_MEMO, GOODIE_BAG_ITEMS, sendEmail } from './_lib.js';

const redis = Redis.fromEnv();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const cleanCode = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);

// ---------- identity ----------
async function whoIsAsking(body) {
  const codes = [];
  let email = null;
  const fromToken = readToken(body.token);
  if (fromToken) {
    email = fromToken;
    codes.push(shareCode(fromToken));
  }
  const guest = cleanCode(body.guest);
  const key = String(body.key || '');
  if (guest.startsWith('g') && key.length >= 20) {
    // First browser to show up with a key for this guest code owns it
    const hash = sha('guest:' + key);
    await redis.set(`guestkey:${guest}`, hash, { nx: true });
    if ((await redis.get(`guestkey:${guest}`)) === hash) codes.push(guest);
  }
  return { codes, email: email && email.includes('@') ? email : null };
}

async function progress(codes) {
  if (!codes.length) return { opens: 0, sales: 0 };
  const opens = await redis.mget(...codes.map((c) => `share:opens:${c}`));
  const sales = await redis.mget(...codes.map((c) => `share:sales:${c}`));
  const sum = (a) => a.reduce((n, v) => n + Number(v || 0), 0);
  return { opens: sum(opens), sales: sum(sales) };
}

// ---------- Stripe discount codes ----------
// Pinned API version so these create calls keep working the same way
async function stripe(method, path, params) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-06-20',
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Stripe ${path}: ${d.error?.message || r.status}`);
  return d;
}

// Every active product except the album (so codes only work on merch)
async function merchProductIds() {
  const list = await stripe('GET', 'products?active=true&limit=100');
  return list.data.filter((p) => !/album/i.test(p.name)).map((p) => p.id);
}

async function couponId(cacheKey, fields) {
  const cached = await redis.get(cacheKey);
  if (cached) return cached;
  const params = new URLSearchParams(fields);
  (await merchProductIds()).forEach((id) => params.append('applies_to[products][]', id));
  const c = await stripe('POST', 'coupons', params);
  await redis.set(cacheKey, c.id);
  return c.id;
}

// The 15% code printed on the goodie bag card. Created once, automatically.
async function ensureGoodieBagCode() {
  if (await redis.get('rewards:goodiebag15')) return;
  const existing = await stripe('GET', 'promotion_codes?code=GOODIEBAG15&limit=1');
  if (!existing.data.length) {
    const coupon = await couponId('rewards:coupon:15pct', { percent_off: '15', duration: 'once', name: 'Goodie bag: 15% off merch' });
    await stripe('POST', 'promotion_codes', { coupon, code: 'GOODIEBAG15' });
  }
  await redis.set('rewards:goodiebag15', 1);
}

// A one-time $3 off merch code for this person
async function discountCode(primary) {
  const saved = await redis.get(`rewards:discount:${primary}`);
  if (saved) return saved;
  const lock = await redis.set(`rewards:discount:lock:${primary}`, 1, { nx: true, ex: 30 });
  if (!lock) return null; // being created by another request right now
  const coupon = await couponId('rewards:coupon:3off', { amount_off: '300', currency: 'usd', duration: 'once', name: 'Share reward: $3 off merch' });
  const code = 'SHARE' + crypto.randomBytes(3).toString('hex').toUpperCase();
  await stripe('POST', 'promotion_codes', { coupon, code, max_redemptions: '1' });
  await redis.set(`rewards:discount:${primary}`, code);
  return code;
}

// ---------- goodie bag ----------
async function bagClaimed(codes) {
  const v = await redis.mget(...codes.map((c) => `rewards:bag:${c}`));
  return v.some(Boolean);
}

function cleanShip(s = {}) {
  const t = (v, n) => String(v || '').trim().slice(0, n);
  return {
    name: t(s.name, 80),
    email: t(s.email, 120).toLowerCase(),
    address1: t(s.address1, 120),
    address2: t(s.address2, 120),
    city: t(s.city, 60),
    state_code: t(s.state, 3).toUpperCase(),
    zip: t(s.zip, 12),
    country_code: t(s.country, 2).toUpperCase(),
  };
}

async function shipBag(ship) {
  const r = await fetch('https://api.printful.com/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PRINTFUL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: ship,
      items: GOODIE_BAG_ITEMS.map((id) => ({ external_variant_id: id, quantity: 1 })),
      packing_slip: { message: 'Your Embri goodie bag. Thank you for sharing my music! It may arrive in a few packages.' },
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Printful: ' + JSON.stringify(d.error || d.result || d));
  return d.result?.id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};

  try {
    const { codes, email } = await whoIsAsking(body);
    if (!codes.length) return res.status(200).json({ ok: false });
    const primary = codes[0];
    const { opens, sales } = await progress(codes);

    if (body.action === 'status') {
      const out = { ok: true, code: primary, opens, sales, goal: REWARDS, memo: null, discount: null, bag: 'locked' };
      if (opens >= REWARDS.memoOpens) out.memo = BONUS_MEMO;
      if (opens >= REWARDS.discountOpens) {
        try { out.discount = await discountCode(primary); } catch (e) { console.error(e); out.discount = null; }
      }
      if (await bagClaimed(codes)) out.bag = 'claimed';
      else if (sales >= REWARDS.bagSales) out.bag = 'ready';
      out.email = email;
      return res.status(200).json(out);
    }

    if (body.action === 'claim') {
      if (sales < REWARDS.bagSales) return res.status(200).json({ ok: false, error: 'Your goodie bag unlocks when 2 friends buy the album through your link.' });
      const ship = cleanShip(body.ship);
      // Printful needs a state/province for the US, Canada and Australia
      const needsState = ['US', 'CA', 'AU'].includes(ship.country_code);
      if (!ship.name || !ship.address1 || !ship.city || !/^[A-Z]{2}$/.test(ship.country_code) ||
          (needsState && !ship.state_code) || (ship.country_code === 'US' && !/^\d{5}(-\d{4})?$/.test(ship.zip)) ||
          !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ship.email)) {
        return res.status(200).json({ ok: false, error: 'Please fill in every field.' });
      }
      if (!needsState) ship.state_code = ship.state_code || '';
      if (await bagClaimed(codes)) return res.status(200).json({ ok: false, error: 'Your goodie bag is already on its way.' });
      const first = await redis.set(`rewards:bag:${primary}`, JSON.stringify({ ...ship, at: new Date().toISOString() }), { nx: true });
      if (!first) return res.status(200).json({ ok: false, error: 'Your goodie bag is already on its way.' });
      for (const c of codes.slice(1)) await redis.set(`rewards:bag:${c}`, primary);

      let orderId;
      try {
        await ensureGoodieBagCode();
        orderId = await shipBag(ship);
      } catch (err) {
        console.error('Goodie bag failed', err);
        await Promise.all(codes.map((c) => redis.del(`rewards:bag:${c}`)));
        return res.status(200).json({ ok: false, error: 'Something went wrong. Please try again in a minute.' });
      }
      await redis.sadd('rewards:bags', primary);

      const addr = `${ship.name}<br>${ship.address1}${ship.address2 ? '<br>' + ship.address2 : ''}<br>${ship.city}${ship.state_code ? ', ' + ship.state_code : ''} ${ship.zip}<br>${ship.country_code}`;
      await Promise.allSettled([
        sendEmail({
          to: ship.email,
          subject: 'Your Embri goodie bag is on its way 🖤',
          html: `<h2 style="margin:0 0 12px">Thank you for sharing my music 🖤</h2>
            <p>Your goodie bag (pins, a Sushi &amp; Soju sticker, and a handwritten lyric card) is being made now.</p>
            <p>It ships in a few pieces, so watch your mailbox for a few surprises over the next week or two.</p>
            <p style="font-size:13px;color:#666">Shipping to:<br>${addr}</p>`,
        }),
        sendEmail({
          to: process.env.ALBUM_EMAIL_SENDER,
          subject: `Goodie bag earned by ${ship.name}`,
          html: `<p>A fan earned a goodie bag (2 album sales through their link). Printful order ${orderId || '(check Printful)'} was created.</p><p>${addr}<br>${ship.email}</p>`,
        }),
      ]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false });
  }
}
