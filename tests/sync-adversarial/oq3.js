// Owner queue stamps Yehuda's STALE payment state with the row-level _updatedAt (inflated by a field-merge bump) instead of the field's own stamp
// -> it beats Asher's newer "paid".
const H=require('./h');
(async()=>{
  const W=new H.World(1,{lat:[200,200],coalesce:true});
  const A=H.makeDevice(W,'A','admin'), C=H.makeDevice(W,'C','admin'), Y=H.makeDevice(W,'Y','owner');
  for(const d of [A,C,Y]) await W.go(H.boot(d));
  const t={id:'R',type:'income',customer:'job',total:1000,date:'2026-10-01',work:'w',notes:'',whoseCustomer:'mine'}; A.app.applyTxStage(t,'unpaid'); A.app.state.tx.push(t);
  await W.go(A.app.saveState()); await W.advance(20000);
  H.goOffline(Y);                                                    // Yehuda has no reception
  await W.advance(5000);
  const yr=Y.app.state.tx[0]; const prev=Y.app.collectedAmount(yr);
  Y.app.setTxStage(yr,'partial'); yr.paidAmount=100; yr.paidDate='2026-10-01'; Y.app.recordReceipt(yr,prev); Y.app.saveState();   // 09:00 Yehuda: customer paid 100 on account (offline)
  await W.advance(5000);
  C.app.state.tx[0].total=1200; await W.go(C.app.saveState()); await W.advance(20000);                // Yechiel/Asher's other device edits the amount
  // Yehuda gets reception: reconnect merge reads the cloud (total=1200, no full payment yet) -> hybrid row, stamped "now"
  const pOn=H.goOnline(Y);                                           // reconnect: Y reads the cloud (arrives in 200ms)
  await W.advance(100);
  A.app.setTxStage(A.app.state.tx[0],'paid'); A.app.recordReceipt(A.app.state.tx[0],0); A.app.saveState(); await pOn;  // Asher marks it PAID 100ms before Yehuda's read lands (his write lands 100ms after it)
  await W.advance(120000);                                           // Asher's queue tick merges Yehuda's entry
  const f=d=>d.app.state.tx[0].stage+' paidAmount='+d.app.state.tx[0].paidAmount+' total='+d.app.state.tx[0].total;
  console.log('A:',f(A),'| C:',f(C),'| Y:',f(Y),'| cloud:',(()=>{const r=H.cloudDoc(W).tx[0];return r.stage+' paidAmount='+r.paidAmount+' total='+r.total})());
  console.log('queue entry:',JSON.stringify((W.docs.get('state/owner_actions')||{data:{tx:[]}}).data.tx.map(r=>[r.stage,r.paidAmount,r._updatedAt-H.T0,r._fieldAt&&r._fieldAt.stage-H.T0])));
})().catch(e=>console.error(e));
