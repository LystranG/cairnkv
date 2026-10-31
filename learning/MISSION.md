# Mission：存储引擎原理（配合 AI 实现的 CairnKV 学习）

## Why
CairnKV 的代码由 AI 编写，我通过读代码理解一个单机 LSM 存储引擎为什么这样设计。学习目的不是交论文或应付面试，而是：
- 对每个「为什么不是另一种做法」，都能自己给出有证据的回答；
- 读代码时能看出哪里可能藏着静默错误。

（2026-10-31 调整：原定亲手实现，现改为 AI 实现、我读代码，见 [[0002-learn-by-reading-ai-code]]。）

## Success looks like
- 不看资料，能画出「一次写入从 `write()` 到真正持久」的完整链路，并说出每一步之后崩溃，磁盘上是什么状态
- 能独立解释 `docs/learning-path.md` §2.1、§2.2、§2.4 的全部自测问题
- 能读懂 LevelDB 的 `log_format.md` / `table_format.md`，能手工解码一条 CairnKV 的 WAL 记录（`docs/file-format.md` §9.1）和一个数据块
- 能说清 V-01 / V-04 / V-08 各自防的是哪种静默错误，并在 CairnKV 代码里找到对应的断言或测试
- 能用 WA / RA / SA 与 RUM 的语言比较 leveled 与 tiered，并给出在自己环境下的测量方案

## Constraints
- 每周 3–5 小时；每节课 20–30 分钟
- 背景：OS 基础尚可（页缓存、文件系统有概念），数据库和存储引擎基础较薄
- 用中文授课；一手资料多为英文，课内给出精确出处
- 节奏：**先上课，再让 AI 实现对应模块**（模块与课程的对应见仓库根目录的 `CLAUDE.md` 第 4 节）
- 课后练习落到刚实现的代码上：按讲解稿的阅读路线读代码、回答自测问题、手工解码样例。不要求我自己写实现
- 讲到规格细节时，以 `docs/file-format.md`、`docs/durability.md` 为准；`docs/learning-path.md` 中的部分说法已经过时

## Out of scope
- Go 语言本身（调度、内存模型、GC 等），我另行学习
- 分布式（复制、共识、分片）、SQL 与查询优化、B-Tree 引擎的深入实现
