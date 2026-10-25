(function(){
  var q=new URLSearchParams(location.search); var role=q.get('role')||'admin'; var CLOUD='http://localhost:8766';
  var user={uid:'u-'+role,email:role+'@example.com'};
  function post(path,body){return fetch(CLOUD+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw Object.assign(new Error(j.error||'http '+r.status),{code:j.error});return j;});});}
  function snapDoc(j,id){return {exists:function(){return !!j.exists},data:function(){return j.data},id:id};}
  function ref(a){return {path:a.join('/'),__doc:true};}
  function qsnap(j){var docs=j.docs.map(function(d){return {id:d.id,data:function(){return d.data}}});return {docs:docs,size:docs.length,empty:!docs.length,forEach:function(f){docs.forEach(f)}};}
  function sanitize(o){return JSON.parse(JSON.stringify(o,function(k,v){return v===undefined?null:v}));}
  window.__fbLog=[];
  window.fb={
    auth:{currentUser:user}, db:{},
    signIn:function(){return Promise.resolve()}, signOut:function(){return Promise.resolve()},
    onAuthChange:function(cb){setTimeout(function(){cb(user)},50);return function(){}},
    createUser:function(){return Promise.reject(new Error('demo'))}, createUserWithoutSignOut:function(){return Promise.reject(new Error('demo'))}, resetPassword:function(){return Promise.resolve()},
    doc:function(db){return ref([].slice.call(arguments,1))},
    setDoc:function(r,d,o){window.__fbLog.push('set '+r.path);return post('/set',{path:r.path,data:sanitize(d),merge:!!(o&&o.merge)});},
    getDoc:function(r){return post('/get',{path:r.path}).then(function(j){return snapDoc(j,r.path.split('/').pop())});},
    updateDoc:function(r,d){window.__fbLog.push('update '+r.path);return post('/update',{path:r.path,data:sanitize(d)});},
    deleteDoc:function(r){return post('/delete',{path:r.path});},
    arrayUnion:function(){return {__op:'arrayUnion',values:[].slice.call(arguments)};}, arrayRemove:function(){return {__op:'arrayRemove',values:[].slice.call(arguments)};},
    collection:function(db){return {__coll:[].slice.call(arguments,1).join('/'),where:[]};},
    where:function(f,op,v){return {__where:[f,op,v]};},
    query:function(c){var w=c.where.slice();[].slice.call(arguments,1).forEach(function(x){if(x&&x.__where)w.push(x.__where)});return {__coll:c.__coll,where:w};},
    getDocs:function(c){return post('/docs',{coll:c.__coll,where:c.where}).then(qsnap);},
    onSnapshot:function(r,cb,err){
      var alive=true,last=null;
      function tick(){
        if(!alive)return;
        var p=r.__doc?post('/get',{path:r.path}):post('/docs',{coll:r.__coll,where:r.where});
        p.then(function(j){var sig=r.__doc?(j.exists?j.rev:0):(j.rev+':'+j.n);if(sig!==last){last=sig;try{cb(r.__doc?snapDoc(j,r.path.split('/').pop()):qsnap(j));}catch(e){console.error('snap cb',e)}}}).catch(function(e){if(err)err(e)}).then(function(){if(alive)setTimeout(tick,400)});
      }
      tick(); return function(){alive=false};
    },
    serverTimestamp:function(){return Date.now()}
  };
  window.dispatchEvent(new Event('firebase-ready'));
})();
