"""Generic disposable Linux environments. No project-specific commands or adapters.
Agent scripts run only inside resource-capped containers, with no host mounts/socket.
Setup egress is restricted through a public-address dependency proxy. Checks run offline.
"""
import argparse, hashlib, json, os, pathlib, re, shutil, subprocess, tempfile, time, uuid
ROOT=pathlib.Path(__file__).resolve().parent
BASES={'ubuntu','debian','python','node','golang','rust','eclipse-temurin','ruby','php','mcr.microsoft.com/dotnet/sdk'}
def validate(p):
    if p.get('version')!=1:raise ValueError('Unknown environment version')
    image=p.get('image','')
    if not re.fullmatch(r'[a-z0-9./-]+:[A-Za-z0-9_.-]+',image) or image.rsplit(':',1)[0] not in BASES:raise ValueError('Choose a tagged official runtime image')
    for k in ['setup','prepare']:
        if not isinstance(p.get(k),str) or len(p[k])>50000:raise ValueError('Missing/big script: '+k)
    hosts=p.get('dependency_hosts',[])
    if not isinstance(hosts,list) or len(hosts)>40 or any(not re.fullmatch(r'(?=.{4,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',h) or '.' not in h or h.endswith(('.local','.internal','.localhost')) for h in hosts):raise ValueError('Invalid dependency host list')
    checks=p.get('checks',[])
    if not 2<=len(checks)<=30:raise ValueError('Need 2 to 30 substantive checks')
    ids=set()
    for c in checks:
        if not re.fullmatch(r'[a-z][a-z0-9_-]{0,59}',c.get('id','')) or c['id'] in ids:raise ValueError('Invalid/duplicate check id')
        ids.add(c['id'])
        if c.get('kind') not in ['preserve','requirement'] or not isinstance(c.get('script'),str) or not 1<=len(c['script'])<=50000:raise ValueError('Invalid check')
    if not any(c['kind']=='preserve' for c in checks) or not any(c['kind']=='requirement' for c in checks):raise ValueError('Need preserved behavior and new requirement checks')
    paths=p.get('protected_paths',[])
    if not paths or any(not safe_path(x) for x in paths):raise ValueError('Protect original tests/CI with relative paths')
    if not p.get('mutations') or len(p['mutations'])>5:raise ValueError('Need bounded negative controls')
    for m in p['mutations']:
        if not safe_path(m.get('path','')) or not m.get('find') or m.get('find')==m.get('replace') or m.get('check_id') not in ids:raise ValueError('Invalid mutation control')
    return p

def safe_path(s):return isinstance(s,str) and s and not s.startswith('/') and '..' not in pathlib.PurePosixPath(s).parts and '\\' not in s and '\0' not in s

def command(argv,timeout=600,log=None):
    start=time.monotonic()
    try:
        with tempfile.TemporaryFile() as f:
            p=subprocess.Popen(argv,stdout=f,stderr=subprocess.STDOUT)
            try:code=p.wait(timeout=timeout);timed=False
            except subprocess.TimeoutExpired:p.kill();p.wait();code=124;timed=True
            f.seek(0,2);size=f.tell();f.seek(max(0,size-200000));out=f.read().decode(errors='replace')
        if log:pathlib.Path(log).write_text(out)
        return {'code':code,'output':out,'seconds':round(time.monotonic()-start,3),'timed_out':timed}
    except Exception as e:return {'code':-1,'output':str(e),'seconds':round(time.monotonic()-start,3),'timed_out':False}

def docker(*args,timeout=600,required=True):
    r=command(['docker',*args],timeout)
    if required and r['code']:raise RuntimeError(r['output'][-6000:])
    return r

