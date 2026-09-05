import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const skillDir = join(repoRoot, 'understand-anything-plugin', 'skills', 'understand');
const scanScript = join(skillDir, 'scan-project.mjs');
const importScript = join(skillDir, 'extract-import-map.mjs');
const fingerprintScript = join(skillDir, 'build-fingerprints.mjs');
const prepareScript = join(skillDir, 'prepare-incremental.mjs');
const finalizeScript = join(skillDir, 'finalize-incremental.mjs');
const mergeScript = join(skillDir, 'merge-batch-graphs.py');

const python = (() => {
  for (const command of ['python3', 'python']) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf-8' });
    if (probe.status === 0) return command;
  }
  throw new Error('Python 3 is required for incremental merge tests');
})();

const roots = [];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function git(root, args) {
  return run('git', args, root).stdout.trim();
}

function writeProjectFile(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
}

function commit(root, message, { forcePaths = [] } = {}) {
  git(root, ['add', '-A']);
  for (const path of forcePaths) git(root, ['add', '-f', '--', path]);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function setupRepository(files) {
  const root = mkdtempSync(join(tmpdir(), 'ua-incremental-test-'));
  roots.push(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  // Keep fixture bytes literal on Windows so the LF -> CRLF regression
  // actually creates a commit instead of being normalized back to LF.
  git(root, ['config', 'core.autocrlf', 'false']);
  writeProjectFile(root, '.gitignore', '.ua/\n.understand-anything/\n');
  for (const [path, content] of Object.entries(files)) writeProjectFile(root, path, content);
  const baseCommit = commit(root, 'baseline');
  buildBaseline(root, baseCommit);
  return { root, baseCommit };
}

function buildBaseline(root, baseCommit) {
  const intermediate = join(root, '.ua', 'intermediate');
  mkdirSync(intermediate, { recursive: true });
  const rawScanPath = join(intermediate, 'baseline-scan.json');
  run(process.execPath, [scanScript, root, rawScanPath, '--exclude-analysis-data'], root);
  const rawScan = JSON.parse(readFileSync(rawScanPath, 'utf-8'));

  const importInput = join(intermediate, 'baseline-import-input.json');
  const importOutput = join(intermediate, 'baseline-import-output.json');
  writeFileSync(
    importInput,
    JSON.stringify({ projectRoot: root, files: rawScan.files }),
    'utf-8',
  );
  run(process.execPath, [importScript, importInput, importOutput], root);
  const importMap = JSON.parse(readFileSync(importOutput, 'utf-8')).importMap;
  const scan = {
    name: 'fixture',
    description: 'fixture project',
    languages: [...new Set(rawScan.files.map(file => file.language))].sort(),
    frameworks: [],
    contentDigest: rawScan.contentDigest,
    files: rawScan.files,
    totalFiles: rawScan.totalFiles,
    filteredByIgnore: rawScan.filteredByIgnore,
    estimatedComplexity: rawScan.estimatedComplexity,
    importMap,
  };
  writeFileSync(join(intermediate, 'scan-result.json'), JSON.stringify(scan), 'utf-8');

  const fingerprintInput = join(intermediate, 'fingerprint-input.json');
  writeFileSync(
    fingerprintInput,
    JSON.stringify({
      projectRoot: root,
      filePaths: rawScan.files.map(file => file.path),
      gitCommitHash: baseCommit,
    }),
    'utf-8',
  );
  run(process.execPath, [fingerprintScript, fingerprintInput], root);

  const nodes = rawScan.files.map(file => ({
    id: `file:${file.path}`,
    type: 'file',
    name: file.path.split('/').at(-1),
    filePath: file.path,
    summary: file.path,
    tags: ['fixture'],
    complexity: 'simple',
  }));
  const nodeIdByPath = new Map(nodes.map(node => [node.filePath, node.id]));
  const edges = Object.entries(importMap).flatMap(([sourcePath, targets]) =>
    targets
      .filter(targetPath => nodeIdByPath.has(sourcePath) && nodeIdByPath.has(targetPath))
      .map(targetPath => ({
        source: nodeIdByPath.get(sourcePath),
        target: nodeIdByPath.get(targetPath),
        type: 'imports',
        direction: 'forward',
        weight: 0.7,
      })),
  );
  writeFileSync(
    join(root, '.ua', 'knowledge-graph.json'),
    JSON.stringify({
      version: '1.0.0',
      project: {
        name: 'fixture',
        languages: scan.languages,
        frameworks: [],
        description: 'fixture project',
        analyzedAt: '2026-01-01T00:00:00.000Z',
        gitCommitHash: baseCommit,
      },
      nodes,
      edges,
      layers: [{
        id: 'layer:source',
        name: 'Source',
        description: 'Source files',
        nodeIds: nodes.map(node => node.id),
      }],
      tour: [{
        order: 1,
        title: 'Overview',
        description: 'Read the project',
        nodeIds: nodes.map(node => node.id),
      }],
    }),
    'utf-8',
  );
  writeFileSync(
    join(root, '.ua', 'meta.json'),
    JSON.stringify({ gitCommitHash: baseCommit, analyzedFiles: nodes.length, version: '1.0.0' }),
    'utf-8',
  );
}

function prepare(root, baseCommit, extraArgs = []) {
  const result = run(process.execPath, [prepareScript, root, baseCommit, ...extraArgs], root);
  const intermediate = join(root, '.ua', 'intermediate');
  return {
    result,
    plan: JSON.parse(readFileSync(join(intermediate, 'incremental-plan.json'), 'utf-8')),
    scan: JSON.parse(readFileSync(join(intermediate, 'scan-result.json'), 'utf-8')),
    changedFiles: JSON.parse(readFileSync(join(intermediate, 'changed-files.json'), 'utf-8')),
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  // These integration tests intentionally use synchronous child processes.
  // Yield between cases so Vitest workers can service task-update RPC replies,
  // especially on slower Windows runners where the full file exceeds 60s.
  await new Promise(resolve => setImmediate(resolve));
});

describe('prepare-incremental.mjs', { timeout: 30_000 }, () => {
  it('refreshes imports in the same run and only schedules the structural source', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    commit(root, 'add import');

    const { plan, scan, changedFiles } = prepare(root, baseCommit);
    expect(plan.action).toBe('PARTIAL_UPDATE');
    expect(plan.filesToReanalyze).toEqual(['src/a.ts']);
    expect(changedFiles).toEqual(['src/a.ts']);
    expect(scan.importMap['src/a.ts']).toEqual(['src/b.ts']);
    expect(scan.importMap['src/c.ts']).toEqual([]);
  });

  it('turns a local deletion into cleanup with an empty analyzer list', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    unlinkSync(join(root, 'src/b.ts'));
    commit(root, 'delete b');
    writeFileSync(
      join(root, '.ua', 'intermediate', 'batch-99.json'),
      JSON.stringify({
        nodes: [{ id: 'file:src/b.ts', type: 'file', filePath: 'src/b.ts' }],
        edges: [],
      }),
      'utf-8',
    );

    const { plan, scan, changedFiles } = prepare(root, baseCommit);
    expect(plan.action).toBe('PARTIAL_UPDATE');
    expect(plan.filesToReanalyze).toEqual([]);
    expect(plan.deletedFiles).toEqual(['src/b.ts']);
    expect(changedFiles).toEqual([]);
    expect(scan.files.map(file => file.path)).not.toContain('src/b.ts');
    expect(scan.importMap).not.toHaveProperty('src/b.ts');
    expect(() => readFileSync(join(root, '.ua', 'intermediate', 'batch-99.json'))).toThrow();
    const retained = JSON.parse(
      readFileSync(join(root, '.ua', 'intermediate', 'batch-existing.json'), 'utf-8'),
    );
    expect(retained.nodes.map(node => node.filePath)).not.toContain('src/b.ts');

    run(python, [mergeScript, root], root);
    run(process.execPath, [finalizeScript, root], root);
    const graph = JSON.parse(readFileSync(join(root, '.ua', 'knowledge-graph.json'), 'utf-8'));
    const fingerprints = JSON.parse(
      readFileSync(join(root, '.ua', 'fingerprints.json'), 'utf-8'),
    );
    expect(graph.nodes.map(node => node.filePath)).not.toContain('src/b.ts');
    expect(graph.layers.flatMap(layer => layer.nodeIds)).not.toContain('file:src/b.ts');
    expect(graph.tour.flatMap(step => step.nodeIds)).not.toContain('file:src/b.ts');
    expect(fingerprints.files).not.toHaveProperty('src/b.ts');
  });

  it('does not recover an import removed during this incremental run', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'src/a.ts', 'export const a = 1;\n');
    commit(root, 'remove import');

    const { plan, scan } = prepare(root, baseCommit);
    expect(plan.filesToReanalyze).toEqual(['src/a.ts']);
    expect(scan.importMap['src/a.ts']).toEqual([]);
    const intermediate = join(root, '.ua', 'intermediate');
    const retained = JSON.parse(readFileSync(join(intermediate, 'batch-existing.json'), 'utf-8'));
    writeFileSync(
      join(intermediate, 'batch-0.json'),
      JSON.stringify({
        nodes: [{
          id: 'file:src/a.ts',
          type: 'file',
          name: 'a.ts',
          filePath: 'src/a.ts',
          summary: 'a',
          tags: ['fixture'],
          complexity: 'simple',
        }],
        edges: [],
      }),
      'utf-8',
    );
    expect(retained.nodes.map(node => node.filePath)).not.toContain('src/a.ts');
    run(python, [mergeScript, root], root);
    const assembled = JSON.parse(
      readFileSync(join(intermediate, 'assembled-graph.json'), 'utf-8'),
    );
    expect(assembled.edges.filter(edge => edge.type === 'imports')).toHaveLength(0);
  });

  it('removes a deleted target from unchanged import-map sources', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    unlinkSync(join(root, 'src/b.ts'));
    commit(root, 'delete imported target');

    const { plan, scan } = prepare(root, baseCommit);
    expect(plan.filesToReanalyze).toEqual([]);
    expect(plan.deletedFiles).toEqual(['src/b.ts']);
    expect(scan.importMap['src/a.ts']).toEqual([]);
  });

  it('re-resolves unchanged importers when a preferred candidate is added', () => {
    const { root, baseCommit } = setupRepository({
      'src/index.ts': "import { value } from './foo';\nexport { value };\n",
      'src/foo.js': 'export const value = 1;\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });
    writeProjectFile(root, 'src/foo.ts', 'export const value = 2;\n');
    commit(root, 'add preferred typescript candidate');

    const { plan, scan } = prepare(root, baseCommit);
    expect(plan.filesToReanalyze).toEqual(['src/foo.ts']);
    expect(scan.importMap['src/index.ts']).toEqual(['src/foo.ts']);
    const intermediate = join(root, '.ua', 'intermediate');
    const retained = JSON.parse(readFileSync(join(intermediate, 'batch-existing.json'), 'utf-8'));
    expect(retained.edges).not.toContainEqual(
      expect.objectContaining({ source: 'file:src/index.ts', type: 'imports' }),
    );
    writeFileSync(
      join(intermediate, 'batch-0.json'),
      JSON.stringify({
        nodes: [{
          id: 'file:src/foo.ts',
          type: 'file',
          name: 'foo.ts',
          filePath: 'src/foo.ts',
          summary: 'Preferred TypeScript candidate',
          tags: ['typescript'],
          complexity: 'simple',
        }],
        edges: [],
      }),
      'utf-8',
    );
    run(python, [mergeScript, root], root);
    const assembled = JSON.parse(
      readFileSync(join(intermediate, 'assembled-graph.json'), 'utf-8'),
    );
    expect(assembled.edges.filter(edge => edge.source === 'file:src/index.ts')).toEqual([
      expect.objectContaining({ target: 'file:src/foo.ts', type: 'imports' }),
    ]);
  });

  it('re-resolves unchanged importers to a fallback when a preferred candidate is deleted', () => {
    const { root, baseCommit } = setupRepository({
      'src/index.ts': "import { value } from './foo';\nexport { value };\n",
      'src/foo.ts': 'export const value = 2;\n',
      'src/foo.js': 'export const value = 1;\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });
    unlinkSync(join(root, 'src/foo.ts'));
    commit(root, 'delete preferred typescript candidate');

    const { plan, scan } = prepare(root, baseCommit);
    expect(plan.filesToReanalyze).toEqual([]);
    expect(scan.importMap['src/index.ts']).toEqual(['src/foo.js']);
  });

  it('re-resolves unchanged importers when resolver configuration changes', () => {
    const { root, baseCommit } = setupRepository({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
      'src/index.ts': "import { value } from '@/foo';\nexport { value };\n",
      'src/foo.ts': 'export const value = 1;\n',
      'alternate/foo.ts': 'export const value = 2;\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    writeProjectFile(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['alternate/*'] } },
    }));
    commit(root, 'change alias target');

    const { scan } = prepare(root, baseCommit);
    expect(scan.importMap['src/index.ts']).toEqual(['alternate/foo.ts']);
  });

  it('aborts without advancing baselines when import extraction reports a config failure', () => {
    const { root, baseCommit } = setupRepository({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
      'src/index.ts': "import { value } from '@/foo';\nexport { value };\n",
      'src/foo.ts': 'export const value = 1;\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    const graphPath = join(root, '.ua', 'knowledge-graph.json');
    const fingerprintPath = join(root, '.ua', 'fingerprints.json');
    const metaPath = join(root, '.ua', 'meta.json');
    const scanPath = join(root, '.ua', 'intermediate', 'scan-result.json');
    const graphBefore = readFileSync(graphPath, 'utf-8');
    const fingerprintsBefore = readFileSync(fingerprintPath, 'utf-8');
    const metaBefore = readFileSync(metaPath, 'utf-8');
    const scanBefore = readFileSync(scanPath, 'utf-8');
    writeProjectFile(root, 'tsconfig.json', '{"compilerOptions":{"paths":');
    commit(root, 'break resolver config');

    const result = spawnSync(process.execPath, [prepareScript, root, baseCommit], {
      cwd: root,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Import extraction reported failures: tsconfig.json (resolver-config-parse)',
    );
    expect(readFileSync(graphPath, 'utf-8')).toBe(graphBefore);
    expect(readFileSync(fingerprintPath, 'utf-8')).toBe(fingerprintsBefore);
    expect(readFileSync(metaPath, 'utf-8')).toBe(metaBefore);
    expect(readFileSync(scanPath, 'utf-8')).toBe(scanBefore);
  });

  it('refreshes supplemental require imports even when fingerprints classify the edit as cosmetic', () => {
    const { root, baseCommit } = setupRepository({
      'src/index.js': "const value = require('./a');\nmodule.exports = value;\n",
      'src/a.js': 'module.exports = 1;\n',
      'src/b.js': 'module.exports = 2;\n',
      'src/c.js': 'module.exports = 3;\n',
    });
    writeProjectFile(
      root,
      'src/index.js',
      "const value = require('./b');\nmodule.exports = value;\n",
    );
    commit(root, 'change supplemental require');

    const { plan, scan } = prepare(root, baseCommit);
    expect(plan.action).toBe('SKIP');
    expect(plan.cosmeticFiles).toEqual(['src/index.js']);
    expect(plan.filesToReanalyze).toEqual([]);
    expect(scan.importMap['src/index.js']).toEqual(['src/b.js']);
    run(process.execPath, [finalizeScript, root], root);
    const graph = JSON.parse(readFileSync(join(root, '.ua', 'knowledge-graph.json'), 'utf-8'));
    expect(graph.edges.filter(edge => edge.source === 'file:src/index.js')).toEqual([
      expect.objectContaining({ target: 'file:src/b.js', type: 'imports' }),
    ]);
  });

  it('treats LF-to-CRLF conversion as cosmetic and schedules no analyzer', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export function value() {\n  return 1;\n}\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'src/a.ts', 'export function value() {\r\n  return 1;\r\n}\r\n');
    commit(root, 'convert line endings');

    const { plan, changedFiles } = prepare(root, baseCommit);
    expect(plan.action).toBe('SKIP');
    expect(plan.cosmeticFiles).toEqual(['src/a.ts']);
    expect(plan.filesToReanalyze).toEqual([]);
    expect(changedFiles).toEqual([]);
  });

  it('applies a new explicit exclude against the current inventory at the same commit', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'feature/old.ts': 'export const old = true;\n',
    });

    const { plan, scan } = prepare(root, baseCommit, ['--exclude', 'feature/']);
    expect(plan.headCommit).toBe(baseCommit);
    expect(plan.filesToReanalyze).toEqual([]);
    expect(plan.deletedFiles).toEqual(['feature/old.ts']);
    expect(scan.files.map(file => file.path)).not.toContain('feature/old.ts');
  });

  it('conservatively analyzes an existing non-code file missing from a legacy fingerprint baseline', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'docs/guide.md': '# Guide\n\nOld body.\n',
    });
    const fingerprintPath = join(root, '.ua', 'fingerprints.json');
    const fingerprints = JSON.parse(readFileSync(fingerprintPath, 'utf-8'));
    delete fingerprints.files['docs/guide.md'];
    writeFileSync(fingerprintPath, JSON.stringify(fingerprints), 'utf-8');
    writeProjectFile(root, 'docs/guide.md', '# Guide\n\nNew body.\n');
    commit(root, 'update legacy-unfingerprinted docs');

    const { plan } = prepare(root, baseCommit);
    expect(plan.filesToReanalyze).toEqual(['docs/guide.md']);
    expect(plan.reason).toContain('structural changes');
  });

  it('treats parsed non-code content changes as structural', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'docs/guide.md': '# Guide\n\nOld body.\n',
    });
    const fingerprints = JSON.parse(
      readFileSync(join(root, '.ua', 'fingerprints.json'), 'utf-8'),
    );
    expect(fingerprints.files['docs/guide.md'].hasStructuralAnalysis).toBe(false);
    writeProjectFile(root, 'docs/guide.md', '# Guide\n\nNew body.\n');
    commit(root, 'update parsed non-code content');

    const { plan } = prepare(root, baseCommit);
    expect(plan.filesToReanalyze).toEqual(['docs/guide.md']);
  });

  it('classifies implementation-only edits as SKIP and advances fingerprints via finalize', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export function value() { return 1; }\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'src/a.ts', 'export function value() { return 2; }\n');
    const headCommit = commit(root, 'implementation only');

    const { plan } = prepare(root, baseCommit);
    expect(plan.action).toBe('SKIP');
    expect(plan.cosmeticFiles).toEqual(['src/a.ts']);
    run(process.execPath, [finalizeScript, root], root);

    const meta = JSON.parse(readFileSync(join(root, '.ua', 'meta.json'), 'utf-8'));
    const fingerprints = JSON.parse(
      readFileSync(join(root, '.ua', 'fingerprints.json'), 'utf-8'),
    );
    const graph = JSON.parse(
      readFileSync(join(root, '.ua', 'knowledge-graph.json'), 'utf-8'),
    );
    expect(meta.gitCommitHash).toBe(headCommit);
    expect(fingerprints.gitCommitHash).toBe(headCommit);
    expect(Object.keys(fingerprints.files)).toHaveLength(4);
    expect(graph.project.gitCommitHash).toBe(headCommit);
    expect(graph.project.analyzedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('removes files newly covered by .understandignore without analyzing them', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'legacy/old.ts': 'export const old = true;\n',
    });
    writeProjectFile(root, '.understandignore', 'legacy/\n');
    commit(root, 'ignore legacy');

    const { plan } = prepare(root, baseCommit);
    expect(plan.filesToReanalyze).toEqual([]);
    expect(plan.deletedFiles).toEqual(['legacy/old.ts']);
    expect(plan.ignoredFiles).toContain('.understandignore');
    expect(plan.action).toBe('ARCHITECTURE_UPDATE');
  });

  it('handles renames and spaces as a delete plus add', () => {
    const { root, baseCommit } = setupRepository({
      'src/old name.ts': 'export const value = 1;\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
    });
    renameSync(join(root, 'src/old name.ts'), join(root, 'src/new name.ts'));
    commit(root, 'rename spaced file');

    const { plan } = prepare(root, baseCommit);
    expect(plan.deletedFiles).toEqual(['src/old name.ts']);
    expect(plan.filesToReanalyze).toEqual(['src/new name.ts']);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves literal backslashes in POSIX project paths',
    () => {
      const literalPath = 'src/foo\\bar.js';
      const { root, baseCommit } = setupRepository({
        [literalPath]: 'function before() { return 1; }\nmodule.exports = before;\n',
        'src/a.js': 'module.exports = 1;\n',
        'src/b.js': 'module.exports = 2;\n',
        'src/c.js': 'module.exports = 3;\n',
      });
      writeProjectFile(root, literalPath, 'function after() { return 1; }\nmodule.exports = after;\n');
      commit(root, 'change literal backslash path');

      const { plan, scan } = prepare(root, baseCommit);
      expect(plan.filesToReanalyze).toEqual([literalPath]);
      expect(scan.files.map(file => file.path)).toContain(literalPath);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'preserves newline-containing paths in the JSON analyzer handoff',
    () => {
      const newlinePath = 'src/line\nbreak.js';
      const { root, baseCommit } = setupRepository({
        [newlinePath]: 'function before() { return 1; }\nmodule.exports = before;\n',
        'src/a.js': 'module.exports = 1;\n',
        'src/b.js': 'module.exports = 2;\n',
        'src/c.js': 'module.exports = 3;\n',
      });
      writeProjectFile(
        root,
        newlinePath,
        'function after() { return 1; }\nmodule.exports = after;\n',
      );
      commit(root, 'change newline path');

      const { plan, changedFiles } = prepare(root, baseCommit);
      expect(plan.filesToReanalyze).toEqual([newlinePath]);
      expect(changedFiles).toEqual([newlinePath]);
    },
  );

  it('keeps the same new-directory decision when preparation is retried', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'new-package/index.ts', 'export const added = true;\n');
    commit(root, 'add package');

    const first = prepare(root, baseCommit).plan;
    const second = prepare(root, baseCommit).plan;
    expect(first.action).toBe('ARCHITECTURE_UPDATE');
    expect(second.action).toBe(first.action);
    expect(second.filesToReanalyze).toEqual(['new-package/index.ts']);
  });

  it('reuses the preserved import map when retrying a different head', () => {
    const { root, baseCommit } = setupRepository({
      'src/index.js': "const value = require('./a');\nmodule.exports = value;\n",
      'src/a.js': 'module.exports = 1;\n',
      'src/b.js': 'module.exports = 2;\n',
      'src/c.js': 'function c() { return 3; }\nmodule.exports = c;\n',
    });
    writeProjectFile(
      root,
      'src/index.js',
      "const value = require('./b');\nmodule.exports = value;\n",
    );
    commit(root, 'abandoned head changes import');
    const abandoned = prepare(root, baseCommit);
    expect(abandoned.scan.importMap['src/index.js']).toEqual(['src/b.js']);

    git(root, ['reset', '--hard', baseCommit]);
    writeProjectFile(
      root,
      'src/c.js',
      'function changedC() { return 3; }\nmodule.exports = changedC;\n',
    );
    commit(root, 'replacement head changes another file');
    const replacement = prepare(root, baseCommit);

    expect(replacement.scan.importMap['src/index.js']).toEqual(['src/a.js']);
    expect(replacement.plan.filesToReanalyze).toEqual(['src/c.js']);
  });

  it('does not advance the baseline for generated-artifact-only commits', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, '.ua/tracked-generated.json', '{}\n');
    commit(root, 'generated output', { forcePaths: ['.ua/tracked-generated.json'] });

    const { plan } = prepare(root, baseCommit);
    expect(plan.action).toBe('SKIP');
    expect(plan.generatedArtifactFiles).toEqual(['.ua/tracked-generated.json']);
    run(process.execPath, [finalizeScript, root], root);
    const meta = JSON.parse(readFileSync(join(root, '.ua', 'meta.json'), 'utf-8'));
    expect(meta.gitCommitHash).toBe(baseCommit);
  });

  it('refuses to stamp HEAD when an analyzable untracked file is present', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    const metaPath = join(root, '.ua', 'meta.json');
    const metaBefore = readFileSync(metaPath, 'utf-8');
    writeProjectFile(root, 'src/a.ts', 'export const renamed = 1;\n');
    commit(root, 'committed structural change');
    writeProjectFile(root, 'src/uncommitted.ts', 'export const dirty = true;\n');

    const result = spawnSync(process.execPath, [prepareScript, root, baseCommit], {
      cwd: root,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('relevant uncommitted changes: src/uncommitted.ts');
    expect(readFileSync(metaPath, 'utf-8')).toBe(metaBefore);
  });

  it('refuses a partial-commit update when another analyzed file is still unstaged', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'src/a.ts', 'export const renamed = 1;\n');
    commit(root, 'partial commit');
    writeProjectFile(root, 'src/b.ts', 'export const stillDirty = 2;\n');

    const result = spawnSync(process.execPath, [prepareScript, root, baseCommit], {
      cwd: root,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('relevant uncommitted changes: src/b.ts');
  });

  it('allows uncommitted files excluded by deterministic analysis rules', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'src/a.ts', 'export const renamed = 1;\n');
    commit(root, 'committed structural change');
    writeProjectFile(root, 'dist/untracked.js', 'generated();\n');

    const { plan } = prepare(root, baseCommit);
    expect(plan.filesToReanalyze).toEqual(['src/a.ts']);
  });

  it('aborts rather than treating a transient scan read failure as deletion', () => {
    if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return;
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    const graphPath = join(root, '.ua', 'knowledge-graph.json');
    const metaPath = join(root, '.ua', 'meta.json');
    const graphBefore = readFileSync(graphPath, 'utf-8');
    const metaBefore = readFileSync(metaPath, 'utf-8');
    writeProjectFile(root, 'src/a.ts', 'export const renamed = 1;\n');
    commit(root, 'committed structural change');
    chmodSync(join(root, 'src/b.ts'), 0o000);

    const result = spawnSync(process.execPath, [prepareScript, root, baseCommit], {
      cwd: root,
      encoding: 'utf-8',
    });
    chmodSync(join(root, 'src/b.ts'), 0o644);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /(?:Project scan reported failures|Working tree has relevant uncommitted changes): src\/b\.ts/,
    );
    expect(readFileSync(graphPath, 'utf-8')).toBe(graphBefore);
    expect(readFileSync(metaPath, 'utf-8')).toBe(metaBefore);
  });
});

describe('finalize-incremental.mjs', { timeout: 30_000 }, () => {
  it('preserves local layer/tour text, removes dangling refs, and places new nodes by path', () => {
    const { root, baseCommit } = setupRepository({
      'src/api/a.ts': 'export const a = 1;\n',
      'src/ui/view.ts': 'export const view = 1;\n',
      'src/other.ts': 'export const other = 1;\n',
      'docs/readme.md': '# Docs\n',
    });
    const graphPath = join(root, '.ua', 'knowledge-graph.json');
    const previousGraph = JSON.parse(readFileSync(graphPath, 'utf-8'));
    previousGraph.layers = [
      {
        id: 'layer:api',
        name: 'API',
        description: 'API files',
        nodeIds: ['file:src/api/a.ts', 'file:missing.ts'],
      },
      {
        id: 'layer:ui',
        name: 'UI',
        description: 'UI files',
        nodeIds: ['file:src/ui/view.ts', 'file:src/other.ts', 'file:docs/readme.md'],
      },
    ];
    previousGraph.tour[0].nodeIds.push('file:missing.ts');
    writeFileSync(graphPath, JSON.stringify(previousGraph), 'utf-8');
    writeProjectFile(root, 'src/api/new.ts', "import { a } from './a';\nexport const value = a;\n");
    const headCommit = commit(root, 'add api file');
    const { plan } = prepare(root, baseCommit);
    expect(plan.action).toBe('PARTIAL_UPDATE');

    const intermediate = join(root, '.ua', 'intermediate');
    const retained = JSON.parse(readFileSync(join(intermediate, 'batch-existing.json'), 'utf-8'));
    const newNode = {
      id: 'file:src/api/new.ts',
      type: 'file',
      name: 'new.ts',
      filePath: 'src/api/new.ts',
      summary: 'new api',
      tags: ['api'],
      complexity: 'simple',
    };
    const aId = 'file:src/api/a.ts';
    writeFileSync(
      join(intermediate, 'assembled-graph.json'),
      JSON.stringify({
        nodes: [...retained.nodes, newNode],
        edges: [{ source: newNode.id, target: aId, type: 'imports', direction: 'forward', weight: 0.7 }],
      }),
      'utf-8',
    );

    run(process.execPath, [finalizeScript, root], root);
    const graph = JSON.parse(readFileSync(join(root, '.ua', 'knowledge-graph.json'), 'utf-8'));
    expect(graph.project.gitCommitHash).toBe(headCommit);
    expect(graph.layers.find(layer => layer.id === 'layer:api').nodeIds).toContain(newNode.id);
    expect(graph.layers.flatMap(layer => layer.nodeIds)).not.toContain('file:missing.ts');
    expect(graph.tour[0].title).toBe('Overview');
    expect(graph.tour[0].description).toBe('Read the project');
    expect(graph.tour[0].nodeIds.every(id => graph.nodes.some(node => node.id === id))).toBe(true);
    const fingerprints = JSON.parse(
      readFileSync(join(root, '.ua', 'fingerprints.json'), 'utf-8'),
    );
    expect(fingerprints.gitCommitHash).toBe(headCommit);
    expect(fingerprints.files).toHaveProperty('src/api/new.ts');
    expect(Object.keys(fingerprints.files)).toHaveLength(5);
  });

  it('does not advance graph, fingerprints, or meta when assembled output is missing', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    const graphPath = join(root, '.ua', 'knowledge-graph.json');
    const fingerprintPath = join(root, '.ua', 'fingerprints.json');
    const metaPath = join(root, '.ua', 'meta.json');
    const graphBefore = readFileSync(graphPath, 'utf-8');
    const fingerprintsBefore = readFileSync(fingerprintPath, 'utf-8');
    const metaBefore = readFileSync(metaPath, 'utf-8');
    writeProjectFile(root, 'src/a.ts', 'export const renamed = 1;\n');
    commit(root, 'structural change');
    prepare(root, baseCommit);

    const result = spawnSync(process.execPath, [finalizeScript, root], {
      cwd: root,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('assembled-graph.json is missing or invalid');
    expect(readFileSync(graphPath, 'utf-8')).toBe(graphBefore);
    expect(readFileSync(fingerprintPath, 'utf-8')).toBe(fingerprintsBefore);
    expect(readFileSync(metaPath, 'utf-8')).toBe(metaBefore);
  });

  it.each([
    ['table', 'db/schema.sql', 'users'],
    ['endpoint', 'api/openapi.yaml', 'GET-users'],
  ])('accepts a valid %s node as analyzed-file coverage', (nodeType, changedPath, name) => {
    const initialContent = nodeType === 'table'
      ? 'CREATE TABLE users (id INT);\n'
      : 'openapi: 3.0.0\npaths: {}\n';
    const changedContent = nodeType === 'table'
      ? 'CREATE TABLE users (id INT, name TEXT);\n'
      : 'openapi: 3.0.0\npaths:\n  /users: {}\n';
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      [changedPath]: initialContent,
    });
    writeProjectFile(root, changedPath, changedContent);
    const headCommit = commit(root, `change ${nodeType} file`);
    prepare(root, baseCommit);

    const intermediate = join(root, '.ua', 'intermediate');
    const retained = JSON.parse(readFileSync(join(intermediate, 'batch-existing.json'), 'utf-8'));
    const analyzedNode = {
      id: `${nodeType}:${changedPath}:${name}`,
      type: nodeType,
      name,
      filePath: changedPath,
      summary: `${nodeType} definition`,
      tags: [nodeType],
      complexity: 'simple',
    };
    writeFileSync(
      join(intermediate, 'assembled-graph.json'),
      JSON.stringify({ nodes: [...retained.nodes, analyzedNode], edges: retained.edges }),
      'utf-8',
    );
    run(process.execPath, [finalizeScript, root], root);

    const graph = JSON.parse(readFileSync(join(root, '.ua', 'knowledge-graph.json'), 'utf-8'));
    expect(graph.project.gitCommitHash).toBe(headCommit);
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: analyzedNode.id }));
  });

  it('adds a newly introduced language to graph project metadata', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'src/script.py', 'value = 1\n');
    commit(root, 'add first python file');
    prepare(root, baseCommit);

    const intermediate = join(root, '.ua', 'intermediate');
    const retained = JSON.parse(readFileSync(join(intermediate, 'batch-existing.json'), 'utf-8'));
    writeFileSync(
      join(intermediate, 'assembled-graph.json'),
      JSON.stringify({
        nodes: [
          ...retained.nodes,
          {
            id: 'file:src/script.py',
            type: 'file',
            name: 'script.py',
            filePath: 'src/script.py',
            summary: 'Python script',
            tags: ['python'],
            complexity: 'simple',
          },
        ],
        edges: retained.edges,
      }),
      'utf-8',
    );
    run(process.execPath, [finalizeScript, root], root);

    const graph = JSON.parse(readFileSync(join(root, '.ua', 'knowledge-graph.json'), 'utf-8'));
    expect(graph.project.languages).toEqual(['python', 'typescript']);
  });

  it('removes a language from graph metadata when its last file is deleted', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/script.py': 'value = 1\n',
    });
    unlinkSync(join(root, 'src/script.py'));
    commit(root, 'remove last python file');
    prepare(root, baseCommit);
    run(python, [mergeScript, root], root);
    run(process.execPath, [finalizeScript, root], root);

    const graph = JSON.parse(readFileSync(join(root, '.ua', 'knowledge-graph.json'), 'utf-8'));
    expect(graph.project.languages).toEqual(['typescript']);
  });

  it('does not advance the baseline when analyzer output omits a changed file node', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    const graphPath = join(root, '.ua', 'knowledge-graph.json');
    const fingerprintPath = join(root, '.ua', 'fingerprints.json');
    const metaPath = join(root, '.ua', 'meta.json');
    const graphBefore = readFileSync(graphPath, 'utf-8');
    const fingerprintsBefore = readFileSync(fingerprintPath, 'utf-8');
    const metaBefore = readFileSync(metaPath, 'utf-8');
    writeProjectFile(root, 'src/a.ts', 'export const renamed = 1;\n');
    commit(root, 'structural change omitted by analyzer');
    prepare(root, baseCommit);

    const intermediate = join(root, '.ua', 'intermediate');
    const retained = JSON.parse(readFileSync(join(intermediate, 'batch-existing.json'), 'utf-8'));
    writeFileSync(
      join(intermediate, 'assembled-graph.json'),
      JSON.stringify(retained),
      'utf-8',
    );
    const result = spawnSync(process.execPath, [finalizeScript, root], {
      cwd: root,
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing whole-file nodes for analyzed paths: src/a.ts');
    expect(readFileSync(graphPath, 'utf-8')).toBe(graphBefore);
    expect(readFileSync(fingerprintPath, 'utf-8')).toBe(fingerprintsBefore);
    expect(readFileSync(metaPath, 'utf-8')).toBe(metaBefore);
  });
});
