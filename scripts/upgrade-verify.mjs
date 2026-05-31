#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE_VERSION = 'v1';
const DEFAULT_EVENT_SCHEMA_VERSION = 'v1';
const DEFAULT_NETWORK = 'testnet';
const DEFAULT_POOL_SAMPLE_LIMIT = 5;

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

function run(command, args, options = {}) {
  const completed = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

  if (completed.error) {
    throw completed.error;
  }

  if (completed.status !== 0) {
    const stderr = (completed.stderr || '').trim();
    const stdout = (completed.stdout || '').trim();
    throw new Error(
      [
        `exit code ${completed.status}`,
        stderr ? `stderr:\n${stderr}` : '',
        stdout ? `stdout:\n${stdout}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  return (completed.stdout || '').trim();
}

function tryParseJson(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = normalizeValue(value[key]);
    }
    return sorted;
  }

  return value;
}

function deepDiff(before, after, basePath = '') {
  const diffs = [];

  if (Array.isArray(before) && Array.isArray(after)) {
    const max = Math.max(before.length, after.length);
    for (let i = 0; i < max; i += 1) {
      const nextPath = `${basePath}[${i}]`;
      if (i >= before.length) {
        diffs.push({ path: nextPath, before: undefined, after: after[i] });
      } else if (i >= after.length) {
        diffs.push({ path: nextPath, before: before[i], after: undefined });
      } else {
        diffs.push(...deepDiff(before[i], after[i], nextPath));
      }
    }
    return diffs;
  }

  const beforeObject = before && typeof before === 'object' && !Array.isArray(before);
  const afterObject = after && typeof after === 'object' && !Array.isArray(after);
  if (beforeObject && afterObject) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of Array.from(keys).sort()) {
      const nextPath = basePath ? `${basePath}.${key}` : key;
      if (!(key in before)) {
        diffs.push({ path: nextPath, before: undefined, after: after[key] });
      } else if (!(key in after)) {
        diffs.push({ path: nextPath, before: before[key], after: undefined });
      } else {
        diffs.push(...deepDiff(before[key], after[key], nextPath));
      }
    }
    return diffs;
  }

  if (JSON.stringify(before) !== JSON.stringify(after)) {
    diffs.push({ path: basePath || '(root)', before, after });
  }

  return diffs;
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function extractContractId(output, fallbackLabel) {
  const parsed = tryParseJson(output);
  if (typeof parsed === 'string' && /^C[A-Z0-9]{10,}$/i.test(parsed)) {
    return parsed;
  }

  if (parsed && typeof parsed === 'object') {
    const possibleKeys = ['contract_id', 'contractId', 'id'];
    for (const key of possibleKeys) {
      if (typeof parsed[key] === 'string' && /^C[A-Z0-9]{10,}$/i.test(parsed[key])) {
        return parsed[key];
      }
    }
  }

  const match = output.match(/(C[A-Z0-9]{20,})/);
  if (match) {
    return match[1];
  }

  fail(`could not determine the deployed contract ID from ${fallbackLabel}`);
}

function extractWasmHash(output) {
  const parsed = tryParseJson(output);
  if (parsed && typeof parsed === 'object') {
    for (const key of ['wasm_hash', 'wasmHash', 'hash']) {
      if (typeof parsed[key] === 'string' && parsed[key].length > 0) {
        return parsed[key];
      }
    }
  }

  const match = output.match(/\b([a-f0-9]{64})\b/i);
  return match ? match[1] : '';
}

function contractInvoke(contractId, sourceAccount, network, fn, fnArgs = []) {
  const stdout = run('stellar', [
    'contract',
    'invoke',
    '--id',
    contractId,
    '--source-account',
    sourceAccount,
    '--network',
    network,
    '--output',
    'json',
    '--',
    fn,
    ...fnArgs,
  ]);
  return tryParseJson(stdout);
}

function readMaybe(contractId, sourceAccount, network, fn, fnArgs = []) {
  try {
    return contractInvoke(contractId, sourceAccount, network, fn, fnArgs);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function captureSnapshot({ contractId, sourceAccount, network, samplePools, includeInterface = false }) {
  const config = contractInvoke(contractId, sourceAccount, network, 'get_config');
  const metrics = {
    pool_count: contractInvoke(contractId, sourceAccount, network, 'get_pool_count'),
    treasury_balance: contractInvoke(contractId, sourceAccount, network, 'get_treasury_balance'),
    withdrawable_treasury: contractInvoke(contractId, sourceAccount, network, 'get_withdrawable_treasury'),
    total_contract_volume: contractInvoke(contractId, sourceAccount, network, 'get_total_contract_volume'),
    paused: contractInvoke(contractId, sourceAccount, network, 'is_paused'),
  };

  const scheduled = {
    pools: contractInvoke(contractId, sourceAccount, network, 'get_scheduled_pools', ['1', String(samplePools)]),
    claims: contractInvoke(contractId, sourceAccount, network, 'get_scheduled_claims', ['1', String(samplePools)]),
  };

  const poolCount = Number(metrics.pool_count);
  const pools = [];
  if (Number.isFinite(poolCount) && poolCount > 1) {
    for (let poolId = 1; poolId < poolCount && pools.length < samplePools; poolId += 1) {
      const pool = readMaybe(contractId, sourceAccount, network, 'get_pool', [String(poolId)]);
      pools.push({
        pool_id: poolId,
        pool,
        metadata: readMaybe(contractId, sourceAccount, network, 'get_pool_metadata', [String(poolId)]),
        outcomes: readMaybe(contractId, sourceAccount, network, 'get_pool_outcomes', [String(poolId)]),
        bet_limits: readMaybe(contractId, sourceAccount, network, 'get_pool_bet_limits', [String(poolId)]),
        participant_count: readMaybe(contractId, sourceAccount, network, 'get_participant_count', [String(poolId)]),
        volume: readMaybe(contractId, sourceAccount, network, 'get_pool_volume', [String(poolId)]),
        payout_state: readMaybe(contractId, sourceAccount, network, 'get_pool_payout_state', [String(poolId)]),
        settlement_source: readMaybe(contractId, sourceAccount, network, 'get_settlement_source', [String(poolId)]),
        delegated_settler: readMaybe(contractId, sourceAccount, network, 'get_delegated_settler', [String(poolId)]),
      });
    }
  }

  const snapshot = {
    contract_id: contractId,
    network,
    captured_at: new Date().toISOString(),
    config: normalizeValue(config),
    metrics: normalizeValue(metrics),
    scheduled: normalizeValue(scheduled),
    pools: normalizeValue(pools),
  };

  if (includeInterface) {
    snapshot.interface = normalizeValue(readMaybe(contractId, sourceAccount, network, 'get_config'));
  }

  return snapshot;
}

function validateSnapshot(snapshot, expectedStateVersion, expectedEventSchemaVersion, label) {
  const issues = collectSnapshotIssues(snapshot, expectedStateVersion, expectedEventSchemaVersion, label);
  if (issues.length > 0) {
    fail(`${label} snapshot validation failed:\n- ${issues.join('\n- ')}`);
  }
}

function validateSnapshotShape(snapshot, label) {
  const requiredConfig = [
    'token',
    'treasury_recipient',
    'creation_fee',
    'protocol_fee_bps',
    'event_schema_version',
    'contract_state_version',
  ];

  const requiredMetrics = [
    'pool_count',
    'treasury_balance',
    'withdrawable_treasury',
    'total_contract_volume',
    'paused',
  ];

  const requiredTopLevel = ['config', 'metrics', 'scheduled', 'pools'];
  for (const key of requiredTopLevel) {
    if (!(key in snapshot)) {
      fail(`${label} snapshot is missing top-level key "${key}"`);
    }
  }

  for (const key of requiredConfig) {
    if (!(key in snapshot.config)) {
      fail(`${label} snapshot config is missing "${key}"`);
    }
  }

  for (const key of requiredMetrics) {
    if (!(key in snapshot.metrics)) {
      fail(`${label} snapshot metrics is missing "${key}"`);
    }
  }

  if (!snapshot.scheduled || typeof snapshot.scheduled !== 'object') {
    fail(`${label} snapshot scheduled state is malformed`);
  }

  for (const key of ['pools', 'claims']) {
    if (!(key in snapshot.scheduled)) {
      fail(`${label} snapshot scheduled state is missing "${key}"`);
    }
    const scheduledValue = snapshot.scheduled[key];
    if (scheduledValue && typeof scheduledValue === 'object' && 'error' in scheduledValue) {
      fail(`${label} snapshot scheduled state failed to read "${key}": ${scheduledValue.error}`);
    }
  }

  if (!Array.isArray(snapshot.pools)) {
    fail(`${label} snapshot pools must be an array`);
  }

  const requiredPoolKeys = [
    'pool_id',
    'pool',
    'metadata',
    'outcomes',
    'bet_limits',
    'participant_count',
    'volume',
    'payout_state',
    'settlement_source',
    'delegated_settler',
  ];

  for (const [index, pool] of snapshot.pools.entries()) {
    if (!pool || typeof pool !== 'object') {
      fail(`${label} snapshot pool ${index} is malformed`);
    }

    for (const key of requiredPoolKeys) {
      if (!(key in pool)) {
        fail(`${label} snapshot pool ${index} is missing "${key}"`);
      }
    }

    for (const key of ['pool', 'metadata', 'outcomes', 'bet_limits', 'participant_count', 'volume', 'payout_state', 'settlement_source', 'delegated_settler']) {
      const value = pool[key];
      if (value && typeof value === 'object' && 'error' in value) {
        fail(`${label} snapshot pool ${pool.pool_id} failed to read "${key}": ${value.error}`);
      }
    }
  }
}

function collectSnapshotIssues(snapshot, expectedStateVersion, expectedEventSchemaVersion, label) {
  const issues = [];

  try {
    validateSnapshotShape(snapshot, label);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return issues;
  }

  if (snapshot.config.contract_state_version !== expectedStateVersion) {
    issues.push(
      `contract_state_version mismatch: expected ${expectedStateVersion}, got ${snapshot.config.contract_state_version}`,
    );
  }

  if (snapshot.config.event_schema_version !== expectedEventSchemaVersion) {
    issues.push(
      `event_schema_version mismatch: expected ${expectedEventSchemaVersion}, got ${snapshot.config.event_schema_version}`,
    );
  }

  return issues;
}

function renderReport({
  preSnapshot,
  postSnapshot,
  deployResult,
  migrationResult,
  validationIssues,
  diffReport,
  contractId,
  stateVersion,
  reportPath,
}) {
  const lines = [
    '# Upgrade Verification Report',
    '',
    `- Contract ID: \`${contractId}\``,
    `- Expected state version: \`${stateVersion}\``,
    `- Pre snapshot captured: ${preSnapshot.captured_at}`,
    `- Post snapshot captured: ${postSnapshot.captured_at}`,
    '',
    '## Deployment',
    '',
    `- Deployed contract: \`${deployResult.contract_id}\``,
    `- Deploy transaction: \`${deployResult.tx_hash || 'n/a'}\``,
    `- WASM hash: \`${deployResult.wasm_hash || 'n/a'}\``,
    '',
    '## Migration',
    '',
    migrationResult
      ? `- Migration command: \`${migrationResult.command}\``
      : '- Migration command: not provided',
    migrationResult
      ? `- Migration status: ${migrationResult.status}`
      : '- Migration status: skipped',
    '',
    '## State Diff',
    '',
  ];

  if (diffReport.length === 0) {
    lines.push('- No unexpected state changes detected.');
  } else {
    for (const diff of diffReport) {
      lines.push(`- \`${diff.path}\``);
      lines.push(`  - before: ${pretty(diff.before)}`);
      lines.push(`  - after: ${pretty(diff.after)}`);
    }
  }

  if (validationIssues.length > 0) {
    lines.push('', '## Validation Issues', '');
    for (const issue of validationIssues) {
      lines.push(`- ${issue}`);
    }
  }

  lines.push(
    '',
    '## Rollback Instructions',
    '',
    '1. Re-deploy the previously known good WASM or restore the last stable contract ID.',
    '2. If a migration command mutated on-chain data, run the inverse migration against the pre-upgrade snapshot before re-opening traffic.',
    '3. Keep the failed verification report attached to the release notes for incident review.',
    '',
    '## Snapshot Summary',
    '',
    `- Pools sampled: ${postSnapshot.pools.length}`,
    `- Contract state version: ${postSnapshot.config.contract_state_version}`,
    `- Event schema version: ${postSnapshot.config.event_schema_version}`,
    '',
  );

  if (migrationResult && migrationResult.status !== 'success') {
    lines.push(
      '## Migration Failure Details',
      '',
      `- Exit code: ${migrationResult.exit_code}`,
      migrationResult.error ? `- Error: ${migrationResult.error}` : '- Error: n/a',
      migrationResult.stderr ? `- Stderr: ${migrationResult.stderr}` : '- Stderr: n/a',
      '',
    );
  }

  writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const network = args.network || DEFAULT_NETWORK;
  const sourceAccount = args.sourceAccount || args.source || '';
  const wasmPath = args.wasm || args.wasmPath || '';
  const reportDir = path.resolve(args.reportDir || 'upgrade-verification-report');
  const samplePools = Number(args.samplePools || DEFAULT_POOL_SAMPLE_LIMIT);
  const expectedStateVersion = args.expectedStateVersion || DEFAULT_STATE_VERSION;
  const expectedEventSchemaVersion = args.expectedEventSchemaVersion || DEFAULT_EVENT_SCHEMA_VERSION;
  const migrationCommand = args.migrationCommand || '';

  if (!sourceAccount) {
    fail('missing required --source-account');
  }

  if (!wasmPath) {
    fail('missing required --wasm');
  }

  mkdirSync(reportDir, { recursive: true });

  const preContractId = args.oldContractId || args.contractId || '';
  if (!preContractId) {
    fail('missing required --old-contract-id');
  }

  const preSnapshot = captureSnapshot({
    contractId: preContractId,
    sourceAccount,
    network,
    samplePools,
  });
  validateSnapshotShape(preSnapshot, 'pre-upgrade');

  const deployArgs = [
    'contract',
    'deploy',
    '--wasm',
    wasmPath,
    '--source-account',
    sourceAccount,
    '--network',
    network,
    '--output',
    'json',
  ];
  const deployStdout = run('stellar', deployArgs);
  const deployContractId = extractContractId(deployStdout, 'stellar contract deploy output');
  const deployWasmHash = extractWasmHash(deployStdout);
  const deployTxHash = (() => {
    const parsed = tryParseJson(deployStdout);
    if (parsed && typeof parsed === 'object') {
      for (const key of ['transaction_hash', 'tx_hash', 'transactionHash']) {
        if (typeof parsed[key] === 'string') {
          return parsed[key];
        }
      }
    }
    return '';
  })();

  let migrationResult = null;
  if (migrationCommand) {
    const env = {
      ...process.env,
      UPGRADE_VERIFY_OLD_CONTRACT_ID: preContractId,
      UPGRADE_VERIFY_NEW_CONTRACT_ID: deployContractId,
      UPGRADE_VERIFY_WASM_HASH: deployWasmHash,
      UPGRADE_VERIFY_NETWORK: network,
      UPGRADE_VERIFY_EXPECTED_STATE_VERSION: expectedStateVersion,
      UPGRADE_VERIFY_EXPECTED_EVENT_SCHEMA_VERSION: expectedEventSchemaVersion,
    };

    const completed = spawnSync('bash', ['-lc', migrationCommand], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    migrationResult = {
      command: migrationCommand,
      status: completed.status === 0 && !completed.error ? 'success' : 'failed',
      exit_code: completed.status,
      error: completed.error ? (completed.error instanceof Error ? completed.error.message : String(completed.error)) : '',
      stdout: (completed.stdout || '').trim(),
      stderr: (completed.stderr || '').trim(),
    };
  }

  const postSnapshot = captureSnapshot({
    contractId: deployContractId,
    sourceAccount,
    network,
    samplePools,
  });
  const validationIssues = collectSnapshotIssues(
    postSnapshot,
    expectedStateVersion,
    expectedEventSchemaVersion,
    'post-upgrade',
  );

  const comparableBefore = {
    config: preSnapshot.config,
    metrics: preSnapshot.metrics,
    scheduled: preSnapshot.scheduled,
    pools: preSnapshot.pools,
  };
  const comparableAfter = {
    config: postSnapshot.config,
    metrics: postSnapshot.metrics,
    scheduled: postSnapshot.scheduled,
    pools: postSnapshot.pools,
  };

  const diffReport = deepDiff(normalizeValue(comparableBefore), normalizeValue(comparableAfter)).filter(
    (entry) => entry.path !== 'config.contract_state_version' && entry.path !== 'config.event_schema_version',
  );

  const jsonReport = {
    contract_id: preContractId,
    deployed_contract_id: deployContractId,
    expected_state_version: expectedStateVersion,
    expected_event_schema_version: expectedEventSchemaVersion,
    deploy: {
      transaction_hash: deployTxHash,
      wasm_hash: deployWasmHash,
      stdout: deployStdout,
    },
    migration: migrationResult,
    pre_snapshot: preSnapshot,
    post_snapshot: postSnapshot,
    validation_issues: validationIssues,
    diff: diffReport,
    rollback_instructions: [
      'Re-deploy the last known good WASM or restore the prior contract ID.',
      'If migration changed state, run the inverse migration against the pre-upgrade snapshot.',
      'Do not promote the release until the diff report is empty or explicitly acknowledged.',
    ],
  };

  const jsonPath = path.join(reportDir, 'upgrade-verify-report.json');
  const mdPath = path.join(reportDir, 'upgrade-verify-report.md');
  writeFileSync(jsonPath, `${pretty(jsonReport)}\n`, 'utf8');
  renderReport({
    preSnapshot,
    postSnapshot,
    deployResult: {
      contract_id: deployContractId,
      tx_hash: deployTxHash,
      wasm_hash: deployWasmHash,
    },
    migrationResult,
    validationIssues,
    diffReport,
    contractId: preContractId,
    stateVersion: expectedStateVersion,
    reportPath: mdPath,
  });

  console.log(`upgrade verification completed`);
  console.log(`report: ${mdPath}`);
  console.log(`json: ${jsonPath}`);

  if ((migrationResult && migrationResult.status !== 'success') || validationIssues.length > 0 || diffReport.length > 0) {
    console.error(
      `upgrade verification failed: ${(migrationResult && migrationResult.status !== 'success') ? 1 : 0} migration failures, ${validationIssues.length} validation issues, ${diffReport.length} unexpected diffs`,
    );
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
