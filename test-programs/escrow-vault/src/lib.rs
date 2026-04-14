//! Escrow Vault — real BPF program for svmforge production-grade testing.
//!
//! Instructions
//! ────────────
//! 0 · Initialize  [vault(writable, program-owned)]
//!       data: [0u8, beneficiary: [u8;32], amount: u64 LE]
//!       • Vault must already hold enough lamports (pre-funded by caller).
//!       • Records beneficiary + amount + marks as initialized.
//!       • In svmforge tests, the test supplies the vault with lamports directly —
//!         this is idiomatic: you own all account state in the harness.
//!
//! 1 · Release     [vault(writable), beneficiary(writable)]
//!       data: [1u8]
//!       • Validates stored beneficiary matches provided account.
//!       • Transfers ALL vault lamports → beneficiary.
//!       • Clears vault data.
//!
//! 2 · Cancel      [vault(writable), depositor(signer,writable)]
//!       data: [2u8]
//!       • Returns all vault lamports → depositor.
//!       • Clears vault data.
//!
//! Vault account layout (41 bytes, owned by this program)
//! ────────────────────────────────────────────────────────
//! [0..32]  beneficiary pubkey
//! [32..40] escrowed amount (u64 LE) — informational, Release sends ALL lamports
//! [40]     is_initialized flag (0 = no, 1 = yes)

use solana_account_info::{next_account_info, AccountInfo};
use solana_program_entrypoint::entrypoint;
use solana_program_error::{ProgramError, ProgramResult};
use solana_pubkey::Pubkey;

// ── constants ─────────────────────────────────────────────────────────────────

pub const VAULT_DATA_LEN: usize = 41;

pub const ERR_ALREADY_INITIALIZED:   u32 = 1;
pub const ERR_NOT_INITIALIZED:       u32 = 2;
pub const ERR_WRONG_BENEFICIARY:     u32 = 3;
pub const ERR_WRONG_DEPOSITOR:       u32 = 4;
pub const ERR_DEPOSITOR_NOT_SIGNER:  u32 = 5;
pub const ERR_WRONG_VAULT_OWNER:     u32 = 7;
pub const ERR_INSUFFICIENT_AMOUNT:   u32 = 8;

// ── entrypoint ────────────────────────────────────────────────────────────────

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    match data[0] {
        0 => initialize(program_id, accounts, &data[1..]),
        1 => release(program_id, accounts),
        2 => cancel(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// ── 0: Initialize ─────────────────────────────────────────────────────────────
//
// Expects vault to already be owned by this program and pre-funded with lamports.
// Just validates and writes state. No CPI needed.

fn initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let vault = next_account_info(iter)?;

    // Vault must be owned by this program
    if vault.owner != program_id {
        return Err(ProgramError::Custom(ERR_WRONG_VAULT_OWNER));
    }

    // Must not already be initialized
    {
        let vd = vault.try_borrow_data()?;
        if vd.len() == VAULT_DATA_LEN && vd[40] == 1 {
            return Err(ProgramError::Custom(ERR_ALREADY_INITIALIZED));
        }
    }

    // Parse: [beneficiary: 32 bytes] [amount: 8 bytes]
    if data.len() < 40 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = u64::from_le_bytes(data[32..40].try_into().unwrap());
    if amount == 0 {
        return Err(ProgramError::Custom(ERR_INSUFFICIENT_AMOUNT));
    }

    // Validate vault holds at least the escrowed amount
    if vault.lamports() < amount {
        return Err(ProgramError::InsufficientFunds);
    }

    // Write state
    let mut vd = vault.try_borrow_mut_data()?;
    vd[..32].copy_from_slice(&data[..32]); // beneficiary pubkey
    vd[32..40].copy_from_slice(&amount.to_le_bytes());
    vd[40] = 1; // is_initialized

    Ok(())
}

// ── 1: Release ────────────────────────────────────────────────────────────────

fn release(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let vault       = next_account_info(iter)?;
    let beneficiary = next_account_info(iter)?;

    if vault.owner != program_id {
        return Err(ProgramError::Custom(ERR_WRONG_VAULT_OWNER));
    }

    let stored_beneficiary = {
        let vd = vault.try_borrow_data()?;
        if vd.len() != VAULT_DATA_LEN || vd[40] != 1 {
            return Err(ProgramError::Custom(ERR_NOT_INITIALIZED));
        }
        Pubkey::try_from(&vd[..32]).map_err(|_| ProgramError::InvalidAccountData)?
    };

    if beneficiary.key != &stored_beneficiary {
        return Err(ProgramError::Custom(ERR_WRONG_BENEFICIARY));
    }

    // Transfer all lamports: vault → beneficiary
    let lamports = vault.lamports();
    **vault.try_borrow_mut_lamports()? = 0;
    **beneficiary.try_borrow_mut_lamports()? += lamports;

    // Clear state
    vault.try_borrow_mut_data()?.fill(0);

    Ok(())
}

// ── 2: Cancel ─────────────────────────────────────────────────────────────────

fn cancel(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let vault     = next_account_info(iter)?;
    let depositor = next_account_info(iter)?;

    if vault.owner != program_id {
        return Err(ProgramError::Custom(ERR_WRONG_VAULT_OWNER));
    }
    if !depositor.is_signer {
        return Err(ProgramError::Custom(ERR_DEPOSITOR_NOT_SIGNER));
    }
    {
        let vd = vault.try_borrow_data()?;
        if vd.len() != VAULT_DATA_LEN || vd[40] != 1 {
            return Err(ProgramError::Custom(ERR_NOT_INITIALIZED));
        }
    }

    // Return all lamports: vault → depositor
    let lamports = vault.lamports();
    **vault.try_borrow_mut_lamports()? = 0;
    **depositor.try_borrow_mut_lamports()? += lamports;

    vault.try_borrow_mut_data()?.fill(0);

    Ok(())
}
