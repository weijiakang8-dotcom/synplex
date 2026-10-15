"""One free clean-engine scenario: isolated install -> API -> durable restart.

No provider configured, no invocation, no shared database or active queue touched.
Private evidence/state are kept so an interrupted check can be investigated.
"""
import asyncio
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import time
import uuid

import httpx
import psycopg

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "integrations/agenthub"))
from private_infrastructure import prepare, OwnedInfrastructure, safe_env, read_private
from engine_runtime import setup


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


provider_client_script = r'''
import asyncio,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from local_runner import load_config
data=load_config(Path(sys.argv[2]),Path(sys.argv[3]))
import httpx
def forbidden(*args,**kwargs):raise AssertionError('External HTTP forbidden in free provider check')
httpx.Client.send=forbidden
httpx.AsyncClient.send=forbidden
from app.database import async_session_factory
from app.models import ModelConfig
from sqlalchemy import select
from app.core import model_gateway
from langchain_core.messages import HumanMessage
from engine_provider import load_provider
async def check():
 profile=load_provider(Path(sys.argv[2]),data)
 async with async_session_factory() as session:
  models=(await session.execute(select(ModelConfig))).scalars().all()
  assert len(models)==len(profile.models)
  for row,effort in zip(sorted(models,key=lambda r:r.model),['high','max']):
   assert row.api_key.startswith('synplex-runtime-provider:') and 'not-a-valid' not in row.api_key
   client=model_gateway.get_chat_model(row,reasoning_effort=effort)
   assert client.openai_api_key.get_secret_value()=='test-only-not-a-valid-provider-key'
   payload=client._get_request_payload([HumanMessage(content='Never send this offline fixture')])
   assert payload['model']==row.model and payload['reasoning_effort']==effort
   assert payload.get('extra_body')==({'thinking':{'type':'enabled'}} if profile.provider=='deepseek' else None)
   assert payload['max_completion_tokens']==512 and payload.get('temperature') is None
   assert await model_gateway.ModelGateway()._rate_for_model(row.model,data['organization_id']) is None
   assert await model_gateway.ModelGateway()._cost_for(row.model,data['organization_id'],100,100) is None
   try:model_gateway.get_chat_model(row,reasoning_effort='ultra')
   except RuntimeError:pass
   else:raise AssertionError('Unreviewed effort accepted')
   row.max_tokens=8193
   try:model_gateway.get_chat_model(row,reasoning_effort='high')
   except RuntimeError:pass
   else:raise AssertionError('Database row bypassed configured output limit')
 print('Configured provider clients and efforts; unknown price stays unknown; external HTTP blocked; modelCalls=0')
asyncio.run(check())
'''


