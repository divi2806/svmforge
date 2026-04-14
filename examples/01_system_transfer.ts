/**
 * Example 01 — System Program Transfer
 *
 * Demonstrates the most basic svmforge flow:
 *   1. Construct a MolluskSvm test harness targeting the System Program.
 *   2. Build an instruction that transfers SOL from Alice to Bob.
 *   3. Execute and validate the result with type-safe Check helpers.
 *
 * Run (from the node/ directory):
 *   npx ts-node examples/01_system_transfer.ts
 */

import {
  MolluskSvm,
  JsAccount,
  JsInstruction,
  checkSuccess,
  checkAccountLamports,
  systemAccount,
} from '../index';

// ── addresses ────────────────────────────────────────────────────────────────

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// Minimal valid 32-byte base58 pubkeys (31 leading-zero bytes + trailing byte)
const ALICE = '11111111111111111111111111111112'; // sender
const BOB   = '11111111111111111111111111111113'; // recipient

// ── build the transfer instruction ───────────────────────────────────────────

/**
 * Encode a System Program Transfer instruction manually.
 *
 * Wire format: [instruction_index: u32 LE] [lamports: u64 LE]
 *   instruction index 2 = Transfer
 */
function buildTransferIx(from: string, to: string, lamports: bigint): JsInstruction {
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(2, 0);           // Transfer variant = 2
  buf.writeBigUInt64LE(lamports, 4); // amount
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [
      { pubkey: from, isSigner: true,  isWritable: true  },
      { pubkey: to,   isSigner: false, isWritable: true  },
    ],
    data: buf,
  };
}

// ── harness setup ─────────────────────────────────────────────────────────────

// createDefault() needs no arguments — it targets the System Program (builtins only)
const svm = MolluskSvm.createDefault();

const ALICE_STARTING = 5_000_000_000n; // 5 SOL
const BOB_STARTING   =   500_000_000n; // 0.5 SOL
const TRANSFER       =   500_000_000n; // 0.5 SOL

const aliceAccount: JsAccount = systemAccount(ALICE_STARTING);
const bobAccount:   JsAccount = systemAccount(BOB_STARTING);

const ix = buildTransferIx(ALICE, BOB, TRANSFER);

// ── Option A: fire-and-inspect manually ──────────────────────────────────────

console.log('\n=== Option A: processInstruction (manual inspection) ===');

const result = svm.processInstruction(
  ix,
  [
    { pubkey: ALICE, account: aliceAccount },
    { pubkey: BOB,   account: bobAccount   },
  ],
);

console.log('success              :', result.success);
console.log('program result       :', result.programResult);
console.log('compute units used   :', result.computeUnitsConsumed);
console.log('execution time (ns)  :', result.executionTime);

const afterAlice = result.resultingAccounts.find(a => a.pubkey === ALICE)!;
const afterBob   = result.resultingAccounts.find(a => a.pubkey === BOB)!;

console.log('Alice lamports before:', ALICE_STARTING);
console.log('Alice lamports after :', afterAlice.lamports);
console.log('Bob   lamports before:', BOB_STARTING);
console.log('Bob   lamports after :', afterBob.lamports);

console.assert(result.success, 'Instruction should succeed');
console.assert(afterAlice.lamports === ALICE_STARTING - TRANSFER, 'Alice debited correctly');
console.assert(afterBob.lamports   === BOB_STARTING   + TRANSFER, 'Bob credited correctly');
console.assert(
  afterAlice.lamports + afterBob.lamports === ALICE_STARTING + BOB_STARTING,
  'Total SOL is conserved',
);

// ── Option B: use check helpers (throws on any failure) ───────────────────────

console.log('\n=== Option B: processAndValidateInstruction (check helpers) ===');

svm.processAndValidateInstruction(
  ix,
  [
    { pubkey: ALICE, account: aliceAccount },
    { pubkey: BOB,   account: bobAccount   },
  ],
  [
    checkSuccess(),
    checkAccountLamports(ALICE, ALICE_STARTING - TRANSFER),
    checkAccountLamports(BOB,   BOB_STARTING   + TRANSFER),
  ],
);

console.log('All checks passed — transfer validated');

// ── Option C: test that an insufficient-funds transfer FAILS ─────────────────

console.log('\n=== Option C: insufficient funds (should fail gracefully) ===');

const POOR_ALICE: JsAccount = systemAccount(100_000_000n); // only 0.1 SOL
const HUGE_TRANSFER = 999_999_000_000_000n;                // far more than she has

const failResult = svm.processInstruction(
  buildTransferIx(ALICE, BOB, HUGE_TRANSFER),
  [
    { pubkey: ALICE, account: POOR_ALICE },
    { pubkey: BOB,   account: bobAccount },
  ],
);

console.log('success              :', failResult.success, '  (expected false)');
console.log('program result       :', failResult.programResult);

console.assert(!failResult.success, 'Should have failed');

console.log('\nAll assertions passed ✓');
