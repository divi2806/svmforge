//! # svmforge
//!
//! Node.js bindings for [`mollusk-svm`](https://github.com/anza-xyz/mollusk) —
//! the lightweight Solana program test harness that drives the SVM directly,
//! without a full validator, AccountsDB, or Bank.
//!
//! ## Quick start
//!
//! ```ts
//! import { MolluskSvm, checkSuccess, checkComputeUnits } from 'svmforge';
//!
//! const mollusk = new MolluskSvm(PROGRAM_ID, 'target/deploy/my_program');
//!
//! // processInstruction — returns the full result
//! const result = mollusk.processInstruction(ix, accounts);
//! console.assert(result.success);
//!
//! // processAndValidateInstruction — throws if any check fails
//! mollusk.processAndValidateInstruction(ix, accounts, [
//!   checkSuccess(),
//!   checkComputeUnits(500n),
//! ]);
//! ```

#![deny(clippy::all)]
#![allow(clippy::needless_pass_by_value)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

use mollusk_svm::Mollusk;
use mollusk_svm_result::types::{ProgramResult, TransactionProgramResult};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;
use std::str::FromStr;

// ── parse helper ──────────────────────────────────────────────────────────────

fn parse_pubkey(s: &str) -> Result<Pubkey> {
    Pubkey::from_str(s)
        .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid pubkey '{s}': {e}")))
}

// ── JS-visible data types ─────────────────────────────────────────────────────

/// A Solana account.
///
/// All fields map 1-to-1 to the on-chain `Account` layout.
/// `lamports` and `rentEpoch` are `bigint` to avoid precision loss.
#[napi(object)]
pub struct JsAccount {
    /// Lamports held by the account.
    pub lamports: BigInt,
    /// Raw account data bytes.
    pub data: Buffer,
    /// Base58 public key of the program that owns this account.
    pub owner: String,
    /// Whether the account holds a loaded executable program.
    pub executable: bool,
    /// Epoch at which this account will next owe rent.
    pub rent_epoch: BigInt,
}

/// A `(pubkey, account)` pair — the input unit for `processInstruction`.
#[napi(object)]
pub struct AccountEntry {
    /// Base58 public key.
    pub pubkey: String,
    /// The account state.
    pub account: JsAccount,
}

/// Per-account metadata within an instruction.
#[napi(object)]
pub struct JsAccountMeta {
    /// Base58 public key.
    pub pubkey: String,
    /// Whether this account must sign the transaction.
    pub is_signer: bool,
    /// Whether the instruction may mutate this account.
    pub is_writable: bool,
}

/// A Solana instruction ready to be handed to `processInstruction`.
#[napi(object)]
pub struct JsInstruction {
    /// Base58 public key of the program being invoked.
    pub program_id: String,
    /// Ordered list of accounts the instruction references.
    pub accounts: Vec<JsAccountMeta>,
    /// Raw instruction data bytes.
    pub data: Buffer,
}

/// Final state of a single account after execution.
#[napi(object)]
pub struct ResultAccount {
    /// Base58 public key.
    pub pubkey: String,
    /// Lamports after execution.
    pub lamports: BigInt,
    /// Account data bytes after execution.
    pub data: Buffer,
    /// Owner program public key (base58) after execution.
    pub owner: String,
    /// Whether the account is executable after execution.
    pub executable: bool,
    /// Rent epoch.
    pub rent_epoch: BigInt,
}

/// The complete outcome of a processed instruction.
#[napi(object)]
pub struct InstructionResult {
    /// Human-readable program result: `"success"` or an error description.
    pub program_result: String,
    /// `true` when the program returned `Ok(())`.
    pub success: bool,
    /// Compute units consumed during execution.
    pub compute_units_consumed: BigInt,
    /// Wall-clock execution time in nanoseconds.
    pub execution_time: BigInt,
    /// Bytes written by `set_return_data` (empty `Buffer` if none).
    pub return_data: Buffer,
    /// Final state of every account provided to the instruction, in the
    /// same order they were passed in.
    pub resulting_accounts: Vec<ResultAccount>,
}

/// The outcome of a full transaction (multiple instructions processed atomically).
#[napi(object)]
pub struct TransactionResult {
    /// Human-readable result of the last / failing instruction.
    pub program_result: String,
    /// `true` when all instructions succeeded.
    pub success: bool,
    /// If a failure occurred, the 0-based index of the failing instruction.
    pub failing_instruction_index: Option<u32>,
    /// Total compute units consumed across all instructions.
    pub compute_units_consumed: BigInt,
    /// Wall-clock execution time in nanoseconds.
    pub execution_time: BigInt,
    /// Bytes written by `set_return_data` in the last instruction that produced them.
    pub return_data: Buffer,
    /// Final state of every account provided, in the order they were passed.
    pub resulting_accounts: Vec<ResultAccount>,
}