def provider_check(backend, valkey, pg_bin, directory, *, resume=False, provider="deepseek"):
    from engine_provider import configure, load_provider
    from engine_runtime import configuration, supervise
    from engine_recovery import snapshot, restore
    from private_infrastructure import write_private
    if directory.exists() and not resume:
        raise RuntimeError('Use a new provider evidence directory, never overwrite an interrupted setup')
    if resume:
        saved,_,data=configuration(directory)
        assert data['model_mode'] in {'disabled','configured'}
        ports=[saved[k] for k in ['apiPort','redisPort','databasePort']]
    else:
        ports=[free_port() for _ in range(3)];assert len(set(ports))==3
        setup(directory,backend,pg_bin,valkey,api_port=ports[0],redis_port=ports[1],database_port=ports[2])
    keyfile=directory/'test-provider-key'
    if not resume:
        keyfile.write_text('test-only-not-a-valid-provider-key');os.chmod(keyfile,0o600)
    else:
        assert keyfile.read_text()=='test-only-not-a-valid-provider-key'
    spec=directory/'test-provider-profile.json'
    from engine_provider import PROVIDERS
    payload={'provider':provider,'models':list(PROVIDERS[provider][1]),'maxTokens':512,'tokenFile':str(keyfile)}
    for invalid in ([] if resume else [{**payload,'baseUrl':'https://unapproved.invalid'},{**payload,'models':['not-evaluated']},{**payload,'maxTokens':True}]):
        write_private(spec,invalid)
        try:configure(directory,spec)
        except RuntimeError:pass
        else:raise AssertionError('Unreviewed provider settings accepted')
        assert not (directory/'engine/provider.json').exists()
        assert configuration(directory)[2]['model_mode']=='disabled'
    if not resume:
        write_private(spec,payload)
        os.chmod(keyfile,0o644)
        try:configure(directory,spec)
        except RuntimeError:pass
        else:raise AssertionError('Broadly readable provider key accepted')
        os.chmod(keyfile,0o600)
        write_private(directory/'provider-update-incomplete.json',{'fixture':'unfinished configuration'})
        try:configuration(directory)
        except RuntimeError:pass
        else:raise AssertionError('Unfinished provider setup accepted')
        (directory/'provider-update-incomplete.json').unlink()
    else:
        assert read_private(spec)==payload
    if configuration(directory)[2]['model_mode']=='disabled':
        assert configure(directory,spec)['modelCalls']==0
    else:
        prior=load_provider(directory/'engine',data)
        assert prior.models==tuple(payload['models']) and prior.max_tokens==512
        assert prior.credential=='test-only-not-a-valid-provider-key'
    saved,infra,data=configuration(directory)
    assert saved['providerConfigured'] and data['model_mode']=='configured'
    assert 'test-only' not in repr(load_provider(directory/'engine',data))
    owned=OwnedInfrastructure(infra);child=None
    try:
        owned.start_database();owned.start_queue(valkey,directory/'engine')
        with open(directory/'provider-api.log','ab') as log:
            os.chmod(log.name,0o600)
            child=subprocess.Popen([sys.executable,'-B',str(root/'integrations/agenthub/local_runner.py'),
                                    '--state',str(directory/'engine'),'--backend',str(backend),'api'],
                                   stdin=subprocess.DEVNULL,stdout=log,stderr=log,env=safe_env())
            deadline=time.monotonic()+25
            while True:
                assert child.poll() is None, 'Private provider API exited; inspect its own log'
                try:
                    response=httpx.get(f'http://127.0.0.1:{ports[0]}/health/live',timeout=1)
                    if response.status_code==200:break
                except httpx.HTTPError:pass
                if time.monotonic()>deadline:raise RuntimeError('Private provider API did not become ready')
                time.sleep(0.1)
            token=(directory/'engine/access-token').read_text()
            with httpx.Client(base_url=f'http://127.0.0.1:{ports[0]}',headers={'Authorization':'Bearer '+token}) as client:
                options=client.get('/api/synplex/model-options').json()
                assert {c['id'] for c in options['choices']}==set(payload['models'])
                assert all(c['efforts']==['low','high','max'] for c in options['choices'])
                assert client.get('/api/synplex/input-capabilities').json()['documentText'] is True
                denied=client.post('/api/synplex/executions',json={'workflow_id':data['workflow_id'],'user_input':'Do not submit',
                    'model_selection':{'provider':provider,'model':'not-enabled','reasoning_effort':'high'}})
                assert denied.status_code==422
            result=subprocess.run([sys.executable,'-B','-c',provider_client_script,str(root/'integrations/agenthub'),
                                   str(directory/'engine'),str(backend)],env=safe_env(),capture_output=True,timeout=25)
            (directory/'provider-client-check.log').write_bytes(result.stdout+result.stderr);os.chmod(directory/'provider-client-check.log',0o600)
            assert result.returncode==0, 'Private client construction failed; inspect isolated evidence'
            from local_runner import database_connection
            with psycopg.connect(**database_connection(data,data['database'])) as db:
                assert db.execute('SELECT count(*) FROM executions').fetchone()[0]==0
                assert db.execute('SELECT count(*) FROM outbox_events').fetchone()[0]==0
            child.terminate();child.wait(timeout=15);child=None
    finally:
        if child and child.poll() is None:child.terminate();child.wait(timeout=15)
        owned.close()
    snapshot_dir=directory.with_name(directory.name+'-snapshot')
    restored_dir=directory.with_name(directory.name+'-restored')
    snapshot(directory,snapshot_dir)
    new_ports=[free_port() for _ in range(3)];assert len(set(new_ports))==3
    restore(snapshot_dir,restored_dir,backend=backend,pg_bin=pg_bin,valkey=valkey,
            api_port=new_ports[0],redis_port=new_ports[1],database_port=new_ports[2])
    new_saved,new_infra,new_data=configuration(restored_dir)
    assert new_saved['providerConfigured'] and new_data['model_mode']=='configured'
    assert load_provider(restored_dir/'engine',new_data)==load_provider(directory/'engine',data)
    from local_runner import load_config
    try:load_config(restored_dir/'engine',backend)
    except RuntimeError as error:assert '执行器保持停用' in str(error)
    else:raise AssertionError('Direct runner bypassed restored execution guard')
    try:supervise(restored_dir)
    except RuntimeError as error:assert '执行器保持停用' in str(error)
    else:raise AssertionError('Restored configured provider started without reconciliation')
    return {'providerConfiguration':'passed','provider':provider,'models':payload['models'],'modelCalls':0,'executionsCreated':0,
            'providerBackupRestore':'passed','restoredExecutorsEnabled':False,'realAccountValidation':'not_run'}


