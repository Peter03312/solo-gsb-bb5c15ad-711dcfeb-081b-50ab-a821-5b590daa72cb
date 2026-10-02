#!/usr/bin/env bash
# 出处遮盖（按出处原文撤回公开展示）端到端调用示例。
#
# 流程：建草稿 → 发布两个版本 → 只读预览命中 → 携最新版本号确认遮盖
#       → 核对访客视图（「出处已遮盖」）与编辑口令原文视图
#       → 空文本 400、预览后新版本 409、重复确认幂等。
#
# 依赖：curl 与 node（本应用本身就需要 node，用于解析 JSON）。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/redaction-example.sh
# 可重复运行（出处文本带时间戳，避免与历史数据互相干扰）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"
SRC="示例受访人口述 ${TS}（2026-09-01 访谈，录音 01 段）"
SRC2="另一位受访人口述 ${TS}"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
# 从标准输入的 JSON 中取字段：echo "$json" | jfield 'd.event.id'
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
latest_no() { curl -s "$BASE/api/public/versions" | jfield 'd.currentVersionNo'; }

say "0) 口令检查（错误口令应 401）"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" \
  -H 'X-Editor-Token: wrong-token' -d '{"source":"x"}' "$BASE/api/editor/redaction-preview")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 建草稿：2 个事件 + 主张（第 1 个出处为 SRC）+ 一条出处同为 SRC 的先于关系"
E1=$(post "$BASE/api/editor/events" -d '{"title":"示例动员会 '$TS'"}' | jfield 'd.event.id')
E2=$(post "$BASE/api/editor/events" -d '{"title":"示例通水会 '$TS'"}' | jfield 'd.event.id')
C1=$(post "$BASE/api/editor/events/$E1/claims" \
  -d '{"precision":"day","year":1958,"month":9,"day":12,"source":"'"$SRC"'"}' | jfield 'd.claim.id')
C2=$(post "$BASE/api/editor/events/$E2/claims" \
  -d '{"precision":"month","year":1959,"month":5,"source":"志书第 87 页 '$TS'"}' | jfield 'd.claim.id')
post "$BASE/api/editor/relations" \
  -d '{"earlierId":'"$E1"',"laterId":'"$E2"',"source":"'"$SRC"'"}' >/dev/null
echo "事件 $E1、$E2；主张 $C1、$C2"

say "2) 发布下一版"
post "$BASE/api/editor/publish" \
  -d '{"selection":[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'}],"baseVersionNo":'"$(latest_no)"',"note":"遮盖示例首版","editor":"示例脚本"}' \
  | jfield '"versionNo=" + d.versionNo + "\n"'

say "3) 草稿再加一个出处同为 SRC 的事件，发布下一版（验证遮盖会跨全部版本命中）"
E3=$(post "$BASE/api/editor/events" -d '{"title":"示例抽水机到站 '$TS'"}' | jfield 'd.event.id')
C3=$(post "$BASE/api/editor/events/$E3/claims" \
  -d '{"precision":"year","year":1962,"source":"'"$SRC"'"}' | jfield 'd.claim.id')
post "$BASE/api/editor/publish" \
  -d '{"selection":[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'},{"eventId":'"$E3"',"claimId":'"$C3"'}],"baseVersionNo":'"$(latest_no)"',"note":"遮盖示例二版","editor":"示例脚本"}' \
  | jfield '"versionNo=" + d.versionNo + "\n"'

say "4) 只读预览（首尾空白会被去除；返回全部已发布版本的命中位置与数量）"
PREVIEW=$(post "$BASE/api/editor/redaction-preview" -d '{"source":"  '"$SRC"'  "}')
echo "$PREVIEW" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("source        =", d.source);
console.log("latestVersion =", d.currentVersionNo, " 已发布版本数 =", d.versionCount);
console.log("事件主张命中  =", d.totalEventHitCount, " 先于关系命中 =", d.totalRelationHitCount, " 合计 =", d.totalHitCount);
for (const v of d.versions) console.log(`  第 ${v.versionNo} 版：事件 ${v.eventHitCount} 处、关系 ${v.relationHitCount} 处`,
  v.eventHits.map(h=>`事件「${h.title}」`).join(" "),
  v.relationHits.map(h=>`关系 ${h.earlierEventId}→${h.laterEventId}`).join(" "));'
LATEST=$(echo "$PREVIEW" | jfield 'd.currentVersionNo')