// ── Check system ──────────────────────────────────────────────────────────────

/// A single validation assertion to run against an `InstructionResult`.
///
/// Use the `check*` factory functions rather than constructing this directly.
///
/// ```ts
/// import { checkSuccess, checkComputeUnits, checkAccountLamports } from 'svmforge';
///
/// mollusk.processAndValidateInstruction(ix, accounts, [
///   checkSuccess(),
///   checkComputeUnits(500n),
///   checkAccountLamports(ALICE, 999_000_000n),
/// ]);
/// ```
#[napi(object)]
pub struct JsCheck {
    /// Discriminant: `"success"` | `"err"` | `"compute_units"` | `"return_data"` | `"account"`.
    pub kind: String,
    // ── err ──
    /// Expected `ProgramError::Custom` error code (for kind = `"err"`).
    pub error_code: Option<u32>,
    // ── compute_units ──
    /// Expected exact CU count (for kind = `"compute_units"`).
    pub compute_units: Option<BigInt>,
    // ── return_data ──
    /// Expected return-data bytes (for kind = `"return_data"`).
    pub return_data: Option<Buffer>,
    // ── account ──
    /// Target account pubkey (for kind = `"account"`).
    pub pubkey: Option<String>,
    /// Expected lamports (for kind = `"account"`).
    pub lamports: Option<BigInt>,
    /// Expected owner pubkey base58 (for kind = `"account"`).
    pub owner: Option<String>,
    /// Expected account data bytes (for kind = `"account"`).
    pub data: Option<Buffer>,
    /// Expected executable flag (for kind = `"account"`).
    pub executable: Option<bool>,
    /// Expected data length in bytes (for kind = `"account"`).
    pub space: Option<u32>,
    /// When `true`, asserts the account was closed / does not exist (for kind = `"account"`).
    pub closed: Option<bool>,
}

// ── Check factory functions ───────────────────────────────────────────────────

/// Assert the program returned `Ok(())`.
#[napi]
pub fn check_success() -> JsCheck {
    JsCheck {
        kind: "success".to_string(),
        error_code: None,
        compute_units: None,
        return_data: None,
        pubkey: None,
        lamports: None,
        owner: None,
        data: None,
        executable: None,
        space: None,
        closed: None,
    }
}

/// Assert the program returned `ProgramError::Custom(code)`.
#[napi]
pub fn check_err(error_code: u32) -> JsCheck {
    JsCheck {
        kind: "err".to_string(),
        error_code: Some(error_code),
        ..check_success()
    }
}

/// Assert the instruction consumed exactly `units` compute units.
#[napi]
pub fn check_compute_units(units: BigInt) -> JsCheck {
    JsCheck {
        kind: "compute_units".to_string(),
        compute_units: Some(units),
        ..check_success()
    }
}

/// Assert the instruction produced exactly `data` as return data.
#[napi]
pub fn check_return_data(data: Buffer) -> JsCheck {
    JsCheck {
        kind: "return_data".to_string(),
        return_data: Some(data),
        ..check_success()
    }
}

/// Assert a resulting account's lamport balance.
#[napi]
pub fn check_account_lamports(pubkey: String, lamports: BigInt) -> JsCheck {
    JsCheck {
        kind: "account".to_string(),
        pubkey: Some(pubkey),
        lamports: Some(lamports),
        ..check_success()
    }
}

/// Assert a resulting account's owner program.
#[napi]
pub fn check_account_owner(pubkey: String, owner: String) -> JsCheck {
    JsCheck {
        kind: "account".to_string(),
        pubkey: Some(pubkey),
        owner: Some(owner),
        ..check_success()
    }
}

/// Assert a resulting account's raw data bytes.
#[napi]
pub fn check_account_data(pubkey: String, data: Buffer) -> JsCheck {
    JsCheck {
        kind: "account".to_string(),
        pubkey: Some(pubkey),
        data: Some(data),
        ..check_success()
    }
}

/// Assert a resulting account's data length in bytes.
#[napi]
pub fn check_account_space(pubkey: String, space: u32) -> JsCheck {
    JsCheck {
        kind: "account".to_string(),
        pubkey: Some(pubkey),
        space: Some(space),
        ..check_success()
    }
}

/// Assert a resulting account's executable flag.
#[napi]
pub fn check_account_executable(pubkey: String, executable: bool) -> JsCheck {
    JsCheck {
        kind: "account".to_string(),
        pubkey: Some(pubkey),
        executable: Some(executable),
        ..check_success()
    }
}

/// Assert that a resulting account is closed (lamports == 0, data empty, owner = system).
#[napi]
pub fn check_account_closed(pubkey: String) -> JsCheck {
    JsCheck {
        kind: "account".to_string(),
        pubkey: Some(pubkey),
        closed: Some(true),
        ..check_success()
    }
}

// ── internal check runner ─────────────────────────────────────────────────────