checkpoint_script = r'''
import asyncio,json,sys
from typing import TypedDict
import psycopg
from psycopg.rows import dict_row
from langgraph.graph import StateGraph,START,END
from langgraph.types import interrupt,Command
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from local_runner import database_connection
state=json.loads(Path(sys.argv[2]).read_text())
params=database_connection(state,state['database']);params.pop('connect_timeout')
url=psycopg.conninfo.make_conninfo(**params)
class State(TypedDict):
    answer:str
async def before(state):
    async with await psycopg.AsyncConnection.connect(url) as connection:
        await connection.execute("INSERT INTO synplex_restart_check(kind) VALUES ('completed_step')")
    return state
async def question(state):
    answer=interrupt('需要什么格式？')
    return {'answer':answer}
async def main():
    graph=StateGraph(State);graph.add_node('before',before);graph.add_node('question',question)
    graph.add_edge(START,'before');graph.add_edge('before','question');graph.add_edge('question',END)
    async with AsyncPostgresSaver.from_conn_string(url) as saver:
        await saver.setup()
        agent=graph.compile(checkpointer=saver)
        config={'configurable':{'thread_id':sys.argv[4]}}
        result=await agent.ainvoke({'answer':''} if sys.argv[3]=='begin' else Command(resume='文字'),config)
        if sys.argv[3]=='begin':assert result['__interrupt__']
        else:assert result['answer']=='文字'
asyncio.run(main())
'''


