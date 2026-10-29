# CairnKV 学习路线（与实现里程碑绑定的自学指南）

| 项 | 内容 |
|---|---|
| 面向对象 | 本项目实现者（即设计草案作者）：想在亲手实现中把存储引擎知识学扎实 |
| 前提 | 会 Go 基础语法即可；存储引擎经验不要求，本文档会给出补齐路径 |
| 配套文档 | `docs/cairnkv-design-overview-go.md`（需求草案）、`docs/cairnkv-reference-and-innovation.md`（全局地图）、`docs/research/DELIVERABLE-01/02/03`（理论/决策/实现计划）、`.autoresearch/`（26 份迭代论证 + 23 项裁决） |
| 核心原则 | **读 ↔ 做交替**：不追求"先学完再动手"；每完成一个里程碑，回到决策书"对答案" |
| 更新日期 | 2026-09-29（对应实现计划 M0–M5） |

---

## 0. 30 秒版

1. **开工前读三样**：`reference-and-innovation`（182 行，全局地图）+ `DELIVERABLE-03` §0–§2（不变量/断言、参数表、里程碑）+ `iter-20-arbitration.md` 第一部分（23 项裁决）。
2. **之后边做边读**：按里程碑查 `DELIVERABLE-02` 对应节与 `iter-NN` 深挖；`DELIVERABLE-01` 当成"带证据分级的书单"，挑着追原文。
3. **三个必须亲手验证的高危项**：V-01（合并输入全序）、V-04（毒化状态机）、V-08（seqNum 重建）——它们是 `dup`/`crc` 硬门槛成立的前提。

---

## 1. 资源地图：什么时候读什么

### 1.1 开工前必读（约 1–2 天）

| 顺序 | 文件 | 行数 | 读法 | 目的 |
|---|---|---|---|---|
| 1 | `docs/cairnkv-reference-and-innovation.md` | 182 | 通读 | 建立"参考了什么、自己决定了什么"的直觉 |
| 2 | `docs/cairnkv-design-overview-go.md` | 442 | 带着研究结论重读 | 找回你自己的需求优先级（你是需求的最终裁量人） |
| 3 | `DELIVERABLE-03` §0–§2 | 约 140 行 | 精读 | 五条不变量（INV-1..5）、五条断言（AS-1..5）、参数默认值表、里程碑与退出标准 |
| 4 | `DELIVERABLE-02` §0.4 + §1 | 约 150 行 | 精读 | 25 条迭代的决策总账与全局结论 |
| 5 | `.autoresearch/work/iter-20-arbitration.md` 第一部分 | 约 250 行 | 通读 | 23 项裁决 = 所有"为什么不是另一种做法" |

### 1.2 常备（贯穿全程）

| 文件 | 用法 |
|---|---|
| `DELIVERABLE-02` | **主索引**：做到哪个组件读哪一节；末尾 §17 是"已知缺口 + 触发条件" |
| `DELIVERABLE-03` §1 | **唯一权威参数表**（实现时以此为准，本文档的论证在 D02） |
| `DELIVERABLE-03` §9 | 测试金字塔（L0–L4）与 CI 门禁清单 |
| `.autoresearch/CHANGELOG.md` | 三个阶段的全貌 + 本轮所有修正记录 |
| `.autoresearch/third_party/PINS.md` | 引用源码时用这里的 commit 前缀（`<repo>/<path>:<line> @ <commit>`） |

### 1.3 按里程碑查阅（不要预读）

| 里程碑 | 决策书（D02） | 实现计划（D03） | 迭代深挖（.autoresearch/work/） | 理论（D01） |
|---|---|---|---|---|
| **M0** 骨架与契约 | §13（接口/Options 两层/比较器） | §3（工作项 + vfs 草案 + 退出标准） | iter-04 | §7（验证方法论） |
| **M1** WAL/组提交/内存表/恢复 | §2（写路径）、§3（内存表）、§9.5（毒化） | §4（工作项 + API + 用例映射） | iter-05/06/07/08/09 | §3（写路径）、§6（崩溃一致性） |
| **M2** SSTable/索引/过滤器/缓存/元数据 | §4–§7、§9.1–§9.3 | §5（工作项 + 目录布局 + 崩溃注入三定点） | iter-10/11/12/13/14/15 | §4（读路径）、§6 |
| **M3** 合并/调度/墓碑/度量 | §8（压缩）、§10（合并）、§11（调度背压）、§14（可观测性） | §6（工作项 + 参数块）、§8、§9.3 | iter-16/17/18 + 补充轮 iter-21/22/23 | §2（成本模型）、§5（合并策略谱） |
| **M4** 网络/工具 | §11.2（N-06）、§15.3（check） | §7.1 | iter-23（准入控制） | — |
| **M5** 示例/实验/论文材料 | §17（缺口表）、§10.4（SA 口径） | §7.2、§12 | iter-01（度量口径）、iter-19（测试体系） | §8（2020s 进展地图） |

