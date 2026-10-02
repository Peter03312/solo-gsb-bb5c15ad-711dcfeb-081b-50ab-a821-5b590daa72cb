# 地方口述史事件年表（Oral Chronicle）

供地方口述史团队本机使用的事件年表 Web 应用。编辑者录入**事件**、带**出处**的时间主张（可精确到年 / 月 / 日），以及事件之间的**「先于」关系**；同一事件可以保留多条互相矛盾的主张。发布时为每个事件选定一条主张，系统检查全部先后关系后生成**不可变版本**。访客只能看到最新已发布年表。

- 技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 浏览器原生界面（无需前端构建）

## 一键启动（Docker Compose，推荐）

```bash
docker compose up -d --build
```

启动即完成：安装依赖、初始化 SQLite 数据库（自动建表）、挂载持久化数据卷。
Compose 默认 `SEED_DEMO=1`，首次启动会写入一组演示草稿（3 个事件，含矛盾主张），方便体验发布流程。

访问地址：

| 用途 | 地址 |
| --- --- | --- |
| 访客年表（只读最新已发布版本） | http://localhost:3000/ |
| 编辑者工作台 | http://localhost:3000/editor |
| 最新发布快照 JSON | http://localhost:3000/api/public/chronicle |

编辑者口令默认在 `docker-compose.yml` 中为 `change-me-please`，**请修改后使用**：在编辑台右上角输入口令并保存（仅保存在该浏览器 localStorage 中，请求以 `X-Editor-Token` 头发送）。

停止与查看日志：

```bash
docker compose logs -f
docker compose down            # 保留数据卷
docker compose down -v         # 同时删除数据库数据卷
```

## 不用 Docker，本机直接运行

要求 Node.js ≥ 20。

