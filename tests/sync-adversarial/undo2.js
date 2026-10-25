// Ctrl+Z / "בטל" right after deleting a job, when Yehuda's queue merge (timer-driven, takes its own undo snapshot) ran in between.
const H=require('./h');
(async()=>{
  const W=new H.World(2,{lat:[100,200],coalesce:true});
  const A=H.makeDevice(W,'A','admin'), Y=H.makeDevice(W,'Y','owner');
  await W.go(H.boot(A)); await W.go(H.boot(Y));
  const mk=(id)=>{const t={id,type:'income',customer:id,total:500,date:'2026-10-01',work:'w',notes:'',whoseCustomer:'mine'};A.app.applyTxStage(t,'unpaid');return t;};
  A.app.state.tx.push(mk('X'),mk('P')); await W.go(A.app.saveState()); await W.advance(20000);
  // 1. Asher deletes X by mistake
  A.app.snapshotState('מחיקה'); A.app.markDeleted('X'); A.app.state.tx=A.app.state.tx.filter(r=>r.id!=='X'); await W.go(A.app.saveState());
  // 2. Yehuda (phone) marks P as paid: queue entry
  const yp=Y.app.state.tx.find(r=>r.id==='P'); const prev=Y.app.collectedAmount(yp); Y.app.setTxStage(yp,'paid'); Y.app.recordReceipt(yp,prev); await W.go(Y.app.saveState());
  // 3. Asher's app merges the queue (visibilitychange / 60s timer) -> takes an undo snapshot 'עדכונים מיהודה', Yehuda's queue is emptied
  await W.go(A.app._mergeOwnerActions());
  console.log('after queue merge  A: P =',A.app.state.tx.find(r=>r.id==='P').stage,'| undo stack:',A.app.state.undoStack.map(s=>s.label).join(' > '));
  // 4. Asher taps בטל (undo) to get X back
  A.app.globalUndo(); await W.advance(60000);
  console.log('after undo         A: rows =',A.app.state.tx.map(r=>r.id+':'+r.stage).join(', '));
  await W.advance(120000);
  console.log('Yehuda sees        Y: rows =',Y.app.state.tx.map(r=>r.id+':'+r.stage).join(', '));
  console.log('cloud                 rows =',H.cloudDoc(W).tx.map(r=>r.id+':'+r.stage).join(', '), '| owner queue left:', JSON.stringify(((W.docs.get('state/owner_actions')||{}).data||{}).tx||[]).length);
})().catch(e=>console.error(e));
