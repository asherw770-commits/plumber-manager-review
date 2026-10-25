// GET /api/address — Israeli cities and streets for the customers' order form (1.10).
// Source: the government street register on data.gov.il (CKAN datastore).
//   ?type=city&q=ירוש            → [{name, code}]
//   ?type=street&code=3000&q=בן  → [{name}]
// The whole city list (≈1,300 rows) and each city's streets are fetched once
// per server instance and matched here — one upstream call per city per day,
// and the page never talks to data.gov.il itself (CSP: connect-src 'self').
const CITIES = '5c78e9fa-c2e2-4771-93ff-7f400a12f7ba';
const STREETS = 'a7296d1a-f8c9-4b70-96c2-6ebb4352f8e3';
const BASE = 'https://data.gov.il/api/3/action/datastore_search';
const TTL = 24 * 3600 * 1000;
const cache = new Map(); // key → { at, items }

const norm = s => String(s || '').replace(/[֑-ׇ]/g, '').replace(/["'׳״׳״`]/g, '').replace(/\s+/g, ' ').trim();

async function ckan(params) {
  const u = BASE + '?' + new URLSearchParams(params).toString();
  const r = await fetch(u, { headers: { 'User-Agent': 'plumber-manager/1.0' }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('upstream ' + r.status);
  const j = await r.json();
  if (!j.success) throw new Error('upstream not ok');
  return j.result.records || [];
}
async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.items;
  const items = await loader();
  if (items.length) { if (cache.size > 400) cache.clear(); cache.set(key, { at: Date.now(), items }); }   // empty answers are not remembered; the map cannot grow without bound
  return items;
}
const cities = () => cached('cities', async () => {
  const rows = await ckan({ resource_id: CITIES, limit: 5000, fields: 'סמל_ישוב,שם_ישוב' });
  return rows.map(r => ({ name: String(r['שם_ישוב'] || '').trim(), code: String(r['סמל_ישוב'] || '').trim() })).filter(c => c.name && c.code);
});
const streets = code => cached('streets:' + code, async () => {
  const rows = await ckan({ resource_id: STREETS, filters: JSON.stringify({ 'סמל_ישוב': Number(code) }), limit: 10000, fields: 'שם_רחוב' });
  const seen = new Set();
  return rows.map(r => String(r['שם_רחוב'] || '').trim()).filter(n => n && !seen.has(n) && seen.add(n)).map(name => ({ name }));
});
// Streets in the register are often surname-first ("בן יאיר אלעזר") and people
// type "פנחס בן יאיר" or "רח' בן יאיר" — so rank by how many typed words are
// prefixes of the name's words, in any order; a full prefix match ranks first.
const STRIP = /^(רחוב|רח'|רח׳|רח|שדרות|שד'|שד׳|שד|סמטת|סמ'|דרך|כיכר)\s+/;
function match(items, q, limit) {
  const nq = norm(q).replace(STRIP, '');
  if (!nq) return items.slice(0, limit);
  const words = nq.split(' ').filter(Boolean);
  const scored = [];
  for (const it of items) {
    const n = norm(it.name), nw = n.split(' ');
    let score = 0;
    if (n.startsWith(nq)) score = 1000;
    else if (n.includes(nq)) score = 500;
    else {
      const hits = words.filter(w => w.length >= 2 && nw.some(x => x.startsWith(w))).length;
      if (!hits || (words.length > 1 && hits < Math.min(2, words.length))) continue;
      score = hits * 10 - nw.length; // more typed words matched, shorter names first
    }
    scored.push([score, it]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name, 'he')).slice(0, limit).map(x => x[1]);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const type = String(req.query.type || ''), q = String(req.query.q || '').slice(0, 40), code = String(req.query.code || '').replace(/\D/g, '').slice(0, 6);
  const ok = () => res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
  try {
    if (type === 'city') { const out = match(await cities(), q, 8); ok(); return res.status(200).json({ items: out }); }
    if (type === 'street' && code) {
      // only codes that exist in the city list reach the upstream service
      if (!(await cities()).some(c => c.code === code)) return res.status(400).json({ error: 'params' });
      const out = match(await streets(code), q, 8); ok(); return res.status(200).json({ items: out });
    }
    return res.status(400).json({ error: 'params' });
  } catch (e) {
    console.error('address lookup failed', e && e.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ items: [], offline: true });
  }
};
