# 委派工作区

- 根目录仅保存工作区规则。每个对话在自己的 YYYY-MM-DD-topic 直接子目录工作。
- 本对话的代码、任务输入、下载、临时文件和产物全部放在该子目录。
- 执行命令显式使用本对话目录，文件工具使用该目录内的绝对路径。
- 连续工作与返修复用当前对话和目录，不写入兄弟任务目录。
- session.json、task.md、requests.jsonl、events.jsonl、result.md、supervisor.log、delivery.json、review.json 和锁文件由 Codex 管理。
- 遇到权限或工具限制，报告实际失败与未完成项，由 Codex 核查；保留现有保护设置。
- 完成后说明真实改动和验证结果。验收由 Codex 完成。
