#!/usr/bin/env node
// Parse Claude Code stream-json run log(s): tool-call sequence, token usage, and
// RESIDUAL CONTEXT OCCUPANCY — how many tokens of the context window each tool
// family's responses still occupy when the run ends.
//
// Usage: parse-run.mjs <run.jsonl> [run.t2.jsonl ...] [--brief] [--envelope] [--answer <glob>]...
//   Multiple files = one multi-turn session's segments, IN ORDER (run-all.sh
//   writes run-<label>.jsonl, run-<label>.t2.jsonl, … for a `Q1||Q2||Q3` set).
//   `--resume` does not replay prior messages, so the segments concatenate
//   cleanly and token accounting carries across the boundary.
//
//   `--brief` drops the numbered tool-call transcript and keeps everything else,
//   for harnesses that print one of these blocks per run (ab-new-vs-baseline.sh
//   at RUNS>=2 is otherwise mostly call listings).
//
//   Every run also reports EXPLORE SUFFICIENCY — each lattice_sensor_explore call
//   bucketed by what the agent did next (see classifySufficiency) — and EXPLORE
//   ALLOCATION EFFICIENCY, the share of the bytes explore returned that belonged
//   to files the agent's final answer actually cited (see computeAllocation).
//
//   `--envelope` additionally reports how the lattice_sensor_explore responses were
//   DIVIDED across files — the per-file share of the source envelope (#1500).
//   `--answer <glob>` (repeatable, implies --envelope) marks the files that
//   actually answer the question and reports their combined share: bar 2 of the
//   CG-1/CG-22 allocation gate. See formatEnvelope for why it parses the
//   rendered markdown rather than the CG-4 diagnostic sidecar.
//
// ---------------------------------------------------------------------------
// Why occupancy, and how it's measured
// ---------------------------------------------------------------------------
// A single-question A/B reports cost/tokens/time/tool-calls for ONE answer. It
// cannot see what issue #1500 measured: a tool response stays in the window for
// everything that follows, so it is charged against every later turn's headroom.
// That is a per-session cost our single-question runs structurally miss.
//
// Tokens are MEASURED, not estimated at bytes/4. For assistant request k,
//   ctx_k = usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens
// is the exact token count of that request's whole prompt. So
//   gap_k = ctx_k - ctx_{k-1}
// is exactly the tokens appended since the previous request: the previous
// assistant output (thinking + text + tool_use JSON) plus the tool_results and
// user text that followed it. We split gap_k across those blocks in proportion
// to their characters, which attributes each tool_result its measured share.
// (Measured on real runs, explore output lands near 2.3 chars/token — bytes/4
// under-counts it by ~40%, which is why the estimate isn't good enough.)
//
// Two traps this file works around, both verified against real logs:
//   * Claude Code emits ONE assistant event PER CONTENT BLOCK, all carrying the
//     same message.id and the same `usage`. Summing usage per event double-counts
//     every turn that emits both thinking and a tool_use — dedupe by message.id.
//   * The streamed `output_tokens` is a partial snapshot (observed `out=2` on a
//     turn that really generated ~1100). Never trust it; the char-proportional
//     split doesn't need it.
//
// Residual ≠ contributed. Content leaves the window two ways, and both are
// tracked: a `compact_boundary` system event (everything prior is replaced by a
// summary) and micro-compaction (ctx drops mid-run — oldest tool results are
// dropped first, so eviction is applied FIFO).
import { readFileSync } from 'fs';
const file = process.argv[2];
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);

const toolCalls = [];
let result = null;
let initTools = null;

for (const line of lines) {
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  if (ev.type === 'system' && ev.subtype === 'init') {
    initTools = (ev.tools || []).filter(t => /lattice-sensor/.test(t));
  }
  if (ev.type === 'assistant' && ev.message?.content) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_use') {
        let detail = '';
        if (block.name === 'Task') detail = ` [subagent_type=${block.input?.subagent_type ?? '?'}] ${(block.input?.description ?? '').slice(0,40)}`;
        else if (/lattice-sensor/.test(block.name)) detail = ` ${JSON.stringify(block.input?.query ?? block.input?.task ?? block.input?.symbol ?? '').slice(0,60)}`;
        else if (block.name === 'Bash') detail = ` ${(block.input?.command ?? '').slice(0,50)}`;
        else if (block.name === 'Read') detail = ` ${(block.input?.file_path ?? '').split('/').slice(-1)[0]}`;
        toolCalls.push(`${block.name}${detail}`);
      }
    }
  }
  if (ev.type === 'result') result = ev;
}

console.log(`\n=== ${file.split('/').pop()} ===`);
console.log(`lattice-sensor tools exposed: ${initTools ? initTools.length : '?'}`);
console.log(`\nTool calls (${toolCalls.length}):`);
const counts = {};
for (const tc of toolCalls) { const n = tc.split(' ')[0]; counts[n] = (counts[n]||0)+1; }
console.log('  by type:', JSON.stringify(counts));
toolCalls.forEach((tc, i) => console.log(`  ${i+1}. ${tc}`));

if (result) {
  const u = result.usage || {};
  const totalIn = (u.input_tokens||0) + (u.cache_read_input_tokens||0) + (u.cache_creation_input_tokens||0);
  console.log(`\nResult: ${result.subtype} | duration ${(result.duration_ms/1000).toFixed(0)}s | turns ${result.num_turns}`);
  console.log(`  tokens: in=${totalIn} out=${u.output_tokens||0} | cost $${(result.total_cost_usd||0).toFixed(3)}`);
}
