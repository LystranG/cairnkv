# CairnKV 参考点与创新点总览

| 项 | 内容 |
|---|---|
| 版本 | 2026-09-29（对应研究循环：主轮 20 条 + 补充轮 5 条） |
| 性质 | **合成索引文档**——把「参考了什么」与「自己决定了什么」两张账拆开，供实现者与评审者快速定位；**不引入任何新结论** |
| 权威来源 | `docs/research/DELIVERABLE-02-design-decisions.md`（决策书）、`DELIVERABLE-03-implementation-plan.md`（实现计划）、`.autoresearch/work/iter-20-arbitration.md`（仲裁记录）与各迭代工件 |
| 前置文档 | `docs/cairnkv-design-overview-go.md`（草案 v0.1，本项目的需求基线） |

> **定位声明**：CairnKV 的技术方案是「**以成熟工业实践为骨架 + 少量有证据的偏离**」。
> 它**不主张算法或数据结构的原创**：跳表、LSM 分层、bloom、CLOCK-Pro、组提交等都是已有工作；
> 本文档所称的「创新点」= **有意偏离** + **自研工程组合**，每条都有理由、有代价、可复核。

---

## 1. 参考体系总览

### 1.1 五个参照对象

| 角色 | 参照对象 | 为什么是它 |
|---|---|---|
| **主参照** | **Pebble**（CockroachDB 的生产级 Go LSM 引擎） | 唯一生产级现代 Go LSM；其代码与文档是本项目最主要的一手证据源（钉版 `e0818dd`） |
| 格式与语义祖本 | **LevelDB** | SSTable/WAL/MANIFEST 的规范级文档（`leveldb/doc/*.md`）；语义最清晰（钉版 `7ee830d`） |
| 工业对照 | **RocksDB** | 参数与生态最广；用于确认「行业共识」（如压缩默认、写停顿语义） |
| Go 生态对照 | **Badger** | Go 内的另一种 LSM 取舍（value log、`ristretto` 缓存）（钉版 `5688f14`） |
| 提交协议对照 | **bbolt** | B+tree（非同构），但提交顺序语义（数据页先于 meta 页 fsync）值得照抄（钉版 `4dc08f71`） |

> 五个仓库的浅克隆与 commit 钉版在 `.autoresearch/third_party/`（`PINS.md`）；本文档所有代码引用均可按该目录复核。

### 1.2 三分法速览（iter-03 的判断框架）

工业对照矩阵（12 维度 × 5 系统）的结论：**主动继承 9 项 / 主动放弃 6 项 / 主动现代化 5 项**。
另有 1 组「整体不继承」：Pebble 的**列式块 + 值分离 + 共享缓存**三件套（互相依赖，只抄一件会得到不完整能力）。

### 1.3 阅读须知：快照与最终形态

本总览的第 2 节保留 iter-03 的**原始三分法快照**（便于追溯当时依据），但**最终形态以后续迭代与交付文档为准**。
已知更新过的地方在表中以「⚠️ 后续更新」标出（如 A1 参数族、A6 被否决、B5/B6 后续落地、C5 降级）。

---

## 2. 参考点

### 2.1 主动继承（9 项）

