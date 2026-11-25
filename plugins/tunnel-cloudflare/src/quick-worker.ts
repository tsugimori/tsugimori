import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Expected cloudflared command');

const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 500).unref();
}

// The gateway owns the pipe. EOF also stops the tunnel after an ungraceful exit.
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.resume();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('error', () => process.exit(1));
child.on('close', (code) => process.exit(code ?? 1));
