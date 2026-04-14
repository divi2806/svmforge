/**
 * Production-grade test suite — real compiled BPF program via svmforge.
 *
 * Tests the escrow-vault program: Initialize, Release, Cancel.
 * This exercises the critical path: `new MolluskSvm(programId, path)`
 * loading an actual compiled `.so` ELF file and running it through the SVM.
 *
 * Build the program first (from repo root):
 *   cargo build-sbf --manifest-path test-programs/escrow-vault/Cargo.toml
 *
 * Run tests (from node/ directory):
 *   SBF_OUT_DIR=../target/deploy npm test
 */

import {
    MolluskSvm,
    MolluskContext,
    JsInstruction,
    JsAccount,
    systemAccount,
    emptyAccount,
    checkSuccess,
    checkErr,
    checkAccountLamports,
    checkAccountOwner,
    checkAccountClosed,
} from '../index';

// ── constants ─────────────────────────────────────────────────────────────────

// Deterministic program ID for the escrow-vault (matches what we load from ELF)
const PROGRAM_ID = '9qGMkGAjdGuFKGMBtHMFfTMHPRHLjPsCPrFAGsPxbfAn';

// Vault account layout: 41 bytes
const VAULT_DATA_LEN = 41;

// Custom error codes (must match program's ERR_* constants)
const ERR_ALREADY_INITIALIZED  = 1;
const ERR_NOT_INITIALIZED      = 2;
const ERR_WRONG_BENEFICIARY    = 3;
const ERR_DEPOSITOR_NOT_SIGNER = 5;
const ERR_INSUFFICIENT_AMOUNT  = 8;

// ── test pubkeys ──────────────────────────────────────────────────────────────

const DEPOSITOR        = '11111111111111111111111111111112';
const VAULT            = '11111111111111111111111111111113';
const BENEFICIARY      = '11111111111111111111111111111114';
const WRONG_BENEFICIARY = '11111111111111111111111111111115';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Decode our test pubkeys (all 1s + trailing value byte) to 32-byte Buffers.
 * "11111111111111111111111111111112" → [0x00 × 31, 0x01]
 */
function pubkeyToBytes(pubkey: string): Buffer {
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const bytes = Buffer.alloc(32, 0);
    bytes[31] = B58.indexOf(pubkey[pubkey.length - 1]);
    return bytes;
}

/** Build the Initialize instruction (variant = 0). */
function initializeIx(vault: string, beneficiary: string, amount: bigint): JsInstruction {
    const data = Buffer.alloc(1 + 32 + 8);
    data[0] = 0;
    pubkeyToBytes(beneficiary).copy(data, 1);
    data.writeBigUInt64LE(amount, 33);
    return {
        programId: PROGRAM_ID,
        accounts: [{ pubkey: vault, isSigner: false, isWritable: true }],
        data,
    };
}