### 1.4 不必读的

- `.autoresearch/work/verification-report.md`（1204 行）：只在你要审计"引用是否可信"时读；
- `block-*-digest.md`、`handoff*/`、`workflow-*.js`、`autoresearch.jsonl`：研究循环的仪器输出，对实现无直接价值；
- `DELIVERABLE-01` 不必通读：它是 3886 行的理论地图，按 §1.3 的表挑节 + 追文末 `§9 参考来源`。

---

## 2. 知识地图（4 块）

### 2.1 存储与文件系统基础（M0–M1 前必须补齐）

**学什么**
- 页面缓存与写回；`fsync` vs `fdatasync` vs `O_DIRECT` 的差别与用途；
- **目录 fsync**、`rename` 的原子性与持久性边界；写顺序（数据先于元数据）；
- torn write / 半截写；块设备扇区与文件系统块的差别；
- mmap 的行为与代价（缺页、SIGBUS、持久性不由 `msync` 保证）；
- 不同文件系统（ext4/xfs/btrfs/APFS/NFS/overlayfs）的语义差异。

**材料**
- **OSTEP**（免费，`pages.cs.wisc.edu/~remzi/OSTEP/`）的持久化部分：I/O 设备、磁盘、文件系统实现、崩溃一致性；
- **《Database Internals》第 1 部分**（Alex Petrov）：B-Tree 与 LSM 的存储引擎基础；
- Pillai et al., *All File Systems Are Not Created Equal*, OSDI 2014（链接见 D01 §9）；
- Pebble `docs/memory.md`；`pebble/vfs/` 的接口注释。

**仓库落点**：D02 §9.3（目录 fsync 六项清单）、§9.5（毒化状态机）；iter-04/15；D03 §3.2（vfs 草案）。

**自测问题**
1. "写临时文件 → rename" 之后为什么还必须 fsync 目录？rename 返回成功意味着什么、不意味着什么？
2. darwin 上 `os.File.Sync` 会走 `F_FULLFSYNC`；它的回退分支在什么情况下触发，回退后语义有什么变化？
3. "缺页会让 goroutine 绑定 OS 线程"这个说法哪里不准确？准确表述是什么（读 iter-25）？
4. 块尾 CRC 为什么覆盖"压缩后数据 + 类型字节"而不是明文？读到未知压缩类型应该怎么做？
5. 为什么第一期不用 mmap？对比实验（`EXP-13-MMAP`）的判定规则是什么？

### 2.2 LSM 核心（M1–M3 全程）

**学什么**
- memtable/skiplist/arena、WAL 与恢复、冻结与切换；
- SSTable 格式：块、前缀压缩、restart points、索引（两级）、Bloom、footer/魔数；
- 合并：leveled vs tiered vs hybrid、触发与打分、调度与背压；
- 放大三角（WA/RA/SA）与 RUM 权衡；seqnum/MVCC/快照；墓碑与回收安全条件；
- 组提交、确认点语义、fsync 失败处理。

**材料**
- **《Database Internals》第 2 部分**（LSM-Tree：memtable、SSTable、合并、代价模型）——最直接的教材；
- LevelDB 规范级文档：`leveldb/doc/impl.md`、`doc/table_format.md`、`doc/log_format.md`；
- RocksDB wiki：`Leveled-Compaction`、`Universal-Compaction`、`Write-Stalls`、`Write-Ahead-Log-File-Format`；
- 论文（ID 见 D01 §9 或 `reference-and-innovation` §2.4）：O'Neil 1996（LSM 原论文）、Monkey、WiscKey、Dostoevsky、SILK、Sarkar PVLDB'21、RUM 相关；
- 源码精读顺序：**LevelDB（最小最干净）→ Pebble（现代 Go 主参照）→ Badger（另一种取舍）**。

**仓库落点**：D01 §1–§5（理论主线）；D02 §2–§11、§14；iter-05..18。

