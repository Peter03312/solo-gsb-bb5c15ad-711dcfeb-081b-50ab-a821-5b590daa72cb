#!/usr/bin/env bash
# 预约发布（定时公开）端到端调用示例。
#
# 流程：建草稿并发布一版 → 建立 2 秒后到期的预约（冻结内容）
#       → 到期前访客只见旧版、草稿改动不影响冻结内容
#       → 到期自动生成不可变新版本，重启 / 重复触发不会重复发布
#       → 取消尚未执行的预约（已取消不能再取消）
#       → 到期前被即时发布抢跑 → 预约标冲突、内容保留、不自动改基准
#       → 时间非法 400、校验不通过 422、已生效 / 冲突预约不能取消 409。
#
# 依赖：curl 与 node（本应用本身就需要 node，用于解析 JSON）。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/schedule-example.sh
# 可重复运行（事件标题带时间戳，避免与历史数据互相干扰）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
del_ed() { curl -s -X DELETE "${h_ed[@]}" "$@"; }
latest_no() { curl -s "$BASE/api/public/versions" | jfield 'd.currentVersionNo'; }
# 若干秒后的 UTC ISO 时刻
iso_in() { node -e 'console.log(new Date(Date.now()+ (+process.argv[1])*1000).toISOString())' "$1"; }
code_of() { curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }

say "0) 口令检查（错误口令应 401）"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${h_json[@]}" \
  -H 'X-Editor-Token: wrong' -d '{}' "$BASE/api/editor/schedules")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 建草稿：2 个事件 + 主张 + 一条先于关系，并先发布一个版本"
E1=$(post "$BASE/api/editor/events" -d '{"title":"定时示例动员会 '$TS'"}' | jfield 'd.event.id')
E2=$(post "$BASE/api/editor/events" -d '{"title":"定时示例通水会 '$TS'"}' | jfield 'd.event.id')
C1=$(post "$BASE/api/editor/events/$E1/claims" \
  -d '{"precision":"day","year":1958,"month":9,"day":12,"source":"定时示例李某口述 '$TS'"}' | jfield 'd.claim.id')
C2=$(post "$BASE/api/editor/events/$E2/claims" \
  -d '{"precision":"month","year":1959,"month":5,"source":"定时示例王某口述 '$TS'"}' | jfield 'd.claim.id')
post "$BASE/api/editor/relations" \
  -d '{"earlierId":'"$E1"',"laterId":'"$E2"',"source":"定时示例二人口述 '$TS'"}' >/dev/null
SEL='[{"eventId":'"$E1"',"claimId":'"$C1"'},{"eventId":'"$E2"',"claimId":'"$C2"'}]'
post "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL"',"baseVersionNo":'"$(latest_no)"',"note":"定时示例旧版","editor":"示例脚本"}' >/dev/null
BASE_NO="$(latest_no)"
echo "当前最新版本：第 $BASE_NO 版"

say "2) 建立 2 秒后到期的预约（冻结事件 / 主张 / 关系 / 求解日期 / 基准版本号）"
AT="$(iso_in 2)"
RESP=$(post "$BASE/api/editor/schedules" \
  -d '{"selection":'"$SEL"',"scheduledAt":"'"$AT"'","editor":"示例脚本","note":"预约公开版"}')
SNO="$(printf '%s' "$RESP" | jfield 'd.schedule.scheduleNo')"
SID="$(printf '%s' "$RESP" | jfield 'd.schedule.id')"
echo "$RESP" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).schedule;
console.log(`预约 #${d.scheduleNo}（id=${d.id}） ${d.status} 到期=${d.scheduledAt} 冻结基准=第 ${d.baseVersionNo} 版`);
for (const e of d.events) console.log(`  冻结：「${e.title}」 ${e.dateLabel} → 求解日期 ${e.resolvedDate} 出处=[${e.source}]`);'

say "3) 到期前：预约为 pending，访客仍只见旧版"
get_ed "$BASE/api/editor/schedules/$SID" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).schedule;
console.log(`状态=${d.status} resultVersionNo=${d.resultVersionNo}`);'
echo "访客当前版本 = $(latest_no)（期望 $BASE_NO）"

say "4) 等待到期（约 4 秒，默认每 1 秒轮询一次；重启也会在启动时立即追赶）"
sleep 4
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
console.log(`访客当前版本=第 ${d.currentVersionNo} 版，说明=[${d.version.note}] 编辑=[${d.version.editor}]`);
for (const e of d.version.events) console.log(`  「${e.title}」 求解日期=${e.resolvedDate} 出处=[${e.source}]`);
console.log("关系出处 =", d.version.relations.map(r=>`[${r.source}]`).join(", "));'
EXPECTED_NO="$((BASE_NO+1))"
get_ed "$BASE/api/editor/schedules/$SID" | EXPECTED="$EXPECTED_NO" node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).schedule;
if (d.status!=="published" || d.resultVersionNo!==Number(process.env.EXPECTED)) process.exit(1);
console.log("OK：预约 #"+d.scheduleNo+" "+d.status+"，已生成第 "+d.resultVersionNo+" 版，执行于 "+d.executedAt+" UTC");'

