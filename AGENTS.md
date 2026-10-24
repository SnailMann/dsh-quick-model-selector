# DSH Quick Model Selector

- 公开样例不包含用户真实模型配置或本机路径。
- 仅增强 `conversation.input.model` 选择界面；复用官方模型目录及选择服务，不改 provider、凭证或模型清单。
- 保留官方选择器回退能力；注册和卸载不留重复占位或空白入口，选择结果与官方模型状态一致。
- 自适应仅观察宿主控制行和本座位的尺寸，修改自身宽度，不覆写其他插件或宿主布局。窄框模型按钮固定 150px，空间不足时继续收窄并保持名称省略，推理强度移入菜单；极窄时保留宿主换行能力。观察器、动画帧及窗口监听必须清理，验证连续缩放、其他控件文字变化和弹层边界。
- 搜索、折叠、收藏、最近使用和键盘操作同时可用；偏好存储失败时正常降级，升级兼容已有偏好（含旧包名 `dsh-model-palette` 的 localStorage 键一次性迁移）。
- 修改 `src/logic.js` 或 `src/client.template.js` 后运行 `npm run build`；修改源文件，不直接维护生成的 `dist/client.js`。
- 执行 `npm test`，再在真实 DSH 验证焦点、键盘导航、切换模型和偏好读回；打包前确认 `dist/client.js` 已更新。
- 键盘回归使用 `test/keyboard.test.js` 在隔离浏览器中加载本机 DSH 的 React 和构建产物；通过 `NODE_PATH` 提供 Playwright，必要时用 `QMS_BROWSER_CHANNEL=chrome` 选择系统浏览器。依赖缺失会明确跳过，不能当作交互验收通过。
- 涉及安装时按当前 DSH 包清单及 bundle 规则核验；旧脚本的软链与 YAML 追加不足以证明插件列表可见，必须补齐验收。