**自测问题**
1. WA/RA/SA 的精确定义？为什么 RA 要"文件数 + 字节数"双口径、SA 要包含 obsolete？
2. leveled 与 tiered 各在放大三角的哪一端更优？第一期为什么选 leveled、代价量级是多少、为什么必须重测？
3. 批量的原子性来自"共享同一个序号"还是别的机制？（读 D02 §2.6）
4. "同一用户键的版本连续且序号降序"为什么是合并丢弃规则的前提？违反会怎样？
5. 墓碑物理丢弃的两个条件分别防的是哪种错误？
6. L0 子层解决什么问题？"证据缺口型 defer"与"已量化的 defer"区别是什么？

### 2.3 Go 工程与并发（贯穿）

**学什么**
- goroutine 调度、阻塞系统调用与 P/M 的关系、`GOMAXPROCS`；
- 内存模型、`sync/atomic`、锁与无锁的取舍；对象分配与 GC 压力；
- 接口设计与错误分类（`errors.Is/As`、哨兵错误、typed error）；
- `context` 取消与优雅关闭；后台协程生命周期。

**材料**
- Go 官方 Memory Model（`go.dev/ref/mem`）、`runtime` 包文档（`pkg.go.dev/runtime`）、官方 GC 指南；
- 《The Go Programming Language》选章（接口、并发、测试）；
- 仓库内：iter-04（Go 约束与 vfs）、iter-08（arena 与并发协议）、iter-19（测试方法）。

**仓库落点**：D02 §3（内存表）、§13（接口）、§9.5（毒化）；D03 §3.2（vfs）、§4.2（公开 API）。

**自测问题**
1. 为什么 arena 用 32 位偏移链接？它的适用上限与代价是什么（读 iter-08）？
2. `writerRefs` / `readerRefs` 各自封死的窗口是什么？释放条件为什么必须是两者都为 0？
3. 为什么"组提交 + L1 单写者"是自洽的？什么时候才需要 L2 的并发写？
4. 后台协程 panic 为什么不能被宿主 `recover`？这如何影响 fsync 失败的处理方式？

### 2.4 测试方法论与性能度量（M1–M5）

**学什么**
- 单元 → 模型对拍 → 故障/崩溃注入 → 蜕变测试 → 离线校验五层体系；
- 确定性测试与随机化的取舍；fuzz 的适用边界（只限解析代码）；
- 放大系数的采集口径与归因（五个 RA 分项不叠加）；
- 基准测试方法：重复次数、尾延迟、环境噪声。

**材料**
- 仓库内：iter-19（本循环的方法论综述，含"4 个 Go 引擎都不用 `go test -fuzz`"这条负面证据）、D03 §9（金字塔 + CI 门禁）、D03 §8（可观测性契约）；
- Pebble `vfs/errorfs/`（故障注入）、`metamorphic/`（蜕变测试）、`internal/`（模型测试）；
- Brendan Gregg《Systems Performance》前两章（测量方法）。

**仓库落点**：D03 §9.1–§9.3；D02 §15；D01 §7。

**自测问题**
1. 为什么故障注入要放 vfs 层，而不是在引擎代码里打点？
2. 模型对拍为什么不能替代崩溃/故障注入（各防哪类缺陷）？
3. `-race` 在 CI 的位置与预算？为什么 fuzz 只限解析代码？
4. "读放大改善 X%" 为什么必须指明是哪个分项？五个分项分别归谁改善？

---

## 3. 按里程碑的学习计划

> 工作量估计来自 `DELIVERABLE-03` §12（人周单位，非承诺）：M0 0.5 / M1 3 / M2 3.5 / M3 4 / M4 2 / M5 1.5。

### M0 · 骨架与契约（0.5）

- **前置**：Go 模块与包布局；接口与错误分类基础。
- **必读**：D03 §0（INV-1..5、AS-1..5）、§3；D02 §13；iter-04。
- **动手练习**：
  1. 建 `go.mod` 与目录骨架（`internal/` 全部私有）；
  2. 写 `vfs` 接口 + `os` 实现 + 一个**包装 FS**（记录调用序列、可注入错误）；
  3. 用包装 FS 断言"目录 `Sync` 在 rename 之后被调用"；
  4. 建 CI 骨架（gofmt/vet/test/race 四条最小门禁）。
- **完成标志（D03 §3.3）**：接口冻结、两层 `Options` 可用、CI 跑通。
- **学习产出**：能向别人解释"为什么 `SyncDir` 必须单列"、"为什么库不调用 `debug.SetMemoryLimit`"。

