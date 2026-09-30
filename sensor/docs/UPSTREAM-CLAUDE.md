# CLAUDE.md

> **旧上流の開発メモ（履歴）**: この文書はLatticeのagent instructionではない。
> 名称、CLI、package、state path、installer、telemetryの記述は現行契約に使わない。
> 現行仕様は[`../README.md`](../README.md)と[`../../docs/00_product-contract.md`](../../docs/00_product-contract.md)を参照する。

Claude Code project guidance for this repository.

Primary instructions live in the canonical agent guide — import it:

@AGENTS.md

## Claude-only notes

- Prefer the repo-root `AGENTS.md` as the source of truth for build/test/architecture/house rules. Edit that file (not this wrapper) when guidance changes.
- Claude Code can `@`-import nested guides too (e.g. `@docs/AGENTS.md`) when working on design/eval docs; Codex loads nested `AGENTS.md` automatically when the session cwd is under that directory.
- Do not reintroduce a duplicated `## CodeGraph` MCP tool-guidance block here — `src/mcp/server-instructions.ts` is the single source of truth (issue #529); the installer strips legacy marker blocks on upgrade.
