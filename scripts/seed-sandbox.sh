#!/usr/bin/env bash
set -Eeuo pipefail
shopt -s inherit_errexit
trap 'echo "seed-sandbox: error at line $LINENO" >&2' ERR

ODEV=${ODEV:-odev}
PROJECT=${SEED_PROJECT:-team/app-sandbox}
HOST=${SEED_HOST:-http://192.0.2.30:6610}
TOTAL=420
ASSIGNEE_LOGIN=${SEED_ASSIGNEE:-demo-user}
TITLE_RUNGS=(8000 5000 4000 3000 2000 1500 1000 750 500 400 300 255 200 150 100)

TYPES=(Bug "New Feature" Improvement Task)
PRIORITIES=(Normal Major Minor Critical Normal Normal Minor Major)
TRIAGES=(needs-triage ready-for-agent ready-for-human needs-info wontfix)
AREAS=("Login page" "Issue list" "Sort order" "Search box" "Detail pane"
  "Comment form" "Label chips" "Date column" "Keyboard focus" "Empty state"
  "Pagination" "Export button")
PROBLEMS=("slow first paint" "wrong count after refresh" "text clipped"
  "flickers on resize" "ignores the theme" "loses scroll position"
  "shows a stale value")

usage() {
  cat <<USAGE
Usage: seed-sandbox.sh [--apply]

Seed $PROJECT with $TOTAL issues (keys m1-001..m1-$TOTAL) through \$ODEV
(default: odev). Without --apply it prints what it would write and exits 0.
Environment: ODEV (odev binary), SEED_PROJECT (must end in -sandbox), SEED_ASSIGNEE
(login that gets the assigned issues),
SEED_HOST (OneDev base URL, default http://192.0.2.30:6610).
USAGE
}

die() {
  echo "seed-sandbox: $*" >&2
  exit 1
}

log() { printf '%s\n' "$*"; }

safe() {
  local LC_ALL=C s=${1:0:${2:-80}}
  printf '%s' "${s//[^[:print:]]/?}"
}

repeat() { head -c "$2" /dev/zero | tr '\0' "$1"; }

hostile_title() {
  local n p
  printf -v n %03d "$1"
  p="Seed $n: "
  local rlm=$'\xe2\x80\x8f' rlo=$'\xe2\x80\xae'
  local lri=$'\xe2\x81\xa6' rli=$'\xe2\x81\xa7' fsi=$'\xe2\x81\xa8' pdi=$'\xe2\x81\xa9'
  local zwj=$'\xe2\x80\x8d' zwsp=$'\xe2\x80\x8b' esc=$'\e'
  local c1=$'\xcc\x81' c2=$'\xcc\x83' c3=$'\xcc\xa7' c4=$'\xcc\x88'
  case $1 in
    13) H_TITLE="$p$(repeat A $((10000 - ${#p})))" ;;
    38) H_TITLE="${p}${rlm}right to left${rlo} override ${lri}isolate${pdi} ${rli}two${pdi} ${fsi}three${pdi} end" ;;
    62)
      H_TITLE="${p}family "$'\xf0\x9f\x91\xa8'"${zwj}"$'\xf0\x9f\x91\xa9'"${zwj}"$'\xf0\x9f\x91\xa7'"${zwj}"$'\xf0\x9f\x91\xa6'" flag "$'\xf0\x9f\x87\xac\xf0\x9f\x87\xa7'" tones "$'\xf0\x9f\x91\x8d\xf0\x9f\x8f\xbd'" "$'\xf0\x9f\x91\x8b\xf0\x9f\x8f\xbf'
      ;;
    87) H_TITLE="${p}${esc}[31m red ${esc}[0m ${esc}]8;;http://example.com${esc}\\link${esc}]8;;${esc}\\ ${esc}[2J cleared" ;;
    111) H_TITLE="${p}**bold** _it_ [link](http://example.com) # heading \`code\` \`\`\`fence\`\`\`" ;;
    139) H_TITLE="${p}refs #3 #7 team/app#5 and #99999" ;;
    163) H_TITLE="${p}zero${zwsp}width${zwsp}spaces${zwsp}inside${zwsp}words" ;;
    188) H_TITLE="${p}e${c1}${c2}${c3}${c4}${c1}${c2} a${c1}${c1}${c1}${c1}${c1} o${c3}${c4}${c2}" ;;
    212) H_TITLE="${p}$(repeat W $((400 - ${#p})))" ;;
    237) H_TITLE="${p}<script>alert(1)</script>" ;;
    *) return 1 ;;
  esac
}

build_spec() {
  local i=$1 n
  printf -v n %03d "$i"
  S_KEY="m1-$n"
  S_TYPE=${TYPES[i % 4]}
  S_PRIORITY=${PRIORITIES[i % 8]}
  S_TRIAGE=${TRIAGES[i % 5]}
  S_ASSIGNEE=""
  if ((i % 7 == 0)); then S_ASSIGNEE=$ASSIGNEE_LOGIN; fi
  S_STATE=Open
  if ((i % 5 == 0)); then S_STATE=Closed; fi
  if ((i % 7 == 3)); then
    S_COMMENTS=3
  elif ((i % 3 == 1)); then
    S_COMMENTS=1
  elif ((i % 11 == 2)); then
    S_COMMENTS=2
  else
    S_COMMENTS=0
  fi
  S_HOSTILE=""
  if hostile_title "$i"; then
    S_HOSTILE=1
    S_TITLE=$H_TITLE
  else
    S_TITLE="Seed $n: ${AREAS[i % 12]}: ${PROBLEMS[i % 7]}"
  fi
  S_BODY="Seeded by scripts/seed-sandbox.sh for the live test lanes."$'\n\n'"seed-key: $S_KEY"
}

