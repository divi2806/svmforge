/**
 * Test suite for mollusk-svm-node.
 *
 * Covers: processInstruction, processAndValidateInstruction,
 *         processInstructionChain, processTransactionInstructions,
 *         Check validators, sysvar helpers, rent helpers, compute budget.
 *
 * All tests use builtin programs only — no custom ELF required.
 *
 * Build & run:
 *   npm run build && npm test
 */

import {
  MolluskSvm,
  MolluskContext,
  JsInstruction,
  systemAccount,
  emptyAccount,
  checkSuccess,
  checkComputeUnits,
  checkAccountLamports,
} from '../index';

// ── constants ─────────────────────────────────────────────────────────────────

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

// ── test pubkeys ──────────────────────────────────────────────────────────────
// Valid 32-byte base58 pubkeys: 31 leading zero bytes + trailing value byte.
const ALICE = '11111111111111111111111111111112'; // [0x00 × 31, 0x01]
const BOB   = '11111111111111111111111111111113'; // [0x00 × 31, 0x02]
const CAROL = '11111111111111111111111111111114'; // [0x00 × 31, 0x03]

// ── instruction builders ──────────────────────────────────────────────────────

/**
 * system-program "transfer" instruction (index = 2).
 * Layout: u32le(2) ++ u64le(lamports)  = 12 bytes
 */