fn run_js_checks(
    result: &mollusk_svm_result::InstructionResult,
    checks: &[JsCheck],
) -> Result<()> {
    use mollusk_svm_result::types::ProgramResult as PR;
    use solana_program_error::ProgramError;

    for (i, check) in checks.iter().enumerate() {
        let label = format!("Check[{i}] kind={}", check.kind);

        match check.kind.as_str() {
            "success" => {
                if !result.program_result.is_ok() {
                    return Err(Error::new(
                        Status::GenericFailure,
                        format!(
                            "{label}: expected success, got {}",
                            program_result_string(&result.program_result)
                        ),
                    ));
                }
            }
            "err" => {
                let code = check.error_code.unwrap_or(0);
                let expected = PR::Failure(ProgramError::Custom(code));
                if result.program_result != expected {
                    return Err(Error::new(
                        Status::GenericFailure,
                        format!(
                            "{label}: expected ProgramError::Custom({code}), got {}",
                            program_result_string(&result.program_result)
                        ),
                    ));
                }
            }
            "compute_units" => {
                if let Some(expected_cu) = &check.compute_units {
                    let expected = expected_cu.get_u64().1;
                    let actual = result.compute_units_consumed;
                    if actual != expected {
                        return Err(Error::new(
                            Status::GenericFailure,
                            format!("{label}: expected {expected} CUs, got {actual}"),
                        ));
                    }
                }
            }
            "return_data" => {
                if let Some(expected_data) = &check.return_data {
                    let actual = result.return_data.as_slice();
                    let expected = expected_data.as_ref();
                    if actual != expected {
                        return Err(Error::new(
                            Status::GenericFailure,
                            format!(
                                "{label}: return_data mismatch — expected {} bytes, got {} bytes",
                                expected.len(),
                                actual.len()
                            ),
                        ));
                    }
                }
            }
            "account" => {
                let pk_str = check
                    .pubkey
                    .as_deref()
                    .ok_or_else(|| Error::new(Status::InvalidArg, "{label}: pubkey required for account check"))?;
                let pk = parse_pubkey(pk_str)?;
                let account = result
                    .resulting_accounts
                    .iter()
                    .find(|(k, _)| k == &pk)
                    .map(|(_, a)| a);

                if check.closed == Some(true) {
                    let is_closed = account.map_or(true, |a| {
                        a.lamports == 0
                            && a.data.is_empty()
                            && a.owner == Pubkey::default()
                    });
                    if !is_closed {
                        return Err(Error::new(
                            Status::GenericFailure,
                            format!("{label}: account {pk_str} expected to be closed"),
                        ));
                    }
                    continue;
                }

                let acc = account.ok_or_else(|| {
                    Error::new(
                        Status::GenericFailure,
                        format!("{label}: account {pk_str} not found in resulting_accounts"),
                    )
                })?;

                if let Some(expected_lamps) = &check.lamports {
                    let expected = expected_lamps.get_u64().1;
                    if acc.lamports != expected {
                        return Err(Error::new(
                            Status::GenericFailure,
                            format!(
                                "{label}: account {pk_str} lamports — expected {expected}, got {}",
                                acc.lamports
                            ),
                        ));
                    }
                }
                if let Some(expected_owner) = &check.owner {
                    let expected_pk = parse_pubkey(expected_owner)?;
                    if acc.owner != expected_pk {
                        return Err(Error::new(
                            Status::GenericFailure,
                            format!(
                                "{label}: account {pk_str} owner — expected {expected_owner}, got {}",
                                acc.owner
                            ),
                        ));
                    }
                }
                if let Some(expected_data) = &check.data {
                    if acc.data.as_slice() != expected_data.as_ref() {
                        return Err(Error::new(
                            Status::GenericFailure,
                            format!("{label}: account {pk_str} data mismatch"),
                        ));
                    }
                }
                if let Some(expected_space) = check.space {
                    let actual_space = acc.data.len() as u32;
                    if actual_space != expected_space {
                        return Err(Error::new(
                            Status::GenericFailure,
                            format!(
                                "{label}: account {pk_str} space — expected {expected_space}, got {actual_space}"
                            ),
                        ));
                    }
                }
                if let Some(expected_exec) = check.executable {
                    if acc.executable != expected_exec {
                        return Err(Error::new(
                            Status::GenericFailure,
                            format!(
                                "{label}: account {pk_str} executable — expected {expected_exec}, got {}",
                                acc.executable
                            ),
                        ));
                    }
                }
            }
            other => {
                return Err(Error::new(
                    Status::InvalidArg,
                    format!("Unknown check kind: '{other}'"),
                ));
            }
        }
    }
    Ok(())
}

// ── Rust ↔ JS conversions ─────────────────────────────────────────────────────

