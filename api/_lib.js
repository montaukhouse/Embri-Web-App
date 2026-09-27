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
