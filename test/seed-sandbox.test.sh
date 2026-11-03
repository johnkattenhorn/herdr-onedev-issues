#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s inherit_errexit
trap 'echo "test: error at line $LINENO" >&2' ERR

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/../scripts/seed-sandbox.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat >"$work/odev" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\t' "$@" >>"$STUB_LOG"
echo >>"$STUB_LOG"
[[ $1 == issue ]] || exit 64
verb=$2
shift 2
host="" project="" state="" title="" body="" num="" fields=()
while (($#)); do
  case $1 in
    --json) shift ;;
    --host | --project | --state | -s | --title | --body | -F | -L)
      case $1 in
        --host) host=$2 ;;
        --project) project=$2 ;;
        --state | -s) state=$2 ;;
        --title) title=$2 ;;
        --body) body=$2 ;;
        -F) fields+=("$2") ;;
      esac
      shift 2
      ;;
    *)
      num=$1
      shift
      ;;
  esac
done
[[ $host == "${STUB_WANT_HOST:-http://192.0.2.30:6610}" ]] || {
  echo "stub: unexpected host '$host'" >&2
  exit 1
}
[[ $project == team/app-sandbox ]] || {
  echo "stub: unexpected project '$project'" >&2
  exit 1
}
edit() { jq "$@" "$STUB_STATE" >"$STUB_STATE.new" && mv "$STUB_STATE.new" "$STUB_STATE"; }
case $verb in
  list)
    jq --arg s "${state:-Open}" '[.issues[] | select($s == "all" or .state == $s)]' "$STUB_STATE"
    ;;
  create)
    if ((${#title} > ${STUB_MAX_TITLE:-255})); then
      echo "Title: size must be between 1 and ${STUB_MAX_TITLE:-255}" >&2
      exit 1
    fi
    f=$(printf '%s\n' "${fields[@]}" | jq -Rn '[inputs | split("=") | {(.[0]): .[1]}] | add')
    edit --arg t "$title" --arg b "$body" --argjson f "$f" \
      '.issues += [{number: ((.issues | map(.number) | max // 0) + 1), title: $t, description: $b, state: "Open", fields: $f, commentCount: 0}]'
    echo create >>"$STUB_WRITES"
    echo '{}'
    ;;
  transition)
    edit --argjson n "$num" --arg s "$state" '(.issues[] | select(.number == $n) | .state) = $s'
    echo transition >>"$STUB_WRITES"
    echo '{}'
    ;;
  comment)
    edit --argjson n "$num" '(.issues[] | select(.number == $n) | .commentCount) += 1'
    echo comment >>"$STUB_WRITES"
    echo '{}'
    ;;
  *) exit 64 ;;
esac
STUB
chmod +x "$work/odev"

export ODEV="$work/odev"
export STUB_LOG="$work/argv.log" STUB_WRITES="$work/writes.log" STUB_STATE="$work/state.json"

