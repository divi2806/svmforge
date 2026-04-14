# svmforge

**Lightweight Solana SVM program test harness for Node.js / TypeScript**

```bash
npm install svmforge
```

---

## The Problem

Before svmforge, Solana developers writing TypeScript — SDK authors, dApp teams, Anchor users — had two testing options:

### Option 1: `solana-test-validator`
Spin up a full local validator process, wait 3–10 seconds for it to boot, then talk to it over RPC. It's the real deal, but:
- **Slow startup** — every test run waits for the validator to initialize
- **External process** — your test suite depends on a subprocess; CI setup is painful
- **Hard to control** — injecting specific account state, setting the clock to a particular timestamp, or deactivating a feature gate requires special tooling and RPC calls
- **Non-deterministic** — background block production can interfere with timing-sensitive tests

### Option 2: `solana-bankrun` (the existing TypeScript harness)
Better — no external process — but it compiles the Solana bank to WASM, which means:
- You're running the bank layer (with all its overhead) compiled through WASM
- Slower than native code
- WASM size can be significant
- Less direct access to SVM internals

### What was missing entirely
`mollusk-svm` — Anza's purpose-built SVM testing library — existed only in Rust. Rust developers could drive the SVM directly (no bank, no AccountsDB, pure execution) for extremely fast, isolated tests. **TypeScript developers had no equivalent.**

---

## What svmforge solves

