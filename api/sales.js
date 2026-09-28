// api/sales.js — real sales numbers from Stripe for the admin page (password protected)
//
// Header: x-admin-password  (same ADMIN_PASSWORD as the Shares tab)
// Uses STRIPE_SECRET_KEY (already set).

const isAlbumName = (n) => /album/i.test(n) || n.trim().toLowerCase() === 'evil innocence';

function field(session, key) {
  const f = (session.custom_fields || []).find((x) => x.key === key || x.label?.custom === key);
  if (!f) return '';
  if (f.dropdown) return f.dropdown.options?.find((o) => o.value === f.dropdown.value)?.label || f.dropdown.value || '';
  return f.text?.value || '';
}

export default async function handler(req, res) {
  const pw = req.headers['x-admin-password'];
  if (!process.env.ADMIN_PASSWORD || pw !== process.env.ADMIN_PASSWORD) return res.status(401).json({ ok: false });

  try {
    const auth = { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } };
    const orders = [];
    let after = '';
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ status: 'complete', limit: '100' });
      q.append('expand[]', 'data.line_items');
      if (after) q.set('starting_after', after);
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions?${q}`, auth);
      if (!r.ok) throw new Error('Stripe ' + r.status);
      const list = await r.json();
      for (const s of list.data) {
        if (s.payment_status !== 'paid') continue;
        const items = (s.line_items?.data || []).map((i) => ({ name: i.description || '', qty: i.quantity || 1 }));
        const album = items.some((i) => isAlbumName(i.name));
        orders.push({
          date: new Date(s.created * 1000).toISOString(),
          email: s.customer_details?.email || '',
          item: items.map((i) => i.name).join(', ') || 'Order',
          size: [field(s, 'color') || field(s, 'Color'), field(s, 'size') || field(s, 'Size')].filter(Boolean).join(' '),
          amount: (s.amount_total || 0) / 100,
          discount: (s.total_details?.amount_discount || 0) / 100,
          type: album ? 'album' : 'merch',
          qty: items.reduce((n, i) => n + i.qty, 0),
        });
      }
      if (!list.has_more || !list.data.length) break;
      after = list.data[list.data.length - 1].id;
    }

    const sum = (a) => Math.round(a.reduce((n, o) => n + o.amount, 0) * 100) / 100;
    const albums = orders.filter((o) => o.type === 'album');
    const merch = orders.filter((o) => o.type === 'merch');
    res.status(200).json({
      ok: true,
      revenue: sum(orders),
      albumRevenue: sum(albums),
      merchRevenue: sum(merch),
      albumsSold: albums.reduce((n, o) => n + o.qty, 0),
      merchSold: merch.reduce((n, o) => n + o.qty, 0),
      orders, // newest first
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
}
