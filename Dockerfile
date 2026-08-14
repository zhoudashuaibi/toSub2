# syntax=docker/dockerfile:1
# toSub2 运行镜像：Node 22 + Python 3（curl_cffi 需要 glibc，故用 Debian slim 而非 Alpine）
FROM node:22-bookworm-slim

# 系统依赖：Python 3 + pip + curl_cffi 编译所需的 C 工具链 + tini（正确的 PID 1 信号转发）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-dev build-essential tini ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /app

# 先装 Node 依赖（利用层缓存：package.json 变了才重装）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 装 Python 依赖
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# 拷贝源码（.dockerignore 已排除 node_modules / tmp / .env / test 等）
COPY . .

# 数据目录：任务产物、号池配置等都在这里，需要挂卷持久化
ENV ONBOARDING_OUTPUT_ROOT=/app/data
# 整个 /app 交给 node 用户：Vite 运行时要往 node_modules/.vite 写依赖缓存，
# npm install 是 root 跑的，不 chown 会因 EACCES 启动失败
RUN mkdir -p /app/data && chown -R node:node /app

# 非 root 运行
USER node

# 容器内必须监听 0.0.0.0 才能被外部访问
ENV ONBOARDING_HOST=0.0.0.0
EXPOSE 4399

# tini 作为 PID 1，确保 SIGTERM 能正确转发给 Node 及其 Python 子进程，实现优雅关闭
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:4399/api/bootstrap || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/console-server.mjs", "--host=0.0.0.0", "--port=4399"]
