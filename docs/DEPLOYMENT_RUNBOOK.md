# Predinex Deployment Runbook

## Testnet Section

### Stellar Contract Build
Compile the contract to WASM:
```bash
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/predinex.wasm
```

### Stellar Contract Deploy
Deploy the optimized WASM to Testnet:
```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/predinex.optimized.wasm \
  --source admin \
  --network testnet
```

### Stellar Contract Invoke
Initialize the contract:
```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source admin \
  --network testnet \
  -- initialize --admin <ADMIN_ADDRESS>
```

## Verification

### Contract ID Validation
Verify that the `CONTRACT_ID` matches the output of the deploy command.

### SAC Validation
Ensure the Stellar Asset Contract (SAC) for the underlying token (e.g. USDC) is correctly wired in the contract state.

### Frontend Config Verification
Verify that `NEXT_PUBLIC_SOROBAN_CONTRACT_ID` and `NEXT_PUBLIC_NETWORK` in `web/.env.local` or Vercel match the newly deployed contract.

### Pre-release upgrade verification

Before promoting a contract release, run the manual
[`upgrade-verify.yml`](../.github/workflows/upgrade-verify.yml) workflow and
review the generated report. The workflow captures a pre-upgrade snapshot,
deploys the candidate WASM on testnet, runs the migration step if one is
provided, and compares the post-upgrade state against the expected schema.

For the expected snapshot shape and rollback instructions, see
[`docs/UPGRADE_VERIFICATION.md`](./UPGRADE_VERIFICATION.md).

## Mainnet Checklist

- [ ] **Backup keys**: Ensure all admin and deployer private keys are securely backed up in a hardware wallet or secure vault.
- [ ] **Multi-sig**: Configure multi-signature for the admin account to prevent single point of failure.
- [ ] **Dry-run on testnet**: Re-run the exact mainnet configuration and migration on testnet first.
- [ ] **Monitoring enabled**: Verify that error tracking (Sentry) and RPC monitoring (ValidationCloud) are active and alerting correctly.

## Rollback Section

### Contract Rollback
If a critical flaw is found immediately post-deploy, deploy the previous WASM hash using the contract upgrade function (if supported), or instruct users to withdraw using emergency methods.

If the pre-release upgrade verification report shows unexpected state changes,
do not promote the release. Re-run the workflow against the last known good
WASM, attach the diff report to the incident record, and verify the rollback
plan before trying again.

### Frontend Rollback
Revert the Vercel deployment to the last known stable commit.
```bash
vercel rollback <DEPLOYMENT_URL>
```

### Emergency Freeze Procedure
If funds are at risk, invoke the freeze entrypoint:
```bash
stellar contract invoke --id <CONTRACT_ID> --source freeze_admin --network mainnet -- freeze_pool --pool_id <ID>
```
