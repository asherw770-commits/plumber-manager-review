// A's clock is +1h (detected). After A restores, B legitimately edits a note 10 minutes later: B's edit must win (it is the last real edit).
const H=require('./h');
(async()=>{
 for (const skew of [0, 3600000]) {
  const W=new H.World(3,{lat:[50,200],coalesce:true});
  const A=H.makeDevice(W,'A','admin',{skew,detected:true}), B=H.makeDevice(W,'B','admin');
  await W.go(H.boot(A)); await W.go(H.boot(B));
  const t={id:'r1',type:'income',customer:'r1',total:500,date:'2026-10-01',work:'w',notes:'old',whoseCustomer:'mine'};B.app.applyTxStage(t,'unpaid');B.app.state.tx.push(t);
  await W.go(B.app.saveState()); await W.advance(10000);
  const backup=JSON.parse(JSON.stringify({tx:B.app.state.tx,tasks:[],customerMeta:{},dailyNotes:{},whatsappInbox:[],products:[],priceList:[],settlements:[]}));
  B.app.state.tx[0].notes='mid'; await W.go(B.app.saveState()); await W.advance(60000);
  A.app.applyBackupData(backup); await W.advance(60000);
  await W.advance(10*60000);
  B.app.state.tx[0].notes='B edit AFTER the restore (payment note)'; await W.go(B.app.saveState());
  await W.advance(5*60000);
  console.log('A clock skew',skew/60000+'min','-> A:',A.app.state.tx[0].notes,'| B:',B.app.state.tx[0].notes,'| cloud:',H.cloudDoc(W).tx[0].notes);
 }
})();