```bash
npm install
npm start                     # 默认 http://localhost:3000
# 可选：写入演示草稿
npm run seed
npm test                      # 运行求解器与接口测试
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（本机直跑可设 `127.0.0.1`） |
| `EDITOR_TOKEN` | `editor` | 编辑者口令，生产使用务必修改 |
| `DB_PATH` | `./data/chronicle.db`（容器内 `/app/data/chronicle.db`） | SQLite 数据库文件路径，目录自动创建 |
| `SEED_DEMO` | 未设置 | 设为 `1` 时启动写入演示草稿（仅在库为空时） |
| `SCHEDULE_TICK_MS` | `1000` | 预约发布到期检查间隔（毫秒）；每次服务启动都会立即补跑一次到期预约 |

改端口示例：

```bash
PORT=8080 EDITOR_TOKEN=my-secret npm start
# 访客 http://localhost:8080/ ，编辑 http://localhost:8080/editor
```

## 使用方式

### 编辑（http://localhost:3000/editor）

1. 右上角输入编辑者口令并保存。
2. 在「事件与时间主张」中添加事件；每个事件可添加**任意多条**时间主张，每条必须填写出处（受访人 / 访谈时间 / 档案全宗 / 页码等），矛盾说法可用「考异备注」记录。
3. 用单选按钮为**每个**事件选定一条拟发布主张（选择只保存在当前浏览器中）。
4. 在「先于」关系中声明 A 严格先于 B，可附出处。
5. 「校验能否发布」先预览；「发布新版本」正式生成不可变快照。也可以「预约发布」：指定一个**未来 UTC 时刻**，系统在到期时自动尝试发布（见下节）。

### 发布规则（为什么会发布失败）

粗精度日期按其覆盖的闭区间处理：

- 精确到**年**（如「1958 年」）：区间 `1958-01-01 ~ 1958-12-31`
- 精确到**月**（如「1958 年 3 月」）：区间 `1958-03-01 ~ 1958-03-31`
- 精确到**日**：区间即当天

发布时，系统为每个事件在其选定主张的区间内确定一个**具体日期**，并要求每条「先于」关系两端**严格相差至少一天**（不允许同一天）。以下情况会拒绝发布，错误面板会标明涉事事件与关系（点击可定位），**上一已发布版本保持不变**：

1. **缺少主张**：有事件未选定主张（或选定了已删除 / 不属于该事件的主张）；
2. **关系成环**：「先于」关系构成有向环（含自环，自环在录入时即被禁止）；
3. **时间无解**：区间内不存在满足全部严格先后关系的具体日期。错误信息会给出一条导致矛盾的见证链，例如「冬月会议 先于 春月会议」却分别主张 1958 年 12 月、1958 年 1 月。

发布成功后得到递增版本号（第 1 版、第 2 版……），事件、所选主张（精度、区间、出处、考异）、关系与求解日期全部**复制进版本快照**；此后修改草稿不影响任何旧版本。访客页只展示当前最新版本。

### 预约未来时刻（UTC）自动发布

除即时发布外，编辑者可为**通过现有发布校验的草稿**选定每事件主张，并指定一个**未来 UTC 时间**预约发布：

- **建立即冻结**：预约成功时，系统把当时的**事件、每事件所选主张、「先于」关系、求解日期**与**当前最新版本号（冻结基准版本号）**整体复制进预约。此后编辑者修改草稿、增删主张、从历史版本恢复草稿，**都不改变预约内容**；到期前访客仍只见当前最新版本。
- **建立即校验**：时间必须是合法的未来 UTC 时刻（形如 `2026-10-02T12:34:00Z`，只接受 `Z` 结尾；秒可省略）。时间非法或已过期返回 **400**（`INVALID_SCHEDULED_TIME`）；主张选择为空 **400**；草稿不能通过现有发布校验（缺主张 / 成环 / 时间无解）返回 **422**（与即时发布同一错误结构）；`baseVersionNo` 不等于当前最新版本号返回 **409** `VERSION_CONFLICT`。**以上情况都不建立预约**。
- **到期执行**：调度器在服务启动时立即补跑一次（停机期间到期的预约不丢失），之后每 1 秒检查一次（可用 `SCHEDULE_TICK_MS` 调整）。到期的待执行预约按**预约时间、预约号顺序**逐条处理：
  - 仅当**冻结的基准版本号仍等于当前最新版本号**时，用冻结内容在一个事务内**生成一个不可变新版本**（写版本与翻转预约状态同事务，失败整体回滚，绝不留半版）；
  - 否则把预约标记为 **冲突（conflict）**：**不发布、不自动改基准**，冻结的完整内容保留在预约详情中供编辑者查看，编辑者可核对后即时发布或另建预约。
- **幂等与重启安全**：重启服务或重复触发都**不会重复发布**——只有 `pending`（待执行）状态的预约会被处理，已发布 / 冲突 / 已取消的预约永不再执行。
- **查看与取消**：编辑者在工作台「发布」卡片中可查看全部预约（待执行的在前，显示倒计时、冻结基准版本号与冻结事件摘要）、展开冻结详情。**尚未执行的预约可随时取消**（取消幂等）；**已生效（已发布 / 冲突）的预约不能取消**（409 `SCHEDULE_NOT_CANCELLABLE`）。
- 预约生成的新版本与即时发布完全同源（同一快照构造与求解逻辑），**公开读取继续应用出处遮盖**；即时发布、历史版本读取与原有接口保持兼容。

```bash
TOKEN=editor
BASE=http://localhost:3000
# 先用现有接口取草稿事件/主张，组装 selection（与即时发布相同）
# 建立 5 分钟后到期的预约（时间必须是未来 UTC，Z 结尾）
AT=$(node -e 'console.log(new Date(Date.now()+300000).toISOString().replace(/\.\d{3}Z$/,"Z"))')
curl -s -X POST "$BASE/api/editor/schedules" \
  -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
  -d '{"selection":[{"eventId":1,"claimId":1},{"eventId":2,"claimId":3}],
       "scheduledAt":"'"$AT"'","baseVersionNo":2,
       "editor":"志愿者小王","note":"纪念日后自动公开"}'
# => 201 {"ok":true,"schedule":{"scheduleNo":1,"scheduledAt":"…Z","status":"pending",
#        "baseVersionNo":2,"frozen":{"events":[…含求解日期…],"relations":[…]}, ...}}

curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/schedules"           # 预约列表
curl -s -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/schedules/1"         # 冻结内容详情
curl -s -X DELETE -H "X-Editor-Token: $TOKEN" "$BASE/api/editor/schedules/1"  # 到期前取消
```

到期后预约详情的 `status` 变为 `published`（附 `resultVersionNo`）或 `conflict`（附 `resultMessage`，冻结内容仍在 `frozen` 中）。完整可运行的端到端示例见 `examples/schedule-example.sh`（建预约、改草稿验证冻结、等待自动发布、抢先发布触发冲突、取消与各类 400/409/422，约 25 秒）。

### 从历史版本恢复草稿（预览 → 确认）

编辑台右侧「已发布版本」中，每个版本都有「预览并恢复草稿」按钮。恢复**不产生新版本、不改动任何历史快照**，只替换草稿区：

1. **预览（只读）**：弹窗双栏列出——
   - 该版的事件、每个事件在**当版被选的那一条时间主张**（精度、区间、出处、考异）、全部「先于」关系；
   - 当前草稿中将被替换掉的全部事件（含未选主张）与关系，以及草稿修订号、最新版本号。
   预览不写任何数据。
2. **确认恢复**：请求必须提交预览时返回的**草稿修订号**与**最新版本号**。确认成功时系统在一个事务内**原子替换整个草稿**：清空当前草稿的事件 / 主张 / 关系，按该版快照重建，并**只恢复当版被选的主张**（同一事件其它未选主张不恢复）。返回：
   - 旧快照 id → 新草稿 id 的映射（事件、主张、关系）；
   - 每事件一条的**待选主张**，编辑台据此自动填好单选；
   - 新草稿修订号（每次恢复只推进一次修订号）。
3. **冲突保护**：确认前若草稿被任何人增删改过（修订号变化），或期间发布了更新的版本（最新版本号变化），返回 **409**（`DRAFT_REVISION_CONFLICT` / `VERSION_CONFLICT`）且**不改动任何数据**，需重新预览再确认；目标版本不存在返回 404。

草稿的任何增、删、改都会推进草稿修订号（含恢复本身）。恢复后：

- **历史快照与访客年表保持不变**（访客仍看当前最新发布版）；
- 草稿仅含该版内容，仍需「校验能否发布」后正式发布才会公开；
- 发布仍遵守现有编辑口令、求解校验与 `baseVersionNo` 冲突约定——恢复的是更旧的版本时，请以**当前最新版本号**为 `baseVersionNo` 发布，否则同样收到 409。

### 导入采访整理包（JSON，预览 → 确认）

编辑者可在工作台「导入采访整理包」卡片中上传 `.json` 文件或粘贴 JSON，也可直接调用 HTTP API。整理包格式（完整示例见 `examples/interview-bundle.example.json`）：

```json
{
  "batchId": "2026-09-dongganqu-fangtan-01",
  "events": [
    {
      "key": "dongyuan-hui",
      "title": "修水渠动员会",
      "description": "可选",
      "claims": [
        { "precision": "day", "year": 1958, "month": 9, "day": 12, "source": "李宝山口述，2021-07-05 访谈", "note": "可选考异" },
        { "precision": "year", "year": 1958, "source": "《县水利志》1994 年版，第 87 页" }
      ]
    },
    {
      "key": "tongshui",
      "title": "东干渠通水",
      "claims": [ { "precision": "month", "year": 1959, "month": 5, "source": "王秀兰口述" } ]
    }
  ],
  "relations": [
    { "earlierKey": "dongyuan-hui", "laterKey": "tongshui", "source": "二人口述一致" }
  ]
}
```

- `batchId`：批次标识，**已成功导入过的批次不能再次导入**；
- 每个事件以包内唯一键 `key` 标记，至少一条时间主张；主张字段与手工录入一致（`precision` 为 `year`/`month`/`day`，`source` 出处必填）；
- `relations` 可省略，用 `earlierKey`/`laterKey` 按键引用事件，表示「先于」。

流程与恢复草稿类似，分两步：

1. **预览（只读）**：`POST /api/editor/import-preview`，请求体即整理包 JSON。返回待写入的事件 / 主张 / 关系内容与数量、`fingerprint`（内容指纹）、`draftRevisionNo`（当前草稿修订号），不写任何数据。**键重复、关系引用缺失（指向包内不存在的键）、日期或出处非法**等问题会一次性全部列出，并以 **422** 整包拒绝：

   ```bash
   curl -s -X POST http://localhost:3000/api/editor/import-preview \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
     --data-binary @examples/interview-bundle.example.json
   # => {"ok":true,"batchId":"...","fingerprint":"cbf008...","draftRevisionNo":0,
   #     "alreadyImported":null,"counts":{"eventCount":2,"claimCount":3,"relationCount":1},
   #     "events":[...],"relations":[...]}
   ```

2. **确认导入**：`POST /api/editor/import`，必须提交**原包**、预览返回的**内容指纹**和**草稿修订号**。成功时在**一个事务**中把整包**追加**进草稿区（既有草稿、历史快照、访客视图均不受影响），返回包内键 → 草稿 ID 的映射与新修订号（整包只推进一次修订号）：

   ```bash
   # 用预览返回的 fingerprint 与 draftRevisionNo 组装确认请求（示例借助 jq）
   PREVIEW=$(curl -s -X POST http://localhost:3000/api/editor/import-preview \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
     --data-binary @examples/interview-bundle.example.json)
   jq -n --argjson p "$PREVIEW" --slurpfile b examples/interview-bundle.example.json \
     '{bundle: $b[0], fingerprint: $p.fingerprint, draftRevisionNo: $p.draftRevisionNo}' \
   | curl -s -X POST http://localhost:3000/api/editor/import \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" --data-binary @-
   # => 201 {"ok":true,"batchId":"...","revisionNo":1,"counts":{...},
   #     "idMap":{"events":[{"key":"dongyuan-hui","eventId":1,"claimIds":[1,2]},...],
   #              "relations":[{"earlierKey":"dongyuan-hui","laterKey":"tongshui","relationId":1}]}}
   ```

   确认在以下情况返回 **409 且不写入任何数据**（需重新预览后再确认）：
   - `BUNDLE_CONTENT_MISMATCH`：提交的包与预览指纹不符（内容被替换）；
   - `DRAFT_REVISION_CONFLICT`：预览后草稿被任何人增删改过；
   - `BATCH_ALREADY_IMPORTED`：批次标识曾成功导入（失败的确认不留记录，可修正后重试）。

导入的内容只是草稿：仍需在编辑台为每个事件**选定主张**、通过现有「校验能否发布」（含先后关系求解）后正式发布，访客才能看到。

### 按出处原文撤回公开展示（出处遮盖，预览 → 确认）

受访人或档案方要求撤回某条出处的公开展示时，编辑者可按**出处原文**精确遮盖。适用于已发布快照中**事件主张的出处**与**「先于」关系的出处**：

1. **预览（只读）**：在编辑台「按出处原文撤回公开展示」卡片粘贴**非空的精确出处文本**（须与快照中的出处逐字相同；首尾空白会被去除，部分包含不命中），或调用 `POST /api/editor/redaction-preview`。返回该文本在**全部已发布版本**中命中的位置与数量（按版本列出事件主张命中与关系命中）、当前最新版本号 `currentVersionNo`；另附草稿区同文本条数供参考。预览不写任何数据。
2. **确认遮盖**：`POST /api/editor/redaction`，必须提交原文与预览时的**最新版本号** `currentVersionNo`。系统只在 `source_redactions` 表**追加登记该文本**：

   - **不改写任何历史快照或草稿**（版本快照表里的 `source` 原文原样保留）；
   - 访客读取**最新年表**或**指定历史版本**时，命中位置的 `source` 一律显示为统一的 **「出处已遮盖」**，其余字段（标题、日期、区间、求解日期、考异等）与版本号不变；
   - **以后发布含同一文本的新版本也自动遮盖**（读出时动态比对登记文本，无需逐版处理）；
   - 持编辑口令查看版本详情（`GET /api/editor/versions/:no/raw`、编辑台「查看该版快照原文」）**仍显示原文**；**从历史版本恢复草稿也使用原文**；
   - 遮盖登记不推进草稿修订号，与恢复 / 导入的并发控制互不影响。
3. **冲突与幂等**：预览后若有人发布了新版本（最新版本号变化），确认返回 **409** `VERSION_CONFLICT` 且**不落库**，需重新预览再确认；空 / 纯空白文本返回 **400**；同一文本**重复确认**返回 **200** 且 `alreadyRedacted: true`（已遮盖状态与当前命中数量，不重复登记）。

   ```bash
   TOKEN=editor
   SRC='李宝山口述，2021-07-05 访谈'

   # 1) 只读预览：命中位置与数量 + 最新版本号
   curl -s -X POST http://localhost:3000/api/editor/redaction-preview \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
     -d "{\"source\":\"$SRC\"}"
   # => {"ok":true,"source":"李宝山口述…","alreadyRedacted":false,
   #     "currentVersionNo":2,"versionCount":2,
   #     "totalEventHitCount":3,"totalRelationHitCount":2,"totalHitCount":5,
   #     "versions":[{"versionNo":1,"eventHitCount":1,"relationHitCount":1,
   #                  "eventHits":[{"eventId":1,"title":"动员会",...}],
   #                  "relationHits":[{"relationId":1,"earlierEventId":1,"laterEventId":2}]},
   #                 {"versionNo":2,...}],
   #     "draft":{"claimHitCount":0,"relationHitCount":0,...}}

   # 2) 携预览返回的最新版本号确认（示例用 jq 取号）
   PREVIEW=$(curl -s -X POST http://localhost:3000/api/editor/redaction-preview \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
     -d "{\"source\":\"$SRC\"}")
   curl -s -X POST http://localhost:3000/api/editor/redaction \
     -H "Content-Type: application/json" -H "X-Editor-Token: $TOKEN" \
     -d "{\"source\":\"$SRC\",
          \"currentVersionNo\":$(echo "$PREVIEW" | jq .currentVersionNo),
          \"editor\":\"志愿者小王\"}"
   # => {"ok":true,"alreadyRedacted":false,"redactedLabel":"出处已遮盖",
   #     "currentVersionNo":2,"totalHitCount":5,...}

   # 3) 访客视图：命中处显示「出处已遮盖」（最新年表与任一历史版本皆然）
   curl -s http://localhost:3000/api/public/chronicle | jq '.version.events[].source'
   curl -s http://localhost:3000/api/public/versions/1 | jq '.version.relations[].source'

   # 4) 持口令的版本原文不变
   curl -s -H "X-Editor-Token: $TOKEN" \
     http://localhost:3000/api/editor/versions/1/raw | jq '.version.events[].source'
   ```

   完整可运行的调用示例见 `examples/redaction-example.sh`（自动建草稿、发布两版、预览、确认、核对访客视图与原文视图）。

### 两名编辑者并发修改（版本冲突）

发布请求必须带 `baseVersionNo`（编辑台打开时自动记录当前最新版本号）。若两名编辑者都从第 N 版开始改，第一人发布产生第 N+1 版后，第二人仍以 `baseVersionNo=N` 提交时：

- 服务器返回 **409 版本冲突**，编辑台弹出冲突框，告知对方发布的第 N+1 版概况；
- **不会**静默覆盖对方版本；
- 第二人需点击「刷新到最新版本并重新确认选择」，重新核对每个事件的主张单选后再发布。

### 访客（http://localhost:3000/）

只渲染最新已发布版本：按系统确定的日期排列的时间线、每条事件所选主张的精度与出处、全部「先于」关系及其出处。草稿、未发布主张、未发布关系均不出现在任何公开接口中。尚无发布版本时仅显示「尚未发布」。

凡编辑者已按出处原文登记遮盖的位置，访客在最新年表与任一历史版本中都只看到 **「出处已遮盖」**（快照原文仍在库中，仅持编辑口令的接口可查看）。

## 数据与备份

- 单文件 SQLite 数据库：容器中位于 `/app/data/chronicle.db`（Docker 卷 `chronicle-data`），本机直跑位于 `./data/chronicle.db`。
- 备份：停止写入后复制该 `.db` 文件即可（或使用 SQLite 的 `.backup` 命令）。
- 历史版本表 `versions / version_events / version_relations` 只追加、不更新不删除，保证不可变。
- 导入批次表 `import_batches` 记录每次成功导入的批次标识与内容指纹，用于防止同一批次重复导入。
- 出处遮盖表 `source_redactions` 同样只追加：只存被遮盖的精确出处文本，**不回写快照或草稿**；删除该表对应行即恢复公开显示。
- 预约发布表 `publish_schedules` 在建立时冻结完整待发布内容（事件 / 所选主张 / 关系 / 求解日期）与基准版本号；`status` 在待执行（`pending`）、已发布（`published`）、冲突（`conflict`）、已取消（`cancelled`）间单向流转。到期写版本与翻状态在同一事务内完成，重启只补跑 `pending` 行。

## 目录结构

```
src/
  server.js     Express 入口、口令中间件、静态界面
  routes.js     公开只读 API 与编辑者草稿/发布/恢复 API
  db.js         SQLite 连接与建表（草稿区 + 草稿修订号触发器 + 版本快照区）
  dates.js      年/月/日精度 → 覆盖区间（公历序数日）
  solver.js     Tarjan 环检测 + 拓扑下界传播求严格先后可行解
  publish.js    发布事务：再校验 + 版本冲突检查 + 写不可变快照
  restore.js    恢复草稿：只读预览 + 原子替换事务（修订号/版本号冲突检查、按快照重建）
  bundle.js     采访整理包导入：整包校验 + 内容指纹 + 只读预览 + 事务追加（批次防重/修订号冲突检查）
  redact.js     出处遮盖：精确出处文本的只读命中预览 + 只追加登记（版本号冲突检查）；公开读出层动态替换为「出处已遮盖」
  schedule.js   预约发布：建立时冻结快照/基准版本号；到期按时间、预约号顺序逐条事务执行（发布或标冲突，幂等不重发不留半版）；查看/取消
  scheduler.js  预约调度器：每秒检查到期预约，服务启动立即补跑（重启安全）
  seed.js       演示数据
