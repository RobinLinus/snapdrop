# Local Development
## Install

First, [Install docker with docker-compose.](https://docs.docker.com/compose/install/)

Then, clone the repository and run docker-compose:
```shell
    git clone https://github.com/RobinLinus/snapdrop.git
```
```shell
    cd snapdrop
```
```shell
    docker-compose up -d
```
Now point your browser to `http://localhost:8080`.

- To restart the containers run `docker-compose restart`.
- To stop the containers run `docker-compose stop`.
- To debug the NodeJS server run `docker logs snapdrop_node_1`.


## Run locally by pulling image from Docker Hub

Have docker installed, then use the command:
```shell
    docker pull linuxserver/snapdrop
```

To run the image, type (if port 8080 is occupied by host use another random port <random port>:80):
```shell
    docker run -d -p 8080:80 linuxserver/snapdrop
```

<br>

## Testing PWA related features
PWAs require that the app is served under a correctly set up and trusted TLS endpoint.

The nginx container creates a CA certificate and a website certificate for you. To correctly set the common name of the certificate, you need to change the FQDN environment variable in `docker/fqdn.env` to the fully qualified domain name of your workstation.

If you want to test PWA features, you need to trust the CA of the certificate for your local deployment. For your convenience, you can download the crt file from `http://<Your FQDN>:8080/ca.crt`. Install that certificate to the trust store of your operating system.
- On Windows, make sure to install it to the `Trusted Root Certification Authorities` store.
- On MacOS, double click the installed CA certificate in `Keychain Access`, expand `Trust`, and select `Always Trust` for SSL.
- Firefox uses its own trust store. To install the CA, point Firefox at `http://<Your FQDN>:8080/ca.crt`. When prompted, select `Trust this CA to identify websites` and click OK.
- When using Chrome, you need to restart Chrome so it reloads the trust store (`chrome://restart`). Additionally, after installing a new cert, you need to clear the Storage (DevTools -> Application -> Clear storage -> Clear site data).

Please note that the certificates (CA and webserver cert) expire after a day.
Also, whenever you restart the nginx docker, container new certificates are created.

The site is served on `https://<Your FQDN>:8443`.


# Deployment Notes
The client expects the server at http(s)://your.domain/server.

When serving the node server behind a proxy, the `X-Forwarded-For` header has to be set by the proxy. Otherwise, all clients that are served by the proxy will be mutually visible.

## Deployment with node
By default, the node server listens on port 3000.

Use nginx or apache to set the header correctly:

### Using nginx
```
server {
    listen       80;

    expires epoch;

    location / {
        root   /var/www/snapdrop/client;
        index  index.html index.htm;
    }

    location /server {
        proxy_connect_timeout 300;
        proxy_pass http://node:3000;
        proxy_set_header Connection "upgrade";
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header X-Forwarded-for $remote_addr;
    }
}

server {
    listen       443 ssl http2;
    ssl_certificate /etc/ssl/certs/snapdrop-dev.crt;
    ssl_certificate_key /etc/ssl/certs/snapdrop-dev.key;

    expires epoch;

    location / {
        root   /var/www/snapdrop/client;
        index  index.html;
    }

    location /server {
        proxy_connect_timeout 300;
        proxy_pass http://node:3000;
        proxy_set_header Connection "upgrade";
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header X-Forwarded-for $remote_addr;
    }
}
```

### Using Apache
```
<VirtualHost *:80>	
	DocumentRoot "/var/www/snapdrop/client"
	DirectoryIndex index.html	

	RewriteEngine on
	RewriteCond %{HTTP:Upgrade} websocket [NC]
	RewriteCond %{HTTP:Connection} upgrade [NC]
	RewriteRule ^/?(.*) "ws://127.0.0.1:3000/$1" [P,L]
</VirtualHost>
<VirtualHost *:443>	
	DocumentRoot "/var/www/snapdrop/client"
	DirectoryIndex index.html
	
	RewriteEngine on
	RewriteCond %{HTTP:Upgrade} websocket [NC]
	RewriteCond %{HTTP:Connection} upgrade [NC]
	RewriteRule ^/?(.*) "wws://127.0.0.1:3000/$1" [P,L]
</VirtualHost>
```

## Deployment with Docker
The easiest way to get snapdrop up and running is by using Docker.

By default, docker listens on ports 8080 (http) and 8443 (https) (specified in `docker-compose.yml`).

When running Snapdrop via Docker, the `X-Forwarded-For` header has to be set by a proxy. Otherwise, all clients will be mutually visible.

### Installation
[See Local Development > Install](#install)

Use nginx or apache to set the header correctly:

### Using nginx
(This differs from the config under `/docker/nginx/default.conf)
```
server {
    listen       80;

    expires epoch;

    location / {
        proxy_connect_timeout 300;
        proxy_pass http://127.0.0.1:8080;
    }

    location /server {
        proxy_connect_timeout 300;
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Connection "upgrade";
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header X-Forwarded-for $remote_addr;
    }
}

server {
    listen       443 ssl http2;
    ssl_certificate /etc/ssl/certs/snapdrop-dev.crt;
    ssl_certificate_key /etc/ssl/certs/snapdrop-dev.key;

    expires epoch;

    location / {
        proxy_connect_timeout 300;
        proxy_pass http://127.0.0.1:443;
    }

    location /server {
        proxy_connect_timeout 300;
        proxy_pass http://127.0.0.1:443;
        proxy_set_header Connection "upgrade";
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header X-Forwarded-for $remote_addr;
    }
}
```

### Using Apache
install modules `proxy`, `proxy_http`, `mod_proxy_wstunnel`
```shell
a2enmod proxy
```
```shell
a2enmod proxy_http
```
```shell
a2enmod proxy_wstunnel
```

<br>

Create a new configuration file under `/etc/apache2/sites-available` (on debian)

**snapdrop.conf**
```
<VirtualHost *:80>	
	ProxyPass / http://127.0.0.1:8080/
	RewriteEngine on
	RewriteCond %{HTTP:Upgrade} websocket [NC]
	RewriteCond %{HTTP:Connection} upgrade [NC]
	RewriteRule ^/?(.*) "ws://127.0.0.1:8080/$1" [P,L]
</VirtualHost>
<VirtualHost *:443>	
	ProxyPass / https://127.0.0.1:8443/
	RewriteEngine on
	RewriteCond %{HTTP:Upgrade} websocket [NC]
	RewriteCond %{HTTP:Connection} upgrade [NC]
	RewriteRule ^/?(.*) "wws://127.0.0.1:8443/$1" [P,L]
</VirtualHost>
```
Activate the new virtual host and reload apache:
```shell
a2ensite snapdrop
```
```shell
service apache2 reload
```

[< Back](/README.md)
