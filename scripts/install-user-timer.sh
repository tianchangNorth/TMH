#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="$(command -v node || true)"
unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"

if [[ -z "${node_bin}" ]]; then
  echo "错误：未找到 node，请先安装 Node.js 20.18.1 或更高版本。" >&2
  exit 1
fi

if [[ ! -f "${project_dir}/.env" ]]; then
  echo "错误：请先复制 .env.example 为 .env，并填写认证信息。" >&2
  exit 1
fi

chmod 600 "${project_dir}/.env"
"${node_bin}" "${project_dir}/src/send-qr.js" --check-config
"${node_bin}" "${project_dir}/src/feishu-listener.js" --check-config
mkdir -p "${unit_dir}"

escaped_project_dir="${project_dir//|/\\|}"
escaped_node_bin="${node_bin//|/\\|}"
for service_name in tml-feishu-qr tml-feishu-listener; do
  sed \
    -e "s|__PROJECT_DIR__|${escaped_project_dir}|g" \
    -e "s|__NODE_BIN__|${escaped_node_bin}|g" \
    "${project_dir}/systemd/${service_name}.service.in" \
    > "${unit_dir}/${service_name}.service"
done

install -m 0644 \
  "${project_dir}/systemd/tml-feishu-qr.timer" \
  "${unit_dir}/tml-feishu-qr.timer"

systemctl --user daemon-reload
systemctl --user enable tml-feishu-qr.timer tml-feishu-listener.service
systemctl --user restart tml-feishu-qr.timer tml-feishu-listener.service

echo "已启用每日 08:30、11:30 定时任务和飞书长连接监听服务。"
systemctl --user list-timers tml-feishu-qr.timer --no-pager
systemctl --user status tml-feishu-listener.service --no-pager
