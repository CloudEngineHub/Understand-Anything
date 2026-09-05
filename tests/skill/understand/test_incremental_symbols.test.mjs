import { beforeAll, describe, expect, it } from 'vitest';
import { TreeSitterPlugin } from '../../../understand-anything-plugin/packages/core/dist/index.js';
import { compareFileSymbols } from '../../../understand-anything-plugin/skills/understand/validate-incremental-symbols.mjs';

let parser;
beforeAll(async () => {
  parser = new TreeSitterPlugin();
  await parser.init();
});

const node = (name, extra = {}) => ({
  id: `function:src/a.ts:${name}`, name, type: 'function', filePath: 'src/a.ts', ...extra,
});
const graph = nodes => ({ filePath: 'src/a.ts', nodes, edges: [] });
const parse = content => parser.analyzeFileStrict('src/a.ts', content);
const compare = (oldNodes, newNodes, oldSource, newSource) => compareFileSymbols(
  graph(oldNodes), graph(newNodes), parse(oldSource), parse(newSource),
);

describe('incremental symbol matching', () => {
  it('detects an omitted old method even when total node counts stay the same', () => {
    const result = compare([node('A.keep'), node('A.lost')], [node('A.keep'), node('A.added')],
      'class A { keep() {} lost() {} }', 'class A { keep() {} lost() {} added() {} }');
    expect(result.beforeCount).toBe(result.afterCount);
    expect(result.missing).toEqual([expect.objectContaining({ name: 'A.lost', status: 'still-present' })]);
  });

  it('accepts spelling changes and moved lines for a uniquely identified method', () => {
    const result = compare([node('A.run', { lineRange: [2, 2] })],
      [node('run', { id: 'func:src/a.ts:A::run', lineRange: [6, 6] })],
      'class A {\n run() {}\n}', '\n\n\n\nclass A {\n run() {}\n}');
    expect(result.missing).toEqual([]);
    expect(result.replacements).toEqual([{ oldId: 'function:src/a.ts:A.run', newId: 'func:src/a.ts:A::run' }]);
  });

  it('does not substitute a different class with the same method name', () => {
    const code = 'class A { run() {} }\nclass B { run() {} }';
    const result = compare([node('A.run'), node('B.run')], [node('B.run')], code, code);
    expect(result.missing).toEqual([expect.objectContaining({ name: 'A.run', status: 'still-present' })]);
    expect(compare([node('run')], [], code, code).missing[0].status).toBe('unknown');
  });

  it('uses class containment when graph method names are unqualified', () => {
    const code = 'class A { run() {} }\nclass B { run() {} }';
    const previous = graph([node('A', { id: 'class:src/a.ts:A', type: 'class' }), node('run')]);
    previous.edges.push({ type: 'contains', source: 'class:src/a.ts:A', target: node('run').id });
    const result = compareFileSymbols(previous, graph([previous.nodes[0]]), parse(code), parse(code));
    expect(result.missing[0]).toMatchObject({ name: 'run', status: 'still-present' });
  });

  it('does not let an unchanged generic ID hide a changed or missing class owner', () => {
    const code = 'class A { run() {} }\nclass B { run() {} }';
    const classes = ['A', 'B'].map(name => node(name, { id: `class:src/a.ts:${name}`, type: 'class' }));
    const previous = graph([...classes, node('run')]);
    previous.edges = [{ source: classes[0].id, target: node('run').id, type: 'contains' }];
    for (const edges of [[], [{ source: classes[1].id, target: node('run').id, type: 'contains' }]]) {
      const current = { ...graph([...classes, node('run')]), edges };
      const result = compareFileSymbols(previous, current, parse(code), parse(code));
      expect(result.missing[0]).toMatchObject({ id: node('run').id, status: 'still-present' });
      expect(compareFileSymbols(previous, current, { status: 'unsupported' }, { status: 'unsupported' })
        .missing[0].status).toBe('unknown');
    }
    expect(compareFileSymbols(previous, previous).missing).toEqual([]);
    const ambiguous = graph([...classes, node('run')]);
    expect(compareFileSymbols(ambiguous, ambiguous, parse(code), parse(code)).missing[0].status).toBe('unknown');
  });

  it('accepts a top-level function sharing a name with a method when source locations establish ownership', () => {
    const code = 'function run() {}\nclass A { run() {} }';
    const nodes = [node('A', { type: 'class', id: 'class:src/a.ts:A' }), node('run', { lineRange: [1, 1] })];
    expect(compare(nodes, nodes, code, code).missing).toEqual([]);
  });

  it('verifies generic callables even when neither graph contains class nodes', () => {
    const nodes = [node('run', { lineRange: [1, 1] })];
    expect(compare(nodes, nodes, 'class A { run() {} }', 'class B { run() {} }')
      .missing[0].status).toBe('unknown');
    const opaqueIds = [node('run', { id: 'function:src/a.ts:method.run', lineRange: [1, 1] })];
    expect(compare(opaqueIds, opaqueIds, 'class A { run() {} }', 'class B { run() {} }')
      .missing[0].status).toBe('unknown');
    expect(compare(nodes, [node('run', { lineRange: [2, 2] })],
      'class A { run() {} }', 'class A { run() {} }\nclass B { run() {} }')
      .missing[0].status).toBe('still-present');
    expect(compare(nodes, nodes, 'class A { run() {} }', 'class A { run() {} added() {} }').missing).toEqual([]);
    const unknown = { status: 'unsupported' };
    expect(compareFileSymbols(graph(nodes), graph(nodes), unknown, unknown).missing[0].status).toBe('unknown');
    // Preserving identical current descriptors within one HEAD is a different
    // operation from accepting an old symbol across source revisions.
    expect(compareFileSymbols(graph(nodes), graph(nodes), unknown, unknown, true).missing).toEqual([]);
  });

  it('confirms genuine function, class, and method deletions without restoring them', () => {
    const result = compare([node('gone'), node('Old', { type: 'class' }), node('A.removed')], [],
      'function gone() {} class Old {} class A { removed() {} keep() {} }',
      'class A { keep() {} }');
    expect(result.missing.map(entry => entry.status)).toEqual(['deleted', 'deleted', 'deleted']);
  });

  it.each([
    ['parse error', 'class A {'],
    ['empty extraction', '// everything removed'],
    ['unextracted arrow method', 'class A { run = () => {}; }'],
    ['computed method', 'class A { ["run"]() {} }'],
    ['moved method', 'class B { run() {} }'],
  ])('treats %s as unknown, never deletion', (_label, code) => {
    expect(compare([node('A.run')], [], 'class A { run() {} }', code).missing[0].status).toBe('unknown');
  });

  it('requires valid baseline extraction and rejects unsupported languages', () => {
    for (const evidence of [{ status: 'unsupported' }, parse('class Broken {')]) {
      const result = compareFileSymbols(graph([node('lost')]), graph([]), evidence, parse('function keep() {}'));
      expect(result.missing[0].status).toBe('unknown');
    }
  });

  it('cannot use one new node to replace two old nodes with the same source identity', () => {
    const code = 'function f() {}';
    const result = compare([node('f', { id: 'old:one' }), node('f', { id: 'old:two' })],
      [node('f', { id: 'new:one' })], code, code);
    expect(result.missing.map(entry => entry.status)).toEqual(['unknown', 'unknown']);
  });

  it('keeps overloads ambiguous even when a qualified name is available', () => {
    const result = compare([node('A.run')], [],
      'class A { run() {} run(n: number) {} }', 'class A { keep() {} }');
    expect(result.missing[0].status).toBe('unknown');
  });
});
