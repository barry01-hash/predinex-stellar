#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (typeof next === 'undefined' || next.startsWith('--')) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    i += 1;
  }
  return result;
}

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`failed to read or parse report at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function toNumber(value) {
  return typeof value === 'number' ? value : Number(value || 0);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function advisoryScore(entry) {
  const scoreCandidates = [
    entry?.advisory?.cvss?.score,
    entry?.cvss?.score,
    entry?.severityScore,
  ];
  for (const candidate of scoreCandidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

function advisorySeverity(entry) {
  const severityCandidates = [
    entry?.advisory?.severity,
    entry?.severity,
  ];
  for (const candidate of severityCandidates) {
    if (typeof candidate === 'string') {
      return candidate.toLowerCase();
    }
  }
  return '';
}

function collectCargoAdvisories(data) {
  const list = data?.vulnerabilities?.list;
  if (Array.isArray(list)) {
    return list.filter(isObject);
  }

  const advisories = [];
  const seen = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }

    if (!isObject(node) || seen.has(node)) {
      return;
    }
    seen.add(node);

    if (isObject(node.advisory) || typeof node.severity === 'string' || isObject(node.cvss)) {
      advisories.push(node);
    }

    for (const value of Object.values(node)) {
      walk(value);
    }
  };

  walk(data);
  return advisories;
}

function checkNpm(data, auditOutcome) {
  const metadata = data?.metadata?.vulnerabilities || {};
  const total = toNumber(metadata.total);
  const critical = toNumber(metadata.critical);

  if (critical > 0) {
    return { total, critical, shouldFail: true, reason: `${critical} critical npm vulnerabilities detected` };
  }

  if (auditOutcome !== 'success') {
    return { total, critical, shouldFail: true, reason: 'npm audit command failed before it could complete cleanly' };
  }

  return { total, critical, shouldFail: false, reason: '' };
}

function checkCargo(data, auditOutcome) {
  const advisories = collectCargoAdvisories(data);
  const total = advisories.length;
  const critical = advisories.filter((entry) => {
    const score = advisoryScore(entry);
    if (score !== null && score >= 9) {
      return true;
    }
    return advisorySeverity(entry) === 'critical';
  }).length;

  if (critical > 0) {
    return { total, critical, shouldFail: true, reason: `${critical} critical RustSec advisories detected` };
  }

  if (auditOutcome !== 'success' && total === 0) {
    return { total, critical, shouldFail: true, reason: 'cargo audit failed before producing a usable vulnerability report' };
  }

  return { total, critical, shouldFail: false, reason: '' };
}

function writeSummary(summaryPath, lines) {
  if (!summaryPath) {
    return;
  }
  writeFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tool = String(args.tool || '').toLowerCase();
  const reportPath = args.report;
  const auditOutcome = String(args.auditOutcome || 'success').toLowerCase();
  const summaryPath = args.summaryPath || '';

  if (!tool) {
    fail('missing required --tool');
  }
  if (!reportPath) {
    fail('missing required --report');
  }

  const data = readJson(reportPath);
  const result = tool === 'npm' ? checkNpm(data, auditOutcome) : tool === 'cargo' ? checkCargo(data, auditOutcome) : null;

  if (!result) {
    fail(`unsupported tool "${tool}"`);
  }

  const summary = [
    `### ${tool} audit`,
    '',
    `- Report: \`${reportPath}\``,
    `- Audit command outcome: \`${auditOutcome}\``,
    `- Total vulnerabilities: \`${result.total}\``,
    `- Critical vulnerabilities: \`${result.critical}\``,
    `- Decision: ${result.shouldFail ? '**block**' : '**pass**'}`,
  ];
  if (result.shouldFail) {
    summary.push(`- Reason: ${result.reason}`);
  }
  writeSummary(summaryPath, summary);

  if (result.shouldFail) {
    fail(result.reason);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
