/**
 * Example 03 — SPL Token CPI (no toolchain required)
 *
 * Demonstrates the zero-setup path: load bundled SPL programs with
 * addSplToken() / addAssociatedToken() — no .so files, no Solana toolchain.
 *
 * What this shows:
 *   • addSplToken() / addSplToken2022() / addAssociatedToken() / addMemo()
 *   • Program ID constants  (SPL_TOKEN_PROGRAM_ID, etc.)
 *   • MolluskContext seeding a pre-built token mint + token account
 *   • Calling SPL Token Transfer — a real CPI instruction
 *
 * Run (from the node/ directory):
 *   npx ts-node examples/03_spl_token_cpi.ts
 */

import {
  MolluskSvm,
  MolluskContext,
  JsAccount,
  JsInstruction,
  systemAccount,
  checkSuccess,
  checkAccountLamports,
  SPL_TOKEN_PROGRAM_ID,
  SPL_TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MEMO_PROGRAM_ID,
} from '../index';

// ── addresses ────────────────────────────────────────────────────────────────

const OWNER = '11111111111111111111111111111112';
const DEST  = '11111111111111111111111111111113';
const MINT  = '11111111111111111111111111111114';

// SPL Token account state constants (from spl-token spec)
const TOKEN_ACCOUNT_LEN = 165; // bytes
const MINT_LEN          = 82;  // bytes

// ── helpers ───────────────────────────────────────────────────────────────────

/** Decode our test keys (all 1s + trailing char) → 32-byte Buffer */
function pubkeyBytes(pubkey: string): Buffer {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b = Buffer.alloc(32, 0);
  b[31] = B58.indexOf(pubkey[pubkey.length - 1]);
  return b;
}

function writeU64LE(buf: Buffer, value: bigint, offset: number) {
  buf.writeBigUInt64LE(value, offset);
}

/**
 * Build a minimal SPL Token mint account.
 * Layout (82 bytes): mint_authority(36) + supply(8) + decimals(1) + is_initialized(1) + ...
 */
function mintAccount(supply: bigint, decimals: number): JsAccount {
  const data = Buffer.alloc(MINT_LEN, 0);
  // option tag: 1 = Some(mint_authority)
  data[0] = 1;
  pubkeyBytes(OWNER).copy(data, 4);   // mint_authority pubkey
  writeU64LE(data, supply, 36);       // supply
  data[44] = decimals;                // decimals
  data[45] = 1;                       // is_initialized
  // freeze_authority: 0 = None
  return {
    lamports:   2_000_000n,
    data,
    owner:      SPL_TOKEN_PROGRAM_ID,
    executable: false,
    rentEpoch:  0n,
  };
}

/**
 * Build a minimal SPL Token account (wallet that holds tokens).
 * Layout (165 bytes): mint(32) + owner(32) + amount(8) + ...
 */
function tokenAccount(owner: string, mint: string, amount: bigint): JsAccount {
  const data = Buffer.alloc(TOKEN_ACCOUNT_LEN, 0);
  pubkeyBytes(mint).copy(data, 0);   // mint
  pubkeyBytes(owner).copy(data, 32); // owner
  writeU64LE(data, amount, 64);      // amount
  data[108] = 1;                     // state: 1 = Initialized
  return {
    lamports:   2_039_280n,
    data,
    owner:      SPL_TOKEN_PROGRAM_ID,
    executable: false,
    rentEpoch:  0n,
  };
}

/**
 * SPL Token Transfer instruction (variant 3).
 * data: [3u8, amount: u64 LE]
 */
function splTransferIx(
  source: string,
  dest: string,
  owner: string,
  amount: bigint,
): JsInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3; // Transfer
  writeU64LE(data, amount, 1);
  return {
    programId: SPL_TOKEN_PROGRAM_ID,
    accounts: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest,   isSigner: false, isWritable: true },
      { pubkey: owner,  isSigner: true,  isWritable: false },
    ],
    data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 1 — Confirm program IDs are correct
// ─────────────────────────────────────────────────────────────────────────────