say "5) 重复触发不重复发布（再等一轮，版本与预约状态不变）"
sleep 2
[ "$(latest_no)" = "$((BASE_NO+1))" ] && echo "OK：最新版本仍为第 $((BASE_NO+1)) 版" || { echo FAIL; exit 1; }
# 已生效预约不能取消
del_ed "$BASE/api/editor/schedules/$SID" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.code!=="SCHEDULE_NOT_PENDING") process.exit(1);
console.log(`OK：取消已生效预约被拒：${d.code}（${d.scheduleStatus}）`);'

say "6) 取消尚未执行的预约：建立 2999 年到期的预约后取消"
FAR="$(post "$BASE/api/editor/schedules" \
  -d '{"selection":'"$SEL"',"scheduledAt":"2999-01-01T00:00:00Z","note":"将被取消"}' \
  | jfield 'd.schedule.id')"
del_ed "$BASE/api/editor/schedules/$FAR" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).schedule;
if (d.status!=="cancelled") process.exit(1);
console.log(`OK：预约 id=${d.id} 状态=${d.status}`);'
del_ed "$BASE/api/editor/schedules/$FAR" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.code!=="SCHEDULE_NOT_PENDING") process.exit(1);
console.log("OK：重复取消返回 409 SCHEDULE_NOT_PENDING");'

say "7) 冲突：预约 2 秒后到期，但到期前即时发布抢跑 → 预约标冲突、内容保留、不发布"
AT2="$(iso_in 2)"
CID="$(post "$BASE/api/editor/schedules" \
  -d '{"selection":'"$SEL"',"scheduledAt":"'"$AT2"'","note":"将冲突的预约"}' | jfield 'd.schedule.id')"
BEFORE="$(latest_no)"
post "$BASE/api/editor/publish" \
  -d '{"selection":'"$SEL"',"baseVersionNo":'"$BEFORE"',"note":"抢跑即时版","editor":"另一位编辑"}' >/dev/null
echo "即时发布后最新 = 第 $(latest_no) 版，等待预约到期…"
sleep 4
get_ed "$BASE/api/editor/schedules/$CID" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")).schedule;
if (d.status!=="conflict") { console.error("期望 conflict，实际", d.status); process.exit(1); }
console.log(`OK：预约 #${d.scheduleNo} 状态=${d.status}：冻结基准第 ${d.baseVersionNo} 版，到期时最新第 ${d.conflictVersionNo} 版`);
console.log(`     冻结内容保留：${d.events.length} 个事件、${d.relations.length} 条关系，仍可在工作台查看`);'
# 访客看到的是抢跑即时版，没有为冲突预约生成新版本
curl -s "$BASE/api/public/chronicle" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.version.note!=="抢跑即时版") process.exit(1);
console.log("OK：访客最新版说明 =", d.version.note, "（冲突预约未发布、未自动改基准）");'

say "8) 参数非法：过期时刻 / 只给日期 / 提交 baseVersionNo / 校验不通过"
[ "$(code_of "$BASE/api/editor/schedules" -d '{"selection":'"$SEL"',"scheduledAt":"2000-01-01T00:00:00Z"}')" = 400 ] \
  && echo "OK：过期时刻 400" || { echo FAIL; exit 1; }
[ "$(code_of "$BASE/api/editor/schedules" -d '{"selection":'"$SEL"',"scheduledAt":"2099-01-01"}')" = 400 ] \
  && echo "OK：只给日期（缺时刻 / 时区）400" || { echo FAIL; exit 1; }
[ "$(code_of "$BASE/api/editor/schedules" -d '{"selection":'"$SEL"',"scheduledAt":"2999-01-01T00:00:00Z","baseVersionNo":1}')" = 400 ] \
  && echo "OK：提交 baseVersionNo 400（基准由服务器冻结）" || { echo FAIL; exit 1; }
post "$BASE/api/editor/schedules" \
  -d '{"selection":[{"eventId":'"$E1"',"claimId":'"$C1"'}],"scheduledAt":"2999-01-01T00:00:00Z"}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if (d.status!==422 || !d.errors.some(e=>e.type==="missing")) { console.error(JSON.stringify(d)); process.exit(1); }
console.log("OK：缺事件选择（未通过发布校验）→ 422 missing，未建立预约");'

say "9) 工作台查看全部预约（含冻结内容）"
get_ed "$BASE/api/editor/schedules" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
for (const s of d.schedules)
  console.log(`  #${s.scheduleNo} [${s.status}] ${s.scheduledAt} 基准=第 ${s.baseVersionNo} 版` +
    (s.resultVersionNo?` → 第 ${s.resultVersionNo} 版`:"") + (s.conflictVersionNo?` 冲突时最新第 ${s.conflictVersionNo} 版`:""));'

say "全部断言通过 ✅"
echo "提示：可在 $BASE/editor 的「预约发布」卡片建立 / 查看 / 取消预约；$BASE/ 查看访客年表。"
