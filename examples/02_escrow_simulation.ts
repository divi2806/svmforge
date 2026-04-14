/**
 * Example 02 — Escrow Simulation with MolluskContext
 *
 * Simulates a two-step escrow flow entirely through the System Program:
 *
 *   Step 1 — Deposit:  Alice → Escrow PDA   (lock funds)
 *   Step 2 — Release:  Escrow PDA → Bob     (pay out)
 *
 * Key concepts shown:
 *   • MolluskContext — stateful harness; accounts persist between calls
 *   • setAccount / getAccount — seed and inspect individual accounts
 *   • processInstructionChain — multiple instructions with forwarded state
 *   • processTransactionInstructions — atomic execution with rollback
 *   • Check helpers — assert post-state without manually inspecting results
 *
 * Run (from the node/ directory):
 *   npx ts-node examples/02_escrow_simulation.ts
 */

import {
  MolluskContext,
  JsInstruction,
  checkSuccess,
  checkAccountLamports,
  systemAccount,
} from '../index';

// ── addresses ────────────────────────────────────────────────────────────────

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

const ALICE  = '11111111111111111111111111111112';
const BOB    = '11111111111111111111111111111113';
const ESCROW = '11111111111111111111111111111114';

// ── encode a System Transfer instruction ─────────────────────────────────────

function transferIx(from: string, to: string, lamports: bigint): JsInstruction {
  const buf = Buffer.alloc(12);
  buf.writeUInt32LE(2, 0);
  buf.writeBigUInt64LE(lamports, 4);
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [
      { pubkey: from, isSigner: true,  isWritable: true },
      { pubkey: to,   isSigner: false, isWritable: true },
    ],
    data: buf,
  };
}

// ── initial balances ──────────────────────────────────────────────────────────

const ALICE_SOL  = 10_000_000_000n; // 10 SOL
const BOB_SOL    =    500_000_000n; //  0.5 SOL
const ESCROW_SOL =    500_000_000n; //  0.5 SOL (pre-funded, acts as rent reserve)
const DEPOSIT    =  3_000_000_000n; //  3 SOL — Alice deposits into escrow
const RELEASE    =  3_000_000_000n; //  3 SOL — escrow releases to Bob

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — Step-by-step with MolluskContext
// ─────────────────────────────────────────────────────────────────────────────

console.log('=== PART 1: Step-by-step with MolluskContext ===\n');

const ctx = MolluskContext.createDefault();

// Seed initial state — do this once; the context carries it forward automatically
ctx.setAccount(ALICE,  systemAccount(ALICE_SOL));
ctx.setAccount(BOB,    systemAccount(BOB_SOL));
ctx.setAccount(ESCROW, systemAccount(ESCROW_SOL));

console.log('Initial balances:');
console.log('  Alice  :', ctx.getAccount(ALICE)!.lamports);
console.log('  Bob    :', ctx.getAccount(BOB)!.lamports);
console.log('  Escrow :', ctx.getAccount(ESCROW)!.lamports);

// — Step 1: Alice deposits into Escrow ————————————————————————————————————————

console.log('\n--- Step 1: Alice deposits 3 SOL into Escrow ---');

ctx.processAndValidateInstruction(
  transferIx(ALICE, ESCROW, DEPOSIT),
  // No accounts arg — context loads them automatically
  [
    checkSuccess(),
    checkAccountLamports(ALICE,  ALICE_SOL  - DEPOSIT),
    checkAccountLamports(ESCROW, ESCROW_SOL + DEPOSIT),
  ],
);

console.log('After deposit:');
console.log('  Alice  :', ctx.getAccount(ALICE)!.lamports,  '(was', ALICE_SOL, ')');
console.log('  Escrow :', ctx.getAccount(ESCROW)!.lamports, '(was', ESCROW_SOL, ')');
console.log('  Bob    :', ctx.getAccount(BOB)!.lamports,    '(unchanged)');

// — Step 2: Escrow releases to Bob ————————————————————————————————————————————

console.log('\n--- Step 2: Escrow releases 3 SOL to Bob ---');

const escrowAfterDeposit = ctx.getAccount(ESCROW)!.lamports;
const bobAfterDeposit    = ctx.getAccount(BOB)!.lamports;

