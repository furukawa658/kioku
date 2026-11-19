import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildWorkerLauncher(zig = process.env.KIOKU_ZIG_EXE || 'zig') {
  const extension = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const source = path.join(extension, 'native', 'worker-launcher.zig');
  const runtime = path.join(extension, 'runtime');
  const output = path.join(runtime, process.platform === 'win32' ? 'kioku-worker-launcher.exe' : 'kioku-worker-launcher');
  const args = ['build-exe', source, '-OReleaseSmall', '-fstrip', `-femit-bin=${output}`];
  if (process.platform === 'darwin') args.push('-lc');
  execFileSync(zig, args, { cwd: extension, stdio: 'inherit' });
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'runtime'), { recursive: true });
  buildWorkerLauncher();
}
