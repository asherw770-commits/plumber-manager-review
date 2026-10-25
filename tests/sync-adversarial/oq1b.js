// Owner queue: Yehuda marks paid then reverts (both versions sit in state/owner_actions) -> admin merge
const H=require('./h');
(async()=>{
  const W=new H.World(1);
  const A=H.makeDevice(W,'A','admin'), Y=H.makeDevice(W,'Y','owner');
  await W.go(H.boot(A)); await W.go(H.boot(Y));
  const t={id:'x1',type:'income',customer:'c',total:500,date:'2026-10-01',work:'w',notes:'',whoseCustomer:'mine'};
  A.app.applyTxStage(t,'unpaid'); t.completedDate='2026-10-01'; t.paidAmount=0; A.app.state.tx.push(t);
  await W.go(A.app.saveState()); await W.advance(20000);
  H.goOffline(A);                               // Asher's phone is closed / offline while Yehuda works
  W.t+=1000;
  const yr=Y.app.state.tx[0];
  Y.app.setTxStage(yr,'paid'); yr.paidDate='2026-10-01'; await W.go(Y.app.saveState()); await W.advance(3000);
  Y.app.setTxStage(yr,'unpaid'); delete yr.paidDate; await W.go(Y.app.saveState()); await W.advance(3000);
  const q=W.docs.get('state/owner_actions').data; console.log('queue tx versions', q.tx.map(r=>r.stage+'@'+r._updatedAt));
  console.log("A row before merge", JSON.stringify(A.app.state.tx[0]), JSON.stringify(q.tx));
  await H.goOnline(A);
  await W.go(A.app._mergeOwnerActions()); await W.advance(30000);
  console.log('Yehuda final stage:', Y.app.state.tx[0].stage, '| Admin stage:', A.app.state.tx[0].stage, '| cloud:', H.cloudDoc(W).tx[0].stage);
})().catch(e=>console.error(e));
