// api/manifest.js — the Embri app's settings, personalized so the app opens already unlocked.
//
// On iPhone, a Home Screen app is kept separate from Safari, so it can't see that the
// buyer unlocked the album in Safari. The site points the app's start page at the buyer's
// personal unlock link, so the Embri app opens unlocked the first time.

import { readToken } from './_lib.js';

export default function handler(req, res) {
  const t = String(req.query?.t || '');
  const valid = t && readToken(t);
  const start = valid ? `/?unlock=${encodeURIComponent(t)}&app=1#listen` : '/?app=1#listen';

  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(JSON.stringify({
    id: '/?app=1',
    name: 'Embri',
    short_name: 'Embri',
    description: 'Evil Innocence by Embri',
    start_url: start,
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#111111',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  }));
}
