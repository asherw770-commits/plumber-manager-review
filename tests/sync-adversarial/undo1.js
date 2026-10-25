// delete while offline, then Undo (ctrl+Z / "בטל") -> row must survive reconnect
const H=require('./h');
async function run(offline){
  const W=new H.World(1);
  const A=H.makeDevice(W,'A','admin'), B=H.makeDevice(W,'B','admin');
  await W.go(H.boot(A)); await W.go(H.boot(B));
  const t={id:'x1',type:'income',customer:'c',total:500,date:'2026-10-01',work:'w',notes:'',whoseCustomer:'mine'};
  A.app.applyTxStage(t,'unpaid'); A.app.state.tx.push(t);
  await W.go(A.app.saveState()); await W.advance(20000);
  if(offline) H.goOffline(A);
  W.t+=1000;
  // delete exactly as the UI does
  A.app.snapshotState('מחיקה'); A.app.markDeleted('x1'); A.app.state.tx=A.app.state.tx.filter(x=>x.id!=='x1'); 
  A.app.saveState(); await W.advance(offline?5000:50);   // online: undo inside the write latency window (fast tap)
  A.app.globalUndo(); A.app.saveState(); 
  console.log(' after undo, A has row:', A.app.state.tx.length, 'upd', A.app.state.tx[0]&&A.app.state.tx[0]._updatedAt, 'tomb', A.app.state._deletedAt.x1);
  if(offline) await H.goOnline(A);
  await W.advance(60000);
  console.log((offline?'OFFLINE':'ONLINE-fast')+': A rows', A.app.state.tx.map(r=>r.id), 'B rows', B.app.state.tx.map(r=>r.id), 'cloud', (H.cloudDoc(W).tx||[]).map(r=>r.id));
}
(async()=>{ await run(true); await run(false); })().catch(e=>console.error(e));
