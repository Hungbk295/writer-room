#!/usr/bin/env bash

set -Eeuo pipefail

PIPELINE_VERSION="1.0.0"
DEFAULT_COLLECTION="hieutv"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

usage() {
  printf '%s\n' \
    "Usage:" \
    "  $(basename "$0") <input-dir> [output-dir] [options]" \
    "  $(basename "$0") --self-test-qmd" \
    "" \
    "Options:" \
    "  --collection NAME   Aggregate QMD collection (default: hieutv)" \
    "  --dry-run           Discover and hash files without invoking Codex or QMD" \
    "  --qmd-only          Skip transcript mining and only update/embed QMD" \
    "  --skip-embed        Run qmd update but skip vector embedding" \
    "  --include-global    Keep collection in unscoped global QMD searches" \
    "  --self-test-qmd     Test collection + embedding + vector search in isolation" \
    "  -h, --help          Show this help" \
    "" \
    "The output defaults to <workspace>/hieutv-taste-rag. Input files are" \
    "discovered recursively with the .txt extension and are never modified."
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

absolute_existing_dir() {
  local candidate="$1"
  [[ -d "$candidate" ]] || fail "Directory does not exist: $candidate"
  (cd "$candidate" && pwd -P)
}

absolute_output_dir() {
  local candidate="$1"
  mkdir -p "$candidate"
  (cd "$candidate" && pwd -P)
}

sha256_file() {
  local source_file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$source_file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$source_file" | awk '{print $1}'
  else
    fail "Neither shasum nor sha256sum is available"
  fi
}

discover_transcripts() {
  local input_root="$1"
  find "$input_root" \
    -type d \( \
      -name .git -o \
      -name node_modules -o \
      -name vendor -o \
      -name dist -o \
      -name build -o \
      -name target \
    \) -prune -o \
    -type f -name '*.txt' -print0
}

manifest_is_current() {
  local manifest="$1"
  local source_file="$2"
  local source_hash="$3"

  [[ -s "$manifest" ]] || return 1
  python3 - "$manifest" "$source_file" "$source_hash" "$PIPELINE_VERSION" <<'PY'
import json
import pathlib
import sys

manifest, source, digest, version = sys.argv[1:]
source_path = pathlib.Path(source).resolve()
current = False
with open(manifest, "r", encoding="utf-8") as handle:
    for raw in handle:
        try:
            row = json.loads(raw)
        except json.JSONDecodeError:
            continue
        try:
            same_path = pathlib.Path(row.get("path", "")).resolve() == source_path
        except (OSError, RuntimeError):
            same_path = False
        if same_path:
            current = (
                row.get("source_hash") == digest
                and row.get("pipeline_version") == version
            )
sys.exit(0 if current else 1)
PY
}

initialize_project() {
  local output_root="$1"
  mkdir -p \
    "$output_root/input" \
    "$output_root/store/sources" \
    "$output_root/store/decisions" \
    "$output_root/store/principles" \
    "$output_root/store/patterns" \
    "$output_root/state" \
    "$output_root/review/low-confidence" \
    "$output_root/reports/runs" \
    "$output_root/eval"

  [[ -e "$output_root/state/source-manifest.jsonl" ]] || : > "$output_root/state/source-manifest.jsonl"
  [[ -e "$output_root/state/rejected-cases.jsonl" ]] || : > "$output_root/state/rejected-cases.jsonl"
  [[ -e "$output_root/state/principle-candidates.jsonl" ]] || : > "$output_root/state/principle-candidates.jsonl"
  [[ -e "$output_root/state/run-state.json" ]] || printf '{}\n' > "$output_root/state/run-state.json"
  [[ -e "$output_root/eval/retrieval-cases.json" ]] || printf '[]\n' > "$output_root/eval/retrieval-cases.json"
  [[ -e "$output_root/eval/qmd-bench.json" ]] || printf '[]\n' > "$output_root/eval/qmd-bench.json"
}

run_codex_for_source() {
  local source_file="$1"
  local source_hash="$2"
  local output_root="$3"
  local prompt

  prompt="Use \$hieutv-taste-rag-miner from $SKILL_DIR. Read its SKILL.md and references/operating-spec.md completely. Process exactly one transcript: $source_file. Write canonical output only under: $output_root. Raw SHA-256 is $source_hash and pipeline_version is $PIPELINE_VERSION. Do not modify, rename, or delete the input. Do not run QMD in this per-source pass. Enforce observed/inferred/synthetic distinctions, the confidence hard gate, stable IDs, source-level argument/rhetorical maps, source-specific stale-artifact cleanup, and atomic manifest replacement. If the manifest is already current, make no semantic changes. Return a concise operational result."

  codex exec \
    --ephemeral \
    --skip-git-repo-check \
    -C "$WORKSPACE_ROOT" \
    --add-dir "$output_root" \
    -s workspace-write \
    "$prompt" </dev/null
}

run_codex_consolidation() {
  local output_root="$1"
  local prompt

  prompt="Use \$hieutv-taste-rag-miner from $SKILL_DIR. Read its SKILL.md and references/operating-spec.md completely. Consolidate the completed batch under $output_root without running QMD. Inspect accepted decision cases and principle candidate state; merge semantic duplicates; promote or update principles and style patterns only at the three-cases/three-sources threshold; preserve contradictions and boundaries; update the corpus-level operational report at reports/latest.md and a timestamped reports/runs copy. Do not change input transcripts and do not fabricate support."

  codex exec \
    --ephemeral \
    --skip-git-repo-check \
    -C "$WORKSPACE_ROOT" \
    --add-dir "$output_root" \
    -s workspace-write \
    "$prompt" </dev/null
}

collection_path() {
  local name="$1"
  qmd collection show "$name" 2>/dev/null | sed -n 's/^  Path:[[:space:]]*//p' | head -n 1
}

same_real_path() {
  python3 - "$1" "$2" <<'PY'
import pathlib
import sys
left = pathlib.Path(sys.argv[1]).resolve()
right = pathlib.Path(sys.argv[2]).resolve()
sys.exit(0 if left == right else 1)
PY
}

ensure_aggregate_collection() {
  local name="$1"
  local store_dir="$2"
  local include_global="$3"
  local configured_path=""
  local context_text="Atomic Hiếu TV editorial Taste Memory. Retrieve by editorial situation, decision geometry, boundary, rationale, and transfer conditions rather than topic alone."

  if configured_path="$(collection_path "$name")" && [[ -n "$configured_path" ]]; then
    same_real_path "$configured_path" "$store_dir" || fail "QMD collection '$name' already points to '$configured_path', not '$store_dir'. Refusing to repoint it."
  else
    qmd collection add "$store_dir" --name "$name" --mask '**/*.md'
  fi

  if ! qmd context list 2>/dev/null | grep -F "qmd://$name/" >/dev/null 2>&1; then
    qmd context add "qmd://$name/" "$context_text"
  fi

  if [[ "$include_global" == "true" ]]; then
    qmd collection include "$name"
  else
    qmd collection exclude "$name"
  fi
}

append_qmd_report() {
  local output_root="$1"
  local collection="$2"
  local embed_status="$3"
  local lexical_status="$4"
  local vector_status="$5"
  local report="$output_root/reports/latest.md"
  local timestamp
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  [[ -e "$report" ]] || printf '# Hiếu TV Taste RAG run report\n' > "$report"
  {
    printf '\n## QMD indexing (%s)\n\n' "$timestamp"
    printf -- '- Collection: `%s`\n' "$collection"
    printf -- '- Topology: aggregate `store/` compatibility mode\n'
    printf -- '- Embedding: %s\n' "$embed_status"
    printf -- '- Lexical smoke test: %s\n' "$lexical_status"
    printf -- '- Vector smoke test: %s\n' "$vector_status"
  } >> "$report"

  cp "$report" "$output_root/reports/runs/$(date -u '+%Y%m%dT%H%M%SZ').md"
}

run_qmd_indexing() {
  local output_root="$1"
  local collection="$2"
  local skip_embed="$3"
  local include_global="$4"
  local store_dir="$output_root/store"
  local lexical_status="not-run"
  local vector_status="not-run"
  local embed_status="skipped"
  local markdown_count

  need_command qmd
  [[ -d "$store_dir" ]] || fail "Canonical store does not exist: $store_dir"

  qmd --help >/dev/null
  qmd collection help >/dev/null
  qmd status >/dev/null
  ensure_aggregate_collection "$collection" "$store_dir" "$include_global"
  qmd update

  markdown_count="$(find "$store_dir" -type f -name '*.md' | wc -l | tr -d ' ')"
  if [[ "$skip_embed" == "false" ]]; then
    qmd embed -c "$collection"
    embed_status="completed incrementally"
  fi

  if [[ "$markdown_count" -gt 0 ]]; then
    if qmd search 'decision geometry hidden cost observed choice transfer conditions' -c "$collection" -n 3 --format json >/dev/null; then
      lexical_status="passed command gate"
    else
      lexical_status="failed"
    fi

    if [[ "$skip_embed" == "false" ]]; then
      if qmd vsearch 'A decision case explains a hidden second-order cost and when the framing transfers to a different topic.' -c "$collection" -n 3 --format json >/dev/null; then
        vector_status="passed command gate"
      else
        vector_status="failed"
      fi
    else
      vector_status="skipped with embedding"
    fi
  else
    lexical_status="pending: no canonical Markdown"
    vector_status="pending: no canonical Markdown"
  fi

  append_qmd_report "$output_root" "$collection" "$embed_status" "$lexical_status" "$vector_status"
  printf 'QMD collection %s points to %s (%s Markdown files).\n' "$collection" "$store_dir" "$markdown_count"
}

self_test_qmd() {
  local test_root=""
  local test_collection="$DEFAULT_COLLECTION"
  local search_output=""

  need_command qmd
  test_root="$(mktemp -d "${TMPDIR:-/tmp}/hieutv-qmd-smoke.XXXXXX")"
  case "$(basename "$test_root")" in
    hieutv-qmd-smoke.*) ;;
    *) fail "Unexpected temporary path: $test_root" ;;
  esac
  trap 'if [[ -n "${test_root:-}" && -d "$test_root" && "$(basename "$test_root")" == hieutv-qmd-smoke.* ]]; then rm -rf -- "$test_root"; fi' EXIT

  mkdir -p "$test_root/store/decisions/sample"
  printf '%s\n' \
    '---' \
    'id: dc_qmd_smoke_test' \
    'memory_type: decision_case' \
    'creator: hieutv' \
    'evidence_status: synthetic_example_for_qmd_smoke_test' \
    'decision_geometry:' \
    '  - loss_of_optionality' \
    '  - large_financial_commitment' \
    '---' \
    '# Synthetic QMD smoke-test decision' \
    '' \
    '## Editorial situation' \
    'A young audience faces a large irreversible commitment under future uncertainty.' \
    '' \
    '## Observed strategy' \
    'This is a synthetic infrastructure fixture, not a claim about a real transcript.' \
    '' \
    '## Transfer conditions' \
    'Retrieve by hidden second-order cost and loss of optionality across different topics.' \
    > "$test_root/store/decisions/sample/dc_qmd_smoke_test.md"

  search_output="$(
    cd "$test_root"
    qmd init >/dev/null
    qmd collection add "$test_root/store" --name "$test_collection" --mask '**/*.md' >/dev/null
    qmd update >/dev/null
    qmd embed -c "$test_collection" >&2
    qmd vsearch 'hidden second-order cost loss of optionality large commitment' -c "$test_collection" -n 3 --format json
  )"
  printf '%s\n' "$search_output"
  grep -F 'dc_qmd_smoke_test.md' <<< "$search_output" >/dev/null || fail "QMD vector search did not retrieve the embedded Taste fixture"

  printf 'PASS: QMD embedded and vector-searched an isolated collection named %s.\n' "$test_collection"
  rm -rf -- "$test_root"
  trap - EXIT
}