| # | 继承项 | 来源（一手证据） | 最终状态 / 后续更新 |
|---|---|---|---|
| A1 | 跳表 + Arena 的内存表 | `leveldb/db/skiplist.h:40,100,242`；`badger/skl/skl.go:34` | ⚠️ 思想继承，**参数族被 iter-07/08 钉死**：Go 堆内 `[]byte` arena + 32 位偏移 + `p=1/e` + `maxHeight=20`（不是 LevelDB 的 `kBranching=4`/`kMaxHeight=12`） |
| A2 | 内部键 = user key + 全局序号 + 类型 | `leveldb/db/dbformat.h:54,61,67` | ✅ 继承并细化为逐字节布局（见 3.2-②） |
| A3 | WAL：32 KB 块 + `CRC(4B) ‖ len(2B) ‖ type(1B)` + 4 类分片 | `leveldb/doc/log_format.md`；`goleveldb/leveldb/journal/journal.go:99-100` | ⚠️ 继承物理层，**iter-05 扩展为双层**（物理分块层 + 逻辑批次层，见 3.2-①） |
| A4 | 「写临时文件 → fsync → 原子重命名」+ 数据页先于 meta 页 fsync 的顺序 | `bbolt/tx.go:566-569`、`:613-616` | ✅ 用于标记文件与 SSTable 提交顺序语义 |
| A5 | 两档背压（软减速阈值 + 硬停写阈值） | `leveldb/db/dbformat.h:31,34`（8/12）；`badger/options.go:138-139`（5/15）；RocksDB wiki Write-Stalls | ⚠️ iter-17 落地为**三条件两档停顿**（`L0Slowdown=8`/`L0Stop=12` + memtable 上限 2）+ 三级优先级 |
| A6 | 过滤器「每 2 KB 一个 filter」的分块粒度 | `leveldb/table/filter_block.cc:15-16`；`goleveldb/leveldb/opt/options.go:43` | ❌ **被 iter-11 否决**：粒度改为**整文件**（2 KB 是 LevelDB 构建期内存受限的妥协，不是更优粒度） |
| A7 | 块尾校验和（`CRC + len` 追加在块后） | `badger/table/builder.go:262-274,413-414`；`leveldb/table/format.h:79`（`kBlockTrailerSize = 5`） | ✅ 确认 `B-16`；CairnKV 的 CRC 覆盖**压缩后数据 + 类型字节** |
| A8 | 每个 memtable 配一个 WAL 文件、生命周期关联 | `badger/memtable.go:31-37,110-117` | ✅ 落地为冻结/切换协议的一部分（简化恢复） |
| A9 | 声明式格式版本号 + 魔数 | `bbolt/internal/common/types.go:13,16`（`Magic=0xED0CDAED`、`Version=2`）；`leveldb/table/format.h:76` | ✅ 确认 `B-24`；CairnKV 用**专属魔数 `0x53c9fb8ce508ea61` + 双版本号 + 版本边界表** |

### 2.2 主动现代化（5 项）

| # | 现代化项 | 来源（一手证据） | 最终形态 |
|---|---|---|---|
| C1 | 原子标记文件取代 `CURRENT` + rename | `pebble/vfs/atomicfs/marker.go:141-143,189-241` | ✅ 裁决-07：标记文件族 `marker.manifest.<iter>.<值>` 为唯一真相来源；iter-15 给出 S1–S6 步骤级算法 |
| C2 | CLOCK-Pro 块缓存取代分片 LRU | `pebble/internal/cache/clockpro.go:85,92,203-227` vs `leveldb/util/cache.cc:336-341` | ✅ iter-13：分片 CLOCK-Pro、`strict_capacity_limit=true`；裁决-12 去掉优先级池切分 |
| C3 | VFS 接口显式包含同步与目录/锁语义 | `pebble/vfs/vfs.go:40-68,109-110,154` | ✅ iter-04：vfs **12+11 方法**（`Sync`/`SyncTo`/`SyncData`/`OpenDir`/`Lock`…），**目录 `Sync` 必须单列** |
| C4 | VFS 层故障注入作为一等公民 | `pebble/vfs/errorfs/`、`disk_full.go`、`disk_health.go`；`bbolt/tx.go:567,614` | ✅ iter-19：第一期必做——包装 FS 注入，不改引擎代码；配套 `cairnkv check` 与两级 CI 门禁 |
| C5 | 按层差异化过滤器 FPR（原"可选加分项"） | `pebble/options.go:1553-1606`（引 Dayan et al. TODS 2018） | ⚠️ **降级为可选**：iter-11 定投**统一 10 bits/key**；逐层配置保留为 `Options` 数组（默认全相等） |

### 2.3 主动放弃（6 项）

> 「放弃」也是参考决策：我们看了先例、给出理由、并写明重新评估的触发条件。**不是遗漏。**

| # | 放弃项 | 先例来源 | 理由 | 重新评估触发条件 |
|---|---|---|---|---|
| B1 | 值分离 / blob 文件 | `pebble/options.go:1684-1696`、`blob_rewrite.go`；`badger/value.go` | 收益依赖「值远大于键」的负载假设；引入独立 GC 与引用深度控制；草案示例是时序数据（值通常小） | 值平均 > 1 KB 且值主导搬移量时 |
| B2 | virtual sstable | `pebble/docs/RFCS/20221122_virtual_sstable.md` | 需要「一个物理文件被多个逻辑表引用」的引用计数，破坏「文件 = 不可变单元」心智模型 | 单文件尺寸成为 compaction 粒度瓶颈时 |
| B3 | excise / delete-only compaction 的 excise 分支 | `pebble/options.go:823`（Pebble 自称 Experimental） | 不做范围删除就不需要 excise | 若未来支持范围删除 |
| B4 | 列式块格式（colblk） | `pebble/sstable/colblk_writer.go`、`pebble/options.go:837` | 与值分离强耦合；价值集中在「大量小列 + 压缩」场景，与「不做列式分析」重叠 | 引入列式友好的上层结构时 |
| B5 | 两级索引「默认关闭」 | `pebble/sstable/rowblk_writer.go:1178`；`leveldb/table/two_level_iterator.cc` | iter-03 当时判断 2 MB 目标文件下索引块远小于阈值 | ⚠️ **后续更新**：iter-10/12 改为 **v1 起就是两级索引（结构自描述）**，`IndexBlockSize = 8 × BlockSize` 为切换阈值 |
| B6 | 不照抄 Pebble 的合并调度器（token-grant / pacing） | `pebble/compaction_scheduler.go` | 复杂度超出第一期需要 | ⚠️ **后续更新**：iter-17 以更简方案落地（三条件两档停顿 + 三级优先级 + 并发 10；限速默认关闭） |

