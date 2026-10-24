# DSH 快捷模型选择器

接管 DSH 输入框右下角的模型座位，把「按 provider 平铺的长列表」换成搜索优先的面板：收藏与最近使用置顶，模型多的 provider 折叠收起；推理强度是旁边独立的第二个控件。

适用于接入了几十上百个模型、翻列表翻到烦的场景。

![模型面板](docs/images/menu.png)

## 效果

输入框右下角是**两个各自独立的控件**，各有各的点击区域、各自的弹层、各自的焦点：

![输入框两个控件](docs/images/composer.png)

模型面板整块 336px 宽、最高 430px，模型行高统一 30px；上方空间不够时会按实际可用高度收缩，不会顶出窗口。面板一打开焦点就在搜索框，输入 `kimi`、`gemini`、`global` 都能命中（模型名、provider 名、模型 id 一起匹配），多个关键词用空格分隔（AND）：

![搜索](docs/images/search.png)

推理强度点开是另一个弹层（宽 212px），不占模型列表的位置：

![推理强度](docs/images/effort.png)

控制行窄到放不下第二个控件时，模型按钮换成图标、强度收进菜单底部的一行入口，能力不缩水：

![窄宽度触发器](docs/images/compact.png)

![窄宽度菜单](docs/images/compact-menu.png)

深色主题同一套排版：

![深色](docs/images/menu-dark.png)

## 功能

- **搜索优先**：面板打开即聚焦搜索框，输入即过滤，无需先找分组。
- **候选收缩**：收藏 + 最近使用置顶，常用的几个模型永远在手指底下。
- **折叠兜底**：模型数超过 6 个的 provider 默认折叠；含当前选中模型的组、含收藏的组默认展开。手动折叠/展开的状态会被记住。
- **倍率角标**：`x0.28` 这类 token 从模型名里剥出来做成行尾角标，按价格分档着色：≤0.3 绿、≤0.8 琥珀、>0.8 红。名字本身保持干净。
- **推理强度独立**：两个按钮各自 `aria-expanded`、各自开弹层、各自收焦点，点一个不会连带另一个。当前模型不支持 reasoning 时强度按钮直接不渲染，不留灰掉的占位。
- **跟随 composer 紧凑契约**：控制行排不下两个控件时，宿主给模型位设 `--dsh-composer-model-text-display: none` 与 `--dsh-composer-model-icon-display: block`；触发器的文字和图标消费这两个变量，所以窄宽度下文字收起换成图标，composer 不会被撑高。

## 安装

插件还没上传插件市场，从 GitHub 仓库装。**用 DSH Desktop 的插件页装**，不需要手改任何配置文件：

1. 打开 **设置 → 插件**，点右上角「添加插件」。
2. 在「包名或地址」里填仓库地址：

   ```
   https://github.com/SnailMann/dsh-quick-model-selector
   ```

   填本机克隆目录的绝对路径也可以，两种方式等价。
3. 等安装跑完，按提示**重启一次 DSH Desktop**（客户端 bundle 只在启动时装配，仅刷新页面不够）。

重启后在「已安装插件」里能看到 **快捷模型选择器**（带自己的图标和一段简介），可以随时开关、查看详情或卸载。装的时候 DSH 会把包登记进 profile 依赖，并因为包里声明了 `dsh.bundle` 自动把它加进组合包列表 —— 这一步是插件页代劳的，别手工往 `cordis.patch.yml` 里加行。

> 之前用 `npm run install:dsh`（软链 + YAML 插入）装过旧版的话，先跑一次 `npm run remove:dsh` 清掉旧登记再装，否则两份登记会抢同一个模型座位。

### 命令行安装

`dsh` 自带 `plugin` 子命令，作用与插件页相同：参数转发给 pnpm，装完把声明了 `dsh.bundle` 的包登记进 `dsh.profile.bundles`。

```sh
dsh plugin --profile web add github:SnailMann/dsh-quick-model-selector
```

`web` 是 DSH Desktop 使用的 profile 名，用别的 profile 时换成对应名字。`dist/` 已随仓库提交，安装时不需要编译，也不会触发 pnpm 的构建脚本审批。

### 从本地源码安装

想改代码就克隆下来，装本地目录（插件页填绝对路径，或命令行）：

```sh
git clone https://github.com/SnailMann/dsh-quick-model-selector.git
cd dsh-quick-model-selector
dsh plugin --profile web add .
```

改完源码要重新构建，`dist/client.js` 才会更新（见「开发」）。

仓库另带一个等价脚本，适合反复安装的场景，并会顺手清掉旧版安装留在 `cordis.patch.yml` 里的标记块：

```sh
npm run install:dsh
```

先看会改什么而不写入：

```sh
node scripts/install-local.mjs --dry-run
```

### 已验证

在 **DSH Desktop 0.12.1 / Harness 0.2.1-rc.2** 上跑过这几条：

