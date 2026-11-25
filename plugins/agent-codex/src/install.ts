import type { CheckContext, PluginInstanceConfig } from '@tsugimori/plugin-sdk';

import { SetupError } from '@tsugimori/plugin-sdk';
import { createHash } from 'node:crypto';
import { constants, createWriteStream, lstatSync, readFileSync } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, join, relative, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';

const releases = 'https://api.github.com/repos/openai/codex/releases';
const repository = 'https://github.com/openai/codex/releases/download/';
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const manifestName = 'codex-package.json';

type Asset = { browser_download_url: string; digest?: string; name: string };
type Release = { assets: Asset[]; tag_name: string };

export function pinnedVersion(entry: PluginInstanceConfig) {
  const version = 'version' in entry ? entry.version : undefined;
  return typeof version === 'string' && versionPattern.test(version)
    ? version
    : undefined;
}

export function codexBinary(
  workspace: string,
  version: string,
  platform = process.platform,
) {
  const directory = packageDirectory(workspace, version);
  try {
    return packageEntrypoint(directory, version);
  } catch {
    return join(directory, 'bin', platform === 'win32' ? 'codex.exe' : 'codex');
  }
}

export async function hasCodexCodeModeHost(
  binary: string,
  platform: NodeJS.Platform,
) {
  const name =
    platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host';
  try {
    return (await stat(join(dirname(binary), name))).isFile();
  } catch {
    return false;
  }
}

