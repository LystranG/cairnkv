# Notes

## 用户偏好
- 中文授课；术语保留英文原词（fsync、rename、page cache）
- 每课本页内容 20–30 分钟；加上原文、源码、作业，整课约 60–70 分钟（可分两次）；每周 3–5 小时
- 目的：纯粹深入学习（非论文/求职），所以重"为什么"与可验证的证据，不追赶进度
- 不教 Go 语言本身（§2.3 排除）；但练习可以落到 CairnKV 的 Go 代码上
- 工作区在 `learning/`（与项目代码隔离）
- 反馈（2026-10-10，第 1 课后）：觉得内容少、"只列了概念、没说怎么学"。每课开头必须有"怎么学这一课"的分步流程
  （预览 → 读指定原文小节 → 合上做练习 → 默写 → 带回仓库/提问），并说明原文只读指定小节、不用通读整本书。
  用户选了 **A（保持短小，靠原文和对话补深度）**，但要求：
  - 每课开头放"0. 学习清单"：① 阅读任务表（必读 / 源码 / 选读，写清书名、第几章第几节 + 章节名、时长；**不写页码**（用户明确要求））；
    ② 按顺序的勾选清单（assets/checklist.js），每步写时长和要做的具体动作
  - 用户的 OSTEP 是中文版《操作系统导论》，必须按中文版章节号 + 章节名引用（不写页码），英文版只作对照（映射见 RESOURCES.md）
  - 引用的外部英文材料要标明"（英文）"并指定只读哪一节

## 与实现绑定（2026-10-31）
- 代码由 AI 写，用户读代码学原理（[[0002-learn-by-reading-ai-code]]）。每个模块开工前上对应的课，模块与课程的对应见仓库根目录 `CLAUDE.md` 第 4 节。课程路线调整时，那张表要同步改。
- 课后练习落到代码上：给出要读的函数（`文件:行号`），附 2–3 个带答案的问题；也可以让用户手工解码 `docs/file-format.md` §9 的样例。
- 已过时的旧口径（讲课时以 `docs/file-format.md`、`docs/durability.md` 为准）：
  - `logSeqNum` 已改为 `allocSeq` / `visibleSeq` / `LastSequence`，序号重建公式见 durability §4.1；
  - 「`SyncDir` 单列」已改为 `OpenDir` + `Sync`；
  - `CURRENT` 已改为标记文件；
  - WAL chunk 头由 7 字节改为 19 字节，校验和带上下文修正；
  - 魔数由 `0x53c9…` 改为 ASCII 字节 `CairnWAL` / `CairnMAN` / `CairnSST`。

## 阅读主线（2026-10-10 用户提出）
- 用户想认真重读 OSTEP 持久化部分（以前读过、多已忘）并做笔记。A 阶段改为"重读计划为主线、课程作检查点"：
  第 2 周后做第 1 课，第 3 周后第 3 课，第 4 周后第 4 课，第 5 周（SSD）后进入第 7 课。计划见 reference/ostep-persistence-reading-plan.html
- 笔记放 learning/notes/ostep/chNN.md（模板 _template.md）。用户发来笔记时：按"关键问题 → 复述 → CairnKV 连接"追问，
  有证据的理解写 learning record
- AFS（第 49 章）不读；NFS（第 48 章）只在 M4 选读 48.7、48.11

## 课程路线（草案，按 ZPD 动态调整）
A. 存储与文件系统（§2.1，M0–M1 前）
  1. 持久化链路 + 原子替换协议（write/fsync/rename/目录 fsync） ← 0001
  2. macOS `F_FULLFSYNC`、`fdatasync`、`O_DIRECT` 的差别（自测 2）
  3. fsync 失败语义（fsyncgate）→ 为什么要毒化（V-04）
  4. torn write、扇区原子性与 CRC（自测 4）
  5. mmap 的代价（自测 3、5）
  6. 文件系统差异（Pillai 表格精读）
B. LSM 核心（§2.2）
  7. LSM 全景：为什么顺序追加（DDIA 3）
  8. WAL 记录格式：手工解码 leveldb log_format
  9. 组提交与确认点
  10. skiplist/arena 内存表
  11. internal key、seqnum、InternalCompare 全序 → V-01
  12. 恢复与 logSeqNum 重建 → V-08
  13. SSTable 块：前缀压缩与 restart points
  14. Bloom 过滤器 FPR
  15. leveled vs tiered；WA/RA/SA 与 RUM
  16. 墓碑与回收条件
C. 测试方法论（§2.4）
  17. vfs 层故障注入 vs 模型对拍 vs 蜕变测试
每 3–4 课插一次间隔复习（混合旧题）。

## 工作笔记
- 测验答案保持等长、正确选项位置轮换
- GLOSSARY.md 尚未建立：等用户能正确使用术语后再收录（首批候选：page cache、durability、atomic replace、directory entry）
