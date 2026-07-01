FROM nginx:1.27-alpine
COPY index.html /usr/share/nginx/html/index.html
# Listen on 8080 (non-root friendly) and serve index.html for any path.
RUN printf 'server { listen 8080; root /usr/share/nginx/html; location / { try_files $uri /index.html; } }' > /etc/nginx/conf.d/default.conf
EXPOSE 8080