workspace_recovery_script = r'''
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WorkspaceRepository} from './services/workspace/repository.mjs';
import {payloadHash} from './packages/contracts/validate.mjs';
import {inspectDatabase} from './scripts/runtime/recovery.mjs';
import {settings,supervise} from './scripts/runtime/workspace.mjs';
const [mode,dataDir,port,engineDir,snapshotDir]=process.argv.slice(1);
if(mode==='init'){
 const repo=new WorkspaceRepository({dataDir});
 try{
  const scope={projectId:'joint-recovery',versionId:null,branchId:null};
  const capabilities=['read_memory','write_memory','prepare_task','record_result'];
  const ui=repo.createCredential({ownerId:'recovery-fixture',actorId:'human',scope,capabilities:[...capabilities,'review_memory'],kind:'ui'});
  const agent=repo.createCredential({ownerId:'recovery-fixture',actorId:'host',scope,capabilities,kind:'agent'});
  const tokenDir=join(dataDir,'connections');mkdirSync(tokenDir,{mode:0o700});
  const uiTokenFile=join(tokenDir,'ui-token'),agentTokenFile=join(tokenDir,'agent-token');
  writeFileSync(uiTokenFile,ui.token,{flag:'wx',mode:0o600});writeFileSync(agentTokenFile,agent.token,{flag:'wx',mode:0o600});
  writeFileSync(join(dataDir,'connection.json'),JSON.stringify({scope,endpoint:`http://127.0.0.1:${port}`,uiTokenFile,agentTokenFile}),{flag:'wx',mode:0o600});
  const auth=repo.authenticate(ui.token),r=await repo.forScope(auth,scope);
  await r.saveBlob({bytes:Buffer.from('联合恢复原件，未知任务不能重发。'),format:'text/plain'},{requestId:'joint-source',expectedStateRevision:0});
 }finally{repo.close();}
 const db=new DatabaseSync(join(dataDir,'workspace.sqlite'));
 try{
  const partition=db.prepare('SELECT partition FROM scopes LIMIT 1').get().partition;
  const unknown={id:'joint-original-unknown',requestId:'joint-original-request',status:'unknown',executionStatus:'unknown',writebackStatus:'pending',resultId:null,error:null};
  db.prepare('INSERT INTO records(partition,kind,id,payload_hash,body_json) VALUES(?,?,?,?,?)').run(partition,'operation',unknown.id,payloadHash(unknown),JSON.stringify(unknown));
 }finally{db.close();}
 const data=JSON.parse(readFileSync(join(engineDir,'engine/bootstrap.json'),'utf8'));
 writeFileSync(join(dataDir,'executors.json'),JSON.stringify({synplex:{endpoint:`http://127.0.0.1:${data.api_port}`,workflowId:data.workflow_id,tokenFile:join(engineDir,'engine/access-token')}}),{flag:'wx',mode:0o600});
}else{
 const m=JSON.parse(readFileSync(join(snapshotDir,'workspace/snapshot.json'),'utf8'));
 assert.deepEqual(inspectDatabase(join(dataDir,'workspace.sqlite')),m.data);
 assert.equal(existsSync(join(dataDir,'executors.json')),false);
 assert.deepEqual(JSON.parse(readFileSync(join(dataDir,'executors.before-recovery.json'),'utf8')),JSON.parse(readFileSync(join(snapshotDir,'workspace/executors.json'),'utf8')));
 const config=settings({dataDir,port:Number(port)});
 let managed,timer;
 try{
  let notify;const ready=new Promise(resolve=>notify=resolve);
  managed=await supervise(config,{openBrowser:false,onReady:notify});
  const event=await Promise.race([ready,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('recovery preview timeout')),15000))]);
  assert.equal(event.error,undefined);assert.equal((await fetch(config.endpoint+'/health')).ok,true);
 }finally{clearTimeout(timer);await managed?.close();}
 assert.deepEqual(inspectDatabase(join(dataDir,'workspace.sqlite')),m.data);
}
console.log(JSON.stringify({workspaceRecovery:mode,modelCalls:0}));
'''