### M1 · 崩溃恢复最小闭环（3）

- **前置**：2.1 块全部内容 + 2.2 的 WAL/组提交/内存表部分。
- **必读**：D03 §4；D02 §2/§3/§9.5；iter-05/06/07/08/09；`leveldb/doc/log_format.md`；`pebble/record/`、`pebble/commit.go`。
- **动手练习**：
  1. WAL 编解码 + **torn write 测试向量**（半截记录、错误 CRC、块边界）；
  2. 组提交的事件驱动实现 + 可订阅提交事件（V-03）；
  3. 毒化状态机（V-04）与 `logSeqNum` 重建（V-08）；
  4. 模型对拍骨架（自建有序模型 + Reopen 对拍）。
- **完成标志（D03 §4.4）**：验收标准 1；`dup` 三道门槛有测试；INV-1..5 各有用例。
- **风险提醒**：这条里程碑直接对应**三条静默错误路径**（见 §6 误区 4），不要赶进度。

### M2 · 文件格式与读路径（3.5）

- **前置**：2.2 的 SSTable/过滤器/缓存部分。
- **必读**：D03 §5；D02 §4–§7、§9.1–§9.3；iter-10/11/12/13/14/15；`leveldb/doc/table_format.md`。
- **动手练习**：
  1. 块编解码（前缀压缩 + restart interval）与边界用例；
  2. 两级索引 + pin 顶层索引；Bloom 的 FPR 实测（10 bits/key）；
  3. CLOCK-Pro 的单元测试（`strict_capacity_limit=true` 语义）；
  4. 标记文件的崩溃注入（写标记→崩→重开）；
  5. 解析代码 fuzz（WAL/块/MANIFEST）。
- **完成标志（D03 §5.4）**：验收标准 2；对照实验第一批跑通。
- **学习产出**：理解"格式一次定型 + 版本位预留"的工程含义（改格式字段 = 格式版本升级）。

### M3 · 合并与度量（4，最大阶段）

- **前置**：2.2 的合并部分 + 2.4 的度量方法。
- **必读**：D03 §6、§8、§9.3；D02 §8/§10/§11/§14；iter-16/17/18 + iter-21/22；Sarkar PVLDB'21；SILK。
- **动手练习**：
  1. leveled 选择打分（L0 按文件数、L1+ 按字节比）+ 祖父层限制；
  2. **V-01 全序断言** + "同一键跨 3 个 L0 文件 + 活跃快照"对拍；
  3. 墓碑丢弃条件 A∧B 的对拍；
  4. WA/RA/SA 采集与五归因表；
  5. 写放大重测（V-05）与参数网格（V-06 起步）。
- **完成标志（D03 §6.4）**：验收标准 3/4；放大系数可输出；`wa` 用实测值替换文献值。
- **学习产出**：亲身体会"论文倍数 → 参数 → 自己环境实测"的落差；这阶段你会真正理解 RUM。

### M4 · 网络与工具（2）

- **前置**：2.4 的过载/尾部延迟概念。
- **必读**：D03 §7.1；D02 §11.2、§15.3；iter-23；草案 §3.5。
- **动手练习**：`proto` 帧 + 幂等请求 ID；有界写队列 + 专用过载错误码（N-04 / M4-2b）；`cairnkv check`。
- **完成标志（D03 §7.1）**：验收标准 5/7。

### M5 · 示例、实验与论文材料（1.5）

- **必读**：D03 §7.2、§12；D02 §17；iter-01/19。
- **动手练习**：时序示例（**自己实现过期逻辑**——这是范围删除 defer 的代价）；四组对照实验 + 参数网格（V-05/V-06/V-07）；真实文件系统崩溃实验（V-09，非 CI）。
- **完成标志**：验收标准 4/6；论文材料（放大曲线 + 参数敏感性）。

---

## 4. 三个优先验证项（V-01 / V-04 / V-08）

> 完整 12 项见 `.autoresearch/work/iter-20-arbitration.md` 第四部分与 D03 §9。

### V-01 · 合并输入迭代器的全序保证（M3 之前）

- **问题**：版本丢弃规则假设"同一用户键的版本连续且序号降序"；若输入乱序，规则会**丢掉正确版本且不报错**。
- **为什么危险**：这是本循环认定的**最高风险点**——静默数据错误，测试全绿也发现不了。
- **怎么测**：
  1. 在合并输入路径加**断言**：严格符合 `InternalCompare` 全序；
  2. `test/model`：同一键跨 3 个 L0 文件写 3 个版本 + 1 个活跃快照，对拍快照读与恢复后读。
