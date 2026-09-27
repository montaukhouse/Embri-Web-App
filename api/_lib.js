// api/_lib.js — shared helpers (the underscore means Vercel doesn't treat this as its own endpoint)
import crypto from 'crypto';

// Full song files. These live only on the server now, so they are not visible in the page code.
// Only buyers with a valid unlock token are given the locked songs.
export const TRACKS = {
  'wasting-time':  { name: 'Wasting Time',  free: true,  url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660150/Wasting_Time.mp3' },
  'sushi-soju':    { name: 'Sushi & Soju',  free: true,  url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660144/Sushi_Soju.mp3' },
  'damaged-goods': { name: 'Damaged Goods', free: false, url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660134/Damaged_Goods.mp3' },
  'like-this':     { name: 'Like This',     free: false, url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660134/Like_This.mp3' },
  'please':        { name: 'Please',        free: false, url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660149/Please.mp3' },
  'black-hole':    { name: 'Black Hole',    free: false, url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660143/Black_Hole.mp3' },
  'honesty':       { name: 'Honesty',       free: false, url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660141/Honesty.mp3' },
  'let-it-go':     { name: 'Let It Go',     free: false, url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660134/Let_It_Go.mp3' },
  'twisted':       { name: 'Twisted',       free: false, url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660150/Twisted.mp3' },
  'pain':          { name: 'Pain',          free: false, url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660144/Pain.mp3' },
  'tell-me':       { name: 'Tell Me',       free: false, url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660154/Tell_Me.mp3' },
  'got-your-back': { name: 'Got Your Back', free: false, url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1788660142/Got_Your_Back.mp3' },
};

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hmac(text) {
  return crypto.createHmac('sha256', process.env.UNLOCK_SECRET).update(text).digest();
}

// Unlock token = the buyer's email + a signature. Same format the Stripe webhook emails out.
export function makeToken(email) {
  const e = email.trim().toLowerCase();
  return `${b64url(e)}.${b64url(hmac(e))}`;
}
export function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  let email;
  try {
    email = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const good = b64url(hmac(email));
  if (sig.length !== good.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) ? email : null;
}


// Short personal share code for a buyer, e.g. "k3f9x2ab". Doesn't reveal their email.
export function shareCode(email) {
  return b64url(hmac('share:' + email.trim().toLowerCase())).replace(/[-_]/g, '').slice(0, 8).toLowerCase();
}

export function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
}

// ---------- Share rewards ----------
// 1 friend opens your link  -> exclusive bonus voice track
// 3 friends open your link  -> $3 off merch (one-time code)
// 2 friends buy the album   -> free goodie bag (pins, sticker, lyric card), shipped by Printful
export const REWARDS = { memoOpens: 1, discountOpens: 3, bagSales: 2 };
export const BONUS_MEMO = {
  name: 'Wasting Time — Exclusive Bonus Voice Track',
  url: 'https://res.cloudinary.com/yyq1iype/video/upload/v1790544358/bonus-voice-memo.mp3',
};
// Printful "External ID"s of the goodie bag items (shown with a # in Printful)
export const GOODIE_BAG_ITEMS = ['6ab96b5f093913', '6ab9677e5bb437', '6ab97441825788'];

export const SITE = process.env.SITE_URL || 'https://embriofficial.com';

export async function sendEmail({ to, subject, html }) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Embri', email: process.env.ALBUM_EMAIL_SENDER },
      to: [{ email: to }],
      subject,
      htmlContent: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111">${html}<p style="font-size:13px;color:#666">— Embri</p></div>`,
    }),
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
}

const REWARD_EMAILS = {
  memo: ['You unlocked an exclusive bonus voice track 🖤', 'Someone opened the song you shared. As a thank you, there’s an exclusive bonus voice track from me waiting for you.'],
  discount: ['You unlocked $3 off merch 🖤', 'Three friends opened your link. Your one-time $3 off merch code is waiting for you.'],
  bag: ['You earned a free Embri goodie bag 🖤', 'Two friends bought Evil Innocence through your link. Your goodie bag is ready. Add your address and it ships free.'],
};

// Emails a buyer when they reach a reward. Guests have no email on file, so they see it on the site instead.
export async function notifyReward(redis, code, kind) {
  try {
    const email = await redis.hget('share:who', code);
    if (!email || !String(email).includes('@')) return;
    const first = await redis.set(`rewards:notified:${kind}:${code}`, 1, { nx: true });
    if (!first) return;
    const [subject, text] = REWARD_EMAILS[kind];
    const link = `${SITE}/?unlock=${encodeURIComponent(makeToken(String(email)))}&rewards=1#listen`;
    await sendEmail({
      to: String(email),
      subject,
      html: `<h2 style="margin:0 0 12px">${subject}</h2><p>${text}</p>
        <p style="margin:24px 0"><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:14px 26px;border-radius:6px;text-decoration:none;font-weight:bold;letter-spacing:1px">See my rewards</a></p>`,
    });
  } catch (err) {
    console.error('Reward email failed', err);
  }
}
