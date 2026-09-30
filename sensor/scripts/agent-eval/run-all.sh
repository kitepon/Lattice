#!/usr/bin/env bash
# With/without A/B (and optional interactive) eval for a lattice-sensor version on a
# repo. Lattice sensor is the ONLY variable: both arms launch claude with
# --strict-mcp-config — with = lattice-sensor-only MCP (pointed at $CG_BIN),
# without = empty MCP. Built-in Read/Grep/Bash stay available in both arms.
#
# Usage: run-all.sh <repo-path> "<question>" [headless|tmux|all]
# Env:   CG_BIN          lattice-sensor binary (default: command -v lattice-sensor)
#        AGENT_EVAL_OUT  output dir (default: /tmp/agent-eval)
#        MODEL / EFFORT  claude model/effort (default: sonnet / high — the
#                        standing A/B policy; see CLAUDE.md, don't raise)
set -uo pipefail

REPO="${1:?usage: run-all.sh <repo-path> \"<question>\" [headless|tmux|all]}"
Q="${2:?question required}"
MODE="${3:-headless}"
CG_BIN="${CG_BIN:-$(command -v lattice-sensor)}"
OUT="${AGENT_EVAL_OUT:-/tmp/agent-eval}"
HARNESS="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"

# Neutralize any ambient Lattice sensor prompt-hook (~/.claude) in BOTH arms:
# the hook injects lattice-sensor context into every prompt, which contaminates
# the without-arm (free structural context) and double-counts the with-arm.
# The A/B's only variable must be the MCP server wired below.
export LATTICE_SENSOR_NO_PROMPT_HOOK=1

[ -n "$CG_BIN" ] || { echo "no lattice-sensor binary on PATH (set CG_BIN)"; exit 1; }
[ -d "$REPO/.lattice/sensor" ] || { echo "no .lattice/sensor index at $REPO — index it first"; exit 1; }
case "$MODE" in headless|tmux|all) ;; *) echo "mode must be headless|tmux|all (got '$MODE')"; exit 1;; esac

# MCP config files (path form avoids inline-JSON quoting through tmux).
cat > "$OUT/mcp-lattice-sensor.json" <<JSON
{"mcpServers":{"lattice-sensor":{"command":"$CG_BIN","args":["serve","--mcp","--path","$REPO"]}}}
JSON
echo '{"mcpServers":{}}' > "$OUT/mcp-empty.json"

echo "###### lattice-sensor: $CG_BIN"
echo "###### repo:      $REPO"
echo "###### turns:     ${#TURNS[@]}"
for t in "${TURNS[@]}"; do echo "######   - $t"; done
echo

# Pull the session id out of a segment's result event so the next turn can
# --resume it (rather than minting a --session-id, which needs a valid uuid).
session_id_of() {
  node -e '
    const fs=require("fs");
    for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n").reverse()) {
      if (!l) continue; let e; try { e=JSON.parse(l) } catch { continue }
      if (e.session_id) { console.log(e.session_id); break }
    }' "$1" 2>/dev/null
}

# Headless arm: claude -p with stream-json -> exact tool sequence + tokens/cost
# + residual context occupancy. One session, one segment file per turn.
headless() {
  local label="$1" cfg="$2"
  echo "############################## HEADLESS [$label] ##############################"
  local sid="" seg=0 out="" files=()
  : > "$OUT/run-$label.err"
  for q in "${TURNS[@]}"; do
    seg=$((seg + 1))
    out="$OUT/run-$label.jsonl"
    [ "$seg" -gt 1 ] && out="$OUT/run-$label.t$seg.jsonl"
    local resume=()
    [ -n "$sid" ] && resume=(--resume "$sid")
    ( cd "$REPO" && PATH="$ARM_PATH" claude -p "$q" \
        --output-format stream-json --verbose \
        --permission-mode bypassPermissions \
        --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" \
        --max-budget-usd 4 \
        --strict-mcp-config --mcp-config "$cfg" \
        --settings "$ARM_SETTINGS" \
        ${resume[@]+"${resume[@]}"} \
        </dev/null > "$out" 2>>"$OUT/run-$label.err" )
    echo "exit $? -> $out ($(wc -l < "$out" | tr -d ' ') lines) [turn $seg/${#TURNS[@]}]"
    files+=("$out")
    sid="$(session_id_of "$out")"
    if [ -z "$sid" ] && [ "$seg" -lt "${#TURNS[@]}" ]; then
      echo "  WARN: no session_id in $out — later turns would start a FRESH context; stopping this arm"
      break
    fi
  done
  tail -2 "$OUT/run-$label.err" 2>/dev/null
  node "$HARNESS/parse-run.mjs" "${files[@]}" 2>&1 || true
  echo
}

# CG_ARMS=with|without|both — re-run one arm without redoing the other.
ARMS="${CG_ARMS:-both}"
if [ "$MODE" = headless ] || [ "$MODE" = all ]; then
  case "$ARMS" in both|with)    headless "headless-with"    "$OUT/mcp-lattice-sensor.json";; esac
  case "$ARMS" in both|without) headless "headless-without" "$OUT/mcp-empty.json";; esac
  # Both arms' three metrics on one screen. The per-arm blocks above say WHY a
  # number moved (which query fell short, which file was never cited); this says
  # whether it moved at all. CG_ARMS=with|without leaves one arm's logs from an
  # earlier invocation in $OUT, and comparing against those is the point of the
  # split — so this runs whichever arms have logs, not only a fresh pair.
  node "$HARNESS/compare-arms.mjs" "$OUT" headless-with headless-without 2>&1 || true
fi

if [ "$MODE" = tmux ] || [ "$MODE" = all ]; then
  echo "############################## INTERACTIVE [with] ##############################"
  CLAUDE_EXTRA_ARGS="--model ${MODEL:-sonnet} --effort ${EFFORT:-high} --strict-mcp-config --mcp-config $OUT/mcp-lattice-sensor.json" \
    bash "$HARNESS/itrun.sh" "$REPO" "int-with" "${TURNS[0]}" 2>&1 || echo "[itrun WITH failed]"
  echo
  echo "############################## INTERACTIVE [without] ##############################"
  CLAUDE_EXTRA_ARGS="--model ${MODEL:-sonnet} --effort ${EFFORT:-high} --strict-mcp-config --mcp-config $OUT/mcp-empty.json" \
    bash "$HARNESS/itrun.sh" "$REPO" "int-without" "${TURNS[0]}" 2>&1 || echo "[itrun WITHOUT failed]"
  echo
fi
echo "############################## RUN-ALL COMPLETE ##############################"