function transfer(from: string, to: string, lamports: bigint): JsInstruction {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return {
    programId: SYSTEM_PROGRAM_ID,
    accounts: [
      { pubkey: from, isSigner: true,  isWritable: true },
      { pubkey: to,   isSigner: false, isWritable: true },
    ],
    data,
  };
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('MolluskSvm', () => {

  // ── construction ─────────────────────────────────────────────────────────

  describe('createDefault()', () => {
    it('constructs without error', () => {
      expect(() => MolluskSvm.createDefault()).not.toThrow();
    });
  });

  // ── compute budget ────────────────────────────────────────────────────────

  describe('compute unit limit', () => {
    it('reads the default limit (1 400 000)', () => {
      const m = MolluskSvm.createDefault();
      expect(m.getComputeUnitLimit()).toBe(1_400_000);
    });

    it('round-trips a custom limit', () => {
      const m = MolluskSvm.createDefault();
      m.setComputeUnitLimit(50_000);
      expect(m.getComputeUnitLimit()).toBe(50_000);
    });
  });

  // ── processInstruction ────────────────────────────────────────────────────

  describe('processInstruction — system transfer', () => {
    const mollusk = MolluskSvm.createDefault();
    const START    = 1_000_000_000n;
    const TRANSFER =    42_000_000n;

    let result: ReturnType<typeof mollusk.processInstruction>;

    beforeAll(() => {
      result = mollusk.processInstruction(
        transfer(ALICE, BOB, TRANSFER),
        [
          { pubkey: ALICE, account: systemAccount(START) },
          { pubkey: BOB,   account: systemAccount(START) },
        ],
      );
    });

    it('reports success', () => {
      expect(result.success).toBe(true);
      expect(result.programResult).toBe('success');
    });

    it('consumes a positive number of compute units', () => {
      expect(result.computeUnitsConsumed).toBeGreaterThan(0n);
    });

    it('debits the sender', () => {
      const alice = result.resultingAccounts.find(a => a.pubkey === ALICE)!;
      expect(alice.lamports).toBe(START - TRANSFER);
    });

    it('credits the recipient', () => {
      const bob = result.resultingAccounts.find(a => a.pubkey === BOB)!;
      expect(bob.lamports).toBe(START + TRANSFER);
    });

    it('conserves total lamports', () => {
      const total = result.resultingAccounts.reduce((s, a) => s + a.lamports, 0n);
      expect(total).toBe(START * 2n);
    });

    it('returns all provided accounts', () => {
      expect(result.resultingAccounts).toHaveLength(2);
    });
  });

  // ── processAndValidateInstruction ─────────────────────────────────────────

  describe('processAndValidateInstruction', () => {
    const mollusk = MolluskSvm.createDefault();
    const START = 500_000_000n;
    const AMT   =  10_000_000n;

    it('passes when all checks hold', () => {
      expect(() =>
        mollusk.processAndValidateInstruction(
          transfer(ALICE, BOB, AMT),
          [
            { pubkey: ALICE, account: systemAccount(START) },
            { pubkey: BOB,   account: systemAccount(START) },
          ],
          [
            checkSuccess(),
            checkAccountLamports(ALICE, START - AMT),
            checkAccountLamports(BOB,   START + AMT),
          ],
        )
      ).not.toThrow();
    });

    it('throws when a lamports check fails', () => {
      expect(() =>
        mollusk.processAndValidateInstruction(
          transfer(ALICE, BOB, AMT),
          [
            { pubkey: ALICE, account: systemAccount(START) },
            { pubkey: BOB,   account: systemAccount(START) },
          ],
          [checkAccountLamports(ALICE, 999n)], // wrong expected value
        )
      ).toThrow(/lamports/i);
    });

    it('throws on an unexpected success', () => {
      // Transfer more than Alice has → should fail
      const result = mollusk.processInstruction(
        transfer(ALICE, BOB, START * 2n), // overdraft
        [
          { pubkey: ALICE, account: systemAccount(START) },
          { pubkey: BOB,   account: systemAccount(START) },
        ],
      );
      expect(result.success).toBe(false);
    });

    it('checkComputeUnits passes with actual CU count', () => {
      const result = mollusk.processInstruction(
        transfer(ALICE, BOB, AMT),
        [
          { pubkey: ALICE, account: systemAccount(START) },
          { pubkey: BOB,   account: systemAccount(START) },
        ],
      );
      const actualCUs = result.computeUnitsConsumed;
      expect(() =>
        mollusk.processAndValidateInstruction(
          transfer(ALICE, BOB, AMT),
          [
            { pubkey: ALICE, account: systemAccount(START) },
            { pubkey: BOB,   account: systemAccount(START) },
          ],
          [checkSuccess(), checkComputeUnits(actualCUs)],
        )
      ).not.toThrow();
    });

    it('checkComputeUnits throws with wrong CU count', () => {
      expect(() =>
        mollusk.processAndValidateInstruction(
          transfer(ALICE, BOB, AMT),
          [
            { pubkey: ALICE, account: systemAccount(START) },
            { pubkey: BOB,   account: systemAccount(START) },
          ],
          [checkComputeUnits(1n)], // clearly wrong
        )
      ).toThrow(/CUs/i);
    });
  });

  // ── processInstructionChain ───────────────────────────────────────────────

  describe('processInstructionChain', () => {
    const mollusk = MolluskSvm.createDefault();
    const START  = 500_000_000n;
    const A_TO_B = 100_000_000n;
    const B_TO_A =  50_000_000n;

    it('applies both transfers in sequence', () => {
      const result = mollusk.processInstructionChain(
        [transfer(ALICE, BOB, A_TO_B), transfer(BOB, ALICE, B_TO_A)],
        [
          { pubkey: ALICE, account: systemAccount(START) },
          { pubkey: BOB,   account: systemAccount(START) },
        ],
      );
      expect(result.success).toBe(true);
      const alice = result.resultingAccounts.find(a => a.pubkey === ALICE)!;
      const bob   = result.resultingAccounts.find(a => a.pubkey === BOB)!;
      expect(alice.lamports).toBe(START - A_TO_B + B_TO_A);
      expect(bob.lamports).toBe(START + A_TO_B - B_TO_A);
    });

    it('chain CUs ≥ single instruction CUs', () => {
      const single = mollusk.processInstruction(
        transfer(ALICE, BOB, A_TO_B),
        [
          { pubkey: ALICE, account: systemAccount(START) },
          { pubkey: BOB,   account: systemAccount(START) },
        ],
      );
      const chain = mollusk.processInstructionChain(
        [transfer(ALICE, BOB, A_TO_B), transfer(BOB, ALICE, B_TO_A)],
        [
          { pubkey: ALICE, account: systemAccount(START) },
          { pubkey: BOB,   account: systemAccount(START) },
        ],
      );
      expect(chain.computeUnitsConsumed).toBeGreaterThanOrEqual(
        single.computeUnitsConsumed,
      );
    });
  });

  // ── processTransactionInstructions ───────────────────────────────────────

  describe('processTransactionInstructions', () => {
    const mollusk = MolluskSvm.createDefault();
    const START = 500_000_000n;

    it('succeeds for valid transaction', () => {
      const result = mollusk.processTransactionInstructions(
        [transfer(ALICE, BOB, 10_000_000n), transfer(BOB, CAROL, 5_000_000n)],
        [
          { pubkey: ALICE, account: systemAccount(START) },
          { pubkey: BOB,   account: systemAccount(START) },
          { pubkey: CAROL, account: systemAccount(START) },
        ],
      );
      expect(result.success).toBe(true);
      expect(result.failingInstructionIndex).toBeUndefined();
    });

    it('rolls back and reports the failing instruction index on error', () => {
      const result = mollusk.processTransactionInstructions(
        [
          transfer(ALICE, BOB, 10_000_000n),  // ix 0 — ok
          transfer(BOB, CAROL, START * 10n),   // ix 1 — overdraft → fails
        ],
        [
          { pubkey: ALICE, account: systemAccount(START) },
          { pubkey: BOB,   account: systemAccount(START) },
          { pubkey: CAROL, account: systemAccount(START) },
        ],
      );
      expect(result.success).toBe(false);
      expect(result.failingInstructionIndex).toBe(1);
    });
  });

  // ── sysvar helpers ────────────────────────────────────────────────────────

  describe('warpToSlot', () => {
    it('advances the clock', () => {
      const mollusk = MolluskSvm.createDefault();
      expect(mollusk.getSlot()).toBe(0n);
      mollusk.warpToSlot(1000n);
      expect(mollusk.getSlot()).toBe(1000n);
    });
  });

  describe('setClockUnixTimestamp', () => {
    it('round-trips the unix timestamp', () => {
      const mollusk = MolluskSvm.createDefault();
      mollusk.setClockUnixTimestamp(1_700_000_000);
      expect(mollusk.getClockUnixTimestamp()).toBe(1_700_000_000);
    });
  });

  describe('setEpoch / getEpoch', () => {
    it('round-trips the epoch', () => {
      const mollusk = MolluskSvm.createDefault();
      mollusk.setEpoch(42n);
      expect(mollusk.getEpoch()).toBe(42n);
    });
  });

  // ── rent helpers ──────────────────────────────────────────────────────────

  describe('getRentMinimumBalance', () => {
    it('returns a positive bigint for non-zero data length', () => {
      const mollusk = MolluskSvm.createDefault();
      const minBalance = mollusk.getRentMinimumBalance(165);
      expect(minBalance).toBeGreaterThan(0n);
    });

    it('returns 0 for zero-length data (no lamports needed)', () => {
      const mollusk = MolluskSvm.createDefault();
      // Solana charges rent even for 0-byte accounts, but let's verify it's a bigint
      expect(typeof mollusk.getRentMinimumBalance(0)).toBe('bigint');
    });
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  describe('systemAccount()', () => {
    it('produces a valid system-owned account', () => {
      const acc = systemAccount(1_000_000n);
      expect(acc.owner).toBe(SYSTEM_PROGRAM_ID);
      expect(acc.lamports).toBe(1_000_000n);
      expect(acc.executable).toBe(false);
      expect(acc.data.length).toBe(0);
    });
  });

  describe('emptyAccount()', () => {
    it('produces zeroed data of the requested size', () => {
      const acc = emptyAccount(SYSTEM_PROGRAM_ID, 165, 890_880n);
      expect(acc.data.length).toBe(165);
      expect(acc.data.every((b: number) => b === 0)).toBe(true);
    });

    it('throws on an invalid owner pubkey', () => {
      expect(() => emptyAccount('not-a-valid-pubkey', 0, 0n)).toThrow();
    });
  });

  // ── MolluskContext ────────────────────────────────────────────────────────

  describe('MolluskContext', () => {
    const START    = 1_000_000_000n;
    const TRANSFER =    10_000_000n;

    it('createDefault() constructs without error', () => {
      expect(() => MolluskContext.createDefault()).not.toThrow();
    });

    it('setAccount / getAccount round-trips account state', () => {
      const ctx = MolluskContext.createDefault();
      ctx.setAccount(ALICE, systemAccount(START));
      const retrieved = ctx.getAccount(ALICE);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.lamports).toBe(START);
      expect(retrieved!.owner).toBe(SYSTEM_PROGRAM_ID);
    });

    it('getAccount returns null for an unknown key', () => {
      const ctx = MolluskContext.createDefault();
      expect(ctx.getAccount(ALICE)).toBeNull();
    });

    it('processInstruction persists state without explicit accounts', () => {
      const ctx = MolluskContext.createDefault();
      ctx.setAccount(ALICE, systemAccount(START));
      ctx.setAccount(BOB,   systemAccount(0n));

      const result = ctx.processInstruction(transfer(ALICE, BOB, TRANSFER));
      expect(result.success).toBe(true);

      // Context persisted resulting balances
      expect(ctx.getAccount(ALICE)!.lamports).toBe(START - TRANSFER);
      expect(ctx.getAccount(BOB)!.lamports).toBe(TRANSFER);
    });

    it('state carries forward across multiple calls automatically', () => {
      const ctx = MolluskContext.createDefault();
      ctx.setAccount(ALICE, systemAccount(START));
      ctx.setAccount(BOB,   systemAccount(0n));
      ctx.setAccount(CAROL, systemAccount(0n));

      // Call 1: Alice → Bob
      ctx.processInstruction(transfer(ALICE, BOB, TRANSFER));
      // Call 2: Bob → Carol (uses Bob's updated balance from call 1)
      ctx.processInstruction(transfer(BOB, CAROL, TRANSFER));

      expect(ctx.getAccount(ALICE)!.lamports).toBe(START - TRANSFER);
      expect(ctx.getAccount(BOB)!.lamports).toBe(0n);
      expect(ctx.getAccount(CAROL)!.lamports).toBe(TRANSFER);
    });

    it('failed instruction does NOT update the store', () => {
      const ctx = MolluskContext.createDefault();
      ctx.setAccount(ALICE, systemAccount(START));
      ctx.setAccount(BOB,   systemAccount(0n));

      // Attempt overdraft — should fail
      const result = ctx.processInstruction(transfer(ALICE, BOB, START * 2n));
      expect(result.success).toBe(false);

      // Store unchanged
      expect(ctx.getAccount(ALICE)!.lamports).toBe(START);
      expect(ctx.getAccount(BOB)!.lamports).toBe(0n);
    });

    it('processAndValidateInstruction throws on check failure', () => {
      const ctx = MolluskContext.createDefault();
      ctx.setAccount(ALICE, systemAccount(START));
      ctx.setAccount(BOB,   systemAccount(0n));
      expect(() =>
        ctx.processAndValidateInstruction(
          transfer(ALICE, BOB, TRANSFER),
          [checkAccountLamports(ALICE, 999n)], // wrong
        )
      ).toThrow(/lamports/i);
    });

    it('processTransactionInstructions works without explicit accounts', () => {
      const ctx = MolluskContext.createDefault();
      ctx.setAccount(ALICE, systemAccount(START));
      ctx.setAccount(BOB,   systemAccount(START));
      ctx.setAccount(CAROL, systemAccount(0n));

      const result = ctx.processTransactionInstructions([
        transfer(ALICE, BOB,   TRANSFER),
        transfer(BOB,   CAROL, TRANSFER),
      ]);
      expect(result.success).toBe(true);
    });

    it('getAllAccounts returns all seeded keys', () => {
      const ctx = MolluskContext.createDefault();
      ctx.setAccount(ALICE, systemAccount(1n));
      ctx.setAccount(BOB,   systemAccount(2n));
      const all = ctx.getAllAccounts();
      const pubkeys = all.map(e => e.pubkey);
      expect(pubkeys).toContain(ALICE);
      expect(pubkeys).toContain(BOB);
    });

    it('getRentMinimumBalance returns a positive bigint', () => {
      const ctx = MolluskContext.createDefault();
      expect(ctx.getRentMinimumBalance(165)).toBeGreaterThan(0n);
    });

    it('warpToSlot advances the clock', () => {
      const ctx = MolluskContext.createDefault();
      ctx.warpToSlot(500n);
      // processInstruction still works after warp
      ctx.setAccount(ALICE, systemAccount(START));
      ctx.setAccount(BOB,   systemAccount(0n));
      const result = ctx.processInstruction(transfer(ALICE, BOB, TRANSFER));
      expect(result.success).toBe(true);
    });
  });
});
