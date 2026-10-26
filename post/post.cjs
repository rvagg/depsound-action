'use strict';

const path = require('path');

const marker = '<!-- depsound -->';
const maxBytes = 60000;

const posixQuote = value => `'${String(value).replace(/'/g, "'\"'\"'")}'`;
const normalizeVersion = value => typeof value === 'string' ? value.replace(/^v/, '') : '';
const titleMarker = title => `<!-- depsound-title: ${Array.from(String(title).replace(/--/g, '- -')).slice(0, 512).join('')} -->`;

function readJSON(fs, file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function incompleteBody(reason) {
  return `**depsound** · analysis incomplete\n\n${reason} Do not treat this incomplete run as approval. Inspect the retained artifact and run logs before deciding.\n`;
}

function boundedBody(body, title, artifact) {
  if (Buffer.byteLength(body, 'utf8') <= maxBytes) return body;
  const route = artifact ? `<a href="${artifact}">retained artifact</a>` : 'retained artifact';
  return `${titleMarker(title || 'depsound: report omitted')}\n\n**depsound** · report omitted from this comment\n\nCoverage boundary: the rendered report exceeds the comment limit. Inspect the ${route} for the full report, coverage boundary, and evidence.\n\n${marker}`;
}

function validatePacket(packet, version) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return 'review input is not an object';
  if (packet.schema !== 1) return 'review input schema is unsupported';
  if (normalizeVersion(packet.toolVersion) !== normalizeVersion(version)) return 'review input tool version does not match the selected analyzer';
  if (packet.omitted !== undefined && (!Array.isArray(packet.omitted) || packet.omitted.some(item =>
    !item || typeof item.ref !== 'string' || typeof item.reason !== 'string'))) return 'review input omissions are malformed';
  if (packet.mode === 'evidence') return null;
  if (packet.mode !== 'bulk') return 'review input mode is unsupported';
  if (!Array.isArray(packet.items) || packet.items.length === 0) return 'review input bulk items are malformed';
  for (const item of packet.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'review input bulk item is malformed';
    for (const key of ['ecosystem', 'name', 'from', 'to', 'redirect']) {
      if (item[key] !== undefined && typeof item[key] !== 'string') return 'review input bulk item is malformed';
    }
    if (item.lockChange !== undefined) {
      const change = item.lockChange;
      if (!change || typeof change !== 'object' || Array.isArray(change)) return 'review input lock change is malformed';
      for (const key of ['ecosystem', 'name', 'kind', 'version', 'fromVersion', 'toVersion']) {
        if (change[key] !== undefined && typeof change[key] !== 'string') return 'review input lock change is malformed';
      }
      if (change.credentialsChanged !== undefined && typeof change.credentialsChanged !== 'boolean') return 'review input lock change is malformed';
      if (change.toRegistry !== undefined && (typeof change.toRegistry !== 'boolean' || change.toRegistry && change.kind !== 'version')) return 'review input registry target is malformed';
      for (const key of ['from', 'to', 'files']) {
        if (change[key] !== undefined && !Array.isArray(change[key])) return 'review input lock change is malformed';
      }
      const present = value => typeof value === 'string' && value.length > 0;
      const sources = value => Array.isArray(value) && value.length > 0 && value.every(source =>
        source && typeof source === 'object' && !Array.isArray(source) &&
        ['location', 'resolved', 'host', 'integrity'].every(key => source[key] === undefined || typeof source[key] === 'string') &&
        (source.credentialsPresent === undefined || typeof source.credentialsPresent === 'boolean'));
      if (!present(change.ecosystem) || !present(change.name)) return 'review input lock change needs an ecosystem and package name';
      switch (change.kind || 'source') {
        case 'source':
          if (!present(change.version) || !sources(change.from) || !sources(change.to)) return 'review input source change is incomplete';
          break;
        case 'version':
          if (!present(change.fromVersion) || !present(change.toVersion) || !sources(change.from) || !sources(change.to)) return 'review input version change is incomplete';
          break;
        case 'added':
          if (!present(change.toVersion) || !sources(change.to)) return 'review input addition is incomplete';
          break;
        case 'removed':
          if (!present(change.fromVersion) || !sources(change.from)) return 'review input removal is incomplete';
          break;
        default: return 'review input lock change kind is unsupported';
      }
    } else if (!item.ecosystem || !item.name || (!item.to && !item.redirect)) {
      return 'review input needs a package version or a source declaration';
    }
  }
  return null;
}

function replayFooter(fs, reportDir, meta) {
  const packetPath = path.join(reportDir, 'review-input.json');
  if (!fs.existsSync(packetPath)) {
    return 'This depsound version did not save rerun instructions. Download the artifact to read the report and files collected during the review.';
  }
  let packet;
  try {
    packet = readJSON(fs, packetPath);
  } catch (_) {
    return { error: 'review input is malformed' };
  }
  const invalid = validatePacket(packet, meta.version);
  if (invalid) return { error: invalid };
  if (packet.mode === 'evidence') {
    return 'Download the artifact and inspect the saved report and files for these findings.';
  }
  const packageArg = `github.com/rvagg/depsound/cmd/depsound@${meta.version}`;
  const command = ['go', 'run', packageArg, 'bulk', '--file=review-input.json'].map(posixQuote).join(' ');
  const escaped = command.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const partial = packet.omitted && packet.omitted.length
    ? `This command repeats collection for ${packet.items.length} input${packet.items.length === 1 ? '' : 's'}. Read the saved report for the other ${packet.omitted.length} finding${packet.omitted.length === 1 ? '' : 's'}. `
    : '';
  return `${partial}Download the artifact, then run:<blockquote><pre>${escaped}</pre></blockquote>This command builds depsound from source through the Go module proxy. The Action uses a prebuilt <a href="https://github.com/rvagg/depsound/releases">release binary</a>, checked against its attestation or the caller's checksum.`;
}

