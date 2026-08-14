#!/bin/sh
set -e

# bind mount 的 /app/data 在宿主机上通常属 root（docker 自动创建），
# 非 root 的 node 用户写不进去会报 permission denied, mkdir '/app/data/<uuid>'。
# 这里以 root 修正属主，再经 gosu 降权到 node 运行业务进程。
mkdir -p /app/data
chown -R node:node /app/data

exec gosu node "$@"