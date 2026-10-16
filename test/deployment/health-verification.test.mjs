import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync}from'node:child_process';
test('发布核验读取旧格式与JSON引号凭据，禁止跨域、重定向和错误版本，错误不回显凭据',()=>{
 const code=String.raw`import base64,importlib.util,io,json,os,tempfile,urllib.request
from pathlib import Path
spec=importlib.util.spec_from_file_location('health','deploy/verify-release.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
sha='a'*40
with tempfile.TemporaryDirectory() as root:
 p=Path(root)/'access'; password='synthetic-"quoted"-\\-only'
 for layout in ['machine example.test\nlogin "synplex"\npassword '+json.dumps(password),'machine example.test login synplex password '+json.dumps(password)]:
  p.write_text(layout);p.chmod(0o600);assert m.credentials(p,'https://example.test',os.getuid())==('synplex',password)
 class Reply(io.BytesIO):
  def getcode(self):return 200
 class Opener:
  def open(self,req,timeout):
   assert req.full_url=='https://example.test/health';assert timeout==20
   assert req.get_header('Authorization')=='Basic '+base64.b64encode(('synplex:'+password).encode()).decode()
   return Reply(json.dumps({'ok':True,'buildSha':sha}).encode())
 assert m.verify(p,'https://example.test',sha,os.getuid(),Opener())['verified']
 for origin in ['http://example.test','https://other.test','https://example.test/','https://evil@example.test','https://example.test?x=y']:
  try:m.credentials(p,origin,os.getuid())
  except ValueError:pass
  else:raise AssertionError('origin accepted')
 p.chmod(0o644)
 try:m.credentials(p,'https://example.test',os.getuid())
 except ValueError:pass
 else:raise AssertionError('readable credentials accepted')
 p.chmod(0o600);link=Path(root)/'symlink';link.symlink_to(p)
 try:m.credentials(link,'https://example.test',os.getuid())
 except ValueError:pass
 else:raise AssertionError('symlink accepted')
 class Wrong(Opener):
  def open(self,req,timeout):return Reply(json.dumps({'ok':True,'buildSha':'b'*40}).encode())
 try:m.verify(p,'https://example.test',sha,os.getuid(),Wrong())
 except ValueError:pass
 else:raise AssertionError('wrong version accepted')
 try:m.NoRedirect().redirect_request(None,None,302,'',{},'https://other.test')
 except ValueError:pass
 else:raise AssertionError('redirect accepted')
print('Private health compatibility and exact SHA checks passed; networkCalls=0')`;
 const run=spawnSync(process.env.SYNPLEX_TEST_PYTHON||'python3',['-B','-c',code],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/networkCalls=0/);
 const fail=spawnSync(process.env.SYNPLEX_TEST_PYTHON||'python3',['-B','deploy/verify-release.py','missing','https://example.test','a'.repeat(40)],{encoding:'utf8'});assert.equal(fail.status,1);assert.equal(fail.stdout,'');assert.match(fail.stderr,/credentials were not displayed/);assert.ok(!fail.stderr.includes('missing'));
});
