import { execFileSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const target = process.argv[2] || 'win32-x64';
const koffiMap = {
  'win32-x64': 'win32_x64',
  'win32-arm64': 'win32_arm64',
  'linux-x64': 'linux_x64',
  'linux-arm64': 'linux_arm64',
  'darwin-x64': 'darwin_x64',
  'darwin-arm64': 'darwin_arm64',
};

const koffiSubdir = koffiMap[target];
if (!koffiSubdir) {
  console.error('Unsupported target platform:', target);
  process.exit(1);
}

// Exclude all other koffi prebuilt platform folders so the VSIX only ships the target platform's koffi.node
const koffiBuildRoot = join(ROOT, 'node_modules', 'koffi', 'build', 'koffi');
const otherKoffiDirs = readdirSync(koffiBuildRoot).filter((d) => {
  if (d === koffiSubdir) return false;
  if (target === 'linux-x64' && d === 'musl_x64') return false;
  if (target === 'linux-arm64' && d === 'musl_arm64') return false;
  return true;
});

const vscodeignore = [
  readFileSync(join(ROOT, '.vscodeignore'), 'utf8').trimEnd(),
  ...otherKoffiDirs.map((d) => `node_modules/koffi/build/koffi/${d}/**`),
  '',
].join('\n');

execFileSync(process.execPath, ['scripts/generate-icon.mjs'], { stdio: 'inherit' });

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const outputDir = join(ROOT, 'artifacts');
mkdirSync(outputDir, { recursive: true });
const outputPath = join(outputDir, `${manifest.name}-${target}-${manifest.version}.vsix`);
// Platform exclusions are temporary so packaging does not modify tracked files.
const ignoreDir = mkdtempSync(join(tmpdir(), 'motorprobe-package-'));
const ignorePath = join(ignoreDir, '.vscodeignore');
const vsceCli = join('node_modules', '@vscode', 'vsce', 'vsce');
try {
  writeFileSync(ignorePath, vscodeignore, 'utf8');
  execFileSync(process.execPath, [vsceCli, 'package', '--target', target, '--ignoreFile', ignorePath, '--out', outputPath, '--githubBranch', 'main'], {
    stdio: 'inherit',
  });
  if (target === 'win32-x64') {
    copyFileSync(outputPath, join(ROOT, `${manifest.name}-${target}-${manifest.version}.vsix`));
  }
} finally {
  try { unlinkSync(ignorePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  rmdirSync(ignoreDir);
}