/** Build the Release instruction (variant = 1). */
function releaseIx(vault: string, beneficiary: string): JsInstruction {
    return {
        programId: PROGRAM_ID,
        accounts: [
            { pubkey: vault,       isSigner: false, isWritable: true },
            { pubkey: beneficiary, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([1]),
    };
}

/** Build the Cancel instruction (variant = 2). */
function cancelIx(vault: string, depositor: string): JsInstruction {
    return {
        programId: PROGRAM_ID,
        accounts: [
            { pubkey: vault,     isSigner: false, isWritable: true },
            { pubkey: depositor, isSigner: true,  isWritable: true },
        ],
        data: Buffer.from([2]),
    };
}

/**
 * Build an initialized vault account owned by the program.
 * The vault is pre-funded with `lamports` and has its state written.
 */
function initializedVault(lamports: bigint, beneficiary: string, amount: bigint): JsAccount {
    const data = Buffer.alloc(VAULT_DATA_LEN, 0);
    pubkeyToBytes(beneficiary).copy(data, 0);
    data.writeBigUInt64LE(amount, 32);
    data[40] = 1; // is_initialized
    return { lamports, data, owner: PROGRAM_ID, executable: false, rentEpoch: 0n };
}

/**
 * Build an uninitialized vault account owned by the program.
 */
function uninitializedVault(lamports: bigint): JsAccount {
    const data = Buffer.alloc(VAULT_DATA_LEN, 0);
    return { lamports, data, owner: PROGRAM_ID, executable: false, rentEpoch: 0n };
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('Escrow-Vault (real compiled BPF program)', () => {

    // This is the key line: loading an actual .so ELF into the SVM
    // SBF_OUT_DIR must point to target/deploy/ when running tests
    const mollusk = new MolluskSvm(PROGRAM_ID, 'escrow_vault');

    const DEPOSIT_AMOUNT    = 2_000_000_000n; // 2 SOL
    const DEPOSITOR_BALANCE = 10_000_000_000n; // 10 SOL

    // ── Initialize ────────────────────────────────────────────────────────────

    describe('Initialize', () => {
        it('records beneficiary and marks vault as initialized', () => {
            const rentLamports = mollusk.getRentMinimumBalance(VAULT_DATA_LEN);
            const vaultLamports = rentLamports + DEPOSIT_AMOUNT;

            const result = mollusk.processInstruction(
                initializeIx(VAULT, BENEFICIARY, DEPOSIT_AMOUNT),
                [{ pubkey: VAULT, account: uninitializedVault(vaultLamports) }],
            );

            expect(result.success).toBe(true);
            expect(result.programResult).toBe('success');

            const vaultAfter = result.resultingAccounts.find(a => a.pubkey === VAULT)!;
            // is_initialized byte
            expect(vaultAfter.data[40]).toBe(1);
            // amount stored correctly
            expect(vaultAfter.data.readBigUInt64LE(32)).toBe(DEPOSIT_AMOUNT);
        });

        it('consumes a positive number of compute units', () => {
            const rentLamports = mollusk.getRentMinimumBalance(VAULT_DATA_LEN);
            const result = mollusk.processInstruction(
                initializeIx(VAULT, BENEFICIARY, DEPOSIT_AMOUNT),
                [{ pubkey: VAULT, account: uninitializedVault(rentLamports + DEPOSIT_AMOUNT) }],
            );
            expect(result.computeUnitsConsumed).toBeGreaterThan(0n);
        });

        it('fails when vault is already initialized', () => {
            const result = mollusk.processInstruction(
                initializeIx(VAULT, BENEFICIARY, DEPOSIT_AMOUNT),
                [{ pubkey: VAULT, account: initializedVault(DEPOSIT_AMOUNT, BENEFICIARY, DEPOSIT_AMOUNT) }],
            );
            expect(result.success).toBe(false);
        });

        it('fails with amount = 0', () => {
            const result = mollusk.processInstruction(
                initializeIx(VAULT, BENEFICIARY, 0n),
                [{ pubkey: VAULT, account: uninitializedVault(1_000_000_000n) }],
            );
            expect(result.success).toBe(false);
        });

        it('fails with too-short instruction data', () => {
            const ix: JsInstruction = {
                programId: PROGRAM_ID,
                accounts: [{ pubkey: VAULT, isSigner: false, isWritable: true }],
                data: Buffer.from([0, 1, 2, 3]), // only 4 bytes, need 41
            };
            const result = mollusk.processInstruction(
                ix,
                [{ pubkey: VAULT, account: uninitializedVault(DEPOSIT_AMOUNT) }],
            );
            expect(result.success).toBe(false);
        });

        it('fails when vault does not hold enough lamports', () => {
            const result = mollusk.processInstruction(
                initializeIx(VAULT, BENEFICIARY, DEPOSIT_AMOUNT),
                [{ pubkey: VAULT, account: uninitializedVault(1n) }], // nearly empty
            );
            expect(result.success).toBe(false);
        });
    });

    // ── Release ───────────────────────────────────────────────────────────────

    describe('Release', () => {
        it('transfers all vault lamports to the correct beneficiary', () => {
            const rentLamports = mollusk.getRentMinimumBalance(VAULT_DATA_LEN);
            const vaultBalance = rentLamports + DEPOSIT_AMOUNT;
            const beneficiaryStart = 500_000_000n;

            const result = mollusk.processInstruction(
                releaseIx(VAULT, BENEFICIARY),
                [
                    { pubkey: VAULT,       account: initializedVault(vaultBalance, BENEFICIARY, DEPOSIT_AMOUNT) },
                    { pubkey: BENEFICIARY, account: systemAccount(beneficiaryStart) },
                ],
            );

            expect(result.success).toBe(true);

            const vaultAfter = result.resultingAccounts.find(a => a.pubkey === VAULT)!;
            expect(vaultAfter.lamports).toBe(0n);

            const beneficiaryAfter = result.resultingAccounts.find(a => a.pubkey === BENEFICIARY)!;
            expect(beneficiaryAfter.lamports).toBe(beneficiaryStart + vaultBalance);
        });

        it('zeroes vault data after release', () => {
            const rentLamports = mollusk.getRentMinimumBalance(VAULT_DATA_LEN);
            const result = mollusk.processInstruction(
                releaseIx(VAULT, BENEFICIARY),
                [
                    { pubkey: VAULT,       account: initializedVault(rentLamports + DEPOSIT_AMOUNT, BENEFICIARY, DEPOSIT_AMOUNT) },
                    { pubkey: BENEFICIARY, account: systemAccount(0n) },
                ],
            );
            expect(result.success).toBe(true);
            const vaultAfter = result.resultingAccounts.find(a => a.pubkey === VAULT)!;
            expect(vaultAfter.data.every((b: number) => b === 0)).toBe(true);
        });

        it('validates with check helpers', () => {
            const rentLamports = mollusk.getRentMinimumBalance(VAULT_DATA_LEN);
            const vaultBalance = rentLamports + DEPOSIT_AMOUNT;
            const beneficiaryStart = 500_000_000n;

            expect(() =>
                mollusk.processAndValidateInstruction(
                    releaseIx(VAULT, BENEFICIARY),
                    [
                        { pubkey: VAULT,       account: initializedVault(vaultBalance, BENEFICIARY, DEPOSIT_AMOUNT) },
                        { pubkey: BENEFICIARY, account: systemAccount(beneficiaryStart) },
                    ],
                    [
                        checkSuccess(),
                        checkAccountLamports(VAULT,       0n),
                        checkAccountLamports(BENEFICIARY, beneficiaryStart + vaultBalance),
                    ],
                ),
            ).not.toThrow();
        });

        it('fails with wrong beneficiary', () => {
            const result = mollusk.processInstruction(
                releaseIx(VAULT, WRONG_BENEFICIARY),
                [
                    { pubkey: VAULT,            account: initializedVault(DEPOSIT_AMOUNT, BENEFICIARY, DEPOSIT_AMOUNT) },
                    { pubkey: WRONG_BENEFICIARY, account: systemAccount(0n) },
                ],
            );
            expect(result.success).toBe(false);
        });

        it('fails when vault is not initialized', () => {
            const result = mollusk.processInstruction(
                releaseIx(VAULT, BENEFICIARY),
                [
                    { pubkey: VAULT,       account: uninitializedVault(1_000_000n) },
                    { pubkey: BENEFICIARY, account: systemAccount(0n) },
                ],
            );
            expect(result.success).toBe(false);
        });
    });

    // ── Cancel ────────────────────────────────────────────────────────────────

    describe('Cancel', () => {
        it('returns all vault lamports to depositor', () => {
            const rentLamports = mollusk.getRentMinimumBalance(VAULT_DATA_LEN);
            const vaultBalance = rentLamports + DEPOSIT_AMOUNT;
            const depositorStart = 5_000_000_000n;

            const result = mollusk.processInstruction(
                cancelIx(VAULT, DEPOSITOR),
                [
                    { pubkey: VAULT,     account: initializedVault(vaultBalance, BENEFICIARY, DEPOSIT_AMOUNT) },
                    { pubkey: DEPOSITOR, account: systemAccount(depositorStart) },
                ],
            );

            expect(result.success).toBe(true);

            const vaultAfter = result.resultingAccounts.find(a => a.pubkey === VAULT)!;
            expect(vaultAfter.lamports).toBe(0n);

            const depositorAfter = result.resultingAccounts.find(a => a.pubkey === DEPOSITOR)!;
            expect(depositorAfter.lamports).toBe(depositorStart + vaultBalance);
        });

        it('zeroes vault data after cancel', () => {
            const result = mollusk.processInstruction(
                cancelIx(VAULT, DEPOSITOR),
                [
                    { pubkey: VAULT,     account: initializedVault(DEPOSIT_AMOUNT, BENEFICIARY, DEPOSIT_AMOUNT) },
                    { pubkey: DEPOSITOR, account: systemAccount(5_000_000_000n) },
                ],
            );
            expect(result.success).toBe(true);
            const vaultAfter = result.resultingAccounts.find(a => a.pubkey === VAULT)!;
            expect(vaultAfter.data.every((b: number) => b === 0)).toBe(true);
        });

        it('fails when depositor is not a signer', () => {
            const ix = cancelIx(VAULT, DEPOSITOR);
            ix.accounts[1].isSigner = false;
            const result = mollusk.processInstruction(
                ix,
                [
                    { pubkey: VAULT,     account: initializedVault(DEPOSIT_AMOUNT, BENEFICIARY, DEPOSIT_AMOUNT) },
                    { pubkey: DEPOSITOR, account: systemAccount(5_000_000_000n) },
                ],
            );
            expect(result.success).toBe(false);
        });

        it('fails when vault is not initialized', () => {
            const result = mollusk.processInstruction(
                cancelIx(VAULT, DEPOSITOR),
                [
                    { pubkey: VAULT,     account: uninitializedVault(1_000_000n) },
                    { pubkey: DEPOSITOR, account: systemAccount(5_000_000_000n) },
                ],
            );
            expect(result.success).toBe(false);
        });
    });

    // ── Invalid instructions ──────────────────────────────────────────────────

    describe('Invalid instruction', () => {
        it('rejects unknown variant byte', () => {
            const result = mollusk.processInstruction(
                { programId: PROGRAM_ID, accounts: [{ pubkey: VAULT, isSigner: false, isWritable: true }], data: Buffer.from([99]) },
                [{ pubkey: VAULT, account: uninitializedVault(0n) }],
            );
            expect(result.success).toBe(false);
        });

        it('rejects empty instruction data', () => {
            const result = mollusk.processInstruction(
                { programId: PROGRAM_ID, accounts: [{ pubkey: VAULT, isSigner: false, isWritable: true }], data: Buffer.alloc(0) },
                [{ pubkey: VAULT, account: uninitializedVault(0n) }],
            );
            expect(result.success).toBe(false);
        });
    });

    // ── MolluskContext with real program ──────────────────────────────────────

    describe('MolluskContext (stateful, real program)', () => {
        it('release persists zero lamports in vault', () => {
            const ctx = new MolluskContext(PROGRAM_ID, 'escrow_vault');
            const rentLamports = ctx.getRentMinimumBalance(VAULT_DATA_LEN);
            const vaultBalance = rentLamports + DEPOSIT_AMOUNT;

            ctx.setAccount(VAULT,       initializedVault(vaultBalance, BENEFICIARY, DEPOSIT_AMOUNT));
            ctx.setAccount(BENEFICIARY, systemAccount(500_000_000n));

            const result = ctx.processInstruction(releaseIx(VAULT, BENEFICIARY));
            expect(result.success).toBe(true);

            expect(ctx.getAccount(VAULT)!.lamports).toBe(0n);
            expect(ctx.getAccount(BENEFICIARY)!.lamports).toBe(500_000_000n + vaultBalance);
        });

        it('cancel via context returns funds to depositor', () => {
            const ctx = new MolluskContext(PROGRAM_ID, 'escrow_vault');
            const rentLamports = ctx.getRentMinimumBalance(VAULT_DATA_LEN);
            const vaultBalance = rentLamports + DEPOSIT_AMOUNT;
            const depositorStart = 5_000_000_000n;

            ctx.setAccount(VAULT,     initializedVault(vaultBalance, BENEFICIARY, DEPOSIT_AMOUNT));
            ctx.setAccount(DEPOSITOR, systemAccount(depositorStart));

            const result = ctx.processInstruction(cancelIx(VAULT, DEPOSITOR));
            expect(result.success).toBe(true);

            expect(ctx.getAccount(VAULT)!.lamports).toBe(0n);
            expect(ctx.getAccount(DEPOSITOR)!.lamports).toBe(depositorStart + vaultBalance);
        });

        it('state from initialize flows into release via context', () => {
            const ctx = new MolluskContext(PROGRAM_ID, 'escrow_vault');
            const rentLamports = ctx.getRentMinimumBalance(VAULT_DATA_LEN);
            const vaultBalance = rentLamports + DEPOSIT_AMOUNT;

            // Step 1: Initialize (vault pre-funded, program already owns it)
            ctx.setAccount(VAULT,       uninitializedVault(vaultBalance));
            ctx.setAccount(BENEFICIARY, systemAccount(0n));

            ctx.processAndValidateInstruction(
                initializeIx(VAULT, BENEFICIARY, DEPOSIT_AMOUNT),
                [checkSuccess()],
            );

            // Step 2: Release — context auto-loads the now-initialized vault
            ctx.processAndValidateInstruction(
                releaseIx(VAULT, BENEFICIARY),
                [
                    checkSuccess(),
                    checkAccountLamports(VAULT,       0n),
                    checkAccountLamports(BENEFICIARY, vaultBalance),
                ],
            );
        });
    });

    // ── Sysvar helpers with real program harness ──────────────────────────────

    describe('Sysvar helpers', () => {
        it('getRentMinimumBalance returns positive value for vault size', () => {
            expect(mollusk.getRentMinimumBalance(VAULT_DATA_LEN)).toBeGreaterThan(0n);
        });

        it('warpToSlot works with real program harness', () => {
            const m = new MolluskSvm(PROGRAM_ID, 'escrow_vault');
            m.warpToSlot(999n);
            expect(m.getSlot()).toBe(999n);
        });

        it('compute unit limit can be overridden', () => {
            const m = new MolluskSvm(PROGRAM_ID, 'escrow_vault');
            m.setComputeUnitLimit(300_000);
            expect(m.getComputeUnitLimit()).toBe(300_000);
        });
    });
});