### 2.4 学术与工程证据（选型依据，不是实现蓝图）

| 主题 | 参考 | 标识符 | 用它决定了什么 |
|---|---|---|---|
| 合并设计空间与写放大量级 | Sarkar, Staratzis, Zhu, Athanassoulis, PVLDB 14(11), 2021 | `DOI:10.14778/3476249.3476274`（PDF arXiv `2202.04522`） | leveled 的 `wa ≈ 2.7×` 量级（**必须重测**，V-05） |
| 长峰值退化与 I/O 调度 | Balmau et al., *SILK*, USENIX ATC 2019 | S2 `4ac21df6adc55df7e4bdc3114b984f13a54e48ce`；PDF `usenix.org/system/files/atc19-balmau.pdf` | 界定「单靠优先级不足以应对 300–500 s 长峰值」；抢占 defer |
| 自适应/懒分层合并（一手工作存在性） | Dostoevsky / LSM-Bush & Wacky / EcoTune / RusKey | `DOI:10.1145/3183713.3196927` / `10.1145/3299869.3319903` / `10.1145/3725344` / `10.1145/3617333` | 自适应合并 **defer 的理由改写**（以先落地 tiered-hybrid 为前提、切换成本为公认瓶颈） |
| 崩溃一致性与 fsync 语义 | Pillai et al., OSDI 2014 | 无 DOI（USENIX） | 目录 fsync 必做、平台差异必须显式声明（V-09/U-15） |
| group commit 的出处 | DeWitt et al., SIGMOD 1984 | `DOI:10.1145/602259.602261` | **证否「首提」**：该文自称属 "unwritten database folklore" ⇒ 只能称「早期书面描述」 |
| 跳表 `p` 的取值依据 | Pugh, CACM 33(6), 1990 | `DOI:10.1145/78973.78977` | `1/e` 的最优口径限定为「最小化 `L(n)/p`」（Pugh 本人推荐 1/4） |
| 缓存算法 | CLOCK-Pro, USENIX ATC 2005 | Pebble `pebble/internal/cache/clockpro.go:1-13` 自述实现来源（其 slides 链接指向原始论文） | 块缓存选型（C2） |
| fsync 失败后应用行为 | Rebello et al., ATC 2020 / ACM TOS 2021 | `DOI:10.1145/3450338` | 「fsync 失败不可恢复」的语义依据（毒化状态机） |

> 完整证据清单（含每个决策的逐条来源与核验状态）见 `docs/research/DELIVERABLE-02` 各节的「证据」列表。
> 未核验项已在 `DELIVERABLE-02` §1.4 显式登记（现仅 5 项，均为「等引擎或上游」）。

---

## 3. 创新点（自研与有依据的偏离）

> 再次声明：以下**不是算法原创**，而是「在嵌入式 Go 库约束下的工程决策」，每条都可追溯到裁决记录。

### 3.1 对工业先例的有意偏离（11 项）

> 完整表见 `docs/research/DELIVERABLE-02` §16.4。实现者若对照 Pebble/LevelDB 代码「顺手照抄」，会在这些点上出错。

