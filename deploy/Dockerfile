FROM node:26.11.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends nginx lsof ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node public public
COPY --chown=node:node services services
COPY --chown=node:node packages packages
COPY --chown=node:node adapters adapters
COPY --chown=node:node plugins plugins
COPY --chown=node:node integrations integrations
COPY --chown=node:node scripts scripts
COPY --chown=node:node migrations migrations
COPY --chown=node:node deploy/container-entrypoint.sh /app/deploy/container-entrypoint.sh
COPY --chown=node:node deploy/nginx.conf /app/deploy/nginx.conf
RUN mkdir -p /var/lib/synplex /tmp/synplex-nginx && chown node:node /var/lib/synplex /tmp/synplex-nginx && chmod 700 /var/lib/synplex && chmod 755 /app/deploy/container-entrypoint.sh
USER node
ENV SYNPLEX_WORKSPACE_DATA_DIR=/var/lib/synplex SYNPLEX_WORKSPACE_SERVE_UI=1 SYNPLEX_WORKSPACE_PORT=5200
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:5200/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/deploy/container-entrypoint.sh"]
