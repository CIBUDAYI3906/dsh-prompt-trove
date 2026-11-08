# 发布到网上

这份文件是发布 runbook。仓库里的代码已经按可分发包改好，剩下的是账号相关的动作（GitHub、npm、目录 PR）。

## 0. 前置条件

- Node 20+、npm 账号（[npmjs.com](https://www.npmjs.com)）、GitHub 账号；
- 本机装好 `dsh`（验证安装用）；
- 仓库名建议就叫 `dsh-prompt-trove`。

## 1. 本地过一遍

```sh
npm install
npm run build        # 改过 client-source.jsx 之后必须重跑
npm run verify       # bundle 加载 + 宿主路由自检
```

`verify` 全绿再继续。

## 2. 填 GitHub 用户名

```sh
npm run owner <你的GitHub用户名>
```

它会把 `package.json` 的 repository/homepage/bugs、README、本文件里的 `CIBUDAYI3906` 换掉，并把
`submission/CIBUDAYI3906__dsh-prompt-trove.yml` 改名成 `<用户名>__dsh-prompt-trove.yml`。

## 3. 建仓库并推上去

1. GitHub 上新建 **public** 仓库 `dsh-prompt-trove`（不要勾 README/.gitignore/License，本地已经有）；
2. 给仓库加 topic：`dsh-plugin`（目录审核会看）；
3. 推代码：

```sh
git init -b main
git add .
git commit -m "dsh-prompt-trove 0.1.0"
git remote add origin git@github.com:<用户名>/dsh-prompt-trove.git
git push -u origin main
```

> 目录的 CI 要求仓库**创建满 1 天**才能通过。今天建仓，明天再提目录 PR。

## 4. 用隔离 profile 验证"别人装得上"

```sh
npm pack
export TEST_HOME=/tmp/dsh-prompt-trove-test
rm -rf "$TEST_HOME"
DSH_HOME="$TEST_HOME" dsh --profile test --from-default-profile web --dump-config >/dev/null
DSH_HOME="$TEST_HOME" dsh plugin --profile test add ./dsh-prompt-trove-0.1.0.tgz
DSH_HOME="$TEST_HOME" dsh --profile test --dump-config | grep -A2 dsh-prompt-trove
DSH_HOME="$TEST_HOME" dsh --profile test --port 49311 --no-open
```

打开它打印的 `http://127.0.0.1:49311/?token=…`，确认输入框工具行出现「常用提示词」，面板能打开、能插入。
（第一次启动会有 provider 配置页，点「稍后配置」即可，不需要真的配模型。）

还有一条自动化路线：

```sh
DSH_WEB_URL="http://127.0.0.1:49311/?token=…" npm run e2e
```

## 5. 发 npm

```sh
npm login
npm publish --access public
npm view dsh-prompt-trove version
```

- 发之前 `prepublishOnly` 会自动跑 `scripts/preflight.mjs`：还带 `CIBUDAYI3906` 占位符、`client.js` 的模块 id 和包名不一致、缺图标，都会在这里挡住。
- 首次发 `0.1.0`；之后每次改动 bump 版本再发，市场和用户的更新检测都认 npm 版本号。
- 预发布用 `npm publish --tag next`，不要把 `latest` 指到预发布版本。
- 发砸了：72 小时内可 `npm unpublish <pkg>@<version>`；超过就 `npm deprecate` 并补一个修复版本。

## 6. 提目录 PR（收录 = 上架）

收录入口是 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：市场、目录站、DSH 0.2.1+ 的 Discover 都读它的数据。

1. Fork 该仓库；
2. 把 `submission/<owner>__dsh-prompt-trove.yml` 原样放到 `data/plugins/` 下，**一个 PR 只加这一个文件**；
3. 提交 PR。

CI 会检查：

- 仓库的 `package.json` 声明了 `dsh.bundle`（本仓库有）；
- 仓库创建满 1 天；
- yml 格式、双语描述、`awesome-lint`；
- 描述里的每个断言都和代码对得上。

审核看的是：代码是否真的做描述的事、分类是否贴切、是否和已有条目重复、源码里有没有可疑行为。
同类条目不少（[dsh-prompt-vault](https://github.com/Frog755/dsh-prompt-vault)、[dsh-prompt-library](https://github.com/JianhangLy/dsh-prompt-library)），
PR 描述里讲清楚差异即可：**两层库（全局 + 项目）、Markdown 落盘可进 git、`@` 触发、追加不覆盖**。

## 7. 合并之后

- 站点自动重建；`dsh-market` 每天刷新 `plugins.json`；
- 用户安装：`dsh plugin --profile web add dsh-prompt-trove`，或在市场/Discover 里一键装；
- 想改描述或截图，改自己的仓库再提 PR（截图放在仓库根 `screenshots.json` 里声明，不用来提 PR）。

## 8. 版本与更新

| 改动 | 版本 | 命令 |
| --- | --- | --- |
| 修 bug / 文案 | patch | `npm version patch && npm publish` |
| 新功能 | minor | `npm version minor && npm publish` |
| 不兼容 | major | `npm version major && npm publish` |

GitHub Release 打 `v<version>` 标签即可（目录的 `tarball:` 字段是可选的，本包不需要）。

## 9. 只在 GitHub 上发（不 npm）

也可以，目录接受 GitHub-only 条目：

```sh
dsh plugin --profile web add github:<用户名>/dsh-prompt-trove
```

本仓库的 `client.js` 是提交进仓库的构建产物，不需要 `prepare` 脚本，用户不用额外授权构建。
只是没有下载量、每次装都要拉整个仓库，更新也走仓库 HEAD——所以推荐 npm。

## 10. 发布前检查清单

- [ ] `npm run build` 后 `client.js` 是最新的（`git status` 干净）
- [ ] `npm run verify` 全绿
- [ ] `npm run e2e` 在隔离 profile 上全绿
- [ ] `node scripts/preflight.mjs` 通过
- [ ] `npm pack` 的内容只有 9 个文件：`index.js`、`client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`、`icon.png`、`examples/*`、`package.json`
- [ ] `examples/` 和截图里没有公司名、真实客户、密钥、个人路径
- [ ] npm 包名可用、`repository` 指向真实仓库
- [ ] GitHub 仓库是 public、带 `dsh-plugin` topic、满 1 天
