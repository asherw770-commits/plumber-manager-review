#!/usr/bin/env node
/* Fictional sample books in the same shape as the app's JSON backup — no real customer, address or phone appears here.
 * Used by the tests when the real backup is not on the machine, and by the UI harness (tests/ui-harness/README.md).
 *   node tests/sample-data.js sample-backup.json [rows=240] [seed=7]
 * The data is deterministic for a given seed: my customers and partners' customers, full / partial / unpaid / scheduled / cancelled jobs, receipts,
 * expenses, tasks, a price list, a catalog and one partner settlement, spread over the last ~4 months before `today`. */
const fs = require('fs');

function sampleBackup(rows = 240, seed = 7, today = new Date()) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const dayAgo = n => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d); };
  const firsts = ['דוד', 'משה', 'יוסי', 'רבקה', 'שרה', 'אברהם', 'חיים', 'נעמי', 'רות', 'אלי'], lasts = ['כהן', 'לוי', 'פרידמן', 'שפירא', 'ברק', 'סגל', 'אדלר', 'גולן'];
  const streets = ['הרצל', 'הגפן', 'הדקל', 'האלון', 'ירושלים', 'הזית', 'התמר'], works = ['סתימת מטבח', 'סתימת אמבטיה', 'איתור נזילה', 'החלפת דוד', 'החלפת ברז', 'החלפת מערבל', 'תיקון ניאגרה', 'חבית 1,500 ליטר', 'סתימה ראשית', 'התקנת סיפון'];
  const partners = ['אהרן', 'שלמה'], methods = ['מזומן', 'ביט', 'העברה', 'אשראי'], cats = ['דלק', 'חומרים', 'כלי עבודה', 'רכב', 'שונות'];
  const tx = [], tasks = [];
  for (let i = 0; i < rows; i++) {
    const date = dayAgo(Math.floor(rnd() * 120)), id = 'sx' + i.toString(36) + Math.floor(rnd() * 1e6).toString(36);
    if (rnd() < 0.15) {   // expense
      const total = Math.round((50 + rnd() * 900) / 10) * 10;
      tx.push({ id, type: 'expense', stage: 'paid', status: 'paid', lifecycleStatus: 'paid', ownership: 'expense', date, paidDate: date, total, category: pick(cats), work: 'הוצאה', customer: '', phone: '', address: '', notes: '', materials: 0, hours: 0, partnerName: '', partnerAmount: 0, payment: pick(methods), noVat: true });
      continue;
    }
    const partnerCustomer = rnd() < 0.15, withPartner = !partnerCustomer && rnd() < 0.2, total = Math.round((250 + rnd() * 3500) / 50) * 50;
    const stage = pick(['paid', 'paid', 'paid', 'paid', 'unpaid', 'unpaid', 'partial', 'scheduled', 'cancelled']);
    const t = { id, type: 'income', stage, date, total, work: pick(works), customer: partnerCustomer ? '' : pick(firsts) + ' ' + pick(lasts), phone: partnerCustomer || rnd() < 0.1 ? '' : '05' + String(Math.floor(rnd() * 1e8)).padStart(8, '0'),
      address: partnerCustomer ? '' : pick(streets) + ' ' + (1 + Math.floor(rnd() * 40)), notes: '', materials: rnd() < 0.3 ? Math.round(rnd() * 400) : 0, hours: rnd() < 0.6 ? pick([0.5, 1, 1.5, 2, 3]) : 0,
      whoseCustomer: partnerCustomer ? 'partner' : 'mine', partnerName: partnerCustomer || withPartner ? pick(partners) : '', partnerAmount: partnerCustomer ? Math.round(total * 0.5) : withPartner ? Math.round(total * 0.4) : 0,
      payment: '', paidAmount: 0, noVat: true, ownership: partnerCustomer ? 'partner' : 'mine', category: '' };
    if (stage === 'paid') { t.paidDate = iso(new Date(new Date(date).getTime() + Math.floor(rnd() * 12) * 864e5)); t.payment = pick(methods); t.receipts = [{ at: Date.parse(t.paidDate), date: t.paidDate, amount: total, method: t.payment }]; if (partnerCustomer) t.partnerCollected = rnd() < 0.7; }
    if (stage === 'partial') { t.paidAmount = Math.round(total * (0.3 + rnd() * 0.4)); t.paidDate = date; t.payment = pick(methods); t.receipts = [{ at: Date.parse(date), date, amount: t.paidAmount, method: t.payment }]; }
    t.status = stage === 'paid' ? 'paid' : stage === 'partial' ? 'partial' : 'unpaid'; t.lifecycleStatus = stage === 'paid' ? 'paid' : stage;
    tx.push(t);
    if (rnd() < 0.4) tasks.push({ id: 'sk' + id, kind: 'work', task: t.work, customer: t.customer, phone: t.phone, address: t.address, status: stage === 'scheduled' ? 'open' : 'done', deadline: stage === 'scheduled' ? dayAgo(-Math.floor(rnd() * 10)) : '', cost: total, partnerName: t.partnerName, partnerAmount: t.partnerAmount, linkedTxId: id, notes: '' });
  }
  const priceList = [['סתימות', 'סתימת מטבח', 350], ['סתימות', 'סתימה ראשית', 600], ['דודים', 'החלפת דוד', 900], ['ברזים', 'החלפת ברז', 250], ['חביות שבת', 'חבית 1,500 ליטר', 1450]].map(([category, name, price], i) => ({ id: 'pl_' + i, order: i, category, name, price, priceMax: 0, note: '' }));
  return {
    exportedAt: Date.now(), exportedBy: 'sample@example.com', version: 1, tx, tasks, customerMeta: {}, whatsappInbox: [], dailyNotes: {}, priceList, priceListSeeded: true,
    products: [{ id: 'sp1', name: 'סתימת מטבח', category: '', sellPrice: 350, costPrice: 0, isBundle: false, bundleItems: [], archivedAt: null }],
    settlements: [{ id: 'ss1', partnerName: 'אהרן', direction: 'toPartner', amount: 500, date: dayAgo(20), method: 'העברה', note: '', txIds: [] }], _deletedIds: [], _deletedAt: {}
  };
}
module.exports = { sampleBackup };
if (require.main === module) {
  const out = process.argv[2] || 'sample-backup.json';
  fs.writeFileSync(out, JSON.stringify(sampleBackup(Number(process.argv[3]) || 240, Number(process.argv[4]) || 7), null, 1));
  console.log('wrote ' + out);
}