- **学习价值**：理解内部比较器（用户键升序 + trailer 降序）与 MVCC 可见性的耦合。

### V-04 · fsync 失败的毒化状态机（M1）

- **问题**：fsync 失败后此前"成功"的写入可能已丢失，继续服务必然违反 `dup`。
- **为什么危险**：静默丢失确认写入（静默错误路径 ③）。
- **怎么测**：`test/crash` 用 `vfs/errorfs` 注入一次 fsync 失败，断言：
  1. 之后所有操作返回 `ErrEnginePoisoned`；
  2. 组提交等待者一律收错（**没有任何未持久化写入被报成功**）；
  3. 关闭不做"尽力而为"的 flush；重开走正常恢复。
- **学习价值**：库形态下"致命错误"的正确处理方式（对比 Pebble 的 `os.Exit`）。

### V-08 · 恢复时 `logSeqNum` 的重建公式（M1，`crc` 前提）

- **问题**：lane B 推断公式为"所有已重放记录的最大 base+count + 1"，但**没有**在 Pebble/LevelDB 里逐行确认。
- **为什么危险**：新序号若与崩溃前记录重叠，历史版本会被未来写入"压在下面"，造成可见性错乱。
- **怎么测**：`test/crash`：写入 → 崩溃 → 重启 → 再写入 → 断言新序号**严格大于**崩溃前所有已重放记录的序号。
- **学习价值**：理解序号空间与恢复的边界条件。

---

## 5. 工作方法建议

### 5.1 每个模块的工作循环（7 步）

1. **读结论**：D02 对应节的"结论"；
2. **读证据**：该节的"证据" + 对应 iter 工件的深挖（只读你需要的那节）；
3. **读参照源码**：`third_party/` 里按 `PINS.md` 的 commit 读（先 LevelDB，再 Pebble）；
4. **写设计小注**：把"我要怎么实现 + 与文档不同的地方 + 为什么"写成 1–2 页（建议建 `docs/adr/`）；
5. **实现**；
6. **测试**：按 D03 §9 的层次补齐该模块的用例；
7. **回写偏差**：实测推翻文档时，更新 D02/D03 对应节 + 在 CHANGELOG 留一条（保持单一真相来源）。

### 5.2 记录模板（建议的 ADR）

```markdown
# ADR-NNN：<决策标题>
- 状态：提议 / 接受 / 被取代（由 ADR-XXX）
- 背景：<为什么现在要做这个决定>
- 选项：<A / B / C + 各自的代价>
- 决定：<选了哪个>
- 证据：<论文 DOI / 代码 <repo>/<path>:<line> @ commit / 实测数据>
- 与交付文档的关系：<一致 / 偏离，偏离原因>
```

### 5.3 三条纪律

1. **参数不迷信**：D03 §1 里标注的"从众取值"（4 MB memtable、32 KiB WAL 块、`p=1/e`……）都可以被你的 V-06 网格推翻；先跑数据再改默认值。
2. **`unverified` 不是事实**：D02 §1.4 仍有 5 项未核验（U-7/U-8/U-11/U-13/U-15），别把它们写进代码注释当定理。
3. **不照抄 Pebble**：`DELIVERABLE-02` §16.4 的 11 条偏离清单就是"顺手照抄会错"的点位表（毒化、三笔预算、kind 取值、标记文件、footer 等）。

---

## 6. 常见误区清单

1. **想先通读全部文档再动手** → 1 万多行读不完也没必要；按 §1.3 的表边做边读。
2. **把文献倍数搬进自己项目** → `wa ≈ 2.7×` 是 RocksDB 上的实测，必须 V-05 重测。
3. **把"从众取值"当定论** → 默认参数是起点，不是结论。
4. **低估三条静默错误路径**（本循环最重要的一条判断）：
   ① 乱序输入导致版本丢弃规则丢新版本且不报错（V-01）；
   ② "WAL 已 fsync、内存未 apply"窗口内释放/旋转内存表（INV-2）；
   ③ fsync 失败后继续宣称成功（INV-5/V-04）。
   它们都不会让测试失败，只会让数据悄悄出错——**先给它们写用例，再谈性能**。
