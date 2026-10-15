# 第三方软件与来源

| 组件 | 用途 | 许可/来源 |
|---|---|---|
| AgentHub backend | 自有任务执行引擎与数据库迁移 | Apache-2.0，见 vendor/agenthub/LICENSE |
| Ajv / ajv-formats | JSON Schema 校验 | MIT；版本见 package-lock.json |
| fflate | 文档容器读取 | MIT；版本见 package-lock.json |
| mammoth | Word 文档正文 | BSD-2-Clause；版本见 package-lock.json |
| pdf-parse | PDF 正文 | Apache-2.0；版本见 package-lock.json |
| SheetJS CE | 表格读取 | Apache-2.0；锁定官方发行包 URL 与完整性 |
| Acorn | 静态代码分析 | MIT；开发依赖 |
| Playwright Core | 浏览器回归 | Apache-2.0；开发依赖 |

Python 引擎的准确依赖版本见 vendor/agenthub/backend/requirements.lock；各包保留原许可。第三方名称仅用于说明兼容关系，不表示官方背书。

文档组织参考 Goose 和 OpenCode 官方 README 的“产品价值→开始使用→详细文档→反馈”结构，未复制其商标、效果数字或功能承诺。来源：https://github.com/aaif-goose/goose ，https://github.com/anomalyco/opencode 。
