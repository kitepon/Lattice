<p align="center">
  <img src="https://raw.githubusercontent.com/kitepon/Lattice/main/.github/og.png" alt="Lattice — several viable routes emerging through an apparently blocked mountain valley" width="100%">
  <br>
  <sub><em>This image represents several viable paths emerging from terrain that first appeared blocked, as autonomous executors begin moving in coordination.</em></sub>
</p>

# Lattice

[![npm](https://img.shields.io/npm/v/@quolu/lattice?color=cb3837&logo=npm)](https://www.npmjs.com/package/@quolu/lattice)
[![CI](https://github.com/kitepon/Lattice/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon/Lattice/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)
[![node](https://img.shields.io/node/v/@quolu/lattice?color=339933&logo=node.js&logoColor=white)](https://nodejs.org/)
[![patent](https://img.shields.io/badge/patent-pending%20JP%202026--178950-6366f1)](#patent)

**English** · [日本語](README.ja.md)

> **Stop serializing work that only looks like it conflicts.**
> Lattice is a schedulability compiler for multi-agent development. It observes the real
> boundaries of your codebase, proves which tasks can run in parallel, and — when two tasks
> genuinely collide — **refactors the seam between them and recompiles the plan** so they can
> run in parallel after all.

Built and maintained by [Quo](https://x.com/QLyun35332) at [kitepon.dev](https://kitepon.dev/en).

On Windows factory hosts, development and operations use PowerShell 7 (`pwsh.exe`) only; install it
through Microsoft's official installer or package manager when only Windows PowerShell 5.1 is present.
The Lattice runtime does not depend on psmux. External interactive work that needs a persistent PTY uses
Aiterm's public API; Aiterm alone owns psmux as its Windows backend.

## Why

Give three coding agents three tasks and the usual outcome is one of two failures:

- **You serialize too much.** "These both touch `renderer.ts`, so run them one at a time."
  Often they touch *different symbols* in that file and could have run together.
- **You serialize too little.** Nothing declared a dependency, so you run them in parallel and
  discover the collision after both have written conflicting code.

Both failures come from the same gap: *nobody actually measured the boundary.* Dependency
arrows in a task list are a claim about intent, not evidence about code.

Lattice closes that gap with a different move. It does not just **detect** the conflict — it
**removes** it. When two tasks contend for one file, Lattice derives a cut, applies it in an
isolated worktree, verifies the transform against five acceptance conditions, and recompiles the
plan against the transformed source. The conflict edge disappears because the shared surface
stopped being shared.

## What it actually does

```
declare boundaries → compile independence → conflict?
                                              ├─ no  → run in parallel
                                              └─ yes → propose a seam
                                                       → transform in an isolated worktree
                                                       → verify (5 conditions)
                                                       → land + recompile → run in parallel
```

**A real example, from this repository.** Two tasks both needed to change
`src/seam-commit.mjs`. Lattice compiled the declarations, reported `conflict_count: 1` with
`severability: code_seam`, proposed a cut, and applied it in an isolated worktree. After all
five acceptance conditions passed, the file was split into one owned surface per task plus a
shared and a residual surface. Recompiling reported `conflict_count: 0` and placed both tasks in
the same parallel group.

Nobody hand-refactored that file. The product cut it so the work could parallelize.

### Task memory travels with the task

Every newly authored ToDo carries an initial Markdown design memo. Empty text and a file reference are
not accepted; an agent with no plan must explicitly write `NO_PLAN`. Lattice asks:
“あなたがこのToDoに対して、何も考えていないならば、設計メモに `NO_PLAN` と書いてください”.
A normal `lattice todo show` and every successful `lattice todo start` return that memo automatically.

After work begins, an agent can append decisions, rejected approaches, findings, cautions, and open
questions. These remain a separate, append-only `note_context`, with origin, correction state, chain
head, overflow, and the full-history command.

```bash
lattice todo note --plan <key> --task <id> --message "Use the existing parser; do not add a fallback"
lattice todo show --plan <key> --task <id> --json
```

The selected ToDo's detail pane shows the initial design memo and the append-only note bodies, plus the
status of each prerequisite and dependent ToDo (pending, in progress, done, blocked) and whether the ToDo
can run in parallel. Note bodies are carried by every rendered surface, including HTML served outside the
repository. Static per-project HTML is not generated; `lattice todo gantt serve` and the shared dashboard
read the store dynamically.

### Check a ToDo's dataflow before and after implementation

A code-changing plan can explicitly opt into logical dataflow inspection after the plan is defined.
Non-code plans such as publishing or operations are left unchanged. Saving a planned source does not
enable the feature. Only an authoritative compile on a clean worktree that returns `consistent` emits
an immutable binding for that exact plan version.

```bash
lattice todo structure --schema --json
lattice todo structure input --plan <key> --input structure.json --dry-run --json
lattice todo structure input --plan <key> --input structure.json
lattice todo structure compile --plan <key> --input .lattice/todo/structure/<key>.json
lattice todo structure --plan <key> --json
```

The verdict is three-valued: `consistent | inconsistent | unknown`. Unknown is never treated as success.
Findings identify the relevant task, data port, code anchor, and commit, and include the next action.
The planned form remains immutable; implementation changes are appended as per-task realizations. A graph
task in an enabled plan cannot complete without a fresh realization. After every task is done, Lattice
recompiles the final HEAD and requires a fresh, consistent finalization before the terminal phase can close.

```bash
lattice todo structure realize --plan <key> --task <id> --input realization.json
lattice todo done --plan <key> --task <id> --evidence evidence.json
lattice todo structure finalize --plan <key> --json
```

The dynamic dashboard exposes this as a separate **Structure inspection** pane. It shows task, data, code,
external contract, and commit-provenance nodes; planned, realized, and effective forms; findings; and
freshness. Dataflow edges are never mixed into the process-dependency diagram. Normal reads and dashboard
renders use saved artifacts without silently running the sensor. Plans that do not opt in retain their
existing lifecycle and do not gain a structure pane.

### The five acceptance conditions

A transform is adopted only when **all five** hold. One missing condition rejects it:

| Condition | Meaning |
|---|---|
| `behavior_equivalent` | The original path's public export surface is preserved, and no moved code references a symbol that stayed behind without a binding (severed-reference net) |
| `focused_tests_passed` | The affected tests actually pass against the transformed source |
| `sensor_fresh` | The structure index was rebuilt and covers the new surfaces |
| `overlap_reduced` | The target conflict is gone **and** plan-wide conflict pairs did not increase |
| `parallelism_improved` | The number of execution waves went down |

### Runtime, not just planning

Complete separation is not obtainable at planning time — dynamic dispatch, runtime-resolved
paths, and external state always leave residue. That is the design, not a deficiency: Lattice
carries a second stage at runtime.

While work executes, Lattice observes **what was actually changed**, not what was declared. When
it sees a task writing outside its declared scope, or into another running task's scope, it
raises a runtime conflict — and can either hold one side while the other commits, or transform
the seam and resume both. Both treatments are exercised end-to-end against a live store in the
integration suite.

Two projection surfaces support that decision without scoring anyone. `lattice run seam profile`
(and `todo seam-profile` at plan time) reports the countable anatomy of a cut — cross references,
shared module state with read/write distinction, shared imports, cycles — with declared blind
spots, and never persists into any digested artifact. And every machine-transform rejection is
classified by a **certainty gate**: the machine only transforms what it can do with certainty,
and each refusal says whether fixing the declaration suffices or the seam should be handed to
the operating AI.

## Install

```bash
npm install -g @quolu/lattice
lattice setup --json
```

Requires **Node.js 22.13 or newer, except 25.x** (`engines: >=22.13 <25 || >=26`; Node 25's V8
turboshaft WASM JIT breaks the bundled sensor, so it is blocked with a banner). The structure sensor ships inside the package — there is nothing
else to install, and Lattice never falls back to a sensor on your `PATH`.

`lattice setup`は既存のClaude・Codex・Grok・Cursor設定を検出し、LatticeのMCP登録、
対応する製品hookの準備、設定読戻し、実MCPの初期化とtool一覧確認を一回で行う。
AIの設定がまだ無い初回は`lattice setup --host claude --json`のように対象を指定する。
全AIを明示する時は`--host all`を使う。再実行とnpm更新後も同じ入口である。

結果はOS・AI・機能別に返す。Windows nativeの製品hookとGrokの製品hookは`unsupported`、
利用者が無効化したMCPは`disabled`として保持する。対応MCPの登録・確認は続行し、
全機能確認済みの`ready`だけexit 0、`partial`と`failed`はexit 1である。
設定形式と機能表は[導入契約](https://github.com/kitepon/Lattice/blob/main/docs/01_integration-package.md#製品所有のai導入入口)を参照。

## Quick start

Every project begins with typed discovery. Never guess from directory layout:

```bash
lattice status --json
```

`state` is one of `uninitialized | ready | active_run | invalid`, and `next_action` gives the
canonical next command. Then index the codebase and declare boundaries:

```bash
lattice sensor init . --json
```

Write a draft declaring what each task owns, then let the tool supply the parts you cannot
hand-write — fresh observations, provenance wiring, canonical bytes:

```bash
lattice todo independence witness scaffold --plan <key> --input draft.json
lattice todo independence compile --plan <key> --input .lattice/todo/witness/<key>.json
lattice todo independence --plan <key> --json
```

If the verdict reports a conflict with `severability: code_seam`, ask for a cut and apply it:

```bash
lattice todo seam-proposal compile --plan <key>
lattice todo seam-proposal apply   --plan <key>               # isolated worktree, five conditions
lattice todo seam-proposal land    --plan <key> --names names.json
```

`lattice todo status --json` exposes `dispatch_frontier`: every ready task is the default
parallel set. Starting one of them does not require `--parallel-frontier` or
`--override-reason`. Those flags record intent; they are not gates.
`--serial-confirmed` and `--serialization-reviewed` are accepted only for compatibility.
If an independence record exists but the task is undeclared or stale, `todo start`
fails with `INDEPENDENCE_UNVERIFIED`. `independence compile` fails with
`INDEPENDENCE_READY_UNDECLARED` when `next_ready` is missing from the witness.

```bash
lattice todo start --plan <key> --task <id>
```

Full CLI surface: `lattice --help`, then
`lattice <plan|run|event|todo|sensor|factory-diagnostics|runtime-errors|bridge|hooks> --help`.

## Design principles

**The operating AI is part of the apparatus.** Lattice is driven by an AI agent, and that agent
is not outside the system — it is a component of it. So Lattice supplies only what the AI
*cannot* produce for itself: structure observation, contracts, verification, records, and
version boundaries. Estimation, judgment, and naming remain the AI's job. You will not find an
LLM call inside this product; adding one would duplicate a capability already present at the
point of use.

**Unknown is never rounded to "no conflict."** If a boundary was not verified, the verdict says
`missing`, not "independent." The absence of a dependency edge is not evidence of independence.

**Fail closed, and say why.** Every rejection carries a typed reason and a next action. A
transform that cannot be verified is not adopted. A finding that cannot be independently
re-derived is not recorded.

**Heavy audit is on by default.** A plan without explicit phases still carries an implicit
terminal audit: every task being done means `gate_ready` — *awaiting audit* — not finished. The
live dependency diagram refuses to fold such a plan away, because folding is how the product
says "closed", and nothing gets there without an evidence-bound `phase accept`. Creation is never
rejected over it; the requirement is reported instead. And the audit gate never touches dispatch:
phases order reviews, the ToDo DAG orders work
([ADR 0147](https://github.com/kitepon/Lattice/blob/main/docs/adr/0147-audit-is-on-by-default.md)).

**History closes unaudited, never audited.** Work that finished long ago cannot be audited — the
code under review has already moved. Demanding an audit there produces either a false finding
(pointing at a later, intentional change) or a rubber stamp. So there is a third terminal state,
`closed_unaudited`: recorded with a reason, folded away like finished work, and **structurally
incapable of passing as `accepted`** — phase-accept dependencies unlock on `accepted` alone. The
bulk entry point never runs by itself, and the machine never infers "old enough to skip"; a human
decides what gets audited and what becomes history
([ADR 0148](https://github.com/kitepon/Lattice/blob/main/docs/adr/0148-history-closes-unaudited-not-audited.md)).

## Patent

The design in this repository is the subject of a Japanese patent application:

| | |
|---|---|
| Application number | 特願2026-178950 (JP 2026-178950) |
| Filing date | 2026-07-27 |
| Title | 情報処理装置、ソフトウェア開発制御方法及びプログラム<br>(Information processing apparatus, software development control method, and program) |
| Claims | 12 |

Noncommercial use is permitted under the [License](#license) below.
**A separate commercial license is required for commercial use.**

## Ownership boundary

This repository owns the plan/ToDo/run store, the bundled sensor, schemas, migrations,
releases, and diagnostics. [dotagents](https://github.com/kitepon/dotagents) coordinates optional
cross-product factory installation and host integration; it does not own or control Lattice's
product state, update, diagnostics, or release.

- Product philosophy: [PLAN.md](https://github.com/kitepon/Lattice/blob/main/PLAN.md)
- Public contract: [docs/00_product-contract.md](https://github.com/kitepon/Lattice/blob/main/docs/00_product-contract.md)
- Immutable decisions: [docs/adr/](https://github.com/kitepon/Lattice/tree/main/docs/adr)
- Document map: [docs/README.md](https://github.com/kitepon/Lattice/blob/main/docs/README.md)

## Update and diagnostics

The npm package is the standalone update path. After updating, typed discovery verifies the
installed CLI and refreshes the product-owned dashboard when needed. Check the bridge only on a
host where it is enabled; its supervised process replaces an older loaded version within one minute.

```bash
npm install -g @quolu/lattice@latest
lattice setup --json
lattice --version
lattice status --json
lattice bridge status --json
```

AI登録の診断は`lattice setup status --json`。`--host <AI>`で対象を限定でき、
設定を変更せず現在の登録とMCP接続を確認する。既存の製品hook単独操作も維持する。

## Release

Maintainers release Lattice from this repository. Update `package.json` and `CHANGELOG.md`, pass the
product gate, land and push the release commit on the default branch, then publish and verify that
same version from the registry. `prepublishOnly` rejects a dirty tree or a commit not landed on the
remote default branch.

```bash
npm run ci
npm run verify:release-commit
gh workflow run publish.yml --repo kitepon/Lattice --ref main
npm install -g @quolu/lattice@<version>
lattice setup --json
lattice --version
lattice status --json
lattice bridge status --json
```

The product CI contract is [docs/ci-contract.md](https://github.com/kitepon/Lattice/blob/main/docs/ci-contract.md). The deployment-specific
dashboard and bridge checks are in
[docs/operations/lattice-kitepon-deployment.md](https://github.com/kitepon/Lattice/blob/main/docs/operations/lattice-kitepon-deployment.md).

## Development

```bash
npm test        # product test gate
npm run check   # syntax + control-character gate
npm run ci      # full gate
```

Product-local maintenance, when relevant:

```bash
node scripts/reap-orphan-test-daemons.mjs
lattice sensor sync . --json
```

These optional factory-integration diagnostics are not Lattice's standalone development or release
gate:

```bash
spotter doctor
codex-sidecar diagnostics --project . --preset auditor --json
```

The full gate includes checks that are unusual and deliberate:

- **`check:cli-surface`** — every shipped command must have help text *and* be exercised through
  a CLI entry point by a test. Shipping a command nobody ever ran is treated as a defect.
- **`check:open-questions`** — every unresolved question in an ADR must carry an explicit firing
  condition, so "deferred" is never indistinguishable from "forgotten."
- **`check:reachability`** — every module must be reachable from a product entry point, or be
  declared a research artifact with a reason.

Detailed operational notes (dashboard, bridge, actor environment, store transactions) are in
[README.ja.md](README.ja.md) and [docs/](docs/).

## License

**[PolyForm Noncommercial License 1.0.0](LICENSE)** — free for noncommercial use.

- **Free:** personal projects, study and research, hobby and amateur work, charities,
  educational institutions, public research organizations, and government institutions.
- **Permission required:** commercial use. That includes use inside a company's paid work or products,
  regardless of whether Lattice itself is redistributed.

**For commercial use**, a separate commercial license is required.
Enquiries can be made by email at [kitepon@gmail.com](mailto:kitepon@gmail.com). Whether a
license is granted, and on what terms, is decided case by case.

The bundled structure sensor in [`sensor/`](sensor/) is third-party work absorbed into this
repository and remains under the **MIT License**. Its upstream origin and attribution are
recorded in [`sensor/NOTICE`](sensor/NOTICE); the license text is
[`sensor/LICENSE`](sensor/LICENSE). The terms above do not modify it.

© 2026 quolu (kitepon.dev)
