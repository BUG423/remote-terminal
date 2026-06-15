#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# 生成本地测试用自签名 TLS 证书
#
# 用法：
#   ./scripts/generate-cert.sh
#
# 生成文件：
#   certs/localhost.crt  — 自签名证书
#   certs/localhost.key  — 私钥
#
# 然后在 config.json 中设置：
#   "useTLS": true,
#   "tlsCertPath": "certs/localhost.crt",
#   "tlsKeyPath": "certs/localhost.key"
#
# ⚠️ 仅用于本地开发测试！浏览器会显示"不安全"警告，点"高级 → 继续访问"即可。
#    生产环境请使用 Let's Encrypt 或正规 CA 签发的证书。
# ═══════════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="$SCRIPT_DIR/../certs"

mkdir -p "$CERT_DIR"

echo "🔐 生成自签名 TLS 证书（用于本地开发测试）..."
echo ""

# 生成私钥 + 证书（有效期 365 天，包含 localhost 和 127.0.0.1 的 SAN）
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout "$CERT_DIR/localhost.key" \
  -out "$CERT_DIR/localhost.crt" \
  -days 365 \
  -subj "/C=CN/ST=Dev/L=Local/O=WebClaude/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

chmod 600 "$CERT_DIR/localhost.key"
chmod 644 "$CERT_DIR/localhost.crt"

echo ""
echo "✅ 证书已生成:"
echo "   证书: $CERT_DIR/localhost.crt"
echo "   私钥: $CERT_DIR/localhost.key"
echo ""
echo "📋 请在 config.json 中配置:"
echo '   "useTLS": true,'
echo '   "tlsCertPath": "certs/localhost.crt",'
echo '   "tlsKeyPath": "certs/localhost.key"'
echo ""
echo "⚠️  浏览器访问时会提示证书不受信任，点击「高级 → 继续访问」即可。"
