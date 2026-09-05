/** Shared merge/finalize gate. Reports evidence; never restores old graph data. */
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const skillDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(skillDir, '../..');
const require = createRequire(join(pluginRoot, 'package.json'));
let corePromise;
async function getCore() {
  corePromise ??= (async () => {
    try {
      return await import(pathToFileURL(require.resolve('@understand-anything/core')).href);
    } catch {
      return import(pathToFileURL(join(pluginRoot, 'packages/core/dist/index.js')).href);
    }
  })();
  return corePromise;
}

export async function getIntermediateDir(projectRoot) {
  return join((await getCore()).resolveUaDir(projectRoot), 'intermediate');
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function atomicWriteJson(path, value) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

export function normalizePath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) return null;
  const path = (process.platform === 'win32' ? value.replaceAll('\\', '/') : value).replace(/^\.\//, '');
  return path.split('/').includes('..') ? null : path;
}

export function symbolKind(node) {
  if (node.type === 'class') return 'class';
  if (['function', 'func', 'method'].includes(node.type)) return 'callable';
  return null;
}

function qualifiedName(name) {
  return typeof name === 'string' ? name.replaceAll('::', '.').replaceAll('#', '.') : '';
}

function symbolKey(symbol) {
  return JSON.stringify([symbol.kind, symbol.owner, symbol.name]);
}

function sourceSymbols(evidence) {
  if (evidence?.status !== 'succeeded' || !evidence.structure) return [];
  const { functions, classes } = evidence.structure;
  const symbols = [];
  for (const cls of classes) {
    symbols.push({ kind: 'class', owner: '', name: cls.name, lineRange: cls.lineRange });
    for (const name of cls.methods) {
      symbols.push({ kind: 'callable', owner: cls.name, name, lineRange: cls.lineRange });
    }
  }
  for (const fn of functions) {
    // Some extractors emit methods in both functions and classes[].methods.
    // Keep overloads ambiguous, but avoid counting that dual representation.
    const owners = classes.filter(cls => cls.methods.includes(fn.name)
      && fn.lineRange[0] >= cls.lineRange[0] && fn.lineRange[1] <= cls.lineRange[1]);
    if (owners.length > 0) continue;
    symbols.push({ kind: 'callable', owner: '', name: fn.name, lineRange: fn.lineRange });
  }
  return symbols;
}

function nodeNames(node) {
  const path = normalizePath(node.filePath);
  const names = new Set([qualifiedName(node.name)]);
  // Accept ID spelling changes, including func/function and class separators.
  // Path and kind are independently checked; the ID is only a name hint.
  const marker = `:${path}:`;
  if (typeof node.id === 'string' && node.id.includes(marker)) {
    names.add(qualifiedName(node.id.slice(node.id.indexOf(marker) + marker.length)));
  }
  return names;
}

function classOwners(node, graph) {
  const parents = new Set(graph.edges.filter(edge => edge.type === 'contains' && edge.target === node.id)
    .map(edge => edge.source));
  return graph.nodes.filter(parent => parent.type === 'class' && parents.has(parent.id));
}

function hasPreservedIdentity(node, previous, current, sameRevision = false) {
  const candidate = current.nodes.find(candidate => candidate.id === node.id
    && symbolKind(candidate) === symbolKind(node) && candidate.name === node.name);
  if (!candidate) return false;
  const owners = (item, graph) => classOwners(item, graph)
    .map(owner => JSON.stringify([owner.id, owner.name])).sort();
  const oldOwners = owners(node, previous);
  if (JSON.stringify(oldOwners) !== JSON.stringify(owners(candidate, current))) return false;
  // An unowned callable cannot prove its scope: missing class nodes may itself
  // be analyzer under-reporting. Across revisions always verify it in source.
  // Within one HEAD, identical descriptors preserve existing current refs;
  // changed source locations still require matching against that HEAD.
  if (symbolKind(node) === 'callable' && oldOwners.length === 0
    && (!sameRevision || JSON.stringify(node.lineRange) !== JSON.stringify(candidate.lineRange))) return false;
  return true;
}

