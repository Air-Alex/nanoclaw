import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Keep the SDK's system trust order and its proxy-only fallback.
const SYSTEM_CA_PATHS = ['/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'];

export function combinedCaBundle(certificate: string): string | undefined {
  for (const file of SYSTEM_CA_PATHS) {
    let system: string;
    try {
      system = fs.readFileSync(file, 'utf8');
    } catch (error) {
      // Unavailable host trust stores are optional, as in the SDK. Do not
      // include staging here: a failed write must abort the contribution.
      if (!(error instanceof Error && 'code' in error)) throw error;
      continue;
    }
    return `${system.trimEnd()}\n${certificate.trimEnd()}\n`;
  }
}

/**
 * Content-addressed files remain stable for existing read-only bind mounts.
 * A new CA/stub publishes a new path; retries reuse it. Never remove old
 * versions here: another session may still have one mounted.
 */
export function stageOnecliFile(dataDir: string, kind: 'ca' | 'combined' | 'stub', content: string): string {
  const directory = path.join(dataDir, 'onecli');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.uid !== process.getuid?.() ||
    (directoryStat.mode & 0o777) !== 0o700
  ) {
    throw new Error('OneCLI file directory must be owned by the current user with mode 0700');
  }
  const digest = createHash('sha256').update(content).digest('hex');
  const destination = path.join(directory, `${kind}-${digest}${kind === 'stub' ? '' : '.pem'}`);
  const mode = kind === 'stub' ? 0o600 : 0o644;
  const validate = () => {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.uid !== directoryStat.uid || (stat.mode & 0o777) !== mode) {
      throw new Error('OneCLI staged file has an unexpected type, owner, or permissions');
    }
    const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.readFileSync(fd, 'utf8') !== content) throw new Error('OneCLI staged file content does not match');
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    validate();
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Publish a complete file without replacing a concurrent writer's file or
  // following a symlink. Cleanup is limited to this invocation's temp file.
  const temporary = path.join(directory, `.pending-${randomUUID()}`);
  const fd = fs.openSync(temporary, 'wx', mode);
  try {
    try {
      fs.writeFileSync(fd, content);
      fs.fchmodSync(fd, mode);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    validate();
    return destination;
  } finally {
    fs.unlinkSync(temporary);
  }
}
