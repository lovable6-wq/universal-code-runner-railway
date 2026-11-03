const fs=require('fs'),path=require('path');
const SKIP=new Set(['node_modules','.git','target','bin','obj','__pycache__','.pydeps','.home','.cargo','.m2','.nuget','.gopath','.gradle','venv','.venv','dist']);
const rd=p=>{try{return fs.readFileSync(p,'utf8')}catch{return''}};
function files(d,dep=0,o=[]){if(dep>4||o.length>400)return o;let es;try{es=fs.readdirSync(d,{withFileTypes:true})}catch{return o}
 for(const e of es){if(SKIP.has(e.name))continue;const p=path.join(d,e.name);e.isDirectory()?files(p,dep+1,o):o.push(p)}return o}
const first=(d,n)=>n.find(x=>fs.existsSync(path.join(d,x)));
const pick=(txt,libs)=>{for(const[l,re]of libs)if(re.test(txt))return l;return null};
function commands(fl){const s=new Set();
 for(const f of fl){if(!/\.(js|ts|mjs|py)$/.test(f))continue;let t;try{if(fs.statSync(f).size>2e5)continue;t=fs.readFileSync(f,'utf8')}catch{continue}
  for(const m of t.matchAll(/setName\(\s*['"`]([\w-]{1,32})['"`]/g))s.add(m[1]);
  for(const m of t.matchAll(/@[\w.]+\.(?:command|slash_command|hybrid_command)\([^)]*\)\s*(?:@[^\n]+\s*)*async\s+def\s+(\w+)/g))s.add(m[1])}
 return[...s].slice(0,60)}
const NODE=[['discord.js',/(^|\s)(discord\.js|@discordjs\/\S+)(\s|$)/],['Eris',/(^|\s)eris(\s|$)/],['Oceanic.js',/oceanic\.js/],['discordx',/discordx/],['Telegraf',/telegraf/],['grammY',/grammy/],['node-telegram-bot-api',/node-telegram-bot-api/],['Slack Bolt',/@slack\/bolt/],['tmi.js',/tmi\.js/],['Mineflayer',/mineflayer/]];
const PY=[['Pycord',/py-?cord/i],['Disnake',/disnake/i],['Nextcord',/nextcord/i],['discord.py',/^\s*discord(\.py)?\b/im],['python-telegram-bot',/python-telegram-bot/i],['aiogram',/aiogram/i],['Slack Bolt',/slack[-_]bolt/i],['TwitchIO',/twitchio/i]];
const X=(o)=>({env:{},need:[],...o});
module.exports=function detect(d){
 const fl=files(d),base={commands:commands(fl)},has=n=>fs.existsSync(path.join(d,n)),bot=l=>l?'bot':'server';
 const pj=rd(path.join(d,'package.json'));
 if(pj){let j={};try{j=JSON.parse(pj)}catch{}
  const deps={...j.dependencies,...j.devDependencies},lib=pick(Object.keys(deps).join(' '),NODE);
  const ts=!!deps.typescript||fl.some(f=>/\.ts$/.test(f)&&!/\.d\.ts$/.test(f));
  const main=j.main||first(d,['index.js','bot.js','main.js','src/index.js','index.ts','src/index.ts','src/bot.ts'])||'index.js';
  const sc=j.scripts||{};
  const run=sc.start?((ts&&sc.build?'npm run build && ':'')+'npm start'):(/\.ts$/.test(main)?'npx --yes tsx '+main:'node '+main);
  return X({...base,name:j.name,lang:ts?'TypeScript':'JavaScript',lib,kind:lib?'bot':'server',need:['node','npm'],cmd:'npm install --no-audit --no-fund && '+run})}
 const req=['requirements.txt','pyproject.toml','Pipfile'].map(n=>rd(path.join(d,n))).join('\n'),pe=first(d,['main.py','bot.py','app.py','index.py','run.py','src/main.py','src/bot.py','__main__.py']);
 if(first(d,['requirements.txt','pyproject.toml','Pipfile'])||pe){const lib=pick(req,PY);
  const inst=has('requirements.txt')?'.venv/bin/pip install -q -r requirements.txt && ':has('pyproject.toml')?'.venv/bin/pip install -q . && ':'';
  return X({...base,lang:'Python',lib,kind:bot(lib),need:['python3'],cmd:'[ -d .venv ] || python3 -m venv .venv; '+inst+'.venv/bin/python -u '+(pe||'main.py'),env:{PYTHONUNBUFFERED:'1',PIP_NO_CACHE_DIR:'1'}})}
 const gm=rd(path.join(d,'go.mod'));
 if(gm)return X({...base,lang:'Go',lib:pick(gm,[['discordgo',/discordgo/],['DisGo',/disgoorg/],['go-telegram-bot-api',/telegram-bot-api/]]),need:['go'],cmd:'go run .',env:{GOFLAGS:'-buildvcs=false'},get kind(){return bot(this.lib)}});
 const ct=rd(path.join(d,'Cargo.toml'));
 if(ct)return X({...base,lang:'Rust',lib:pick(ct,[['Serenity',/serenity/],['Twilight',/twilight/],['Poise',/poise/]]),need:['cargo'],cmd:'cargo run --release',get kind(){return bot(this.lib)}});
 const pom=rd(path.join(d,'pom.xml')),jl=[['JDA',/net\.dv8tion/],['Discord4J',/discord4j/]];
 if(pom)return X({...base,lang:'Java',lib:pick(pom,jl),need:['mvn','java'],cmd:'mvn -q -B -DskipTests package && java -jar $(ls target/*.jar | grep -v original | head -1)',get kind(){return bot(this.lib)}});
 const gr=rd(path.join(d,'build.gradle'))+rd(path.join(d,'build.gradle.kts'));
 if(gr)return X({...base,lang:'Java',lib:pick(gr,jl),need:['gradle','java'],cmd:'gradle run --no-daemon',get kind(){return bot(this.lib)}});
 const cs=fl.find(f=>f.endsWith('.csproj'));
 if(cs){const t=rd(cs),rel=path.relative(d,cs);return X({...base,lang:'C#',lib:pick(t,[['Discord.Net',/Discord\.Net/],['DSharpPlus',/DSharpPlus/]]),need:['dotnet'],cmd:'dotnet run -c Release'+(rel.includes(path.sep)?' --project '+rel:''),env:{DOTNET_NOLOGO:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1'},get kind(){return bot(this.lib)}})}
 if(has('composer.json')||fl.some(f=>/\.php$/.test(f))){const e=first(d,['index.php','public/index.php','bot.php','main.php']);
  return X({...base,lang:'PHP',lib:null,kind:'server',need:['php'],cmd:(has('composer.json')?'composer install -q --no-interaction && ':'')+(e&&/index\.php$/.test(e)?'php -S 0.0.0.0:$PORT'+(e.startsWith('public')?' -t public':''):'php '+(e||'main.php')),port:e&&/index\.php$/.test(e)?1:undefined})}
 if(has('Gemfile')||fl.some(f=>/\.rb$/.test(f)))return X({...base,lang:'Ruby',lib:null,kind:'server',need:['ruby'],cmd:(has('Gemfile')?'bundle config set path .bundle && bundle install -q && bundle exec ruby ':'ruby ')+(first(d,['main.rb','app.rb','bot.rb','index.rb'])||'main.rb')});
 const sf=(ext,n,lang,bin)=>{const f=first(d,n.map(x=>x+ext));return f?X({...base,lang,lib:null,kind:'script',need:[bin],cmd:bin+' '+f}):null};
 const sc=sf('.lua',['main','init','bot'],'Lua','lua5.4')||sf('.pl',['main','script'],'Perl','perl')||sf('.sh',['main','run','start'],'Bash','bash');
 if(sc)return sc;
 if(has('Makefile'))return X({...base,lang:'C/C++',lib:null,kind:'app',need:['make'],cmd:'make && ./$(ls -t | grep -v -E "\\.|Makefile" | head -1)'});
 const c=fl.find(f=>/\.(c|cpp|cc)$/.test(f));
 if(c){const cpp=!/\.c$/.test(c);return X({...base,lang:cpp?'C++':'C',lib:null,kind:'app',need:[cpp?'g++':'gcc'],cmd:(cpp?'g++ -O2 -o app ':'gcc -O2 -o app ')+fl.filter(f=>cpp?/\.(cpp|cc)$/.test(f):/\.c$/.test(f)).map(f=>JSON.stringify(path.relative(d,f))).join(' ')+' && ./app'})}
 if(has('index.html'))return X({...base,lang:'HTML',lib:null,kind:'web',need:['python3'],cmd:'python3 -m http.server $PORT --bind 0.0.0.0',port:1});
 return X({...base,lang:'Desconocido',lib:null,kind:'app',cmd:null});
};
