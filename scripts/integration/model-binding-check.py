"""Free engine selection scenario: HTTP -> atomic outbox -> real gateway clients.

No invoke/stream call is made. Only private temporary SQLite or a newly created
PostgreSQL cluster is written; frozen definitions are imported with Python -B.
"""
import asyncio
import base64
import csv
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "integrations/agenthub"))
sys.path.insert(0, sys.argv[1])
from model_binding import install_api, install_runtime
from task_files import initialize as initialize_files, inventory
from submission_delivery import initialize as initialize_submissions, submission_hash, PROTOCOL as SUBMISSION_PROTOCOL
from task_tools import install as install_tools
from app.models import Execution, Workflow, ModelConfig, OutboxEvent, User, ToolCall, Organization
from app.models.artifact import Artifact
from app.models.enums import WorkflowStatus
from app.api.deps import get_current_user
from app.database import get_db
from app.core import model_gateway
from app.engine import runner
import app.database as database

fixture_engine = None

async def main():
    global fixture_engine
    with tempfile.TemporaryDirectory(prefix="synplex-model-") as directory:
        engine = create_async_engine(database_url if database_url else "sqlite+aiosqlite:///" + directory + "/fixture.sqlite")
        fixture_engine = engine
        async with engine.begin() as connection:
            if database_url:
                from app.models.base import Base
                required = {model.__table__ for model in [Organization, Workflow, ModelConfig, Execution, OutboxEvent, User, ToolCall, Artifact]}
                while True:
                    expanded = required | {key.column.table for table in required for key in table.foreign_keys}
                    if expanded == required:
                        break
                    required = expanded
                await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=list(required)))
            else:
                for model in [Organization, Workflow, ModelConfig, Execution, OutboxEvent, User, ToolCall, Artifact]:
                    await connection.run_sync(model.__table__.create)
        await initialize_files(engine)
        await initialize_submissions(engine)
        fault = {"commit": False}

        class Session(AsyncSession):
            async def commit(self):
                if fault["commit"]:
                    fault["commit"] = False
                    raise RuntimeError("Synthetic crash before commit")
                return await super().commit()

        sessions = async_sessionmaker(engine, class_=Session, expire_on_commit=False)
        org, wid, uid = [uuid.uuid4() for _ in range(3)]
        data = {"organization_id": str(org), "workflow_id": str(wid)}
        async with sessions() as session:
            session.add(Organization(id=org,name='Private fixture',slug=org.hex))
            await session.flush()
            session.add(User(id=uid, organization_id=org, email='fixture@synplex.invalid', password_hash='disabled'))
            session.add(Workflow(id=wid, organization_id=org, name="Fixture", status=WorkflowStatus.ACTIVE, created_by=str(uid)))
            for model in ["deepseek-flash", "deepseek-v4-pro"]:
                session.add(ModelConfig(organization_id=org, name=model, provider="deepseek", model=model,
                    api_key="synplex-runtime-keychain", base_url="https://api.deepseek.com/v1",
                    max_tokens=100, config={"reasoning_effort": "low"}))
            await session.commit()
        app = FastAPI()
        from app.api.routes.artifacts import router as artifact_router
        app.include_router(artifact_router, prefix='/api')
        install_api(app, data)
        user = SimpleNamespace(id=uid, organization_id=org)

        async def db():
            async with sessions() as session:
                yield session

        app.dependency_overrides[get_db] = db
        app.dependency_overrides[get_current_user] = lambda: user
        app.openapi()  # Also verifies dependency/annotation resolution.
        selections = []
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://fixture") as client:
            options = (await client.get("/api/synplex/model-options")).json()
            assert options["protocol"] == "synplex.engine-selection/1"
            assert options["submissionLookup"] == SUBMISSION_PROTOCOL
            assert len(options["choices"]) == 2
            payload = {"workflow_id": str(wid), "user_input": "Make the fixture file",
                       "model_selection": {"provider": "deepseek", "model": "deepseek-flash", "reasoning_effort": "high"}}
            for patch in [{"model_selection": {**payload["model_selection"], "model": "not-enabled"}},
                          {"model_selection": {**payload["model_selection"], "reasoning_effort": "ultra"}},
                          {"model_selection": {**payload["model_selection"], "base_url": "https://evil.invalid"}}]:
                assert (await client.post("/api/synplex/executions", json={**payload, **patch})).status_code == 422
            fault["commit"] = True
            assert (await client.post("/api/synplex/executions", json=payload)).status_code == 500
            async with sessions() as session:
                assert not (await session.execute(select(Execution))).scalars().all()
                assert not (await session.execute(select(OutboxEvent))).scalars().all()
            raw = '分类,收入\n房费,0.1\n房费,0.2\n=不执行公式,1.25\n'.encode()
            original = {"sourceId":"original-source", "occurrenceId":"original-event", "name":"资料.txt",
                        "sha256":hashlib.sha256(raw).hexdigest(), "byteLength":len(raw), "mediaType":"text/plain",
                        "contentBase64":base64.b64encode(raw).decode()}
            # Reuse the existing four format fixtures, now through actual
            # engine admission and ToolExecutor, not another parser-only suite.
            generated=subprocess.run([shutil.which('node'),'--input-type=module','-e',
                "import {documentFixtures} from './scripts/testing/document-fixtures.mjs';import {DOCUMENT_FORMATS} from './public/document-formats.js';console.log(JSON.stringify(Object.entries(documentFixtures()).filter(([k])=>['pdf','docx','xlsx','pptx'].includes(k)).map(([extension,bytes])=>({extension,mediaType:DOCUMENT_FORMATS[extension],contentBase64:bytes.toString('base64')}))));"],
                cwd=root,capture_output=True,timeout=10,check=True)
            documents=[]
            for i,doc in enumerate(json.loads(generated.stdout)):
                content=base64.b64decode(doc['contentBase64'])
                documents.append({'sourceId':'document-'+str(i),'occurrenceId':'document-event-'+str(i),'name':'原资料.'+doc['extension'],
                                  'sha256':hashlib.sha256(content).hexdigest(),'byteLength':len(content),
                                  'mediaType':doc['mediaType'],'contentBase64':doc['contentBase64']})
            broken=b'broken Office file'
            broken_document={'sourceId':'broken-document','occurrenceId':'broken-event','name':'损坏资料.docx',
                             'sha256':hashlib.sha256(broken).hexdigest(),'byteLength':len(broken),
                             'mediaType':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','contentBase64':base64.b64encode(broken).decode()}
            sheet_bytes=subprocess.run([shutil.which('node'),'--input-type=module','-e',
                "import {literalSpreadsheetFixture} from './scripts/testing/document-fixtures.mjs';process.stdout.write(literalSpreadsheetFixture());"],
                cwd=root,capture_output=True,timeout=10,check=True).stdout
            spreadsheet={'sourceId':'income-spreadsheet','occurrenceId':'income-sheet-event','name':'收入明细.xlsx',
                         'sha256':hashlib.sha256(sheet_bytes).hexdigest(),'byteLength':len(sheet_bytes),
                         'mediaType':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                         'contentBase64':base64.b64encode(sheet_bytes).decode()}
            for invalid in [{**original,"sha256":"0"*64}, {**original,"name":"../other.csv"},
                            {**original,"byteLength":len(raw)+1}, {**original,"contentBase64":"not-base64"}]:
                assert (await client.post('/api/synplex/executions',json={**payload,'input_files':[invalid]})).status_code == 422
            assert (await client.post('/api/synplex/executions',json={**payload,'input_files':[original,original]})).status_code == 422
            capability = (await client.get('/api/synplex/input-capabilities')).json()
            assert capability['protocol'] == 'synplex.engine-input-files/1'
            assert capability['maxBytes'] == 8*1024*1024
            assert capability['documentText'] is True
            assert capability['literalSpreadsheet'] is True
            async def oversized():
                for _ in range(17):
                    yield b' ' * (1024*1024)
            assert (await client.post('/api/synplex/executions', content=oversized())).status_code == 413
            sentinel = Path(directory) / 'code-must-not-execute'
            code_cases = [
                ('python', 'sample.py', ("from pathlib import Path\nPath(" + repr(str(sentinel)) + ").write_text('must not run')\n").encode(), True),
                ('javascript', 'sample.cjs', ("require('node:fs').writeFileSync(" + json.dumps(str(sentinel)) + ", 'must not run');\n").encode(), True),
                ('javascript_module', 'sample.mjs', ("import fs from 'node:fs'; fs.writeFileSync(" + json.dumps(str(sentinel)) + ", 'must not run'); export const value = 1;\n").encode(), True),
                ('python', 'broken.py', b'def broken(\n', False),
                ('javascript_module', 'broken.mjs', b'export const = ;\n', False),
            ]
            code_files = []
            for number, (language, name, content, valid) in enumerate(code_cases):
                code_files.append({'sourceId':'code-'+str(number),'occurrenceId':'code-event-'+str(number),
                    'name':name,'sha256':hashlib.sha256(content).hexdigest(),'byteLength':len(content),
                    'mediaType':'text/plain','contentBase64':base64.b64encode(content).decode()})
            for index, (model, effort) in enumerate([("deepseek-flash", "high"), ("deepseek-v4-pro", "max")]):
                payload.pop('submission', None)
                payload["model_selection"] = {"provider": "deepseek", "model": model, "reasoning_effort": effort}
                payload['input_files'] = [original,*documents,broken_document,spreadsheet,*code_files] if index == 0 else []
                if index == 0:
                    identity = {"operation_id":str(uuid.uuid4()), "attempt_id":str(uuid.uuid4()),
                                "packet_hash":"a"*64, "payload_hash":submission_hash(payload)}
                    payload['submission'] = identity
                    fault['commit'] = True
                    assert (await client.post('/api/synplex/executions',json=payload)).status_code == 500
                    async with sessions() as session:
                        assert (await session.execute(text('SELECT count(*) FROM synplex_task_files'))).scalar_one() == 0
                        assert len((await session.execute(select(Execution))).scalars().all()) == 0
                        assert (await session.execute(text('SELECT count(*) FROM synplex_execution_submissions'))).scalar_one() == 0
                if database_url and index == 0:
                    response, concurrent = await asyncio.gather(client.post('/api/synplex/executions',json=payload),
                                                               client.post('/api/synplex/executions',json=payload))
                    assert response.status_code == concurrent.status_code == 202, (response.text, concurrent.text)
                    assert response.json() == concurrent.json()
                else:
                    response = await client.post("/api/synplex/executions", json=payload)
                assert response.status_code == 202, response.text
                result = response.json()
                assert result["model_selection"] == payload["model_selection"]
                selections.append((uuid.UUID(result["execution_id"]), dict(payload["model_selection"])))
                if index == 0:
                    assert (await client.post('/api/synplex/executions',json=payload)).json() == result
                    route = '/api/synplex/submissions/' + identity['operation_id']
                    query = {key:value for key,value in identity.items() if key != 'operation_id'}
                    proof = await client.get(route, params=query)
                    assert proof.status_code == 200, proof.text
                    assert proof.json() == {'protocol':SUBMISSION_PROTOCOL, **identity, 'execution_id':result['execution_id']}
                    assert (await client.get(route, params={**query,'attempt_id':str(uuid.uuid4())})).status_code == 404
                    user.id = uuid.uuid4()
                    assert (await client.get(route, params=query)).status_code == 404
                    user.id = uid
                    altered = {**payload, 'user_input':'不同的任务，不可冒充原请求'}
                    assert (await client.post('/api/synplex/executions',json=altered)).status_code == 409
                    raw_request = {key:value for key,value in altered.items() if key != 'submission'}
                    altered['submission'] = {**identity,'payload_hash':submission_hash(raw_request)}
                    assert (await client.post('/api/synplex/executions',json=altered)).status_code == 409
                    async with sessions() as session:
                        assert len((await session.execute(select(Execution))).scalars().all()) == 1
                        assert len((await session.execute(select(OutboxEvent))).scalars().all()) == 1
                        assert (await session.execute(text('SELECT count(*) FROM synplex_execution_submissions'))).scalar_one() == 1
            user.organization_id = uuid.uuid4()
            assert (await client.get("/api/synplex/model-options")).status_code == 404
            user.organization_id = org

        async def models(_organization):
            async with sessions() as session:
                return (await session.execute(select(ModelConfig))).scalars().all()

        observations = []
        async def deterministic(execution_id, *args, **kwargs):
            selection = dict(model_gateway.get_active_selection())
            await asyncio.sleep(0)
            # Direct intent/planner call and compatibility graph call both bind.
            for clients in [await model_gateway.ModelGateway().select(organization_id=str(org), selection={"provider":"deepseek", "model":"deepseek-flash", "reasoning_effort":"low"}),
                            await model_gateway.get_chat_models(str(org))]:
                assert len(clients) == 1
                assert clients[0].model_name == selection["model"]
                assert clients[0].reasoning_effort == selection["reasoning_effort"]
            observations.append((str(execution_id), selection))
            if kwargs.get("fail"):
                raise RuntimeError("Synthetic failure")

        model_gateway.list_active_models = models
        database.async_session_factory = sessions
        runner.run_execution, runner.resume_execution = deterministic, deterministic
        install_runtime(data)
        for execution_id, _ in selections:
            await runner.run_execution(execution_id, leased=True)
        # Rebind persisted choice when a fresh worker resumes the original graph.
        await runner.resume_execution(selections[1][0], {"answer": "Continue"})
        try:
            await runner.run_execution(selections[0][0], fail=True)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Synthetic failure did not propagate")
        assert model_gateway.get_active_selection() is None
        assert observations[2][1] == selections[1][1]
        # Follow this same input through real ToolExecutor, persisted artifact,
        # authenticated download and reopen; no second suite or model request.
        from app.engine import tool_executor
        from app.engine import delivery_tools
        from app.artifacts import service as artifacts
        from app.config import settings
        async def no_external_event(*args, **kwargs):
            pass
        tool_executor.async_session_factory = sessions
        delivery_tools.async_session_factory = sessions
        tool_executor.publish_execution_event = no_external_event
        tool_executor.record_span = no_external_event
        artifacts.async_session_factory = sessions
        settings.ARTIFACT_ROOT = str(Path(directory) / 'artifacts')
        install_tools()
        from app.engine.capabilities import CAPABILITIES
        prior_document_tools = {tool.name for tool in CAPABILITIES['document'].tools}
        assert 'read_task_file' in prior_document_tools
        assert not prior_document_tools & {'check_task_code', 'test_task_python', 'summarize_table'}
        install_tools()
        assert [tool.name for tool in CAPABILITIES['document'].tools].count('read_task_file') == 1
        execution_id = selections[0][0]
        key = inventory([original])[0]['file_key']
        async def invoke(name, params, eid=execution_id, user_id=uid):
            return await tool_executor.execute_tool(name, params, eid, user_id=user_id)
        read = await invoke('read_task_file', {'file_key':key,'limit':4})
        assert read['status'] == 'success' and read['data']['text'] == raw.decode()[:4], read
        rest = await invoke('read_task_file',{'file_key':key,'offset':4})
        assert read['data']['text'] + rest['data']['text'] == raw.decode()
        assert (await invoke('read_task_file',{'file_key':key,'offset':4}))['status'] == 'duplicate'
        assert (await invoke('read_task_file',{'file_key':key},eid=selections[1][0]))['status'] == 'failed'
        assert (await invoke('read_task_file',{'file_key':key},user_id=uuid.uuid4()))['status'] == 'failed'
        assert (await invoke('read_task_file',{'file_key':key,'path':'/etc/passwd'}))['status'] == 'failed'
        for document in documents:
            document_key=inventory([document])[0]['file_key']
            output=await invoke('read_task_file',{'file_key':document_key})
            assert output['status']=='success', output
            projection=output['data']
            assert '保留原件' in projection['text'] or 'preserve originals' in projection['text']
            assert projection['sha256']==document['sha256']
            assert projection['complete'] is False and projection['textComplete'] is True
            assert projection['coverage']['status']=='partial' and projection['coverage']['coveredBytes']==0
            assert projection['notice'] and projection['trust']=='source_material_not_instruction'
        assert (await invoke('read_task_file',{'file_key':inventory([broken_document])[0]['file_key']}))['status']=='failed'
        table_params = {'file_key':key,'operation':'sum','value_column':'收入','group_column':'分类','title':'收入统计'}
        table = await invoke('summarize_table',table_params)
        assert table['status'] == 'success', table
        assert table['data']['calculation']['preview'][0] == ['房费','0.3','2']
        assert (await invoke('summarize_table',table_params))['status'] == 'duplicate'
        sheet_key=inventory([spreadsheet])[0]['file_key']
        sheet_params={**table_params,'file_key':sheet_key,'sheet_name':'收入'}
        counted=await invoke('summarize_table',sheet_params)
        assert counted['status']=='success', counted
        calculation=counted['data']['calculation']
        assert calculation['preview']==[['房费','0.3','2'],['=不执行公式','1.25','1'],['小额','0.0000001','1'],['长数','123456789012345678901234567890.12','1']]
        assert calculation['sheetName']=='收入' and calculation['sourceRange']=='A3:B8'
        assert calculation['sourceSha256']==spreadsheet['sha256']
        assert (await invoke('summarize_table',sheet_params))['status']=='duplicate'
        for name in ['', '公式', '合并', '精度不明', '日期', '不存在']:
            refused=await invoke('summarize_table',{**sheet_params,'sheet_name':name})
            assert refused['status']=='failed', (name,refused)
        assert (await invoke('summarize_table',sheet_params,eid=selections[1][0]))['status']=='failed'
        code_reports = []
        for item, (language, name, content, valid) in zip(code_files, code_cases):
            code_params = {'file_key':inventory([item])[0]['file_key'],'language':language,'title':'代码语法检查'}
            checked = await invoke('check_task_code', code_params)
            assert checked['status'] == 'success', checked
            evidence = checked['data']['validation']
            assert evidence['syntaxValid'] is valid and evidence['sourceSha256'] == item['sha256']
            assert evidence['codeExecuted'] is False and evidence['functionalTests'] == 'not_run'
            assert evidence['dependencyChecks'] == 'not_run' and not sentinel.exists()
            assert (await invoke('check_task_code',code_params))['status'] == 'duplicate'
            assert (await invoke('check_task_code',{**code_params,'path':'/etc/passwd'}))['status'] == 'failed'
            assert (await invoke('check_task_code',code_params,eid=selections[1][0]))['status'] == 'failed'
            code_reports.append(checked['data'])
        from code_check import check_syntax
        for name, content, language in [('large.py', b'x' * (128 * 1024 + 1), 'python'),
                ('nul.py', b'x=1\x00', 'python'), ('encoded.py', b'\xff', 'python'),
                ('wrong.pdf', b'x=1', 'python')]:
            try:
                check_syntax({'name':name}, content, language)
            except ValueError:
                pass
            else:
                raise AssertionError('Invalid code material was accepted')
        assert not sentinel.exists(), 'A syntax check must never execute uploaded code'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as client:
            for document in code_reports:
                downloaded_code = await client.get('/api/artifacts/'+document['id']+'/download')
                assert downloaded_code.status_code == 200
                assert hashlib.sha256(downloaded_code.content).hexdigest() == document['sha256']
                assert '没有运行代码' in downloaded_code.text and '语法通过不代表程序运行正确' in downloaded_code.text
                assert document['validation']['sourceSha256'] in downloaded_code.text
                assert str(sentinel) not in downloaded_code.text
            downloaded = await client.get('/api/artifacts/'+table['data']['id']+'/download')
            assert downloaded.status_code == 200, downloaded.text
            assert downloaded.headers['content-type'].startswith('text/csv')
            assert '房费,0.3,2' in downloaded.text and "'=不执行公式" in downloaded.text
            assert hashlib.sha256(downloaded.content).hexdigest() == table['data']['sha256']
            sheet_download=await client.get('/api/artifacts/'+counted['data']['id']+'/download')
            assert sheet_download.status_code==200 and hashlib.sha256(sheet_download.content).hexdigest()==counted['data']['sha256']
            assert '小额,0.0000001,1' in sheet_download.text and '123456789012345678901234567890.12' in sheet_download.text
            user.organization_id = uuid.uuid4()
            assert (await client.get('/api/artifacts/'+table['data']['id']+'/download')).status_code == 404
            user.organization_id = org
        from task_tools import calculate, TableParams
        for operation, expected in [('average','0.15'),('min','0.1'),('max','0.2'),('count','2')]:
            _, calculated = calculate(original,raw,TableParams(file_key=key,operation=operation,value_column='收入',group_column='分类'))
            assert calculated['preview'][0] == ['房费',expected,'2']
        for invalid in ['收入\n\n','收入\n=1+2\n','收入\nNaN\n','收入,收入\n1,2\n','收入\n1,2\n']:
            try:
                calculate({'name':'invalid.csv','sha256':'fixture'},invalid.encode(),TableParams(file_key=key,operation='sum',value_column='收入'))
            except (ValueError,csv.Error):
                pass
            else:
                raise AssertionError('Dirty table must fail, not export a partial result')
        async with sessions() as session:
            row = await session.get(Execution, execution_id)
            row.checkpoint_data = {'interrupt':{'type':'clarification'}}
            await session.commit()
        await engine.dispose()
        reopened = await invoke('read_task_file',{'file_key':key,'limit':10000})
        assert reopened['status'] == 'success' and reopened['data']['text'] == raw.decode()
        async with sessions() as session:
            assert len((await session.execute(select(OutboxEvent))).scalars().all()) == 2
            assert len((await session.execute(select(Artifact))).scalars().all()) == 2 + len(code_cases)
            assert all(model.config == {"reasoning_effort": "low"} for model in (await session.execute(select(ModelConfig))).scalars())
        await engine.dispose()
        print(json.dumps({"checks": ["atomic choice/files/outbox/submission rollback", "original submission GET binds owner/attempt/packet/payload/task", "duplicate submit returns one execution and outbox", "invalid choice/file fingerprint rejection", "foreign organization denied", "intent/planner selected client", "persisted continuation choice", "failure resets context", "ToolExecutor identity/idempotency", "uploaded Python/CommonJS/ES-module syntax only with no side effects", "invalid syntax and oversized/binary code refusal", "scoped idempotent syntax report and authenticated hash-matched download", "four binary document formats through isolated parser with partial-coverage truth", "broken document fails without pretending complete", "literal XLSX named-sheet Decimal calculation with exact long text numbers and small numeric cells", "formula cached values/merged/ambiguous sheet/date/precision rejection", "Decimal calculation", "authenticated CSV download and formula protection", "dirty tables rejected", "input survives checkpoint and reopen", "shared defaults unchanged"], "postgresConcurrentSubmission":bool(database_url), "modelCalls": 0}))


database_url = None
owned = None
async def checked_main():
    original_async_send, original_sync_send = httpx.AsyncClient.send, httpx.Client.send
    async def asgi_only(client, request, *args, **kwargs):
        if not isinstance(client._transport, httpx.ASGITransport):
            raise AssertionError('Free check forbids external model HTTP')
        return await original_async_send(client, request, *args, **kwargs)
    def forbidden(*args, **kwargs):
        raise AssertionError('Free check forbids external model HTTP')
    httpx.AsyncClient.send, httpx.Client.send = asgi_only, forbidden
    try:
        await main()
    finally:
        # A failed assertion must release the fixture pool before PostgreSQL's
        # smart shutdown; otherwise the owned process waits on our own clients.
        if fixture_engine is not None:
            await fixture_engine.dispose()
        httpx.AsyncClient.send, httpx.Client.send = original_async_send, original_sync_send
try:
    if len(sys.argv) > 2:
        # Explicit new private PostgreSQL evidence directory, never an existing
        # service or a URL discovered from another application's environment.
        import socket
        from private_infrastructure import prepare, OwnedInfrastructure
        from sqlalchemy.engine import URL
        location = Path(sys.argv[2]).absolute()
        if location.exists():
            raise RuntimeError('Use a new evidence directory; inspect prior results before retrying')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0))
            port = sock.getsockname()[1]
        config = prepare(location, Path(sys.argv[3]), port=port)
        owned = OwnedInfrastructure(config)
        owned.start_database()
        database_url = URL.create('postgresql+asyncpg',username=config['username'],password=config['password'],
                                  host='127.0.0.1',port=port,database='postgres')
    asyncio.run(checked_main())
finally:
    if owned:
        owned.close()
