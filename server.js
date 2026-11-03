'use strict';
const express=require('express'),http=require('http'),net=require('net'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const{execFile,spawn}=require('child_process'),multer=require('multer'),{WebSocketServer}=require('ws'),AdmZip=require('adm-zip');
const detect=require('./detect');
const DATA=path.resolve(process.env.DATA_DIR||process.env.RAILWAY_VOLUME_MOUNT_PATH||'./data');
const META=path.join(DATA,'meta'),PROJ=path.join(DATA,'projects'),LOGS=path.join(DATA,'logs');
for(const d of[DATA,META,PROJ,LOGS])fs.mkdirSync(d,{recursive:true});
const ROOT=process.getuid&&process.getuid()===0;
if(ROOT){fs.chmodSync(DATA,0o711);fs.chmodSync(PROJ,0o711);fs.chmodSync(META,0o700);fs.chmodSync(LOGS,0o700)}

// ---------- credenciales: variables de entorno o generadas y guardadas en el volumen ----------
const persist=(name,make)=>{const f=path.join(DATA,name);try{return fs.readFileSync(f,'utf8').trim()}catch{const v=make();fs.writeFileSync(f,v,{mode:0o600});return v}};
const generated=[];
let ADMIN=process.env.ADMIN_TOKEN||'';if(ADMIN.length<12){ADMIN=persist('.admin-token',()=>{generated.push('ADMIN_TOKEN');return crypto.randomBytes(18).toString('base64url')})}
let KEYHEX=process.env.SECRET_KEY||'';if(!/^[0-9a-f]{64}$/i.test(KEYHEX))KEYHEX=persist('.secret-key',()=>{generated.push('SECRET_KEY');return crypto.randomBytes(32).toString('hex')});
const KEY=Buffer.from(KEYHEX,'hex');
const seal=o=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',KEY,iv),b=Buffer.concat([c.update(JSON.stringify(o),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64')};
const unseal=s=>{if(!s)return{};const b=Buffer.from(s,'base64'),d=crypto.createDecipheriv('aes-256-gcm',KEY,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'))};
const mask=v=>v.length>12?'••••••'+v.slice(-4):'••••';
const SESSION=crypto.createHmac('sha256',KEY).update('session:'+ADMIN).digest('hex');
const eq=(a,b)=>{a=Buffer.from(String(a||''));b=Buffer.from(String(b||''));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const cookie=q=>((q.headers.cookie||'').match(/(?:^|;\s*)ucr=([0-9a-f]+)/)||[])[1];
const authed=q=>eq(cookie(q),SESSION)||eq((q.headers.authorization||'').replace(/^Bearer /,''),ADMIN);

// ---------- proyectos ----------
const idOk=id=>/^[0-9a-f]{8}$/.test(id||''),pdir=id=>path.join(PROJ,id),sdir=id=>path.join(pdir(id),'src'),mfile=id=>path.join(META,id+'.json');
const getMeta=id=>{try{return idOk(id)?JSON.parse(fs.readFileSync(mfile(id),'utf8')):null}catch{return null}};
const saveMeta=m=>fs.writeFileSync(mfile(m.id),JSON.stringify(m,null,1),{mode:0o600});
const allMeta=()=>fs.readdirSync(META).map(f=>f.replace(/\.json$/,'')).filter(idOk).map(getMeta).filter(Boolean);
const uidOf=id=>200000+parseInt(id,16)%1000000;      // un usuario Linux distinto por proyecto (aislamiento)
const own=(id,p)=>ROOT?new Promise(r=>execFile('chown',['-R',uidOf(id)+':'+uidOf(id),p],()=>r())):Promise.resolve();
const sh=(cmd,opt={})=>new Promise(r=>execFile('sh',['-c',cmd],{timeout:30000,maxBuffer:5e6,...opt},(e,o,s)=>r({ok:!e,out:(o||'').trim(),err:(s||(e&&e.message)||'').trim()})));
const hasBin=async b=>(await sh('command -v '+b)).ok;
const pickPort=()=>{const used=new Set(allMeta().map(m=>m.port));let p;do p=20000+Math.floor(Math.random()*20000);while(used.has(p));return p};

function extract(buf,dest){
 const es=new AdmZip(buf).getEntries();let total=0;
 if(es.length>20000)throw new Error('El ZIP tiene demasiados archivos');
 fs.rmSync(dest,{recursive:true,force:true});fs.mkdirSync(dest,{recursive:true});
 for(const e of es){total+=e.header.size;if(total>1e9)throw new Error('El ZIP descomprimido supera 1 GB');
  const t=path.resolve(dest,e.entryName);if(t!==dest&&!t.startsWith(dest+path.sep))throw new Error('Ruta insegura dentro del ZIP');
  if(e.isDirectory){fs.mkdirSync(t,{recursive:true});continue}
  fs.mkdirSync(path.dirname(t),{recursive:true});fs.writeFileSync(t,e.getData())}
 fs.rmSync(path.join(dest,'__MACOSX'),{recursive:true,force:true});
 const top=fs.readdirSync(dest);
 if(top.length===1&&fs.statSync(path.join(dest,top[0])).isDirectory()){const inn=path.join(dest,top[0]);for(const n of fs.readdirSync(inn))fs.renameSync(path.join(inn,n),path.join(dest,n));fs.rmdirSync(inn)}
}

// ---------- logs ----------
const logs=new Map(); // id -> {ring:[],subs:Set}
const L=id=>{let l=logs.get(id);if(!l){l={ring:[],subs:new Set()};logs.set(id,l);try{const f=path.join(LOGS,id+'.log'),st=fs.statSync(f),fd=fs.openSync(f,'r'),n=Math.min(st.size,65536),b=Buffer.alloc(n);fs.readSync(fd,b,0,n,st.size-n);fs.closeSync(fd);l.ring=b.toString('utf8').split('\n').filter(Boolean).slice(-300)}catch{}}return l};
function log(id,line,sys){line=String(line).replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'');if(sys)line='[UCR] '+line;const l=L(id);l.ring.push(line);if(l.ring.length>500)l.ring.shift();
 try{fs.appendFileSync(path.join(LOGS,id+'.log'),line+'\n')}catch{}for(const w of l.subs)if(w.readyState===1)w.send(line)}
const feeder=id=>{let b='';return d=>{b+=d;const ls=b.split('\n');b=ls.pop();ls.forEach(x=>log(id,x.replace(/\r$/,'')));if(b.length>8000){log(id,b);b=''}}};

// ---------- gestor de procesos persistentes ----------
const procs=new Map(); // id -> {child,startedAt,stopping,timer,backoff}
const ENVKEEP=['PATH','LANG','LC_ALL','TZ','JAVA_HOME'];
async function start(m,why){
 const old=procs.get(m.id);if(old&&old.child&&!old.child.killed&&old.child.exitCode===null)return;
 if(!m.cmd)throw new Error('No se pudo detectar cómo ejecutar este proyecto (lenguaje no reconocido). Define el comando en Ajustes.');
 for(const b of m.need||[])if(!await hasBin(b))throw new Error(`Runtime no instalado en este servidor: "${b}". En Railway se incluye en el Dockerfile (Rust y .NET: pon las variables de build INSTALL_RUST=1 / INSTALL_DOTNET=1 y vuelve a desplegar).`);
 const vars=unseal(m.vars);
 if(vars.DISCORD_TOKEN)for(const a of['TOKEN','BOT_TOKEN','DISCORD_BOT_TOKEN'])if(!vars[a])vars[a]=vars.DISCORD_TOKEN;
 const src=sdir(m.id),home=path.join(src,'.home');fs.mkdirSync(home,{recursive:true});await own(m.id,pdir(m.id));
 const env={HOME:home,TERM:'xterm-256color',...Object.fromEntries(ENVKEEP.filter(k=>process.env[k]).map(k=>[k,process.env[k]])),...(m.env||{}),...vars};
 if(m.port)env.PORT=String(m.port);
 const o={cwd:src,env,detached:true,stdio:['ignore','pipe','pipe']};if(ROOT){o.uid=o.gid=uidOf(m.id)}
 const p={child:null,startedAt:Date.now(),stopping:false,backoff:(old&&old.backoff)||2000};procs.set(m.id,p);
 m.desired='running';m.lastStart=new Date().toISOString();delete m.lastExit;saveMeta(m);
 log(m.id,`${why||'Iniciando'}: ${m.cmd}`,1);
 const c=p.child=spawn('sh',['-c','ulimit -u 2048 2>/dev/null; '+m.cmd],o);
 const f=feeder(m.id);c.stdout.setEncoding('utf8');c.stderr.setEncoding('utf8');c.stdout.on('data',f);c.stderr.on('data',f);
 c.on('error',e=>log(m.id,'No se pudo lanzar el proceso: '+e.message,1));
 c.on('close',(code,sig)=>{const cur=getMeta(m.id);if(!cur)return;const up=Date.now()-p.startedAt;
  cur.lastExit={code,sig,at:new Date().toISOString()};log(m.id,`El proceso terminó (código ${code}${sig?', señal '+sig:''}) tras ${Math.round(up/1000)}s`,1);
  if(p.stopping||cur.desired!=='running'){saveMeta(cur);return}
  if(!cur.restart){cur.desired='stopped';saveMeta(cur);return}
  p.backoff=up>60000?2000:Math.min(p.backoff*2,60000);cur.restarts=(cur.restarts||0)+1;saveMeta(cur);
  log(m.id,`Reinicio automático en ${Math.round(p.backoff/1000)}s…`,1);p.timer=setTimeout(()=>{const x=getMeta(m.id);if(x&&x.desired==='running')start(x,'Reinicio automático').catch(e=>log(m.id,e.message,1))},p.backoff)})}
async function stop(m){const p=procs.get(m.id);m.desired='stopped';saveMeta(m);if(!p)return;p.stopping=true;clearTimeout(p.timer);
 const c=p.child;if(!c||c.exitCode!==null)return;try{process.kill(-c.pid,'SIGTERM')}catch{}
 await new Promise(r=>{const t=setTimeout(()=>{try{process.kill(-c.pid,'SIGKILL')}catch{}r()},8000);c.once('close',()=>{clearTimeout(t);r()})})}
const alive=id=>{const p=procs.get(id);return !!(p&&p.child&&p.child.exitCode===null&&p.child.signalCode===null)};

// monitor de CPU/RAM por proyecto (ps por sesión) + límite de memoria real
let res={};
const mem2mb=s=>/g$/i.test(s)?parseFloat(s)*1024:parseFloat(s);
setInterval(()=>execFile('ps',['-eo','sid=,rss=,pcpu='],(e,out)=>{if(e)return;const by={};
 for(const l of out.split('\n')){const[s,r,c]=l.trim().split(/\s+/).map(Number);if(!s)continue;(by[s]=by[s]||{rss:0,cpu:0});by[s].rss+=r;by[s].cpu+=c}
 const n={};for(const[id,p]of procs){if(!alive(id))continue;const x=by[p.child.pid];if(!x)continue;n[id]={cpu:x.cpu.toFixed(1)+'%',mem:(x.rss/1024).toFixed(0)+' MiB',rss:x.rss};
  const m=getMeta(id);if(m&&x.rss/1024>mem2mb(m.mem||'512m')*1.05){log(id,`Límite de RAM superado (${(x.rss/1024).toFixed(0)} MiB > ${m.mem}). Proceso detenido.`,1);try{process.kill(-p.child.pid,'SIGKILL')}catch{}}}res=n}),4000).unref();

// ---------- vista de proyecto ----------
const dcache=new Map();
async function discordWho(m,vars){const t=vars.DISCORD_TOKEN;if(!t)return null;const c=dcache.get(m.id);if(c&&Date.now()-c.t<60000&&c.k===t.slice(-6))return c.v;let v;
 try{const r=await fetch('https://discord.com/api/v10/users/@me',{headers:{Authorization:'Bot '+t},signal:AbortSignal.timeout(8000)}),j=await r.json();
  v=r.ok?{id:j.id,name:j.username,avatar:j.avatar?`https://cdn.discordapp.com/avatars/${j.id}/${j.avatar}.png?size=96`:null}:{error:r.status===401?'Discord rechazó el token (401): es inválido o fue regenerado':'Discord respondió '+r.status}}
 catch(e){v={error:'No se pudo contactar con Discord: '+e.message}}
 dcache.set(m.id,{t:Date.now(),k:t.slice(-6),v});return v}
const GW=/logged (in|on) as|\bready\b|connected to (the )?gateway|shard \d+.{0,20}ready|is online|bot (is )?(started|running)|started polling/i;
async function view(m){
 const run=alive(m.id),p=procs.get(m.id),le=m.lastExit;
 const state=run?'running':(p&&p.timer&&m.desired==='running'&&!p.stopping)?'restarting':le?(le.code===0||le.sig==='SIGTERM'?'exited':'crashed'):'stopped';
 const o={id:m.id,name:m.name,kind:m.kind,lang:m.lang,lib:m.lib,cmd:m.cmd,port:m.port,restart:m.restart,mem:m.mem,cpu:m.cpu,public:!!m.public,commands:m.commands,source:m.source,createdAt:m.createdAt,lastStart:m.lastStart,
  state,exitCode:le&&le.code,restarts:m.restarts||0,desired:m.desired,uptime:run?Math.floor((Date.now()-p.startedAt)/1000):0,res:res[m.id]||null,
  lastActivity:(L(m.id).ring.slice(-1)[0]||'').slice(0,120),url:m.port?'/p/'+m.id+'/':null,needFix:null};
 if(m.kind==='bot'){o.discord=await discordWho(m,unseal(m.vars));if(run)o.gateway=L(m.id).ring.some(l=>GW.test(l))}
 return o}

// ---------- API ----------
const app=express();app.disable('x-powered-by');app.set('trust proxy',true);
app.get('/health',(q,s)=>s.json({ok:true}));
app.use((q,s,n)=>{s.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'});n()});
const fails=new Map();
app.post('/api/login',express.json({limit:'4kb'}),(q,s)=>{const f=fails.get(q.ip)||{n:0,t:Date.now()};if(Date.now()-f.t>6e5){f.n=0;f.t=Date.now()}
 if(f.n>=10)return s.status(429).json({error:'Demasiados intentos. Espera 10 minutos.'});
 if(!eq(q.body&&q.body.token,ADMIN)){f.n++;fails.set(q.ip,f);return s.status(401).json({error:'Token incorrecto'})}
 s.setHeader('Set-Cookie',`ucr=${SESSION}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${q.secure?'; Secure':''}`);s.json({ok:true})});
app.post('/api/logout',(q,s)=>{s.setHeader('Set-Cookie','ucr=; HttpOnly; Path=/; Max-Age=0');s.json({ok:true})});
app.use(express.static(path.join(__dirname,'public')));

// proxy HTTP hacia proyectos web: /p/<id>/...
const target=q=>{const m=/^\/p\/([0-9a-f]{8})(\/.*)?$/.exec(q.url.split('?')[0]);if(!m)return null;const pr=getMeta(m[1]);if(!pr||!pr.port)return null;return{pr,rest:q.url.replace('/p/'+m[1],'')||'/'}};
app.use('/p/:id',(q,s)=>{const t=target({url:q.originalUrl});if(!t)return s.status(404).send('Proyecto no encontrado');
 if(!t.pr.public&&!authed(q))return s.status(401).send('Inicia sesión en el panel primero');
 if(!alive(t.pr.id))return s.status(502).send('El proyecto no está en ejecución. Inícialo desde el panel.');
 if(q.originalUrl.split('?')[0]==='/p/'+t.pr.id)return s.redirect('/p/'+t.pr.id+'/');
 const h={...q.headers,host:'127.0.0.1:'+t.pr.port,'x-forwarded-prefix':'/p/'+t.pr.id};delete h.cookie;
 const r=http.request({host:'127.0.0.1',port:t.pr.port,path:t.rest,method:q.method,headers:h},x=>{s.writeHead(x.statusCode,x.headers);x.pipe(s)});
 r.on('error',e=>s.status(502).send('El proyecto no responde en el puerto '+t.pr.port+': '+e.message));q.pipe(r)});

app.use('/api',(q,s,n)=>authed(q)?n():s.status(401).json({error:'No autorizado'}));
const up=multer({storage:multer.memoryStorage(),limits:{fileSize:200e6}});
const json=express.json({limit:'6mb'});
const wrap=f=>(q,s)=>Promise.resolve().then(()=>f(q,s)).catch(e=>s.status(400).json({error:e.message}));
const P=q=>{const m=getMeta(q.params.id);if(!m)throw new Error('Proyecto no encontrado');return m};
const applyDetect=(m,d)=>{Object.assign(m,{lang:d.lang,lib:d.lib,kind:d.kind,commands:d.commands});if(!m.custom){m.cmd=d.cmd;m.env=d.env;m.need=d.need}if(d.port&&!m.port)m.port=pickPort()};
async function create(name,d0){const id=crypto.randomBytes(4).toString('hex');fs.mkdirSync(pdir(id),{recursive:true});return id}
async function finish(id,name,source){await own(id,pdir(id));const d=detect(sdir(id));
 const m={id,name:String(name||d.name||'proyecto').slice(0,60),source,createdAt:new Date().toISOString(),restart:true,mem:'512m',cpu:1,port:null,vars:seal({}),desired:'stopped',restarts:0};applyDetect(m,d);saveMeta(m);return view(m)}

app.get('/api/projects',wrap(async(q,s)=>s.json(await Promise.all(allMeta().map(view)))));
app.post('/api/projects',up.single('file'),wrap(async(q,s)=>{if(!q.file)throw new Error('Falta el archivo');
 const id=await create(),nm=q.file.originalname;
 try{if(/\.zip$/i.test(nm))extract(q.file.buffer,sdir(id));else{fs.mkdirSync(sdir(id),{recursive:true});fs.writeFileSync(path.join(sdir(id),path.basename(nm)),q.file.buffer)}}catch(e){fs.rmSync(pdir(id),{recursive:true,force:true});throw e}
 s.json(await finish(id,q.body.name||nm.replace(/\.[^.]+$/,''),'zip'))}));
app.post('/api/projects/git',json,wrap(async(q,s)=>{const u=String(q.body.url||'').trim();if(!/^https:\/\/[\w.-]+\/[\w.\/~-]+$/.test(u))throw new Error('URL de Git inválida (solo https)');
 const id=await create();const r=await sh(`git clone --depth 1 -- ${JSON.stringify(u)} ${JSON.stringify(sdir(id))}`,{timeout:300000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 if(!r.ok){fs.rmSync(pdir(id),{recursive:true,force:true});throw new Error('git clone falló: '+r.err.slice(-300))}
 fs.rmSync(path.join(sdir(id),'.git'),{recursive:true,force:true});s.json(await finish(id,q.body.name||u.split('/').pop().replace(/\.git$/,''),'git'))}));
app.post('/api/projects/:id/upload',up.single('file'),wrap(async(q,s)=>{const m=P(q);if(!q.file)throw new Error('Falta el archivo ZIP');
 await stop(m);extract(q.file.buffer,sdir(m.id));await own(m.id,pdir(m.id));applyDetect(m,detect(sdir(m.id)));saveMeta(m);s.json(await view(m))}));
app.get('/api/system',wrap(async(q,s)=>{const rd=f=>{try{return fs.readFileSync(f,'utf8').trim()}catch{return null}},cm=rd('/sys/fs/cgroup/memory.max'),cc=rd('/sys/fs/cgroup/memory.current');
 const df=await sh(`df -Pk ${JSON.stringify(DATA)} | tail -1`),d=df.out.split(/\s+/);
 s.json({cpus:os.cpus().length,load:os.loadavg(),memTotal:cm&&cm!=='max'?+cm:os.totalmem(),memUsed:cc?+cc:os.totalmem()-os.freemem(),diskTotal:+d[1]*1024||null,diskUsed:+d[2]*1024||null,uptime:Math.floor(process.uptime()),node:process.version,root:ROOT,volume:!!process.env.RAILWAY_VOLUME_MOUNT_PATH||DATA!==path.resolve('./data'),url:publicUrl()})}));
app.get('/api/projects/:id/env',wrap((q,s)=>s.json({vars:Object.entries(unseal(P(q).vars)).map(([key,v])=>({key,mask:mask(v)}))})));
app.put('/api/projects/:id/env',json,wrap((q,s)=>{const m=P(q),v=unseal(m.vars),{set={},remove=[]}=q.body;
 for(const[k,x]of Object.entries(set)){if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)||typeof x!=='string'||!x||/[\r\n\0]/.test(x))throw new Error('Variable inválida: '+k);v[k]=x}
 for(const k of remove)delete v[k];m.vars=seal(v);saveMeta(m);dcache.delete(m.id);s.json({ok:true})}));
app.put('/api/projects/:id/config',json,wrap((q,s)=>{const m=P(q),b=q.body;
 if(typeof b.cmd==='string'&&b.cmd.trim()){m.cmd=b.cmd.trim().slice(0,800);m.custom=true;m.need=[]}
 if('port'in b){const p=parseInt(b.port);m.port=p>0&&p<65536?p:null}
 if('restart'in b)m.restart=!!b.restart;if('public'in b)m.public=!!b.public;
 if(/^\d{2,5}[mg]$/i.test(b.mem||''))m.mem=b.mem.toLowerCase();
 saveMeta(m);s.json({ok:true})}));
app.post('/api/projects/:id/:act',wrap(async(q,s)=>{const m=P(q),a=q.params.act;
 if(a==='stop')await stop(m);
 else if(a==='start')await start(m);
 else if(a==='restart'){await stop(m);await start(getMeta(m.id),'Reiniciando')}
 else if(a==='reinstall'){await stop(m);for(const d of['node_modules','.venv','.cargo','.bundle','target','bin','obj','vendor'])fs.rmSync(path.join(sdir(m.id),d),{recursive:true,force:true});await start(getMeta(m.id),'Reinstalando dependencias')}
 else throw new Error('Acción desconocida');s.json({ok:true})}));
app.delete('/api/projects/:id',wrap(async(q,s)=>{const m=P(q);await stop(m);fs.rmSync(pdir(m.id),{recursive:true,force:true});fs.rmSync(mfile(m.id),{force:true});fs.rmSync(path.join(LOGS,m.id+'.log'),{force:true});logs.delete(m.id);procs.delete(m.id);s.json({ok:true})}));

// archivos: explorador, editor, hex, desensamblador
const safe=(m,rel)=>{const root=fs.realpathSync(sdir(m.id)),t=path.resolve(root,'.'+path.sep+String(rel||'')),r=fs.existsSync(t)?fs.realpathSync(t):t;if(r!==root&&!r.startsWith(root+path.sep))throw new Error('Ruta fuera del proyecto');return r};
app.get('/api/projects/:id/files',wrap((q,s)=>{const m=P(q),d=safe(m,q.query.path);const es=fs.readdirSync(d,{withFileTypes:true}).filter(e=>e.name!=='.home').map(e=>({name:e.name,dir:e.isDirectory(),size:e.isDirectory()?0:fs.statSync(path.join(d,e.name)).size})).sort((a,b)=>b.dir-a.dir||a.name.localeCompare(b.name));s.json({files:es.slice(0,1000)})}));
app.get('/api/projects/:id/file',wrap((q,s)=>{const m=P(q),f=safe(m,q.query.path),st=fs.statSync(f);if(st.size>2e6)throw new Error('Archivo demasiado grande para el editor (máx. 2 MB). Usa el editor hexadecimal.');const b=fs.readFileSync(f);if(b.includes(0))throw new Error('Es un archivo binario. Ábrelo en el editor hexadecimal o el desensamblador.');s.json({text:b.toString('utf8')})}));
app.put('/api/projects/:id/file',json,wrap(async(q,s)=>{const m=P(q),f=safe(m,q.body.path);if(typeof q.body.text!=='string')throw new Error('Falta el texto');fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,q.body.text);await own(m.id,f);s.json({ok:true})}));
app.get('/api/projects/:id/hex',wrap((q,s)=>{const m=P(q),f=safe(m,q.query.path),off=Math.max(0,+q.query.offset||0),fd=fs.openSync(f,'r'),b=Buffer.alloc(2048),n=fs.readSync(fd,b,0,2048,off);fs.closeSync(fd);let o='';
 for(let i=0;i<n;i+=16){const c=b.subarray(i,Math.min(i+16,n));o+=(off+i).toString(16).padStart(8,'0')+'  '+[...c].map(x=>x.toString(16).padStart(2,'0')).join(' ').padEnd(47)+'  '+[...c].map(x=>x>31&&x<127?String.fromCharCode(x):'.').join('')+'\n'}
 s.json({text:o,size:fs.statSync(f).size,offset:off,read:n})}));
app.get('/api/projects/:id/disasm',wrap(async(q,s)=>{const m=P(q),f=safe(m,q.query.path);
 let r=await sh(`objdump -d -M intel --no-show-raw-insn ${JSON.stringify(f)} | head -n 600`);
 if(!r.out)r=await sh(`objdump -D -b binary -m i386:x86-64 -M intel ${JSON.stringify(f)} | head -n 600`);
 if(!r.out)throw new Error('objdump no pudo desensamblar este archivo: '+r.err.slice(0,200));s.json({text:r.out})}));

// ---------- servidor, WebSockets (logs + terminal real + proxy WS) ----------
const srv=http.createServer(app),wss=new WebSocketServer({noServer:true});
function publicUrl(){const d=process.env.RAILWAY_PUBLIC_DOMAIN||process.env.RAILWAY_STATIC_URL;return d?'https://'+d.replace(/^https?:\/\//,''):null}
srv.on('upgrade',(q,sock,head)=>{const u=new URL(q.url,'http://x'),id=u.searchParams.get('id');
 const t=target(q);
 if(t){if(!t.pr.public&&!authed(q))return sock.destroy();const c=net.connect(t.pr.port,'127.0.0.1',()=>{c.write(`${q.method} ${t.rest} HTTP/1.1\r\n`+Object.entries({...q.headers,host:'127.0.0.1:'+t.pr.port}).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');c.write(head);sock.pipe(c);c.pipe(sock)});c.on('error',()=>sock.destroy());sock.on('error',()=>c.destroy());return}
 if(!authed(q))return sock.destroy();
 if(u.pathname==='/ws'&&getMeta(id))return wss.handleUpgrade(q,sock,head,ws=>{const l=L(id);for(const x of l.ring.slice(-300))ws.send(x);l.subs.add(ws);ws.on('close',()=>l.subs.delete(ws))});
 if(u.pathname==='/term'){const m=id?getMeta(id):null;if(id&&!m)return sock.destroy();
  return wss.handleUpgrade(q,sock,head,async ws=>{
   const cwd=m?sdir(m.id):path.join(DATA,'workspace');fs.mkdirSync(cwd,{recursive:true});const uid=m?uidOf(m.id):uidOf('00000000');if(ROOT){await own(m?m.id:'00000000',m?pdir(m.id):cwd);if(!m)await own('00000000',cwd)}
   const home=path.join(cwd,'.home');fs.mkdirSync(home,{recursive:true});if(ROOT)await own(m?m.id:'00000000',home);
   const env={HOME:home,TERM:'xterm-256color',PATH:process.env.PATH,LANG:'C.UTF-8',...(m?(m.env||{}):{})};const o={cwd,env,detached:true};if(ROOT)o.uid=o.gid=uid;
   const p=spawn('script',['-qfec','/bin/bash -i','/dev/null'],o);p.stdout.on('data',d=>ws.readyState===1&&ws.send(d.toString('utf8')));p.stderr.on('data',d=>ws.readyState===1&&ws.send(d.toString('utf8')));
   p.on('error',e=>{ws.send('No se pudo abrir la terminal: '+e.message);ws.close()});p.on('close',()=>ws.close());
   ws.on('message',d=>{try{p.stdin.write(d.toString())}catch{}});ws.on('close',()=>{try{process.kill(-p.pid,'SIGKILL')}catch{}})})}
 sock.destroy()});

// ---------- arranque ----------
const PORT=+process.env.PORT||3000;
srv.listen(PORT,'0.0.0.0',async()=>{
 const url=publicUrl(),line='═'.repeat(64);
 console.log('\n'+line+'\n  UNIVERSAL CODE RUNNER está en línea\n'+line);
 console.log(url?`  🌐 Abre tu web:  ${url}`:`  🌐 Local: http://localhost:${PORT}\n  ⚠  Railway: Settings → Networking → "Generate Domain" para obtener el link público.`);
 if(generated.includes('ADMIN_TOKEN'))console.log(`  🔑 ADMIN_TOKEN generado (cópialo ahora): ${ADMIN}\n     Para fijar el tuyo, define la variable ADMIN_TOKEN en Railway.`);
 else console.log('  🔑 Entra con tu ADMIN_TOKEN.');
 if(!process.env.RAILWAY_VOLUME_MOUNT_PATH&&process.env.RAILWAY_ENVIRONMENT)console.log('  ⚠  Sin Volume: proyectos y secretos se pierden en cada deploy. Añade un Volume montado en /data.');
 if(!ROOT)console.log('  ⚠  No corre como root: no hay aislamiento por usuario entre proyectos.');
 console.log(line+'\n');
 // restaurar procesos que estaban activos antes del deploy/reinicio
 for(const m of allMeta())if(m.desired==='running')start(m,'Restaurado tras reinicio del servidor').catch(e=>log(m.id,e.message,1))});
const bye=()=>{for(const[,p]of procs){p.stopping=true;try{process.kill(-p.child.pid,'SIGTERM')}catch{}}setTimeout(()=>process.exit(0),3000)};
process.on('SIGTERM',bye);process.on('SIGINT',bye);
