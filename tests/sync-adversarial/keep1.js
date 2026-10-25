// Asher deletes a job and brings it back with Undo (row is alive again, newer than the tombstone); Yehuda's queued payment for it is then discarded
// by _mergeOwnerActions.keep() ("any tombstone => drop"), his phone shows it paid for ever, the cloud/Asher show unpaid.
const H=require('./h');
(async()=>{
  const W=new H.World(2,{lat:[100,200],coalesce:true});
  const A=H.makeDevice(W,'A','admin'), Y=H.makeDevice(W,'Y','owner');
  await W.go(H.boot(A)); await W.go(H.boot(Y));
  const t={id:'X',type:'income',customer:'X',total:500,date:'2026-10-01',work:'w',notes:'',whoseCustomer:'mine'};A.app.applyTxStage(t,'unpaid');A.app.state.tx.push(t); await W.go(A.app.saveState()); await W.advance(20000);
  H.goOffline(A);                                        // Asher's phone is offline (so the queue is not merged yet)
  const yx=Y.app.state.tx[0]; const prev=Y.app.collectedAmount(yx); Y.app.setTxStage(yx,'paid'); Y.app.recordReceipt(yx,prev); await W.go(Y.app.saveState());   // 1. Yehuda: customer paid cash
  await W.advance(5000);
  A.app.snapshotState('מחיקה'); A.app.markDeleted('X'); A.app.state.tx=[]; A.app.saveState();   // 2. Asher deletes the job by mistake...
  await W.advance(3000); A.app.globalUndo(); A.app.saveState();                                   // 3. ...and taps בטל
  await H.goOnline(A); await W.advance(10000); await W.go(A.app._mergeOwnerActions()); await W.advance(120000);
  console.log('Asher:',A.app.state.tx.map(r=>r.id+':'+r.stage).join(','),'| Yehuda:',Y.app.state.tx.map(r=>r.id+':'+r.stage).join(','),'| cloud:',H.cloudDoc(W).tx.map(r=>r.id+':'+r.stage).join(','));
})().catch(e=>console.error(e));