svmforge brings `mollusk-svm`'s approach to TypeScript. It's a **native Node.js addon** (a `.node` binary built from Rust using [napi-rs](https://napi.rs/)) that calls directly into the same `solana-svm` crate that mainnet validators use — just without everything around it.

**What this means for you:**

| | `solana-test-validator` | `solana-bankrun` | **svmforge** |
|---|---|---|---|
| Startup time | 3–10 seconds | ~100 ms | **~0 ms** |
| External process required | Yes | No | No |
| Native speed | Yes (validator) | No (WASM) | **Yes (native .node)** |
| Precise account control | Partial | Yes | **Yes** |
| Stateful account store | Via RPC | Yes | **Yes (MolluskContext)** |
| Clock / feature control | Limited | Partial | **Yes** |
| Works offline | No | Yes | **Yes** |
| TypeScript types | No | Yes | **Yes** |

**The core insight**: for unit testing a Solana program, you don't need a validator. You need exactly what the SVM needs — the instruction, the accounts it touches, and the feature set. svmforge provides that minimal surface, nothing more.

---

## How it works

```
Your TypeScript test
        │
        ▼
  svmforge (napi-rs .node binary)
        │
        ▼
  mollusk-svm (Rust crate)
        │
        ▼
  solana-svm (the actual SVM)
        │
        ▼
  Your program executes
```

You provide:
1. The program you want to test (compiled `.so` ELF, or a builtin like the System Program)
2. The accounts the instruction needs
3. The instruction data

svmforge hands these directly to the SVM, captures the result, and returns it. No RPC, no bank, no block production — pure execution.

---

## Installation

### New project from scratch

```bash
mkdir my-solana-tests && cd my-solana-tests
npm init -y

# svmforge itself
npm install svmforge

# test runner + TypeScript (choose jest or vitest)
npm install --save-dev jest ts-jest typescript @types/jest @types/node
```

Add a minimal `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true
  }
}
```

Add Jest config to `package.json`:
```json
{
  "scripts": {
    "test": "jest"
  },
  "jest": {
    "testEnvironment": "node",
    "transform": {
      "^.+\\.tsx?$": ["ts-jest", { "tsconfig": "tsconfig.json" }]
    },
    "testRegex": ".*\\.spec\\.ts$"
  }
}
```

### Adding to an existing project

```bash
npm install svmforge
```

> **Requirements**: Node.js >= 18. Pre-built native binaries are included for macOS (Apple Silicon + Intel), Linux (x64 + arm64 glibc), and Windows (x64). No Rust toolchain required to use svmforge itself.

---

## Quick Start

### 1. Test a builtin program (no ELF needed)

```typescript
import {
  MolluskSvm,
  systemAccount,
  checkSuccess,
  checkAccountLamports,
} from 'svmforge';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const ALICE = 'ALiCePubkey...'; // base58 pubkey
const BOB   = 'B0bPubkey...';

// Build a System Program Transfer instruction
function transferIx(from: string, to: string, lamports: bigint) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);           // variant 2 = Transfer
  data.writeBigUInt64LE(lamports, 4);
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [
      { pubkey: from, isSigner: true,  isWritable: true },
      { pubkey: to,   isSigner: false, isWritable: true },
    ],
    data,
  };
}

const svm = MolluskSvm.createDefault();

// Execute and validate in one step — throws with a clear message if any check fails
svm.processAndValidateInstruction(
  transferIx(ALICE, BOB, 500_000_000n),
  [
    { pubkey: ALICE, account: systemAccount(1_000_000_000n) },
    { pubkey: BOB,   account: systemAccount(0n) },
  ],
  [
    checkSuccess(),
    checkAccountLamports(ALICE, 500_000_000n),
    checkAccountLamports(BOB,   500_000_000n),
  ],
);
```

### 2. Test your own program

```typescript
import { MolluskSvm, emptyAccount, checkSuccess, checkAccountOwner } from 'svmforge';

const MY_PROGRAM = 'YourProgramPubkey...';

// Load the compiled ELF (Mollusk appends .so automatically)
const svm = new MolluskSvm(MY_PROGRAM, 'target/deploy/my_program');

const rentLamports = svm.getRentMinimumBalance(165); // calculate rent-exempt balance

const result = svm.processInstruction(
  myProgramIx,
  [
    { pubkey: AUTHORITY,  account: systemAccount(10_000_000_000n) },
    { pubkey: STATE_ACCOUNT, account: emptyAccount(MY_PROGRAM, 165, rentLamports) },
  ],
);

console.log(result.success);               // true / false
console.log(result.computeUnitsConsumed);  // bigint
console.log(result.resultingAccounts);     // final state of all accounts
```

### 3. Stateful multi-step tests (MolluskContext)

```typescript
import { MolluskContext, systemAccount, checkSuccess } from 'svmforge';

const ctx = MolluskContext.createDefault();

// Seed accounts once — the context remembers them
ctx.setAccount(ALICE, systemAccount(10_000_000_000n));
ctx.setAccount(BOB,   systemAccount(0n));

// No need to pass accounts on every call
ctx.processInstruction(transferIx(ALICE, BOB, 1_000_000_000n));
ctx.processInstruction(transferIx(ALICE, BOB, 2_000_000_000n));

// Inspect state at any point
console.log(ctx.getAccount(ALICE)?.lamports); // 7_000_000_000n
console.log(ctx.getAccount(BOB)?.lamports);   // 3_000_000_000n
```

---

## Core Concepts

### Instructions

Every instruction is a plain object — no web3.js dependency required:

```typescript
import { JsInstruction } from 'svmforge';

const ix: JsInstruction = {
  programId: 'ProgramPubkey...',   // base58 string
  accounts: [
    { pubkey: 'Alice...', isSigner: true,  isWritable: true  },
    { pubkey: 'Bob...',   isSigner: false, isWritable: false },
  ],
  data: Buffer.from([1, 2, 3, 4]),  // raw instruction bytes
};
```

If you're using **Anchor**, build the instruction with `program.methods.xxx().instruction()` and convert:

```typescript
const anchorIx = await program.methods.initialize(amount).accounts({...}).instruction();

const ix: JsInstruction = {
  programId: anchorIx.programId.toBase58(),
  accounts: anchorIx.keys.map(k => ({
    pubkey:      k.pubkey.toBase58(),
    isSigner:    k.isSigner,
    isWritable:  k.isWritable,
  })),
  data: Buffer.from(anchorIx.data),
};
```

### Accounts

Accounts map directly to the on-chain `Account` layout. Use helpers for common cases:

```typescript
import { systemAccount, emptyAccount } from 'svmforge';

// Wallet / plain SOL holder
const wallet = systemAccount(1_000_000_000n); // 1 SOL

// Uninitialized PDA with space for your data
const rentLamports = svm.getRentMinimumBalance(165);
const pda = emptyAccount(MY_PROGRAM_ID, 165, rentLamports);

// Full manual control
const custom = {
  lamports:   1_000_000_000n,
  data:       Buffer.from(mySerializedData),
  owner:      MY_PROGRAM_ID,
  executable: false,
  rentEpoch:  0n,
};
```

> **Note**: `lamports` and `rentEpoch` are `bigint` — always use the `n` suffix (`1_000_000_000n`) or `BigInt()`. See [Working with bigint](#working-with-bigint).

### Results

`processInstruction` returns an `InstructionResult` with everything you need to inspect:

```typescript
const result = svm.processInstruction(ix, accounts);

result.success                // boolean — did the program return Ok(())?
result.programResult          // string — "success" or "error: InsufficientFunds"
result.computeUnitsConsumed   // bigint — exact CUs used
result.executionTime          // bigint — nanoseconds (wall clock)
result.returnData             // Buffer — bytes from set_return_data (empty if none)
result.resultingAccounts      // ResultAccount[] — final state of every account
```

Access individual accounts after execution:

```typescript
const aliceAfter = result.resultingAccounts.find(a => a.pubkey === ALICE);
console.log(aliceAfter?.lamports); // bigint
console.log(aliceAfter?.data);     // Buffer
console.log(aliceAfter?.owner);    // string (base58)
```

### Check validators

Instead of manually inspecting results, declare what you expect:

```typescript
import {
  checkSuccess,            // program returned Ok(())
  checkErr,                // program returned ProgramError::Custom(code)
  checkComputeUnits,       // exact CU count
  checkReturnData,         // exact return data bytes
  checkAccountLamports,    // account balance
  checkAccountOwner,       // account owner changed
  checkAccountData,        // raw account bytes
  checkAccountSpace,       // data length
  checkAccountExecutable,  // executable flag
  checkAccountClosed,      // account was deleted (lamports=0, empty data)
} from 'svmforge';

svm.processAndValidateInstruction(ix, accounts, [
  checkSuccess(),
  checkComputeUnits(5000n),
  checkAccountLamports(BOB,  1_500_000_000n),
  checkAccountOwner(PDA,     MY_PROGRAM_ID),
  checkAccountClosed(OLD_PDA),
]);
// Throws with a clear message like:
// "Check[2] kind=account: account Bob lamports — expected 1500000000, got 900000000"
```

### MolluskSvm vs MolluskContext

| | `MolluskSvm` | `MolluskContext` |
|---|---|---|
| Account passing | Explicit on every call | Seeded once, auto-managed |
| State between calls | Not persisted | Persisted on success |
| Best for | Isolated unit tests | Multi-step / stateful flows |
| Account arg on execution | Required | Not needed |

---

## API Reference

### MolluskSvm

#### Construction

```typescript
// Load a custom BPF program
new MolluskSvm(programId: string, programPath: string)

// No custom program — use only builtins (system program, SPL token, etc.)
MolluskSvm.createDefault(): MolluskSvm
```

`programPath` is the path to the compiled `.so` file **without** the `.so` extension. Mollusk appends it automatically and also searches the `SBF_OUT_DIR` environment variable for relative paths.

#### Execution

```typescript
// Run one instruction, get full result
processInstruction(
  instruction: JsInstruction,
  accounts: AccountEntry[],
): InstructionResult

// Run one instruction + assert checks (throws on failure)
processAndValidateInstruction(
  instruction: JsInstruction,
  accounts: AccountEntry[],
  checks: JsCheck[],
): InstructionResult

// Run multiple instructions — state flows forward between each step
// Returns the result of the LAST instruction
processInstructionChain(
  instructions: JsInstruction[],
  accounts: AccountEntry[],
): InstructionResult

// Chain with post-execution validation
processAndValidateInstructionChain(
  instructions: JsInstruction[],
  accounts: AccountEntry[],
  checks: JsCheck[],
): InstructionResult

// Run multiple instructions as ONE atomic transaction
// If any fails → full rollback, TransactionResult.success = false
processTransactionInstructions(
  instructions: JsInstruction[],
  accounts: AccountEntry[],
): TransactionResult
```

**`processInstructionChain` vs `processTransactionInstructions`:**
- `chain` — feeds each instruction's output accounts into the next; if one fails, earlier results are still returned
- `transaction` — atomic: all succeed or all roll back, just like on-chain transactions

#### Compute budget

```typescript
setComputeUnitLimit(limit: number): void  // default: 1_400_000
getComputeUnitLimit(): number
```

#### Sysvar / clock control

```typescript
warpToSlot(slot: bigint): void       // advance the clock to a specific slot
getSlot(): bigint

setClockUnixTimestamp(ts: number): void  // set the unix timestamp
getClockUnixTimestamp(): number

setEpoch(epoch: bigint): void
getEpoch(): bigint
```

Useful for programs with time-gated logic (vesting, auctions, expiry).

#### Rent

```typescript
getRentMinimumBalance(dataLen: number): bigint
```

Calculate rent-exempt lamports for a given data size.

#### Feature gates

```typescript
deactivateFeature(featureId: string): void
```

Simulate older network behaviour by deactivating specific feature gates.

---

### MolluskContext

All execution methods mirror `MolluskSvm` but **without** the `accounts` argument — the context handles it automatically.

#### Construction

```typescript
new MolluskContext(programId: string, programPath: string)
MolluskContext.createDefault(): MolluskContext
```

#### Account store

```typescript
setAccount(pubkey: string, account: JsAccount): void
// Seed or overwrite. Call this before execution.

getAccount(pubkey: string): JsAccount | null
// Read current state. Returns null for unknown keys.

getAllAccounts(): AccountEntry[]
// All (pubkey, account) pairs in the store.
```

#### Execution (no accounts arg)

```typescript
processInstruction(instruction: JsInstruction): InstructionResult
processAndValidateInstruction(instruction: JsInstruction, checks: JsCheck[]): InstructionResult
processInstructionChain(instructions: JsInstruction[]): InstructionResult
processTransactionInstructions(instructions: JsInstruction[]): TransactionResult
```

#### Config

```typescript
setComputeUnitLimit(limit: number): void
warpToSlot(slot: bigint): void
setClockUnixTimestamp(ts: number): void
getRentMinimumBalance(dataLen: number): bigint
```

---

### Check factory functions

| Function | What it asserts |
|---|---|
| `checkSuccess()` | Program returned `Ok(())` |
| `checkErr(code: number)` | Program returned `ProgramError::Custom(code)` |
| `checkComputeUnits(units: bigint)` | Exact compute units consumed |
| `checkReturnData(data: Buffer)` | Exact return data bytes |
| `checkAccountLamports(pubkey, lamports: bigint)` | Account SOL balance |
| `checkAccountOwner(pubkey, owner: string)` | Account owner program |
| `checkAccountData(pubkey, data: Buffer)` | Raw account data bytes |
| `checkAccountSpace(pubkey, space: number)` | Data length in bytes |
| `checkAccountExecutable(pubkey, executable: boolean)` | Executable flag |
| `checkAccountClosed(pubkey)` | Account closed (lamports=0, empty data, system owner) |

All check functions return a `JsCheck` object. Pass an array of them to any `processAndValidate*` method.

---

### Account helper functions

```typescript
systemAccount(lamports: bigint): JsAccount
// A system-program-owned account with no data. Use for wallets.

emptyAccount(owner: string, space: number, lamports: bigint): JsAccount
// An account owned by `owner` with `space` bytes of zeroed data.
// Use for uninitialised PDAs.
```

---

### Types

```typescript
interface JsAccount {
  lamports:   bigint;
  data:       Buffer;
  owner:      string;    // base58
  executable: boolean;
  rentEpoch:  bigint;
}

interface AccountEntry {
  pubkey:  string;       // base58
  account: JsAccount;
}

interface JsAccountMeta {
  pubkey:      string;   // base58
  isSigner:    boolean;
  isWritable:  boolean;
}

interface JsInstruction {
  programId:  string;           // base58
  accounts:   JsAccountMeta[];
  data:       Buffer;
}

interface InstructionResult {
  programResult:         string;   // "success" | "error: ..."
  success:               boolean;
  computeUnitsConsumed:  bigint;
  executionTime:         bigint;   // nanoseconds
  returnData:            Buffer;
  resultingAccounts:     ResultAccount[];
}

interface ResultAccount {
  pubkey:      string;   // base58
  lamports:    bigint;
  data:        Buffer;
  owner:       string;   // base58
  executable:  boolean;
  rentEpoch:   bigint;
}

interface TransactionResult extends InstructionResult {
  failingInstructionIndex: number | null;
}
```

---

## SPL Token / Token-2022 / ATA / Memo (zero toolchain)

svmforge ships with ELF binaries for the four most-used Solana programs embedded directly in the `.node` binary. No `.so` files, no Solana toolchain, no `solana-test-validator` — just call one method:

```typescript
import {
  MolluskSvm,
  SPL_TOKEN_PROGRAM_ID,
  SPL_TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MEMO_PROGRAM_ID,
} from 'svmforge';

const svm = MolluskSvm.createDefault();

svm.addSplToken();          // SPL Token (classic)
svm.addSplToken2022();      // SPL Token-2022
svm.addAssociatedToken();   // Associated Token Account
svm.addMemo();              // Memo program
```

The same methods are available on `MolluskContext`:

```typescript
const ctx = MolluskContext.createDefault();
ctx.addSplToken();
```

Once loaded, any instruction in your test that CPIs into that program will execute the real ELF — including complex token operations like `Transfer`, `MintTo`, `Burn`, `CreateAssociatedTokenAccount`, etc.

### Program ID constants

```typescript
SPL_TOKEN_PROGRAM_ID          // "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
SPL_TOKEN_2022_PROGRAM_ID     // "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
ASSOCIATED_TOKEN_PROGRAM_ID   // "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
MEMO_PROGRAM_ID               // "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
```

Use these constants as the `programId` when building SPL instructions, so you never have to hardcode a base58 string.

### Example: SPL Token Transfer

```typescript
import { MolluskSvm, MolluskContext, SPL_TOKEN_PROGRAM_ID, checkSuccess } from 'svmforge';

// Build SPL Token Transfer instruction (variant 3)
function splTransferIx(source: string, dest: string, owner: string, amount: bigint) {
  const data = Buffer.alloc(9);
  data[0] = 3; // Transfer
  data.writeBigUInt64LE(amount, 1);
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

const ctx = MolluskContext.createDefault();
ctx.addSplToken(); // load bundled ELF — zero setup

ctx.setAccount(SOURCE, myTokenAccount);
ctx.setAccount(DEST,   destinationTokenAccount);

ctx.processAndValidateInstruction(
  splTransferIx(SOURCE, DEST, OWNER, 500_000_000n),
  [checkSuccess()],
);
```

See [`examples/03_spl_token_cpi.ts`](./examples/03_spl_token_cpi.ts) for a full runnable example including reading token balances from raw account data.

---

## Gotchas

### Field names are camelCase — always

svmforge uses [napi-rs](https://napi.rs/) to generate its TypeScript bindings. napi-rs **always converts Rust `snake_case` field names to TypeScript `camelCase`**. This is hardcoded — you cannot opt out.

| Rust field | TypeScript field |
|---|---|
| `is_signer` | `isSigner` |
| `is_writable` | `isWritable` |
| `rent_epoch` | `rentEpoch` |
| `program_id` | `programId` |
| `compute_units_consumed` | `computeUnitsConsumed` |
| `resulting_accounts` | `resultingAccounts` |
| `return_data` | `returnData` |
| `failing_instruction_index` | `failingInstructionIndex` |

**The fix**: always use the generated `index.d.ts` as the source of truth, not the underlying Rust struct names. Your IDE will show you the correct names via IntelliSense the moment you type `result.` or `{ pubkey:`. TypeScript will also catch wrong names at compile time.

> If you're coming from the Rust `mollusk-svm` crate and copy-pasting struct field names, every `snake_case` name will be a compile error in TypeScript. Just rename them — it takes 10 seconds.

### `lamports` and `rentEpoch` are `bigint`, not `number`

JavaScript's `Number` type can only represent integers up to 2^53 − 1 (~9 quadrillion). Large SOL balances and epoch values overflow that. svmforge uses `bigint` for all lamport and epoch fields. Always use the `n` suffix:

```typescript
// Wrong — silently loses precision for large values
const balance = 10_000_000_000; // number

// Correct
const balance = 10_000_000_000n; // bigint
```

You cannot mix `bigint` and `number` in arithmetic. If you need to convert:
```typescript
Number(result.computeUnitsConsumed) // safe — CU counts fit in Number
```

### `programPath` does not include the `.so` extension

```typescript
// Wrong
new MolluskSvm(PROGRAM_ID, 'target/deploy/my_program.so');

// Correct — Mollusk appends .so automatically
new MolluskSvm(PROGRAM_ID, 'target/deploy/my_program');
```

### Custom programs need `SBF_OUT_DIR` for relative paths

When using a relative path for your program, set the `SBF_OUT_DIR` env variable so Mollusk knows where to look:

```bash
SBF_OUT_DIR=./target/deploy npx jest
```

Or set it in your `jest` config / test runner. Absolute paths work without it.

### All accounts touched by the instruction must be passed

The SVM does not fetch missing accounts — it only sees what you give it. If your instruction references an account you forgot to pass, the program will typically receive a zeroed/default account, which may cause unexpected failures or panics.

```typescript
// Missing the escrow account — program sees zeroed data for it
svm.processInstruction(ix, [
  { pubkey: AUTHORITY, account: systemAccount(10_000_000_000n) },
  // ← ESCROW missing — this will likely fail or behave incorrectly
]);
```

---

## Examples

Full runnable examples are in [`examples/`](./examples/).

### Example 1 — System Program Transfer (`examples/01_system_transfer.ts`)

Shows `MolluskSvm` from scratch: constructing instructions manually, passing accounts, inspecting results both manually and with check helpers.

```bash
npx ts-node examples/01_system_transfer.ts
```

Key pattern:
```typescript
const svm = MolluskSvm.createDefault();

// Manual inspection
const result = svm.processInstruction(ix, accounts);
const bobAfter = result.resultingAccounts.find(a => a.pubkey === BOB)!;
console.assert(bobAfter.lamports === expectedBalance);

// Or declare expectations upfront
svm.processAndValidateInstruction(ix, accounts, [
  checkSuccess(),
  checkAccountLamports(BOB, expectedBalance),
]);
```

---

### Example 2 — Escrow Simulation (`examples/02_escrow_simulation.ts`)

Shows `MolluskContext` for a two-step escrow flow: deposit → release. Also demonstrates:
- `processInstructionChain` — both steps in one call
- `processTransactionInstructions` — transaction rollback when an instruction fails

```bash
npx ts-node examples/02_escrow_simulation.ts
```

Key pattern:
```typescript
const ctx = MolluskContext.createDefault();
ctx.setAccount(ALICE,  systemAccount(10_000_000_000n));
ctx.setAccount(ESCROW, systemAccount(500_000_000n));
ctx.setAccount(BOB,    systemAccount(500_000_000n));

// Step 1: Alice deposits
ctx.processAndValidateInstruction(transferIx(ALICE, ESCROW, 3_000_000_000n), [checkSuccess()]);

// Step 2: Escrow releases — accounts auto-loaded with state from step 1
ctx.processAndValidateInstruction(
  transferIx(ESCROW, BOB, 3_000_000_000n),
  [checkSuccess(), checkAccountLamports(BOB, 3_500_000_000n)],
);
```

---

### Example 3 — Anchor program integration

For an Anchor program at `target/deploy/my_escrow.so`:

```typescript
import { MolluskSvm, emptyAccount, checkSuccess, checkAccountOwner } from 'svmforge';

const PROGRAM_ID = 'YourProgramId...';

const svm = new MolluskSvm(PROGRAM_ID, 'target/deploy/my_escrow');

// Build the Anchor instruction
const anchorIx = await program.methods
  .initialize(new BN(1_000_000))
  .accounts({ escrow: escrowPda, authority: wallet.publicKey })
  .instruction();

// Convert for svmforge
const ix = {
  programId: anchorIx.programId.toBase58(),
  accounts: anchorIx.keys.map(k => ({
    pubkey:     k.pubkey.toBase58(),
    isSigner:   k.isSigner,
    isWritable: k.isWritable,
  })),
  data: Buffer.from(anchorIx.data),
};

const space = 200; // size of your Escrow account struct
const rentLamports = svm.getRentMinimumBalance(space);

svm.processAndValidateInstruction(
  ix,
  [
    { pubkey: wallet.publicKey.toBase58(), account: systemAccount(10_000_000_000n) },
    { pubkey: escrowPda.toBase58(),        account: emptyAccount(PROGRAM_ID, space, rentLamports) },
  ],
  [
    checkSuccess(),
    checkAccountOwner(escrowPda.toBase58(), PROGRAM_ID),
    checkAccountSpace(escrowPda.toBase58(), space),
  ],
);
```

---

## Working with bigint

`lamports`, `rentEpoch`, and compute unit counts are all `bigint` to avoid JavaScript's 53-bit integer precision limit. 1 SOL = 1,000,000,000 lamports — large balances quickly overflow `Number.MAX_SAFE_INTEGER`.

```typescript
// Always use the 'n' suffix
const ONE_SOL    = 1_000_000_000n;
const FIVE_SOL   = 5_000_000_000n;
const RENT_EPOCH = 0n;

// Arithmetic works as normal
const total      = ONE_SOL + FIVE_SOL;   // 6_000_000_000n
const half       = FIVE_SOL / 2n;        // 2_500_000_000n

// Comparison
if (result.computeUnitsConsumed > 200_000n) {
  console.log('High CU usage');
}

// Convert to Number only if you're certain it fits
const cuAsNumber = Number(result.computeUnitsConsumed); // safe for CU counts
```

---

## Fixtures (fuzz / Firedancer)

svmforge supports Mollusk's protobuf fixture format used for differential fuzz testing against Firedancer. This requires building from source with the `fuzz` cargo feature.

Enable in `Cargo.toml`:
```toml
[features]
fuzz = ["mollusk-svm/fuzz", "dep:mollusk-svm-fuzz-fixture"]
```

Build with the feature:
```bash
napi build --platform --release --features fuzz
```

Usage:
```typescript
const svm = new MolluskSvm(PROGRAM_ID, 'target/deploy/my_program');

// Execute a protobuf fixture and return the result
const result = svm.processFixtureFile('./fixtures/my_test.pb');

// Execute and validate against the fixture's expected effects (throws on mismatch)
svm.processAndValidateFixtureFile('./fixtures/my_test.pb');
```

Both `.pb` (binary protobuf) and `.json` formats are auto-detected by extension.

---

## Platform support

Pre-built binaries are included for all major platforms:

| OS | Architecture | Support |
|---|---|---|
| macOS | Apple Silicon (arm64) | Tier 1 |
| macOS | Intel (x64) | Tier 1 |
| Linux | x64 (glibc) | Tier 1 |
| Linux | arm64 (glibc) | Tier 1 |
| Windows | x64 (MSVC) | Tier 1 |
| Linux musl (Alpine) | any | Not supported |

---

## Publishing

svmforge follows the [napi-rs](https://napi.rs/) platform sub-package convention. The main `svmforge` package specifies five platform packages as `optionalDependencies`. npm installs only the one matching your OS and CPU.

### Build locally

```bash
cd node
npm install
npm run build       # release build for current platform
npm run build:debug # faster debug build
npm test            # run test suite
```

Requirements: Rust 1.86+ (see workspace `rust-toolchain.toml`), `protoc` (for the fuzz feature only).

### Publish to npm

1. Create an **Automation** token at npmjs.com → Account Settings → Access Tokens.
2. Add it as `NPM_TOKEN` in your GitHub repo → Settings → Secrets.
3. Tag a release:

```bash
# Bump version in node/package.json and all node/npm/*/package.json files
git add .
git commit -m "bump version to 0.2.0"
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions will build all 5 platform binaries in parallel, run the test suite, then publish the main package and all platform sub-packages automatically.

---

## License

Apache 2.0.

The underlying [`mollusk-svm`](https://github.com/anza-xyz/mollusk) Rust crate is also Apache 2.0, maintained by Anza Technology.
