// Owner queue: Yehuda ticks a task done, then re-opens it (both versions in the queue)
const H=require('./h');
(async()=>{
  const W=new H.World(1);
  const A=H.makeDevice(W,'A','admin'), Y=H.makeDevice(W,'Y','owner');
  await W.go(H.boot(A)); await W.go(H.boot(Y));
  A.app.state.tasks.push({id:'k1',task:'t',status:'open',kind:'work'});
  await W.go(A.app.saveState()); await W.advance(20000);
  H.goOffline(A); W.t+=1000;
  const yt=Y.app.state.tasks[0];
  yt.status='done'; yt.completedAt=Y.app.Date.now(); await W.go(Y.app.saveState()); await W.advance(3000);
  yt.status='open'; delete yt.completedAt; await W.go(Y.app.saveState()); await W.advance(3000);
  const q=W.docs.get('state/owner_actions').data; console.log('queue task versions', q.tasks.map(r=>r.status+'@'+r._updatedAt));
  await H.goOnline(A);
  await W.go(A.app._mergeOwnerActions()); await W.advance(30000);
  console.log('Yehuda final:', Y.app.state.tasks[0].status, '| Admin:', A.app.state.tasks[0].status, '| cloud:', H.cloudDoc(W).tasks[0].status);
})().catch(e=>console.error(e));