main() {
  local input_dir=""
  local output_dir="$WORKSPACE_ROOT/hieutv-taste-rag"
  local collection="$DEFAULT_COLLECTION"
  local dry_run="false"
  local qmd_only="false"
  local skip_embed="false"
  local include_global="false"
  local self_test="false"
  local positional_count=0
  local input_abs=""
  local output_abs=""
  local manifest=""
  local discovered=0
  local skipped=0
  local attempted=0
  local failed=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --collection)
        [[ $# -ge 2 ]] || fail "--collection requires a value"
        collection="$2"
        shift 2
        ;;
      --dry-run)
        dry_run="true"
        shift
        ;;
      --qmd-only)
        qmd_only="true"
        shift
        ;;
      --skip-embed)
        skip_embed="true"
        shift
        ;;
      --include-global)
        include_global="true"
        shift
        ;;
      --self-test-qmd)
        self_test="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        shift
        break
        ;;
      -*)
        fail "Unknown option: $1"
        ;;
      *)
        positional_count=$((positional_count + 1))
        if [[ "$positional_count" -eq 1 ]]; then
          input_dir="$1"
        elif [[ "$positional_count" -eq 2 ]]; then
          output_dir="$1"
        else
          fail "Too many positional arguments"
        fi
        shift
        ;;
    esac
  done

  if [[ "$self_test" == "true" ]]; then
    [[ "$positional_count" -eq 0 ]] || fail "--self-test-qmd takes no input/output arguments"
    self_test_qmd
    exit 0
  fi

  [[ "$collection" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "Unsafe QMD collection name: $collection"

  [[ -n "$input_dir" || "$qmd_only" == "true" ]] || {
    usage >&2
    exit 2
  }

  need_command python3
  if [[ "$qmd_only" == "false" ]]; then
    input_abs="$(absolute_existing_dir "$input_dir")"
  fi

  if [[ "$dry_run" == "true" ]]; then
    [[ "$qmd_only" == "false" ]] || fail "--dry-run and --qmd-only cannot be combined"
    while IFS= read -r -d '' source_file; do
      discovered=$((discovered + 1))
      printf 'DRY RUN %s  %s\n' "$(sha256_file "$source_file")" "$source_file"
    done < <(discover_transcripts "$input_abs")
    printf 'Discovered %s transcript(s). No files, Codex sessions, or QMD state changed.\n' "$discovered"
    exit 0
  fi

  output_abs="$(absolute_output_dir "$output_dir")"
  if [[ "$qmd_only" == "false" ]] && same_real_path "$input_abs" "$output_abs"; then
    fail "Input and output directories must be different"
  fi
  initialize_project "$output_abs"
  manifest="$output_abs/state/source-manifest.jsonl"

  if [[ "$qmd_only" == "false" ]]; then
    need_command codex
    while IFS= read -r -d '' source_file; do
      local source_hash
      discovered=$((discovered + 1))
      source_hash="$(sha256_file "$source_file")"
      if manifest_is_current "$manifest" "$source_file" "$source_hash"; then
        skipped=$((skipped + 1))
        printf 'SKIP unchanged: %s\n' "$source_file"
        continue
      fi

      attempted=$((attempted + 1))
      printf 'PROCESS: %s\n' "$source_file"
      if ! run_codex_for_source "$source_file" "$source_hash" "$output_abs"; then
        failed=$((failed + 1))
        printf 'FAILED: %s\n' "$source_file" >&2
      elif ! manifest_is_current "$manifest" "$source_file" "$source_hash"; then
        failed=$((failed + 1))
        printf 'FAILED ARTIFACT GATE: manifest was not committed for %s\n' "$source_file" >&2
      fi
    done < <(discover_transcripts "$input_abs")

    if [[ "$attempted" -gt 0 ]]; then
      run_codex_consolidation "$output_abs" || printf 'WARNING: consolidation pass failed; canonical per-source files were preserved.\n' >&2
    fi
  fi

  run_qmd_indexing "$output_abs" "$collection" "$skip_embed" "$include_global"
  printf 'Run summary: discovered=%s skipped=%s attempted=%s failed=%s\n' "$discovered" "$skipped" "$attempted" "$failed"

  [[ "$failed" -eq 0 ]] || exit 1
}

main "$@"
