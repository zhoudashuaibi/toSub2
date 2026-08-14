# toSub2

QQ 交流群：`1085165735`

[点击链接加入群聊【toSub2】](https://qm.qq.com/q/n40xuIClm8)

toSub2 是一个本地网页工具，通过协议请求完成 ChatGPT 登录和 Codex OAuth（授权登录），自动判断账号是否需要绑定手机号，并生成可供 sub2api 导入的 JSON（结构化数据）文件。

> 本项目不是 OpenAI 官方项目。上游登录接口随时可能变化。

![toSub2 控制台](docs/console.png)

## 工作流程

1. 通过邮箱验证码或密码登录 ChatGPT。
2. 账号启用 2FA（双重身份验证）时，自动生成并提交 TOTP（基于时间的一次性密码）。
3. 发起 Codex OAuth（授权登录）。
4. 根据服务端响应判断账号是否已经绑定手机号。
5. 未绑定手机号时进入短信验证，支持手动号码、LubanSMS（鲁班接码）、SMSBower（短信接码平台）或自定义接码 API（接口）。
6. 选择 workspace（工作区），兑换 OAuth Token（授权令牌）。
7. 生成标准 `sub2api-data` 导入文件。

## 主要功能

- 本地网页控制台，可同时管理多条登录任务。
- 最多同时运行 20 条任务，超出后自动排队。
- 支持手动邮箱验证码、邮箱收码 API（接口）自动取码。
- 支持密码登录，以及密码或邮箱验证码登录后的 2FA（双重身份验证）。
- 已完成账号可以单个或批量创建新的 TOTP 2FA（基于时间的一次性密码），程序会自动生成并提交激活验证码，密钥不会写入协议日志。
- 自动跳过已经完成手机号绑定的账号。
- 未绑定账号支持手动手机号、手动短信验证码，以及 LubanSMS、SMSBower、自定义号码池自动取号收码。
- 邮箱登录成功后立即保存 checkpoint（检查点），中断后可继续手机号流程。
- 支持单个和批量重新授权；“重新授权”优先使用已有 Refresh Token（刷新令牌），“重新登录并授权”会跳过刷新令牌和旧检查点，强制重新完成登录与授权。
- 支持分页、精确筛选、跨页多选、批量删除、停止全部、批量重新授权和批量下载。
- 可每 5 分钟巡检 Sub2API 异常账号，对上次全自动登录的任务自动重新登录并更新远端授权。
- 最终输出 sub2api 导入格式，下载文件名自动附带时间戳。

## 环境要求

- Node.js 20 或更高版本，建议使用 Node.js 22。
- Python 3.9 或更高版本；默认协议登录流程需要安装 `curl_cffi`（浏览器 TLS 指纹请求库），即使不使用代理也需要。
- macOS 使用 Keychain（钥匙串）持久保存密码、2FA 密钥和账号代理。
- Windows 使用当前用户的 DPAPI（数据保护接口）加密保存上述数据，密文位于 `%LOCALAPPDATA%\toSub2\credentials`，只能由同一个 Windows 用户解密。
- Linux 仍可使用邮箱验证码流程，但目前不持久保存密码、2FA 密钥和账号代理；服务重启后不会让原本配置代理的排队任务悄悄改用本机网络。

## 安装与启动

```bash
git clone https://github.com/poxiao33/toSub2.git
cd toSub2
npm install
python -m pip install -r requirements.txt
npm run dev
```

默认访问地址：

```text
http://127.0.0.1:4399
```

指定其他端口：

```bash
npm run dev -- --port 4400
```

允许局域网设备访问：

```bash
npm run dev -- --host 0.0.0.0
```

局域网模式没有访问认证，只应在可信网络内短时间使用。

### PM2（Node.js 进程管理器）守护运行

号池巡检依赖控制台服务持续运行。需要崩溃后自动重启或开机启动时，建议使用项目内置的 PM2 配置：

```bash
npm install -g pm2
npm run daemon:start
pm2 save
pm2 startup
```

`pm2 startup`（生成开机启动配置）会输出一条系统命令，继续执行该命令即可。默认使用 `127.0.0.1:4399` 和项目内的 `tmp/chatgpt-onboarding-console` 数据目录。

需要保留旧数据目录并开放局域网时，macOS/Linux 可以在首次启动时传入：

```bash
ONBOARDING_OUTPUT_ROOT=/path/to/existing-data ONBOARDING_HOST=0.0.0.0 npm run daemon:start
```

Windows PowerShell（命令行）使用：

```powershell
$env:ONBOARDING_OUTPUT_ROOT="C:\path\to\existing-data"
$env:ONBOARDING_HOST="0.0.0.0"
npm run daemon:start
```

常用管理命令：

```bash
npm run daemon:restart
npm run daemon:logs
npm run daemon:stop
```

PM2 只负责在进程异常退出后重启。toSub2 在正常关闭时仍会先取消巡检请求、停止登录任务并保存任务状态。

### 公网部署与访问密码

部署到公网（或不可信网络）时，必须先设置访问密码，否则任何打开页面的人都能拿到控制台令牌、查看和操作全部账号数据。设置环境变量 `TOSUB2_CONSOLE_PASSWORD` 即可启用访问密码防护。

推荐用项目根目录的 `.env` 文件配置（启动时自动加载，免去每次手动传环境变量）：

```bash
# 在项目根目录创建 .env，写入（等号两边不要加引号）
TOSUB2_CONSOLE_PASSWORD=你的密码
ONBOARDING_HOST=0.0.0.0
```

也可以直接用命令行临时指定：

```bash
# macOS / Linux
TOSUB2_CONSOLE_PASSWORD=你的密码 ONBOARDING_HOST=0.0.0.0 npm run dev

# Windows PowerShell
$env:TOSUB2_CONSOLE_PASSWORD="你的密码"
$env:ONBOARDING_HOST="0.0.0.0"
npm run dev
```

> `.env` 已被 `.gitignore` 忽略，不会提交到仓库；已有同名系统环境变量不会被 `.env` 覆盖。

启用后，打开页面会先显示「访问验证」登录框，输入正确密码才能进入控制台；密码以 scrypt 哈希校验、不明文存储，同一 IP 连续输错 5 次会被锁定 15 分钟。不设置该环境变量时行为完全不变（本机或可信局域网直接访问，无需登录）。

> 安全提醒：访问密码在传输过程中仍为明文，**务必配合 HTTPS（反向代理或 TLS 终端）使用**，否则密码可能被中间人截获。建议用 Nginx / Caddy 等反向代理在前面加一层 HTTPS。

### Docker 容器部署（推荐用于服务器）

项目自带 `Dockerfile`、`docker-compose.yml` 和 `.dockerignore`，镜像基于 Node 22 + Python 3（Debian slim），内置 `curl_cffi` 和正确的 PID 1 信号处理（`tini`），适合长时间在服务器上运行。

每次推送到 `main`（或打 `v*` 标签）时，GitHub Actions 会自动构建 `linux/amd64` + `linux/arm64` 双架构镜像并发布到 GHCR：`ghcr.io/zhoudashuaibi/tosub2`。服务器上无需克隆源码、无需本地构建，直接拉镜像即可。

#### 方式一：拉取 CI 发布的镜像（服务器推荐）

```bash
# 0. 首次使用：到 GitHub 仓库页面 → Packages → tosub2 → Package settings
#    把可见性改为 Public（否则服务器上 docker pull 会提示 denied）。
#    也可以保持私有，但服务器上需要先：
#    echo 你的GitHub访问令牌 | docker login ghcr.io -u 你的GitHub用户名 --password-stdin
#    （令牌需勾选 read:packages 权限）

# 1. 在服务器上建一个目录，放入 docker-compose.yml（scp 过去，或 git clone 本仓库）

# 2. 配置访问密码（公网部署必填，本机自用可跳过）
echo 'TOSUB2_CONSOLE_PASSWORD=你的强密码' > .env

# 3. 拉取镜像并后台启动
docker compose pull
docker compose up -d

# 4. 查看日志 / 状态
docker compose logs -f
docker compose ps
```

镜像标签规则：`main` 分支推送 → `latest`；打 `v1.5.4` 这样的标签 → `1.5.4`、`1.5`。想固定版本就把 compose 里的 `image` 改成 `ghcr.io/zhoudashuaibi/tosub2:1.5.4`。

#### 方式二：本地构建（无 GHCR 镜像 / 离线服务器）

**最快上手**（在项目根目录）：

```bash
# 1. 配置访问密码（公网部署必填，本机自用可跳过）
echo 'TOSUB2_CONSOLE_PASSWORD=你的强密码' > .env

# 2. 构建并后台启动
docker compose up -d --build

# 3. 查看日志 / 状态
docker compose logs -f
docker compose ps
```

默认通过宿主机的 `4399` 端口访问：`http://服务器IP:4399`。启动后打开页面会先要求输入访问密码。

**配置说明**（`docker-compose.yml`）：

| 配置项 | 说明 |
|--------|------|
| `ports: "4399:4399"` | 左边宿主机端口可改，右边容器内固定。改端口只改左边 |
| `./data:/app/data` | 数据持久化卷：任务产物、号池配置都在这里。容器删了重建数据还在 |
| `TOSUB2_CONSOLE_PASSWORD` | 访问密码，从 `.env` 自动读取。留空 = 无密码（仅本机自用场景）|
| `mem_limit: 1g` | 容器内存上限，防止异常吃满宿主机内存。1G 够用，服务器紧张可调到 512m |
| `restart: unless-stopped` | 崩溃自动重启，但手动 `docker compose stop` 不会重启 |

**端口修改**：要改宿主机端口（比如用 8080），编辑 `docker-compose.yml` 的 `- "8080:4399"`，然后 `docker compose up -d`。

**更新版本**：

```bash
# 方式一（拉取 CI 镜像部署的）：
docker compose pull             # 拉最新镜像
docker compose up -d            # 替换旧容器，数据卷不变

# 方式二（本地构建部署的）：
git pull
docker compose up -d --build    # 重新构建并替换旧容器，数据卷不变
```

**数据备份**：只需备份项目根目录的 `data/` 文件夹，里面包含所有任务产物和号池配置。

**常用命令**：

```bash
docker compose up -d --build   # 构建并启动
docker compose down            # 停止并删除容器（数据保留）
docker compose stop            # 仅停止（容器仍在，下次 start 即可）
docker compose restart         # 重启（改了 .env 后用这个生效）
docker compose logs -f         # 实时日志
```

> Linux 容器说明：toSub2 的账号密码、2FA 密钥、Outlook 凭据持久化依赖 macOS Keychain 或 Windows DPAPI，**Linux/容器内无法持久保存这些凭据**（重启容器后丢失，但任务进度靠 `job-meta.json` 仍可恢复）。这是上游设计限制，Docker 部署同样适用。

## 账号代理和 TLS 指纹

网页顶部的“代理 IP”输入框配置账号登录使用的代理。支持以下格式：

```text
http://用户名:密码@主机:端口
socks5h://用户名:密码@主机:端口
socks5h://account-id:proxy-secret-JP-91977332-20m@proxy.example.com:1000
```

如果用户名中存在 `-sid-xxxxxxxx-t-20`，或者密码中存在 `-JP-12345678-20m` 这样的会话字段，toSub2 会为每个任务随机生成新的会话编号，并使用 `curl_cffi` 的 Chrome 浏览器指纹真实访问 `chatgpt.com` 检测出口。本机直连且未指定指纹时，控制台只启动一个共享探测任务，从当前 `curl_cffi` 支持的桌面 Chrome 指纹中由新到旧分批探测，每批最多并发 4 个请求；所有无代理账号等待并复用同一个结果，不会逐账号重复探测。探测会选择首批可用结果中版本较新且返回 `200-399`、不是安全校验页或安全校验跳转的指纹；配置代理时仍默认使用 `chrome146`。通过 `--tls-profile` 或 `TOSUB2_TLS_PROFILE` 显式指定时使用指定指纹。如果当前 Python `curl_cffi` 或底层库不支持指定指纹，会自动降级到兼容指纹，并把实际降级结果同步给后续流程。协议请求的 User-Agent、Client Hints、OAuth 请求头以及补充账号资料时的 Sentinel 浏览器环境都会跟随最终指纹版本，不再混用固定版本或不同操作系统环境。刷新令牌模式不会访问 ChatGPT 首页，只有回退到完整登录时才使用共享探测结果。HTTP 风控响应会更换会话，最多使用 10 个有响应的代理会话；TLS、超时等纯连接失败不占这 10 次，但连续连接失败达到 20 次也会停止，避免网络异常时无限循环。代理检测通过后，如果在邮箱登录、2FA、手机号绑定、工作区选择或 OAuth（授权登录）阶段再次遇到 403 HTML 风控页，任务会清除本次无效登录状态、换新代理会话并从当前流程起点自动重试。没有可识别会话字段的固定代理不会重复轮换，失败后直接提示用户更换代理。

代理首次检测通过后，正式登录和授权流程如果再次遇到明确的安全校验页面，会先保持当前代理出口重试最多 3 次；手机号验证码发送接口只有在 `400/409` 同时带有安全校验响应头或实际安全校验页面时才采用相同策略。连续 3 次重试后仍然触发风控，才会进入更换代理并重新授权流程。普通手机号不可用、`invalid_state` JSON 等业务错误不会触发代理重试，只提示用户更换当前手机号。

代理输入为空时使用本机网络。页面设置保存在当前浏览器的 localStorage（本地存储）中；创建任务、重试和重新授权会读取输入框当前最新内容。任务实际使用的代理还会保存在系统安全凭据存储中，以便服务重启后恢复排队任务。代理密码不会写入 `job-meta.json`（任务元数据）或日志。

Python 辅助进程默认使用 `python3`（macOS/Linux）或 `python`/`py -3`（Windows）。如果系统有多个 Python，可以设置环境变量 `TOSUB2_PYTHON` 指定解释器路径。

## 批量添加格式

每行一个账号，支持以下格式：

```text
邮箱
邮箱----邮箱收码接口
邮箱----密码
邮箱----密码----2FA身份验证密钥
邮箱----密码----邮件接收API
邮箱----密码----邮件接收API----2FA身份验证密钥
邮箱----邮箱收码接口----2FA身份验证密钥
邮箱--------2FA身份验证密钥
```

示例：

```text
name@example.com
name2@example.com----https://mail.example/messages/account-token
name3@example.com----账号密码----JBSWY3DPEHPK3PXP
name4@example.com----账号密码----https://mail.example/messages/name4
name5@example.com----账号密码----https://mail.example/messages/name5----JBSWY3DPEHPK3PXP
name6@example.com----https://mail.example/messages/account-token----JBSWY3DPEHPK3PXP
name7@example.com--------JBSWY3DPEHPK3PXP
```

第二段以 `http://` 或 `https://` 开头时按邮箱收码接口处理，否则按密码处理。密码后的字段以 `http://` 或 `https://` 开头时，作为密码登录的备用邮件收码接口；如果还有第四段，则按 2FA 密钥处理。只有邮箱和 2FA 密钥、登录时手动填写邮箱验证码的账号，可使用连续 8 个短横线的 `邮箱--------2FA密钥` 格式。邮箱是唯一字段，重复导入会更新原任务资料。

## Outlook 邮箱取件

网页顶部工具栏的“Outlook 导入”按钮用于导入使用 OAuth 刷新令牌收取验证码的 Outlook 邮箱。每行一条记录，格式为：

```text
邮箱----邮箱密码----clientId----refresh_token
```

示例：

```text
name@outlook.com----邮箱密码----9e5f94bc-e8a4-4e73-b8be-63364c29d753----M.C509_BL2.0.U.MsaArtifacts...
```

导入的账号在登录到邮箱验证码步骤时，会自动调用取件接口读取收件箱并提交最新验证码，不需要手动输入。Outlook 取件与上方“邮件接收 API”是两条互斥的收码路径：一个账号只能配置其中一种。

取件行为：

- 登录进入邮箱验证码步骤前，先记录当前收件箱中已有邮件的验证码标识和基准时间。
- 轮询时只接受**基准时间之后到达**、且发件人是 OpenAI/ChatGPT 相关域名（`openai.com`、`tm.openai.com`、`email.openai.com`、`chatgpt.com`、`codex.chatgpt.com`）的邮件。
- 同时用验证码 + 邮件标识去重，避免重复提交同一封邮件。新验证码通常有几秒投递延迟，由默认 2.5 秒轮询间隔自然吸收，最多等待 10 分钟。
- 只识别上述 OpenAI 发件人的邮件，邮箱里其他服务的验证码不会被误提交。

凭据安全：

- `refresh_token`、邮箱密码和 `clientId` 会加密保存到系统安全凭据存储（Windows 使用 DPAPI，macOS 使用 Keychain），**不会写入任务元数据（`job-meta.json`）或协议日志**。
- 取件接口地址默认为 `https://8t92.cc/api/fetch-mails`，可在网页顶部“Outlook 取件”栏位配置为自建或其他接口，配置保存在本机数据目录。
- 取件接口会收到你配置的 `refresh_token`，请只导入你本人持有或已明确授权的邮箱。

## 接码平台配置

网页顶部的“接码平台”区域可以打开统一配置页面。每个平台拥有独立配置，保存后写入当前浏览器的 localStorage（本地存储）；服务端不会持久保存 API Key（接口密钥）。

目前支持：

- LubanSMS：填写 API Key 和供应商编号。
- SMSBower：填写 API Key 后手动点击“查询价格”，再从下拉框选择国家。列表按价格从低到高显示中文国家名称、价格和库存，不显示国家缩写和国际区号。
- 自定义接码：每行填写 `+国际手机号----接码API`，一次最多 500 条。重复手机号以最后一行为准，并发任务按顺序获取未分配号码。

```text
+8613711111111----https://example.com/messages/13711111111
+8613822222222----https://example.com/messages/13822222222
```

任务到达手机号步骤后，可以使用当前选中的平台取号。SMSBower 取号时会带上用户选择时的最高价格，避免实时价格上涨后按更高价格购买。自定义接码在发送短信前会先记录接口中的旧验证码，只提交之后出现的新验证码。服务端会自动轮询短信、提取独立的 6 位数字验证码并提交。手动手机号和手动验证码流程始终保留。

新增平台时，通过统一 SmsProvider（短信平台适配器）接入，不需要复制任务轮询和状态处理代码。

API Key 只会随取号请求临时发送给本地服务，不会写入任务元数据、协议日志或导出文件。

## 直接上传到 Sub2API

任务完成后，可以在单个任务的“上传”按钮，或顶部批量操作中使用“上传到 Sub2API”，把生成的 OAuth（授权）账号直接写入指定的 Sub2API 后端号池。

首次使用时，在页面的“Sub2API”配置区域填写：

- Sub2API 后端地址，例如 `http://127.0.0.1:8080`。
- 管理员 API Key（管理员接口密钥）。请求时通过 `x-api-key` 请求头发送。
- 点击“读取配置”后读取目标号池和代理列表。号池支持多选；不选择具体分组时使用后端默认号池。
- 可以统一指定代理 IP、并发数、负载因子和优先级。数字参数留空时保留每个账号原来的配置。
- 可以填写允许使用的模型，每行一个，也支持逗号分隔，例如 `gpt-5`、`gpt-5-mini`。
- “新号自动选择绑定最少的代理”开关（默认开启）：未手动指定代理时，上传新号会为每个账号独立统计当前各可用代理绑定的账号数，选择绑定最少的那个；并列时随机选择。批量上传多个号时会在内存中累加本次分配，避免整批都选到同一个代理。手动指定代理后此项自动失效。
- “禁用 5h 自动暂停”和“禁用 7d 自动暂停”开关（默认关闭）：勾选后，上传的账号会设置 `auto_pause_5h_disabled` 或 `auto_pause_7d_disabled`，账号在对应滚动窗口用量超阈时不会被 Sub2API 自动暂停；不勾选则不设置该字段，由后端按默认行为处理。两个开关相互独立。

上传选项会保存在当前浏览器的 `localStorage`（本地存储）。批量上传时，未完成的任务会自动跳过；服务端返回的创建失败数量会显示在控制台中。

### Sub2API 号池监控

在 Sub2API 配置中启用“每 5 分钟监控异常账号”后，本机服务会按页读取 `openai` 平台中状态为 `error` 的账号，提取邮箱并匹配本地任务。如果配置了号池，只检查所选号池；没有选择时检查全部 OpenAI 账号。

只有同时满足以下条件的任务才会自动重新登录并授权：

- 上次完整登录已成功，且密码、邮箱验证码、登录 2FA 均未由用户手动输入。
- 上次用到的密码和 2FA 密钥仍能从系统凭据存储读取，邮箱收码 API 仍存在。
- 任务当前没有运行、排队或执行其他操作。

手动输入绑定手机号或手机验证码不影响自动修复资格，因为账号通常只需绑定一次。自动授权成功后，toSub2 会按 Sub2API 远端账号 ID 更新凭据，不会通过批量创建接口新增重复账号；远端的模型映射等非敏感配置会保留，同时恢复账号为启用调度状态。

临时网络错误、代理风控、`429` 或 Sub2API 短时不可用只会进入 5 分钟冷却。如果登录返回明确的 `account_deactivated`、`account_deleted` 或同类永久停用信息，任务会被标记为永久跳过，下次巡检不再重试。用户仍可手动点击“重新登录并授权”重新确认账号状态。

启用监控后，Sub2API 后端地址和管理员 API Key 会由本机服务保存在运行数据目录的 `sub2api-monitor.json` 中，但不会写入账号任务元数据、协议日志、状态接口或导出文件。

## 输出文件

任务运行数据默认保存在：

```text
tmp/chatgpt-onboarding-console/<任务 ID>/
```

每个完成任务会生成 `sub2api-import-oauth.json`。单账号和批量下载均输出标准 `sub2api-data` 格式。

也可以直接使用 CLI（命令行工具）：

```bash
node src/protocol-login.mjs --email you@example.com --verbose
```

查看全部参数：

```bash
node src/protocol-login.mjs --help
```

## 安全说明

- `tmp/` 中包含 Cookie（登录凭证）、OAuth Token（授权令牌）和登录检查点，禁止提交或分享。
- Windows 保存的密码和 2FA 密钥由 DPAPI（数据保护接口）按当前用户加密，不会以明文写入任务目录。
- sub2api 导入文件包含可用的授权令牌，应当按密码文件保护。
- 不要把 API Key、密码、2FA 密钥、验证码、Cookie 或 Token 提交到 Git 仓库。
- 网页控制台用于本机或可信局域网时无需登录；公网部署请务必设置 `TOSUB2_CONSOLE_PASSWORD` 访问密码，并配合 HTTPS 使用（详见上文「公网部署与访问密码」）。
- 只处理你本人持有或已获得明确授权的账号。

### 长期运行的内存与性能

toSub2 设计为长时间运行（号池巡检依赖控制台持续在线），以下是关于内存和性能的说明：

- **任务记录会累积**：已完成的任务会保留在内存中（每条最多约 80KB 日志），便于随时查看和重新授权。任务积累到上千条时内存占用会明显上升（约几百 MB）。**定期在页面上删除不再需要的任务**是控制内存最直接的办法。
- **重启清空日志缓存**：任务日志不落盘，重启服务（或重启容器）会清空所有内存中的日志，任务本身仍能从磁盘恢复。任务量大时，重启一次即可释放日志占用的内存。
- **Docker 内存上限**：`docker-compose.yml` 默认设置 `mem_limit: 1g`，异常情况下不会吃满宿主机内存；正常运行约占用 200MB 左右。
- **前端轮询**：页面打开时会每 0.9 秒刷新一次任务列表，任务非常多时可能感到轻微卡顿，关闭页面或切到后台标签页即可停止轮询。
- **凭据持久化**：Linux/容器内无法持久保存账号密码、2FA 密钥和 Outlook 凭据（依赖 macOS/Windows 系统级加密），重启后需重新录入；任务进度和授权文件不受影响。

总体而言，正常使用（几十到几百条任务）内存稳定可控；如果任务量很大，定期清理或定期重启容器即可保持流畅。

## 免责声明

本项目仅供学习、研究和管理本人账号使用，不隶属于 OpenAI，也未获得 OpenAI 背书。使用者应自行遵守 OpenAI 服务条款、相关平台规则以及所在地法律法规。因接口变更、账号限制、数据泄露或不当使用造成的后果由使用者自行承担。

## 更新日志

版本变化和升级说明请查看 [CHANGELOG.md](CHANGELOG.md)。

## License（开源许可证）

[MIT](LICENSE)
