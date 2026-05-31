# Upgrade Verification Workflow

This guide describes the manual pre-release upgrade safety workflow used by
`upgrade-verify.yml`.

## Purpose

The workflow is intended for Soroban contract releases that need a safety
check before they are promoted. It:

1. Captures a snapshot of the current contract state on testnet.
2. Deploys the candidate WASM to testnet.
3. Runs the configured migration command, if one is provided.
4. Captures the post-upgrade state from the deployed contract.
5. Compares the resulting state against the expected schema.
6. Writes a diff report and rollback instructions.

## Expected schema

The verification script checks the following shape:

- `config`
  - `token`
  - `treasury_recipient`
  - `creation_fee`
  - `protocol_fee_bps`
  - `event_schema_version`
  - `contract_state_version`
- `metrics`
  - `pool_count`
  - `treasury_balance`
  - `withdrawable_treasury`
  - `total_contract_volume`
  - `paused`
- `scheduled`
  - `pools`
  - `claims`
- `pools`
  - a sampled set of pool snapshots, each with:
    - `pool_id`
    - `pool`
    - `metadata`
    - `outcomes`
    - `bet_limits`
    - `participant_count`
    - `volume`
    - `payout_state`
    - `settlement_source`
    - `delegated_settler`

The current expected contract state version is `v1`, matching
[`contracts/predinex/src/lib.rs`](../contracts/predinex/src/lib.rs).

## Workflow inputs

`upgrade-verify.yml` expects:

- the pre-upgrade contract ID
- a source account secret key or named identity for testnet deployment
- the WASM path for the candidate build
- an optional migration command
- an optional pool sample size

The migration command runs with these environment variables:

- `UPGRADE_VERIFY_OLD_CONTRACT_ID`
- `UPGRADE_VERIFY_NEW_CONTRACT_ID`
- `UPGRADE_VERIFY_WASM_HASH`
- `UPGRADE_VERIFY_NETWORK`
- `UPGRADE_VERIFY_EXPECTED_STATE_VERSION`
- `UPGRADE_VERIFY_EXPECTED_EVENT_SCHEMA_VERSION`

## Rollback instructions

If verification fails:

1. Stop the release.
2. Redeploy the last known good WASM or restore the prior contract ID.
3. If the migration mutated state, run the inverse migration against the
   pre-upgrade snapshot before re-opening traffic.
4. Keep the generated `upgrade-verify-report.md` and JSON report attached to
   the release issue or PR for review.

## Testnet note

This workflow is designed to run against testnet first. That keeps the
deployment, migration, and diff generation realistic without risking mainnet
state.