async function writeCheck(github, owner, repo, head, title) {
  const { data } = await github.rest.checks.listForRef({ owner, repo, ref: head, check_name: 'depsound' });
  const params = {
    owner, repo, name: 'depsound', head_sha: head, status: 'completed', conclusion: 'neutral',
    output: { title, summary: title },
  };
  const existing = data.check_runs && data.check_runs[0];
  if (existing) await github.rest.checks.update({ ...params, check_run_id: existing.id });
  else await github.rest.checks.create(params);
}

async function postReport({ fs, github, context, core, reportDir = 'report' }) {
  const { owner, repo } = context.repo;
  const pull = context.payload.pull_request;
  if (!pull) {
    core.setFailed('depsound post incomplete: workflow_run posting is unsupported without a trusted pull request identity.');
    return;
  }
  const pr = pull.number;
  const head = pull.head && pull.head.sha;
  if (!pr || !head) {
    core.setFailed('depsound post incomplete: trusted pull request identity is missing.');
    return;
  }

  let meta;
  let state = 'incomplete';
  let reason = 'The report artifact or its status envelope is missing or malformed.';
  try {
    meta = readJSON(fs, path.join(reportDir, 'meta.json'));
    if (!meta || typeof meta !== 'object' || !['no-changes', 'complete', 'incomplete'].includes(meta.state)) throw new Error('invalid state');
    state = meta.state;
    if (meta.headSha !== head) {
      state = 'incomplete';
      reason = 'The saved report describes a different pull request head.';
    }
  } catch (_) {
    meta = { title: 'depsound: analysis incomplete' };
  }
  const noChanges = state === 'no-changes';
  if (state === 'complete' && (typeof meta.version !== 'string' || !normalizeVersion(meta.version))) {
    state = 'incomplete';
    reason = 'The report metadata is missing the depsound version used for this run.';
  }

  let title = typeof meta.title === 'string' ? meta.title : 'depsound: analysis incomplete';
  let body;
  if (noChanges) {
    title = 'depsound: no dependency changes';
    body = '**depsound** · no dependency changes detected at this PR head.\n\nOnly configured manifests were compared; inspect the PR diff for other changes.';
  }
  if (state === 'complete') {
    try {
      body = fs.readFileSync(path.join(reportDir, 'comment.md'), 'utf8');
      if (!body.trim()) throw new Error('empty rendered report');
    } catch (_) {
      state = 'incomplete';
      title = 'depsound: analysis incomplete';
      reason = 'The rendered report is missing or unreadable.';
    }
  }
  if (state === 'incomplete') {
    title = 'depsound: analysis incomplete';
    body = incompleteBody(reason);
  }

  let replay = null;
  if (state === 'complete') {
    replay = replayFooter(fs, reportDir, meta);
    if (typeof replay === 'object') {
      state = 'incomplete';
      title = 'depsound: analysis incomplete';
      body = incompleteBody(`The retained review input cannot be replayed because ${replay.error}.`);
    }
  }
  if (!body.includes('<!-- depsound-title:')) body = `${titleMarker(title)}\n\n${body}`;
  const artifact = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const skill = 'https://github.com/rvagg/depsound/blob/master/skills/review-dependency-change/SKILL.md';
  const footer = state === 'complete'
    ? `${replay}\n\nOr hand this PR to an agent with the <a href="${skill}">review skill</a>.\n\n<sub><a href="https://github.com/rvagg/depsound">depsound</a> · <a href="${artifact}">retained report and evidence</a></sub>`
    : `<sub><a href="https://github.com/rvagg/depsound">depsound</a> · <a href="${artifact}">run logs and retained artifact</a></sub>`;
  const combined = body.includes(marker) ? body.replace(marker, `\n\n${footer}\n${marker}`) : `${body}\n\n${footer}\n${marker}`;
  const finalBody = boundedBody(combined, title, artifact);

  const failures = [];
  try {
    await writeCheck(github, owner, repo, head, title);
  } catch (error) {
    failures.push(`check: ${error.message}`);
    core.warning(`depsound check write failed: ${error.message}`);
  }
  try {
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr, per_page: 100 });
    const existing = comments.find(comment => comment.body && comment.body.includes(marker) && comment.body.includes('<!-- depsound-title:') && comment.user && comment.user.type === 'Bot');
    // Check after pagination, immediately before the shared comment write.
    const current = await github.rest.pulls.get({ owner, repo, pull_number: pr });
    if (!current.data.head || current.data.head.sha !== head) {
      core.warning('depsound comment skipped because this report is for an older PR head.');
    } else {
      if (existing) await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: finalBody });
      else await github.rest.issues.createComment({ owner, repo, issue_number: pr, body: finalBody });
    }
  } catch (error) {
    failures.push(`comment: ${error.message}`);
    core.warning(`depsound comment write failed: ${error.message}`);
  }
  if (failures.length) core.setFailed(`depsound post incomplete after retries (${failures.join('; ')}); re-run this job to retry.`);
}

module.exports = { postReport, posixQuote, validatePacket, boundedBody };