| # | 我们的决策 | 偏离对象 | 核心理由 |
|---|---|---|---|
| D-1 | **三笔独立内存预算**（memtable / block cache / index-filter），不把 memtable 计入缓存容量 | Pebble `Cache.Reserve` 耦合（`pebble/internal/cache/cache.go:198`） | 单预算会让刷盘与命中率互相扰动，`§4.3` 的「硬上限」无法独立验证 |
| D-2 | **fsync 失败 ⇒ 毒化引擎 + typed `ErrEnginePoisoned`**（不 `os.Exit`、不 `panic`） | Pebble `Logger.Fatalf` → `os.Exit(1)`（`pebble/internal/base/logger.go:39-44`、`pebble/db.go:840`） | 库形态不能杀宿主进程；后台协程 panic 无法被宿主 `recover` |
| D-3 | 内部键 kind `0=Invalid / 1=Set / 2=Delete` | LevelDB `0=Delete / 1=Value` | 全零 trailer 若被解读成删除 ⇒ 损坏变静默数据丢失 |
| D-4 | **不保留 `CURRENT`**，标记文件是唯一真相来源 | LevelDB 的 `CURRENT` 指针文件 | 两个真相来源的不一致本身就是新崩溃窗口 |
| D-5 | 库**不调用** `debug.SetMemoryLimit` | 某 lane 提议的 `GOMEMLIMIT = 可用内存 × 0.9` | 进程级全局设置，嵌入式库不应改宿主 GC 策略 |
| D-6 | **默认开启块级 Snappy** | LevelDB/Pebble 默认不启用压缩的保守姿态 | 四家工业实现一致把块压缩作为默认能力；`S-07` 升 M（作者已确认） |
| D-7 | **MinLZ 只进对照，不作默认** | Pebble 的 `Fastest/Fast/Balanced` 档已用 MinLZ1 | 唯一性能证据是仓库自报告；依赖链/格式类型/上游 API 稳定性未达默认标准（升级判据见 §17 第 13 行） |
| D-8 | **第一期不实现 L0 子层** | Pebble `l0_sublevels.go` | 上游与学术侧均无可引用的量化收益；跨 manifest/compaction |
| D-9 | **第一期不做范围删除 / TTL / KV 分离** | Pebble `range_deletions.md`、blob | 范围删除复杂度横跨 5 个子系统；草案 §10 警惕范围蔓延 |
| D-10 | **53 字节 footer + 专属魔数 `0x53c9fb8ce508ea61`** | LevelDB 48 字节 footer / `0xdb4775248b80fb57` | 明确放弃二进制兼容，换取 kind 的安全语义与版本演进空间 |
| D-11 | **分片 CLOCK-Pro** | LevelDB 的 16 分片 LRU（`leveldb/util/cache.cc:22-40`） | 扫描污染与命中率；对齐 Pebble 的现代实践 |

### 3.2 自研设计组合（10 项）

> 这些点**没有单一先例可照抄**：要么是多个来源的组合在 CairnKV 约束下的再设计，要么是研究循环自己给出的精确化。

| # | 自研点 | 内容 | 为什么算自研 |
|---|---|---|---|
| ① | **WAL 双层记录格式** | 物理分块层（chunk 头 + 4 类片段，记录不跨块）+ 逻辑记录层（批次头 + tagged 条目）；块边界重对齐 | LevelDB 只有单层记录；双层是 iter-05 为「扁平日志的静默截断风险」给出的再设计 |
| ② | **内部键逐字节布局** | `user_key ‖ uint64 LE (seqNum<<8 \| kind)`；56 位序号、值域 `[10, 2^56-1]`；配合可见性水位单调推进保证批量原子性 | 在 LevelDB 编码上做的**字段级再设计**（kind 语义、序号值域、原子性来源都重新论证过） |
| ③ | **三档同步谱 + 确认点精确定义** | `SyncAlways` / `SyncGroupCommit`（默认）/ `NoSync`；确认点 =「包含该批次的组提交的那一次 fsync 已返回」 | 草案只有两档；三档与确认点是 iter-06 的定义工作 |
| ④ | **durability 不稀释的机械规则** | 绝不把「要求 fsync」的写入者并入「不要求 fsync」的组 | 把 `B-44` 从原则落成可实现的成组规则（对照 LevelDB `db_impl.cc:1303-1306` 加固） |
| ⑤ | **毒化状态机**（语义与可测试性） | 检测到 fsync 失败：所有 API 返回 `ErrEnginePoisoned`；等待者一律收错；关闭不做「尽力而为」flush；重开走正常恢复 | 不是「禁止崩溃」也不是「忽略」，是第三种选择；**可测试**（`vfs/errorfs` 注入一次 fsync 失败即可断言） |
| ⑥ | **三笔独立预算 + 统一上限规则** | `memtable_budget` / `block_cache_budget` / `index_filter_budget`；`TotalMemoryBudget > 0` 时 Open 早失败 | 把「硬上限」变成可被单元测试断言的性质（裁决-19） |
| ⑦ | **放大系数度量口径** | `write_amp = (WAL + flush + compact) / 用户字节`；RA 双口径；SA 含 obsolete；10 字段 + 采集点 + Go 接口签名 | iter-01 的度量定义工作（含 `§4.2` 四组对照实验的可执行化） |
| ⑧ | **RA 收益归因五拆分（不叠加）** | L0 重叠文件数 / 层数 / 索引块读 / 过滤器假阳性 / 缓存未命中——各归其主 | 防止同一份收益被计两次（裁决-14） |
| ⑨ | **墓碑回收条件 A ∧ B 的精确化** | 条件 A（更深层无更旧版本）∧ 条件 B（`S ≤ smallest_snapshot`） | 把草案「安全条件下」变成可判定的谓词（iter-18） |
| ⑩ | **冻结/切换五状态机 + 双引用计数** | `writerRefs`/`readerRefs`；R1/R2/R3 三条不变量（各配 model 测试） | 覆盖「WAL 已 fsync、内存未 apply」窗口的显式协议（iter-08） |
| ⑪ | **跨层超时/过载结论** | 引擎不提供带超时的写入阻塞（`Block`/`ReturnError` 两档）；`N-04`（有界队列 + 专用过载错误码）与 `N-06`（幂等请求 ID + 可查询提交状态）归网络层 | 「单机引擎无法精确回答超时后是否已提交」这一判断，是三处交叉论证后的跨层结论（裁决-18、iter-23） |
| ⑫ | **验证体系组合** | vfs 故障注入（不改引擎代码）+ 内存参考实现对拍 + 崩溃注入三定点 + 蜕变测试骨架（M3）+ 两级 CI 门禁 | 把 LSM 最难测的四类风险（静默丢版本 / 崩溃一致性 / 并发 / 非确定性）落到具体机件 |

