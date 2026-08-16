# AI 伴侣（AI Companion）

一个跑在你电脑上的 **AI 女友 / AI 男友** 桌面应用。离线语音合成与识别、微信式状态栏、双角色可切换，双击即用。

> 默认大模型：智谱 GLM（`glm-4-flash`，免费）。首次打开按引导填你自己的 API Key 即可。

---

## ✨ 特性

- 💬 **双角色**：女友 / 男友，一键切换，音色与界面自动跟随性别
- 🗣️ **ChatTTS 本地离线中文语音**：自然、有活人感（会笑、有停顿），**绝不回退系统嗓音**
- 🎙️ **whisper-small 本地语音识别**：中文，对河南等方言口音鲁棒
- 📱 **微信式状态栏**：「对方正在输入中…」「对方正在录制语音…」
- 🔒 **离线优先**：语音合成与识别全在本地，音频不上传
- ⚡ **边出边说**：LLM 第一句就绪即开口配音，不用等整段回复写完
- 🎨 可换伴侣头像、用户头像；音色 / 语速可调

---

## 🧱 架构

| 层 | 文件 | 说明 |
|---|---|---|
| Electron 壳 | `resources/app/main.js` | 把后端 HTTP 服务跑在进程内，监听 `localhost:4000` |
| Node 后端 | `resources/app/server.js` | 聊天、TTS/STT 路由、用户数据 |
| TTS | `resources/app/tts-local.js` → `chattts/chattts_synth.py` | ChatTTS 合成（嵌入式 Python 常驻子进程） |
| STT | `resources/app/stt-node.js` + `models/whisper-small` | 本地语音识别 |
| 前端 | `resources/app/public/` | 聊天界面、状态栏、设置 |

---

## 📦 下载完整包（双击即用）

> 本仓库**仅含源码**。ChatTTS 嵌入式 Python 运行时、模型权重等体积数 GB，**不纳入 git**。

### 🎯 用户：从 Release 页面下载（推荐）

直接到 GitHub Releases 页面下载已打包好的完整包（已含可执行文件 + Python 运行时 + ChatTTS 权重 + Whisper 权重，解压后双击 `AI伴侣.exe` 即用）：

> 👉 **[Releases 页面 → v1.0.0](https://github.com/liu123585/AI-companion/releases/latest)**

**三步安装**：
1. 到 Releases 页面下载 **`download_merge.bat`**（小脚本，几 KB）。
2. **双击 `download_merge.bat`** → 自动下载全部 924 个分块（`aipkg.part0001`~`aipkg.part0924`，合计 1.85 GB）并合并成 `AI伴侣完整包CPU版.7z`（首次会让你 `gh auth login` 登录 GitHub，约 10–30 分钟，看网速）。
3. 用 **7-Zip** 右键解压 `AI伴侣完整包CPU版.7z` → 进解压目录双击 `AI伴侣.exe` 即用。

> 合并脚本已内置顺序与完整性检查，无需手动操作。若某块下载失败，重跑 bat 会自动补下缺失块。

**SHA256 校验**（合并后核对，确认没下坏）：
```
ceb03cc4edafbc8b2af1b83f0973b7e81e93383188a2079fcec880f975b75897  AI伴侣完整包CPU版.7z  (1.85 GB)
```
> 自己校验：在文件目录里运行 `certutil -hashfile AI伴侣完整包CPU版.7z SHA256`，对比上面的字符串。

> ⚠️ **为什么拆成 924 个 2MB 小分块**：GitHub 上传接口对单个文件连接只有 ~20 秒存活窗口，>3MB 必被掐断，1.85GB 单文件无论网页还是 API 都传不上去。拆成 2MB 小块后每块几秒传完（在窗口内），维护者用脚本逐块传上；你下载时由 `download_merge.bat` 自动拉全 + 合并，对你是透明的。

> ⚠️ **为什么是 CPU 版不是 GPU 版**：ChatTTS 是逐 token 自回归解码，瓶颈在串行步数、不在算力。实测 GPU vs CPU 推理速度几乎一致（4–5 s / 句），CUDA 版 torch 反而占 2.4 GB 体积。CPU 版用户机器无需 NVIDIA 显卡，开箱即用。

### 🔧 开发者：从源码自行组装

1. 准备嵌入式 Python 运行时（`torch 2.13.0+cpu` / `ChatTTS 0.2.5` / `transformers`）放到 `resources/app/chattts_runtime/python/`
2. `cd resources/app/chattts && python download_model.py` 下载 ChatTTS 权重（走 `hf-mirror.com` 镜像，含 sha256 校验与断点续传）
3. 下载 `whisper-small` 权重到 `resources/app/models/whisper-small/`
4. `cd resources/app && npm install && npm run dist`（输出 `resources/app/dist/AI伴侣.exe`，portable 单文件）

---

## 🛠 开发 / 本地运行

```bash
git clone <本仓库地址>
cd AICompanion/resources/app
npm install
npm run start          # 以 Electron 开发模式启动（需先备好 runtime + models）
```

## 📀 打包为 exe

```bash
cd resources/app
npm run dist           # 输出 resources/app/dist/AI伴侣.exe（portable 单文件）
```

---

## ⚙️ 首次使用

1. 启动后按引导填写大模型 **API Key**（默认智谱 GLM，`glm-4-flash` 免费）
2. 设置里选择伴侣**音色**（女声：晓晓 / 小妮；男声：云阳 等）、**语速**
3. 聊天支持：文字 / 语音输入 / 语音回复

> 角色与音色契约：女友界面永远女声、男友界面永远男声（后端性别铁律 + 前端按界面选音色双重保障）。

---

## 📂 目录结构

```
AICompanion/
├── .gitignore
├── LICENSE
├── README.md
└── resources/app/            # ← 源码根（git 跟踪）
    ├── main.js
    ├── server.js
    ├── tts-local.js
    ├── stt-node.js
    ├── package.json
    ├── chattts/
    │   ├── chattts_synth.py   # ChatTTS 合成脚本
    │   └── download_model.py  # 权重下载（hf-mirror）
    ├── public/                # 前端（HTML/CSS/JS）
    ├── chattts_runtime/       # [不进 git] 嵌入式 Python + torch
    ├── chattts/models/        # [不进 git] ChatTTS 权重
    ├── models/                # [不进 git] whisper 权重
    └── data/                  # [不进 git] 用户聊天记录 / 配置 / 头像
```

---

## 📜 许可证

MIT © 2026 刘昱善 (Yushan Liu)

## ⚠️ 免责声明

- 本项目调用第三方大模型 API（默认智谱 GLM），请自行保管 API Key，勿泄露、勿提交进仓库。
- 聊天数据默认存于本机 `AppData\ai-companion\data`，不上传。