function resolveSymbol(node, graph, symbols) {
  const kind = symbolKind(node);
  const names = nodeNames(node);
  let candidates = symbols.filter(symbol => symbol.kind === kind && (
    names.has(qualifiedName(symbol.name))
    || (symbol.owner && names.has(qualifiedName(`${symbol.owner}.${symbol.name}`)))
  ));
  const qualified = candidates.filter(symbol => symbol.owner
    && names.has(qualifiedName(`${symbol.owner}.${symbol.name}`)));
  if (qualified.length) candidates = qualified;
  const owners = classOwners(node, graph).map(parent => parent.name);
  if (owners.length) candidates = candidates.filter(symbol => owners.includes(symbol.owner));
  // Lines locate ownership within one revision only; they are never identity
  // across revisions. Do not use lines to guess among overloads/same-name classes.
  if (candidates.length > 1 && Array.isArray(node.lineRange)) {
    const located = candidates.filter(symbol => node.lineRange[0] >= symbol.lineRange[0]
      && node.lineRange[1] <= symbol.lineRange[1]);
    if (located.length === 1) candidates = located;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export function compareFileSymbols(previous, current, baseEvidence, headEvidence, sameRevision = false) {
  const oldSymbols = previous.nodes.filter(symbolKind);
  const newSymbols = current.nodes.filter(symbolKind);
  const baseSource = sourceSymbols(baseEvidence);
  const headSource = sourceSymbols(headEvidence);
  const oldMappings = oldSymbols.map(node => resolveSymbol(node, previous, baseSource));
  const newMappings = newSymbols.map(node => resolveSymbol(node, current, headSource));
  const missing = [];
  const replacements = [];
  for (let index = 0; index < oldSymbols.length; index++) {
    const node = oldSymbols[index];
    if (hasPreservedIdentity(node, previous, current, sameRevision)) continue;
    const entry = { id: node.id, name: node.name, type: node.type, status: 'unknown', reason: '' };
    const old = oldMappings[index];
    if (!old || baseEvidence?.status !== 'succeeded' || headEvidence?.status !== 'succeeded') {
      entry.reason = 'Old symbol cannot be mapped uniquely, or source parsing is unavailable/failed';
    } else if (oldMappings.filter(symbol => symbol && symbolKey(symbol) === symbolKey(old)).length !== 1) {
      entry.reason = 'Multiple old graph nodes map to the same source symbol';
    } else {
      const matches = headSource.filter(symbol => symbolKey(symbol) === symbolKey(old));
      const graphMatches = newMappings.filter(symbol => symbol && symbolKey(symbol) === symbolKey(old));
      if (matches.length === 1 && graphMatches.length === 1) {
        const matchedIndex = newMappings.findIndex(symbol => symbol && symbolKey(symbol) === symbolKey(old));
        if (newSymbols[matchedIndex].id !== node.id) {
          replacements.push({ oldId: node.id, newId: newSymbols[matchedIndex].id });
        }
        continue;
      }
      if (matches.length === 1) {
        entry.status = 'still-present';
        entry.reason = 'Symbol still exists in current source but is missing or ambiguous in the new graph';
      } else if (matches.length > 1) {
        entry.reason = 'Current source has ambiguous same-name symbols';
      } else if (headSource.length === 0) {
        entry.reason = 'Empty structural extraction is not proof of deletion';
      } else if (headSource.some(symbol => symbol.name === old.name)
        || (headEvidence.leafTexts ?? []).some(text => qualifiedName(text.replace(/^['"`]|['"`]$/g, '')) === qualifiedName(old.name))) {
        entry.reason = 'Name remains in source; moved or unsupported syntax cannot be ruled out';
      } else {
        entry.status = 'deleted';
        entry.reason = 'Both revisions parsed; uniquely mapped old symbol and its name are absent from current source';
      }
    }
    missing.push(entry);
  }
  return {
    filePath: previous.filePath,
    beforeCount: previous.nodes.length,
    afterCount: current.nodes.length,
    beforeSymbolCount: oldSymbols.length,
    afterSymbolCount: newSymbols.length,
    missing,
    replacements,
  };
}

export function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.error || result.status}`);
  return result.stdout;
}

export function loadSymbolContext(projectRoot, intermediateDir) {
  const plan = readJson(join(intermediateDir, 'incremental-plan.json'));
  const baseline = readJson(join(intermediateDir, 'incremental-symbol-baseline.json'));
  if (baseline.version !== 1 || baseline.baseCommit !== plan.baseCommit || baseline.headCommit !== plan.headCommit
    || !Array.isArray(baseline.files)) throw new Error('Symbol baseline does not match the incremental plan');
  const paths = baseline.files.map(file => file.filePath).sort();
  if (JSON.stringify(paths) !== JSON.stringify([...plan.filesToReanalyze].sort())
    || paths.some(path => !normalizePath(path) || (plan.deletedFiles ?? []).includes(path))
    || new Set(paths).size !== paths.length) {
    throw new Error('Symbol baseline file inventory does not match the incremental plan');
  }
  if (git(projectRoot, ['rev-parse', 'HEAD']).trim() !== plan.headCommit) {
    throw new Error('HEAD changed since prepare; baseline not advanced');
  }
  // Check every analyzer input, even if all IDs survive and parsing is skipped.
  // Git compares normalized contents, including repository clean/EOL rules.
  if (paths.length) git(projectRoot, [
    'diff', '--quiet', '--no-ext-diff', plan.headCommit, '--', ...paths.map(path => `:(literal)${path}`),
  ]);
  return { plan, baseline };
}

export async function validateIncrementalSymbols(projectRoot, { graph, intermediateDir } = {}) {
  const core = await getCore();
  intermediateDir ??= join(core.resolveUaDir(projectRoot), 'intermediate');
  const reportPath = join(intermediateDir, 'incremental-symbol-report.json');
  const report = { version: 1, ok: false, files: [], unresolvedFiles: [], errors: [] };
  const graphFromDisk = graph === undefined;
  try {
    const { plan, baseline } = loadSymbolContext(projectRoot, intermediateDir);
    report.baseCommit = plan.baseCommit;
    report.headCommit = plan.headCommit;
    graph ??= readJson(join(intermediateDir, 'assembled-graph.json'));
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Invalid assembled graph');
    report.graphHash = createHash('sha256').update(JSON.stringify(graph)).digest('hex');
    let parser;
    const evidenceByPath = new Map();
    const parseHead = async path => {
      if (evidenceByPath.get(path)?.head) return evidenceByPath.get(path).head;
      if (!parser) {
        parser = new core.TreeSitterPlugin(core.builtinLanguageConfigs.filter(config => config.treeSitter));
        await parser.init();
      }
      // :./ keeps git-show relative to projectRoot, including monorepo subdirectories.
      const headContent = git(projectRoot, ['show', `${plan.headCommit}:./${path}`]);
      const evidence = { head: parser.analyzeFileStrict(path, headContent) };
      evidenceByPath.set(path, evidence);
      return evidence.head;
    };
    const parseRevisions = async path => {
      await parseHead(path);
      const evidence = evidenceByPath.get(path);
      if (!evidence.base) {
        const oldContent = git(projectRoot, ['show', `${plan.baseCommit}:./${path}`]);
        evidence.base = parser.analyzeFileStrict(path, oldContent);
      }
      return evidence;
    };
    const fileGraph = filePath => {
      const nodes = graph.nodes.filter(node => normalizePath(node.filePath) === filePath);
      const ids = new Set(nodes.map(node => node.id));
      return { nodes, edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
    };
    for (const previous of baseline.files) {
      const current = fileGraph(previous.filePath);
      let baseEvidence;
      let headEvidence;
      if (previous.nodes.some(node => symbolKind(node) && !hasPreservedIdentity(node, previous, current))) {
        try {
          const evidence = await parseRevisions(previous.filePath);
          baseEvidence = evidence.base;
          headEvidence = evidence.head;
        } catch (error) {
          baseEvidence = { status: 'failed' };
          headEvidence = { status: 'failed' };
          report.errors.push(`${previous.filePath}: ${error.message}`);
        }
      }
      const result = compareFileSymbols(previous, current, baseEvidence, headEvidence);
      report.files.push(result);
      if (result.missing.some(node => node.status !== 'deleted')) report.unresolvedFiles.push(previous.filePath);
    }
    report.ok = report.errors.length === 0 && report.unresolvedFiles.length === 0;
    if (report.ok) {
      const retryPath = join(intermediateDir, 'incremental-symbol-retry.json');
      const retry = existsSync(retryPath) ? readJson(retryPath) : null;
      const candidatePath = join(intermediateDir, 'incremental-edge-candidates.json');
      const currentCandidates = existsSync(candidatePath) ? readJson(candidatePath) : null;
      if (currentCandidates && (currentCandidates.baseCommit !== plan.baseCommit
        || currentCandidates.headCommit !== plan.headCommit || !Array.isArray(currentCandidates.edges))) {
        throw new Error('Current edge candidates do not match the incremental plan');
      }
      const hasRetry = retry?.baseCommit === plan.baseCommit && retry.headCommit === plan.headCommit
        && Array.isArray(retry.inboundEdgeCandidates);
      if (hasRetry && !Array.isArray(retry.currentFiles)) throw new Error('Retry endpoint descriptors are missing');
      const candidates = [
        ...(currentCandidates?.edges ?? []).map(edge => ({ edge, saved: false })),
        ...(hasRetry ? retry.inboundEdgeCandidates : []).map(edge => ({ edge, saved: true })),
      ];
      if (candidates.length || hasRetry) {
        const ids = new Set(graph.nodes.map(node => node.id));
        const replacements = new Map(report.files.flatMap(file => file.replacements)
          .map(({ oldId, newId }) => [oldId, newId]));
        const deleted = new Set(report.files.flatMap(file => file.missing.map(node => node.id)));
        const baselineBindings = new Map(baseline.files.flatMap(file => file.nodes.filter(symbolKind))
          .map(node => [node.id, deleted.has(node.id) ? null : replacements.get(node.id) ?? node.id]));
        const currentBindings = new Map();
        // These descriptors belong to the initial CURRENT analysis, not the
        // old published graph. Both sides therefore map against HEAD source.
        for (const previous of hasRetry ? retry.currentFiles : []) {
          const current = fileGraph(previous.filePath);
          const needsEvidence = previous.nodes.some(node => symbolKind(node) && !hasPreservedIdentity(node, previous, current, true));
          const evidence = needsEvidence && previous.filePath ? await parseHead(previous.filePath) : undefined;
          const result = compareFileSymbols(previous, current, evidence, evidence, true);
          const missing = new Set(result.missing.map(node => node.id));
          const aliases = new Map(result.replacements.map(({ oldId, newId }) => [oldId, newId]));
          for (const node of previous.nodes) {
            const match = symbolKind(node)
              ? missing.has(node.id) ? null : aliases.get(node.id) ?? node.id
              : current.nodes.some(candidate => candidate.id === node.id && candidate.type === node.type && candidate.name === node.name)
                ? node.id : null;
            // Even a failed match overrides the old baseline meaning of this
            // ID. The current analysis may have reused it for another symbol.
            currentBindings.set(node.id, match);
          }
        }
        const endpoint = (id, saved) => {
          if (saved && currentBindings.has(id)) return currentBindings.get(id);
          if (!saved && ids.has(id)) return id;
          if (baselineBindings.has(id)) return baselineBindings.get(id);
          return ids.has(id) ? id : null;
        };
        const edgeKey = edge => JSON.stringify([edge.source, edge.target, edge.type, edge.direction]);
        const existing = new Map(graph.edges.map((edge, index) => [edgeKey(edge), index]));
        report.reconciledCurrentEdges = 0;
        report.droppedCurrentEdges = [];
        report.idReplacements = [...replacements].map(([oldId, newId]) => ({ oldId, newId }));
        report.currentIdBindings = [...currentBindings].map(([oldId, newId]) => ({ oldId, newId }));
        for (const { edge: candidate, saved } of candidates) {
          const edge = {
            ...candidate,
            source: endpoint(candidate.source, saved),
            target: endpoint(candidate.target, saved),
          };
          if (!ids.has(edge.source) || !ids.has(edge.target)) {
            report.droppedCurrentEdges.push({ source: candidate.source, target: candidate.target, type: candidate.type });
          } else {
            const index = existing.get(edgeKey(edge));
            if (index === undefined) {
              existing.set(edgeKey(edge), graph.edges.length);
              graph.edges.push(edge);
              report.reconciledCurrentEdges++;
            } else if (Number(edge.weight) > Number(graph.edges[index].weight)) {
              graph.edges[index] = edge;
              report.reconciledCurrentEdges++;
            }
          }
        }
        // Merge's earlier dangling-edge cleanup cannot see semantic ID aliases.
        // Save the reconciled candidate before architecture/tour consumers run.
        if (graphFromDisk && report.reconciledCurrentEdges > 0) {
          atomicWriteJson(join(intermediateDir, 'assembled-graph.json'), graph);
        }
        report.graphHash = createHash('sha256').update(JSON.stringify(graph)).digest('hex');
      }
    }
  } catch (error) {
    report.ok = false;
    report.errors.push(error.message);
  }
  atomicWriteJson(reportPath, report);
  return report;
}

export function formatSymbolReport(report) {
  const lines = ['Incremental symbol validation:'];
  for (const file of report.files) {
    lines.push(`  ${JSON.stringify(file.filePath)}: nodes ${file.beforeCount} -> ${file.afterCount}; symbols ${file.beforeSymbolCount} -> ${file.afterSymbolCount}`);
    for (const node of file.missing) lines.push(`    ${node.status}: ${JSON.stringify(node.id)} (${JSON.stringify(node.name)}) — ${node.reason}`);
  }
  lines.push(...report.errors.map(error => `  Error: ${error}`));
  if (report.reconciledCurrentEdges) lines.push(`  Reconciled ${report.reconciledCurrentEdges} current edge(s)`);
  for (const edge of report.droppedCurrentEdges ?? []) {
    lines.push(`  Dropped current edge with unresolved endpoint: ${JSON.stringify(edge)}`);
  }
  lines.push(report.ok ? 'Symbol validation passed' : 'Symbol validation blocked publication; baseline not advanced');
  return lines.join('\n');
}

const isCli = process.argv[1] && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isCli) {
  if (process.argv.length !== 3) {
    process.stderr.write('Usage: node validate-incremental-symbols.mjs <projectRoot>\n');
    process.exitCode = 1;
  } else {
    try {
      const report = await validateIncrementalSymbols(realpathSync(process.argv[2]));
      process.stderr.write(`${formatSymbolReport(report)}\n`);
      process.exitCode = report.ok ? 0 : 1;
    } catch (error) {
      process.stderr.write(`Symbol validation failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