export async function installCodex(
  ctx: CheckContext,
  { signal, upgrade }: { signal?: AbortSignal; upgrade: boolean },
) {
  const pinned = upgrade ? undefined : pinnedVersion(ctx.entry);
  if (pinned && (await installedPackageWorks(ctx, pinned))) return pinned;
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[ctx.arch];
  const os =
    ctx.platform === 'darwin'
      ? 'apple-darwin'
      : ctx.platform === 'linux'
        ? 'unknown-linux-musl'
        : ctx.platform === 'win32'
          ? 'pc-windows-msvc'
          : undefined;
  if (!arch || !os)
    throw new SetupError(
      'Managed Codex installation supports Linux, macOS and Windows on x64 and arm64.',
    );
  const target = `${arch}-${os}`;
  const timeout = (ms: number) =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
      : AbortSignal.timeout(ms);
  try {
    const meta = await ctx.fetch(
      pinned ? `${releases}/tags/rust-v${pinned}` : `${releases}/latest`,
      {
        redirect: 'error',
        signal: timeout(20_000),
      },
    );
    if (!meta.ok)
      throw new SetupError('Could not resolve a Codex release from GitHub.');
    const release = (await meta.json()) as Release;
    const version = release.tag_name?.startsWith('rust-v')
      ? release.tag_name.slice(6)
      : '';
    if (!versionPattern.test(version) || (pinned && pinned !== version))
      throw new SetupError(
        'GitHub returned an unexpected Codex release version.',
      );
    const name = `codex-package-${target}.tar.gz`;
    const url = `${repository}rust-v${version}/${name}`;
    const asset = release.assets.find((asset) => asset.name === name);
    if (!asset)
      throw new SetupError(
        `Codex ${version} has no managed package archive for ${target}.`,
      );
    if (asset.browser_download_url !== url)
      throw new SetupError('Unexpected Codex package archive URL.');
    if (await installedPackageWorks(ctx, version)) return version;

    const directory = packageDirectory(ctx.workspace, version);
    const parent = dirname(directory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    // Publish with a single directory rename on the same filesystem.
    const staging = await mkdtemp(join(parent, `.${version}.install-`));
    try {
      const digest = await publishedDigest(
        ctx,
        release,
        version,
        asset,
        timeout(20_000),
      );
      const response = await ctx.fetch(url, {
        signal: timeout(300_000),
      });
      if (!response.ok || !response.body)
        throw new SetupError('Could not download the Codex release tarball.');
      const hash = createHash('sha256');
      const archive = join(staging, name);
      await pipeline(
        response.body,
        async function* (chunks) {
          for await (const chunk of chunks) {
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
      );
      if (digest && digest !== hash.digest('hex'))
        throw new SetupError('The Codex release checksum did not match.');

      const options = { timeoutMs: 60_000, signal };
      let unsafeMember = false;
      let sawListingLine = false;
      const inspectMember = (line: string) => {
        sawListingLine = true;
        if (line && !isPackagePath(line)) unsafeMember = true;
      };
      const listing = await ctx.runCommand(['tar', '-tzf', archive], {
        ...options,
        // The command runner only retains a tail of stdout.
        onLine: inspectMember,
      });
      if (!sawListingLine) listing.stdout.split(/\r?\n/).forEach(inspectMember);
      if (unsafeMember)
        throw new SetupError(
          'The Codex package archive contains an unsafe member path.',
        );
      if (listing.exitCode !== 0)
        throw new SetupError('Could not list the Codex package archive.');

      const unpacked = join(staging, 'package');
      await mkdir(unpacked, { mode: 0o700 });
      const extraction = await ctx.runCommand(
        ['tar', '-xzf', archive, '-C', unpacked],
        options,
      );
      if (extraction.exitCode !== 0)
        throw new SetupError('Could not extract the Codex package archive.');
      const binary = packageEntrypoint(unpacked, version);
      if (
        !lstatSync(binary, { throwIfNoEntry: false })?.isFile() ||
        !isPackagePath(
          relative(await realpath(unpacked), await realpath(binary)),
        )
      )
        throw new SetupError(
          'The Codex package did not contain the declared executable.',
        );
      await chmod(binary, 0o700);
      signal?.throwIfAborted();
      await publishPackage(ctx, version, unpacked, directory);
    } finally {
      await rm(staging, { force: true, recursive: true });
    }
    return version;
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError(
      'Could not install the Codex release. Check GitHub connectivity, tar, and workspace permissions.',
      { cause: error },
    );
  }
}

function packageDirectory(workspace: string, version: string) {
  return join(workspace, 'runtime', 'codex', version);
}

function isPackagePath(path: string) {
  return (
    !!path &&
    !win32.isAbsolute(path) &&
    !/^[A-Za-z]:/.test(path) &&
    !path.split(/[/\\]/).includes('..')
  );
}

function packageEntrypoint(directory: string, version: string) {
  const path = join(directory, manifestName);
  let manifest: {
    entrypoint?: unknown;
    layoutVersion?: unknown;
    version?: unknown;
  } | null;
  try {
    if (!lstatSync(path).isFile()) throw new Error('Expected a regular file.');
    manifest = JSON.parse(readFileSync(path, 'utf8')) as typeof manifest;
  } catch (error) {
    throw new SetupError('Could not read the Codex package manifest.', {
      cause: error,
    });
  }
  const entrypoint = manifest?.entrypoint;
  if (
    manifest?.layoutVersion !== 1 ||
    manifest.version !== version ||
    typeof entrypoint !== 'string' ||
    !isPackagePath(entrypoint) ||
    entrypoint.includes('\0')
  )
    throw new SetupError(
      'The Codex package manifest has an invalid layout, version, or entrypoint.',
    );
  return join(directory, entrypoint);
}

async function installedPackageWorks(ctx: CheckContext, version: string) {
  try {
    const binary = packageEntrypoint(
      packageDirectory(ctx.workspace, version),
      version,
    );
    await access(binary, constants.X_OK);
    return await hasCodexCodeModeHost(binary, ctx.platform);
  } catch {
    return false;
  }
}

async function publishPackage(
  ctx: CheckContext,
  version: string,
  unpacked: string,
  directory: string,
) {
  try {
    await rename(unpacked, directory);
    return;
  } catch (error) {
    if (!lstatSync(directory, { throwIfNoEntry: false })) throw error;
    if (await installedPackageWorks(ctx, version)) return;
  }

  // Move an old single-binary or incomplete install aside only after validation.
  const previous = join(dirname(unpacked), 'previous');
  await rename(directory, previous);
  try {
    await rename(unpacked, directory);
  } catch (error) {
    if (await installedPackageWorks(ctx, version)) return;
    await rename(previous, directory);
    throw error;
  }
}

async function publishedDigest(
  ctx: CheckContext,
  release: Release,
  version: string,
  asset: Asset,
  signal: AbortSignal,
) {
  if (asset.digest) {
    const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1];
    if (!digest)
      throw new SetupError(
        'The Codex release published an invalid SHA-256 digest.',
      );
    return digest.toLowerCase();
  }
  for (const checksum of release.assets) {
    if (
      !['SHA256SUMS', 'checksums.txt', asset.name + '.sha256'].includes(
        checksum.name,
      )
    )
      continue;
    const url = `${repository}rust-v${version}/${checksum.name}`;
    if (checksum.browser_download_url !== url)
      throw new SetupError('Unexpected Codex checksum URL.');
    const result = await ctx.fetch(url, {
      signal,
    });
    if (!result.ok)
      throw new SetupError('Could not download the published Codex checksums.');
    for (const line of (await result.text()).split('\n')) {
      const [digest, file] = line.trim().split(/\s+\*?/);
      if (
        file !== asset.name &&
        !(checksum.name === asset.name + '.sha256' && !file)
      )
        continue;
      if (!digest || !/^[0-9a-f]{64}$/i.test(digest))
        throw new SetupError('Invalid published Codex checksum.');
      return digest.toLowerCase();
    }
    if (checksum.name === asset.name + '.sha256')
      throw new SetupError('The published Codex checksum file is invalid.');
  }
}
