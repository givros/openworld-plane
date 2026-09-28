import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
// The separate world suite validates the authoring exports, not the runtime package.
const files=(await readdir(new URL('../tests/',import.meta.url)))
  .filter(name=>name.endsWith('.test.mjs')&&name!=='world.test.mjs').sort().map(name=>`tests/${name}`);
const child=spawn(process.execPath,['--import','./scripts/register-typescript.mjs','--test',...files],{cwd:root,stdio:'inherit'});
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
