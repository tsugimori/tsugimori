import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const workspace = '/workspace';
const control = '/run/tsugimori-control.sock';

async function readOrWrite(mode: string, path: string) {
  const target = resolve(workspace, path);
  if (
    !target.startsWith(workspace + '/') ||
    (await realpath(dirname(target))) !== dirname(target)
  )
    throw new Error('File must be inside the chat workdir');
  const flags = constants.O_NOFOLLOW | constants.O_NONBLOCK;
  if (mode === 'read') {
    const file = await open(target, flags | constants.O_RDONLY);
    try {
      if (!(await file.stat()).isFile())
        throw new Error('Expected a regular file');
      await pipeline(file.createReadStream(), stdout, { end: false });
    } finally {
      await file.close();
    }
    return;
  }
  const file = await open(
    target,
    flags | constants.O_WRONLY | constants.O_CREAT,
    0o600,
  );
  try {
    if (!(await file.stat()).isFile())
      throw new Error('Expected a regular file');
    await file.truncate();
    await pipeline(stdin, file.createWriteStream());
  } finally {
    await file.close();
  }
}

async function expose(port: number, command: string, args: string[]) {
  const child = spawn(command, args, { stdio: 'ignore' });
  child.on('error', () => process.exit(1));
  child.on('exit', (status) => process.exit(status ?? 1));
  const dest = { host: '127.0.0.1', port };
  for (;;) {
    const ready = await new Promise<boolean>((resolve) => {
      const probe = connect(dest);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (ready) break;
    await delay(50);
  }

  function waitForClient() {
    const upstream = connect(control);
    upstream.on('error', () => upstream.destroy());
    upstream.once('data', (chunk: Buffer) => {
      waitForClient();
      const server = connect(dest);
      server.on('error', () => server.destroy());
      server.on('close', () => upstream.destroy());
      upstream.on('close', () => server.destroy());
      if (chunk.length > 1) server.write(chunk.subarray(1));
      upstream.pipe(server).pipe(upstream);
    });
  }
  for (let n = 0; n < 8; n++) waitForClient();
  stdout.write('ready\n');
}

const [action, value, command, ...args] = process.argv.slice(2);
try {
  if ((action === 'read' || action === 'write') && value)
    await readOrWrite(action, value);
  else if (action === 'serve' && value && command)
    await expose(Number(value), command, args);
  else throw new Error('Invalid sandbox worker arguments');
} catch {
  process.stderr.write('Sandbox operation failed\n');
  process.exitCode = 1;
}