def recovery_check(directory, backend, valkey, pg_bin, evidence_root):
    from local_runner import database_connection
    from engine_recovery import unused, settled
    import fcntl
    from redis import Redis
    state=directory/'engine'
    data=read_private(state/'bootstrap.json')
    infra=read_private(directory/'infrastructure/infrastructure.json')
    runtime=root/'integrations/agenthub/engine_runtime.py'
    protected=state/'artifacts'/'恢复核对.md'
    assert protected.is_file()
    def refused_start(path, reason):
        # CLI deliberately masks arbitrary exceptions; inspect the exact guard
        # inside this isolated subprocess instead of weakening user error safety.
        code="import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from engine_runtime import supervise\ntry:supervise(Path(sys.argv[2]))\nexcept RuntimeError as e:\n assert sys.argv[3] in str(e)\n sys.exit(17)"
        result=subprocess.run([sys.executable,'-B','-c',code,str(root/'integrations/agenthub'),str(path),reason],
                              env=safe_env(),capture_output=True,timeout=15)
        assert result.returncode==17, 'Expected engine safety guard did not fire'
    owned=OwnedInfrastructure(infra)
    try:
        owned.start_database()
        with psycopg.connect(**database_connection(data,data['database'])) as db:
            pending=db.execute("SELECT id FROM executions WHERE user_input='unfinished original' AND status='pending'").fetchall()
            assert len(pending)==1
            eid=str(pending[0][0])
    finally:
        owned.close()
    # Only this exact startup descriptor is exempt, never another handle owned
    # by the same process. A held lock must also prevent a supervisor start.
    with open(directory/'startup.lock','a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        settled(directory,lock)
        with open(protected,'rb'):
            try:unused(directory,lock)
            except RuntimeError:pass
            else:raise AssertionError('Open source file was exempted with lock')
        refused_start(directory,'引擎正在运行或维护')
    from engine_recovery import product_snapshot, product_restore, verify_product
    node=Path(shutil.which('node'))
    workspace=evidence_root.with_name(evidence_root.name+'-workspace')
    def workspace_check(mode, path, port, snapshot_dir=None):
        result=subprocess.run([str(node),'--input-type=module','-e',workspace_recovery_script,mode,str(path),str(port),str(directory),str(snapshot_dir or '')],
                              cwd=root,env=safe_env(),capture_output=True,timeout=40)
        # These fixed fixtures contain no credentials in their output.
        log=evidence_root.with_name(evidence_root.name+'-workspace-'+mode+'.log')
        log.write_bytes(result.stdout+result.stderr);os.chmod(log,0o600)
        assert result.returncode==0, 'Workspace fixture failed; inspect private evidence'
    workspace_check('init',workspace,free_port())
    snapshot_dir=evidence_root.with_name(evidence_root.name+'-snapshot')
    restored_dir=evidence_root.with_name(evidence_root.name+'-restored')
    product_snapshot(workspace,directory,snapshot_dir,node=node)
    verify_product(snapshot_dir,node=node)
    # Broken archives are refused before a restore directory is created.
    archive=snapshot_dir/'engine/engine.pgdump'
    original=archive.read_bytes();archive.write_bytes(original[:-1])
    try:
        verify_product(snapshot_dir,node=node)
    except RuntimeError:
        pass
    else:
        raise AssertionError('Damaged archive accepted')
    archive.write_bytes(original)
    new_ports=[free_port() for _ in range(4)];assert len(set(new_ports))==4
    restored=product_restore(snapshot_dir,restored_dir,node=node,workspace_port=new_ports[3],backend=backend,pg_bin=pg_bin,valkey=valkey,
                             api_port=new_ports[0],redis_port=new_ports[1],database_port=new_ports[2])
    assert restored['executorsEnabled'] is False
    assert restored['remoteIdentitiesRemapped'] is False
    product_root=restored_dir
    restored_dir=product_root/'engine'
    new_state=read_private(restored_dir/'engine/bootstrap.json')
    assert new_state['id']==data['id'] and new_state['database']==data['database']
    assert new_state['model_mode']=='disabled'
    restore_infra=read_private(restored_dir/'infrastructure/infrastructure.json')
    owned=OwnedInfrastructure(restore_infra)
    try:
        owned.start_database()
        with psycopg.connect(**database_connection(new_state,new_state['database'])) as db:
            assert db.execute("SELECT status FROM executions WHERE id=%s",(eid,)).fetchone()[0]=='pending'
            assert db.execute('SELECT count(*) FROM synplex_restart_check').fetchone()[0]==1
        assert (restored_dir/'engine/artifacts/恢复核对.md').read_bytes()==protected.read_bytes()
        owned.start_queue(valkey,restored_dir/'engine')
        queue=Redis(host='127.0.0.1',port=new_state['redis_port'],password=new_state['redis_password'])
        assert queue.lrange('synplex:restore-check',0,-1)==[b'preserve-without-replay'];queue.close()
    finally:
        owned.close()
    refused_start(restored_dir,'执行器保持停用')
    workspace_check('verify',product_root/'workspace',new_ports[3],snapshot_dir)
    return {"engineRecovery":"passed","workspaceRecovery":"passed","modelCalls":0,"executorsEnabled":False,
            "remoteIdentitiesRemapped":False,"tableCount":len(read_private(snapshot_dir/'engine/engine-snapshot.json')['database'])}


def run_check(backend, valkey, pg_bin, directory):
    if directory.exists():
        raise RuntimeError("Use a new evidence directory; never repeat an interrupted operation")
    api_port, redis_port, pg_port = free_port(), free_port(), free_port()
    assert len({api_port, redis_port, pg_port}) == 3
    setup(directory, backend, pg_bin, valkey, api_port=api_port, redis_port=redis_port, database_port=pg_port)
    infra = read_private(directory / "infrastructure/infrastructure.json")
    owned = OwnedInfrastructure(infra)
    state = directory / "engine"
    api_child = worker_child = supervisor_child = None
    logs = []
    runner = root / "integrations/agenthub/local_runner.py"
    try:
        owned.start_database()
        owned.start_queue(valkey, state)

        def start_process(command, name):
            log = open(directory / name, "ab");os.chmod(log.name, 0o600);logs.append(log)
            return subprocess.Popen([sys.executable, "-B", str(runner), "--state", str(state), "--backend", str(backend), command],
                                    env=safe_env(), stdin=subprocess.DEVNULL, stdout=log, stderr=log)

        def ready(child):
            for _ in range(200):
                if child.poll() is not None:
                    raise RuntimeError("Clean engine API exited; inspect its private log")
                try:
                    response = httpx.get(f"http://127.0.0.1:{api_port}/health/live", timeout=1)
                    if response.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                time.sleep(0.1)
            raise RuntimeError("Clean engine API startup timed out")

        api_child = start_process("api", "api.log");ready(api_child)
        data = read_private(state / "bootstrap.json")
        assert data["model_mode"] == "disabled"
        base = f"http://127.0.0.1:{api_port}"
        headers = {"Authorization": "Bearer " + (state / "access-token").read_text()}
        with httpx.Client(base_url=base, headers=headers, timeout=10) as client:
            assert client.get("/api/synplex/model-options").json()["choices"] == []
            assert client.get("/api/workflows/" + data["workflow_id"]).status_code == 200
            denied = client.post("/api/synplex/executions", json={"workflow_id":data["workflow_id"], "user_input":"Do not execute",
                                "model_selection":{"provider":"deepseek", "model":"deepseek-flash", "reasoning_effort":"low"}})
            assert denied.status_code == 422, denied.text
        # A real worker process imports all paths in this independently installed environment.
        # The queue has no executions, and no model is enabled.
        api_child.terminate();api_child.wait(timeout=15);api_child=None
        worker_child = start_process("worker", "worker.log")
        time.sleep(2)
        assert worker_child.poll() is None
        worker_child.terminate();worker_child.wait(timeout=15);worker_child=None

        sys.path.insert(0, str(root / "integrations/agenthub"))
        from local_runner import database_connection
        connection = database_connection(data, data["database"])
        with psycopg.connect(**connection) as db:
            assert db.execute("SELECT COUNT(*) FROM executions").fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM outbox_events").fetchone()[0] == 0
            db.execute("CREATE TABLE synplex_restart_check(kind TEXT NOT NULL)")
        thread_id = str(uuid.uuid4())
        (directory / "checkpoint-intent.json").write_text(json.dumps({"threadId":thread_id}))
        script = directory / "durable-check.py";script.write_text(checkpoint_script)
        for mode in ["begin", "resume"]:
            if mode == "resume":
                owned.close();owned=OwnedInfrastructure(infra);owned.start_database();owned.start_queue(valkey,state)
            result = subprocess.run([sys.executable,"-B",str(script),str(root / "integrations/agenthub"),str(state / "bootstrap.json"),mode,thread_id],
                                    capture_output=True, env=safe_env())
            (directory / (mode+".log")).write_bytes(result.stdout+result.stderr)
            if result.returncode:
                raise RuntimeError("Durable checkpoint scenario failed; inspect private evidence")
        with psycopg.connect(**connection) as db:
            assert db.execute("SELECT COUNT(*) FROM synplex_restart_check").fetchone()[0] == 1
            assert db.execute("SELECT COUNT(*) FROM executions").fetchone()[0] == 0
        api_child=start_process("api","api.log");ready(api_child)
        with httpx.Client(base_url=base, headers=headers, timeout=10) as client:
            assert client.get("/api/synplex/model-options").json()["choices"] == []
            assert client.get("/api/workflows/"+data["workflow_id"]).status_code == 200
        api_child.terminate();api_child.wait(timeout=15);api_child=None
        owned.close()
        runtime=root / "integrations/agenthub/engine_runtime.py"
        with open(directory / "supervisor.log","ab") as log:
            supervisor_child=subprocess.Popen([sys.executable,"-B",str(runtime),"run","--root",str(directory)],
                                              env=safe_env(),stdin=subprocess.DEVNULL,stdout=log,stderr=log)
            ready(supervisor_child)
            duplicate=subprocess.run([sys.executable,"-B",str(runtime),"run","--root",str(directory)],
                                     env=safe_env(),capture_output=True,timeout=15)
            assert duplicate.returncode==1
            assert httpx.get(base+"/health/live",timeout=2).status_code==200
            supervisor_child.terminate();supervisor_child.wait(timeout=25);assert supervisor_child.returncode==0;supervisor_child=None
        # A stopped engine with an unfinished original request must not replay it.
        owned=OwnedInfrastructure(infra);owned.start_database()
        with psycopg.connect(**connection) as db:
            eid=str(uuid.uuid4())
            db.execute("INSERT INTO executions(id,workflow_id,organization_id,user_id,user_input,status,context_messages,event_sequence,run_attempt,input_tokens,output_tokens,current_step_index,correlation_id) VALUES (%s,%s,%s,%s,'unfinished original','pending','[]',0,0,0,0,0,%s)",
                       (eid,data['workflow_id'],data['organization_id'],data['user_id'],str(uuid.uuid4())))
        owned.close()
        refused=subprocess.run([sys.executable,"-B",str(runtime),"run","--root",str(directory)],env=safe_env(),capture_output=True,timeout=25)
        assert refused.returncode==1
        owned=OwnedInfrastructure(infra);owned.start_database()
        with psycopg.connect(**connection) as db:
            assert db.execute("SELECT status FROM executions WHERE id=%s",(eid,)).fetchone()[0]=='pending'
            assert db.execute("SELECT count(*) FROM synplex_restart_check").fetchone()[0]==1
        owned.close()
        for log in logs:
            log.close()
        logs.clear()
        # Original bytes and a persisted queue entry must survive alongside SQL.
        (state/'artifacts').mkdir(exist_ok=True,mode=0o700)
        protected=state/'artifacts'/'恢复核对.md'
        protected.write_text('原件和待核对结果必须保留。')
        os.chmod(protected,0o600)
        owned=OwnedInfrastructure(infra);owned.start_queue(valkey,state)
        from redis import Redis
        queue=Redis(host='127.0.0.1',port=data['redis_port'],password=data['redis_password'])
        queue.rpush('synplex:restore-check','preserve-without-replay');queue.close();owned.close()
        recovery_check(directory,backend,valkey,pg_bin,directory)
        evidence={"checks":["new locked Python environment", "new authenticated PostgreSQL cluster and private Valkey", "engine API imports and seeds vendored source",
                             "unauthorized model choices refused without dispatch", "separate real worker starts with an empty queue", "durable LangGraph interrupt across process and database restarts",
                             "completed node executed once", "same seeded workflow after restart", "supervised API/worker/database/queue and duplicate-start refusal", "unfinished original task blocks restart without redelivery",
                             "native offline PostgreSQL snapshot", "damaged archive refused", "new-directory database/file/queue restoration and every-table logical fingerprint", "original graph and pending identity retained without replay", "restored worker startup stays disabled"],
                  "modelCalls":0,"modelExecutionsCreated":0,"pendingSafetyFixture":1,"completedNodeCalls":1,
                  "limitations":["no real model execution or model-backed input delivery", "no cross-directory remote-task recovery", "uses explicitly located system PostgreSQL and evaluated Valkey binaries"]}
        (directory / "evidence.json").write_text(json.dumps(evidence,ensure_ascii=False,indent=2))
        print(json.dumps(evidence,ensure_ascii=False))
    finally:
        for child in [supervisor_child,worker_child,api_child]:
            if child and child.poll() is None:
                child.terminate();child.wait(timeout=15)
        for log in logs:log.close()
        owned.close()


def source_check(backend, valkey, pg_bin, directory):
    """One new native backup/restore with source identity; no task is dispatched."""
    from engine_runtime import configuration, ensure_execution_allowed
    from engine_recovery import snapshot, restore, database_state, verify_snapshot
    from local_runner import database_connection, load_config
    from source_identity import source_identity, runtime_identity
    if directory.exists():
        raise RuntimeError("Use a new source-check directory; inspect interrupted evidence first")
    directory.mkdir(parents=True, mode=0o700)
    copied = directory / 'backend-original'
    shutil.copytree(backend, copied, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    relocated = directory / 'backend-relocated'
    shutil.copytree(copied, relocated)
    original = directory / 'engine-original'
    ports = [free_port() for _ in range(3)]
    setup(original, copied, pg_bin, valkey, api_port=ports[0], redis_port=ports[1], database_port=ports[2])
    saved, infra, data = configuration(original)
    assert saved['sourceIdentity'] == source_identity(relocated)
    assert saved['runtimeIdentity'] == runtime_identity()
    artifact = original / 'engine/artifacts/source-check.txt'
    artifact.parent.mkdir(mode=0o700, exist_ok=True)
    artifact.write_text('源码一致才恢复；原任务不重发。');os.chmod(artifact, 0o600)
    owned = OwnedInfrastructure(infra)
    try:
        owned.start_database()
        with psycopg.connect(**database_connection(data, data['database'])) as db:
            db.execute('CREATE TABLE source_identity_check (value TEXT NOT NULL)')
            db.execute('INSERT INTO source_identity_check VALUES (%s)', ('原记录保全',))
        before = database_state(data)
    finally:
        owned.close()
    backup = directory / 'snapshot'
    snapshot(original, backup)
    next_ports = [free_port() for _ in range(3)]
    options = dict(backend=relocated, pg_bin=pg_bin, valkey=valkey, api_port=next_ports[0], redis_port=next_ports[1], database_port=next_ports[2])
    changed = relocated / 'app/source_identity_fixture.py'
    changed.write_text('# not part of the original source\n')
    rejected = directory / 'must-not-be-created'
    try:
        restore(backup, rejected, **options)
    except RuntimeError as error:
        assert '源码' in str(error)
    else:
        raise AssertionError('Changed backend was restored with the same dependency lock')
    assert not rejected.exists()
    copied_change = copied / 'app/source_identity_fixture.py'
    configuration(original)
    try:
        # Direct API/worker entry uses load_config, not just the supervisor.
        copied_change.write_bytes(changed.read_bytes())
        try:
            load_config(original / 'engine', copied)
        except RuntimeError as error:
            assert '源码' in str(error)
        else:
            raise AssertionError('Direct runner bypassed source identity')
    finally:
        copied_change.unlink()
        changed.unlink()
    restored = directory / 'restored'
    restore(backup, restored, **options)
    _, restored_infra, restored_data = configuration(restored)
    owned = OwnedInfrastructure(restored_infra)
    try:
        owned.start_database()
        assert database_state(restored_data) == before
    finally:
        owned.close()
    assert (restored / 'engine/artifacts/source-check.txt').read_bytes() == artifact.read_bytes()
    try:
        ensure_execution_allowed(restored)
    except RuntimeError as error:
        assert '停用' in str(error)
    else:
        raise AssertionError('Restored executor was enabled')
    verify_snapshot(backup)
    result = {'sourceCompatibility': 'passed', 'changedSourceRejectedBeforeWrites': True,
              'directRunnerBypassRejected': True, 'relocatedExactSourceRestored': True,
              'allTablesAndOriginalFilePreserved': True, 'executorsEnabled': False,
              'modelCalls': 0, 'modelExecutionsCreated': 0, 'sourceFiles': saved['sourceIdentity']['files'],
              'runtimeFiles': saved['runtimeIdentity']['files'], 'runtimeIdentityPreserved': True,
              'limitation': 'Exact-source restore only; no cross-version engine migration or model validation'}
    (directory / 'source-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


if __name__=="__main__":
    if sys.argv[1:2]==['--source-only']:
        print(json.dumps(source_check(*map(lambda p:Path(p).resolve(),sys.argv[2:6]))))
    elif sys.argv[1:2] in [['--provider-only'],['--provider-resume']]:
        print(json.dumps(provider_check(*map(lambda p:Path(p).resolve(),sys.argv[2:6]),resume=sys.argv[1]=='--provider-resume',
              provider=sys.argv[6] if len(sys.argv)>6 else 'deepseek')))
    elif sys.argv[1:2]==['--recovery-only']:
        backend,valkey,pg_bin,directory,evidence_root=map(lambda p:Path(p).resolve(),sys.argv[2:7])
        print(json.dumps(recovery_check(directory,backend,valkey,pg_bin,evidence_root)))
    else:
        run_check(*map(lambda p:Path(p).resolve(),sys.argv[1:5]))