ctx.processAndValidateInstruction(
  transferIx(ESCROW, BOB, RELEASE),
  [
    checkSuccess(),
    checkAccountLamports(ESCROW, escrowAfterDeposit - RELEASE),
    checkAccountLamports(BOB,    bobAfterDeposit    + RELEASE),
  ],
);

console.log('Final balances:');
console.log('  Alice  :', ctx.getAccount(ALICE)!.lamports);
console.log('  Escrow :', ctx.getAccount(ESCROW)!.lamports);
console.log('  Bob    :', ctx.getAccount(BOB)!.lamports);

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — Atomic chain: both steps in one processInstructionChain call
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== PART 2: Both steps atomically via processInstructionChain ===\n');

const ctx2 = MolluskContext.createDefault();
ctx2.setAccount(ALICE,  systemAccount(ALICE_SOL));
ctx2.setAccount(BOB,    systemAccount(BOB_SOL));
ctx2.setAccount(ESCROW, systemAccount(ESCROW_SOL));

const chainResult = ctx2.processInstructionChain([
  transferIx(ALICE, ESCROW, DEPOSIT),
  transferIx(ESCROW, BOB,   RELEASE),
]);

console.log('Chain success          :', chainResult.success);
console.log('Chain CUs consumed     :', chainResult.computeUnitsConsumed);
console.log('Alice  after chain     :', ctx2.getAccount(ALICE)!.lamports);
console.log('Escrow after chain     :', ctx2.getAccount(ESCROW)!.lamports);
console.log('Bob    after chain     :', ctx2.getAccount(BOB)!.lamports);

console.assert(chainResult.success, 'Chain should succeed');
console.assert(ctx2.getAccount(BOB)!.lamports === BOB_SOL + RELEASE, 'Bob received correct amount');

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — Transaction rollback: one bad instruction rolls back the whole tx
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== PART 3: Transaction rollback on failure ===\n');

const ctx3 = MolluskContext.createDefault();
ctx3.setAccount(ALICE,  systemAccount(ALICE_SOL));
ctx3.setAccount(BOB,    systemAccount(BOB_SOL));
ctx3.setAccount(ESCROW, systemAccount(ESCROW_SOL));

const IMPOSSIBLE_AMOUNT = 999_999_000_000_000n; // far more than Alice has

const txResult = ctx3.processTransactionInstructions([
  transferIx(ALICE, ESCROW, DEPOSIT),           // would succeed on its own
  transferIx(ALICE, BOB,    IMPOSSIBLE_AMOUNT), // this will fail
]);

console.log('Transaction succeeded       :', txResult.success, '(expected false)');
console.log('Failing instruction index   :', txResult.failingInstructionIndex, '(expected 1)');
console.log('Program result              :', txResult.programResult);

// Because the tx failed, ctx3 must still have the original balances
console.log('Alice balance (rolled back) :', ctx3.getAccount(ALICE)!.lamports, '(should be', ALICE_SOL, ')');

console.assert(!txResult.success, 'Transaction should have failed');
console.assert(txResult.failingInstructionIndex === 1, 'Instruction 1 should have failed');
console.assert(ctx3.getAccount(ALICE)!.lamports === ALICE_SOL, 'Rollback preserved original balance');

// ─────────────────────────────────────────────────────────────────────────────
// PART 4 — getAllAccounts + clock manipulation
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n=== PART 4: getAllAccounts + clock / sysvar control ===\n');

const ctx4 = MolluskContext.createDefault();
ctx4.setAccount(ALICE,  systemAccount(ALICE_SOL));
ctx4.setAccount(BOB,    systemAccount(BOB_SOL));
ctx4.setAccount(ESCROW, systemAccount(ESCROW_SOL));

const all = ctx4.getAllAccounts();
console.log('Total accounts in store:', all.length);
all.forEach(e => console.log(' ', e.pubkey, '→', e.account.lamports, 'lamports'));

// Advance to a specific slot (programs that check the clock will see this)
ctx4.warpToSlot(500n);
console.log('\nWarped to slot 500');

// Set a specific unix timestamp
ctx4.setClockUnixTimestamp(1_700_000_000); // Nov 2023
console.log('Rent for 0 bytes    :', ctx4.getRentMinimumBalance(0),   'lamports (account header overhead)');
console.log('Rent for 165 bytes  :', ctx4.getRentMinimumBalance(165), 'lamports (e.g. token account)');

console.log('\nAll escrow example steps completed ✓');