> 表中 ⑪ 与 ⑫ 略超 10 项计数口径（原三分法只覆盖组件选型）；保留在此以呈现完整「自研账」。

### 3.3 诚实声明（不主张什么）

- **没有新算法**：不发明压缩、不发明索引、不发明合并策略。
- **没有新数据结构**：跳表/arena/布隆/CLOCK-Pro 均为已有工作。
- **不声称与任何既有引擎兼容**：磁盘格式（魔数、footer、kind、内部键编码）均自成一版。
- **不声称性能数字**：文献中的量级（如 `wa ≈ 2.7×`）明确标注为**待 CairnKV 重测**（V-05）。
- 本项目的实质产出是：**一份在嵌入式 Go 库约束下、每条决策都有证据与代价、可直接照做的设计书 + 实现计划**。

---

## 4. 与草案 v0.1 的关系

- **基线**：草案 55 条 `B-xx` 决策（13 条 `UNSPEC` 已全部消解）。
- **决策分布**（25 条非基线迭代）：`adopt` 19 / `keep` 5 / `defer` 1。
- **对草案的差异**（`DELIVERABLE-02` §16）：
  - A 类 · 措辞澄清 **9 项**（不需作者决策）；
  - B 类 · 实质修正 **10 项**（均有充分证据）；
  - C 类 · 需求优先级变更 **3 项**（✅ 作者已于 2026-09-29 确认全部接受）。
- **四项推翻草案默认**：合并策略 size-tiered → **leveled**；同步两档 → **三档**；压缩 C → **M（默认 Snappy）**；`CURRENT` → **标记文件族**。
- 草案需求表本身**未做修改**（作者自行修订）；研究循环只产出变更建议与依据。

---

## 5. 复核与来源

```bash
# 在工作副本上复核全部代码引用（期望 exit=0）
python3 .autoresearch/tools/scan_refs.py --exclude-report
# 迭代台账门禁（期望 PASS，25/25）
bash .autoresearch/autoresearch.sh check
```

| 想深入哪一块 | 读哪里 |
|---|---|
| 逐项设计决策（结论/候选/证据/代价/开放项） | `docs/research/DELIVERABLE-02-design-decisions.md` |
| 实现计划（M0–M5、参数默认值表、测试金字塔、风险表） | `docs/research/DELIVERABLE-03-implementation-plan.md` |
| 三分法原始论证（12 维度矩阵） | `.autoresearch/work/iter-03-industrial-matrix.md` |
| 23 项裁决 + UNSPEC 消解 + 差异清单 + U 清单 | `.autoresearch/work/iter-20-arbitration.md` |
| 补充轮（自适应合并 / L0 子层 / 准入控制 / U 收口） | `.autoresearch/work/iter-21..25-*.md` |
| 独立引用核验报告 | `.autoresearch/work/verification-report.md` |
| 一手源码钉版 | `.autoresearch/third_party/PINS.md` |
