// Local read-only snapshot/workflow/source-contract check. No PowerShell or EXE execution.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../../..');
const here=import.meta.dirname;
const manifestBytes=fs.readFileSync(path.join(here,'source-manifest.json'));
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifest=JSON.parse(manifestBytes);
const checks=[];
const check=(name,ok)=>{checks.push({name,ok:!!ok});if(!ok)throw new Error(name);};
check('manifest-hash',digest(manifestBytes)==='28b7766841e3c8ddae60008432508a2780aee0e4b22042de9bf062e5b80ef813');
check('local-source-head',manifest.sourceHead==='4ab846c70883170f94b6af05b99cb049e2cff0f4');
check('snapshot-inventory-count',manifest.files.length===13&&manifest.files.reduce((n,r)=>n+r.bytes,0)===51764);
for(const row of manifest.files){const bytes=fs.readFileSync(path.join(here,'snapshot',row.path));check(`snapshot:${row.path}`,bytes.length===row.bytes&&digest(bytes)===row.sha256);}
const driver=fs.readFileSync(path.join(here,'hosted-build.ps1'),'utf8');
check('no-target-invocation',!/^\s*&.*(?:capture\.exe|fault-fixture\.exe)/m.test(driver));
check('no-product-install-run',!/(?:npm (?:ci|run)|npx |Start-Process|Invoke-WebRequest|Invoke-RestMethod|winget |choco )/.test(driver));
check('known-toolchain-only',driver.includes('^14\\.44\\.[0-9]+$')&&driver.includes('10.0.26100.0'));
check('bin-dll-manifest',driver.includes('vcBin=$bin'));
check('independent-pe-inspection',driver.includes("throw 'pe_not_amd64'")&&driver.includes("throw 'unexpected_pe_import'"));
check('entry-exit-clean',driver.includes('sourceValidAtEntry=$true')&&driver.includes('sourceValidAtEnd=$true')&&driver.includes('tracked_source_dirty'));
check('bounded-failure-output',driver.includes("else{'build_observer_error'}"));
const workflowPath=path.join(root,'.github/workflows/upstream-check.yml');
if(fs.readFileSync(workflowPath,'utf8').trimStart().startsWith('{')){
 const workflow=JSON.parse(fs.readFileSync(workflowPath));
 check('manual-only',Object.keys(workflow.on).join()==='workflow_dispatch');
 check('contents-read-only',JSON.stringify(workflow.permissions)==='{"contents":"read"}');
 check('no-cancel',workflow.concurrency['cancel-in-progress']===false);
 const job=workflow.jobs['build-only'];check('hosted-only',job['runs-on']==='windows-2025');
 check('finite-timeout',job['timeout-minutes']===20);
 for(const step of job.steps.filter(s=>s.uses))check('action-sha',/^[^@]+@[0-9a-f]{40}$/.test(step.uses));
 const checkout=job.steps.find(s=>s.uses?.startsWith('actions/checkout@'));
 check('pinned-source',/^[0-9a-f]{40}$/.test(checkout.with.ref));check('no-persist',checkout.with['persist-credentials']===false);
 const upload=job.steps.find(s=>s.uses?.startsWith('actions/upload-artifact@'));check('seven-day',upload.with['retention-days']===7);
}
console.log(JSON.stringify({kind:'local-read-only-contract',passed:checks.length,checks,windowsExecuted:false,powershellParsed:false},null,2));