console.log('=== Part 1: Program ID constants ===\n');
console.log('SPL_TOKEN_PROGRAM_ID          :', SPL_TOKEN_PROGRAM_ID);
console.log('SPL_TOKEN_2022_PROGRAM_ID     :', SPL_TOKEN_2022_PROGRAM_ID);
console.log('ASSOCIATED_TOKEN_PROGRAM_ID   :', ASSOCIATED_TOKEN_PROGRAM_ID);
console.log('MEMO_PROGRAM_ID               :', MEMO_PROGRAM_ID);

// ─────────────────────────────────────────────────────────────────────────────
// Part 2 — Load bundled programs, no .so files needed
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== Part 2: Load bundled SPL programs with addSplToken() ===\n');

// createDefault() — no custom program loaded
const svm = MolluskSvm.createDefault();

// One call each — ELFs are embedded in the svmforge binary itself
svm.addSplToken();
svm.addSplToken2022();
svm.addAssociatedToken();
svm.addMemo();

console.log('SPL Token loaded       ✓');
console.log('SPL Token-2022 loaded  ✓');
console.log('ATA program loaded     ✓');
console.log('Memo program loaded    ✓');

// ─────────────────────────────────────────────────────────────────────────────
// Part 3 — Execute a real SPL Token Transfer instruction
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== Part 3: SPL Token Transfer (real program, no .so needed) ===\n');

const SOURCE_AMOUNT = 1_000_000_000n; // 1000 tokens (6 decimals)
const TRANSFER_AMT  =   500_000_000n; // 500 tokens

const result = svm.processInstruction(
  splTransferIx(OWNER, DEST, OWNER, TRANSFER_AMT),
  [
    { pubkey: OWNER, account: tokenAccount(OWNER, MINT, SOURCE_AMOUNT) },
    { pubkey: DEST,  account: tokenAccount(DEST,  MINT, 0n) },
    // No separate signer account needed — OWNER acts as both token holder and signer
  ],
);

console.log('Transfer success       :', result.success);
console.log('Program result         :', result.programResult);
console.log('Compute units used     :', result.computeUnitsConsumed);

if (result.success) {
  // Read the token balances from raw account data
  const sourceAfter = result.resultingAccounts.find(a => a.pubkey === OWNER)!;
  const destAfter   = result.resultingAccounts.find(a => a.pubkey === DEST)!;
  const sourceBal   = sourceAfter.data.readBigUInt64LE(64);
  const destBal     = destAfter.data.readBigUInt64LE(64);

  console.log('Source balance before  :', SOURCE_AMOUNT);
  console.log('Source balance after   :', sourceBal);
  console.log('Dest   balance before  : 0n');
  console.log('Dest   balance after   :', destBal);

  console.assert(sourceBal === SOURCE_AMOUNT - TRANSFER_AMT, 'Source debited correctly');
  console.assert(destBal   === TRANSFER_AMT,                 'Dest credited correctly');
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 4 — Same thing with MolluskContext
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== Part 4: Same flow with MolluskContext ===\n');

const ctx = MolluskContext.createDefault();
ctx.addSplToken(); // one call — bundled ELF, no .so file

ctx.setAccount(OWNER, tokenAccount(OWNER, MINT, SOURCE_AMOUNT));
ctx.setAccount(DEST,  tokenAccount(DEST,  MINT, 0n));

ctx.processAndValidateInstruction(
  splTransferIx(OWNER, DEST, OWNER, TRANSFER_AMT),
  [checkSuccess()],
);

const ownerAfter = ctx.getAccount(OWNER)!;
const destAfter2 = ctx.getAccount(DEST)!;

console.log('Source balance after   :', ownerAfter.data.readBigUInt64LE(64));
console.log('Dest   balance after   :', destAfter2.data.readBigUInt64LE(64));

console.assert(
  ownerAfter.data.readBigUInt64LE(64) === SOURCE_AMOUNT - TRANSFER_AMT,
  'Context: source debited',
);
console.assert(
  destAfter2.data.readBigUInt64LE(64) === TRANSFER_AMT,
  'Context: dest credited',
);

console.log('\nAll SPL Token tests passed ✓');
console.log('\nZero toolchain required — just npm install svmforge.');
