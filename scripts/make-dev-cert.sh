#!/bin/bash
# One-time: create a self-signed "Switchboard Dev" code-signing certificate in your login keychain.
# Builds signed with it keep the same identity, so Full Disk Access survives rebuilds.
# Prints no secrets. The private key never leaves your keychain.
set -euo pipefail
NAME="Switchboard Dev"
if security find-identity -v -p codesigning | grep -q "\"$NAME\""; then
  echo "✓ \"$NAME\" already exists"; exit 0
fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$tmp/cert.cnf" \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
# Random one-time passphrase for the transfer file only; it's never shown or stored.
pass=$(openssl rand -hex 16)
openssl pkcs12 -export -legacy -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$NAME" \
  -out "$tmp/id.p12" -passout "pass:$pass" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$NAME" -out "$tmp/id.p12" -passout "pass:$pass"
security import "$tmp/id.p12" -k ~/Library/Keychains/login.keychain-db -P "$pass" -T /usr/bin/codesign
echo "Trusting the certificate for code signing (macOS will ask for your login password)…"
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db "$tmp/cert.pem"
security find-identity -v -p codesigning | grep -q "\"$NAME\"" && echo "✓ \"$NAME\" ready" || { echo "✗ identity not found after import" >&2; exit 1; }
