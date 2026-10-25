// A creates a job (write lands), the PWA is killed/reopened; C (which has not received A's write yet) saves an unrelated edit
// -> cloud doc is overwritten WITHOUT A's job; A and B treat the job as "deleted elsewhere" (dropStale) -> gone everywhere.
const H=require('./h');
(async()=>{
  const W=new H.World(10,{lat:[100,400],coalesce:true});
  const A=H.makeDevice(W,'A','admin'),B=H.makeDevice(W,'B','admin'),C=H.makeDevice(W,'C','admin');
  for(const d of [A,B,C]) await W.go(H.boot(d));
  // C owns a row so it has something to edit
  const c0={id:'c0',type:'income',customer:'c0',total:100,date:'2026-10-01',work:'w',notes:'',whoseCustomer:'mine'}; C.app.applyTxStage(c0,'unpaid'); C.app.state.tx.push(c0);
  await W.go(C.app.saveState()); await W.advance(30000);
  // A creates R and saves; write lands at the server
  const r={id:'R',type:'income',customer:'real job',total:900,date:'2026-10-01',work:'w',notes:'',whoseCustomer:'mine'}; A.app.applyTxStage(r,'unpaid'); A.app.state.tx.push(r);
  A.app.saveState(); await W.advance(60);
  // C edits a note ~now (before C's listener got A's write) -> blind full-doc write, lands after A's
  C.app.state.tx[0].notes='edit on C'; C.app.saveState();
  // A's PWA is evicted and reopened a few seconds later (iOS)
  await W.advance(1500); H.closeApp(A); await W.advance(3000); await W.go(H.boot(A)); 
  await W.advance(120000);
  for(const d of [A,B,C]) console.log(d.name,'rows:',d.app.state.tx.map(x=>x.id).join(','));
  console.log('cloud rows:',(H.cloudDoc(W).tx||[]).map(x=>x.id).join(','));
})();