say "5) 空 / 纯空白文本 → 400"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" \
  "$BASE/api/editor/redaction-preview" -d '{"source":"   "}')
[ "$code" = 400 ] && echo "OK：空文本返回 400" || { echo "FAIL：期望 400，实际 $code"; exit 1; }

say "6) 携预览时的最新版本号确认遮盖"
post "$BASE/api/editor/redaction" \
  -d '{"source":"'"$SRC"'","currentVersionNo":'"$LATEST"',"editor":"示例脚本"}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("alreadyRedacted =", d.alreadyRedacted, " 遮盖标签 =", d.redactedLabel, " 当前命中 =", d.totalHitCount);'

say "7) 访客读取最新年表：命中处显示「出处已遮盖」，其余字段不变"
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("currentVersionNo =", d.currentVersionNo);
for (const e of d.version.events) console.log(`  事件「${e.title}」 出处=[${e.source}] 日期=${e.resolvedDate}`);
for (const r of d.version.relations) console.log(`  关系 ${r.earlierEventId}→${r.laterEventId} 出处=[${r.source}]`);'

say "8) 访客读取指定历史版本：同样遮盖"
curl -s "$BASE/api/public/versions/1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("第 1 版事件出处 =", d.version.events.map(e=>e.source));
console.log("第 1 版关系出处 =", d.version.relations.map(r=>r.source));'

say "9) 持编辑口令查看版本原文：仍是原文；草稿不受影响"
get_ed "$BASE/api/editor/versions/1/raw" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("原文视图事件出处 =", d.version.events.map(e=>e.source));
console.log("原文视图关系出处 =", d.version.relations.map(r=>r.source));'
get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("草稿区出处仍为原文 =", JSON.stringify(d.events.flatMap(e=>e.claims.map(c=>c.source)).filter(s=>s.includes("'"$TS"'"))));'

say "10) 重复确认 → 200 alreadyRedacted:true（幂等，不重复登记）"
post "$BASE/api/editor/redaction" -d '{"source":"'"$SRC"'","currentVersionNo":999}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.alreadyRedacted !== true) process.exit(1);
console.log("OK：alreadyRedacted =", d.alreadyRedacted, " 当前命中 =", d.totalHitCount);'

say "11) 预览后若有新版本 → 确认 409 VERSION_CONFLICT，不落库"
post "$BASE/api/editor/redaction-preview" -d '{"source":"'"$SRC2"'"}' >/dev/null  # 先预览另一文本
CUR="$(latest_no)"
BEFORE=$(get_ed "$BASE/api/editor/redactions" | jfield 'd.redactions.length')
# 期间发布一个新版本（内容不变，仅为推进版本号）
post "$BASE/api/editor/publish" \
  -d '{"selection":[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'},{"eventId":'"$E3"',"claimId":'"$C3"'}],"baseVersionNo":'"$CUR"',"note":"推进版本号触发冲突","editor":"示例脚本"}' >/dev/null
RESP=$(post -w $'\n%{http_code}' "$BASE/api/editor/redaction" \
  -d '{"source":"'"$SRC2"'","currentVersionNo":'"$CUR"'}')
code=$(printf '%s' "$RESP" | tail -1)
printf '%s' "$RESP" | sed '$d' | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log("code =", d.code, " currentVersionNo =", d.currentVersionNo, " expectedVersionNo =", d.expectedVersionNo);'
echo "HTTP $code"
[ "$code" = 409 ] || { echo "FAIL：期望 409，实际 $code"; exit 1; }
AFTER=$(get_ed "$BASE/api/editor/redactions" | jfield 'd.redactions.length')
[ "$BEFORE" = "$AFTER" ] && echo "OK：冲突未登记新遮盖（清单数量 $AFTER 不变）" || { echo "FAIL：409 却落库了"; exit 1; }

say "12) 已登记遮盖清单（编辑者视角，含原文）"
get_ed "$BASE/api/editor/redactions" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
for (const r of d.redactions.filter(x=>x.source.includes("'"$TS"'")))
  console.log(`  [${r.id}] ${r.source}  登记于 ${r.redactedAt} UTC  by ${r.editor||"匿名"}`);'

say "全部断言通过 ✅"
echo "提示：可打开 $BASE/ 查看访客年表（出处显示「出处已遮盖」），$BASE/editor 查看版本原文。"
