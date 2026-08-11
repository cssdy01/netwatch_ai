FROM nginx:1.27-alpine
ENV BACKEND_UPSTREAM=http://netwatch-backend:3000
COPY public /usr/share/nginx/html
COPY nginx/nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker/10-render-nginx.sh /docker-entrypoint.d/10-render-nginx.sh
RUN printf '%s\n' 'window.NW_CONFIG = { backendUrl: "" };' > /usr/share/nginx/html/config.js \
 && chmod 755 /docker-entrypoint.d/10-render-nginx.sh
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
