(function(){
  var q=new URLSearchParams(location.search); var role=q.get('role')||'admin';
  var DATA=null; var listeners=[];
  var xhr=new XMLHttpRequest(); xhr.open('GET','/data.json',false); xhr.send(); DATA=JSON.parse(xhr.responseText);
  var user={uid:'u1',email:'demo@example.com'};
  var profile={name:role==='admin'?'מנהל מערכת':role==='owner'?'יהודה':'יחיאל',role:role,email:'demo@example.com'};
  if(q.get('access')!==null) profile.access={views:q.get('access').split(',').filter(Boolean)};
  var USERS={'JgQOxlW5UJdRWNHu94knOf0FJed2':{name:'מנהל מערכת',role:'admin',email:'asher@x.com',createdAt:1790000000000},
    'u-yehuda':{name:'יהודה',role:'owner',email:'yehuda@x.com',createdAt:1791000000000,needsApproval:true},
    'u-yechiel':{name:'יחיאל',role:'manager',email:'yechiel@x.com',createdAt:1791000000001,access:{views:['collection','transactions']}},
    'u-old':{name:'עובד ישן',role:'manager',email:'old@x.com',createdAt:1791000000002,disabled:true}};
  window.__USERS=USERS;
  function snap(data){return {exists:function(){return data!=null},data:function(){return data}, id:'x'}}
  function ref(path){return {path:path.join('/')}}
  function getDoc(r){
    var p=r.path;
    if(p.indexOf('users/')===0) return Promise.resolve(snap(profile));
    if(p==='state/current') return Promise.resolve(snap(JSON.parse(JSON.stringify(DATA))));
    return Promise.resolve(snap(null));
  }
  window.fb={
    auth:{currentUser:user}, db:{},
    signIn:function(){return Promise.resolve()}, signOut:function(){return Promise.resolve()},
    onAuthChange:function(cb){setTimeout(function(){cb(user)},50);return function(){}},
    createUser:function(){return Promise.reject(new Error('demo'))}, createUserWithoutSignOut:function(){return Promise.reject(new Error('demo'))},
    resetPassword:function(){return Promise.resolve()},
    doc:function(db){var a=[].slice.call(arguments,1);return ref(a)},
    setDoc:function(){return Promise.resolve()}, getDoc:getDoc, updateDoc:function(r,patch){var m=/^users\/(.+)$/.exec(r.path);if(m&&USERS[m[1]]){Object.keys(patch).forEach(function(k){if(patch[k]===null)delete USERS[m[1]][k];else USERS[m[1]][k]=patch[k]})}window.__LAST_UPDATE={path:r.path,patch:patch};return Promise.resolve()}, deleteDoc:function(){return Promise.resolve()},
    arrayUnion:function(){}, arrayRemove:function(){},
    collection:function(db){var a=[].slice.call(arguments,1);return ref(a)},
    getDocs:function(c){if(c&&c.path==='users'){var ds=Object.keys(USERS).map(function(id){return {id:id,data:function(){return JSON.parse(JSON.stringify(USERS[id]))}}});return Promise.resolve({docs:ds,forEach:function(f){ds.forEach(f)},empty:false,size:ds.length})}return Promise.resolve({docs:[],forEach:function(){},empty:true,size:0})},
    query:function(c){return c}, where:function(){return {}},
    onSnapshot:function(r,cb,err){ return function(){} },
    serverTimestamp:function(){return Date.now()}
  };
  window.addEventListener('DOMContentLoaded',function(){window.dispatchEvent(new Event('firebase-ready'))});
  window.dispatchEvent(new Event('firebase-ready'));
})();
