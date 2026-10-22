import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';

const child = spawn('sleep', ['60'], {stdio: 'ignore'});
writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
