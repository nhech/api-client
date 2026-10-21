#!/bin/sh
# Makes the certificates that the TLS tests of the engine use. They are for tests only: the keys are public in this repository,
# every certificate is valid for 100 years, and none of them is trusted by anything but the tests that name them.
#
#   docker run --rm -v "$PWD:/out" -w /out node:22-bookworm sh generate.sh
#
# ca.pem          the certificate authority of the tests (its key is deleted after use)
# server.pem      localhost, 127.0.0.1 and ::1, signed by the CA
# mismatch.pem    a certificate for other.test only, signed by the CA: the name does not match localhost
# selfsigned.pem  localhost and 127.0.0.1, signed by itself: nobody trusts it
# client.pem      a client certificate signed by the CA, also as client.p12 with the passphrase "test"
set -eu
rm -f ./*.pem ./*.p12 ./*.srl ./*.csr ./*.ext

openssl ecparam -name prime256v1 -genkey -noout -out ca-key.pem
openssl req -x509 -new -key ca-key.pem -sha256 -days 36500 -subj "/CN=api-client test CA" -out ca.pem \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"

issue() { # name, subject, subjectAltName, extendedKeyUsage
  openssl ecparam -name prime256v1 -genkey -noout -out "$1-key.pem"
  openssl req -new -key "$1-key.pem" -subj "$2" -out "$1.csr"
  printf 'basicConstraints=CA:FALSE\nextendedKeyUsage=%s\n' "$4" > "$1.ext"
  if [ -n "$3" ]; then printf 'subjectAltName=%s\n' "$3" >> "$1.ext"; fi
  openssl x509 -req -in "$1.csr" -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 36500 -sha256 -extfile "$1.ext" -out "$1.pem"
}
issue server "/CN=localhost" "DNS:localhost,IP:127.0.0.1,IP:::1" serverAuth
issue mismatch "/CN=other.test" "DNS:other.test" serverAuth
issue client "/CN=api-client test client" "" clientAuth

openssl ecparam -name prime256v1 -genkey -noout -out selfsigned-key.pem
openssl req -x509 -new -key selfsigned-key.pem -sha256 -days 36500 -subj "/CN=localhost" -out selfsigned.pem -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

openssl pkcs12 -export -in client.pem -inkey client-key.pem -certfile ca.pem -out client.p12 -passout pass:test

rm -f ca-key.pem ./*.srl ./*.csr ./*.ext
ls -1
