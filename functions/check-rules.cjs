const fs=require('node:fs');
const root=process.env.FIREBASE_TOOLS_LIB || require('node:path').dirname(require.resolve('firebase-tools/package.json'))+'/lib/';
const auth=require(root+'auth');
const {requireAuth}=require(root+'requireAuth');
const {Client}=require(root+'apiv2');
(async()=>{
 const options={project:'dj-photo-wall'};
 auth.setActiveAccount(options,auth.getGlobalDefaultAccount());
 await requireAuth(options);
 const client=new Client({urlPrefix:'https://firebaserules.googleapis.com',apiVersion:'v1'});
 const content=fs.readFileSync(__dirname+'/../firestore.rules','utf8');
 const path='/databases/(default)/documents/media_queue/probe';
 const tests=[
  {expectation:'DENY',request:{path,method:'create',resource:{data:{name:'Probe',url:'https://example.com/public.jpg'}}}},
  {expectation:'DENY',request:{path,method:'update',resource:{data:{likes:999}}},resource:{data:{likes:0}}},
  {expectation:'DENY',request:{path,method:'get'},resource:{data:{name:'Private'}}},
  {expectation:'ALLOW',request:{path,method:'get',auth:{uid:'admin-probe',token:{email:'sunnybesilly@gmail.com',email_verified:true}}},resource:{data:{name:'Private'}}}
 ];
 const base='/databases/%28default%29/documents/';
 const mock=(fn,path,value)=>({function:fn,args:[{exactValue:base+path}],result:{value}});
 const now='2026-11-12T00:00:00Z',expiry='2026-11-13T00:00:00Z',eventId='qa-event',id='photo-wall-12345678-1234-1234-1234-123456789abc';
 const guest={uid:'guest',token:{}};
 const mocks=[mock('exists','gallery_access/guest',true),mock('get','gallery_access/guest',{data:{eventId,expiresAt:expiry}}),mock('get','gallery_state/current',{data:{eventId,active:true}}),mock('exists','photo_wall_uploads/'+id,true),mock('get','photo_wall_uploads/'+id,{data:{eventId,expiresAt:expiry}}),mock('exists','media_queue/'+id,true),mock('get','media_queue/'+id,{data:{eventId}})];
 const data={v:3,eventId,name:'QA',url:'https://res.cloudinary.com/yl4yzjh5/image/authenticated/v123/'+id+'.jpg',publicId:id,type:'image',timestamp:now,likes:0};
 const add=(expectation,collection,method,data,auth=guest,resource)=>tests.push({expectation,request:{path:'/databases/(default)/documents/'+collection,method,auth,time:now,resource:{data}},...(resource?{resource:{data:resource}}:{}),functionMocks:mocks});
 add('ALLOW','media_queue/'+id,'create',data,null);
 add('DENY','media_queue/'+id,'create',{...data,url:'https://res.cloudinary.com/yl4yzjh5/image/upload/v123/'+id+'.jpg'},null);
 add('DENY','media_queue/'+id,'create',{...data,likes:500},null);
 add('ALLOW','media_queue/'+id,'update',{...data,likes:1},guest,data);
 add('DENY','media_queue/'+id,'update',{...data,likes:100},guest,data);
 const comment={eventId,mediaId:id,name:'QA',uid:'guest',text:'Test comment',t:now};
 add('ALLOW','photo_comments/qa','create',comment);
 add('DENY','photo_comments/qa','create',{...comment,uid:'someone-else'});
 add('DENY','photo_comments/qa','create',{...comment,text:'x'.repeat(161)});
 add('DENY','photo_comments/qa','delete',{},guest,comment);
 add('ALLOW','photo_comments/qa','delete',{}, {uid:'admin',token:{email:'sunnybesilly@gmail.com',email_verified:true}},comment);
 const response=await client.post('/projects/dj-photo-wall:test',{source:{files:[{name:'firestore.rules',content}]},testSuite:{testCases:tests}},{skipLog:{body:true,resBody:true}});
 console.log(JSON.stringify({issues:response.body.issues,results:response.body.testResults?.map((r,i)=>({test:i+1,state:r.state,debug:r.state==='SUCCESS'?undefined:r.debugMessages,calls:r.state==='SUCCESS'?undefined:r.functionCalls}))},null,2));
 if(response.body.issues?.some(x=>x.severity==='ERROR')||response.body.testResults?.some(x=>x.state!=='SUCCESS'))process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1});