- **插件页 / 命令行装 Git 仓库**：`dsh plugin --profile web add github:SnailMann/dsh-quick-model-selector` 后，profile 的 `dependencies` 记成 `github:SnailMann/dsh-quick-model-selector`，`dsh.profile.bundles` 自动追加本包；`dsh --profile web --dump-config` 里能看到 `# == dsh-quick-model-selector` 层；`dsh plugin --profile web remove dsh-quick-model-selector` 把依赖和层一起撤掉。
- **已安装插件列表**：真实 profile 里 `installed` 与 `enabled` 均为 `true`，标题显示「快捷模型选择器」，图标取自包内 `icon.svg`；启用时组合出 1 条插件行，停用后 0 条（`test/host-registration.mjs` 断言）。
- **两半都真激活**：host 半在真实 cordis `Context` 上 `apply` 成功，客户端 bundle 走 `__ModuleLoader__` 注册，`conversation.input.model` 座位被接管（priority -20）。
- **安装脚本**：重复运行输出 `Registration already matches; unchanged`；卸载只移除自身登记，会话、模型配置与偏好都保留。

## 使用

打开输入框右下角的模型按钮，剩下的都在这张表里：

| 键 | 行为 |
| --- | --- |
| 直接打字 | 过滤列表 |
| ↑ / ↓ | 移动高亮（搜索框始终持有焦点） |
| Enter | 选中当前高亮 |
| Esc | 先清空搜索词，再按一次关闭面板；在推理强度弹层里直接关闭 |
| Tab | 折叠 / 展开当前高亮所在的 provider 组 |
| ⌘1 – ⌘9（或 Ctrl+1–9） | 直接选中第 N 个可见项 |
| ⌘D（或 Ctrl+D） | 收藏 / 取消收藏当前高亮 |

鼠标操作同样可用：点击行选中、点击星标收藏、点击分组头折叠。

偏好存在 `localStorage` 键 `dsh-quick-model-selector:prefs:v1`，全局共享、不区分会话；隐私模式下写不进去也不影响使用。从旧包名 `dsh-model-palette` 升级时，旧键会在首次读取时自动迁移过来并删除，收藏、最近使用与折叠状态不丢。

## 卸载

```sh
dsh plugin --profile web remove dsh-quick-model-selector
```

或使用仓库脚本（效果相同，含软链清理）：

```sh
npm run remove:dsh
```

只移除自身登记，会话、模型配置、偏好都保留。重启后恢复官方模型选择器。

## 已知取舍

- 收藏区和分组区会出现同一个模型（收藏是置顶快捷方式，像 VS Code 的固定标签），键位导航时该行会出现两次。
- 长模型名走省略号 + `title` 提示；模型列表固定 336px 宽、推理强度弹层 212px，都不随窗口拉伸。
- 英文界面走 `navigator.language` 判断，文案是内置的两套字典，不参与 DSH 的 locale 切换。
- 倍率角标的底色是硬编码的浅色（`#eaf3de` 等），深色主题下仍是浅底深字，能看但不算完全贴合主题。

## 开发

```sh
npm run build   # 改完 src/logic.js 或 src/client.template.js 后必须重新构建
npm test        # 逻辑单测 + 安装脚本测试 + 构建产物的注册/渲染冒烟
node scripts/preview.mjs /tmp/qms-preview          # 静态预览页（六个变体 × 明暗）
QMS_DOCS=1 node scripts/preview.mjs /tmp/qms-docs  # 生成 README 用的干净截图
```

改完客户端代码要 `npm run build` 并重启 DSH（客户端 bundle 不做热替换）。

排版别靠感觉猜：`scripts/preview.mjs` 用 profile 自带的 React 把真实组件 SSR 成 HTML，页面里带一段脚本把每类元素的**计算后**尺寸和字号写进 `#m`，可以直接读真实 px。

真实宿主验收（需要本机装了 DSH Desktop）：

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop" test/host-registration.mjs
```

它会在临时目录里跑一遍安装脚本，然后用 Desktop 自己的 `PluginManager` 与 `loadProfile` 断言插件被发现、启用时装配 1 条行、停用后 0 条。

## 目录

```
src/logic.js              纯函数：解析、偏好归一化、视图模型（有单测）
src/client.template.js    面板 UI 模板（含 __LOGIC_BUNDLE__ 占位）
src/index.js              host 半，仅打一行启动日志
cordis.patch.yml          组合包配置层：插入插件行
locale/                   插件列表里的中英文标题与描述
icon.svg                  插件列表与详情页的图标
scripts/build-client.mjs  内联 logic → dist/client.js
scripts/install-local.mjs 本地注册 / 卸载
scripts/preview.mjs       把真实组件渲染成静态页并截图，用于看排版
test/                     逻辑单测、安装脚本测试、宿主注册验收
docs/images/              README 配图
```

## English

A search-first replacement for DSH's composer model seat: favorites and recents pinned on top, provider groups collapsed beyond six models, `⌘1–⌘9` quick pick, and reasoning effort as a separate control next to the model button.

Install it from **Settings → Plugins → Add plugin** with the repository address `https://github.com/SnailMann/dsh-quick-model-selector` (a local clone path works too), then restart DSH Desktop once. The same install from a terminal:

```sh
dsh plugin --profile web add github:SnailMann/dsh-quick-model-selector
```

Toggle it any time under Settings → Plugins. Verified on DSH Desktop 0.12.1 / Harness 0.2.1-rc.2.

## License

MIT