failures=0
check() {
  if [[ $2 == "$3" ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1: got '$2', want '$3'"
    failures=$((failures + 1))
  fi
}

reset() {
  echo '{"issues":[]}' >"$STUB_STATE"
  : >"$STUB_LOG"
  : >"$STUB_WRITES"
}
writes() { grep -c "^$1\$" "$STUB_WRITES" || true; }
q() { jq -r "$1" "$STUB_STATE"; }
title_of() { q ".issues[] | select(.description | endswith(\"seed-key: $1\")) | .title"; }

reset
out=$("$script")
check "dry run exit code" "$?" 0
check "dry run writes nothing" "$(wc -c <"$STUB_WRITES")" 0
check "dry run only lists" "$(grep -vc '^issue	list	' "$STUB_LOG" || true)" 0
check "dry run lists every state" "$(grep -c -- '--state	all	-L	1000' "$STUB_LOG")" 1
dry_summary=$(tail -n 2 <<<"$out" | head -n 1)
want_comments=${dry_summary##* comment }
check "every odev call passes --host" "$(grep -vc -- '--host	http://192.0.2.30:6610	--project	' "$STUB_LOG" || true)" 0
check "dry run summary" "${dry_summary%, comment *}" "dry run, nothing written: would create 420, transition 84"

reset
out=$(SEED_HOST=http://example.test:1 STUB_WANT_HOST=http://example.test:1 "$script")
check "SEED_HOST overrides the host" "$(grep -c -- '--host	http://example.test:1	' "$STUB_LOG")" 1

reset
out=$("$script" --apply)
check "apply creates 420" "$(writes create)" 420
check "apply transitions 84" "$(writes transition)" 84
check "apply comments match the dry run" "$(writes comment)" "$want_comments"
check "apply summary" "$(tail -n 1 <<<"$out")" "created 420, transitioned 84, commented $want_comments"
check "420 issues" "$(q '.issues | length')" 420
check "keys are unique and last" "$(q '[.issues[].description | split("\n") | last] | unique | length')" 420
check "first key" "$(q '.issues[0].description | split("\n") | last')" "seed-key: m1-001"
check "closed issues" "$(q '[.issues[] | select(.state == "Closed")] | length')" 84
check "assigned issues" "$(q '[.issues[] | select(.fields.Assignees == "demo-user")] | length')" 60
check "types" "$(q '[.issues[].fields.Type] | unique | join(",")')" "Bug,Improvement,New Feature,Task"
check "priorities" "$(q '[.issues[].fields.Priority] | unique | join(",")')" "Critical,Major,Minor,Normal"
check "triages" "$(q '[.issues[].fields.Triage] | unique | join(",")')" "needs-info,needs-triage,ready-for-agent,ready-for-human,wontfix"
check "comment total" "$(q '[.issues[].commentCount] | add')" "$want_comments"
check "issues with comments" "$(q '[.issues[] | select(.commentCount > 0)] | length > 10')" true
check "long title cut to server limit" "$(title_of m1-013 | wc -m)" 256
check "long word cut to server limit" "$(title_of m1-212 | wc -m)" 256
check "rejections are reported" "$(grep -c '^REJECTED m1-013 title length 10000: Title: size' <<<"$out")" 1
check "fallbacks are reported" "$(grep -c '^title fallbacks (key:length): m1-013:255 m1-212:255$' <<<"$out")" 1
t=$(title_of m1-038)
check "bidi override kept" "$([[ $t == *$'\xe2\x80\xae'*$'\xe2\x81\xa6'* ]] && echo yes)" yes
t=$(title_of m1-087)
check "ANSI escapes kept" "$([[ $t == *$'\e[31m'*$'\e]8;;'*$'\e[2J'* ]] && echo yes)" yes
t=$(title_of m1-062)
check "ZWJ emoji kept" "$([[ $t == *$'\xf0\x9f\x91\xa8\xe2\x80\x8d\xf0\x9f\x91\xa9'* ]] && echo yes)" yes
check "no raw escape on stdout" "$(grep -c $'\e' <<<"$out" || true)" 0

: >"$STUB_WRITES"
out=$("$script" --apply)
check "rerun summary" "$(tail -n 1 <<<"$out")" "created 0, transitioned 0, commented 0"
check "rerun writes nothing" "$(wc -c <"$STUB_WRITES")" 0

edit_state='(.issues[] | select(.description | endswith("seed-key: m1-005")) | .state) = "Open"
  | (.issues[] | select(.description | endswith("seed-key: m1-003")) | .commentCount) = 0
  | (.issues[] | select(.description | endswith("seed-key: m1-004")) | .state) = "Closed"'
jq "$edit_state" "$STUB_STATE" >"$STUB_STATE.new" && mv "$STUB_STATE.new" "$STUB_STATE"
out=$("$script" --apply)
check "drift summary" "$(tail -n 1 <<<"$out")" "created 0, transitioned 2, commented 3"

reset
out=$(STUB_MAX_TITLE=100000 "$script" --apply)
check "no rejection with a generous server" "$(grep -c '^REJECTED' <<<"$out" || true)" 0
check "10000-character title stored" "$(title_of m1-013 | wc -m)" 10001

reset
if STUB_MAX_TITLE=10 "$script" --apply >"$work/fail.out" 2>"$work/fail.err"; then rc=0; else rc=$?; fi
check "server failure exits 1" "$rc" 1
check "server failure writes nothing" "$(wc -c <"$STUB_WRITES")" 0

reset
if SEED_PROJECT=team/app "$script" --apply >"$work/guard.out" 2>"$work/guard.err"; then rc=0; else rc=$?; fi
check "non-sandbox project exits 2" "$rc" 2
check "non-sandbox project reaches no odev call" "$(wc -c <"$STUB_LOG")" 0
check "non-sandbox project names the rule" "$(grep -c 'must end in -sandbox' "$work/guard.err")" 1

if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
