# DSH 快捷模型选择器

[English](README.en.md) · 中文

接管 DSH 输入框右下角的模型座位：把按 provider 平铺的长列表换成搜索优先的面板，收藏与最近使用置顶，模型多的 provider 折叠收起；推理强度是旁边独立的第二个控件。适合接了几十上百个模型、翻列表翻到烦的场景。

输入框右下角是两个各自独立的控件，各有各的点击区域和弹层：

![输入框两个控件](docs/images/composer.png)

![模型面板](docs/images/menu.png)

## 功能

- **搜索优先**：打开即聚焦搜索框，输入即过滤，模型名、provider 名、模型 id 一起匹配，多个关键词用空格分隔（AND）。
- **收藏与最近使用**：常用的几个模型永远置顶。
- **分组折叠**：超过 6 个模型的 provider 默认折叠；含当前选中模型、含收藏的组自动展开，手动折叠状态会记住。
- **倍率角标**：模型名里的 `x0.28` 剥出来做成行尾角标，≤0.3 绿、≤0.8 琥珀、>0.8 红。
- **推理强度独立**：单独按钮、单独弹层、单独收焦点；当前模型不支持 reasoning 时按钮直接不渲染。
- **键盘快选**：`⌘1–⌘9` 直选、`⌘D` 收藏、`Tab` 折叠、方向键 + Enter。

![搜索](docs/images/search.png)

![推理强度](docs/images/effort.png)

控制行窄到放不下两个控件时，模型按钮换成图标、强度收进菜单底部一行：

![窄宽度触发器](docs/images/compact.png)

![窄宽度菜单](docs/images/compact-menu.png)

深色主题同一套排版：

![深色](docs/images/menu-dark.png)

## 安装

**插件页（推荐）**：设置 → 插件 → 添加插件 → 「包名或地址」填

```
https://github.com/SnailMann/dsh-quick-model-selector
```

装完按提示重启一次 DSH Desktop。重启后在「已安装插件」里能看到「快捷模型选择器」，可随时开关或卸载。

**命令行**（等价，`web` 是 Desktop 用的 profile 名）：

```sh
dsh plugin --profile web add github:SnailMann/dsh-quick-model-selector
```

`dist/` 已随仓库提交，安装不需要编译，也不会触发 pnpm 的构建脚本审批。

**从源码**（想改代码时）：

```sh
git clone https://github.com/SnailMann/dsh-quick-model-selector.git
cd dsh-quick-model-selector
dsh plugin --profile web add .
```

改完 `src/` 要 `npm run build` 再重启 DSH。

已在 DSH Desktop 0.12.1 / Harness 0.2.1-rc.2 验证：插件列表可见可开关，启用装配 1 条插件行、停用 0 条。

## 使用

点输入框右下角的模型按钮，剩下的都在表里：

| 键 | 行为 |
| --- | --- |
| 直接打字 | 过滤列表 |
| ↑ / ↓ | 移动高亮（焦点留在搜索框） |
| Enter | 选中当前高亮 |
| Esc | 先清空搜索词，再按一次关闭；在强度弹层里直接关闭 |
| Tab | 折叠 / 展开当前高亮所在的 provider 组 |
| ⌘1 – ⌘9（或 Ctrl+1–9） | 直选第 N 个可见项 |
| ⌘D（或 Ctrl+D） | 收藏 / 取消收藏当前高亮 |

鼠标同样可用：点行选中、点星标收藏、点分组头折叠。

偏好存在 `localStorage` 的 `dsh-quick-model-selector:prefs:v1`，全局共享、不区分会话；从旧包名 `dsh-model-palette` 升级时旧键会自动迁移，收藏与折叠状态不丢。

## 卸载

```sh
dsh plugin --profile web remove dsh-quick-model-selector
```

只移除自身登记，会话、模型配置和偏好都保留；重启后恢复官方模型选择器。

## 开发

改 `src/` 后 `npm run build` 再 `npm test`；`node scripts/preview.mjs <dir>` 可把真实组件渲染成静态页看排版。

## License

MIT
