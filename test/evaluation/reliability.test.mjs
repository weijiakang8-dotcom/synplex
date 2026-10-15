import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('reliability arithmetic matches fixed reviewed source; missing evidence never becomes a zero or a passing score',t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-reliability-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const result=spawnSync('/usr/bin/python3',['-I','-B',resolve('test/evaluation/reliability-check.py'),process.cwd(),dir],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/modelCalls=0/);
});
