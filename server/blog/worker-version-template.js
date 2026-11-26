async () => {
  const config = __BLOG_RELEASE_CONFIGURATION__;
  const worker = 'vellivex-site-migration';
  const account = '/accounts/' + accountId;
  const deployments = account + '/workers/scripts/' + worker + '/deployments';
  const versions = account + '/workers/workers/' + worker + '/versions';
  const check = (valid, message) => { if (!valid) throw Error(message); };
  const canonical = value => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
  const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const active = async () => (await cloudflare.request({method:'GET', path:deployments})).result.deployments[0];
  const isLive = (d,version) => d.versions?.length === 1 && d.versions[0].version_id === version && d.versions[0].percentage === 100;
  const requireOriginal = async () => {
    const d=await active();
    check(d.id===config.baseDeployment && isLive(d,config.baseVersion),'Production deployment changed; reconcile before publishing');
  };
  const read = async id => (await cloudflare.request({method:'GET',path:versions+'/'+id,query:{include:'modules,sourcemaps'}})).result;
  const hash = async content => {
    const raw = atob(content), bytes = new Uint8Array(raw.length);
    for (let i=0;i<raw.length;i++) bytes[i] = raw.charCodeAt(i);
    const sha = await crypto.subtle.digest('SHA-256',bytes);
    return [raw.length,Array.from(new Uint8Array(sha),n=>n.toString(16).padStart(2,'0')).join('')];
  };
  async function compareModules(source,inventory) {
    check(source.length===inventory.length && new Set(source.map(m=>m.name)).size===inventory.length,'Unexpected module count or duplicate names');
    for (const m of source) {
      const exp=inventory.find(item=>item.name===m.name);
      const [size,digest]=await hash(m.content_base64);
      check(exp && exp.type===m.content_type && exp.size===size && exp.sha256===digest,'Incorrect module: '+m.name);
    }
  }
  const old=await read(config.baseVersion);
  const expectedKeys=['annotations','author_email','author_id','bindings','compatibility_date','created_on','env','id','main_module','modules','number','source','startup_time_ms','urls','usage_model'];
  check(same(Object.keys(old).sort(),expectedKeys),'Review unexpected version settings before publishing');
  check(old.number===54 && old.id===config.baseVersion && old.main_module==='app-access-entry.mjs' &&
    old.compatibility_date==='2026-10-27' && old.usage_model==='standard','Incorrect baseline');
  await compareModules(old.modules,config.baseline);
  check(same(old.bindings.map(b=>b.name).sort(),['APP_ACCESS','BLOG_DB','DB','FEEDBACK_RATE_SECRET','MAIL_API','MARKETING_METRICS_DB','MESSENGER_RELEASES','PHONE_SHOP_SELLER_JSON','VELLIVEX_FEEDBACK_WRITE_HOLD_20261031']),'Unexpected baseline bindings');
  const blog=old.bindings.find(b=>b.name==='BLOG_DB');
  check(blog?.type==='d1' && (blog.database_id??blog.id)===config.database,'Incorrect original BLOG_DB binding');
  if (config.action==='stage' || config.action==='test') {
    await requireOriginal();
    const db=(await cloudflare.request({method:'GET',path:account+'/d1/database/'+config.database})).result;
    check(db.name==='vellivex-blog-content' && db.uuid===config.database,'Incorrect BLOG_DB');
    const modules=old.modules.map(({name,content_type,content_base64})=>({name,content_type,content_base64}));
    modules.find(m=>m.name==='blog-publisher.mjs').content_base64=config.renderer;
    await compareModules(modules,config.proposed);
    if(config.action==='test')return {ok:true,baseline:old.id,modules:modules.length,bindings:9};
    const payload={main_module:old.main_module,compatibility_date:old.compatibility_date,usage_model:old.usage_model,
      annotations:{'workers/message':'Serve photos on published Vellivex articles.'},
      bindings:old.bindings.map(b=>({name:b.name,type:'inherit',version_id:old.id})),modules};
    await requireOriginal();
    const newVersion=(await cloudflare.request({method:'POST',path:versions,query:{deploy:false},body:payload})).result;
    return {id:newVersion.id,number:newVersion.number,created_on:newVersion.created_on};
  }
  const target=await read(config.staged);
  check(target.id===config.staged && target.number>old.number,'Incorrect target');
  for(const key of ['main_module','compatibility_date','compatibility_flags','usage_model','limits','assets','placement','containers','exports','cache_options','migration_tag','sourcemaps','package_dependencies']){
    check(same(old[key],target[key]),'Runtime setting changed: '+key);
  }
  check(target.bindings.length===9 && old.bindings.every(b=>same(b,target.bindings.find(c=>c.name===b.name))),'Existing binding changed');
  check(same(old.env,target.env),'Inherited environment map changed');
  await compareModules(target.modules,config.proposed);
  const summary={verified:true,target:target.id,number:target.number,modules:target.modules.length,bindings:target.bindings.length,database:config.database};
  if(config.action==='verify') {
    const d=await active();return {...summary,deployment:d.id,versions:d.versions};
  }
  check(config.action==='deploy' || config.action==='rollback','Unknown action');
  let dest, annotation;
  if (config.action==='deploy'){
    await requireOriginal();dest=target.id;annotation='Publish photo support for Vellivex blog posts';
  } else {
    const d=await active();check(d.id===config.deployed && isLive(d,target.id),'Rollback guard: target no longer active');
    dest=old.id;annotation='Restore previous Vellivex site version';
  }
  const d=(await cloudflare.request({method:'POST',path:deployments,body:{strategy:'percentage',versions:[{version_id:dest,percentage:100}],annotations:{'workers/message':annotation}}})).result;
  const live=await active();check(d.id===live.id && isLive(live,dest),'Traffic readback failure');
  return {...summary,active:dest,deployment:live.id,versions:live.versions,created_on:live.created_on};
}