fn into_account(js: JsAccount) -> Result<Account> {
    let owner = parse_pubkey(&js.owner)?;
    // get_u64() → (is_signed, value, lossless)
    let lamports = js.lamports.get_u64().1;
    let rent_epoch = js.rent_epoch.get_u64().1;
    Ok(Account {
        lamports,
        data: js.data.to_vec(),
        owner,
        executable: js.executable,
        rent_epoch,
    })
}

fn into_instruction(js: JsInstruction) -> Result<Instruction> {
    let program_id = parse_pubkey(&js.program_id)?;
    let accounts = js
        .accounts
        .into_iter()
        .map(|m| {
            let pubkey = parse_pubkey(&m.pubkey)?;
            Ok(if m.is_writable {
                AccountMeta::new(pubkey, m.is_signer)
            } else {
                AccountMeta::new_readonly(pubkey, m.is_signer)
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Instruction {
        program_id,
        accounts,
        data: js.data.to_vec(),
    })
}

fn into_account_list(entries: Vec<AccountEntry>) -> Result<Vec<(Pubkey, Account)>> {
    entries
        .into_iter()
        .map(|e| Ok((parse_pubkey(&e.pubkey)?, into_account(e.account)?)))
        .collect()
}

fn program_result_string(r: &ProgramResult) -> String {
    match r {
        ProgramResult::Success => "success".to_string(),
        ProgramResult::Failure(e) => format!("error: {e}"),
        ProgramResult::UnknownError(e) => format!("unknown_error: {e}"),
    }
}

fn result_accounts(pairs: &[(Pubkey, Account)]) -> Vec<ResultAccount> {
    pairs
        .iter()
        .map(|(pk, acc)| ResultAccount {
            pubkey: pk.to_string(),
            lamports: BigInt::from(acc.lamports),
            data: Buffer::from(acc.data.clone()),
            owner: acc.owner.to_string(),
            executable: acc.executable,
            rent_epoch: BigInt::from(acc.rent_epoch),
        })
        .collect()
}

fn from_mollusk_result(r: mollusk_svm_result::InstructionResult) -> InstructionResult {
    let success = r.program_result.is_ok();
    let program_result = program_result_string(&r.program_result);
    InstructionResult {
        program_result,
        success,
        compute_units_consumed: BigInt::from(r.compute_units_consumed),
        execution_time: BigInt::from(r.execution_time),
        return_data: Buffer::from(r.return_data),
        resulting_accounts: result_accounts(&r.resulting_accounts),
    }
}

fn from_transaction_result(r: mollusk_svm_result::types::TransactionResult) -> TransactionResult {
    let success = r.program_result.is_ok();
    let (program_result_str, failing_idx) = match &r.program_result {
        TransactionProgramResult::Success => ("success".to_string(), None),
        TransactionProgramResult::Failure(idx, e) => (format!("error: {e}"), Some(*idx as u32)),
        TransactionProgramResult::UnknownError(idx, e) => {
            (format!("unknown_error: {e}"), Some(*idx as u32))
        }
    };
    TransactionResult {
        program_result: program_result_str,
        success,
        failing_instruction_index: failing_idx,
        compute_units_consumed: BigInt::from(r.compute_units_consumed),
        execution_time: BigInt::from(r.execution_time),
        return_data: Buffer::from(r.return_data),
        resulting_accounts: result_accounts(&r.resulting_accounts),
    }
}

// ── MolluskSvm class ──────────────────────────────────────────────────────────

/// Lightweight Solana program test harness.
///
/// Drives the SVM directly — no full validator, no AccountsDB, no Bank.
/// You provide accounts explicitly; execution is near-instant.
///
/// ```ts
/// // Testing a custom program
/// const mollusk = new MolluskSvm(MY_PROGRAM_ID, 'target/deploy/my_program');
///
/// // Testing a builtin (system program, token, etc.)
/// const mollusk = MolluskSvm.createDefault();
/// ```
#[napi]
pub struct MolluskSvm {
    inner: Mollusk,
}

// SAFETY: `Mollusk` contains `Option<Rc<RefCell<LogCollector>>>` which is !Send.
// The Rc is only ever created and used on the Node.js main thread; napi-rs
// ensures all JS-triggered method calls execute on that same thread.
// No `MolluskSvm` instance is ever moved to or shared with another OS thread.
unsafe impl Send for MolluskSvm {}

#[napi]
impl MolluskSvm {
    // ── construction ──────────────────────────────────────────────────────────

    /// Load a BPF program and create a test harness.
    ///
    /// @param programId   - Base58 public key of the program under test.
    /// @param programPath - Path to the compiled ELF **without** the `.so`
    ///                      extension (e.g. `"target/deploy/my_program"`).
    ///                      Mollusk appends `.so` automatically and searches
    ///                      `SBF_OUT_DIR` if the path is relative.
    #[napi(constructor)]
    pub fn new(program_id: String, program_path: String) -> Result<Self> {
        let pk = parse_pubkey(&program_id)?;
        Ok(Self {
            inner: Mollusk::new(&pk, &program_path),
        })
    }

    /// Create a harness with **no** custom program loaded.
    ///
    /// Useful when testing instructions that only use builtin programs
    /// (system program, SPL token, compute-budget, etc.).
    #[napi(factory)]
    pub fn create_default() -> Self {
        Self {
            inner: Mollusk::default(),
        }
    }

    // ── core execution ────────────────────────────────────────────────────────

    /// Execute a single instruction and return the full result.
    #[napi]
    pub fn process_instruction(
        &self,
        instruction: JsInstruction,
        accounts: Vec<AccountEntry>,
    ) -> Result<InstructionResult> {
        let ix = into_instruction(instruction)?;
        let accs = into_account_list(accounts)?;
        Ok(from_mollusk_result(
            self.inner.process_instruction(&ix, &accs),
        ))
    }

    /// Execute a single instruction and assert a set of checks.
    /// **Throws** with a descriptive message if any check fails.
    ///
    /// @param checks - Array produced by the `check*` factory functions.
    #[napi]
    pub fn process_and_validate_instruction(
        &self,
        instruction: JsInstruction,
        accounts: Vec<AccountEntry>,
        checks: Vec<JsCheck>,
    ) -> Result<InstructionResult> {
        let ix = into_instruction(instruction)?;
        let accs = into_account_list(accounts)?;
        let raw = self.inner.process_instruction(&ix, &accs);
        run_js_checks(&raw, &checks)?;
        Ok(from_mollusk_result(raw))
    }

    /// Execute a chain of instructions, forwarding account state between steps.
    /// Returns the `InstructionResult` for the **last** instruction.
    #[napi]
    pub fn process_instruction_chain(
        &self,
        instructions: Vec<JsInstruction>,
        accounts: Vec<AccountEntry>,
    ) -> Result<InstructionResult> {
        let ixs = instructions
            .into_iter()
            .map(into_instruction)
            .collect::<Result<Vec<_>>>()?;
        let accs = into_account_list(accounts)?;
        Ok(from_mollusk_result(
            self.inner.process_instruction_chain(&ixs, &accs),
        ))
    }

    /// Execute a chain and assert checks on the final result.
    /// **Throws** if any check fails.
    #[napi]
    pub fn process_and_validate_instruction_chain(
        &self,
        instructions: Vec<JsInstruction>,
        accounts: Vec<AccountEntry>,
        checks: Vec<JsCheck>,
    ) -> Result<InstructionResult> {
        let ixs = instructions
            .into_iter()
            .map(into_instruction)
            .collect::<Result<Vec<_>>>()?;
        let accs = into_account_list(accounts)?;
        let raw = self.inner.process_instruction_chain(&ixs, &accs);
        run_js_checks(&raw, &checks)?;
        Ok(from_mollusk_result(raw))
    }

    /// Execute multiple instructions as a single **transaction** (atomic).
    ///
    /// Unlike `processInstructionChain`, this respects Solana's transaction
    /// semantics: if any instruction fails, the entire transaction is rolled
    /// back and `success` will be `false`.
    ///
    /// Returns a `TransactionResult` that also reports which instruction failed.
    #[napi]
    pub fn process_transaction_instructions(
        &self,
        instructions: Vec<JsInstruction>,
        accounts: Vec<AccountEntry>,
    ) -> Result<TransactionResult> {
        let ixs = instructions
            .into_iter()
            .map(into_instruction)
            .collect::<Result<Vec<_>>>()?;
        let accs = into_account_list(accounts)?;
        Ok(from_transaction_result(
            self.inner.process_transaction_instructions(&ixs, &accs),
        ))
    }

    // ── compute budget ────────────────────────────────────────────────────────

    /// Override the compute-unit limit for all subsequent executions.
    /// Default: 1,400,000 CUs.
    #[napi]
    pub fn set_compute_unit_limit(&mut self, limit: u32) {
        self.inner.compute_budget.compute_unit_limit = u64::from(limit);
    }

    /// Read the current compute-unit limit.
    #[napi]
    pub fn get_compute_unit_limit(&self) -> u32 {
        self.inner.compute_budget.compute_unit_limit as u32
    }

    // ── sysvar helpers ────────────────────────────────────────────────────────

    /// Advance the simulated clock to the given slot.
    ///
    /// Updates `Clock.slot`, `Clock.epoch`, `Clock.leaderScheduleEpoch`,
    /// and the `SlotHashes` sysvar to match.
    #[napi]
    pub fn warp_to_slot(&mut self, slot: BigInt) {
        let s = slot.get_u64().1;
        self.inner.warp_to_slot(s);
    }

    /// Read the current simulated slot.
    #[napi]
    pub fn get_slot(&self) -> BigInt {
        BigInt::from(self.inner.sysvars.clock.slot)
    }

    /// Set `Clock.unixTimestamp`.
    ///
    /// Useful for programs that branch on the wall-clock time.
    #[napi]
    pub fn set_clock_unix_timestamp(&mut self, unix_timestamp: i64) {
        self.inner.sysvars.clock.unix_timestamp = unix_timestamp;
    }

    /// Read the current simulated `Clock.unixTimestamp`.
    #[napi]
    pub fn get_clock_unix_timestamp(&self) -> i64 {
        self.inner.sysvars.clock.unix_timestamp
    }

    /// Set `Clock.epoch`.
    #[napi]
    pub fn set_epoch(&mut self, epoch: BigInt) {
        self.inner.sysvars.clock.epoch = epoch.get_u64().1;
    }

    /// Read the current simulated epoch.
    #[napi]
    pub fn get_epoch(&self) -> BigInt {
        BigInt::from(self.inner.sysvars.clock.epoch)
    }

    // ── rent helpers ──────────────────────────────────────────────────────────

    /// Calculate the minimum lamports needed for rent exemption given `dataLen`.
    ///
    /// ```ts
    /// const lamports = mollusk.getRentMinimumBalance(165); // e.g. token account
    /// ```
    #[napi]
    pub fn get_rent_minimum_balance(&self, data_len: u32) -> BigInt {
        BigInt::from(
            self.inner
                .sysvars
                .rent
                .minimum_balance(data_len as usize),
        )
    }


    // ── feature set ───────────────────────────────────────────────────────────

    /// Deactivate a feature by its feature-gate public key (base58).
    ///
    /// Useful for testing program behaviour under older feature sets.
    ///
    /// ```ts
    /// mollusk.deactivateFeature('someFeaturePubkey...');
    /// ```
    #[napi]
    pub fn deactivate_feature(&mut self, feature_id: String) -> Result<()> {
        let pk = parse_pubkey(&feature_id)?;
        self.inner.feature_set.deactivate(&pk);
        Ok(())
    }
}

// ── module-level convenience constructors ─────────────────────────────────────

/// Build a `JsAccount` owned by the system program with no data.
///
/// ```ts
/// import { systemAccount } from 'svmforge';
/// const alice = systemAccount(1_000_000_000n);
/// ```
#[napi]
pub fn system_account(lamports: BigInt) -> JsAccount {
    JsAccount {
        lamports,
        data: Buffer::from(vec![]),
        owner: solana_system_interface::program::id().to_string(),
        executable: false,
        rent_epoch: BigInt::from(0u64),
    }
}

/// Build an account owned by `owner` with `space` bytes of zeroed data.
///
/// ```ts
/// import { emptyAccount } from 'svmforge';
/// const pda = emptyAccount(MY_PROGRAM_ID, 165, rent_exempt_lamports);
/// ```
#[napi]
pub fn empty_account(owner: String, space: u32, lamports: BigInt) -> Result<JsAccount> {
    parse_pubkey(&owner)?; // validate early
    Ok(JsAccount {
        lamports,
        data: Buffer::from(vec![0u8; space as usize]),
        owner,
        executable: false,
        rent_epoch: BigInt::from(0u64),
    })
}

// ── MolluskContext ────────────────────────────────────────────────────────────

/// Stateful wrapper around `MolluskSvm` with an in-memory account store.
///
/// Unlike `MolluskSvm`, you **do not** pass accounts on every call — the
/// context automatically loads, tracks, and persists account state between
/// instruction executions.
///
/// State is only written back after a **successful** execution.  A failing
/// instruction leaves the store unchanged.
///
/// ```ts
/// import { MolluskContext, systemAccount, checkSuccess } from 'svmforge';
///
/// const ctx = MolluskContext.createDefault();
///
/// // Seed initial account state
/// ctx.setAccount(ALICE, systemAccount(1_000_000_000n));
/// ctx.setAccount(BOB,   systemAccount(0n));
///
/// // No need to pass accounts — the context handles it
/// ctx.processInstruction(transferIx);
///
/// // Inspect resulting state
/// console.log(ctx.getAccount(BOB)?.lamports);
/// ```
#[napi]
pub struct MolluskContext {
    inner: mollusk_svm::MolluskContext<std::collections::HashMap<Pubkey, Account>>,
}

// SAFETY: same reasoning as MolluskSvm — Rc is single-threaded, only ever
// touched from the Node.js main thread via napi-rs dispatch.
unsafe impl Send for MolluskContext {}

#[napi]
impl MolluskContext {
    // ── construction ──────────────────────────────────────────────────────────

    /// Create a stateful context loaded with a specific BPF program.
    ///
    /// @param programId   - Base58 public key of the program under test.
    /// @param programPath - Path to the compiled ELF without the `.so` extension.
    #[napi(constructor)]
    pub fn new(program_id: String, program_path: String) -> Result<Self> {
        let pk = parse_pubkey(&program_id)?;
        Ok(Self {
            inner: Mollusk::new(&pk, &program_path)
                .with_context(std::collections::HashMap::default()),
        })
    }

    /// Create a stateful context with no custom program (builtins only).
    #[napi(factory)]
    pub fn create_default() -> Self {
        Self {
            inner: Mollusk::default().with_context(std::collections::HashMap::default()),
        }
    }

    // ── account store ─────────────────────────────────────────────────────────

    /// Seed or overwrite an account in the store.
    #[napi]
    pub fn set_account(&self, pubkey: String, account: JsAccount) -> Result<()> {
        let pk = parse_pubkey(&pubkey)?;
        let acc = into_account(account)?;
        self.inner
            .account_store
            .borrow_mut()
            .insert(pk, acc);
        Ok(())
    }

    /// Read the current state of an account from the store.
    /// Returns `null` if the account has not been set.
    #[napi]
    pub fn get_account(&self, pubkey: String) -> Result<Option<JsAccount>> {
        let pk = parse_pubkey(&pubkey)?;
        let store = self.inner.account_store.borrow();
        Ok(store.get(&pk).map(|acc| JsAccount {
            lamports:   BigInt::from(acc.lamports),
            data:       Buffer::from(acc.data.clone()),
            owner:      acc.owner.to_string(),
            executable: acc.executable,
            rent_epoch: BigInt::from(acc.rent_epoch),
        }))
    }

    /// Return all (pubkey, account) pairs currently in the store.
    #[napi]
    pub fn get_all_accounts(&self) -> Vec<AccountEntry> {
        self.inner
            .account_store
            .borrow()
            .iter()
            .map(|(pk, acc)| AccountEntry {
                pubkey: pk.to_string(),
                account: JsAccount {
                    lamports:   BigInt::from(acc.lamports),
                    data:       Buffer::from(acc.data.clone()),
                    owner:      acc.owner.to_string(),
                    executable: acc.executable,
                    rent_epoch: BigInt::from(acc.rent_epoch),
                },
            })
            .collect()
    }

    // ── execution ─────────────────────────────────────────────────────────────

    /// Execute an instruction.  Account state is loaded from — and written
    /// back to — the store automatically on success.
    #[napi]
    pub fn process_instruction(&self, instruction: JsInstruction) -> Result<InstructionResult> {
        let ix = into_instruction(instruction)?;
        Ok(from_mollusk_result(self.inner.process_instruction(&ix)))
    }

    /// Execute an instruction and assert checks. **Throws** if any check fails.
    ///
    /// Note: account state is persisted before checks are evaluated.
    /// A failing check means your assertion was wrong, not that the
    /// instruction failed — check `result.success` first if needed.
    #[napi]
    pub fn process_and_validate_instruction(
        &self,
        instruction: JsInstruction,
        checks: Vec<JsCheck>,
    ) -> Result<InstructionResult> {
        let ix = into_instruction(instruction)?;
        let raw = self.inner.process_instruction(&ix);
        run_js_checks(&raw, &checks)?;
        Ok(from_mollusk_result(raw))
    }

    /// Execute a chain of instructions, forwarding account state between steps.
    #[napi]
    pub fn process_instruction_chain(
        &self,
        instructions: Vec<JsInstruction>,
    ) -> Result<InstructionResult> {
        let ixs = instructions
            .into_iter()
            .map(into_instruction)
            .collect::<Result<Vec<_>>>()?;
        Ok(from_mollusk_result(self.inner.process_instruction_chain(&ixs)))
    }

    /// Execute multiple instructions as a single atomic transaction.
    #[napi]
    pub fn process_transaction_instructions(
        &self,
        instructions: Vec<JsInstruction>,
    ) -> Result<TransactionResult> {
        let ixs = instructions
            .into_iter()
            .map(into_instruction)
            .collect::<Result<Vec<_>>>()?;
        Ok(from_transaction_result(
            self.inner.process_transaction_instructions(&ixs),
        ))
    }

    // ── config (delegates to inner.mollusk) ───────────────────────────────────

    /// Override the compute-unit limit for this context.
    #[napi]
    pub fn set_compute_unit_limit(&mut self, limit: u32) {
        self.inner.mollusk.compute_budget.compute_unit_limit = u64::from(limit);
    }

    /// Advance the simulated clock to the given slot.
    #[napi]
    pub fn warp_to_slot(&mut self, slot: BigInt) {
        self.inner.mollusk.warp_to_slot(slot.get_u64().1);
    }

    /// Set `Clock.unixTimestamp`.
    #[napi]
    pub fn set_clock_unix_timestamp(&mut self, unix_timestamp: i64) {
        self.inner.mollusk.sysvars.clock.unix_timestamp = unix_timestamp;
    }

    /// Calculate the minimum lamports for rent exemption given `dataLen`.
    #[napi]
    pub fn get_rent_minimum_balance(&self, data_len: u32) -> BigInt {
        BigInt::from(
            self.inner
                .mollusk
                .sysvars
                .rent
                .minimum_balance(data_len as usize),
        )
    }
}

// ── SPL program IDs ───────────────────────────────────────────────────────────

/// Program ID for SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
#[napi]
pub const SPL_TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/// Program ID for SPL Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`)
#[napi]
pub const SPL_TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/// Program ID for Associated Token Account (`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`)
#[napi]
pub const ASSOCIATED_TOKEN_PROGRAM_ID: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/// Program ID for SPL Memo (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`)
#[napi]
pub const MEMO_PROGRAM_ID: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// ── SPL program loaders — MolluskSvm ──────────────────────────────────────────

#[napi]
impl MolluskSvm {
    /// Load the bundled SPL Token program into this harness.
    ///
    /// After calling this, any instruction that CPIs into SPL Token will work
    /// without needing to provide the program account or any `.so` file.
    ///
    /// ```ts
    /// const svm = new MolluskSvm(MY_PROGRAM_ID, 'target/deploy/my_program');
    /// svm.addSplToken();
    /// ```
    #[napi]
    pub fn add_spl_token(&mut self) {
        mollusk_svm_programs_token::token::add_program(&mut self.inner);
    }

    /// Load the bundled SPL Token-2022 program into this harness.
    #[napi]
    pub fn add_spl_token_2022(&mut self) {
        mollusk_svm_programs_token::token2022::add_program(&mut self.inner);
    }

    /// Load the bundled SPL Associated Token Account program into this harness.
    #[napi]
    pub fn add_associated_token(&mut self) {
        mollusk_svm_programs_token::associated_token::add_program(&mut self.inner);
    }

    /// Load the bundled SPL Memo program into this harness.
    #[napi]
    pub fn add_memo(&mut self) {
        mollusk_svm_programs_memo::memo::add_program(&mut self.inner);
    }
}

// ── SPL program loaders — MolluskContext ──────────────────────────────────────

#[napi]
impl MolluskContext {
    /// Load the bundled SPL Token program into this context.
    #[napi]
    pub fn add_spl_token(&mut self) {
        mollusk_svm_programs_token::token::add_program(&mut self.inner.mollusk);
    }

    /// Load the bundled SPL Token-2022 program into this context.
    #[napi]
    pub fn add_spl_token_2022(&mut self) {
        mollusk_svm_programs_token::token2022::add_program(&mut self.inner.mollusk);
    }

    /// Load the bundled SPL Associated Token Account program into this context.
    #[napi]
    pub fn add_associated_token(&mut self) {
        mollusk_svm_programs_token::associated_token::add_program(&mut self.inner.mollusk);
    }

    /// Load the bundled SPL Memo program into this context.
    #[napi]
    pub fn add_memo(&mut self) {
        mollusk_svm_programs_memo::memo::add_program(&mut self.inner.mollusk);
    }
}

// ── Fixture support ───────────────────────────────────────────────────────────
//
// Gated behind the `fuzz` cargo feature:
//   mollusk-svm = { features = ["fuzz"] }
//   mollusk-svm-fuzz-fixture in [dependencies]

#[cfg(feature = "fuzz")]
impl MolluskSvm {
    fn load_fixture(path: &str) -> Result<mollusk_svm_fuzz_fixture::Fixture> {
        let fixture = if path.ends_with(".json") {
            mollusk_svm_fuzz_fixture::Fixture::load_from_json_file(path)
        } else {
            mollusk_svm_fuzz_fixture::Fixture::load_from_blob_file(path)
        };
        Ok(fixture)
    }
}

/// Process a Mollusk fuzz fixture file and return the result.
///
/// Automatically detects format: `.json` → JSON fixture, anything else →
/// protobuf blob.
///
/// Loading a fixture **overwrites** compute budget, feature set, and sysvars
/// on the `MolluskSvm` instance with values from the fixture.
///
/// ```ts
/// import { MolluskSvm } from 'svmforge';
/// const mollusk = new MolluskSvm(PROGRAM_ID, 'target/deploy/my_program');
/// const result  = mollusk.processFixtureFile('./fixtures/transfer.pb');
/// console.assert(result.success);
/// ```
#[napi]
#[cfg(feature = "fuzz")]
impl MolluskSvm {
    pub fn process_fixture_file(&mut self, path: String) -> Result<InstructionResult> {
        let fixture = Self::load_fixture(&path)?;
        Ok(from_mollusk_result(self.inner.process_fixture(&fixture)))
    }

    /// Process a fixture and compare the result against the fixture's expected
    /// effects.  **Throws** if the result does not match.
    pub fn process_and_validate_fixture_file(&mut self, path: String) -> Result<InstructionResult> {
        let fixture = Self::load_fixture(&path)?;
        Ok(from_mollusk_result(
            self.inner.process_and_validate_fixture(&fixture),
        ))
    }
}