public/         访客页与编辑台（原生 HTML/CSS/JS）
examples/       采访整理包 JSON 示例；出处遮盖、预约发布 curl 调用示例
test/           node:test 单元与端到端测试（含成环、无解、409 冲突、草稿恢复、整理包导入、出处遮盖、预约发布/重启补跑）
```

## 主要 HTTP API

公开（无口令）：

- `GET /api/public/chronicle` — 最新已发布版本完整快照（命中遮盖登记的 `source` 显示「出处已遮盖」）
- `GET /api/public/versions` / `GET /api/public/versions/:no` — 版本清单 / 指定版本（指定版本同样应用遮盖）

编辑（需请求头 `X-Editor-Token`）：

- `GET  /api/editor/state` — 草稿全貌 + 当前版本号 + 草稿修订号 `draftRevisionNo`
- 事件：`POST /api/editor/events`、`PUT/DELETE /api/editor/events/:id`
- 主张：`POST /api/editor/events/:id/claims`、`PUT/DELETE /api/editor/claims/:claimId`
- 关系：`POST /api/editor/relations`、`DELETE /api/editor/relations/:id`
- `POST /api/editor/validate` — 预校验（不落库）
- `POST /api/editor/publish` — 发布；体含 `selection:[{eventId,claimId}]`、`baseVersionNo`、`editor`、`note`
  - 422：`{errors:[{type:missing|cycle|temporal, eventIds, relationIds, message, detail}]}`
  - 409：`{code:"VERSION_CONFLICT", baseVersionNo, currentVersionNo, currentVersion}`
- `GET  /api/editor/restore-preview/:no` — 从第 `:no` 版恢复草稿的只读预览（该版被选内容 + 将被替换的当前草稿），返回 `draftRevisionNo`、`currentVersionNo`；版本不存在 404
- `POST /api/editor/restore` — 确认恢复；体含 `versionNo`、`draftRevisionNo`、`currentVersionNo`（后两者取预览返回值）
  - 200：`{restoredFromVersionNo, currentVersionNo, revisionNo, idMap:{events,relations}, pendingSelection:[{eventId,claimId}], draft}`
  - 409：`{code:"DRAFT_REVISION_CONFLICT"|"VERSION_CONFLICT", ...}`（草稿或最新版本在确认前变化，数据不变）；版本不存在 404；参数非法 400
- `POST /api/editor/import-preview` — 整理包只读预览；请求体即整理包 JSON，返回 `fingerprint`、`draftRevisionNo`、`counts`、待写入 `events`/`relations` 与 `alreadyImported` 提示
  - 422：`{code:"BUNDLE_INVALID", problems:[{type, message, ...}]}`（键重复 `duplicate_key`、引用缺失 `missing_reference`、日期非法 `invalid_date`、出处非法 `invalid_source`、自环 `self_relation`、结构非法 `invalid_structure`，整包拒绝）
- `POST /api/editor/import` — 确认导入；体含 `bundle`（原包）、`fingerprint`、`draftRevisionNo`（后两者取预览返回值）
  - 201：`{batchId, revisionNo, counts, idMap:{events:[{key,eventId,claimIds}], relations:[{earlierKey,laterKey,relationId}]}}`（一个事务追加整包）
  - 409：`{code:"BUNDLE_CONTENT_MISMATCH"|"DRAFT_REVISION_CONFLICT"|"BATCH_ALREADY_IMPORTED", ...}`（内容被替换 / 草稿已变化 / 批次已导入，均不写入）；参数非法 400
- `POST /api/editor/redaction-preview` — 出处遮盖只读预览；体含非空 `source`（精确出处原文，首尾空白去除），返回全部已发布版本的命中位置/数量、`currentVersionNo` 与草稿区参考计数
  - 200：`{source, alreadyRedacted, currentVersionNo, versionCount, totalEventHitCount, totalRelationHitCount, totalHitCount, versions:[{versionNo,eventHitCount,relationHitCount,eventHits:[{eventId,title,sortOrder}],relationHits:[{relationId,earlierEventId,laterEventId,sortOrder}]}], draft:{claimHitCount,relationHitCount,...}}`
  - 400：空 / 纯空白 / 非字符串文本
- `POST /api/editor/redaction` — 确认遮盖（只追加登记，不改写快照或草稿）；体含 `source`、`currentVersionNo`（取预览返回值）、可选 `editor`
  - 200：`{alreadyRedacted:false, redactedLabel:"出处已遮盖", redactedAt, ...命中统计}`；重复确认 200 且 `alreadyRedacted:true`（不重复登记）
  - 409：`{code:"VERSION_CONFLICT", currentVersionNo, expectedVersionNo, ...}`（预览后发布了新版本，不落库）；空文本或版本号非法 400
- `GET  /api/editor/redactions` — 已登记遮盖清单（编辑者视角，含出处原文与登记时间）
- `POST /api/editor/schedules` — 建立预约发布；体含 `selection:[{eventId,claimId}]`、`scheduledAt`（未来 UTC，如 `2026-10-02T12:34:00Z`）、`baseVersionNo`、`editor`、`note`
  - 201：`{schedule:{scheduleNo, scheduledAt, status:"pending", baseVersionNo, draftRevisionNo, eventCount, relationCount, frozen:{events:[…含 resolvedDate/source…], relations:[…]}, ...}}`（冻结快照）
  - 400：时间非法 / 非未来时刻（`{code:"INVALID_SCHEDULED_TIME"}`）或选择为空；422：草稿未通过现有发布校验（`{errors:[...]}`，同即时发布）；409：`VERSION_CONFLICT`（基准版本号已过期）；均不建立预约
- `GET  /api/editor/schedules` — 预约列表（待执行在前、按到期时刻升序；列表项含冻结事件摘要与执行结果）
- `GET  /api/editor/schedules/:no` — 预约详情（展开冻结的完整事件 / 主张 / 关系 / 求解日期；不存在 404）
- `DELETE /api/editor/schedules/:no` — 取消尚未执行的预约（200 `{cancelled:true}`；重复取消已取消的预约幂等 200 且 `alreadyCancelled:true`）
  - 409：`{code:"SCHEDULE_NOT_CANCELLABLE", statusNow:"published"|"conflict", resultVersionNo}`（已生效不能取消）；不存在 404
- `GET  /api/editor/versions/:no/raw` — 指定版本快照**原文**（持编辑口令，不应用遮盖；恢复草稿亦用原文）
