import test from 'node:test';
import assert from 'node:assert/strict';
import {readNoteBytes} from '../../public/note-reader.js';

test('cloud placeholder timeout aborts its read; a late result cannot replace the next note',async()=>{
 let aborts=0,late;
 const stalled={readAsArrayBuffer(){late=this.onload;},abort(){aborts++;}};
 await assert.rejects(readNoteBytes({}, {timeoutMs:5,reader:stalled}),{code:'note_read_unavailable'});
 assert.equal(aborts,1);assert.equal(stalled.onload,null);late();
 const bytes=new Uint8Array([1,2,3]).buffer;
 const ready={result:bytes,readAsArrayBuffer(){this.onload();},abort(){throw Error('Must not abort completed read');}};
 assert.equal(await readNoteBytes({}, {timeoutMs:5,reader:ready}),bytes);
 const broken={readAsArrayBuffer(){this.onerror();},abort(){}};
 await assert.rejects(readNoteBytes({}, {timeoutMs:5,reader:broken}),{code:'note_read_unavailable'});
});
