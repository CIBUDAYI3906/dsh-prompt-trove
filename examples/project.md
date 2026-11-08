# 项目常用提示词（示例）

<!--
项目库的样子：<项目目录>/.dsh-prompts/<项目名>.md
把这一份放到 <项目目录>/.dsh-prompts/ 下，并在 profile 的 cordis.patch.yml
给 dsh-prompt-trove 这一行加 config.root 指向项目或项目父目录。
-->

## 这个项目的技术栈
> 让新会话开局就知道用什么写 #技术栈
Node.js 24 + TypeScript，包管理用 pnpm；不要把临时脚本写进 src/。

## 这个项目的验收标准
> 交付前必须满足的硬约束 #流程
改完必须跑 `npm run verify`；涉及界面时附一张真机截图；不引入新的运行时依赖。
