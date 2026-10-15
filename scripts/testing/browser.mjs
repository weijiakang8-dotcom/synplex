import {existsSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

// Private, fresh contexts only. Never attach to the user's Chrome or agent app.
export async function launchTestBrowser(){
 const driver=process.env.SYNPLEX_BROWSER_DRIVER;
 const {chromium}=driver?await import(pathToFileURL(resolve(driver)).href):await import('playwright-core');
 const installed='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const executablePath=process.env.SYNPLEX_BROWSER_EXECUTABLE??(process.env.SYNPLEX_TEST_BUNDLED_BROWSER==='1'?undefined:process.platform==='darwin'&&existsSync(installed)?installed:undefined);
 return chromium.launch({...(executablePath?{executablePath}:{}),headless:true,args:['--disable-background-networking']});
}

export function browserEvidenceDirectory(name,variable){
 const path=resolve(process.env[variable]??'.runtime/browser-checks/'+name+'-'+randomUUID());
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 // Do not overwrite evidence from an interrupted or successful run.
 mkdirSync(path,{mode:0o700});return path;
}
