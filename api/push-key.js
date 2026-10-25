// GET /api/push-key — the public half of the push key, for the phone to subscribe.
const { getDb, getVapid } = require('./_lib');
let cached = null;
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'not-configured' });
  try {
    if (!cached) cached = (await getVapid(db)).publicKey;
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).json({ publicKey: cached });
  } catch (e) { console.error('push-key failed', e && e.message); return res.status(500).json({ error: 'server' }); }
};
