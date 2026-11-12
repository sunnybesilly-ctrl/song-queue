const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const crypto=require('node:crypto');
function fixture(){
 const store=new Map(),writes=[];
 const snapshot=path=>({exists:store.has(path),data:()=>store.get(path)});
 const ref=path=>({path,get:async()=>snapshot(path),create:async data=>store.set(path,data),set:async data=>store.set(path,data)});
 const tx={get:async r=>snapshot(r.path),set:(r,d)=>writes.push([r.path,d]),update:(r,d)=>writes.push([r.path,{...store.get(r.path),...d}]),create:(r,d)=>writes.push([r.path,d])};
 const db={doc:ref,collection:path=>({doc:()=>ref(path+'/generated')}),runTransaction:async fn=>{const result=await fn(tx);for(const [p,d]of writes)store.set(p,d);return result}};
 const firestore=()=>db;
 firestore.Timestamp={now:()=>({toMillis:()=>Date.now()}),fromMillis:n=>({toMillis:()=>n})};
 firestore.FieldValue={serverTimestamp:()=>({server:true}),increment:n=>({increment:n})};
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code}}
 const exports={};
 vm.runInNewContext(fs.readFileSync(__dirname+'/index.js','utf8'),{exports,require:name=>name==='firebase-functions/v2/https'?{onCall:(_,fn)=>fn,HttpsError}:name==='firebase-admin'?{initializeApp(){},firestore}:name==='node:crypto'?crypto:{},Date});
 const eventId='event';
 store.set('gallery_state/current',{eventId,active:true});
 store.set('gallery_access/guest',{eventId,expiresAt:{toMillis:()=>Date.now()+60000}});
 store.set('guest_wallets/guest',{eventId,balance:777,spent:0});
 store.set('media_queue/photo-wall-test',{eventId});
 return {exports,store,writes,req:{auth:{uid:'guest',token:{}},data:{kind:'comet',mediaId:'photo-wall-test',name:'Guest'}}};
}
test('guest gift charges the published price and creates an event-linked gift',async()=>{
 const f=fixture();const r=await f.exports.sendPhotoGift(f.req);
 assert.equal(r.balance,700);assert.equal(f.store.get('photo_gifts/generated').mediaId,'photo-wall-test');assert.equal(f.store.get('photo_gifts/generated').cost,77);
});
for(const [label,change,code]of [
 ['expired pass',f=>f.store.get('gallery_access/guest').expiresAt={toMillis:()=>0},'permission-denied'],
 ['closed event',f=>f.store.get('gallery_state/current').active=false,'permission-denied'],
 ['old event media',f=>f.store.get('media_queue/photo-wall-test').eventId='old','failed-precondition'],
 ['insufficient credits',f=>f.store.get('guest_wallets/guest').balance=1,'resource-exhausted'],
 ['nested media path',f=>f.req.data.mediaId='a/b/c','invalid-argument']
])test('rejects '+label+' without charging',async()=>{const f=fixture();change(f);await assert.rejects(f.exports.sendPhotoGift(f.req),e=>e.code===code);assert.equal(f.writes.length,0)});
test('guest cannot send unlimited admin gifts',async()=>{const f=fixture();await assert.rejects(f.exports.sendAdminPhotoGift(f.req),e=>e.code==='permission-denied')});
test('code redemption initializes credits once and rejects reuse',async()=>{
 const f=fixture(),code='12345678',key='gallery_codes/'+crypto.createHash('sha256').update(code).digest('hex');
 f.store.delete('guest_wallets/guest');f.store.set(key,{eventId:'event',used:false,expiresAt:{toMillis:()=>Date.now()+60000}});f.req.data={code};
 await f.exports.redeemGalleryCode(f.req);assert.equal(f.store.get('guest_wallets/guest').balance,777);
 await assert.rejects(f.exports.redeemGalleryCode(f.req),e=>e.code==='permission-denied');
});
test('redeeming a second code in one event preserves spent credits',async()=>{
 const f=fixture(),code='12345678';f.store.get('guest_wallets/guest').balance=12;
 f.store.set('gallery_codes/'+crypto.createHash('sha256').update(code).digest('hex'),{eventId:'event',used:false,expiresAt:{toMillis:()=>Date.now()+60000}});f.req.data={code};
 await f.exports.redeemGalleryCode(f.req);assert.equal(f.store.get('guest_wallets/guest').balance,12);
});