def execute(source,plan,out,phase='baseline'):
    validate(plan);out=pathlib.Path(out);out.mkdir(parents=True,exist_ok=True)
    key='goose-auto-'+uuid.uuid4().hex[:12];network=key+'-net';proxy=key+'-proxy';setup=key+'-setup';image=key+':prepared'
    report={'phase':phase,'started_at':time.time(),'plan_sha256':hashlib.sha256(json.dumps(plan,sort_keys=True).encode()).hexdigest(),'checks':[],'mutations':[],'ok':False}
    containers=[];volume=key+'-checks'
    work=pathlib.Path(tempfile.mkdtemp(prefix='goose-run-'))
    limits=['--cpus','2','--memory','3g','--pids-limit','384','--security-opt','no-new-privileges','--cap-drop','ALL','--ulimit','nofile=4096:4096']
    def save(): (out/'report.json').write_text(json.dumps(report,indent=2))
    def check(c,src_image=image):
        name=key+'-'+uuid.uuid4().hex[:8];containers.append(name)
        script=f"set -eu\ncd /workspace\n/bin/sh /acceptance/prepare.sh\n/bin/sh /acceptance/{c['id']}.sh\n"
        r=docker('run','--name',name,*limits,'--network','none','--user','1000:1000','--mount',f'type=volume,src={volume},dst=/acceptance,readonly','--tmpfs','/tmp:rw,nosuid,size=512m','--env','HOME=/home/goose','--env','CI=true','--env','PYTHONDONTWRITEBYTECODE=1','--workdir','/workspace',src_image,'/bin/sh','-c',script,timeout=min(int(c.get('timeout_seconds',300)),900)+30,required=False)
        if r['timed_out']:docker('kill',name,required=False)
        (out/f"{c['id']}-{len(report['checks'])}-{len(report['mutations'])}.log").write_text(r['output'])
        return {'id':c['id'],'title':c.get('title',c['id']),'kind':c['kind'],**r}
    try:
        docker('pull',plan['image']);base=docker('image','inspect',plan['image'],'--format','{{.Id}}')['output'].strip();report['base_image']=base
        if plan.get('base_image_digest') and base!=plan['base_image_digest']:raise RuntimeError('Base image changed since discovery; reassessment required')
        docker('pull','python:3.12-slim');docker('network','create','--internal',network)
        docker('volume','create',volume)
        # The proxy is the only internet-connected container. It contains no source or secrets.
        docker('create','--name',proxy,*limits,'--read-only','--env','GOOSE_ALLOWED_HOSTS='+','.join(plan['dependency_hosts']),'python:3.12-slim','python','-c',(ROOT/'egress.py').read_text());containers.append(proxy)
        docker('network','connect','--alias','dependency-proxy',network,proxy);docker('start',proxy)
        # Bind the workspace solely through Docker copy, never through host mounts.
        env=['--env', 'HTTP_PROXY=http://dependency-proxy:8080','--env','HTTPS_PROXY=http://dependency-proxy:8080','--env','http_proxy=http://dependency-proxy:8080','--env','https_proxy=http://dependency-proxy:8080','--env','NO_PROXY=localhost,127.0.0.1','--env','DEBIAN_FRONTEND=noninteractive']
        # Package installation needs ownership and UID operations, but never network administration or host privileges.
        docker('create','--name',setup,*limits,'--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER','--cap-add','SETUID','--cap-add','SETGID','--network',network,*env,'--workdir','/workspace',base,'sleep','infinity');containers.append(setup)
        docker('cp',str(pathlib.Path(source).resolve())+'/.',setup+':/workspace');docker('start',setup)
        (work/'setup.sh').write_text('set -eu\ncd /workspace\n'+plan['setup'])
        docker('cp',str(work/'setup.sh'),setup+':/tmp/goose-setup.sh')
        r=docker('exec',setup,'/bin/sh','/tmp/goose-setup.sh',timeout=900,required=False);report['setup']={**r};(out/'setup.log').write_text(r['output']);save()
        if r['code']:return report
        # Dependency setup must not rewrite the customer's original source or tests.
        original_files=sorted(p for p in pathlib.Path(source).rglob('*') if p.is_file())
        for begin in range(0,len(original_files),100):
            group=original_files[begin:begin+100]
            names=['/workspace/'+str(p.relative_to(source)) for p in group]
            if any('\n' in n or '\\' in n for n in names):raise RuntimeError('Unsupported filename in integrity check')
            expected=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+n+'\n' for p,n in zip(group,names))
            actual=docker('exec',setup,'sha256sum','--',*names)['output']
            if actual!=expected:raise RuntimeError('Environment setup changed original source or tests; discovery must repair setup')
        r=docker('exec',setup,'/bin/sh','-c',"mkdir -p /home/goose; (getent passwd 1000 >/dev/null || printf 'goose:x:1000:1000:Goose:/home/goose:/bin/sh\\n' >> /etc/passwd); chown -R 1000:1000 /workspace /home/goose; rm -f /tmp/goose-setup.sh",required=False)
        if r['code']:raise RuntimeError(r['output'])
        docker('commit',setup,image);docker('rm','-f',setup);docker('rm','-f',proxy)
        # A separate root-owned volume supplies acceptance scripts read-only to each independent check.
        scripts=work/'checks';scripts.mkdir();(scripts/'prepare.sh').write_text('set -eu\n'+plan['prepare'])
        for c in plan['checks']:(scripts/(c['id']+'.sh')).write_text('set -eu\n'+c['script'])
        seed=key+'-seed';containers.append(seed)
        docker('create','--name',seed,'--network','none','--mount',f'type=volume,src={volume},dst=/acceptance',base,'true');docker('cp',str(scripts)+'/.',seed+':/acceptance');docker('rm',seed)
        for c in plan['checks']:
            r=check(c);r['expected']='pass' if phase=='verify' or c['kind']=='preserve' else 'fail'
            r['accepted']=(r['code']==0 if r['expected']=='pass' else r['code']>0 and not r['timed_out'] and bool(re.search(r'assert|expect|fail',r['output'],re.I)))
            report['checks'].append(r);save()
        if phase=='baseline':
            for i,m in enumerate(plan['mutations']):
                file=pathlib.Path(source)/m['path'];text=file.read_text()
                if text.count(m['find'])!=1:raise RuntimeError('Negative control must match exactly once: '+m['path'])
                changed=work/f'mutation-{i}';changed.write_text(text.replace(m['find'],m['replace'],1));changed.chmod(0o644)
                name=key+f'-mut-{i}';containers.append(name);mutimage=key+f':mutation-{i}'
                docker('create','--name',name,'--network','none',image,'true');docker('cp',str(changed),name+':/workspace/'+m['path']);docker('commit',name,mutimage)
                try:
                    c=next(c for c in plan['checks'] if c['id']==m['check_id']);r=check(c,mutimage)
                    # A failing build/import is not evidence that a behavior assertion noticed the mutation.
                    detected=r['code']>0 and not r['timed_out'] and bool(re.search(r'AssertionError|assert |expected|not ok',r['output'],re.I)) and not bool(re.search(r'SyntaxError|ModuleNotFoundError|command not found',r['output']))
                    report['mutations'].append({'path':m['path'],'check_id':m['check_id'],'detected':detected,**r});save()
                finally:docker('image','rm','-f',mutimage,required=False)
        report['ok']=all(c['accepted'] for c in report['checks']) and (phase!='baseline' or all(m['detected'] for m in report['mutations']))
    except Exception as e:report['error']=str(e)
    finally:
        for c in containers:docker('rm','-f',c,required=False)
        docker('image','rm','-f',image,required=False);docker('volume','rm','-f',volume,required=False);docker('network','rm',network,required=False)
        shutil.rmtree(work,ignore_errors=True);report['finished_at']=time.time();save()
    return report

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--source',required=True);ap.add_argument('--plan',required=True);ap.add_argument('--out',required=True);ap.add_argument('--phase',choices=['baseline','verify'],default='baseline');a=ap.parse_args()
    p=json.loads(pathlib.Path(a.plan).read_text());r=execute(a.source,p,a.out,a.phase);print(json.dumps({'ok':r['ok'],'checks':[{k:c[k] for k in ['id','code','accepted']} for c in r['checks']],'error':r.get('error')}));raise SystemExit(0 if r['ok'] else 1)
