const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function setup(){
 const source=fs.readFileSync(__dirname+'/../react.html','utf8');
 const code=source.slice(source.indexOf('KINDS.forEach(function (k, i)'),source.indexOf('const commentText='));
 let next=0,taps=0;const timers=new Map(),events={},globalEvents={};
 const b={type:'',className:'',setAttribute(){},classList:{add(){},remove(){}},addEventListener:(k,fn)=>events[k]=fn};
 const context={KINDS:['heart'],LABEL:{heart:'Heart'},ICON:{heart:''},document:{hidden:false,createElement:()=>b},window:{addEventListener:(k,fn)=>globalEvents[k]=fn},setTimeout:fn=>{timers.set(++next,fn);return next},clearTimeout:n=>timers.delete(n),hasPass:()=>true,now:{id:'one'},generation:1,tap:()=>taps++,rx:{appendChild(){}},confirm:()=>true};
 vm.runInNewContext(code,context);
 return {context,events,globalEvents,timers,taps:()=>taps,down:()=>events.pointerdown({pointerType:'touch',clientX:0,clientY:0}),fire:()=>{const work=[...timers.values()];timers.clear();work.forEach(fn=>fn())}};
}
test('quick taps and scrolling send no reaction',()=>{const f=setup();f.down();f.events.pointerup();f.fire();assert.equal(f.taps(),0);f.down();f.events.pointermove({clientX:30,clientY:0});f.fire();assert.equal(f.taps(),0)});
test('a completed hold sends one reaction',()=>{const f=setup();f.down();f.fire();assert.equal(f.taps(),1)});
test('changing media or session during a hold cancels the reaction',()=>{for(const change of [f=>f.context.now.id='two',f=>f.context.generation++]){const f=setup();f.down();change(f);f.fire();assert.equal(f.taps(),0)}});
test('leaving the window cancels an unfinished hold',()=>{const f=setup();f.down();f.globalEvents.blur();f.fire();assert.equal(f.taps(),0)});
