(function(){
  if(!/[?&]dump=1/.test(location.search))return;
  var VIEWS={admin:['dashboard','collection','transactions','reports','profit','tasks','customers','partners','products','messages','whatsapp','settings'],owner:['dashboard','collection','tasks','partners','products'],manager:['dashboard','reports','profit','transactions','customers','partners']};
  var role=(location.search.match(/role=(\w+)/)||[0,'admin'])[1];
  var out={};
  function tokens(t){return (t.match(/-?\d[\d,]*(?:\.\d+)?%?/g)||[]).map(function(x){return x.replace(/,/g,'')});}
  function step(i){
    var vs=VIEWS[role];
    if(i>=vs.length){var q=location.search.match(/ui2=(\d)/);var nm=(q?q[1]:'x')+'_'+role;fetch('http://localhost:8766/save?name='+nm,{method:'POST',body:JSON.stringify(out)}).then(function(){document.title='SAVED '+nm});return;}
    var v=vs[i];
    try{setView(v);}catch(e){out[v]={err:String(e)};return step(i+1);}
    setTimeout(function(){
      try{
        var el=document.getElementById('view-'+v);
        el.querySelectorAll('details').forEach(function(d){d.open=true;});
        var t=el.innerText||'';
        out[v]={tokens:tokens(t),len:t.length,text:t};
      }catch(e){out[v]={err:String(e)};}
      step(i+1);
    },250);
  }
  var tries=0;(function wait(){
    if(typeof state!=='undefined'&&state.tx&&state.tx.length&&document.getElementById('mainApp').style.display==='grid'){setTimeout(function(){step(0)},800);}
    else if(tries++<100)setTimeout(wait,100);
  })();
})();
