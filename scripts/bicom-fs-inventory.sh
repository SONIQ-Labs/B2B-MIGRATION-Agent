#!/bin/bash
# bicom-fs-inventory.sh — filesystem inventory of all tenants on a PBXware box.
# Read-only. Emits single JSON object keyed by tenant code.

MONITOR=/opt/pbxware/pw/var/spool/asterisk/monitor
SOUNDS=/opt/pbxware/pw/var/lib/asterisk/sounds
VOICEMAIL=/opt/pbxware/pw/var/spool/asterisk/voicemail
MOH=/opt/pbxware/pw/var/lib/asterisk/moh

json_arr_from_lines() {
  awk 'BEGIN{first=1} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); if(!first)printf ","; printf "\"%s\"", $0; first=0}'
}

echo "{"
FIRST_T=1

TENANTS=$(ls "$MONITOR" 2>/dev/null | grep -E '^[0-9]+$' | sort -n)

for T in $TENANTS; do
  [ "$FIRST_T" -eq 1 ] || echo ","
  FIRST_T=0

  REC_DIR="$MONITOR/$T"
  REC_COUNT=0; REC_BYTES=0; REC_SAMPLE=""
  if [ -d "$REC_DIR" ]; then
    REC_COUNT=$(find "$REC_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
    REC_BYTES=$(du -sb "$REC_DIR" 2>/dev/null | cut -f1)
    [ -z "$REC_BYTES" ] && REC_BYTES=0
    REC_SAMPLE=$(find "$REC_DIR" -type f 2>/dev/null | head -3 | json_arr_from_lines)
  fi

  SND_DIR="$SOUNDS/$T"
  SND_COUNT=0; SND_GREETINGS=""; SND_CUSTOM=""
  if [ -d "$SND_DIR" ]; then
    SND_COUNT=$(ls "$SND_DIR" 2>/dev/null | wc -l | tr -d ' ')
    SND_GREETINGS=$(ls "$SND_DIR" 2>/dev/null | grep '^greeting-' | sed 's/\.[^.]*$//' | sort -u | head -50 | json_arr_from_lines)
    SND_CUSTOM=$(ls "$SND_DIR" 2>/dev/null | grep -v '^greeting-' | sed 's/\.[^.]*$//' | sort -u | head -50 | json_arr_from_lines)
  fi

  VM_BOXES=""
  VM_DIR="$VOICEMAIL/t-$T"
  if [ -d "$VM_DIR" ]; then
    for EXTDIR in "$VM_DIR"/*; do
      [ -d "$EXTDIR" ] || continue
      EXT=$(basename "$EXTDIR")
      NEW=$(find "$EXTDIR/INBOX" -name '*.wav' 2>/dev/null | wc -l | tr -d ' ')
      OLD=$(find "$EXTDIR/Old" -name '*.wav' 2>/dev/null | wc -l | tr -d ' ')
      HAS_GREETING=0
      [ -f "$EXTDIR/greet.wav" ] && HAS_GREETING=1
      [ -f "$EXTDIR/unavail.wav" ] && HAS_GREETING=1
      [ -f "$EXTDIR/busy.wav" ] && HAS_GREETING=1
      TOTAL=$((NEW + OLD))
      if [ "$TOTAL" -gt 0 ] || [ "$HAS_GREETING" -eq 1 ]; then
        [ -n "$VM_BOXES" ] && VM_BOXES="${VM_BOXES},"
        VM_BOXES="${VM_BOXES}{\"ext\":\"$EXT\",\"unread\":$NEW,\"old\":$OLD,\"has_greeting\":$HAS_GREETING}"
      fi
    done
  fi

  MOH_DIR="$MOH/m-$T"
  MOH_COUNT=0; MOH_FILES=""
  if [ -d "$MOH_DIR" ]; then
    MOH_COUNT=$(ls "$MOH_DIR" 2>/dev/null | wc -l | tr -d ' ')
    MOH_FILES=$(ls "$MOH_DIR" 2>/dev/null | head -20 | json_arr_from_lines)
  fi

  printf '"%s":{"recordings":{"count":%s,"bytes":%s,"sample":[%s]},"sounds":{"count":%s,"greetings":[%s],"custom":[%s]},"voicemail":{"boxes":[%s]},"moh":{"count":%s,"files":[%s]}}' \
    "$T" "$REC_COUNT" "$REC_BYTES" "$REC_SAMPLE" \
    "$SND_COUNT" "$SND_GREETINGS" "$SND_CUSTOM" \
    "$VM_BOXES" "$MOH_COUNT" "$MOH_FILES"
done

echo
echo "}"
