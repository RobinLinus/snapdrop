#!/bin/sh

cnf_dir='/mnt/openssl/'
certs_dir='/etc/ssl/certs/'
openssl req -config ${cnf_dir}snapdropCA.cnf -new -x509 -days 1 -keyout ${certs_dir}snapdropCA.key -out ${certs_dir}snapdropCA.crt
openssl req -config ${cnf_dir}snapdropCert.cnf -new -out /tmp/snapdrop-dev.csr -keyout ${certs_dir}snapdrop-dev.key
openssl x509 -req -in /tmp/snapdrop-dev.csr -CA ${certs_dir}snapdropCA.crt -CAkey ${certs_dir}snapdropCA.key -CAcreateserial -extensions req_ext -extfile ${cnf_dir}snapdropCert.cnf -sha512 -days 1 -out ${certs_dir}snapdrop-dev.crt

exec "$@"