odev_issue() {
  local verb=$1
  shift
  "$ODEV" issue "$verb" --host "$HOST" --project "$PROJECT" --json "$@"
}

load_state() {
  local json rows
  NUM=() STATE=() CCOUNT=()
  json=$(odev_issue list --state all -L 1000)
  jq -e 'type == "array"' <<<"$json" >/dev/null || die "odev list did not return a JSON array"
  rows=$(jq -r '.[]
    | (.description // "" | capture("seed-key: (?<k>m1-[0-9]{3})\\s*$")? // empty) as $c
    | [$c.k, .number, .state, (.commentCount // 0)] | @tsv' <<<"$json")
  local key num st cc
  while IFS=$'\t' read -r key num st cc; do
    [[ -n $key ]] || continue
    [[ -z ${NUM[$key]+x} ]] || continue
    NUM[$key]=$num
    STATE[$key]=$st
    CCOUNT[$key]=$cc
  done <<<"$rows"
}

try_create() {
  local args=(create --title "$1" --body "$S_BODY" -F "Type=$S_TYPE" -F "Priority=$S_PRIORITY" -F "Triage=$S_TRIAGE")
  if [[ -n $S_ASSIGNEE ]]; then args+=(-F "Assignees=$S_ASSIGNEE"); fi
  CREATE_OUT=$(odev_issue "${args[@]}" 2>&1)
}

create_issue() {
  local title=$S_TITLE rung what
  what="$S_KEY $S_TYPE/$S_PRIORITY${S_ASSIGNEE:+ @$S_ASSIGNEE} \"$(safe "$S_TITLE" 60)\""
  if ((APPLY == 0)); then
    log "would create $what"
    return 0
  fi
  if try_create "$title"; then
    log "create $what"
    return 0
  fi
  [[ -n $S_HOSTILE ]] || die "create $S_KEY failed: $(safe "$CREATE_OUT" 300)"
  log "REJECTED $S_KEY title length ${#title}: $(safe "$CREATE_OUT" 300)"
  for rung in "${TITLE_RUNGS[@]}"; do
    ((${#S_TITLE} > rung)) || continue
    if try_create "${S_TITLE:0:rung}"; then
      log "create $what (title cut to $rung characters)"
      FALLBACKS+=("$S_KEY:$rung")
      return 0
    fi
    log "REJECTED $S_KEY title length $rung: $(safe "$CREATE_OUT" 300)"
  done
  die "create $S_KEY failed at every title length"
}

APPLY=0
while (($#)); do
  case $1 in
    --apply) APPLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ $PROJECT != *-sandbox ]]; then
  echo "seed-sandbox: refusing project '$PROJECT': its name must end in -sandbox" >&2
  exit 2
fi

declare -A NUM STATE CCOUNT
FALLBACKS=()
created=0 transitioned=0 commented=0

log "seed-sandbox: project $PROJECT, $TOTAL issues, $( ((APPLY)) && echo apply || echo dry run)"
load_state

for ((i = 1; i <= TOTAL; i++)); do
  build_spec "$i"
  if [[ -z ${NUM[$S_KEY]+x} ]]; then
    create_issue
    created=$((created + 1))
  fi
done

if ((APPLY && created > 0)); then load_state; fi

for ((i = 1; i <= TOTAL; i++)); do
  build_spec "$i"
  if [[ -n ${NUM[$S_KEY]+x} ]]; then
    num=${NUM[$S_KEY]} cur=${STATE[$S_KEY]} have=${CCOUNT[$S_KEY]}
  elif ((APPLY)); then
    die "$S_KEY is missing after create"
  else
    num="(new)" cur=Open have=0
  fi
  if [[ $cur != "$S_STATE" ]]; then
    if ((APPLY)); then
      odev_issue transition "$num" --state "$S_STATE" >/dev/null
      log "transition $S_KEY #$num $cur -> $S_STATE"
    else
      log "would transition $S_KEY #$num $cur -> $S_STATE"
    fi
    transitioned=$((transitioned + 1))
  fi
  for ((k = have + 1; k <= S_COMMENTS; k++)); do
    if ((APPLY)); then
      odev_issue comment "$num" --body "Seed comment $k of $S_COMMENTS for $S_KEY." >/dev/null
      log "comment $S_KEY #$num $k of $S_COMMENTS"
    else
      log "would comment $S_KEY #$num $k of $S_COMMENTS"
    fi
    commented=$((commented + 1))
  done
done

if ((${#FALLBACKS[@]} > 0)); then log "title fallbacks (key:length): ${FALLBACKS[*]}"; fi
if ((APPLY)); then
  log "created $created, transitioned $transitioned, commented $commented"
else
  log "dry run, nothing written: would create $created, transition $transitioned, comment $commented"
  log "to apply: $0 --apply"
fi