5. **测试留到最后** → L1 模型对拍与 L2 故障注入必须从 M1 就有；L3a 蜕变测试才是 M3。
6. **过早优化** → M0–M2 的目标是正确性与格式定型；性能在 M3 之后用数据说话。
7. **忽略"开放项/缺口表"** → D02 §17 的 28 条缺口每条都有触发条件；`cairnkv check --full` 与 `dm-log-writes` 实验不是可选项（按里程碑）。
8. **只在本机内存文件系统上测崩溃** → CI 全绿 ≠ ext4/xfs 上正确（V-09）；文档里要写"已知局限"。

---

## 7. 材料索引

### 书
- **OSTEP**（Operating Systems: Three Easy Pieces，免费）——持久化/文件系统部分：`https://pages.cs.wisc.edu/~remzi/OSTEP/`
- **《Database Internals》**（Alex Petrov, O'Reilly 2019）——第 1 部分存储引擎（B-Tree/LSM）与第 2 部分分布式（本项目可跳过）
- **《Designing Data-Intensive Applications》**（Kleppmann）——第 3 章 Storage and Retrieval
- **《The Go Programming Language》**（Donovan & Kernighan）——接口、并发、测试章节
- **《Systems Performance》**（Brendan Gregg, 2nd ed.）——测量方法（前两章）

### 论文（含本循环已核验标识符）
- Sarkar et al., *Constructing and analyzing the LSM compaction design space*, PVLDB 14(11), 2021 — `DOI:10.14778/3476249.3476274`（arXiv `2202.04522`）
- Dayan & Idreos, *Dostoevsky*, SIGMOD 2018 — `DOI:10.1145/3183713.3196927`
- Dayan & Idreos, *The LSM-Bush & the Wacky Continuum*, SIGMOD 2019 — `DOI:10.1145/3299869.3319903`
- Wang et al., *Rethinking The Compaction Policies in LSM-trees*（EcoTune）, PACMMOD 2025 — `DOI:10.1145/3725344`
- Mo et al., *Learning to Optimize LSM-trees*（RusKey）, PACMMOD 2023 — `DOI:10.1145/3617333`（arXiv `2308.07013`）
- Balmau et al., *SILK*, USENIX ATC 2019 — S2 `4ac21df6adc55df7e4bdc3114b984f13a54e48ce`（PDF：`usenix.org/system/files/atc19-balmau.pdf`）
- DeWitt et al., *Implementation techniques for main memory database systems*, SIGMOD 1984 — `DOI:10.1145/602259.602261`（**不是** group commit 的首提）
- Pugh, *Skip lists: a probabilistic alternative to balanced trees*, CACM 1990 — `DOI:10.1145/78973.78977`
- Rebello et al., *Can Applications Recover from fsync Failures?*, ATC 2020 / TOS 2021 — `DOI:10.1145/3450338`
- Pillai et al., *All File Systems Are Not Created Equal*, OSDI 2014；O'Neil et al. 1996 与 RUM 相关文献 —— **链接与标识符见 `DELIVERABLE-01` §9 参考来源**

### 规范与官方文档（本地克隆内可直接读）
- `leveldb/doc/impl.md`、`doc/table_format.md`、`doc/log_format.md`
- RocksDB wiki：`Leveled-Compaction`、`Universal-Compaction`、`Write-Stalls`、`Write-Ahead-Log-File-Format`（`github.com/facebook/rocksdb/wiki/`）
- Pebble：`docs/memory.md`、`vfs/errorfs/`、`metamorphic/`、`internal/cache/clockpro.go`（含算法出处）
- Badger：`doc.go`、`value.go`；bbolt：`tx.go`（两次 fdatasync 的顺序）

### 源码（钉版在 `.autoresearch/third_party/`，commit 见 `PINS.md`）
- 精读顺序：**leveldb → pebble → badger**（对照 bbolt 的提交协议）
- 引用格式：`<repo>/<path>:<line> @ <commit 前缀>`

### 工具
- `go test -race`、`go test -fuzz`、`go test -bench`、`pprof`、`dlv`
- 仓库自带：`.autoresearch/tools/scan_refs.py`（引用核验，研究期工具）、`autoresearch.sh`（台账门禁）

---

> **最后一句**：这套文档是"证据 + 结论"，不是圣经。你作为草案作者对需求有最终裁量权；
> 标着 `unverified`、`从众取值`、`开放项` 的地方，就是留给你重新决定的空间。
> 遇到与文档不同的实测结果——**数据赢**，然后把它回写进文档。
